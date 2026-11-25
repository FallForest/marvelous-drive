import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSharePatch,
  expiryOptions,
  initialExpiryValue,
  seedShareForm,
  shareAbsoluteUrl,
  shareAvailability,
  shareSettingsLine,
} from '../lib/share-edit.js'

/**
 * The rules an in-place edit must not break.
 *
 * The dialog itself needs a DOM, but every decision it makes — which fields the
 * PATCH names, what "keep" means, whether a link is openable — is a pure
 * function. Those are the parts that were wrong in the naive implementation:
 * a form that re-sends the seeded expiry turns "change the cap" into "renew the
 * link", and an availability check that honours the counter for a viewer makes a
 * downgrade from an exhausted downloader link look dead.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(webRoot, 'lib/share-edit.js'), 'utf8')

const DOWNLOADER = {
  id: 'share-1',
  token: 'tok',
  url: '/s/tok',
  permission: 'downloader',
  expiresAt: null,
  maxDownloads: 5,
  downloads: 2,
  hasPassword: false,
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** A form value set as the dialog would hold it after seeding one row. */
const seedOf = (share, extra) => ({ ...seedShareForm(share), ...(extra || {}) })

describe('share availability', () => {
  it('keeps a viewer link usable even when its old download cap is spent', () => {
    const viewer = { ...DOWNLOADER, permission: 'viewer', maxDownloads: 2, downloads: 2 }
    assert.deepEqual(shareAvailability(viewer), { usable: true, state: 'active', label: '有效' })
  })

  it('marks an exhausted downloader link unusable', () => {
    const spent = { ...DOWNLOADER, maxDownloads: 2, downloads: 2 }
    const result = shareAvailability(spent)
    assert.equal(result.usable, false)
    assert.equal(result.state, 'exhausted')
  })

  it('prefers trashed over every other state, and expired over exhausted', () => {
    const trashed = { ...DOWNLOADER, maxDownloads: 1, downloads: 1, node: { deletedAt: '2026-01-02T00:00:00.000Z' } }
    assert.equal(shareAvailability(trashed).state, 'trashed')
    const both = { ...DOWNLOADER, maxDownloads: 1, downloads: 1, expiresAt: '2026-01-01T00:00:00.000Z' }
    assert.equal(shareAvailability(both, Date.parse('2026-02-01T00:00:00.000Z')).state, 'expired')
  })

  it('trusts the server state word when the listing sends one', () => {
    assert.equal(shareAvailability({ ...DOWNLOADER, state: 'trashed' }).state, 'trashed')
    assert.equal(shareAvailability({ ...DOWNLOADER, state: 'active' }).usable, true)
  })
})

describe('share URL', () => {
  it('completes a relative url and passes an absolute one through', () => {
    assert.equal(shareAbsoluteUrl({ url: '/s/abc' }), '/s/abc', 'no window: no origin to invent')
    assert.equal(shareAbsoluteUrl({ url: 'https://drive.example/s/abc' }), 'https://drive.example/s/abc')
  })

  it('builds the URL from the token when the server sent none', () => {
    assert.equal(shareAbsoluteUrl({ token: 'a/b' }), '/s/a%2Fb')
  })

  it('returns nothing rather than a fragment that resolves nowhere', () => {
    assert.equal(shareAbsoluteUrl({}), '')
    assert.equal(shareAbsoluteUrl(null), '')
    // The same function is absolute once a page provides an origin.
    globalThis.window = { location: { origin: 'https://drive.example' } }
    try {
      assert.equal(shareAbsoluteUrl({ url: '/s/abc' }), 'https://drive.example/s/abc')
      assert.equal(shareAbsoluteUrl({ token: 'abc' }), 'https://drive.example/s/abc')
    } finally {
      delete globalThis.window
    }
  })
})

describe('share settings line', () => {
  it('spells out permission, password, usage and expiry', () => {
    const line = shareSettingsLine({ ...DOWNLOADER, hasPassword: true, expiresAt: '2099-01-01T00:00:00.000Z' })
    assert.match(line, /可下载/)
    assert.match(line, /带密码/)
    assert.match(line, /已下载 2\/5 次/)
    assert.match(line, /天后过期/)
  })

  it('does not present a spent viewer counter as a budget it is still under', () => {
    const line = shareSettingsLine({ ...DOWNLOADER, permission: 'viewer', maxDownloads: 2, downloads: 2 })
    assert.match(line, /仅查看/)
    assert.ok(!/\/2 次/.test(line), line)
    assert.match(line, /已下载 2 次/, 'the history is still worth a word')
  })

  it('says 永不过期 when there is no expiry', () => {
    assert.match(shareSettingsLine({ ...DOWNLOADER, expiresAt: null }), /永不过期/)
  })
})

describe('expiry choices', () => {
  it('offers "keep" only when there is an expiry to keep, with its real label', () => {
    assert.equal(initialExpiryValue(DOWNLOADER), 'never')
    const withExpiry = expiryOptions({ ...DOWNLOADER, expiresAt: '2099-01-01T00:00:00.000Z' })
    assert.equal(withExpiry[0].value, 'keep')
    assert.match(withExpiry[0].label, /保持当前/)
    assert.ok(!expiryOptions(DOWNLOADER).some((option) => option.value === 'keep'))
  })

  it('shows an expired link in the keep slot instead of hiding the fact', () => {
    const expired = { ...DOWNLOADER, expiresAt: '2020-01-01T00:00:00.000Z' }
    assert.equal(initialExpiryValue(expired), 'keep')
    assert.match(expiryOptions(expired)[0].label, /已过期/)
  })
})

describe('patch body', () => {
  it('sends nothing for an untouched form', () => {
    const built = buildSharePatch(seedOf(DOWNLOADER))
    assert.deepEqual(built.body, {})
    assert.equal(built.changed, false)
  })

  it('sends only the cap when only the cap changed, keeping the absolute expiry', () => {
    const withExpiry = { ...DOWNLOADER, expiresAt: '2099-01-01T00:00:00.000Z' }
    const built = buildSharePatch(seedOf(withExpiry, { capText: '9' }))
    assert.deepEqual(built.body, { maxDownloads: 9 })
    assert.equal(built.changed, true)
  })

  it('never re-bases an expiry that was not deliberately replaced', () => {
    const withExpiry = { ...DOWNLOADER, expiresAt: '2099-01-01T00:00:00.000Z' }
    assert.ok(!('expiresInDays' in buildSharePatch(seedOf(withExpiry)).body))
    assert.ok(!('expiresAt' in buildSharePatch(seedOf(withExpiry)).body))
  })

  it('turns a chosen preset into expiresInDays and "never" into an explicit null', () => {
    const withExpiry = { ...DOWNLOADER, expiresAt: '2099-01-01T00:00:00.000Z' }
    assert.deepEqual(buildSharePatch(seedOf(withExpiry, { expiryChoice: '7' })).body, { expiresInDays: 7 })
    assert.deepEqual(buildSharePatch(seedOf(withExpiry, { expiryChoice: '30' })).body, { expiresInDays: 30 })
    assert.deepEqual(buildSharePatch(seedOf(withExpiry, { expiryChoice: 'never' })).body, { expiresInDays: null })
  })

  it('renews an expired link only when a new expiry is chosen', () => {
    const expired = { ...DOWNLOADER, expiresAt: '2020-01-01T00:00:00.000Z' }
    assert.deepEqual(buildSharePatch(seedOf(expired)).body, {}, 'opening and saving must not renew it')
    assert.deepEqual(buildSharePatch(seedOf(expired, { expiryChoice: '30' })).body, { expiresInDays: 30 })
  })

  it('does not send "never" when the link already never expires', () => {
    assert.deepEqual(buildSharePatch(seedOf(DOWNLOADER, { expiryChoice: 'never' })).body, {})
  })

  it('keeps, replaces or removes the password — and never echoes the old one', () => {
    const locked = { ...DOWNLOADER, hasPassword: true }
    assert.deepEqual(buildSharePatch(seedOf(locked)).body, {}, 'keep is the default')
    assert.deepEqual(buildSharePatch(seedOf(locked, { passwordChoice: 'remove' })).body, { password: null })
    assert.deepEqual(buildSharePatch(seedOf(locked, { passwordChoice: 'replace', newPassword: 'new' })).body, { password: 'new' })
    // Clearing the input after choosing "replace" is a validation error, not a
    // silent "keep" and certainly not an accidental unlock.
    const empty = buildSharePatch(seedOf(locked, { passwordChoice: 'replace', newPassword: '' }))
    assert.ok(empty.error)
    assert.equal(empty.field, 'newPassword')
  })

  it('cannot send a removal for a link that has no password', () => {
    assert.deepEqual(buildSharePatch(seedOf(DOWNLOADER, { passwordChoice: 'remove' })).body, {})
  })

  it('clears a cap with an empty field, sets one with an integer, rejects anything else', () => {
    assert.deepEqual(buildSharePatch(seedOf(DOWNLOADER, { capText: '' })).body, { maxDownloads: null })
    assert.deepEqual(buildSharePatch(seedOf(DOWNLOADER, { capText: '12' })).body, { maxDownloads: 12 })
    for (const bad of ['0', '-1', '2.5', 'many']) {
      const built = buildSharePatch(seedOf(DOWNLOADER, { capText: bad }))
      assert.ok(built.error, bad + ' must be rejected')
      assert.equal(built.field, 'capText')
    }
  })

  it('switching to viewer clears an existing cap instead of leaving one unreachable', () => {
    const built = buildSharePatch(seedOf(DOWNLOADER, { nextPermission: 'viewer' }))
    assert.deepEqual(built.body, { permission: 'viewer', maxDownloads: null })
  })

  it('does not send a cap at all for a viewer link, even if one is typed', () => {
    const viewer = { ...DOWNLOADER, permission: 'viewer', maxDownloads: null, downloads: 0 }
    const built = buildSharePatch(seedOf(viewer, { capText: '4', expiryChoice: '7' }))
    assert.deepEqual(built.body, { expiresInDays: 7 })
  })

  it('switching to downloader leaves the stored cap alone unless it is edited', () => {
    const viewer = { ...DOWNLOADER, permission: 'viewer', downloads: 0 }
    assert.deepEqual(buildSharePatch(seedOf(viewer, { nextPermission: 'downloader' })).body, { permission: 'downloader' })
  })
})

describe('dialog wiring', () => {
  it('reads the typed values from the inputs, not from the seed', () => {
    // The bug this pins: the dialog seeded `capText`/`newPassword` once and never
    // bound the inputs, so a typed cap or password was ignored and the PATCH was
    // built from the values the dialog opened with.
    assert.match(source, /capInput\.addEventListener\('input'/, 'the cap field must feed the model')
    assert.match(source, /seed\.capText = capInput\.value/, 'the cap input must write the seeded value')
    assert.match(source, /newPassword\.addEventListener\('input'/, 'the password field must feed the model')
    assert.match(source, /seed\.newPassword = newPassword\.value/, 'the password input must write the seeded value')
  })

  it('uses the shared dialog module and never renders or stores a password', () => {
    assert.match(source, /from '\.\/ui\.js'/, 'the overlay primitives are shared, not re-implemented')
    assert.ok(!/type:\s*'text'[\s\S]{0,40}password/i.test(source), 'no password is ever shown as text')
    assert.ok(!/passwordHash/.test(source), 'the client never handles a hash')
    // The plaintext only ever travels inside a PATCH body.
    const assignments = [...source.matchAll(/password:\s*([^\n]+)/g)].map((match) => match[1].trim())
    for (const value of assignments) {
      assert.ok(/null|\bvalue\b|'new'/.test(value) || value.startsWith('value'), value)
    }
  })

  it('is single-flight and cancels without a request', () => {
    assert.match(source, /if \(submitting \|\| settled\) return/)
    assert.match(source, /if \(!built\.changed\)/, 'an untouched form sends nothing')
    // Cancel is a plain close; no fetch, no PATCH.
    assert.ok(!/cancel[\s\S]{0,200}api\.patch/.test(source))
  })

  it('reports the updated row to the caller instead of re-fetching by id', () => {
    assert.match(source, /opts\.onSaved\(updated\)/)
  })

  it('scopes its element ids per instance instead of colliding while one closes', () => {
    // A closing overlay stays in the document for its exit, so two editors can
    // be alive at once; static ids made every label point at the dying dialog.
    assert.match(source, /const uid = 'se-'/, source.match(/const uid = '[^']*'/) ? '' : 'no per-instance id')
    assert.ok(!/id: 'share-edit-/.test(source), 'ids must be built from the instance suffix')
  })
})
