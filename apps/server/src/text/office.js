import { posix } from 'node:path'
import { readZip, ZipError } from './zip-read.js'

/**
 * Server-side OOXML preview extraction (pptx / docx / xlsx).
 *
 * No dependencies, no LibreOffice: an OOXML file is a ZIP of XML parts, so the
 * archive is read with ./zip-read.js and the parts are parsed by a tiny XML
 * reader below. Everything is localName-based, because the namespace prefixes
 * are chosen by the producer ("w:", "a:", "p:" are conventions, not law).
 *
 * Output shape (shared by all three kinds):
 *
 *   { kind: 'slides' | 'document' | 'sheet',
 *     pages:  [{ index, title, blocks }],          // slides + document
 *     sheets: [{ name, rows: [[{ text, type }]] }],// sheet
 *     meta:   { slideCount?, wordCount?, sheetCount?, truncated? } }
 *
 *   Block = { type:'heading', text, level }
 *         | { type:'paragraph', text }
 *         | { type:'list', items:[...] }
 *         | { type:'table', rows:[[...]] }
 *         | { type:'image', alt }
 */

export const OFFICE_LIMITS = Object.freeze({
  maxPages: 200,
  maxBlocksPerPage: 500,
  maxTableRows: 200,
  maxTableColumns: 50,
})

export class OfficeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OfficeError'
    this.code = code
  }
}

const notOffice = (message) => new OfficeError('NOT_OFFICE', message)
const unavailable = (message) => new OfficeError('PREVIEW_UNAVAILABLE', message)

/* ------------------------------------------------------------------ *
 * A minimal, non-validating XML reader
 *
 * The reader returns a tree of { name, attrs, children }; text (including
 * CDATA) is kept as { name: '#text', text } children so mixed content keeps
 * its order. Entities are decoded, comments and processing instructions are
 * skipped, and quotes inside attribute values are handled properly instead of
 * being split by a regular expression.
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

export function decodeEntities(value) {
  if (value.indexOf('&') < 0) return value
  return value.replace(ENTITY_PATTERN, (match, body) => {
    if (body.charCodeAt(0) === 35) {
      const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    const named = NAMED_ENTITIES[body]
    return named === undefined ? match : named
  })
}

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 13

function parseAttributes(source, start, end, attrs) {
  let cursor = start
  while (cursor < end) {
    while (cursor < end && isSpace(source.charCodeAt(cursor))) cursor++
    if (cursor >= end) break
    const nameStart = cursor
    while (cursor < end && !isSpace(source.charCodeAt(cursor)) && source[cursor] !== '=') cursor++
    const name = source.slice(nameStart, cursor)
    while (cursor < end && isSpace(source.charCodeAt(cursor))) cursor++
    if (source[cursor] !== '=') { if (name) attrs[name] = ''; continue }
    cursor++
    while (cursor < end && isSpace(source.charCodeAt(cursor))) cursor++
    const quote = source[cursor]
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, cursor + 1)
      const stop = close < 0 || close > end ? end : close
      attrs[name] = decodeEntities(source.slice(cursor + 1, stop))
      cursor = stop + 1
    } else {
      const valueStart = cursor
      while (cursor < end && !isSpace(source.charCodeAt(cursor))) cursor++
      attrs[name] = decodeEntities(source.slice(valueStart, cursor))
    }
  }
  return attrs
}

/**
 * Parses an XML document into { name, attrs, children } nodes.
 *
 * Deliberately tolerant: an unclosed or stray tag is ignored rather than
 * throwing, because a preview is worth more than strict validation.
 */
export function parseXml(source) {
  const text = String(source || '').replace(/^\uFEFF/, '')
  const root = { name: '#document', attrs: {}, children: [] }
  const stack = [root]
  let cursor = 0
  const length = text.length

  const top = () => stack[stack.length - 1]
  const addText = (value) => {
    if (!value) return
    const parent = top()
    const last = parent.children[parent.children.length - 1]
    if (last && last.name === '#text') last.text += value
    else parent.children.push({ name: '#text', text: value })
  }

  while (cursor < length) {
    const lt = text.indexOf('<', cursor)
    if (lt < 0) { addText(decodeEntities(text.slice(cursor))); break }
    if (lt > cursor) addText(decodeEntities(text.slice(cursor, lt)))

    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4)
      cursor = close < 0 ? length : close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9)
      const stop = close < 0 ? length : close
      addText(text.slice(lt + 9, stop))
      cursor = close < 0 ? length : close + 3
      continue
    }
    if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2)
      cursor = close < 0 ? length : close + 2
      continue
    }
    if (text.startsWith('<!', lt)) {
      let scan = lt + 2
      let depth = 0
      while (scan < length) {
        const ch = text[scan]
        if (ch === '[') depth++
        else if (ch === ']') depth--
        else if (ch === '>' && depth <= 0) break
        scan++
      }
      cursor = scan + 1
      continue
    }
    if (text.startsWith('</', lt)) {
      const close = text.indexOf('>', lt + 2)
      const stop = close < 0 ? length : close
      const name = text.slice(lt + 2, stop).trim()
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].name === name) { stack.length = index; break }
      }
      cursor = stop + 1
      continue
    }

    // Start tag. Find the closing '>' without being fooled by a '>' in a quote.
    let scan = lt + 1
    let quote = ''
    while (scan < length) {
      const ch = text[scan]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      scan++
    }
    if (scan >= length) { addText(decodeEntities(text.slice(lt))); break }
    let inner = scan
    while (inner > lt + 1 && isSpace(text.charCodeAt(inner - 1))) inner--
    const selfClosing = text[inner - 1] === '/'
    const headEnd = selfClosing ? inner - 1 : scan
    let nameEnd = lt + 1
    while (nameEnd < headEnd && !isSpace(text.charCodeAt(nameEnd))) nameEnd++
    const name = text.slice(lt + 1, nameEnd)
    const node = { name, attrs: {}, children: [] }
    if (nameEnd < headEnd) parseAttributes(text, nameEnd, headEnd, node.attrs)
    top().children.push(node)
    if (!selfClosing) stack.push(node)
    cursor = scan + 1
  }
  return root
}

/* ------------------------------------------------------------------ *
 * Tree helpers (all localName based)
 * ------------------------------------------------------------------ */

export function localName(qualified) {
  const colon = qualified.lastIndexOf(':')
  return colon < 0 ? qualified : qualified.slice(colon + 1)
}

const isElement = (node) => Boolean(node) && node.name !== '#text'

export function elements(node) {
  return node && node.children ? node.children.filter(isElement) : []
}

export function childrenNamed(node, local) {
  return elements(node).filter((child) => localName(child.name) === local)
}

export function firstChild(node, local) {
  for (const child of elements(node)) if (localName(child.name) === local) return child
  return null
}

export function findAll(node, local, out = []) {
  for (const child of elements(node)) {
    if (localName(child.name) === local) out.push(child)
    findAll(child, local, out)
  }
  return out
}

export function findFirst(node, local) {
  for (const child of elements(node)) {
    if (localName(child.name) === local) return child
    const nested = findFirst(child, local)
    if (nested) return nested
  }
  return null
}

/** Attribute by localName; an exact key match wins. */
export function attr(node, name) {
  if (!node || !node.attrs) return undefined
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name]
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === name) return node.attrs[key]
  }
  return undefined
}

/** Relationship id attribute ("r:id"): any namespaced "id", never a bare id. */
export function relAttr(node, local = 'id') {
  if (!node || !node.attrs) return undefined
  for (const key of Object.keys(node.attrs)) {
    const colon = key.lastIndexOf(':')
    if (colon > 0 && localName(key) === local) return node.attrs[key]
  }
  return undefined
}

/** Concatenated text of a subtree, in document order. */
export function textOf(node) {
  if (!node) return ''
  if (node.name === '#text') return node.text
  let out = ''
  for (const child of node.children) out += textOf(child)
  return out
}

const SKIP_IN_TEXT = new Set([
  'pPr', 'rPr', 'endParaRPr', 'defRPr', 'bodyPr', 'spPr', 'lstStyle',
  'lvl1pPr', 'lvl2pPr', 'lvl3pPr', 'lvl4pPr', 'lvl5pPr', 'lvl6pPr',
  'lvl7pPr', 'lvl8pPr', 'lvl9pPr', 'txBody',
])

/**
 * Text of a paragraph or run container.
 *
 * t/tab/br are matched by localName, so DrawingML ("a:"), WordprocessingML
 * ("w:") and any other prefix produce the same string. Property nodes are
 * skipped so style names never leak into the preview.
 */
export function runText(node) {
  let out = ''
  for (const child of elements(node)) {
    const local = localName(child.name)
    if (SKIP_IN_TEXT.has(local)) continue
    if (local === 't') { out += textOf(child); continue }
    if (local === 'tab') { out += '\t'; continue }
    if (local === 'br' || local === 'cr') { out += '\n'; continue }
    out += runText(child)
  }
  return out
}

export function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u200b]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ------------------------------------------------------------------ *
 * Package helpers
 * ------------------------------------------------------------------ */

function readPart(zip, name) {
  const bytes = zip.get(name)
  return bytes ? bytes.toString('utf8') : null
}

function readXmlPart(zip, name) {
  const text = readPart(zip, name)
  if (text == null) return null
  return parseXml(text)
}

/** Resolves a relationship target against the part that owns the rels. */
export function resolvePartTarget(basePart, target) {
  if (!target) return ''
  const clean = String(target).replace(/\\/g, '/')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return clean
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '')
  return posix.normalize(posix.join(posix.dirname(basePart), clean)).replace(/^\.\//, '')
}

/** Parses a .rels part into Map<Id, {type, target, external}>. */
export function parseRelationships(root) {
  const map = new Map()
  if (!root) return map
  for (const relationship of findAll(root, 'Relationship')) {
    const id = attr(relationship, 'Id')
    if (!id) continue
    map.set(id, {
      type: attr(relationship, 'Type') || '',
      target: attr(relationship, 'Target') || '',
      external: (attr(relationship, 'TargetMode') || '').toLowerCase() === 'external',
    })
  }
  return map
}

function relsPartFor(part) {
  const directory = posix.dirname(part)
  const file = posix.basename(part)
  return posix.join(directory, '_rels', file + '.rels')
}

/* ------------------------------------------------------------------ *
 * Kind detection
 * ------------------------------------------------------------------ */

const EXTENSION_KIND = {
  pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', ppsm: 'pptx', potx: 'pptx', potm: 'pptx',
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
}

const MIME_KIND = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.template': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
}

/** Maps a file name (and optional MIME) to pptx | docx | xlsx | null. */
export function detectOffice(name, mime) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot > 0 && dot < base.length - 1) {
    const byExtension = EXTENSION_KIND[base.slice(dot + 1).toLowerCase()]
    if (byExtension) return byExtension
  }
  const type = String(mime || '').split(';')[0].trim().toLowerCase()
  return MIME_KIND[type] || null
}

/* ------------------------------------------------------------------ *
 * PPTX
 * ------------------------------------------------------------------ */

const MAIN_PART = {
  pptx: 'ppt/presentation.xml',
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
}

const isTitlePlaceholder = (shape) => {
  const placeholder = findFirst(shape, 'ph')
  if (!placeholder) return false
  const type = String(attr(placeholder, 'type') || '').toLowerCase()
  return type === 'title' || type === 'ctrtitle'
}

const hasPlaceholder = (shape) => Boolean(findFirst(shape, 'ph'))

const slideNumber = (name) => {
  const match = /slide(\d+)\.xml$/.exec(name)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * Slide parts in presentation order.
 *
 * presentation.xml lists sldId entries whose r:id resolves through
 * presentation.xml.rels; that indirection is the real order, because a deck
 * that reordered or deleted slides has slide files whose numbers no longer
 * match their position. When the parts cannot be resolved that way (or the
 * rels are missing) the ppt/slides/slideN.xml parts are sorted numerically.
 */
export function orderedSlideParts(zip, presentation, rels) {
  const parts = []
  const seen = new Set()
  const push = (target) => {
    const part = resolvePartTarget('ppt/presentation.xml', target)
    if (!part || seen.has(part) || !zip.has(part)) return
    seen.add(part)
    parts.push(part)
  }
  const list = presentation ? findFirst(presentation, 'sldIdLst') : null
  if (list) {
    for (const sldId of childrenNamed(list, 'sldId')) {
      const id = relAttr(sldId, 'id')
      const rel = id ? rels.get(id) : null
      if (rel && !rel.external) push(rel.target)
    }
  }
  if (parts.length) return parts
  return zip.names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
}

const isListParagraph = (paragraph) => {
  const properties = firstChild(paragraph, 'pPr')
  if (!properties) return false
  return Boolean(findFirst(properties, 'buChar') || findFirst(properties, 'buAutoNum'))
}

function pushBlock(blocks, block) {
  if (!block) return
  if (block.type === 'list') {
    const last = blocks[blocks.length - 1]
    if (last && last.type === 'list') { last.items.push(...block.items); return }
  }
  blocks.push(block)
}

function paragraphBlock(paragraph) {
  const text = normalizeText(runText(paragraph))
  if (!text) return null
  if (isListParagraph(paragraph)) return { type: 'list', items: [text] }
  return { type: 'paragraph', text }
}

function tableBlock(table, limits = OFFICE_LIMITS) {
  const rows = []
  for (const rowNode of findAll(table, 'tr')) {
    if (rows.length >= limits.maxTableRows) break
    const cells = []
    for (const cell of childrenNamed(rowNode, 'tc')) {
      if (cells.length >= limits.maxTableColumns) break
      const pieces = findAll(cell, 'p')
        .map((paragraph) => normalizeText(runText(paragraph)))
        .filter(Boolean)
      cells.push(pieces.join(' '))
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return null
  return { type: 'table', rows }
}

/**
 * Blocks of one shape, in document order.
 *
 * Paragraphs (a:p) and tables (a:tbl) become blocks; property containers are
 * skipped so style names never enter the text.
 */
function shapeBlocks(shape, limits) {
  const blocks = []
  const visit = (node) => {
    for (const child of elements(node)) {
      const local = localName(child.name)
      if (local === 'tbl') { pushBlock(blocks, tableBlock(child, limits)); continue }
      if (local === 'p') { pushBlock(blocks, paragraphBlock(child)); continue }
      // Property containers only; a:txBody must be walked because it holds the
      // paragraphs of the shape.
      if (local === 'rPr' || local === 'pPr' || local === 'endParaRPr' || local === 'spPr') continue
      visit(child)
    }
  }
  visit(shape)
  return blocks
}

function pictureAlt(picture) {
  const properties = findFirst(picture, 'cNvPr')
  if (!properties) return ''
  return normalizeText(attr(properties, 'descr') || attr(properties, 'title') || attr(properties, 'name') || '')
}

function walkShapeTree(node, onShape) {
  for (const child of elements(node)) {
    const local = localName(child.name)
    if (local === 'sp' || local === 'pic' || local === 'graphicFrame') { onShape(local, child); continue }
    if (local === 'grpSp') { walkShapeTree(child, onShape); continue }
  }
}

function extractPptx(zip) {
  const presentation = readXmlPart(zip, 'ppt/presentation.xml')
  const rels = parseRelationships(readXmlPart(zip, relsPartFor('ppt/presentation.xml')))
  const slideParts = orderedSlideParts(zip, presentation, rels)
  const pages = []
  let truncated = false

  for (const part of slideParts) {
    if (pages.length >= OFFICE_LIMITS.maxPages) { truncated = true; break }
    const root = readXmlPart(zip, part)
    if (!root) continue
    const shapeTree = findFirst(root, 'spTree')
    if (!shapeTree) continue
    const blocks = []
    let title = ''
    let sawFirstShape = false

    const onShape = (local, shape) => {
      const isFirst = !sawFirstShape
      sawFirstShape = true
      if (local === 'pic') {
        if (blocks.length < OFFICE_LIMITS.maxBlocksPerPage) blocks.push({ type: 'image', alt: pictureAlt(shape) })
        return
      }
      if (local === 'graphicFrame' && findFirst(shape, 'tbl')) {
        for (const block of shapeBlocks(shape, OFFICE_LIMITS)) {
          if (blocks.length >= OFFICE_LIMITS.maxBlocksPerPage) { truncated = true; break }
          blocks.push(block)
        }
        return
      }
      // The title shape is the one with a title placeholder; the first shape of
      // a slide that carries any placeholder also counts, which covers decks
      // whose title placeholder was retyped without type="title".
      const titled = isTitlePlaceholder(shape) || (!title && isFirst && hasPlaceholder(shape))
      if (titled && !title) {
        const text = normalizeText(
          findAll(shape, 'p').map((paragraph) => normalizeText(runText(paragraph))).filter(Boolean).join(' '),
        )
        if (text) { title = text; return }
      }
      for (const block of shapeBlocks(shape, OFFICE_LIMITS)) {
        if (blocks.length >= OFFICE_LIMITS.maxBlocksPerPage) { truncated = true; break }
        pushBlock(blocks, block)
      }
    }

    walkShapeTree(shapeTree, onShape)
    pages.push({ index: pages.length + 1, title, blocks })
  }

  return {
    kind: 'slides',
    pages,
    sheets: [],
    meta: { slideCount: pages.length, truncated },
  }
}

/* ------------------------------------------------------------------ *
 * DOCX
 * ------------------------------------------------------------------ */

/**
 * Splits one WordprocessingML paragraph at hard and rendered page breaks.
 *
 * A returned segment with pageBreak=true means "this segment starts a new
 * page"; its text belongs to that new page, so text after a break accumulates
 * into the break segment rather than being dropped.
 */
function docxSegments(paragraph) {
  const segments = [{ text: '', pageBreak: false }]
  const current = () => segments[segments.length - 1]
  const visit = (node) => {
    for (const child of elements(node)) {
      const local = localName(child.name)
      if (local === 'pPr' || local === 'rPr') continue
      if (local === 't') { current().text += textOf(child); continue }
      if (local === 'tab') { current().text += '\t'; continue }
      if (local === 'lastRenderedPageBreak') { segments.push({ text: '', pageBreak: true }); continue }
      if (local === 'br' || local === 'cr') {
        if (local === 'br' && String(attr(child, 'type') || '').toLowerCase() === 'page') {
          segments.push({ text: '', pageBreak: true })
        } else {
          current().text += '\n'
        }
        continue
      }
      visit(child)
    }
  }
  visit(paragraph)
  return segments
}

function headingLevel(paragraph) {
  const properties = firstChild(paragraph, 'pPr')
  if (!properties) return 0
  const style = firstChild(properties, 'pStyle')
  const styleName = style ? String(attr(style, 'val') || '') : ''
  if (styleName) {
    const match = /heading\s*([1-9])/i.exec(styleName) || /^h([1-9])$/i.exec(styleName)
    if (match) return Number(match[1])
  }
  const outline = firstChild(properties, 'outlineLvl')
  if (outline) {
    const value = Number(attr(outline, 'val'))
    if (Number.isFinite(value) && value >= 0 && value <= 8) return value + 1
  }
  return 0
}

function isListItem(paragraph) {
  const properties = firstChild(paragraph, 'pPr')
  if (!properties) return false
  return Boolean(findFirst(properties, 'numPr'))
}

function docxTable(table) {
  const rows = []
  for (const rowNode of findAll(table, 'tr')) {
    if (rows.length >= OFFICE_LIMITS.maxTableRows) break
    const cells = []
    for (const cell of childrenNamed(rowNode, 'tc')) {
      if (cells.length >= OFFICE_LIMITS.maxTableColumns) break
      const pieces = findAll(cell, 'p')
        .map((paragraph) => normalizeText(runText(paragraph)))
        .filter(Boolean)
      cells.push(pieces.join(' '))
    }
    if (cells.length) rows.push(cells)
  }
  return rows.length ? { type: 'table', rows } : null
}

function countWords(text) {
  const matches = String(text).match(/[A-Za-z0-9'\u2019]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)
  return matches ? matches.length : 0
}

/**
 * Paginates the body.
 *
 * A .docx has no page model of its own: page breaks are either explicit
 * (w:br w:type="page"), a paragraph-level w:pageBreakBefore, or hints the last
 * renderer left behind (w:lastRenderedPageBreak). The first two always split;
 * the third splits too, because it is the only pagination information a real
 * Word file carries. A document with none of them stays one page.
 */
function extractDocx(zip) {
  const document = readXmlPart(zip, 'word/document.xml')
  if (!document) throw unavailable('The document part is missing from the archive.')
  const body = findFirst(document, 'body') || document
  const pages = []
  let pageIndex = 0
  let truncated = false

  const startPage = () => {
    pageIndex += 1
    const page = { index: pageIndex, title: '', blocks: [] }
    pages.push(page)
    return page
  }
  let page = startPage()

  const appendBlock = (block) => {
    if (!block) return
    if (page.blocks.length >= OFFICE_LIMITS.maxBlocksPerPage) { truncated = true; return }
    pushBlock(page.blocks, block)
  }

  const blockFor = (paragraph, text) => {
    const level = headingLevel(paragraph)
    if (level > 0) {
      if (!page.title) page.title = text
      return { type: 'heading', text, level }
    }
    if (isListItem(paragraph)) return { type: 'list', items: [text] }
    return { type: 'paragraph', text }
  }

  const visitContainer = (container) => {
    for (const child of elements(container)) {
      const local = localName(child.name)
      if (local === 'p') {
        const properties = firstChild(child, 'pPr')
        const breakBefore = properties ? findFirst(properties, 'pageBreakBefore') : null
        const forced = breakBefore ? String(attr(breakBefore, 'val') || 'true').toLowerCase() !== 'false' : false
        if (forced && (page.blocks.length || page.title)) {
          if (pages.length >= OFFICE_LIMITS.maxPages) { truncated = true; break }
          page = startPage()
        }
        for (const segment of docxSegments(child)) {
          if (segment.pageBreak && (page.blocks.length || page.title)) {
            if (pages.length >= OFFICE_LIMITS.maxPages) { truncated = true; break }
            page = startPage()
          }
          const text = normalizeText(segment.text)
          if (!text) continue
          appendBlock(blockFor(child, text))
        }
        continue
      }
      if (local === 'tbl') { appendBlock(docxTable(child)); continue }
      if (local === 'sdt' || local === 'sdtContent' || local === 'body' || local === 'txbxContent') {
        visitContainer(child)
      }
    }
  }

  visitContainer(body)

  const allText = pages.flatMap((item) => item.blocks.flatMap((block) => {
    if (block.text) return [block.text]
    if (block.items) return block.items
    if (block.rows) return block.rows.flat()
    return []
  })).join(' ')

  return {
    kind: 'document',
    pages,
    sheets: [],
    meta: { wordCount: countWords(allText), truncated },
  }
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

const columnIndex = (reference) => {
  const match = /^([A-Za-z]+)/.exec(String(reference || ''))
  if (!match) return -1
  let index = 0
  for (const character of match[1].toUpperCase()) index = index * 26 + (character.charCodeAt(0) - 64)
  return index - 1
}

function sharedStrings(root) {
  if (!root) return []
  const table = findFirst(root, 'sst')
  if (!table) return []
  const values = []
  for (const item of childrenNamed(table, 'si')) values.push(normalizeText(textOf(item)))
  return values
}

function cellValue(cell, strings) {
  const type = String(attr(cell, 't') || '').toLowerCase()
  if (type === 'inlinestr') {
    const inline = firstChild(cell, 'is')
    return { text: normalizeText(inline ? textOf(inline) : ''), type: 'string' }
  }
  const valueNode = firstChild(cell, 'v')
  const raw = valueNode ? textOf(valueNode) : ''
  if (type === 's') {
    const index = Number(raw)
    const text = Number.isInteger(index) && index >= 0 && index < strings.length ? strings[index] : ''
    return { text, type: 'string' }
  }
  if (type === 'b') {
    const truthy = raw.trim() === '1' || raw.trim().toLowerCase() === 'true'
    return { text: truthy ? 'TRUE' : 'FALSE', type: 'boolean' }
  }
  if (type === 'str') return { text: normalizeText(raw), type: 'string' }
  if (type === 'e') return { text: raw.trim(), type: 'error' }
  if (type === 'd') return { text: raw.trim(), type: 'date' }
  const trimmed = raw.trim()
  if (!trimmed) return { text: '', type: 'empty' }
  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return { text: trimmed, type: 'string' }
  // Excel stores raw floats: 32.799999999999997 and 616.79999999999995 are the
  // binary forms of 32.8 and 616.8. Show the shortest form that round-trips to
  // the same double, which is what a spreadsheet cell actually displays.
  return { text: shortestNumber(trimmed), type: 'number' }
}

/** Shortest decimal that parses back to the same double, or the input. */
function shortestNumber(text) {
  const value = Number(text)
  if (!Number.isFinite(value) || !text.includes('.')) return text
  for (let digits = 1; digits <= 15; digits += 1) {
    const candidate = Number(value.toPrecision(digits))
    if (String(candidate) === text || candidate === value && String(candidate).length < text.length) {
      return String(candidate)
    }
  }
  return text
}

function sheetRows(root, strings) {
  const data = findFirst(root, 'sheetData')
  if (!data) return { rows: [], truncated: false }
  const rows = []
  let truncated = false
  for (const rowNode of childrenNamed(data, 'row')) {
    if (rows.length >= OFFICE_LIMITS.maxTableRows) { truncated = true; break }
    const row = []
    let nextColumn = 0
    for (const cell of childrenNamed(rowNode, 'c')) {
      const declared = columnIndex(attr(cell, 'r'))
      const column = declared >= 0 ? declared : nextColumn
      if (column >= OFFICE_LIMITS.maxTableColumns) { truncated = true; continue }
      while (row.length < column) row.push({ text: '', type: 'empty' })
      row[column] = cellValue(cell, strings)
      nextColumn = column + 1
    }
    rows.push(row)
  }
  return { rows, truncated }
}

const XLSX_LIMITS = { maxRows: 200, maxColumns: 50 }

function extractXlsx(zip) {
  const workbook = readXmlPart(zip, 'xl/workbook.xml')
  if (!workbook) throw unavailable('The workbook part is missing from the archive.')
  const rels = parseRelationships(readXmlPart(zip, relsPartFor('xl/workbook.xml')))
  const strings = sharedStrings(readXmlPart(zip, 'xl/sharedStrings.xml'))
  const sheets = []
  let truncated = false

  const sheetList = findFirst(workbook, 'sheets')
  const sheetNodes = sheetList ? childrenNamed(sheetList, 'sheet') : []

  for (const [position, sheetNode] of sheetNodes.entries()) {
    const name = String(attr(sheetNode, 'name') || 'Sheet' + (position + 1))
    const id = relAttr(sheetNode, 'id')
    const rel = id ? rels.get(id) : null
    const target = rel && !rel.external ? resolvePartTarget('xl/workbook.xml', rel.target) : ''
    const part = target && zip.has(target) ? target : 'xl/worksheets/sheet' + (position + 1) + '.xml'
    const root = zip.has(part) ? readXmlPart(zip, part) : null
    const result = root ? sheetRows(root, strings) : { rows: [], truncated: false }
    if (result.truncated) truncated = true
    sheets.push({ name, rows: result.rows })
  }

  return {
    kind: 'sheet',
    pages: [],
    sheets,
    meta: { sheetCount: sheets.length, truncated },
  }
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

const EXTRACTORS = { pptx: extractPptx, docx: extractDocx, xlsx: extractXlsx }

/**
 * Extracts a preview structure from an OOXML buffer.
 *
 * Throws OfficeError('NOT_OFFICE') when the bytes are not an OOXML package and
 * OfficeError('PREVIEW_UNAVAILABLE') when a package cannot be parsed.
 */
export function extractOffice(buffer, kind) {
  const extractor = EXTRACTORS[kind]
  if (!extractor) throw notOffice('Unsupported office kind: ' + String(kind) + '.')
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw notOffice('The file is too small to be an OOXML package.')

  let zip
  try {
    zip = readZip(buffer)
  } catch (error) {
    if (error instanceof ZipError && error.code === 'NOT_ZIP') throw notOffice('The file is not a ZIP container.')
    if (error instanceof ZipError) throw unavailable('The OOXML package is damaged: ' + error.message)
    throw unavailable('The OOXML package could not be read: ' + (error && error.message ? error.message : 'unknown error'))
  }

  const mainPart = MAIN_PART[kind]
  if (!zip.has(mainPart)) {
    throw notOffice('The archive does not contain ' + mainPart + '; it is not a ' + kind + ' file.')
  }

  try {
    const result = extractor(zip)
    if (!Array.isArray(result.pages)) result.pages = []
    if (!Array.isArray(result.sheets)) result.sheets = []
    if (!result.meta || typeof result.meta !== 'object') result.meta = {}
    return result
  } catch (error) {
    if (error instanceof OfficeError) throw error
    if (error instanceof ZipError) throw unavailable('The OOXML package is damaged: ' + error.message)
    throw unavailable('The ' + kind + ' content could not be parsed: ' + (error && error.message ? error.message : 'unknown error'))
  }
}
