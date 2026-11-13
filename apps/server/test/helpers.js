import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Boots the real server in-process on an ephemeral port with a throwaway data
 * directory, and hands back a tiny fetch client. Nothing here mocks HTTP: the
 * tests exercise the same code path a browser or the CLI would.
 */

export async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mdrive-test-'))
  process.env.DRIVE_DATA_DIR = dataDir
  process.env.PORT = '0'
  process.env.HOST = '127.0.0.1'
  process.env.DRIVE_LOG = '0'

  // Import after the env is set: config.js resolves paths at module load.
  const { server } = await import('../src/index.js')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  const client = async (method, path, { body, token, headers = {}, raw = false } = {}) => {
    const init = { method, headers: { ...headers } }
    if (token) init.headers.authorization = `Bearer ${token}`
    if (body !== undefined) {
      init.body = raw || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
      if (!raw) init.headers['content-type'] = init.headers['content-type'] || 'application/json'
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: response.status, json, text, headers: response.headers }
  }

  const close = () => new Promise((resolve) => server.close(resolve))

  const cleanup = () => { try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* windows lock */ } }

  return { client, close, cleanup, dataDir, port }
}

export const uniqueEmail = () => `user-${Math.random().toString(16).slice(2)}@example.com`
