import assert from 'node:assert/strict'
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
