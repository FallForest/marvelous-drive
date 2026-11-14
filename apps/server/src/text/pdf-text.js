import { inflateRawSync, inflateSync } from 'node:zlib'

/**
 * Extracts searchable text from a PDF, without a dependency and without a
 * renderer.
 *
 * A PDF is a graph of objects whose content streams hold the show-string
 * operators that put glyphs on the page. This module reads just enough of that
 * to index prose:
 *
 *   - objects are found by scanning for `N G obj`, not by trusting the xref
 *     table: repaired, incremental and linearised files routinely carry a stale
 *     table while every object is intact;
 *   - `/FlateDecode` streams are inflated (both zlib and raw-deflate spellings
 *     occur in the wild); other filters are skipped rather than guessed at;
 *   - a page's `/Font` resources are resolved so each font's `/ToUnicode` CMap
 *     turns byte codes into real characters — this is what makes a CJK PDF
 *     searchable instead of a wall of replacement glyphs;
 *   - `Tj`, `TJ`, `'` and `"` emit text; `Td`/`TD`/`T*`/`TL`/`ET` emit structure.
 *
 * Deliberately out of scope: rasterising, decrypting, repairing. An encrypted
 * PDF reports `encrypted`, a scanned one `no-text`; both are honest skips that
 * the coverage report can explain. Every loop is bounded, because a hostile file
 * is one upload away.
 */

/** 24 MiB of PDF is more parsing than a search hit is worth. */
export const MAX_PDF_INDEX_BYTES = 24 * 1024 * 1024

/** Bounds that keep a malformed or hostile file from becoming a denial of service. */
const PDF_LIMITS = Object.freeze({
  maxObjects: 20000,
  maxPages: 400,
  maxStreamBytes: 8 * 1024 * 1024,
  maxDecodedBytes: 48 * 1024 * 1024,
  maxTextChars: 2 * 1024 * 1024,
  maxDepth: 8,
})

/** Whether this file should go through the PDF extractor at all. */
export function isPdfDocument(name, mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase()
  if (type === 'application/pdf' || type === 'application/x-pdf') return true
  return /\.pdf$/i.test(String(name || ''))
}

/* ------------------------------------------------------------------ *
 * Value model
 *
 * A parsed PDF value is one of:
 *   { kind: 'dict',   map }              Map<string, value>
 *   { kind: 'array',  items }
 *   { kind: 'ref',    num, gen, target }  `target` is filled once objects exist
 *   { kind: 'name',   name }
 *   { kind: 'string', text }              raw bytes, one char per byte
 *   { kind: 'number', value }
 *
 * Keeping the kind explicit is what stops a dictionary from being confused with
 * an array that happens to be empty, and what makes stream lookup unambiguous.
 * ------------------------------------------------------------------ */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const isWhitespace = (code) => WHITESPACE.has(code)
const isDelimiter = (code) => DELIMITERS.has(code)
const isRegular = (code) => code !== undefined && !isWhitespace(code) && !isDelimiter(code)

function skipSpace(text, cursor) {
  let index = cursor
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (isWhitespace(code)) { index++; continue }
    if (code === 0x25) { // % comment runs to end of line
      while (index < text.length && text.charCodeAt(index) !== 0x0a && text.charCodeAt(index) !== 0x0d) index++
      continue
    }
    break
  }
  return index
}

/** Decodes a PDF literal string body: escapes, octal and escaped newlines. */
function decodePdfString(body) {
  let out = ''
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char !== '\\') { out += char; continue }
    const next = body[++index]
    if (next === undefined) break
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === '\n') { /* line continuation contributes nothing */ }
    else if (next === '\r') { if (body[index + 1] === '\n') index++ }
    else if (next >= '0' && next <= '7') {
      let digits = next
      while (digits.length < 3 && body[index + 1] >= '0' && body[index + 1] <= '7') digits += body[++index]
      out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff)
    } else out += next
  }
  return out
}

/** Decodes a PDF hex string body (`<...>`): two hex digits become one byte. */
function decodeHexString(body) {
  const clean = body.replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let index = 0; index + 1 < clean.length; index += 2) out += String.fromCharCode(Number.parseInt(clean.slice(index, index + 2), 16))
  if (clean.length % 2 === 1) out += String.fromCharCode(Number.parseInt(clean[clean.length - 1] + '0', 16))
  return out
}

/** Reads one value at `cursor`; returns `{ value, next }` or null when unusable. */
function readValue(text, cursor) {
  const start = skipSpace(text, cursor)
  if (start >= text.length) return null
  const code = text.charCodeAt(start)

  if (code === 0x3c) {
    if (text.charCodeAt(start + 1) === 0x3c) return readDictionary(text, start)
    const end = text.indexOf('>', start + 1)
    if (end < 0) return null
    return { value: { kind: 'string', text: decodeHexString(text.slice(start + 1, end)) }, next: end + 1 }
  }
  if (code === 0x5b) return readArray(text, start)
  if (code === 0x28) return readLiteralString(text, start)
  if (code === 0x2f) {
    let index = start + 1
    while (index < text.length && isRegular(text.charCodeAt(index))) index++
    return { value: { kind: 'name', name: text.slice(start + 1, index) }, next: index }
  }

  let index = start
  while (index < text.length && isRegular(text.charCodeAt(index))) index++
  if (index === start) return null
  const word = text.slice(start, index)

  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) && /^\d+$/.test(word)) {
    // An integer followed by `G R` is an indirect reference.
    const rest = skipSpace(text, index)
    const refMatch = /^(\d+)\s+R\b/.exec(text.slice(rest, rest + 32))
    if (refMatch) {
      return { value: { kind: 'ref', num: Number(word), gen: Number(refMatch[1]) }, next: rest + refMatch[0].length }
    }
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { value: { kind: 'number', value: Number(word) }, next: index }
  return { value: { kind: 'keyword', word }, next: index }
}

function readLiteralString(text, start) {
  let index = start + 1
  let depth = 1
  let body = ''
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') { body += char + (text[index + 1] ?? ''); index += 2; continue }
    if (char === '(') { depth++; body += char; index++; continue }
    if (char === ')') {
      depth--
      if (depth === 0) return { value: { kind: 'string', text: decodePdfString(body) }, next: index + 1 }
      body += char
      index++
      continue
    }
    body += char
    index++
  }
  return null
}

function readArray(text, start) {
  const items = []
  let cursor = start + 1
  while (cursor < text.length) {
    cursor = skipSpace(text, cursor)
    if (text.charCodeAt(cursor) === 0x5d) return { value: { kind: 'array', items }, next: cursor + 1 }
    const read = readValue(text, cursor)
    if (!read) return null
    items.push(read.value)
    cursor = read.next
  }
  return null
}

function readDictionary(text, start) {
  const map = new Map()
  let cursor = start + 2
  while (cursor < text.length) {
    cursor = skipSpace(text, cursor)
    if (text.charCodeAt(cursor) === 0x3e && text.charCodeAt(cursor + 1) === 0x3e) {
      return { value: { kind: 'dict', map }, next: cursor + 2 }
    }
    if (text.charCodeAt(cursor) !== 0x2f) { cursor++; continue }
    const keyRead = readValue(text, cursor)
    if (!keyRead) return null
    const valueRead = readValue(text, keyRead.next)
    if (!valueRead) return null
    map.set(keyRead.value.name, valueRead.value)
    cursor = valueRead.next
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Objects, streams and the resolver
 * ------------------------------------------------------------------ */

/** Inflates a stream body, tolerating both zlib and raw-deflate spellings. */
function inflateStream(body) {
  for (const inflate of [inflateSync, inflateRawSync]) {
    try { return inflate(body) } catch { /* try the next spelling */ }
  }
  return null
}

/**
 * Reads every indirect object by scanning for `N G obj`.
 *
 * Each record keeps its dictionary and its raw stream bytes; `target` on a ref is
 * not filled here because the scan may meet a reference before the object it
 * points at — the resolver does that lookup afterwards.
 *
 * Exported for tests: when extraction returns nothing, the question is always
 * "did the scan see the objects at all".
 */
function scanObjects(buffer) {
  const text = buffer.toString('latin1')
  const objects = []
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (objects.length >= PDF_LIMITS.maxObjects) break
    const bodyStart = match.index + match[0].length
    const endOfObject = text.indexOf('endobj', bodyStart)
    const bodyEnd = endOfObject < 0 ? text.length : endOfObject
    const body = text.slice(bodyStart, bodyEnd)
    const streamKeyword = /\bstream\b/.exec(body)
    let dictText = body
    let streamBytes = null

    if (streamKeyword) {
      dictText = body.slice(0, streamKeyword.index)
      // `stream` is followed by CRLF or LF; the payload starts after that EOL.
      let payloadStart = bodyStart + streamKeyword.index + 'stream'.length
      if (text.charCodeAt(payloadStart) === 0x0d) payloadStart++
      if (text.charCodeAt(payloadStart) === 0x0a) payloadStart++
      const endMarker = text.indexOf('endstream', payloadStart)
      let payloadEnd = endMarker < 0 ? bodyEnd : endMarker
      // A trailing EOL belongs to the delimiter, not to the bytes.
      if (text.charCodeAt(payloadEnd - 1) === 0x0a) payloadEnd--
      if (text.charCodeAt(payloadEnd - 1) === 0x0d) payloadEnd--
      if (payloadEnd > payloadStart) streamBytes = buffer.subarray(payloadStart, payloadEnd)
    }

    const parsed = readValue(dictText, 0)
    objects.push({
      num: Number(match[1]),
      gen: Number(match[2]),
      dict: parsed && parsed.value.kind === 'dict' ? parsed.value.map : null,
      streamBytes,
    })
    pattern.lastIndex = Math.max(pattern.lastIndex, bodyEnd)
  }
  return objects
}

/**
 * The resolver. Three distinct questions, three distinct methods — the earlier
 * version answered them with one conflated wrapper and streams silently became
 * `undefined`.
 *
 *   valueOf(x)    what this entry means (follows a ref to its dict/array/etc.)
 *   objectOf(x)   the object record a ref points at (needed for stream bytes)
 *   flatten(x)    every object record reachable from a ref, array of refs, or
 *                 direct value, in document order
 */
function makeResolver(objects) {
  const byNum = new Map()
  for (const object of objects) if (!byNum.has(object.num)) byNum.set(object.num, object)

  const objectOf = (value) => (value && value.kind === 'ref' ? byNum.get(value.num) || null : null)

  const valueOf = (value, depth = 0) => {
    if (!value || depth > PDF_LIMITS.maxDepth) return null
    if (value.kind === 'ref') {
      const target = byNum.get(value.num)
      if (!target || !target.dict) return null
      return { kind: 'dict', map: target.dict, object: target }
    }
    return value
  }

  const flatten = (value, depth = 0) => {
    if (!value || depth > PDF_LIMITS.maxDepth) return []
    if (value.kind === 'ref') {
      const target = byNum.get(value.num)
      return target ? [target] : []
    }
    if (value.kind === 'array') return value.items.flatMap((item) => flatten(item, depth + 1))
    return []
  }

  return { objectOf, valueOf, flatten, byNum }
}

/** Reads a dictionary entry as a dictionary (following one ref); null if absent. */
function dictEntry(dict, key, resolver) {
  if (!dict) return null
  const value = dict.get(key)
  if (!value) return null
  const resolved = resolver.valueOf(value)
  return resolved && resolved.kind === 'dict' ? resolved.map : null
}

/** The bytes of a stream object, inflated when it declares Flate; null otherwise. */
function streamContent(object) {
  if (!object || !object.streamBytes || object.streamBytes.length > PDF_LIMITS.maxStreamBytes) return null
  const filter = object.dict ? object.dict.get('Filter') : null
  const names = []
  if (filter && filter.kind === 'name') names.push(filter.name)
  else if (filter && filter.kind === 'array') for (const item of filter.items) if (item.kind === 'name') names.push(item.name)
  if (names.length === 0) return object.streamBytes
  if (names.length === 1 && (names[0] === 'FlateDecode' || names[0] === 'Fl')) return inflateStream(object.streamBytes)
  return null
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

/** CP1252 for 0x80–0x9F; the rest of Latin-1 is identity. */
const CP1252_HIGH = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026', 0x86: '\u2020',
  0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160', 0x8b: '\u2039', 0x8c: '\u0152',
  0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022',
  0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a',
  0x9c: '\u0153', 0x9e: '\u017e', 0x9f: '\u0178',
}

/** WinAnsi/Latin-1 byte → character. */
const decodeWinAnsi = (code) => CP1252_HIGH[code] ?? String.fromCharCode(code & 0xff)

/** UTF-16BE hex (4 digits per unit) → string, as CMaps spell destination text. */
function utf16beFromHex(hex) {
  let out = ''
  for (let index = 0; index + 4 <= hex.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16))
  }
  return out
}

/**
 * Parses a `/ToUnicode` CMap.
 *
 * Returns `{ map, codeBytes }`, where `codeBytes` is the source code width the
 * CMap declares — 1 for a simple font, 2 for an Identity-H Type0 font. Getting
 * that width wrong turns every two-byte code into two wrong characters, which is
 * why it is derived from the codespace rather than assumed.
 */
export function parseToUnicode(cmapText) {
  const map = new Map()
  let codeBytes = 1

  const noteWidth = (hex) => {
    if (hex && hex.length >= 4) codeBytes = Math.max(codeBytes, Math.ceil(hex.length / 2))
  }

  let match
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/g
  while ((match = codespace.exec(cmapText)) !== null) {
    const range = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(match[1])
    if (range) noteWidth(range[1])
  }

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  while ((match = bfchar.exec(cmapText)) !== null) {
    const pair = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g
    let entryMatch
    while ((entryMatch = pair.exec(match[1])) !== null) {
      map.set(Number.parseInt(entryMatch[1], 16), utf16beFromHex(entryMatch[2]))
      noteWidth(entryMatch[1])
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  while ((match = bfrange.exec(cmapText)) !== null) {
    const triple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g
    let entryMatch
    while ((entryMatch = triple.exec(match[1])) !== null) {
      const low = Number.parseInt(entryMatch[1], 16)
      const high = Number.parseInt(entryMatch[2], 16)
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low || high - low > 0xffff) continue
      noteWidth(entryMatch[1])
      if (entryMatch[3][0] === '[') {
        const targets = entryMatch[3].match(/<([0-9a-fA-F]*)>/g) || []
        targets.forEach((hex, offset) => map.set(low + offset, utf16beFromHex(hex.slice(1, -1))))
      } else {
        const base = utf16beFromHex(entryMatch[3].slice(1, -1))
        if (!base.length) continue
        const head = base.slice(0, -1)
        const tail = base.charCodeAt(base.length - 1)
        for (let code = low; code <= high; code++) map.set(code, head + String.fromCharCode(tail + (code - low)))
      }
    }
  }

  return { map, codeBytes }
}

/**
 * Builds `font resource name → { map, codeBytes }` for one page.
 *
 * A font without `/ToUnicode` is decoded as WinAnsi: correct for the common
 * simple-font case, and harmlessly wrong for exotic ones because the printable
 * ratio check downstream discards noise. A Type0 font without `/ToUnicode` has no
 * honest decoding, so it maps to nothing and its text is dropped instead of
 * emitting garbage.
 */
function readFonts(pageDict, resolver) {
  const fonts = new Map()
  const resources = dictEntry(pageDict, 'Resources', resolver)
  const fontDict = resources ? dictEntry(resources, 'Font', resolver) : null
  if (!fontDict) return fonts

  for (const [name, value] of fontDict) {
    const fontValue = resolver.valueOf(value)
    const fontDictMap = fontValue && fontValue.kind === 'dict' ? fontValue.map : null
    if (!fontDictMap) continue

    const toUnicode = dictEntry(fontDictMap, 'ToUnicode', resolver)
    if (toUnicode) {
      const target = resolver.objectOf(fontDictMap.get('ToUnicode'))
      const bytes = streamContent(target)
      if (bytes) {
        const cmap = parseToUnicode(bytes.toString('latin1'))
        if (cmap.map.size) { fonts.set(name, cmap); continue }
      }
    }

    const subtype = fontDictMap.get('Subtype')
    const isType0 = subtype && subtype.kind === 'name' && subtype.name === 'Type0'
    fonts.set(name, { map: null, codeBytes: isType0 ? 0 : 1 })
  }
  return fonts
}

/* ------------------------------------------------------------------ *
 * Content streams → text
 * ------------------------------------------------------------------ */

/** Decodes a shown string through the font active at that point. */
function decodeShown(raw, font) {
  if (!raw || !font) return ''
  if (!font.map) {
    if (font.codeBytes === 0) return ''
    let out = ''
    for (let index = 0; index < raw.length; index++) out += decodeWinAnsi(raw.charCodeAt(index))
    return out
  }
  const width = font.codeBytes || 1
  let out = ''
  for (let index = 0; index + width <= raw.length; index += width) {
    let code = 0
    for (let byte = 0; byte < width; byte++) code = (code << 8) | (raw.charCodeAt(index + byte) & 0xff)
    out += font.map.get(code) ?? ''
  }
  return out
}

/**
 * Walks one content stream and returns its text with line/space structure.
 *
 * Arguments accumulate into a small stack that is cleared per operator, which is
 * how a content stream is meant to be read. Unknown operators are dropped; a
 * misread operator would produce plausible-but-wrong text, which is worse.
 */
function textFromContent(content, fonts) {
  let out = ''
  const args = []
  let font = null
  let pending = ''
  let cursor = 0

  const rank = { '': 0, ' ': 1, '\n': 2 }
  const breakOn = (kind) => { if (rank[kind] > rank[pending]) pending = kind }
  const emit = (value) => {
    if (!value) return
    if (pending) { out += pending; pending = '' }
    out += value
  }

  while (cursor < content.length && out.length <= PDF_LIMITS.maxTextChars) {
    cursor = skipSpace(content, cursor)
    if (cursor >= content.length) break
    const code = content.charCodeAt(cursor)

    // An operand: string, hex string, array, name — or a number. Numbers must be
    // read here too: `12 Tf` puts two operands on the stack, and treating "12" as
    // an operator clears the stack and loses the font name with it.
    if (code === 0x28 || code === 0x3c || code === 0x5b || code === 0x2f ||
        code === 0x2b || code === 0x2d || code === 0x2e || (code >= 0x30 && code <= 0x39)) {
      const read = readValue(content, cursor)
      if (!read) { cursor++; continue }
      args.push(read.value)
      cursor = read.next
      continue
    }

    let end = cursor
    while (end < content.length && isRegular(content.charCodeAt(end))) end++
    if (end === cursor) { cursor++; continue }
    const operator = content.slice(cursor, end)
    cursor = end

    if (operator === 'Tf') {
      const name = args.find((item) => item.kind === 'name')?.name
      font = name ? fonts.get(name) || null : null
    } else if (operator === 'Tj' || operator === "'" || operator === '"') {
      if (operator !== 'Tj') breakOn('\n')
      const shown = args.find((item) => item.kind === 'string')
      emit(decodeShown(shown ? shown.text : '', font))
    } else if (operator === 'TJ') {
      const array = args.find((item) => item.kind === 'array')
      for (const item of array ? array.items : []) {
        if (item.kind === 'string') emit(decodeShown(item.text, font))
        // A kerning offset beyond a fifth of an em is a word gap, not spacing.
        else if (item.kind === 'number' && item.value < -180) breakOn(' ')
      }
    } else if (operator === 'Td' || operator === 'TD') {
      const numbers = args.filter((item) => item.kind === 'number')
      const dy = numbers.length >= 2 ? Math.abs(numbers[1].value) : 0
      const dx = numbers.length >= 1 ? Math.abs(numbers[0].value) : 0
      if (dy > 0.5) breakOn('\n')
      else if (dx > 0.5) breakOn(' ')
    } else if (operator === 'T*') {
      breakOn('\n')
    } else if (operator === 'ET') {
      breakOn('\n')
    }

    args.length = 0
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/** The fraction of characters that look like prose rather than binary noise. */
function readableRatio(text) {
  if (!text.length) return 0
  let good = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === 9 || code === 10 || code === 13) good++
    else if (code >= 0x20 && code <= 0x7e) good++        // ASCII printable
    else if (code >= 0xa0 && code <= 0x2fff) good++      // Latin-1 … punctuation
    else if (code >= 0x3000 && code <= 0x30ff) good++    // CJK punctuation, kana
    else if (code >= 0x4e00 && code <= 0x9fff) good++    // CJK unified ideographs
    else if (code >= 0xac00 && code <= 0xd7af) good++    // Hangul
    else if (code >= 0xf900 && code <= 0xfaff) good++    // CJK compatibility
    else if (code >= 0xff00 && code <= 0xffef) good++    // full-width forms
  }
  return good / text.length
}

/** Collapses the structure the extractor emitted into index-ready prose. */
function tidy(raw) {
  return raw
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extracts a PDF's text.
 *
 * Returns `{ text, reason }`: `text` is '' when nothing usable was found, and
 * `reason` names why so a skip is actionable instead of a mystery —
 * `not-pdf`, `encrypted`, `no-text`, `unreadable`.
 */
export function readPdfText(buffer) {
  if (!buffer || buffer.length < 16) return { text: '', reason: 'not-pdf' }
  const header = buffer.subarray(0, 1024).toString('latin1')
  if (!header.includes('%PDF-')) return { text: '', reason: 'not-pdf' }

  // Encryption makes every stream opaque; inflating it would be guesswork.
  // The trailer's `/Encrypt` is what matters, and it is spelled the same way in
  // object dictionaries, so one scan over the file covers both.
  const scanned = buffer.toString('latin1')
  if (/\/Encrypt\s*(<<|\d+\s+\d+\s+R)/.test(scanned)) return { text: '', reason: 'encrypted' }

  let objects
  try {
    objects = scanObjects(buffer)
  } catch {
    return { text: '', reason: 'unreadable' }
  }
  if (!objects.length) return { text: '', reason: 'unreadable' }
  const resolver = makeResolver(objects)

  const pageObjects = objects.filter((object) => {
    const type = object.dict ? object.dict.get('Type') : null
    return type && type.kind === 'name' && type.name === 'Page'
  }).slice(0, PDF_LIMITS.maxPages)

  // A file with no page objects is unusual but legal; fall back to any stream
  // that is not a font or metadata part rather than reporting nothing.
  const sources = pageObjects.length
    ? pageObjects
    : objects.filter((object) => object.streamBytes && streamContent(object)).slice(0, 1)
  if (!sources.length) return { text: '', reason: 'no-text' }

  const parts = []
  let decodedBytes = 0
  let chars = 0
  for (const page of sources) {
    const fonts = page.dict ? readFonts(page.dict, resolver) : new Map()
    let pageText = ''
    for (const content of resolver.flatten(page.dict ? page.dict.get('Contents') : null)) {
      const bytes = streamContent(content)
      if (!bytes) continue
      decodedBytes += bytes.length
      if (decodedBytes > PDF_LIMITS.maxDecodedBytes) break
      pageText += textFromContent(bytes.toString('latin1'), fonts)
      if (pageText.length > PDF_LIMITS.maxTextChars) break
    }
    const cleaned = tidy(pageText)
    if (cleaned) { parts.push(cleaned); chars += cleaned.length }
    if (chars > PDF_LIMITS.maxTextChars) break
  }

  const text = parts.join('\n\n')
  if (!text.trim()) return { text: '', reason: 'no-text' }
  // Two-byte codes decoded with the wrong width produce long runs of unassigned
  // codepoints; indexing that would create confident nonsense.
  if (readableRatio(text) < 0.6) return { text: '', reason: 'no-text' }
  return { text, reason: null }
}
