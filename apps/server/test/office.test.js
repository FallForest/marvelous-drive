import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { after, before, describe, it } from 'node:test'
import { readZip, readZipEntry, ZipError } from '../src/text/zip-read.js'
import {
  OFFICE_LIMITS,
  OfficeError,
  detectOffice,
  extractOffice,
  parseXml,
} from '../src/text/office.js'
import { startServer, uniqueEmail } from './helpers.js'

/**
 * OOXML preview: ZIP reader, extractor, and the real HTTP route.
 *
 * The fixtures are generated here, on the fly, by a tiny ZIP/OOXML writer:
 * the project may not download samples or add dependencies, so every .pptx,
 * .docx and .xlsx below is assembled from XML strings and node:zlib. The HTTP
 * tests then upload those bytes through the real server and read them back
 * through GET /api/v1/files/:id/office, which is the path a browser takes.
 */

/* ------------------------------------------------------------------ *
 * A minimal ZIP writer (the mirror image of src/zip-read.js)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Builds a ZIP from { name, data, method, descriptor, payload, size } entries.
 *
 * payload + size let a test forge a broken entry (a "deflate" stream that is
 * not deflate) without touching the archive layout by hand.
 */
function buildZip(entries) {
  const bodies = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const method = entry.method === 0 ? 0 : 8
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data == null ? '' : entry.data), 'utf8')
    const payload = entry.payload ? Buffer.from(entry.payload) : method === 8 ? deflateRawSync(data) : data
    const size = entry.size === undefined ? data.length : entry.size
    const crc = entry.payload ? 0 : crc32(data)
    const flags = 0x0800 | (entry.descriptor ? 0x0008 : 0)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(entry.descriptor ? 0 : crc, 14)
    local.writeUInt32LE(entry.descriptor ? 0 : payload.length, 18)
    local.writeUInt32LE(entry.descriptor ? 0 : size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const chunks = [local, name, payload]
    if (entry.descriptor) {
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(payload.length, 8)
      descriptor.writeUInt32LE(size, 12)
      chunks.push(descriptor)
    }
    const body = Buffer.concat(chunks)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    bodies.push(body)
    centrals.push(Buffer.concat([central, name]))
    offset += body.length
  }
  const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...bodies, ...centrals, end])
}

/**
 * Builds the same archive with a ZIP64 end-of-central-directory record and a
 * ZIP64 locator, the way an archiver writes it for large inputs. The 16-bit
 * EOCD fields are set to their 0xffff sentinels, so a reader that ignores the
 * ZIP64 record sees a truncated directory.
 */
function buildZip64(entries) {
  const plain = buildZip(entries)
  const eocdOffset = plain.length - 22
  const centralSize = plain.readUInt32LE(eocdOffset + 12)
  const centralOffset = plain.readUInt32LE(eocdOffset + 16)

  const zip64 = Buffer.alloc(56)
  zip64.writeUInt32LE(0x06064b50, 0)
  zip64.writeBigUInt64LE(44n, 4)
  zip64.writeUInt16LE(45, 12)
  zip64.writeUInt16LE(45, 14)
  zip64.writeUInt32LE(0, 16)
  zip64.writeUInt32LE(0, 20)
  zip64.writeBigUInt64LE(BigInt(entries.length), 24)
  zip64.writeBigUInt64LE(BigInt(entries.length), 32)
  zip64.writeBigUInt64LE(BigInt(centralSize), 40)
  zip64.writeBigUInt64LE(BigInt(centralOffset), 48)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(eocdOffset), 8)
  locator.writeUInt32LE(1, 16)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)

  return Buffer.concat([plain.subarray(0, eocdOffset), zip64, locator, end])
}

/* ------------------------------------------------------------------ *
 * OOXML fixture builders
 * ------------------------------------------------------------------ */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

const contentTypes = (overrides) => [
  XML_HEAD,
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '  <Default Extension="xml" ContentType="application/xml"/>',
  ...overrides,
  '</Types>',
].join('\n')

const relationships = (items) => [
  XML_HEAD,
  '<Relationships xmlns="' + NS_REL + '">',
  ...items.map((item) => '  <Relationship Id="' + item.id + '" Type="' + item.type + '" Target="' + item.target + '"/>'),
  '</Relationships>',
].join('\n')

const packageRels = (mainTarget) => relationships([{
  id: 'rId1',
  type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  target: mainTarget,
}])

const drawingParagraph = (text, bullet, level) => {
  const properties = bullet
    ? '<a:pPr lvl="' + (level || 0) + '"><a:buChar char="&#8226;"/></a:pPr>'
    : level === undefined ? '' : '<a:pPr lvl="' + level + '"/>'
  return '<a:p>' + properties + '<a:r><a:rPr lang="en-US" dirty="0"/><a:t>' + text + '</a:t></a:r></a:p>'
}

const slideTitleShape = (text) => [
  '<p:sp>',
  '  <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>',
  '  <p:spPr/>',
  '  <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/>' + drawingParagraph(text) + '</p:txBody>',
  '</p:sp>',
].join('\n')

const slideBodyShape = (paragraphs) => [
  '<p:sp>',
  '  <p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>',
  '  <p:spPr/>',
  '  <p:txBody><a:bodyPr/><a:lstStyle/>',
  ...paragraphs,
  '  </p:txBody>',
  '</p:sp>',
].join('\n')

const slideTableShape = (rows) => [
  '<p:graphicFrame>',
  '  <p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>',
  '  <p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>',
  '  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>',
  '    <a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="10"/><a:gridCol w="10"/></a:tblGrid>',
  ...rows.map((cells) => '    <a:tr h="10">' + cells.map((cell) =>
    '<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>' + cell + '</a:t></a:r></a:p></a:txBody></a:tc>').join('') + '</a:tr>'),
  '  </a:tbl></a:graphicData></a:graphic>',
  '</p:graphicFrame>',
].join('\n')

const slidePictureShape = (alt) => [
  '<p:pic>',
  '  <p:nvPicPr><p:cNvPr id="5" name="Picture 4" descr="' + alt + '"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>',
  '  <p:blipFill><a:blip r:embed="rId9"/></p:blipFill>',
  '  <p:spPr/>',
  '</p:pic>',
].join('\n')

const slideXml = (shapes) => [
  XML_HEAD,
  '<p:sld xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">',
  '  <p:cSld><p:spTree>',
  '    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
  '    <p:grpSpPr><a:xfrm/></p:grpSpPr>',
  ...shapes,
  '  </p:spTree></p:cSld>',
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
  '</p:sld>',
].join('\n')

/**
 * A three-slide deck. presentation.xml lists the slides as 2, 3, 1, so a reader
 * that falls back to numeric file order is caught immediately.
 */
function buildPptx() {
  const presentation = [
    XML_HEAD,
    '<p:presentation xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">',
    '  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId9"/></p:sldMasterIdLst>',
    '  <p:sldIdLst>',
    '    <p:sldId id="256" r:id="rId2"/>',
    '    <p:sldId id="257" r:id="rId3"/>',
    '    <p:sldId id="258" r:id="rId1"/>',
    '  </p:sldIdLst>',
    '  <p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>',
    '</p:presentation>',
  ].join('\n')

  const presentationRels = relationships([
    { id: 'rId1', type: NS_R + '/slide', target: 'slides/slide1.xml' },
    { id: 'rId2', type: NS_R + '/slide', target: 'slides/slide2.xml' },
    { id: 'rId3', type: NS_R + '/slide', target: 'slides/slide3.xml' },
    { id: 'rId9', type: NS_R + '/slideMaster', target: 'slideMasters/slideMaster1.xml' },
  ])

  const slide1 = slideXml([
    slideTitleShape('R&amp;D &lt;2026&gt; preview'),
    slideBodyShape([
      drawingParagraph('Agenda &amp; goals', false),
      drawingParagraph('Budget', true),
      drawingParagraph('Hiring', true),
    ]),
  ])

  const slide2 = slideXml([
    slideTitleShape('Second slide in order'),
    slideTableShape([['Region', 'Revenue'], ['EMEA', '1.2M']]),
    slidePictureShape('A quarterly chart'),
  ])

  // A group shape: the walker has to descend into p:grpSp.
  const slide3 = slideXml([
    slideTitleShape('Third slide in order'),
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 9"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '<p:grpSpPr/>',
    slideBodyShape([drawingParagraph('Nested inside a group', false)]),
    '</p:grpSp>',
  ])

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes([
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
      '<Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
    ]) },
    { name: '_rels/.rels', data: packageRels('ppt/presentation.xml') },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels },
    { name: 'ppt/slides/slide1.xml', data: slide1, descriptor: true },
    { name: 'ppt/slides/slide2.xml', data: slide2 },
    { name: 'ppt/slides/slide3.xml', data: slide3 },
  ])
}

/**
 * One WordprocessingML paragraph.
 *
 * A run is either plain text (wrapped in w:r/w:t) or { xml } carrying raw run
 * markup such as a page break, so a break never ends up inside a w:t element.
 */
const wParagraph = (options) => {
  const properties = []
  if (options.style) properties.push('<w:pStyle w:val="' + options.style + '"/>')
  if (options.list) properties.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
  const runs = (options.runs || [options.text || '']).map((run) => {
    if (run && typeof run === 'object') return run.xml
    return '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + run + '</w:t></w:r>'
  }).join('')
  return '<w:p>' + (properties.length ? '<w:pPr>' + properties.join('') + '</w:pPr>' : '') + runs + '</w:p>'
}

function buildDocx() {
  const body = [
    wParagraph({ style: 'Heading1', text: 'Contract overview' }),
    wParagraph({ runs: ['A paragraph with an &amp; entity', ' and a second run.'] }),
    wParagraph({ list: true, text: 'Bullet one' }),
    wParagraph({ list: true, text: 'Bullet two' }),
    '<w:tbl>',
    '  <w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>',
    '  <w:tblGrid><w:gridCol w:w="100"/><w:gridCol w:w="100"/></w:tblGrid>',
    '  <w:tr><w:tc>' + wParagraph({ text: 'Col A' }) + '</w:tc><w:tc>' + wParagraph({ text: 'Col B' }) + '</w:tc></w:tr>',
    '  <w:tr><w:tc>' + wParagraph({ text: 'Cell 2' }) + '</w:tc><w:tc>' + wParagraph({ text: '' }) + '</w:tc></w:tr>',
    '</w:tbl>',
    wParagraph({ runs: ['Before the break', { xml: '<w:r><w:br w:type="page"/></w:r>' }, 'After the break'] }),
    wParagraph({ style: 'Heading2', text: 'Appendix' }),
    wParagraph({ text: 'Inside the second page' }),
    '<w:sdt><w:sdtPr><w:alias w:val="note"/></w:sdtPr><w:sdtContent>',
    wParagraph({ text: 'Wrapped in a content control' }),
    '</w:sdtContent></w:sdt>',
    wParagraph({ runs: ['Draft copy', { xml: '<w:r><w:lastRenderedPageBreak/><w:t>Rendered page three</w:t></w:r>' }] }),
  ]
  const document = [
    XML_HEAD,
    '<w:document xmlns:w="' + NS_W + '" xmlns:r="' + NS_R + '">',
    '<w:body>',
    ...body,
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
    '</w:body>',
    '</w:document>',
  ].join('\n')

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes([
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    ]) },
    { name: '_rels/.rels', data: packageRels('word/document.xml') },
    { name: 'word/document.xml', data: document },
  ])
}

function buildXlsx() {
  const workbook = [
    XML_HEAD,
    '<x:workbook xmlns:x="' + NS_X + '" xmlns:r="' + NS_R + '">',
    '  <x:sheets>',
    '    <x:sheet name="Inventory" sheetId="1" r:id="rId1"/>',
    '    <x:sheet name="Totals &amp; Summary" sheetId="2" r:id="rId2"/>',
    '  </x:sheets>',
    '</x:workbook>',
  ].join('\n')

  const workbookRels = relationships([
    { id: 'rId1', type: NS_R + '/worksheet', target: 'worksheets/sheet1.xml' },
    { id: 'rId2', type: NS_R + '/worksheet', target: 'worksheets/sheet2.xml' },
    { id: 'rId3', type: NS_R + '/sharedStrings', target: 'sharedStrings.xml' },
  ])

  const strings = [
    XML_HEAD,
    '<x:sst xmlns:x="' + NS_X + '" count="4" uniqueCount="3">',
    '  <x:si><x:t>Name</x:t></x:si>',
    '  <x:si><x:t>Qty</x:t></x:si>',
    '  <x:si><x:r><x:rPr><x:b/></x:rPr><x:t>Total </x:t></x:r><x:r><x:t>(kg)</x:t></x:r></x:si>',
    '</x:sst>',
  ].join('\n')

  const sheet1 = [
    XML_HEAD,
    '<x:worksheet xmlns:x="' + NS_X + '"><x:sheetData>',
    '  <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="C1" t="s"><x:v>2</x:v></x:c></x:row>',
    '  <x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>Bolts</x:t></x:is></x:c><x:c r="B2"><x:v>42</x:v></x:c><x:c r="C2" t="b"><x:v>1</x:v></x:c></x:row>',
    '  <x:row r="3"><x:c r="A3" t="str"><x:f>CONCAT("a","b")</x:f><x:v>ab</x:v></x:c><x:c r="B3"><x:f>6*7</x:f><x:v>42</x:v></x:c></x:row>',
    '</x:sheetData></x:worksheet>',
  ].join('\n')

  const sheet2 = [
    XML_HEAD,
    '<x:worksheet xmlns:x="' + NS_X + '"><x:sheetData>',
    '  <x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Start</x:t></x:is></x:c><x:c r="D1"><x:v>99</x:v></x:c></x:row>',
    '</x:sheetData></x:worksheet>',
  ].join('\n')

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes([
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ]) },
    { name: '_rels/.rels', data: packageRels('xl/workbook.xml') },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/sharedStrings.xml', data: strings },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1 },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2, method: 0 },
  ])
}

/** Spreadsheet column reference for a 1-based column number (1 -> A, 27 -> AA). */
const columnLetter = (column) => {
  let value = column
  let letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return letters
}

/** A workbook with 210 rows and 60 columns, for the truncation limits. */
function buildWideSheet() {
  const rows = []
  for (let row = 1; row <= 210; row++) {
    const cells = []
    for (let column = 1; column <= 60; column++) {
      const letter = columnLetter(column)
      cells.push('<x:c r="' + letter + row + '"><x:v>' + (row * column) + '</x:v></x:c>')
    }
    rows.push('  <x:row r="' + row + '">' + cells.join('') + '</x:row>')
  }
  return buildZip([
    { name: '_rels/.rels', data: packageRels('xl/workbook.xml') },
    { name: 'xl/workbook.xml', data: [
      XML_HEAD,
      '<x:workbook xmlns:x="' + NS_X + '" xmlns:r="' + NS_R + '">',
      '  <x:sheets><x:sheet name="Wide" sheetId="1" r:id="rId1"/></x:sheets>',
      '</x:workbook>',
    ].join('\n') },
    { name: 'xl/_rels/workbook.xml.rels', data: relationships([
      { id: 'rId1', type: NS_R + '/worksheet', target: 'worksheets/sheet1.xml' },
    ]) },
    { name: 'xl/worksheets/sheet1.xml', data: [
      XML_HEAD,
      '<x:worksheet xmlns:x="' + NS_X + '"><x:sheetData>',
      ...rows,
      '</x:sheetData></x:worksheet>',
    ].join('\n') },
  ])
}

/* ------------------------------------------------------------------ *
 * zip-read
 * ------------------------------------------------------------------ */

describe('zip-read', () => {
  it('reads stored and deflated entries by name', () => {
    const archive = readZip(buildZip([
      { name: 'a.txt', data: 'stored payload', method: 0 },
      { name: 'b.txt', data: 'deflated payload '.repeat(20) },
    ]))
    assert.equal(archive.get('a.txt').toString('utf8'), 'stored payload')
    assert.equal(archive.get('b.txt').toString('utf8'), 'deflated payload '.repeat(20))
    assert.equal(archive.get('missing.txt'), undefined)
    assert.deepEqual(archive.names(), ['a.txt', 'b.txt'])
    const lone = buildZip([{ name: 'x/y.txt', data: 'nested' }])
    assert.equal(readZipEntry(lone, 'x/y.txt').toString('utf8'), 'nested')
    assert.equal(readZipEntry(lone, 'nope.txt'), null)
  })

  it('handles an entry written with a data descriptor', () => {
    const archive = readZip(buildZip([{ name: 'd.txt', data: 'descriptor body', descriptor: true }]))
    assert.equal(archive.get('d.txt').toString('utf8'), 'descriptor body')
  })

  it('normalises backslashes and leading ./ in names', () => {
    const archive = readZip(buildZip([{ name: 'ppt/slides/slide1.xml', data: '<a/>' }]))
    assert.ok(archive.has('ppt\\slides\\slide1.xml'))
    assert.ok(archive.has('./ppt/slides/slide1.xml'))
    assert.equal(archive.get('ppt\\slides\\slide1.xml').toString('utf8'), '<a/>')
  })

  it('reads a ZIP64 archive instead of crashing', () => {
    const archive = readZip(buildZip64([
      { name: 'a.txt', data: 'zip64 stored', method: 0 },
      { name: 'b.txt', data: 'zip64 deflated '.repeat(10) },
    ]))
    assert.equal(archive.get('a.txt').toString('utf8'), 'zip64 stored')
    assert.equal(archive.get('b.txt').toString('utf8'), 'zip64 deflated '.repeat(10))
  })

  it('reports ZIP64_UNSUPPORTED when the locator is missing', () => {
    const zip64 = buildZip64([{ name: 'a.txt', data: 'x' }])
    // Drop the locator record: the 0xffff sentinels now point at nothing.
    const broken = Buffer.concat([zip64.subarray(0, zip64.length - 42), zip64.subarray(zip64.length - 22)])
    assert.throws(() => readZip(broken), (error) => {
      assert.equal(error.code, 'ZIP64_UNSUPPORTED')
      return true
    })
  })

  it('rejects a buffer that is not a ZIP archive', () => {
    assert.throws(() => readZip(Buffer.from('this is definitely not a zip file, not at all')), (error) => {
      assert.ok(error instanceof ZipError)
      assert.equal(error.code, 'NOT_ZIP')
      return true
    })
  })

  it('refuses a zip bomb instead of inflating it', () => {
    const bomb = buildZip([{ name: 'zeros.bin', data: Buffer.alloc(40 * 1024 * 1024) }])
    const archive = readZip(bomb)
    assert.throws(() => archive.get('zeros.bin'), (error) => {
      assert.equal(error.code, 'LIMIT')
      return true
    })
    // The entry names stay readable: only the bytes are refused.
    assert.deepEqual(archive.names(), ['zeros.bin'])
  })

  it('enforces the entry count and the caller-supplied caps', () => {
    const many = buildZip(Array.from({ length: 12 }, (unused, index) => ({ name: 'f' + index + '.txt', data: 'x' })))
    assert.throws(() => readZip(many, { maxEntries: 5 }), (error) => {
      assert.equal(error.code, 'LIMIT')
      return true
    })
    const one = readZip(buildZip([{ name: 'big.txt', data: 'y'.repeat(500) }]), { maxEntryBytes: 100 })
    assert.throws(() => one.get('big.txt'), (error) => {
      assert.equal(error.code, 'LIMIT')
      return true
    })
    const total = readZip(buildZip([
      { name: 'a.txt', data: 'z'.repeat(80) },
      { name: 'b.txt', data: 'z'.repeat(80) },
    ]), { maxTotalBytes: 100 })
    assert.equal(total.get('a.txt').length, 80)
    assert.throws(() => total.get('b.txt'), (error) => {
      assert.equal(error.code, 'LIMIT')
      return true
    })
  })
})

/* ------------------------------------------------------------------ *
 * XML and extraction (no HTTP)
 * ------------------------------------------------------------------ */

describe('office extraction', () => {
  it('parses entities, CDATA and namespaced attributes', () => {
    const root = parseXml([
      '<w:document xmlns:w="' + NS_W + '" xmlns:r="' + NS_R + '">',
      '  <w:p><w:r><w:t>a &amp; b &lt;c&gt; &#65;</w:t></w:r></w:p>',
      '  <w:p><w:r><w:t><![CDATA[raw <tag> text]]></w:t></w:r></w:p>',
      '  <x:thing r:id="rId7" w:val="Heading1"/>',
      '</w:document>',
    ].join('\n'))
    const document = root.children.find((node) => node.name === 'w:document')
    const paragraphs = document.children.filter((node) => node.name === 'w:p')
    assert.equal(paragraphs[0].children[0].children[0].children[0].text, 'a & b <c> A')
    assert.equal(paragraphs[1].children[0].children[0].children[0].text, 'raw <tag> text')
    const thing = document.children.find((node) => node.name === 'x:thing')
    assert.equal(thing.attrs['r:id'], 'rId7')
    assert.equal(thing.attrs['w:val'], 'Heading1')
  })

  it('detects the kind from the extension first and the MIME second', () => {
    assert.equal(detectOffice('deck.pptx', null), 'pptx')
    assert.equal(detectOffice('Report.DOCX', 'text/plain'), 'docx')
    assert.equal(detectOffice('book.xlsm', null), 'xlsx')
    assert.equal(detectOffice('no-extension', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx')
    assert.equal(detectOffice('photo.png', 'image/png'), null)
    assert.equal(detectOffice('', null), null)
  })

  it('returns the exact slides shape for a deck', () => {
    const result = extractOffice(buildPptx(), 'pptx')
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'meta', 'pages', 'sheets'])
    assert.equal(result.kind, 'slides')
    assert.equal(result.pages.length, 3)
    assert.equal(result.meta.slideCount, 3)
    assert.equal(result.meta.truncated, false)
    assert.deepEqual(Object.keys(result.pages[0]).sort(), ['blocks', 'index', 'title'])
    assert.deepEqual(result.pages.map((page) => page.index), [1, 2, 3])
  })

  it('follows presentation.xml order instead of file numbering', () => {
    const result = extractOffice(buildPptx(), 'pptx')
    assert.deepEqual(result.pages.map((page) => page.title), [
      'Second slide in order',
      'Third slide in order',
      'R&D <2026> preview',
    ])
  })

  it('collects title, paragraphs, lists, tables and pictures', () => {
    const pages = extractOffice(buildPptx(), 'pptx').pages
    const third = pages[2]
    assert.deepEqual(third.blocks[0], { type: 'paragraph', text: 'Agenda & goals' })
    assert.deepEqual(third.blocks[1], { type: 'list', items: ['Budget', 'Hiring'] })
    const first = pages[0]
    assert.deepEqual(first.blocks[0], { type: 'table', rows: [['Region', 'Revenue'], ['EMEA', '1.2M']] })
    assert.deepEqual(first.blocks[1], { type: 'image', alt: 'A quarterly chart' })
    // The group shape is walked, so its text is not lost.
    assert.deepEqual(pages[1].blocks[0], { type: 'paragraph', text: 'Nested inside a group' })
  })

  it('paginates a document at hard and rendered page breaks', () => {
    const result = extractOffice(buildDocx(), 'docx')
    assert.equal(result.kind, 'document')
    assert.equal(result.pages.length, 3)
    assert.equal(result.pages[0].title, 'Contract overview')
    assert.equal(result.pages[1].title, 'Appendix')
    assert.ok(result.meta.wordCount > 10)
    assert.deepEqual(result.pages.map((page) => page.blocks.length), [5, 5, 1])

    const first = result.pages[0].blocks
    assert.deepEqual(first[0], { type: 'heading', text: 'Contract overview', level: 1 })
    assert.equal(first[1].text, 'A paragraph with an & entity and a second run.')
    assert.deepEqual(first[2], { type: 'list', items: ['Bullet one', 'Bullet two'] })
    assert.deepEqual(first[3], { type: 'table', rows: [['Col A', 'Col B'], ['Cell 2', '']] })

    assert.deepEqual(result.pages[1].blocks[0], { type: 'paragraph', text: 'After the break' })
    assert.deepEqual(result.pages[1].blocks[1], { type: 'heading', text: 'Appendix', level: 2 })
    assert.equal(result.pages[1].blocks[2].text, 'Inside the second page')
    // A w:sdt content control is transparent: its paragraphs keep flowing.
    assert.equal(result.pages[1].blocks[3].text, 'Wrapped in a content control')
    assert.equal(result.pages[2].blocks[0].text, 'Rendered page three')
  })

  it('keeps a document without page breaks on one page', () => {
    const flat = buildZip([
      { name: '_rels/.rels', data: packageRels('word/document.xml') },
      { name: 'word/document.xml', data: [
        XML_HEAD,
        '<w:document xmlns:w="' + NS_W + '"><w:body>',
        wParagraph({ style: 'Heading1', text: 'Only heading' }),
        wParagraph({ text: 'First paragraph' }),
        wParagraph({ text: 'Second paragraph' }),
        '</w:body></w:document>',
      ].join(String.fromCharCode(10)) },
    ])
    const result = extractOffice(flat, 'docx')
    assert.equal(result.pages.length, 1)
    assert.equal(result.pages[0].title, 'Only heading')
    assert.deepEqual(result.pages[0].blocks.map((block) => block.type), ['heading', 'paragraph', 'paragraph'])
  })

  it('falls back to numeric slide order when the deck has no slide list', () => {
    // presentation.xml present (so it really is a deck) but without sldIdLst or
    // rels: the only usable order is the numeric file suffix.
    const shuffled = buildZip([
      { name: 'ppt/presentation.xml', data: '<p:presentation xmlns:p="' + NS_P + '"/>' },
      { name: 'ppt/slides/slide2.xml', data: slideXml([slideTitleShape('Slide two')]) },
      { name: 'ppt/slides/slide10.xml', data: slideXml([slideTitleShape('Slide ten')]) },
      { name: 'ppt/slides/slide1.xml', data: slideXml([slideTitleShape('Slide one')]) },
    ])
    const result = extractOffice(shuffled, 'pptx')
    assert.deepEqual(result.pages.map((page) => page.title), ['Slide one', 'Slide two', 'Slide ten'])
    assert.equal(result.meta.slideCount, 3)
  })

  it('reads sheets through the workbook relationships', () => {
    const result = extractOffice(buildXlsx(), 'xlsx')
    assert.equal(result.kind, 'sheet')
    assert.deepEqual(result.pages, [])
    assert.deepEqual(Object.keys(result.sheets[0]).sort(), ['name', 'rows'])
    assert.deepEqual(result.sheets.map((sheet) => sheet.name), ['Inventory', 'Totals & Summary'])
    assert.deepEqual(result.meta, { sheetCount: 2, truncated: false })

    const rows = result.sheets[0].rows
    assert.deepEqual(rows[0], [
      { text: 'Name', type: 'string' },
      { text: 'Qty', type: 'string' },
      { text: 'Total (kg)', type: 'string' },
    ])
    assert.deepEqual(rows[1], [
      { text: 'Bolts', type: 'string' },
      { text: '42', type: 'number' },
      { text: 'TRUE', type: 'boolean' },
    ])
    assert.deepEqual(rows[2][0], { text: 'ab', type: 'string' })
    assert.deepEqual(rows[2][1], { text: '42', type: 'number' })

    // Sparse references keep their column positions.
    const second = result.sheets[1].rows[0]
    assert.equal(second.length, 4)
    assert.deepEqual(second[0], { text: 'Start', type: 'string' })
    assert.deepEqual(second[1], { text: '', type: 'empty' })
    assert.deepEqual(second[3], { text: '99', type: 'number' })
  })

  it('truncates huge sheets at 200 rows and 50 columns', () => {
    const result = extractOffice(buildWideSheet(), 'xlsx')
    assert.equal(result.meta.truncated, true)
    assert.equal(result.sheets[0].rows.length, 200)
    assert.equal(result.sheets[0].rows[0].length, 50)
    assert.equal(OFFICE_LIMITS.maxTableRows, 200)
    assert.equal(OFFICE_LIMITS.maxTableColumns, 50)
  })

  it('survives a different namespace prefix', () => {
    const archive = readZip(buildDocx())
    const renamed = archive.get('word/document.xml').toString('utf8').split('w:').join('word:')
    const swapped = buildZip([
      { name: '_rels/.rels', data: packageRels('word/document.xml') },
      { name: 'word/document.xml', data: renamed },
    ])
    const result = extractOffice(swapped, 'docx')
    assert.equal(result.pages.length, 3)
    assert.deepEqual(result.pages[0].blocks[0], { type: 'heading', text: 'Contract overview', level: 1 })
  })

  it('reports NOT_OFFICE for foreign bytes and PREVIEW_UNAVAILABLE for damage', () => {
    assert.throws(() => extractOffice(Buffer.from('plain text pretending to be a deck'), 'pptx'), (error) => {
      assert.ok(error instanceof OfficeError)
      assert.equal(error.code, 'NOT_OFFICE')
      return true
    })
    const alien = buildZip([{ name: 'readme.txt', data: 'nothing here' }])
    assert.throws(() => extractOffice(alien, 'pptx'), (error) => {
      assert.equal(error.code, 'NOT_OFFICE')
      return true
    })
    // Right part name, undecodable slide stream.
    const broken = buildZip([
      { name: 'ppt/presentation.xml', data: '<p:presentation xmlns:p="' + NS_P + '"/>' },
      { name: 'ppt/slides/slide1.xml', method: 8, payload: Buffer.from('this is not a deflate stream'), size: 27 },
    ])
    assert.throws(() => extractOffice(broken, 'pptx'), (error) => {
      assert.equal(error.code, 'PREVIEW_UNAVAILABLE')
      return true
    })
    assert.throws(() => extractOffice(buildPptx(), 'pdf'), (error) => {
      assert.equal(error.code, 'NOT_OFFICE')
      return true
    })
  })
})

/* ------------------------------------------------------------------ *
 * The route, through the real server
 * ------------------------------------------------------------------ */

describe('GET /api/v1/files/:id/office', () => {
  let app
  let token

  before(async () => {
    app = await startServer()
    const registered = await app.client('POST', '/api/v1/auth/register', {
      body: { email: uniqueEmail(), password: 'office preview password' },
    })
    token = registered.json.token
  })

  after(async () => {
    await app.close()
    app.cleanup()
  })

  const upload = async (name, buffer, mime) => app.client('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), {
    body: buffer,
    raw: true,
    token,
    headers: { 'content-type': mime || 'application/octet-stream' },
  })

  const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  it('previews an uploaded .pptx', async () => {
    const uploaded = await upload('deck.pptx', buildPptx(), PPTX_MIME)
    assert.equal(uploaded.status, 201)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.json).sort(), ['file', 'office'])
    assert.deepEqual(Object.keys(response.json.file).sort(), ['id', 'mime', 'name', 'size'])
    assert.equal(response.json.file.name, 'deck.pptx')
    assert.equal(response.json.file.mime, PPTX_MIME)
    assert.ok(response.json.file.size > 0)
    assert.equal(response.json.office.kind, 'slides')
    assert.equal(response.json.office.pages[0].title, 'Second slide in order')
    assert.equal(response.json.office.meta.slideCount, 3)
  })

  it('previews an uploaded .docx', async () => {
    const uploaded = await upload('contract.docx', buildDocx(), DOCX_MIME)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 200)
    assert.equal(response.json.office.kind, 'document')
    assert.deepEqual(response.json.office.pages.map((page) => page.index), [1, 2, 3])
    assert.equal(response.json.office.pages[1].blocks[1].text, 'Appendix')
  })

  it('previews an uploaded .xlsx', async () => {
    const uploaded = await upload('inventory.xlsx', buildXlsx(), XLSX_MIME)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 200)
    assert.equal(response.json.office.kind, 'sheet')
    assert.deepEqual(response.json.office.sheets.map((sheet) => sheet.name), ['Inventory', 'Totals & Summary'])
    assert.deepEqual(response.json.office.meta, { sheetCount: 2, truncated: false })
  })

  it('answers 400 NOT_OFFICE for a file that is not OOXML', async () => {
    const uploaded = await upload('notes.txt', Buffer.from('just text'), 'text/plain')
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'NOT_OFFICE')
  })

  it('answers 400 NOT_OFFICE when the extension lies about the bytes', async () => {
    const uploaded = await upload('fake.pptx', Buffer.from('PK not really'), PPTX_MIME)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'NOT_OFFICE')
  })

  it('answers 422 PREVIEW_UNAVAILABLE for a damaged package', async () => {
    const broken = buildZip([
      { name: 'ppt/presentation.xml', data: '<p:presentation xmlns:p="' + NS_P + '"/>' },
      { name: 'ppt/slides/slide1.xml', method: 8, payload: Buffer.from('corrupted deflate payload'), size: 26 },
    ])
    const uploaded = await upload('broken.pptx', broken, PPTX_MIME)
    assert.equal(uploaded.status, 201)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 422)
    assert.equal(response.json.error.code, 'PREVIEW_UNAVAILABLE')
  })

  it('refuses an unauthenticated request', async () => {
    const uploaded = await upload('deck2.pptx', buildPptx(), PPTX_MIME)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'UNAUTHENTICATED')
  })

  it('refuses a folder id with NOT_A_FILE', async () => {
    const created = await app.client('POST', '/api/v1/nodes', { token, body: { name: 'Deck folder', kind: 'folder' } })
    const response = await app.client('GET', '/api/v1/files/' + created.json.node.id + '/office', { token })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'NOT_A_FILE')
  })

  it('answers 413 for a blob above the preview ceiling', async () => {
    const huge = Buffer.alloc(64 * 1024 * 1024 + 1024, 0x50)
    const uploaded = await upload('huge.pptx', huge, PPTX_MIME)
    assert.equal(uploaded.status, 201)
    const response = await app.client('GET', '/api/v1/files/' + uploaded.json.node.id + '/office', { token })
    assert.equal(response.status, 413)
    assert.equal(response.json.error.code, 'FILE_TOO_LARGE')
  })
})
