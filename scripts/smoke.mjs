#!/usr/bin/env node
/**
 * End-to-end smoke test against a *running* Marvelous Drive server.
 *
 *   node scripts/smoke.mjs [--server http://127.0.0.1:4400]
 *
 * Exercises the paths a real client uses: register, folder, simple upload,
 * range read, resumable upload, share link, anonymous download, trash/purge,
 * content search and index coverage. Exits non-zero on the first failure so it
 * can gate a deployment.
 */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const server = flag('server', process.env.MDRIVE_SERVER || 'http://127.0.0.1:4400').replace(/\/+$/, '')
const api = `${server}/api/v1`

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${name}`) }
  else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}

async function call(method, path, { body, token, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers } }
  if (token) init.headers.authorization = `Bearer ${token}`
  if (body !== undefined) {
    if (raw) init.body = body
    else { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  }
  const response = await fetch(path.startsWith('http') ? path : api + path, init)
  const buffer = Buffer.from(await response.arrayBuffer())
  let json = null
  try { json = buffer.length ? JSON.parse(buffer.toString('utf8')) : null } catch { json = null }
  return { status: response.status, json, buffer, headers: response.headers }
}

const email = `smoke-${Date.now()}@example.com`
console.log(`Marvelous Drive smoke test against ${server}\n`)

const health = await call('GET', `${server}/healthz`)
check('healthz answers ok', health.status === 200 && health.json?.status === 'ok', `status ${health.status}`)

const registered = await call('POST', '/auth/register', { body: { email, password: 'smoke test password' } })
check('register returns a token', registered.status === 201 && typeof registered.json?.token === 'string', `status ${registered.status}`)
const token = registered.json?.token
if (!token) { console.log('\ncannot continue without a token'); process.exit(1) }

const me = await call('GET', '/me', { token })
check('me returns the account', me.json?.user?.email === email)

const folder = await call('POST', '/nodes', { token, body: { name: `Smoke ${Date.now()}`, kind: 'folder' } })
check('folder created', folder.status === 201 && folder.json?.node?.kind === 'folder')
const folderId = folder.json?.node?.id

const payload = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(200))
const uploaded = await call('PUT', `/uploads?parentId=${folderId}&name=fox.txt`, {
  token, raw: true, body: payload, headers: { 'content-type': 'text/plain' },
})
check('simple upload', uploaded.status === 201 && uploaded.json?.node?.size === payload.length, `status ${uploaded.status}`)
const fileId = uploaded.json?.node?.id

const ranged = await call('GET', `/files/${fileId}/content`, { token, headers: { range: 'bytes=0-9' } })
check('range read returns 206', ranged.status === 206 && ranged.buffer.toString() === 'the quick ', `${ranged.status} ${ranged.buffer.slice(0, 12)}`)

const text = await call('GET', `/files/${fileId}/text?limit=64`, { token })
check('text preview is truncated', text.json?.truncated === true && text.json.text.length === 64)

const big = Buffer.alloc(200000, 7)
const session = await call('POST', '/uploads/sessions', { token, body: { name: 'big.bin', size: big.length, chunkSize: 65536, parentId: folderId } })
check('upload session created', session.status === 201 && session.json?.upload?.totalChunks === 4, `status ${session.status}`)
const sessionId = session.json?.upload?.id
for (let index = 0; index < 4; index++) {
  const chunk = big.subarray(index * 65536, Math.min((index + 1) * 65536, big.length))
  const put = await call('PUT', `/uploads/sessions/${sessionId}/chunks/${index}`, {
    token, raw: true, body: chunk, headers: { 'content-type': 'application/octet-stream' },
  })
  if (put.status !== 200) { check(`chunk ${index} accepted`, false, `status ${put.status}`); break }
}
const completed = await call('POST', `/uploads/sessions/${sessionId}/complete`, { token, body: {} })
check('resumable upload completes', completed.status === 201 && completed.json?.node?.size === big.length, `status ${completed.status}`)

const share = await call('POST', `/nodes/${fileId}/share`, { token, body: { permission: 'downloader' } })
check('share link created', share.status === 201 && typeof share.json?.share?.token === 'string')
const shareToken = share.json?.share?.token

const publicMeta = await call('GET', `/shared/${shareToken}`)
check('public metadata is anonymous', publicMeta.status === 200 && publicMeta.json?.share?.node?.name === 'fox.txt')

const publicDownload = await call('GET', `/shared/${shareToken}/content`)
check('public download returns the bytes', publicDownload.status === 200 && publicDownload.buffer.length === payload.length)
check('download is an attachment', /attachment/.test(publicDownload.headers.get('content-disposition') || ''))

const stats = await call('GET', '/storage/stats', { token })
check('stats count the uploads', (stats.json?.stats?.files ?? 0) >= 2, JSON.stringify(stats.json?.stats))

const trashed = await call('DELETE', `/nodes/${folderId}`, { token })
check('trash cascades', trashed.status === 200 && trashed.json?.trashed >= 3, JSON.stringify(trashed.json))
const purged = await call('DELETE', `/nodes/${folderId}/permanent`, { token })
check('permanent delete', purged.status === 200 && purged.json?.purged >= 3, JSON.stringify(purged.json))
const gone = await call('GET', `/nodes/${fileId}`, { token })
check('purged node is gone', gone.status === 404)

const contentSearch = await call('GET', '/search?q=' + encodeURIComponent('内容命中探针') + '&scope=content', { token })
check('content search answers', contentSearch.status === 200 && Array.isArray(contentSearch.json?.results), JSON.stringify(contentSearch.json))

const coverage = await call('GET', '/maintenance/search', { token })
check('index coverage is reported', coverage.status === 200 && typeof coverage.json?.coverage?.missing === 'number', JSON.stringify(coverage.json))

const broken = await call('GET', '/nodes/not-a-uuid', { token })
check('bad id is rejected', broken.status === 404 || broken.status === 400)

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
