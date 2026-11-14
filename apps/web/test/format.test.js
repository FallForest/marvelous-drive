import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bytes, sortNodes, relativeTime, escapeHtml, extension, expiryLabel, fileKind } from '../lib/format.js'

/** Pure helpers the file list depends on; no DOM needed. */

describe('bytes', () => {
  it('formats byte counts with binary units', () => {
    assert.equal(bytes(0), '0 B')
    assert.equal(bytes(512), '512 B')
    assert.equal(bytes(1024), '1.0 KB')
    assert.equal(bytes(1536), '1.5 KB')
    assert.equal(bytes(8 * 1024 * 1024), '8.0 MB')
    assert.equal(bytes(2 * 1024 ** 3), '2.0 GB')
  })

  it('treats missing or negative values as zero instead of printing NaN', () => {
    assert.equal(bytes(undefined), '0 B')
    assert.equal(bytes(null), '0 B')
    assert.equal(bytes(-5), '0 B')
    assert.equal(bytes('nonsense'), '0 B')
  })
})

describe('sortNodes', () => {
  const nodes = [
    { id: '1', kind: 'file', name: 'b.txt', size: 10, updatedAt: '2026-01-02T00:00:00.000Z' },
    { id: '2', kind: 'folder', name: 'zeta', size: 0, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '3', kind: 'file', name: 'A.txt', size: 100, updatedAt: '2026-01-03T00:00:00.000Z' },
  ]

  it('puts folders first and sorts names case-insensitively', () => {
    assert.deepEqual(sortNodes(nodes, 'name').map((node) => node.name), ['zeta', 'A.txt', 'b.txt'])
  })

  it('applies size and date keys to files with the requested direction', () => {
    assert.deepEqual(sortNodes(nodes, 'size', 'desc').map((node) => node.name), ['zeta', 'A.txt', 'b.txt'])
    assert.deepEqual(sortNodes(nodes, 'updated', 'desc').map((node) => node.name), ['zeta', 'A.txt', 'b.txt'])
    assert.deepEqual(sortNodes(nodes, 'updated').map((node) => node.name), ['zeta', 'b.txt', 'A.txt'])
  })

  it('does not mutate the input array', () => {
    const copy = nodes.map((node) => node.name)
    sortNodes(nodes, 'name')
    assert.deepEqual(nodes.map((node) => node.name), copy)
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z')

  it('speaks in the Docs voice', () => {
    assert.equal(relativeTime('2026-11-10T11:59:30.000Z', now), '刚刚')
    assert.equal(relativeTime('2026-11-10T11:45:00.000Z', now), '15 分钟前')
    assert.equal(relativeTime('2026-11-10T09:00:00.000Z', now), '3 小时前')
    assert.equal(relativeTime('2026-11-08T12:00:00.000Z', now), '2 天前')
  })

  it('returns an empty string for a missing or unparsable date', () => {
    assert.equal(relativeTime(null, now), '')
    assert.equal(relativeTime('not a date', now), '')
  })
})

describe('expiryLabel', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z')

  it('describes the remaining budget', () => {
    assert.equal(expiryLabel(null, now), '永不过期')
    assert.equal(expiryLabel('2026-11-10T18:00:00.000Z', now), '6 小时后过期')
    assert.equal(expiryLabel('2026-11-12T12:00:00.000Z', now), '2 天后过期')
    assert.equal(expiryLabel('2026-11-09T12:00:00.000Z', now), '已过期')
  })
})

describe('escapeHtml', () => {
  it('defuses markup in file names', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
    assert.equal(escapeHtml('a & b "c"'), 'a &amp; b &quot;c&quot;')
  })
})

describe('extension', () => {
  it('reads the suffix of a name', () => {
    assert.equal(extension('report.MD'), 'md')
    assert.equal(extension('archive.tar.gz'), 'gz')
    assert.equal(extension('README'), '')
  })
})
describe('fileKind for formats the server cannot extract', () => {
  it('marks Apple iWork as opaque, not as an office document', () => {
    // Routing these to /office returned 400: .pages is a ZIP of IWA protobuf,
    // not OOXML, so the drawer showed "无法预览" for a perfectly valid file.
    for (const name of ['report.pages', 'budget.numbers', 'deck.key']) {
      assert.equal(fileKind('application/octet-stream', name), 'opaque', name)
    }
  })

  it('marks a legacy binary .doc as opaque when the mime says OLE', () => {
    assert.equal(fileKind('application/msword', 'old.doc'), 'opaque')
    assert.equal(fileKind('application/vnd.ms-excel', 'old.xls'), 'opaque')
    assert.equal(fileKind('application/vnd.ms-powerpoint', 'old.ppt'), 'opaque')
  })

  it('still recognises the OOXML formats it can extract', () => {
    assert.equal(fileKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), 'doc')
    assert.equal(fileKind('', 'b.pptx'), 'slides')
    assert.equal(fileKind('', 'c.xlsx'), 'sheet')
  })

  it('keeps the new document and image extensions classifiable', () => {
    assert.equal(fileKind('application/epub+zip', 'book.epub'), 'epub')
    assert.equal(fileKind('image/heic', 'IMG_1.heic'), 'image')
    assert.equal(fileKind('application/octet-stream', 'IMG_1.heif'), 'image')
    assert.equal(fileKind('', 'scan.tiff'), 'image')
    assert.equal(fileKind('', 'clip.mov'), 'video')
    assert.equal(fileKind('', 'song.opus'), 'audio')
    assert.equal(fileKind('', 'subs.srt'), 'text')
  })
})
