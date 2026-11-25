/**
 * Pure binary writers for the ZIP records that carry ZIP64 overflow.
 *
 * The streaming writer and the reader both deal in the same three record
 * families, so they live here as dependency-free Buffer builders:
 * - the data descriptor (APPNOTE §4.3.9),
 * - the ZIP64 end of central directory record and locator (§4.3.14-4.3.16),
 * - the ZIP64 extended information extra field (§4.5.3).
 *
 * Every function is pure: no filesystem, zlib, clocks, or module-level state.
 * Inputs are safe integers (the only Numbers that can be converted to a 64-bit
 * field without rounding), and every record is little-endian as ZIP requires.
 */

/** 0xffffffff is both the largest ZIP32 size/offset and the ZIP64 sentinel. */
export const ZIP32_LIMIT = 0xffffffff
/** 0xffff is both the largest ZIP32 entry count and the ZIP64 sentinel. */
export const ZIP32_COUNT_LIMIT = 0xffff
/** Version made by / needed for a ZIP64 archive. */
export const ZIP64_VERSION = 45

const SIG_DATA_DESCRIPTOR = 0x08074b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_EOCD = 0x06054b50

const ZIP64_EXTRA_ID = 0x0001
const ZIP64_EXTRA_VALUE_BYTES = 8
const ZIP64_EXTRA_HEADER_BYTES = 4
const ZIP64_EOCD_BYTES = 56
const ZIP64_LOCATOR_BYTES = 20
const EOCD_BYTES = 22

const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

const UINT64_MAX = (1n << 64n) - 1n

/** Rejects anything that would lose precision or wrap when written as uint64. */
function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`The ${name} must be a non-negative safe integer.`)
  }
  return value
}

/** Validates a CRC-32 / signature-style unsigned 32-bit field. */
function uint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`The ${name} must be an unsigned 32-bit integer.`)
  }
  return value
}

/** Writes one uint64 field from an already validated safe integer. */
function writeUint64(buffer, value, offset, name) {
  const big = BigInt(safeInteger(value, name))
  if (big > UINT64_MAX) throw new RangeError(`The ${name} does not fit in 64 bits.`)
  buffer.writeBigUInt64LE(big, offset)
}

/**
 * Builds the ZIP64 extended information extra field (id 0x0001).
 *
 * The values are written in the order the caller supplies them, which is the
 * APPNOTE order for the field: uncompressed size, compressed size, local
 * header offset, and (when present) the disk start number. The length field is
 * n * 8; an empty list produces no extra field at all, as callers concatenate
 * extras without special-casing "nothing to add".
 *
 * @param {number[]} values non-negative safe integers
 * @returns {Buffer}
 */
export function zip64Extra(values) {
  if (!Array.isArray(values)) throw new TypeError('zip64Extra expects an array of sizes and offsets.')
  if (values.length === 0) return Buffer.alloc(0)

  const bodyBytes = values.length * ZIP64_EXTRA_VALUE_BYTES
  if (bodyBytes > UINT16_MAX) {
    throw new RangeError(`A ZIP64 extra field can carry at most ${Math.floor(UINT16_MAX / ZIP64_EXTRA_VALUE_BYTES)} values.`)
  }

  const extra = Buffer.alloc(ZIP64_EXTRA_HEADER_BYTES + bodyBytes)
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0)
  extra.writeUInt16LE(bodyBytes, 2)
  for (let index = 0; index < values.length; index++) {
    writeUint64(extra, values[index], ZIP64_EXTRA_HEADER_BYTES + index * ZIP64_EXTRA_VALUE_BYTES, `ZIP64 extra value at index ${index}`)
  }
  return extra
}

/**
 * Builds a data descriptor with the optional signature (APPNOTE §4.3.9).
 *
 * The 16-byte form is kept for values that fit ZIP32; once a size reaches
 * 0xffffffff (the sentinel) both size copies widen to 64 bits, producing the
 * 24-byte form. The CRC is always a 32-bit field in both forms.
 *
 * @param {number} crc unsigned CRC-32
 * @param {number} size non-negative safe integer
 * @returns {Buffer}
 */
export function zipDataDescriptor(crc, size) {
  uint32(crc, 'data descriptor CRC')
  safeInteger(size, 'data descriptor size')

  if (size < ZIP32_LIMIT) {
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    return descriptor
  }

  const descriptor = Buffer.alloc(24)
  descriptor.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0)
  descriptor.writeUInt32LE(crc, 4)
  writeUint64(descriptor, size, 8, 'data descriptor size')
  writeUint64(descriptor, size, 16, 'data descriptor size')
  return descriptor
}

/** Writes the 22-byte classic EOCD, using sentinels only for overflowed fields. */
function writeClassicEocd(entryCount, centralSize, centralStart) {
  const end = Buffer.alloc(EOCD_BYTES)
  end.writeUInt32LE(SIG_EOCD, 0)
  end.writeUInt16LE(0, 4) // number of this disk
  end.writeUInt16LE(0, 6) // disk where the central directory starts
  end.writeUInt16LE(entryCount >= ZIP32_COUNT_LIMIT ? UINT16_MAX : entryCount, 8)
  end.writeUInt16LE(entryCount >= ZIP32_COUNT_LIMIT ? UINT16_MAX : entryCount, 10)
  end.writeUInt32LE(centralSize >= ZIP32_LIMIT ? UINT32_MAX : centralSize, 12)
  end.writeUInt32LE(centralStart >= ZIP32_LIMIT ? UINT32_MAX : centralStart, 16)
  end.writeUInt16LE(0, 20) // comment length
  return end
}

/**
 * Builds the tail of an archive: just the classic EOCD while every value fits,
 * or the ZIP64 EOCD, its locator, and the classic EOCD with sentinels once a
 * count, size, or offset reaches its ZIP32 sentinel value.
 *
 * The locator points at the ZIP64 EOCD, which starts immediately after the
 * central directory, hence `centralStart + centralSize`. The classic record is
 * returned last so a ZIP32-only reader still finds a valid EOCD.
 *
 * @param {number} entryCount non-negative safe integer
 * @param {number} centralSize non-negative safe integer
 * @param {number} centralStart non-negative safe integer
 * @returns {Buffer}
 */
export function zipEndRecords(entryCount, centralSize, centralStart) {
  safeInteger(entryCount, 'entry count')
  safeInteger(centralSize, 'central directory size')
  safeInteger(centralStart, 'central directory offset')

  const needsZip64 = entryCount >= ZIP32_COUNT_LIMIT
    || centralSize >= ZIP32_LIMIT
    || centralStart >= ZIP32_LIMIT
  if (!needsZip64) return writeClassicEocd(entryCount, centralSize, centralStart)

  const zip64Eocd = Buffer.alloc(ZIP64_EOCD_BYTES)
  zip64Eocd.writeUInt32LE(SIG_ZIP64_EOCD, 0)
  zip64Eocd.writeBigUInt64LE(BigInt(ZIP64_EOCD_BYTES - 12), 4) // size of the remaining record: 44
  zip64Eocd.writeUInt16LE(ZIP64_VERSION, 12) // version made by
  zip64Eocd.writeUInt16LE(ZIP64_VERSION, 14) // version needed to extract
  zip64Eocd.writeUInt32LE(0, 16) // number of this disk
  zip64Eocd.writeUInt32LE(0, 20) // disk where the central directory starts
  writeUint64(zip64Eocd, entryCount, 24, 'entry count')
  writeUint64(zip64Eocd, entryCount, 32, 'entry count')
  writeUint64(zip64Eocd, centralSize, 40, 'central directory size')
  writeUint64(zip64Eocd, centralStart, 48, 'central directory offset')

  const locator = Buffer.alloc(ZIP64_LOCATOR_BYTES)
  locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0)
  locator.writeUInt32LE(0, 4) // disk containing the ZIP64 EOCD
  locator.writeBigUInt64LE(BigInt(centralStart) + BigInt(centralSize), 8)
  locator.writeUInt32LE(1, 16) // total number of disks

  return Buffer.concat([zip64Eocd, locator, writeClassicEocd(entryCount, centralSize, centralStart)])
}
