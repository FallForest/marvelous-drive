import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { startServer, uniqueEmail } from './helpers.js'
import { isPdfDocument, parseToUnicode, readPdfText } from '../src/text/pdf-text.js'
import { flattenOfficeText, pdfText } from '../src/text/office-text.js'

/**
 * PDFs in the search index.
 *
 * The drive previewed PDFs from the start and indexed nothing inside them, so
 * "which file mentions INV-2026-0042?" returned nothing when the answer was a
 * contract. The fix is an extractor, and these tests hold it to the two standards
 * that matter for a search index:
 *
 *   - a word inside a PDF is findable, with a snippet that shows it;
 *   - a PDF the extractor cannot read is *recorded as refused with a reason*
 *     instead of silently becoming a hole in coverage — otherwise "up to date"
 *     and "nothing found" become indistinguishable.
 *
 * The fixtures are real PDFs built byte by byte, so the extractor is exercised
 * against objects, streams and CMaps rather than against a mock.
 */

/**
 * Writes a small but genuinely valid PDF: real objects, real xref, real stream
 * lengths. `ops` is the page content stream, so a test can vary the text.
 */
function buildPdf({ ops, compress = true, font = 'simple', toUnicode = null, pages = null }) {
  const streams = []
  const objects = []
  const push = (text) => objects.push({ kind: 'dict', text })
  const pushStream = (dict, bytes) => objects.push({ kind: 'stream', dict, bytes })

  const content = (body) => (compress ? deflateSync(Buffer.from(body, 'latin1')) : Buffer.from(body, 'latin1'))
  const filter = compress ? ' /Filter /FlateDecode' : ''
  const fontObject = font === 'type0'
    ? '/Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /ToUnicode 6 0 R'
    : '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding'

  const pageBodies = pages || [{ ops, contentsRef: 5 }]
  const kids = pageBodies.map((page) => page.ref || '3 0 R')

  push('/Type /Catalog /Pages 2 0 R')
  push('/Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + kids.length)
  for (const page of pageBodies) {
    push('/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents ' + (page.contentsRef || 5) + ' 0 R')
  }
  push(fontObject)
  for (const page of pageBodies) {
    const bytes = content(page.ops)
    pushStream('' + filter, bytes)
  }
  pushStream('', Buffer.from(toUnicode || '', 'latin1'))

  const pieces = []
  let position = 0
  const offsets = []
  const write = (buffer) => { pieces.push(buffer); position += buffer.length }
  write(Buffer.from('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n', 'latin1'))

  objects.forEach((object, index) => {
    const num = index + 1
    offsets[num] = position
    if (object.kind === 'stream') {
      write(Buffer.from(num + ' 0 obj\n<< ' + object.dict + ' /Length ' + object.bytes.length + ' >>\nstream\n', 'latin1'))
      write(object.bytes)
      write(Buffer.from('\nendstream\nendobj\n', 'latin1'))
      return
    }
    write(Buffer.from(num + ' 0 obj\n<< ' + object.text + ' >>\nendobj\n', 'latin1'))
  })

  const xrefStart = position
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (let num = 1; num <= objects.length; num++) xref += String(offsets[num]).padStart(10, '0') + ' 00000 n \n'
  xref += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n'
  write(Buffer.from(xref, 'latin1'))
  void streams
  return Buffer.concat(pieces)
}

const escapeText = (line) => line.replace(/([()\\])/g, '\\$1')
const textOps = (lines) => [
  'BT', '/F1 12 Tf', '14 TL', '72 720 Td',
  ...lines.flatMap((line, index) => ['(' + escapeText(line) + ') Tj'].concat(index < lines.length - 1 ? ['T*'] : [])),
  'ET',
].join('\n')

describe('readPdfText', () => {
  it('extracts a compressed content stream', () => {
    const pdf = buildPdf({ ops: textOps(['the quarterly invoice INV-2026-0042 was approved by finance']) })
    const { text, reason } = readPdfText(pdf)
    assert.equal(reason, null)
    assert.match(text, /approved by finance/)
  })

  it('extracts an uncompressed content stream', () => {
    const pdf = buildPdf({ ops: textOps(['plain uncompressed body']), compress: false })
    assert.match(readPdfText(pdf).text, /plain uncompressed body/)
  })

  it('keeps line structure instead of one long run', () => {
    const pdf = buildPdf({ ops: textOps(['first line of the memo', 'second line about budgets']) })
    assert.match(readPdfText(pdf).text, /first line of the memo\nsecond line about budgets/)
  })

  it('decodes WinAnsi high bytes rather than emitting control characters', () => {
    const pdf = buildPdf({ ops: ['BT', '/F1 12 Tf', '72 720 Td', '(it\\222s approved) Tj', 'ET'].join('\n') })
    assert.match(readPdfText(pdf).text, /\u2019s approved/)
  })

  it('maps CJK through a ToUnicode CMap', () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar',
      '<4E2D> <4E2D>',
      '<6587> <6587>',
      'endbfchar',
      'endcmap CMapName currentdict /CMap defineresource pop end end',
    ].join('\n')
    const pdf = buildPdf({
      ops: ['BT', '/F1 12 Tf', '1 0 0 1 72 720 Tm', '<4E2D6587> Tj', 'ET'].join('\n'),
      font: 'type0', toUnicode: cmap,
    })
    assert.match(readPdfText(pdf).text, /中文/)
  })

  it('treats a large kerning offset inside TJ as a word gap', () => {
    const pdf = buildPdf({ ops: ['BT', '/F1 12 Tf', '72 720 Td', '[(quarterly) -400 (invoice)] TJ', 'ET'].join('\n') })
    assert.match(readPdfText(pdf).text, /quarterly invoice/)
  })

  it('names why a file was not read instead of returning empty text', () => {
    assert.equal(readPdfText(Buffer.from('hello world')).reason, 'not-pdf')
    assert.equal(readPdfText(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Encrypt 9 0 R >>\nendobj\n')).reason, 'encrypted')
    const junk = Buffer.from('%PDF-1.4\n' + '\u0001\u0002\u0003'.repeat(400), 'latin1')
    assert.equal(readPdfText(junk).reason, 'unreadable')
  })

  it('a scanned PDF has no text and says so', () => {
    // A page whose content stream draws an image and shows no strings: what a scan
    // looks like from the indexer's point of view.
    const pdf = buildPdf({ ops: ['q', '612 0 0 792 0 0 cm', '/Im1 Do', 'Q'].join('\n') })
    assert.deepEqual(readPdfText(pdf), { text: '', reason: 'no-text' })
  })
})

describe('parseToUnicode', () => {
  it('reads bfchar pairs and the declared code width', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange ' +
      '2 beginbfchar <4E2D> <4E2D> <6587> <6587> endbfchar'
    const parsed = parseToUnicode(cmap)
    assert.equal(parsed.codeBytes, 2)
    assert.equal(parsed.map.get(0x4e2d), '中')
    assert.equal(parsed.map.get(0x6587), '文')
  })

  it('expands a bfrange with an array of destinations', () => {
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange ' +
      '1 beginbfrange <41> <43> [<0041> <0042> <0043>] endbfrange'
    const parsed = parseToUnicode(cmap)
    assert.equal(parsed.codeBytes, 1)
    assert.equal(parsed.map.get(0x41), 'A')
    assert.equal(parsed.map.get(0x43), 'C')
  })
})

describe('pdfText adapter', () => {
  it('is a no-op for a non-PDF', () => {
    assert.equal(pdfText(Buffer.from('words'), 'notes.txt', 'text/plain').reason, 'not-pdf')
    // A header with nothing after it cannot be parsed at all, so it is rejected
    // as "not a PDF" rather than reported as a document with no words.
    assert.equal(pdfText(Buffer.from('%PDF-1.4\n'), 'a.pdf', 'application/pdf').reason, 'not-pdf')
    // A parseable file with no page content is a document that says nothing —
    // `no-text`, which the coverage report treats as an honest refusal.
    assert.equal(pdfText(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'), 'a.pdf', 'application/pdf').reason, 'no-text')
  })

  it('recognises a PDF by mime or by extension', () => {
    assert.equal(isPdfDocument('x.bin', 'application/pdf'), true)
    assert.equal(isPdfDocument('x.PDF', ''), true)
    assert.equal(isPdfDocument('x.docx', 'application/msword'), false)
  })

  it('does not change how Office text is flattened', () => {
    // The PDF path is additive: a deck must still flatten exactly as before.
    const text = flattenOfficeText({ pages: [{ title: 'Agenda', blocks: [{ type: 'paragraph', text: 'first point' }] }], sheets: [] })
    assert.equal(text, 'Agenda\nfirst point')
  })
})

/* ── through the API ──────────────────────────────────────────── */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'pdf search' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

async function upload(name, body, mime = 'application/pdf') {
  const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name), auth({
    raw: true, body, headers: { 'content-type': mime },
  }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

describe('PDF content search', () => {
  it('finds a word that only exists inside a PDF', async () => {
    const node = await upload('contract.pdf', buildPdf({
      ops: textOps(['service agreement for INV-2026-0042, approved by finance on 3 March']),
    }))
    const found = await api('GET', '/api/v1/search?q=approved&scope=content', auth())
    const hit = found.json.results.find((row) => row.id === node.id)
    assert.ok(hit, JSON.stringify(found.json.results))
    assert.equal(hit.matched, 'content')
    assert.match(hit.snippet, /approved/)
  })

  it('finds the invoice number itself', async () => {
    const node = await upload('po.pdf', buildPdf({ ops: textOps(['purchase order INV-2026-0042 raised today']) }))
    const found = await api('GET', '/api/v1/search?q=INV-2026-0042&scope=content', auth())
    assert.ok(found.json.results.some((row) => row.id === node.id), JSON.stringify(found.json.results))
  })

  it('finds Chinese text inside a PDF', async () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange ' +
      '2 beginbfchar <672C> <672C> <6708> <6708> endbfchar'
    const node = await upload('报表.pdf', buildPdf({
      ops: ['BT', '/F1 12 Tf', '1 0 0 1 72 720 Tm', '<672C6708> Tj', 'ET'].join('\n'),
      font: 'type0', toUnicode: cmap,
    }))
    const found = await api('GET', '/api/v1/search?q=本月&scope=content', auth())
    assert.ok(found.json.results.some((row) => row.id === node.id), JSON.stringify(found.json.results))
  })

  it('counts a PDF as covered, so coverage does not report a hole', async () => {
    const before = await api('GET', '/api/v1/maintenance/search', auth())
    await upload('fresh.pdf', buildPdf({ ops: textOps(['another searchable paragraph here']) }))
    const afterStatus = await api('GET', '/api/v1/maintenance/search', auth())
    assert.equal(afterStatus.json.coverage.missing, 0, JSON.stringify(afterStatus.json.coverage))
    assert.ok(afterStatus.json.coverage.eligible >= before.json.coverage.eligible, 'a PDF is eligible for the index')
    assert.equal(afterStatus.json.upToDate, true)
  })

  it('records a scanned PDF as refused with a reason, not as a gap', async () => {
    const scan = buildPdf({ ops: ['q', '612 0 0 792 0 0 cm', '/Im1 Do', 'Q'].join('\n') })
    await upload('scanned.pdf', scan)
    const status = await api('GET', '/api/v1/maintenance/search', auth())
    assert.ok(status.json.coverage.refused >= 1, JSON.stringify(status.json.coverage))
    assert.equal(status.json.coverage.missing, 0)
    assert.equal(status.json.upToDate, true)
  })

  it('records an encrypted PDF as refused', async () => {
    const encrypted = Buffer.concat([
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n', 'latin1'),
      Buffer.from('2 0 obj\n<< /Filter /Standard /V 2 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n', 'latin1'),
    ])
    await upload('locked.pdf', encrypted)
    const status = await api('GET', '/api/v1/maintenance/search', auth())
    assert.equal(status.json.coverage.missing, 0, JSON.stringify(status.json.coverage))
  })

  it('reindexes a PDF after it is overwritten', async () => {
    const node = await upload('revised.pdf', buildPdf({ ops: textOps(['the original wording appears here']) }))
    assert.ok((await api('GET', '/api/v1/search?q=original&scope=content', auth())).json.results.some((row) => row.id === node.id))
    await api('PUT', '/api/v1/files/' + node.id + '/content', auth({
      raw: true, body: buildPdf({ ops: textOps(['the replacement wording appears here']) }),
      headers: { 'content-type': 'application/pdf' },
    }))
    const fresh = await api('GET', '/api/v1/search?q=replacement&scope=content', auth())
    assert.ok(fresh.json.results.some((row) => row.id === node.id), JSON.stringify(fresh.json.results))
  })

  it('drops a trashed PDF from results', async () => {
    const node = await upload('gone.pdf', buildPdf({ ops: textOps(['temporary wording zydeco']) }))
    assert.ok((await api('GET', '/api/v1/search?q=zydeco&scope=content', auth())).json.results.some((row) => row.id === node.id))
    await api('DELETE', '/api/v1/nodes/' + node.id, auth())
    assert.ok(!(await api('GET', '/api/v1/search?q=zydeco&scope=content', auth())).json.results.some((row) => row.id === node.id))
  })

  it('keeps a name-only PDF match out of content scope', async () => {
    // The classic confusion: a file *called* invoice.pdf must not be a content hit
    // for "invoice" when its body never says it.
    const node = await upload('invoice-september.pdf', buildPdf({ ops: textOps(['unrelated body about logistics']) }))
    const byContent = await api('GET', '/api/v1/search?q=invoice-september&scope=content', auth())
    assert.ok(!byContent.json.results.some((row) => row.id === node.id))
    const byName = await api('GET', '/api/v1/search?q=invoice-september&scope=name', auth())
    assert.ok(byName.json.results.some((row) => row.id === node.id))
  })
})
