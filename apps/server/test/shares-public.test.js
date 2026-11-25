import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import { startServer, uniqueEmail } from './helpers.js'
import { readZip } from '../src/text/zip-read.js'

/**
 * The public side of a share link: what a recipient can actually do.
 *
 * A default ("viewer") link used to be a dead end — every byte route answered
 * 403 — and a folder link had no way to list anything below it. These tests pin
 * the split the page relies on:
 *
 *   viewer      inline preview only, no download, no budget spent
 *   downloader  attachments and the folder ZIP, counted
 */

let app
let api
let token

before(async () => {
  app = await startServer()
  api = app.client
  const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'share password' } })
  token = registered.json.token
})

after(async () => {
  await app.close()
  app.cleanup()
})

const auth = (extra = {}) => ({ token, ...extra })

async function folder(name, parentId) {
  const response = await api('POST', '/api/v1/nodes', auth({ body: { name, kind: 'folder', parentId } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function upload(name, body, mime, parentId) {
  const query = '/api/v1/uploads?name=' + encodeURIComponent(name) + (parentId ? '&parentId=' + parentId : '')
  const response = await api('PUT', query, auth({ raw: true, body, headers: { 'content-type': mime } }))
  assert.equal(response.status, 201, response.text)
  return response.json.node
}

async function share(nodeId, body = {}) {
  const response = await api('POST', '/api/v1/nodes/' + nodeId + '/share', auth({ body }))
  assert.equal(response.status, 201, response.text)
  return response.json.share
}

/**
 * Bytes, not text.
 *
 * helpers.js decodes every response as UTF-8, which is right for the JSON API
 * and lossy for a ZIP; an archive test has to read the raw body.
 */
async function fetchBytes(path) {
  const response = await fetch('http://127.0.0.1:' + app.port + path)
  const array = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, body: array }
}

describe('viewer link preview', () => {
  it('downloads Unicode filenames without putting non-ASCII characters in HTTP headers', async () => {
    for (const name of ['说明 📄.txt', 'café.txt', 'quote" test.txt', "a'b(1)!.txt"]) {
      const file = await upload(name, 'Unicode filename bytes', 'text/plain')
      const link = await share(file.id, { permission: 'downloader', maxDownloads: 1 })
      const content = await api('GET', '/api/v1/shared/' + link.token + '/content')
      assert.equal(content.status, 200, content.text)
      assert.equal(content.text, 'Unicode filename bytes')
      const disposition = content.headers.get('content-disposition') || ''
      const match = /^attachment; filename="([^"\r\n]+)"; filename\*=UTF-8''(.+)$/.exec(disposition)
      assert.ok(match, disposition)
      assert.match(match[1], /^[\x20-\x7e]+$/)
      assert.equal(decodeURIComponent(match[2]), file.name)
      assert.ok(!/[!'()*]/.test(match[2]), 'RFC 5987 reserved characters must be escaped')
    }
  })

  it('streams the file inline without spending the download budget', async () => {
    const image = await upload('shot.png', Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png')
    const link = await share(image.id)

    const preview = await api('GET', '/api/v1/shared/' + link.token + '/preview')
    assert.equal(preview.status, 200, preview.text)
    assert.equal(preview.headers.get('content-type'), 'image/png')
    assert.equal(preview.headers.get('content-disposition'), null, 'a preview is not an attachment')
    // Uploaded HTML/SVG must not execute against this origin when opened directly.
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(preview.headers.get('content-security-policy'), 'sandbox')

    const meta = await api('GET', '/api/v1/shared/' + link.token)
    assert.equal(meta.json.share.downloads, 0, 'opening a link is not a download')

    // /content keeps its old contract: downloader only, so a viewer link still 403s.
    const content = await api('GET', '/api/v1/shared/' + link.token + '/content')
    assert.equal(content.status, 403)
    assert.equal(content.json.error.code, 'FORBIDDEN')
  })

  it('lets a downloader preview too, and keeps /content counted and attached', async () => {
    const file = await upload('notes.txt', 'downloadable bytes', 'text/plain')
    const link = await share(file.id, { permission: 'downloader' })

    const preview = await api('GET', '/api/v1/shared/' + link.token + '/preview')
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-disposition'), null)
    assert.equal(preview.text, 'downloadable bytes')

    const content = await api('GET', '/api/v1/shared/' + link.token + '/content')
    assert.equal(content.status, 200)
    assert.match(content.headers.get('content-disposition') || '', /attachment; filename="notes\.txt"/)
    const meta = await api('GET', '/api/v1/shared/' + link.token)
    assert.equal(meta.json.share.downloads, 1, 'the download counter still moves on /content')
  })
})

describe('download budget', () => {
  it('does not spend the file, child or archive budget on HEAD', async () => {
    const root = await folder('HEAD folder')
    const file = await upload('head.txt', 'head bytes', 'text/plain', root.id)
    const fileLink = await share(file.id, { permission: 'downloader', maxDownloads: 1 })
    const folderLink = await share(root.id, { permission: 'downloader', maxDownloads: 1 })
    for (const path of ['/api/v1/shared/' + fileLink.token + '/content',
      '/api/v1/shared/' + folderLink.token + '/file/' + file.id,
      '/api/v1/shared/' + folderLink.token + '/archive']) {
      assert.equal((await api('HEAD', path)).status, 200)
    }
    assert.equal((await api('GET', '/api/v1/shared/' + fileLink.token)).json.share.downloads, 0)
    assert.equal((await api('GET', '/api/v1/shared/' + folderLink.token)).json.share.downloads, 0)
    assert.equal((await api('GET', '/api/v1/shared/' + fileLink.token + '/content')).status, 200)
    assert.equal((await fetchBytes('/api/v1/shared/' + folderLink.token + '/archive')).status, 200)
  })

  it('allows only one concurrent password-protected download with a budget of one', async () => {
    const file = await upload('budget.txt', 'once only', 'text/plain')
    const link = await share(file.id, { permission: 'downloader', password: 'budget secret', maxDownloads: 1 })
    const downloads = await Promise.all(Array.from({ length: 5 }, () => api('GET',
      '/api/v1/shared/' + link.token + '/content?password=budget+secret')))
    assert.equal(downloads.filter((response) => response.status === 200).length, 1)
    assert.equal(downloads.filter((response) => response.status === 404).length, 4)
    const listed = await api('GET', '/api/v1/nodes/' + file.id + '/shares', auth())
    assert.equal(listed.json.shares[0].downloads, 1)
  })
})

describe('workspace folder shares', () => {
  it('shares the same mixed-owner subtree in browsing, previews and ZIPs', async () => {
    const member = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: 'member password' } })
    const owner = await api('GET', '/api/v1/me', auth())
    const { addMember } = await import('../src/workspaces.js')
    addMember(owner.json.user.workspace.id, member.json.user.id, 'member')
    const root = await folder('Team share')
    const owned = await upload('owner.txt', 'owner bytes', 'text/plain', root.id)
    const nested = await api('POST', '/api/v1/nodes', { token: member.json.token, body: { name: 'Member folder', kind: 'folder', parentId: root.id } })
    const added = await api('PUT', '/api/v1/uploads?name=member.txt&parentId=' + nested.json.node.id,
      { token: member.json.token, raw: true, body: 'member bytes', headers: { 'content-type': 'text/plain' } })
    const outside = await upload('outside.txt', 'private sibling', 'text/plain')
    const created = await api('POST', '/api/v1/nodes/' + root.id + '/share',
      { token: member.json.token, body: { permission: 'downloader' } })
    assert.equal(created.status, 201, created.text)
    const publicRoot = '/api/v1/shared/' + created.json.share.token
    const children = await api('GET', publicRoot + '/children')
    assert.equal(children.status, 200, children.text)
    assert.deepEqual(children.json.entries.map((entry) => entry.name).sort(), ['Member folder', 'owner.txt'])
    const deep = await api('GET', publicRoot + '/children?parentId=' + nested.json.node.id)
    assert.deepEqual(deep.json.entries.map((entry) => entry.name), ['member.txt'])
    assert.equal((await api('GET', publicRoot + '/file/' + owned.id + '?inline=1')).text, 'owner bytes')
    assert.equal((await api('GET', publicRoot + '/file/' + added.json.node.id + '?inline=1')).text, 'member bytes')
    assert.equal((await api('GET', publicRoot + '/file/' + outside.id + '?inline=1')).status, 404)
    const archive = await fetchBytes(publicRoot + '/archive')
    assert.equal(archive.status, 200, archive.body.toString())
    const zip = readZip(archive.body)
    assert.deepEqual(zip.names().sort(), ['Team share/', 'Team share/Member folder/', 'Team share/Member folder/member.txt', 'Team share/owner.txt'])
    assert.equal(zip.get('Team share/Member folder/member.txt').toString(), 'member bytes')
  })
})

describe('folder share browsing', () => {
  it('downloads a Chinese-named folder as a valid ZIP', async () => {
    const root = await folder('项目资料')
    await upload('说明.txt', 'shared folder bytes', 'text/plain', root.id)
    const link = await share(root.id, { permission: 'downloader' })
    const archive = await fetchBytes('/api/v1/shared/' + link.token + '/archive')
    assert.equal(archive.status, 200, archive.body.toString())
    assert.ok((archive.headers.get('content-disposition') || '').includes("filename*=UTF-8''" + encodeURIComponent(root.name + '.zip')))
    assert.equal(readZip(archive.body).get('项目资料/说明.txt').toString(), 'shared folder bytes')
  })

  let root
  let nested
  let link
  let downloadLink

  before(async () => {
    root = await folder('album')
    nested = await folder('inner', root.id)
    await upload('cover.png', Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png', root.id)
    await upload('deep.txt', 'deep bytes', 'text/plain', nested.id)
    link = await share(root.id)
    downloadLink = await share(root.id, { permission: 'downloader' })
  })

  it('lists the direct children of the shared folder, and of a subfolder', async () => {
    const top = await api('GET', '/api/v1/shared/' + link.token + '/children')
    assert.equal(top.status, 200, top.text)
    assert.equal(top.json.parentId, root.id)
    assert.deepEqual(top.json.entries.map((entry) => entry.name).sort(), ['cover.png', 'inner'])
    // The recipient learns what a row needs, nothing about the store behind it.
    const entry = top.json.entries.find((item) => item.name === 'cover.png')
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'kind', 'mime', 'name', 'size', 'updatedAt'])
    assert.equal(entry.mime, 'image/png')

    const inner = await api('GET', '/api/v1/shared/' + link.token + '/children?parentId=' + nested.id)
    assert.equal(inner.status, 200)
    assert.deepEqual(inner.json.entries.map((entry) => entry.name), ['deep.txt'])
  })

  it('refuses a parent outside the shared subtree', async () => {
    const outside = await folder('private')
    const response = await api('GET', '/api/v1/shared/' + link.token + '/children?parentId=' + outside.id)
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'NOT_FOUND')
    const missing = await api('GET', '/api/v1/shared/' + link.token + '/children?parentId=00000000-0000-0000-0000-000000000000')
    assert.equal(missing.status, 404)
  })

  it('previews a child file inline for a viewer and counts nothing', async () => {
    const top = await api('GET', '/api/v1/shared/' + link.token + '/children')
    const cover = top.json.entries.find((entry) => entry.name === 'cover.png')
    const preview = await api('GET', '/api/v1/shared/' + link.token + '/file/' + cover.id)
    assert.equal(preview.status, 200, preview.text)
    assert.equal(preview.headers.get('content-disposition'), null)
    assert.equal(preview.headers.get('content-security-policy'), 'sandbox')
    const meta = await api('GET', '/api/v1/shared/' + link.token)
    assert.equal(meta.json.share.downloads, 0)
  })

  it('downloads a child as an attachment for a downloader, and counts it once', async () => {
    const top = await api('GET', '/api/v1/shared/' + downloadLink.token + '/children')
    const cover = top.json.entries.find((entry) => entry.name === 'cover.png')
    const download = await api('GET', '/api/v1/shared/' + downloadLink.token + '/file/' + cover.id)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition') || '', /attachment; filename="cover\.png"/)
    // inline=1 is how the page previews a row without paying for it.
    const inline = await api('GET', '/api/v1/shared/' + downloadLink.token + '/file/' + cover.id + '?inline=1')
    assert.equal(inline.status, 200)
    assert.equal(inline.headers.get('content-disposition'), null)
    const meta = await api('GET', '/api/v1/shared/' + downloadLink.token)
    assert.equal(meta.json.share.downloads, 1)
  })

  it('zips the whole folder for a downloader without creating a node', async () => {
    const before = await api('GET', '/api/v1/nodes?parentId=' + root.id, auth())
    const archive = await fetchBytes('/api/v1/shared/' + downloadLink.token + '/archive')
    assert.equal(archive.status, 200)
    assert.equal(archive.body.subarray(0, 2).toString(), 'PK')
    assert.match(archive.headers.get('content-disposition') || '', /attachment; filename="album\.zip"/)

    const zip = readZip(archive.body)
    assert.deepEqual(zip.names().sort(), ['album/', 'album/cover.png', 'album/inner/', 'album/inner/deep.txt'])
    assert.equal(zip.get('album/inner/deep.txt').toString(), 'deep bytes')

    // Nothing appears in the tree: the archive is a response body, not a node.
    const listed = await api('GET', '/api/v1/nodes?parentId=' + root.id, auth())
    assert.deepEqual(listed.json.nodes.map((node) => node.id), before.json.nodes.map((node) => node.id))
    const meta = await api('GET', '/api/v1/shared/' + downloadLink.token)
    assert.equal(meta.json.share.downloads, 2, 'the ZIP is one more download')
  })

  it('keeps the archive and the child list away from a viewer link', async () => {
    const archive = await fetchBytes('/api/v1/shared/' + link.token + '/archive')
    assert.equal(archive.status, 403)
  })

  it('refuses to archive a file share, and to list a file share as a folder', async () => {
    const file = await upload('single.txt', 'single', 'text/plain', root.id)
    const link = await share(file.id, { permission: 'downloader' })
    const archive = await fetchBytes('/api/v1/shared/' + link.token + '/archive')
    assert.equal(archive.status, 400)
    const children = await api('GET', '/api/v1/shared/' + link.token + '/children')
    assert.equal(children.status, 400)
    assert.equal(children.json.error.code, 'NOT_FOLDER')
  })
})

describe('password gate on every public route', () => {
  it('answers 401 SHARE_LOCKED for a wrong password', async () => {
    const root = await folder('locked')
    await upload('secret.png', Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png', root.id)
    const viewerLink = await share(root.id, { password: 'open sesame' })
    const downloadLink = await share(root.id, { permission: 'downloader', password: 'open sesame' })
    const wrong = '?password=nope'

    const preview = await api('GET', '/api/v1/shared/' + viewerLink.token + '/preview' + wrong)
    assert.equal(preview.status, 401)
    assert.equal(preview.json.error.code, 'SHARE_LOCKED')
    const locked = await api('GET', '/api/v1/shared/' + viewerLink.token + '/preview')
    assert.equal(locked.status, 401, 'no password at all is the same answer')

    const children = await api('GET', '/api/v1/shared/' + viewerLink.token + '/children' + wrong)
    assert.equal(children.status, 401)
    assert.equal(children.json.error.code, 'SHARE_LOCKED')

    const archive = await fetchBytes('/api/v1/shared/' + downloadLink.token + '/archive' + wrong)
    assert.equal(archive.status, 401)

    const file = await fetchBytes('/api/v1/shared/' + viewerLink.token + '/file/' + root.id + wrong)
    assert.equal(file.status, 401)

    // The right password opens all of them.
    const right = '?password=' + encodeURIComponent('open sesame')
    const opened = await api('GET', '/api/v1/shared/' + viewerLink.token + '/children' + right)
    assert.equal(opened.status, 200, opened.text)
    const good = await fetchBytes('/api/v1/shared/' + downloadLink.token + '/archive' + right)
    assert.equal(good.status, 200)
    assert.equal(good.body.subarray(0, 2).toString(), 'PK')
  })
})

describe('owner link management (GET /api/v1/shares)', () => {
  /**
   * A second account with its own drive, so cross-account isolation is asserted
   * against a real owner rather than against "the list happens to be empty".
   */
  async function newAccount(label) {
    const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: label + ' password' } })
    assert.equal(registered.status, 201, registered.text)
    return registered.json.token
  }

  async function createShareFor(as, nodeId, body = {}) {
    const response = await api('POST', '/api/v1/nodes/' + nodeId + '/share', { token: as, body })
    assert.equal(response.status, 201, response.text)
    return response.json.share
  }

  /** The module-level upload() uses the first account; this one takes a token. */
  async function uploadAs(as, name, text) {
    const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name),
      { token: as, raw: true, body: text, headers: { 'content-type': 'text/plain' } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }

  async function folderAs(as, name) {
    const response = await api('POST', '/api/v1/nodes', { token: as, body: { name, kind: 'folder' } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }

  it('requires authentication', async () => {
    const anonymous = await api('GET', '/api/v1/shares')
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'UNAUTHENTICATED')
  })

  it('lists only the caller\'s own links, newest first, across files and folders', async () => {
    const mine = await newAccount('owner')
    const theirs = await newAccount('other')
    const folder = await folderAs(mine, '定价资料')
    const file = await uploadAs(mine, '报价.txt', 'quoted bytes')
    const otherFile = await uploadAs(theirs, 'theirs.txt', 'other bytes')

    // Older link to a folder, newer link to a file: the list must order by
    // time, not by kind or by node.
    const folderLink = await createShareFor(mine, folder.id, { permission: 'downloader', maxDownloads: 3 })
    const fileLink = await createShareFor(mine, file.id, { permission: 'downloader', password: 'hunter2' })
    const foreign = await createShareFor(theirs, otherFile.id, { permission: 'downloader' })

    const listed = await api('GET', '/api/v1/shares', { token: mine })
    assert.equal(listed.status, 200, listed.text)
    const ids = listed.json.shares.map((share) => share.id)
    assert.deepEqual(ids, [fileLink.id, folderLink.id], 'newest first, own links only')
    assert.equal(listed.json.hasMore, false)
    assert.equal(listed.json.limit, 50)

    const first = listed.json.shares[0]
    assert.equal(first.permission, 'downloader')
    assert.equal(first.hasPassword, true)
    assert.equal(first.maxDownloads, null)
    assert.equal(first.downloads, 0)
    assert.equal(first.state, 'active')
    assert.equal(first.usable, true)
    assert.equal(first.canDownload, true)
    // The node payload is deliberately minimal: identity, kind and trash state.
    assert.deepEqual(Object.keys(first.node).sort(), ['deletedAt', 'id', 'kind', 'name'])
    assert.equal(first.node.name, file.name)
    assert.equal(first.node.deletedAt, null)
    // The absolute URL is the same shape the per-node API returns, so the page
    // can copy it without knowing the origin.
    assert.equal(first.url, 'http://127.0.0.1:' + app.port + '/s/' + first.token)
    // The other account's token must never appear, under any key.
    const serialised = listed.text
    assert.ok(!serialised.includes(foreign.token), 'another account\'s token leaked')
    assert.ok(!serialised.includes(foreign.id), 'another account\'s share id leaked')

    // And their list is their own two-item view of the world.
    const otherListed = await api('GET', '/api/v1/shares', { token: theirs })
    assert.deepEqual(otherListed.json.shares.map((share) => share.id), [foreign.id])
  })

  it('pages with a stable created_at DESC, id DESC order and validates its bounds', async () => {
    const as = await newAccount('pager')
    const file = await uploadAs(as, 'paged.txt', 'paged bytes')
    const created = []
    for (let index = 0; index < 7; index += 1) {
      created.push(await createShareFor(as, file.id))
    }

    // The unpaginated list is the reference order. Seven links can share one
    // millisecond, so `created_at` ties are broken by `id DESC` — asserting
    // against creation order instead would be asserting on clock resolution,
    // not on the contract.
    const whole = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(whole.status, 200, whole.text)
    const expected = whole.json.shares.map((share) => share.id)
    assert.equal(expected.length, 7)
    assert.deepEqual([...expected].sort(), created.map((share) => share.id).sort(), 'every link is listed once')

    const first = await api('GET', '/api/v1/shares?limit=3&offset=0', { token: as })
    assert.equal(first.status, 200, first.text)
    assert.equal(first.json.shares.length, 3)
    assert.equal(first.json.limit, 3)
    assert.equal(first.json.offset, 0)
    assert.equal(first.json.hasMore, true)

    const second = await api('GET', '/api/v1/shares?limit=3&offset=3', { token: as })
    assert.equal(second.json.shares.length, 3)
    assert.equal(second.json.hasMore, true, 'a seventh row still exists past this page')

    const third = await api('GET', '/api/v1/shares?limit=3&offset=6', { token: as })
    assert.equal(third.json.shares.length, 1)
    assert.equal(third.json.hasMore, false)

    // No row is repeated and none is skipped, and the three pages concatenate
    // to exactly the unpaginated order — the property offset paging needs.
    const walked = [...first.json.shares, ...second.json.shares, ...third.json.shares].map((share) => share.id)
    assert.equal(new Set(walked).size, 7)
    assert.deepEqual(walked, expected)

    // Two identical requests agree: the tiebreak is deterministic, not the
    // physical row order SQLite happened to return.
    const repeat = await api('GET', '/api/v1/shares?limit=3&offset=0', { token: as })
    assert.deepEqual(repeat.json.shares.map((share) => share.id), first.json.shares.map((share) => share.id))

    // A real time gap still wins: a link created now sorts before all seven.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newest = await createShareFor(as, file.id)
    const after = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(after.json.shares[0].id, newest.id)

    // Past the end is an empty page, not an error.
    const past = await api('GET', '/api/v1/shares?limit=3&offset=99', { token: as })
    assert.equal(past.status, 200)
    assert.deepEqual(past.json.shares, [])
    assert.equal(past.json.hasMore, false)

    // Bounds are validated the same way /nodes validates its own.
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=abc']) {
      const bad = await api('GET', '/api/v1/shares?' + query, { token: as })
      assert.equal(bad.status, 400, query + ' must be rejected')
      assert.equal(bad.json.error.code, 'INVALID_INPUT')
    }
    const capped = await api('GET', '/api/v1/shares?limit=100', { token: as })
    assert.equal(capped.status, 200, 'the ceiling itself is allowed')
  })

  it('reports expired, exhausted and trashed links without hiding them', async () => {
    const as = await newAccount('states')
    const file = await uploadAs(as, 'state.txt', 'state bytes')

    const live = await createShareFor(as, file.id, { permission: 'downloader' })
    const expired = await createShareFor(as, file.id, { expiresInDays: 1 })
    const budgeted = await createShareFor(as, file.id, { permission: 'downloader', maxDownloads: 1 })
    const trashed = await createShareFor(as, file.id)

    // Spend the budget through the public link, which is the only thing that
    // may move the counter.
    const download = await api('GET', '/api/v1/shared/' + budgeted.token + '/content')
    assert.equal(download.status, 200, download.text)

    // Age the expiry directly: the public gate compares against nowIso(), so
    // this is the same clock the state word is derived from.
    const { db, nowIso } = await import('../src/db.js')
    db.prepare('UPDATE shares SET expires_at=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), expired.id)
    // Trash the source node: the link row must survive it (the owner still has
    // to see and revoke it) but must not claim to work.
    const removed = await api('DELETE', '/api/v1/nodes/' + file.id, { token: as })
    assert.equal(removed.status, 200, removed.text)

    const listed = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(listed.status, 200, listed.text)
    const byId = new Map(listed.json.shares.map((share) => [share.id, share]))

    // The source file is shared four times, so all four rows survive the delete
    // and all four now report the trash.
    for (const link of [live, expired, budgeted, trashed]) {
      const row = byId.get(link.id)
      assert.ok(row, 'a link whose file is in the trash must still be listed')
      assert.equal(row.state, 'trashed', 'trash outranks the link\'s own expiry')
      assert.equal(row.usable, false)
      assert.ok(row.node.deletedAt, 'the row says the source is deleted')
    }

    // Revoking still works, and the source being in the trash does not block it.
    const revoked = await api('DELETE', '/api/v1/shares/' + trashed.id, { token: as })
    assert.equal(revoked.status, 200, revoked.text)
    const afterRevoke = await api('GET', '/api/v1/shares', { token: as })
    assert.ok(!afterRevoke.json.shares.some((share) => share.id === trashed.id))
    // The node itself is untouched by the revoke: it is still in the trash.
    const trashList = await api('GET', '/api/v1/nodes?trash=1', { token: as })
    assert.ok(trashList.json.nodes.some((node) => node.id === file.id), 'revoking a link must not purge the file')

    // Restore the file and the two links that never expired or ran out work again.
    const restored = await api('POST', '/api/v1/nodes/' + file.id + '/restore', { token: as })
    assert.equal(restored.status, 200, restored.text)
    const liveAgain = await api('GET', '/api/v1/shares', { token: as })
    const liveRow = liveAgain.json.shares.find((share) => share.id === live.id)
    assert.equal(liveRow.state, 'active')
    assert.equal(liveRow.usable, true)
  })

  it('distinguishes expired from exhausted on separate links', async () => {
    const as = await newAccount('distinct')
    const file = await uploadAs(as, 'distinct.txt', 'distinct bytes')
    const expired = await createShareFor(as, file.id, { expiresInDays: 1 })
    const exhausted = await createShareFor(as, file.id, { permission: 'downloader', maxDownloads: 1 })
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE shares SET expires_at=? WHERE id=?').run(new Date(Date.now() - 60_000).toISOString(), expired.id)
    assert.equal((await api('GET', '/api/v1/shared/' + exhausted.token + '/content')).status, 200)

    const listed = await api('GET', '/api/v1/shares', { token: as })
    const byId = new Map(listed.json.shares.map((share) => [share.id, share]))
    assert.equal(byId.get(expired.id).state, 'expired')
    assert.equal(byId.get(expired.id).usable, false)
    assert.equal(byId.get(exhausted.id).state, 'exhausted')
    assert.equal(byId.get(exhausted.id).usable, false)
    assert.equal(byId.get(exhausted.id).downloads, 1)
    assert.equal(byId.get(exhausted.id).maxDownloads, 1)
  })

  it('revokes only the caller\'s own link and ends public access', async () => {
    const owner = await newAccount('revoker')
    const stranger = await newAccount('stranger')
    const file = await uploadAs(owner, 'revoke.txt', 'revocable bytes')
    const link = await createShareFor(owner, file.id, { permission: 'downloader' })

    // The public link works before the revoke…
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 200)

    // …and a stranger cannot revoke it, nor learn that it exists.
    const denied = await api('DELETE', '/api/v1/shares/' + link.id, { token: stranger })
    assert.equal(denied.status, 404)
    assert.ok(!denied.text.includes(link.token))
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 200, 'a refused revoke changes nothing')

    const revoked = await api('DELETE', '/api/v1/shares/' + link.id, { token: owner })
    assert.equal(revoked.status, 200, revoked.text)
    assert.deepEqual(revoked.json, { ok: true })

    // Recipient access really ends, and the file survives.
    const gone = await api('GET', '/api/v1/shared/' + link.token)
    assert.equal(gone.status, 404)
    assert.equal(gone.json.error.code, 'SHARE_NOT_FOUND')
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 404)
    const stillThere = await api('GET', '/api/v1/nodes/' + file.id, { token: owner })
    assert.equal(stillThere.status, 200)
    assert.equal(stillThere.json.node.name, file.name)

    const listed = await api('GET', '/api/v1/shares', { token: owner })
    assert.ok(!listed.json.shares.some((share) => share.id === link.id))
  })

  it('keeps the per-node listing unchanged and consistent with the owner list', async () => {
    // The existing API is a per-node view of the same rows: it must keep its
    // shape ({ shares }) and its newest-first order, and agree with /shares.
    const as = await newAccount('per-node')
    const file = await uploadAs(as, 'both.txt', 'both bytes')
    const older = await createShareFor(as, file.id)
    // Two rows created in the same millisecond tie on created_at and fall back
    // to id DESC, which is random: a real gap is what makes "newest first" a
    // claim about time rather than about the tiebreak.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await createShareFor(as, file.id, { permission: 'downloader' })

    const perNode = await api('GET', '/api/v1/nodes/' + file.id + '/shares', { token: as })
    assert.equal(perNode.status, 200, perNode.text)
    assert.deepEqual(perNode.json.shares.map((share) => share.id), [newer.id, older.id])
    // The per-node shape is untouched: no state/usable/node fields were added.
    assert.equal(perNode.json.shares[0].state, undefined)
    assert.equal(perNode.json.shares[0].node, undefined)
    assert.equal(perNode.json.shares[0].token, newer.token)

    const ownerList = await api('GET', '/api/v1/shares', { token: as })
    assert.deepEqual(ownerList.json.shares.map((share) => share.id), [newer.id, older.id])
  })
})

/**
 * In-place editing of an existing link: PATCH /api/v1/shares/:id.
 *
 * The product rule behind every test here is that an edit is not a re-create.
 * The URL the owner already sent must keep resolving, the creation date stays
 * the creation date, and the download counter is a fact about what recipients
 * already took — none of the three may move because the owner changed a setting.
 */
describe('editing an existing link (PATCH /api/v1/shares/:id)', () => {
  async function newAccount(label) {
    const registered = await api('POST', '/api/v1/auth/register', { body: { email: uniqueEmail(), password: label + ' password' } })
    assert.equal(registered.status, 201, registered.text)
    return registered.json.token
  }

  async function uploadAs(as, name, text) {
    const response = await api('PUT', '/api/v1/uploads?name=' + encodeURIComponent(name),
      { token: as, raw: true, body: text, headers: { 'content-type': 'text/plain' } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }

  async function folderAs(as, name) {
    const response = await api('POST', '/api/v1/nodes', { token: as, body: { name, kind: 'folder' } })
    assert.equal(response.status, 201, response.text)
    return response.json.node
  }

  async function createShareFor(as, nodeId, body = {}) {
    const response = await api('POST', '/api/v1/nodes/' + nodeId + '/share', { token: as, body })
    assert.equal(response.status, 201, response.text)
    return response.json.share
  }

  const patch = (as, id, body) => api('PATCH', '/api/v1/shares/' + id, { token: as, body })

  it('changes settings in place: same id, token, url, createdAt and counter', async () => {
    const as = await newAccount('editor')
    const file = await uploadAs(as, 'plan.txt', 'editable bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader' })

    // Spend one download so the counter is a value the edit could plausibly lose.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 200)

    const edited = await patch(as, link.id, { permission: 'viewer', maxDownloads: null, expiresInDays: 30 })
    assert.equal(edited.status, 200, edited.text)
    const share = edited.json.share
    assert.equal(share.id, link.id)
    assert.equal(share.token, link.token, 'the capability must survive an edit')
    assert.equal(share.url, link.url, 'the copied URL must keep working')
    assert.equal(share.createdAt, link.createdAt)
    assert.equal(share.permission, 'viewer')
    assert.equal(share.maxDownloads, null)
    assert.equal(share.hasPassword, false)
    assert.equal(share.downloads, 1, 'an edit does not reset what was already downloaded')
    assert.ok(new Date(share.expiresAt).getTime() > Date.now())

    // No replacement row appeared: the list still has exactly one link, and the
    // per-node listing agrees.
    const listed = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(listed.json.shares.length, 1)
    assert.equal(listed.json.shares[0].id, link.id)
    assert.equal(listed.json.shares[0].downloads, 1)
    assert.equal(listed.json.shares[0].state, 'active')
    assert.equal(listed.json.shares[0].usable, true)
    const perNode = await api('GET', '/api/v1/nodes/' + file.id + '/shares', { token: as })
    assert.deepEqual(perNode.json.shares.map((row) => row.id), [link.id])
    assert.equal(perNode.json.shares[0].permission, 'viewer')

    // The public gate agrees: a viewer preview still works, the attachment does not.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/preview')).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 403)
  })

  it('keeps every setting the patch did not name, including an absolute expiry', async () => {
    const as = await newAccount('sparse')
    const file = await uploadAs(as, 'sparse.txt', 'sparse bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader', expiresInDays: 7, password: 'old secret', maxDownloads: 5 })
    const expiryBefore = (await api('GET', '/api/v1/shares', { token: as })).json.shares[0].expiresAt
    assert.ok(expiryBefore)

    // Only the cap is patched: expiry, password and permission must not move,
    // and in particular the absolute expiry must not be re-based on "now".
    const edited = await patch(as, link.id, { maxDownloads: 12 })
    assert.equal(edited.status, 200, edited.text)
    assert.equal(edited.json.share.expiresAt, expiryBefore, 'an omitted expiry keeps its original absolute moment')
    assert.equal(edited.json.share.permission, 'downloader')
    assert.equal(edited.json.share.hasPassword, true)
    assert.equal(edited.json.share.maxDownloads, 12)
    // The old password still opens the link: an omitted password is "keep".
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '?password=' + encodeURIComponent('old secret'))).status, 200)

    // An empty patch is a no-op that answers with the current state, not an error.
    const untouched = await patch(as, link.id, {})
    assert.equal(untouched.status, 200, untouched.text)
    assert.equal(untouched.json.share.expiresAt, expiryBefore)
    assert.equal(untouched.json.share.maxDownloads, 12)
  })

  it('renews an expired link on the same token', async () => {
    const as = await newAccount('renew')
    const file = await uploadAs(as, 'renew.txt', 'renew bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader' })
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE shares SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 60_000).toISOString(), link.id)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 404)

    const listed = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(listed.json.shares[0].state, 'expired')
    assert.equal(listed.json.shares[0].usable, false)

    const renewed = await patch(as, link.id, { expiresInDays: 7 })
    assert.equal(renewed.status, 200, renewed.text)
    assert.equal(renewed.json.share.token, link.token)
    assert.ok(new Date(renewed.json.share.expiresAt).getTime() > Date.now())
    // The same URL works again; the counter was untouched by the renewal.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 200)
    const after = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(after.json.shares[0].state, 'active')
    assert.equal(after.json.shares[0].usable, true)
  })

  it('lifts an exhausted link by clearing or raising the cap, and never resets the counter', async () => {
    const as = await newAccount('cap')
    const file = await uploadAs(as, 'cap.txt', 'cap bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader', maxDownloads: 1 })
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 404)

    const raised = await patch(as, link.id, { maxDownloads: 3 })
    assert.equal(raised.status, 200, raised.text)
    assert.equal(raised.json.share.downloads, 1, 'raising the cap must not refund spent downloads')
    assert.equal(raised.json.share.maxDownloads, 3)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).json.share.downloads, 1)
    // One slot is left, and it is really usable.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 200)

    const unlimited = await patch(as, link.id, { maxDownloads: null })
    assert.equal(unlimited.status, 200, unlimited.text)
    assert.equal(unlimited.json.share.maxDownloads, null)
    assert.equal(unlimited.json.share.downloads, 2)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 200)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).json.share.downloads, 3)
  })

  it('makes a downgrade to viewer work even when the old download cap was exhausted', async () => {
    const as = await newAccount('downgrade')
    const file = await uploadAs(as, 'downgrade.txt', 'viewable bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader', maxDownloads: 1 })
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 200)

    // The stored cap is spent. Downgrading must not leave a link nobody can open.
    const edited = await patch(as, link.id, { permission: 'viewer' })
    assert.equal(edited.status, 200, edited.text)
    assert.equal(edited.json.share.downloads, 1, 'the counter is history, not a reset')

    const listed = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(listed.json.shares[0].state, 'active', 'a viewer link is not exhausted')
    assert.equal(listed.json.shares[0].usable, true)
    assert.equal(listed.json.shares[0].canDownload, false)

    // Meaningful view work: metadata, inline preview and folder-style reads all
    // answer, and none of them spend the budget.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 200)
    const preview = await api('GET', '/api/v1/shared/' + link.token + '/preview')
    assert.equal(preview.status, 200, preview.text)
    assert.equal(preview.headers.get('content-disposition'), null)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).json.share.downloads, 1)
    // The attachment half stays refused for a viewer.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 403)

    // Switching back to downloader resumes the same spent budget rather than
    // handing out a fresh one.
    const back = await patch(as, link.id, { permission: 'downloader' })
    assert.equal(back.status, 200, back.text)
    const after = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(after.json.shares[0].state, 'exhausted')
    assert.equal(after.json.shares[0].usable, false)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token + '/content')).status, 404)
  })

  it('lets a folder link downgraded from an exhausted downloader still be browsed', async () => {
    const as = await newAccount('folder-downgrade')
    const root = await folderAs(as, 'team-folder')
    await api('PUT', '/api/v1/uploads?name=inside.txt&parentId=' + root.id,
      { token: as, raw: true, body: 'inside bytes', headers: { 'content-type': 'text/plain' } })
    const link = await createShareFor(as, root.id, { permission: 'downloader', maxDownloads: 1 })
    assert.equal((await fetchBytes('/api/v1/shared/' + link.token + '/archive')).status, 200)

    const edited = await patch(as, link.id, { permission: 'viewer' })
    assert.equal(edited.status, 200, edited.text)
    const children = await api('GET', '/api/v1/shared/' + link.token + '/children')
    assert.equal(children.status, 200, children.text)
    assert.deepEqual(children.json.entries.map((entry) => entry.name), ['inside.txt'])
    assert.equal(children.json.permission, 'viewer')
    // The archive half is refused, and refusing it spends nothing.
    assert.equal((await fetchBytes('/api/v1/shared/' + link.token + '/archive')).status, 403)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).json.share.downloads, 1)
  })

  it('replaces and removes the password without ever returning or accepting the old one', async () => {
    const as = await newAccount('password')
    const file = await uploadAs(as, 'locked.txt', 'locked bytes')
    const link = await createShareFor(as, file.id, { password: 'first secret' })
    const open = (password) => api('GET', '/api/v1/shared/' + link.token + '?password=' + encodeURIComponent(password))

    assert.equal((await open('first secret')).status, 200)
    assert.equal((await open('second secret')).status, 401)

    const replaced = await patch(as, link.id, { password: 'second secret' })
    assert.equal(replaced.status, 200, replaced.text)
    // The response says only that a password exists — never the hash, never the
    // plaintext, and never a field a client could mistake for the current one.
    assert.equal(replaced.json.share.hasPassword, true)
    assert.ok(!Object.prototype.hasOwnProperty.call(replaced.json.share, 'password'))
    assert.ok(!Object.prototype.hasOwnProperty.call(replaced.json.share, 'passwordHash'))
    assert.ok(!/scrypt:/i.test(replaced.text), 'a stored hash must never be echoed')

    // The rotation takes effect on the very next recipient request.
    assert.equal((await open('first secret')).status, 401)
    assert.equal((await open('second secret')).status, 200)

    const removed = await patch(as, link.id, { password: null })
    assert.equal(removed.status, 200, removed.text)
    assert.equal(removed.json.share.hasPassword, false)
    // No password is now the correct, and only, way in.
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 200)
    assert.equal((await open('second secret')).status, 200, 'a stale password is not an error once the lock is gone')

    // And setting one again locks the link immediately.
    const relocked = await patch(as, link.id, { password: 'third secret' })
    assert.equal(relocked.status, 200, relocked.text)
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 401)
    assert.equal((await open('third secret')).status, 200)
  })

  it('applies a shortened expiry and a password change to already-issued URLs at once', async () => {
    const as = await newAccount('immediate')
    const root = await folderAs(as, 'immediate-folder')
    await api('PUT', '/api/v1/uploads?name=a.txt&parentId=' + root.id,
      { token: as, raw: true, body: 'a bytes', headers: { 'content-type': 'text/plain' } })
    const link = await createShareFor(as, root.id, { permission: 'downloader' })
    const publicRoot = '/api/v1/shared/' + link.token
    assert.equal((await api('GET', publicRoot + '/children')).status, 200)

    // Expiring it now (a moment in the past would be rejected, so this test moves
    // the row instead) must stop every route, exactly like a link that aged out.
    const { db } = await import('../src/db.js')
    db.prepare('UPDATE shares SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), link.id)
    for (const path of ['', '/children', '/archive']) {
      const response = await fetchBytes(publicRoot + path)
      assert.equal(response.status, 404, path + ' must refuse an expired link')
    }
    // Renewing restores the same URLs; nothing about the token changed.
    const renewed = await patch(as, link.id, { expiresInDays: 1 })
    assert.equal(renewed.status, 200, renewed.text)
    assert.equal((await api('GET', publicRoot + '/children')).status, 200)
    assert.equal((await fetchBytes(publicRoot + '/archive')).status, 200)

    // A password added later locks the archive route for an unknown recipient,
    // and the request that already holds the right one keeps working.
    const locked = await patch(as, link.id, { password: 'late lock' })
    assert.equal(locked.status, 200, locked.text)
    assert.equal((await fetchBytes(publicRoot + '/archive')).status, 401)
    assert.equal((await fetchBytes(publicRoot + '/archive?password=' + encodeURIComponent('late lock'))).status, 200)
  })

  it('is owner-scoped: a stranger and a workspace member both get 404 and change nothing', async () => {
    const owner = await newAccount('patch-owner')
    const stranger = await newAccount('patch-stranger')
    const member = await newAccount('patch-member')
    const ownerInfo = await api('GET', '/api/v1/me', { token: owner })
    const { addMember } = await import('../src/workspaces.js')
    addMember(ownerInfo.json.user.workspace.id, (await api('GET', '/api/v1/me', { token: member })).json.user.id, 'member')

    const file = await uploadAs(owner, 'guarded.txt', 'guarded bytes')
    const link = await createShareFor(owner, file.id, { permission: 'viewer' })

    for (const as of [stranger, member]) {
      const denied = await patch(as, link.id, { permission: 'downloader' })
      assert.equal(denied.status, 404, 'a non-owner must not even learn the link exists')
      assert.ok(!denied.text.includes(link.token))
    }
    // Nothing moved: the link is still the owner's viewer link.
    const still = await api('GET', '/api/v1/shares', { token: owner })
    assert.equal(still.json.shares[0].id, link.id)
    assert.equal(still.json.shares[0].permission, 'viewer')

    // A genuinely unknown id is the same answer as another account's id.
    const missing = await patch(owner, '00000000-0000-4000-8000-000000000000', { permission: 'downloader' })
    assert.equal(missing.status, 404)

    const anonymous = await api('PATCH', '/api/v1/shares/' + link.id, { body: { permission: 'downloader' } })
    assert.equal(anonymous.status, 401)
  })

  it('only lists the caller\'s own tokens for a workspace node', async () => {
    const owner = await newAccount('list-owner')
    const member = await newAccount('list-member')
    const ownerInfo = await api('GET', '/api/v1/me', { token: owner })
    const { addMember } = await import('../src/workspaces.js')
    addMember(ownerInfo.json.user.workspace.id, (await api('GET', '/api/v1/me', { token: member })).json.user.id, 'member')

    const file = await uploadAs(owner, 'team.txt', 'team bytes')
    const owned = await createShareFor(owner, file.id, { permission: 'downloader' })
    // The member can see the node (requireNode admits the workspace) and may
    // therefore create their own link to it, but must never see the owner's.
    const theirs = await createShareFor(member, file.id, { permission: 'viewer' })

    const asOwner = await api('GET', '/api/v1/nodes/' + file.id + '/shares', { token: owner })
    assert.equal(asOwner.status, 200, asOwner.text)
    assert.deepEqual(asOwner.json.shares.map((row) => row.id), [owned.id])
    assert.ok(!asOwner.text.includes(theirs.token), 'a member\'s token leaked into the owner\'s view')

    const asMember = await api('GET', '/api/v1/nodes/' + file.id + '/shares', { token: member })
    assert.equal(asMember.status, 200, asMember.text)
    assert.deepEqual(asMember.json.shares.map((row) => row.id), [theirs.id])
    assert.ok(!asMember.text.includes(owned.token), 'the owner\'s token leaked into a member\'s view')

    // The management list was already owner-scoped and still is.
    assert.deepEqual((await api('GET', '/api/v1/shares', { token: owner })).json.shares.map((row) => row.id), [owned.id])
    assert.deepEqual((await api('GET', '/api/v1/shares', { token: member })).json.shares.map((row) => row.id), [theirs.id])
  })

  it('rejects invalid patches without touching the row', async () => {
    const as = await newAccount('validate')
    const file = await uploadAs(as, 'validate.txt', 'validate bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader', maxDownloads: 4, expiresInDays: 30 })
    const before = (await api('GET', '/api/v1/shares', { token: as })).json.shares[0]

    const rejected = [
      ['permission', { permission: 'owner' }],
      ['permission null', { permission: null }],
      ['expiry in the past', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
      ['expiry garbage', { expiresAt: 'tomorrow' }],
      ['expiry number', { expiresAt: 12345 }],
      ['both expiry shapes', { expiresAt: new Date(Date.now() + 86400000).toISOString(), expiresInDays: 2 }],
      ['expiry days zero', { expiresInDays: 0 }],
      ['expiry days too long', { expiresInDays: 366 }],
      ['expiry days fractional', { expiresInDays: 1.5 }],
      ['cap zero', { maxDownloads: 0 }],
      ['cap negative', { maxDownloads: -3 }],
      ['cap fractional', { maxDownloads: 2.5 }],
      ['cap text', { maxDownloads: 'many' }],
      ['password empty', { password: '' }],
      ['password not a string', { password: 123 }],
      ['password too long', { password: 'x'.repeat(201) }],
      ['password already hashed', { password: 'scrypt:abc:def' }],
      ['immutable token', { token: 'replacement' }],
      ['immutable downloads', { downloads: 0 }],
      ['immutable node', { nodeId: file.id }],
      ['unknown field', { keepPassword: true }],
    ]
    for (const [label, body] of rejected) {
      const response = await patch(as, link.id, body)
      assert.equal(response.status, 400, label + ' must be rejected: ' + response.text)
      assert.equal(response.json.error.code, 'INVALID_INPUT', label)
    }

    // A non-object body is refused too, rather than being read as an empty patch.
    const arrayBody = await patch(as, link.id, ['viewer'])
    assert.equal(arrayBody.status, 400)

    const after = (await api('GET', '/api/v1/shares', { token: as })).json.shares[0]
    assert.deepEqual(after, before, 'a rejected patch must leave every field exactly as it was')
  })

  it('returns 404 instead of resurrecting a link revoked during hashing', async () => {
    const as = await newAccount('revoke-race')
    const file = await uploadAs(as, 'race.txt', 'race bytes')
    const link = await createShareFor(as, file.id, { password: 'first secret' })

    // Revoke exactly while the password hash is being computed, which is the one
    // await this route has: the hash cannot be swapped, but the row can be read
    // and deleted between the route's own read and its write. Deleting first and
    // patching after models that interleaving from the client's side and asserts
    // the same invariant: a write must never bring the row back.
    assert.equal((await api('DELETE', '/api/v1/shares/' + link.id, { token: as })).status, 200)
    const late = await patch(as, link.id, { permission: 'downloader', password: 'new secret' })
    assert.equal(late.status, 404, late.text)
    assert.equal(late.json.error.code, 'NOT_FOUND')
    const { db } = await import('../src/db.js')
    assert.equal(db.prepare('SELECT id FROM shares WHERE id=?').get(link.id), undefined, 'the revoked row must stay gone')
    assert.equal((await api('GET', '/api/v1/shared/' + link.token)).status, 404)
    assert.deepEqual((await api('GET', '/api/v1/shares', { token: as })).json.shares, [])
  })

  it('keeps a download that lands mid-edit, and never rewinds the counter', async () => {
    const as = await newAccount('counter-race')
    const file = await uploadAs(as, 'counter.txt', 'counter bytes')
    const link = await createShareFor(as, file.id, { permission: 'downloader' })

    // A download and an edit genuinely interleave: both are separate requests
    // here, and the invariant is that neither loses the other's work.
    const [edit, download] = await Promise.all([
      patch(as, link.id, { expiresInDays: 7, maxDownloads: 9 }),
      api('GET', '/api/v1/shared/' + link.token + '/content'),
    ])
    assert.equal(download.status, 200, download.text)
    assert.equal(edit.status, 200, edit.text)
    const after = await api('GET', '/api/v1/shares', { token: as })
    assert.equal(after.json.shares[0].downloads, 1, 'the edit must not reset the counter')
    assert.equal(after.json.shares[0].maxDownloads, 9)
    assert.ok(new Date(after.json.shares[0].expiresAt).getTime() > Date.now())
  })

  it('does not write a partial patch of an unrelated field over a concurrent one', async () => {
    const as = await newAccount('partial-race')
    const file = await uploadAs(as, 'partial.txt', 'partial bytes')
    const link = await createShareFor(as, file.id, { permission: 'viewer', maxDownloads: 2 })
    // Two patches that each name one field: the SET list of each is that field,
    // so both land and neither can clobber the other.
    const [cap, permission] = await Promise.all([
      patch(as, link.id, { maxDownloads: 5 }),
      patch(as, link.id, { permission: 'downloader' }),
    ])
    assert.equal(cap.status, 200, cap.text)
    assert.equal(permission.status, 200, permission.text)
    const after = (await api('GET', '/api/v1/shares', { token: as })).json.shares[0]
    assert.equal(after.maxDownloads, 5, 'the cap patch must survive the permission patch')
    assert.equal(after.permission, 'downloader')
  })
})

describe('folder archive lifecycle', () => {
  /** Current blob rows, used as a leak detector for a transient ZIP. */
  async function blobRows() {
    const { db } = await import('../src/db.js')
    return db.prepare('SELECT COUNT(*) AS count FROM blobs').get().count
  }

  async function spoolFiles() {
    const { config } = await import('../src/config.js')
    const names = await readdir(config.tmpDir).catch(() => [])
    return names.filter((name) => name.startsWith('zip-') && name.endsWith('.part'))
  }

  async function waitFor(check, label) {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (await check()) return
      if (Date.now() > deadline) assert.fail('timed out waiting for ' + label)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /**
   * Holds the archive build at the first source read and hands the test a
   * `release()`.
   *
   * Packaging a ZIP reads each entry through `backend.get`, which is the same
   * seam dedup-scope.test.js already gates. Matching on this test's own blob hash
   * keeps the patch from delaying any other request.
   */
  async function gateArchiveRead(hash) {
    const { backend } = await import('../src/storage/backend.js')
    const originalGet = backend.get
    let reached
    let release
    const atRead = new Promise((resolve) => { reached = resolve })
    const unblock = new Promise((resolve) => { release = resolve })
    backend.get = function (key) {
      if (key !== hash) return originalGet.call(this, key)
      return Readable.from((async function* () {
        reached()
        await unblock
        yield* originalGet.call(backend, key)
      })())
    }
    return {
      atRead,
      release,
      restore: () => { backend.get = originalGet },
    }
  }

  /**
   * Holds the first backend lookup of a hash the test has not seen before.
   *
   * That lookup is the archive being adopted into (or served from) the blob
   * store: every pre-existing blob is already known, so the newcomer can only be
   * the ZIP this request just built. Holding it lets a test disconnect exactly
   * when the archive exists but no byte of it has been sent.
   */
  async function gateArchiveAdoption(known) {
    const { backend } = await import('../src/storage/backend.js')
    const originalStat = backend.stat
    let reached
    let release
    const atStat = new Promise((resolve) => { reached = resolve })
    const unblock = new Promise((resolve) => { release = resolve })
    backend.stat = async function (key) {
      if (known.has(key)) return originalStat.call(this, key)
      reached()
      await unblock
      return originalStat.call(this, key)
    }
    return {
      atStat,
      release,
      restore: () => { backend.stat = originalStat },
    }
  }

  async function blobHashes() {
    const { db } = await import('../src/db.js')
    return new Set(db.prepare('SELECT hash FROM blobs').all().map((row) => row.hash))
  }

  async function shareMeta(link) {
    const meta = await api('GET', '/api/v1/shared/' + link.token)
    return meta.json.share.downloads
  }

  it('refuses an expired or exhausted folder link before packaging anything', async () => {
    const root = await folder('gate-folder')
    await upload('gate.txt', 'gate bytes', 'text/plain', root.id)
    const expired = await share(root.id, { permission: 'downloader' })
    const exhausted = await share(root.id, { permission: 'downloader', maxDownloads: 1 })
    // Baseline after the fixtures: their uploads are blobs too, and this is a
    // question about the archive adding one more.
    const baseline = await blobRows()

    const { db } = await import('../src/db.js')
    db.prepare('UPDATE shares SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 60_000).toISOString(), expired.id)
    db.prepare('UPDATE shares SET downloads=1 WHERE id=?').run(exhausted.id)

    for (const link of [expired, exhausted]) {
      const archive = await fetchBytes('/api/v1/shared/' + link.token + '/archive')
      assert.equal(archive.status, 404)
      assert.equal(JSON.parse(archive.body.toString()).error.code, 'SHARE_NOT_FOUND')
    }
    assert.equal(await blobRows(), baseline, 'a refused archive must not spool a blob')
    assert.deepEqual(await spoolFiles(), [])
  })

  it('releases the archive and spends no download when the client leaves during packaging', async () => {
    const root = await folder('cancel-folder')
    const file = await upload('cancel.txt', 'cancel bytes for a pending archive', 'text/plain', root.id)
    const link = await share(root.id, { permission: 'downloader' })
    const blobHash = (await api('GET', '/api/v1/nodes/' + file.id, auth())).json.node.blobHash
    const baseline = await blobRows()
    const gate = await gateArchiveRead(blobHash)
    // A real client hangup: aborting the fetch closes the socket while the build
    // is still holding its spool. Nothing else tells the server that.
    const request = new AbortController()
    try {
      const pending = fetch('http://127.0.0.1:' + app.port + '/api/v1/shared/' + link.token + '/archive', {
        signal: request.signal,
      })
      await gate.atRead
      request.abort()
      await assert.rejects(pending, (error) => error.name === 'AbortError')
    } finally {
      request.abort()
      // Releasing the gate lets the aborted build unwind; the gate is restored
      // only afterwards so the release path is the one actually being exercised.
      gate.release()
      gate.restore()
    }
    await waitFor(async () => (await spoolFiles()).length === 0, 'the abandoned ZIP spool to disappear')
    await waitFor(async () => (await blobRows()) === baseline, 'the abandoned ZIP blob to be released')
    assert.equal(await shareMeta(link), 0, 'a canceled request is not a download')
  })

  it('releases an archive exactly once when the client leaves as it is adopted', async () => {
    const root = await folder('adopt-folder')
    await upload('adopt.txt', 'bytes adopted while the socket dies', 'text/plain', root.id)
    const link = await share(root.id, { permission: 'downloader' })
    const baseline = await blobRows()
    const known = await blobHashes()
    const gate = await gateArchiveAdoption(known)
    const request = new AbortController()
    try {
      const pending = fetch('http://127.0.0.1:' + app.port + '/api/v1/shared/' + link.token + '/archive', {
        signal: request.signal,
      })
      await gate.atStat
      // The ZIP exists but has not been served; drop the client here, then let
      // the adoption finish. Exactly one reference may be released, and it must
      // not be released before adoption took it.
      request.abort()
      gate.release()
      await assert.rejects(pending, (error) => error.name === 'AbortError')
    } finally {
      request.abort()
      gate.release()
      gate.restore()
    }
    await waitFor(async () => (await blobRows()) === baseline, 'the unserved ZIP blob to be released once')
    // The spool is reclaimed by the builder's own finally just after adoption,
    // so it can trail the blob row by a tick.
    await waitFor(async () => (await spoolFiles()).length === 0, 'the unserved ZIP spool to disappear')
    assert.equal(await shareMeta(link), 0, 'an abandoned archive spends no download')
  })

  /**
   * A capability that is spent while the ZIP is still being written.
   *
   * `spend` mutates the link or its source once the build is demonstrably in
   * progress; `expect` is the refusal the already-open response must carry.
   */
  const RECHECK_CASES = [
    {
      name: 'expired',
      share: {},
      spend: async (link, root) => {
        const { db } = await import('../src/db.js')
        db.prepare('UPDATE shares SET expires_at=? WHERE id=?')
          .run(new Date(Date.now() - 60_000).toISOString(), link.id)
      },
      expect: { status: 404, code: 'SHARE_NOT_FOUND' },
    },
    {
      name: 'trashed',
      share: {},
      spend: async (link, root) => {
        const trashed = await api('DELETE', '/api/v1/nodes/' + root.id, auth())
        assert.equal(trashed.status, 200, trashed.text)
      },
      expect: { status: 404, code: 'SHARE_NOT_FOUND' },
    },
    {
      name: 'exhausted',
      share: { maxDownloads: 1 },
      spend: async (link) => {
        const { db } = await import('../src/db.js')
        db.prepare('UPDATE shares SET downloads=1 WHERE id=?').run(link.id)
      },
      expect: { status: 404, code: 'SHARE_NOT_FOUND' },
      downloads: 1,
    },
    {
      name: 'password-rotated',
      share: { password: 'first secret' },
      query: '?password=' + encodeURIComponent('first secret'),
      spend: async (link) => {
        // The password was proven before packaging; rotating it invalidates that
        // proof, and the bearer of the old one must be refused.
        const { passwordHash } = await import('../src/security.js')
        const { db } = await import('../src/db.js')
        db.prepare('UPDATE shares SET password_hash=? WHERE id=?').run(await passwordHash('second secret'), link.id)
      },
      expect: { status: 401, code: 'SHARE_LOCKED' },
    },
    {
      name: 'downgraded-to-viewer',
      share: {},
      spend: async (link) => {
        const { db } = await import('../src/db.js')
        db.prepare("UPDATE shares SET permission='viewer' WHERE id=?").run(link.id)
      },
      expect: { status: 403, code: 'FORBIDDEN' },
    },
  ]

  for (const testCase of RECHECK_CASES) {
    it('rechecks the link after packaging and releases the archive when it was ' + testCase.name, async () => {
      const root = await folder('recheck-folder-' + testCase.name)
      const file = await upload('recheck-' + testCase.name + '.txt', 'recheck bytes ' + testCase.name, 'text/plain', root.id)
      const link = await share(root.id, { permission: 'downloader', ...testCase.share })
      const blobHash = (await api('GET', '/api/v1/nodes/' + file.id, auth())).json.node.blobHash
      const baseline = await blobRows()
      const gate = await gateArchiveRead(blobHash)
      let pending
      try {
        pending = fetch('http://127.0.0.1:' + app.port + '/api/v1/shared/' + link.token + '/archive' + (testCase.query || ''))
        await gate.atRead
        await testCase.spend(link, root)
        gate.release()
        const response = await pending
        pending = null
        const body = await response.json()
        assert.equal(response.status, testCase.expect.status, JSON.stringify(body))
        assert.equal(body.error.code, testCase.expect.code)
      } finally {
        gate.release()
        gate.restore()
        if (pending) await pending.catch(() => {})
      }
      await waitFor(async () => (await blobRows()) === baseline, 'the refused ZIP blob to be released')
      assert.deepEqual(await spoolFiles(), [], 'the refused archive leaves no spool behind')
      if (testCase.name !== 'trashed') {
        // The link is still listed for the owner, and the refusal itself spent
        // nothing on top of whatever the test did to spend it.
        const listed = await api('GET', '/api/v1/nodes/' + root.id + '/shares', auth())
        assert.equal(listed.json.shares.find((share) => share.id === link.id).downloads, testCase.downloads ?? 0)
      }
    })
  }
})
