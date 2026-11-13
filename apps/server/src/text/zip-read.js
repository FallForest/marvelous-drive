import { inflateRawSync } from 'node:zlib'

/**
 * A dependency-free ZIP reader.
 *
 * OOXML files (docx/xlsx/pptx) are ZIP containers, and the project ships no
 * third-party packages, so the central directory is parsed by hand and entries
 * are inflated on demand with node:zlib.
 *
 * Design notes:
 * - readZip returns a Map-compatible archive whose values are produced lazily:
 *   touching ppt/slides/slide3.xml never inflates the embedded media.
 * - Stored (0) and deflate (8) entries are supported, with or without a data
 *   descriptor: the central directory is authoritative for sizes, so entries
 *   written with streaming/unknown sizes still read correctly.
 * - ZIP64 end-of-central-directory records are understood; a 64-bit value that
 *   cannot be represented exactly is rejected instead of being rounded.
 * - Every read is bounded (entry count, per-entry bytes, total bytes), so a zip
 *   bomb fails fast instead of exhausting memory.
 */

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
})

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50

const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800

export class ZipError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

const notZip = (message = 'The buffer is not a ZIP archive.') => new ZipError('NOT_ZIP', message)
const corrupt = (message) => new ZipError('CORRUPT', message)

/** Normalises an entry name so lookups survive "\" and "./" spellings. */
export function normalizeEntryName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
}

/** Locates the end-of-central-directory record, tolerating trailing junk. */
function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw notZip('The buffer is too short to be a ZIP archive.')
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength <= buffer.length) return offset
  }
  throw notZip()
}

function safeInt(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ZipError('ZIP64_UNSUPPORTED', 'The ' + what + ' is outside the range this reader can represent.')
  }
  return value
}

/** Reads the EOCD (and the ZIP64 EOCD when present) into plain numbers. */
function readDirectoryLocation(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  let entryCount = buffer.readUInt16LE(eocd + 10)
  let centralSize = buffer.readUInt32LE(eocd + 12)
  let centralOffset = buffer.readUInt32LE(eocd + 16)

  const needsZip64 = entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
  if (needsZip64) {
    const locatorOffset = eocd - 20
    if (locatorOffset < 0 || buffer.readUInt32LE(locatorOffset) !== SIG_ZIP64_LOCATOR) {
      throw new ZipError('ZIP64_UNSUPPORTED', 'The archive advertises ZIP64 but has no ZIP64 locator.')
    }
    const zip64Offset = safeInt(Number(buffer.readBigUInt64LE(locatorOffset + 8)), 'ZIP64 directory offset')
    if (zip64Offset + 56 > buffer.length || buffer.readUInt32LE(zip64Offset) !== SIG_ZIP64_EOCD) {
      throw new ZipError('ZIP64_UNSUPPORTED', 'The ZIP64 end-of-central-directory record is missing.')
    }
    entryCount = safeInt(Number(buffer.readBigUInt64LE(zip64Offset + 32)), 'entry count')
    centralSize = safeInt(Number(buffer.readBigUInt64LE(zip64Offset + 40)), 'central directory size')
    centralOffset = safeInt(Number(buffer.readBigUInt64LE(zip64Offset + 48)), 'central directory offset')
  }

  if (centralOffset + centralSize > buffer.length) throw corrupt('The central directory points past the end of the buffer.')
  return { entryCount, centralOffset, centralSize }
}

/** Parses the ZIP64 extended information extra field (id 0x0001). */
function readZip64Extra(extra, entry) {
  let cursor = 0
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + 2)
    const bodyStart = cursor + 4
    if (id === 0x0001) {
      let offset = bodyStart
      const bodyEnd = Math.min(extra.length, bodyStart + length)
      if (entry.uncompressedSize === 0xffffffff && offset + 8 <= bodyEnd) {
        entry.uncompressedSize = safeInt(Number(extra.readBigUInt64LE(offset)), 'uncompressed size')
        offset += 8
      }
      if (entry.compressedSize === 0xffffffff && offset + 8 <= bodyEnd) {
        entry.compressedSize = safeInt(Number(extra.readBigUInt64LE(offset)), 'compressed size')
        offset += 8
      }
      if (entry.localOffset === 0xffffffff && offset + 8 <= bodyEnd) {
        entry.localOffset = safeInt(Number(extra.readBigUInt64LE(offset)), 'local header offset')
        offset += 8
      }
    }
    cursor = bodyStart + length
  }
}

function readEntries(buffer, limits) {
  const { entryCount, centralOffset, centralSize } = readDirectoryLocation(buffer)
  if (entryCount > limits.maxEntries) {
    throw new ZipError('LIMIT', 'The archive has ' + entryCount + ' entries; the limit is ' + limits.maxEntries + '.')
  }
  const entries = new Map()
  let cursor = centralOffset
  const end = centralOffset + centralSize
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > end || cursor + 46 > buffer.length) throw corrupt('The central directory is truncated.')
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw corrupt('A central directory record has a bad signature.')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) throw corrupt('A central directory name runs past the end of the buffer.')
    const rawName = buffer.subarray(nameStart, nameEnd)
    const entry = {
      name: normalizeEntryName(rawName.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1')),
      method,
      flags,
      encrypted: (flags & FLAG_ENCRYPTED) !== 0,
      crc32: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    }
    if (extraLength > 0) {
      readZip64Extra(buffer.subarray(nameEnd, Math.min(buffer.length, nameEnd + extraLength)), entry)
    }
    cursor = nameEnd + extraLength + commentLength
    if (!entries.has(entry.name)) entries.set(entry.name, entry)
  }
  return entries
}

/** Inflates one entry, enforcing the per-entry and total budgets. */
function readEntryBytes(source, entry, limits, budget) {
  if (entry.encrypted) {
    throw new ZipError('ENCRYPTED', '"' + entry.name + '" is encrypted; encrypted archives are not supported.')
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new ZipError('LIMIT', '"' + entry.name + '" expands to ' + entry.uncompressedSize + ' bytes; the per-entry limit is ' + limits.maxEntryBytes + '.')
  }
  if (entry.localOffset + 30 > source.length) throw corrupt('"' + entry.name + '" points past the end of the buffer.')
  if (source.readUInt32LE(entry.localOffset) !== SIG_LOCAL) throw corrupt('"' + entry.name + '" has a bad local header.')
  const localNameLength = source.readUInt16LE(entry.localOffset + 26)
  const localExtraLength = source.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength
  const dataEnd = dataStart + entry.compressedSize
  if (entry.compressedSize < 0 || dataStart > source.length || dataEnd > source.length) {
    throw corrupt('"' + entry.name + '" has a truncated data stream.')
  }
  let bytes
  if (entry.method === 0) {
    bytes = source.subarray(dataStart, dataEnd)
  } else if (entry.method === 8) {
    // maxOutputLength makes zlib itself refuse to build a bomb-sized buffer.
    const remaining = Math.max(1, limits.maxTotalBytes - budget.bytes)
    const cap = Math.max(1, Math.min(limits.maxEntryBytes + 1, remaining))
    try {
      bytes = inflateRawSync(source.subarray(dataStart, dataEnd), { maxOutputLength: cap })
    } catch (error) {
      if (error && (error.code === 'ERR_BUFFER_TOO_LARGE' || error.code === 'ERR_OUT_OF_RANGE')) {
        throw new ZipError('LIMIT', '"' + entry.name + '" inflates past the configured limit.')
      }
      throw corrupt('"' + entry.name + '" could not be inflated: ' + (error && error.message ? error.message : 'unknown error'))
    }
  } else {
    throw new ZipError('UNSUPPORTED_METHOD', '"' + entry.name + '" uses compression method ' + entry.method + '; only stored and deflate are supported.')
  }
  budget.bytes += bytes.length
  if (budget.bytes > limits.maxTotalBytes) {
    throw new ZipError('LIMIT', 'The archive inflates past the total limit of ' + limits.maxTotalBytes + ' bytes.')
  }
  if (entry.uncompressedSize !== 0xffffffff && bytes.length !== entry.uncompressedSize) {
    throw corrupt('"' + entry.name + '" inflated to ' + bytes.length + ' bytes but the directory declares ' + entry.uncompressedSize + '.')
  }
  return bytes
}

/**
 * A Map<name, Buffer> over a ZIP buffer.
 *
 * Iteration materialises every entry (bounded by the limits); get/has only
 * touch the entry you ask for, which is what the OOXML extractor needs.
 */
export class ZipArchive extends Map {
  #source
  #entries
  #limits
  #budget = { bytes: 0 }

  constructor(source, entries, limits) {
    super()
    this.#source = source
    this.#entries = entries
    this.#limits = limits
    for (const name of entries.keys()) super.set(name, undefined)
  }

  get(name) {
    const key = normalizeEntryName(name)
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    const cached = super.get(key)
    if (cached !== undefined) return cached
    const bytes = readEntryBytes(this.#source, entry, this.#limits, this.#budget)
    super.set(key, bytes)
    return bytes
  }

  has(name) {
    return this.#entries.has(normalizeEntryName(name))
  }

  /** Entry names in central-directory order, without inflating anything. */
  names() {
    return [...this.#entries.keys()]
  }

  /** Bytes charged against the total budget so far. */
  get inflatedBytes() {
    return this.#budget.bytes
  }

  materialize() {
    for (const name of this.#entries.keys()) this.get(name)
    return this
  }

  entries() {
    this.materialize()
    return super.entries()
  }

  values() {
    this.materialize()
    return super.values()
  }

  forEach(callback, thisArg) {
    this.materialize()
    return super.forEach(callback, thisArg)
  }

  [Symbol.iterator]() {
    this.materialize()
    return super[Symbol.iterator]()
  }
}

function resolveLimits(options) {
  const merged = { ...ZIP_LIMITS, ...(options || {}) }
  return {
    maxEntries: Math.max(1, Math.floor(Number(merged.maxEntries) || ZIP_LIMITS.maxEntries)),
    maxEntryBytes: Math.max(1, Math.floor(Number(merged.maxEntryBytes) || ZIP_LIMITS.maxEntryBytes)),
    maxTotalBytes: Math.max(1, Math.floor(Number(merged.maxTotalBytes) || ZIP_LIMITS.maxTotalBytes)),
  }
}

/**
 * Reads buffer as a ZIP archive.
 *
 * @param {Buffer} buffer
 * @param {{maxEntries?:number,maxEntryBytes?:number,maxTotalBytes?:number}} [options]
 * @returns {ZipArchive} a Map<name, Buffer> that inflates lazily
 */
export function readZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readZip expects a Buffer.')
  const limits = resolveLimits(options)
  const entries = readEntries(buffer, limits)
  return new ZipArchive(buffer, entries, limits)
}

/**
 * Reads a single entry without inflating the rest of the archive.
 *
 * @returns {Buffer|null} null when the entry does not exist
 */
export function readZipEntry(buffer, name, options = {}) {
  const archive = readZip(buffer, options)
  const bytes = archive.get(name)
  return bytes === undefined ? null : bytes
}
