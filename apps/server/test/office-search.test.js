import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServer, uniqueEmail } from './helpers.js';
import { flattenOfficeText, officeText } from '../src/text/office-text.js';

/**
 * Office documents in the search index.
 *
 * The preview extractor already parses pptx/docx/xlsx; search should reuse it
 * instead of leaving those files invisible. The fixtures are built here with
 * the same minimal OOXML writer the office tests use, so no binary assets are
 * committed.
 */

/* ── a minimal OOXML writer ─────────────────────────────────────── */

function deflate(buffer) {
  return zlib.deflateRawSync(buffer);
}
import zlib from 'node:zlib';

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const data = Buffer.from(raw);
    const compressed = deflate(data);
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const header = Buffer.concat([local, nameBuffer, compressed]);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header);
    central.push(Buffer.concat([directory, nameBuffer]));
    offset += header.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';

/** A one-slide deck whose text is the secret word. */
function buildPptx(word) {
  return buildZip({
    '[Content_Types].xml': CONTENT_TYPES,
    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Deck title</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>' + word + '</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>',
  });
}

/** A one-paragraph document whose text is the secret word. */
function buildDocx(word) {
  return buildZip({
    '[Content_Types].xml': CONTENT_TYPES,
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>' + word + '</w:t></w:r></w:p></w:body></w:document>',
  });
}

/** A one-cell spreadsheet whose text is the secret word. */
function buildXlsx(word) {
  return buildZip({
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="s" xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>' + word + '</t></is></c></row></sheetData></worksheet>',
  });
}

describe('flattenOfficeText', () => {
  it('joins titles, paragraphs, lists and table rows', () => {
    const text = flattenOfficeText({
      pages: [{ title: 'Agenda', blocks: [
        { type: 'paragraph', text: 'first point' },
        { type: 'list', items: ['one', 'two'] },
        { type: 'table', rows: [[{ text: 'Region' }, { text: 'Revenue' }], [{ text: 'EMEA' }, { text: '1.2M' }]] },
      ] }],
      sheets: [],
    });
    assert.match(text, /Agenda/);
    assert.match(text, /first point/);
    assert.match(text, /one\ntwo/);
    assert.match(text, /Region \| Revenue/);
    assert.match(text, /EMEA \| 1\.2M/);
  });

  it('joins sheet rows and skips empty cells', () => {
    const text = flattenOfficeText({
      pages: [],
      sheets: [{ name: 'Sheet1', rows: [[{ text: 'a' }, { text: '' }, { text: 'c' }]] }],
    });
    assert.match(text, /a \| c/);
  });

  it('returns an empty string for nothing', () => {
    assert.equal(flattenOfficeText(null), '');
    assert.equal(flattenOfficeText({ pages: [], sheets: [] }), '');
  });
});

describe('officeText', () => {
  it('extracts the text of a real pptx token', () => {
    const text = officeText(buildPptx('quarterly-widget'), 'deck.pptx', 'application/octet-stream');
    assert.match(text, /quarterly-widget/);
    assert.match(text, /Deck title/);
  });

  it('returns empty for a file that is not OOXML', () => {
    assert.equal(officeText(Buffer.from('plain'), 'notes.txt', 'text/plain'), '');
    assert.equal(officeText(Buffer.from('%PDF-1.4'), 'a.pdf', 'application/pdf'), '');
  });

  it('never throws on a corrupt package', () => {
    assert.equal(officeText(Buffer.from('PK\u0003\u0004broken'), 'deck.pptx', 'application/octet-stream'), '');
  });
});

/* ── through the API ──────────────────────────────────────────── */

let app;
let api;
let token;

before(async () => {
  app = await startServer();
  api = app.client;
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'office search' } });
  token = registered.json.token;
});

after(async () => {
  await app.close();
  app.cleanup();
});

const auth = (extra = {}) => ({ token, ...extra });

async function upload(name, buffer, mime) {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body: buffer, headers: { 'content-type': mime },
  }));
  assert.equal(response.status, 201, response.text);
  return response.json.node;
}

describe('office content search', () => {
  it('finds a deck by a word on a slide', async () => {
    const node = await upload('roadmap.pptx', buildPptx('quarterly-widget'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const found = await api('GET', '/api/v1/search?q=quarterly-widget&scope=content', auth());
    assert.equal(found.status, 200);
    assert.ok(found.json.results.some((row) => row.id === node.id), JSON.stringify(found.json.results));
  });

  it('finds a document by a word in a paragraph', async () => {
    const node = await upload('memo.docx', buildDocx('reimbursement-policy'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const found = await api('GET', '/api/v1/search?q=reimbursement-policy&scope=content', auth());
    assert.ok(found.json.results.some((row) => row.id === node.id));
  });

  it('finds a sheet by a word in a cell', async () => {
    const node = await upload('budget.xlsx', buildXlsx('cost-centre-42'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const found = await api('GET', '/api/v1/search?q=cost-centre-42&scope=content', auth());
    assert.ok(found.json.results.some((row) => row.id === node.id));
  });

  it('stops finding the old text after an overwrite', async () => {
    const node = await upload('changing.docx', buildDocx('retired-word'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok((await api('GET', '/api/v1/search?q=retired-word&scope=content', auth())).json.results.some((r) => r.id === node.id));
    await api('PUT', `/api/v1/files/${node.id}/content`, auth({
      raw: true, body: buildDocx('replacement-word'),
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    }));
    const old = await api('GET', '/api/v1/search?q=retired-word&scope=content', auth());
    assert.ok(!old.json.results.some((r) => r.id === node.id), 'the old body must leave the index');
    const fresh = await api('GET', '/api/v1/search?q=replacement-word&scope=content', auth());
    assert.ok(fresh.json.results.some((r) => r.id === node.id));
  });
});
