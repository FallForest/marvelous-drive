import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reusableShareUrl, shareUrlOf } from '../lib/actions.js'
import { conflictingNames, existingFileNames, existingFilesIn } from '../lib/uploads.js'
import { trashRetentionClause, trashRetentionNote } from '../lib/files.js'

/**
 * The business-flow rules that used to be implied by a click.
 *
 * Nothing here touches the DOM: each helper is the decision half of a flow whose
 * other half is a toast or a dialog, so the rule can be asserted without a
 * browser. The three groups map to the three UI fixes they protect:
 *
 *  - copying a link must REUSE a live one, never mint a second public link;
 *  - an upload must only ask about names that are really taken;
 *  - the trash wording must follow the deployment, where 0 means "never".
 */

// Share URLs are made absolute against the page origin, which does not exist
// under node --test; one fixed fake origin keeps the assertions exact.
globalThis.window = { location: { origin: 'http://localhost' } }

const share = (extra) => ({ token: 'tok', url: '/s/tok', permission: 'downloader', hasPassword: false, ...extra })

describe('reusableShareUrl (UI03)', () => {
  it('reuses a live downloader link instead of creating another', () => {
    assert.equal(reusableShareUrl([share()], Date.now()), 'http://localhost/s/tok')
  })

  it('ignores links that are not downloader links', () => {
    assert.equal(reusableShareUrl([share({ permission: 'viewer' })], Date.now()), '')
  })

  it('ignores a password-protected link, which the copier could not open', () => {
    assert.equal(reusableShareUrl([share({ hasPassword: true })], Date.now()), '')
  })

  it('ignores an expired link', () => {
    const expired = share({ expiresAt: '2020-01-01T00:00:00.000Z' })
    assert.equal(reusableShareUrl([expired], Date.parse('2026-01-01T00:00:00.000Z')), '')
    const future = share({ expiresAt: '2030-01-01T00:00:00.000Z' })
    assert.equal(reusableShareUrl([future], Date.parse('2026-01-01T00:00:00.000Z')), 'http://localhost/s/tok')
  })

  it('ignores a link that has spent its download budget', () => {
    assert.equal(reusableShareUrl([share({ maxDownloads: 3, downloads: 3 })], Date.now()), '')
    assert.equal(reusableShareUrl([share({ maxDownloads: 3, downloads: 2 })], Date.now()), 'http://localhost/s/tok')
  })

  it('picks the first usable link out of a mixed list', () => {
    const list = [share({ token: 'old', hasPassword: true }), share({ token: 'good', url: '/s/good' })]
    assert.equal(reusableShareUrl(list, Date.now()), 'http://localhost/s/good')
  })

  it('answers empty for no candidates at all', () => {
    assert.equal(reusableShareUrl([], Date.now()), '')
    assert.equal(reusableShareUrl(null, Date.now()), '')
  })
})

describe('shareUrlOf (UI03)', () => {
  it('keeps an absolute url untouched', () => {
    assert.equal(shareUrlOf({ url: 'https://drive.example/s/x' }), 'https://drive.example/s/x')
  })

  it('rebuilds the origin for a relative url', () => {
    assert.equal(shareUrlOf({ url: '/s/x' }), 'http://localhost/s/x')
  })

  it('falls back to the token when the server sends no url', () => {
    assert.equal(shareUrlOf({ token: 'abc' }), 'http://localhost/s/abc')
  })
})

describe('upload conflict detection (UI04)', () => {
  const index = {
    children: new Map([
      ['root', [
        { id: 'f1', name: 'report.pdf', kind: 'file' },
        { id: 'd1', name: 'photos', kind: 'folder' },
      ]],
      ['sub', [{ id: 'f2', name: 'notes.txt', kind: 'file' }]],
    ]),
  }

  it('collects only files of the target folder', () => {
    assert.deepEqual([...existingFileNames(index, null)], ['report.pdf'])
    assert.deepEqual([...existingFileNames(index, 'sub')], ['notes.txt'])
  })

  it('never treats a folder with the same name as a conflict', () => {
    const files = [{ name: 'photos' }]
    assert.equal(conflictingNames(new Set(existingFileNames(index, null)), files).size, 0)
  })

  it('reports the names that are really taken', () => {
    const files = [{ name: 'report.pdf' }, { name: 'fresh.txt' }]
    const conflicts = conflictingNames(new Set(existingFileNames(index, null)), files)
    assert.deepEqual([...conflicts], ['report.pdf'])
  })

  it('counts one conflict per name, not per picked file', () => {
    const files = [{ name: 'report.pdf' }, { name: 'report.pdf' }]
    assert.equal(conflictingNames(new Set(existingFileNames(index, null)), files).size, 1)
  })

  it('maps names to the node that already owns them', () => {
    const files = existingFilesIn(index, 'sub')
    assert.equal(files.get('notes.txt').id, 'f2')
  })

  it('is empty when the folder is not in the index yet', () => {
    assert.equal(existingFilesIn(index, 'missing').size, 0)
    assert.equal(existingFileNames(null, null).size, 0)
  })
})

describe('trash retention wording (UI08)', () => {
  it('uses the deployment retention window', () => {
    assert.equal(trashRetentionClause({ trash: { retentionDays: 7 } }), '7 天内可以还原。')
    assert.equal(trashRetentionNote({ trash: { retentionDays: 7 } }), '删除的文件会先进入回收站，7 天内可以还原。')
  })

  it('says "1 天" without a trailing plural for a one-day window', () => {
    assert.equal(trashRetentionClause({ trash: { retentionDays: 1 } }), '1 天内可以还原。')
  })

  it('states that auto-purge is off when the window is 0', () => {
    assert.equal(trashRetentionNote({ trash: { retentionDays: 0 } }), '删除的文件会先进入回收站，本部署未开启自动清理。')
  })

  it('falls back to the generic wording when stats are not loaded', () => {
    const generic = '删除的文件会先进入回收站，可随时还原。'
    assert.equal(trashRetentionNote(null), generic)
    assert.equal(trashRetentionNote(undefined), generic)
    assert.equal(trashRetentionNote({}), generic)
    assert.equal(trashRetentionNote({ trash: null }), generic)
  })

  it('does not mistake a missing field for "auto-purge is off"', () => {
    const generic = '删除的文件会先进入回收站，可随时还原。'
    assert.equal(trashRetentionNote({ trash: {} }), generic)
    assert.equal(trashRetentionNote({ trash: { retentionDays: null } }), generic)
    assert.equal(trashRetentionNote({ trash: { retentionDays: undefined } }), generic)
  })
})
