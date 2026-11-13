#!/usr/bin/env node
import { resolve } from 'node:path'
import { createNodeServer } from '../src/storage/node.js'

/**
 * Standalone storage node.
 *
 *   DRIVE_NODE_TOKEN=<token> DRIVE_NODE_DIR=/srv/drive-blobs node bin/storage-node.js
 *
 * This process is intentionally tiny and has no dependency on the coordinator's
 * codebase beyond one file: it stores bytes, verifies their sha256, and answers
 * four verbs. Running it next to the coordinator (`node:storage-node.js` with
 * `DRIVE_STORAGE=cluster`) puts a second disk on the same machine; running it on
 * another box is the case this exists for.
 *
 *   PORT=4501              port to listen on (default 4501)
 *   HOST=0.0.0.0           bind address (default 127.0.0.1; use 0.0.0.0 for a peer)
 *   DRIVE_NODE_DIR         where blobs go (required)
 *   DRIVE_NODE_TOKEN       shared secret the coordinator presents (required)
 *   DRIVE_NODE_NAME        name shown in /health and in the coordinator's report
 *   DRIVE_NODE_CAPACITY_BYTES  advertised ceiling, 0 = announce only what is used
 */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const rootDir = resolve(flag('dir', process.env.DRIVE_NODE_DIR || ''))
const token = flag('token', process.env.DRIVE_NODE_TOKEN || '')
const name = flag('name', process.env.DRIVE_NODE_NAME || 'storage-node')
const port = Number(flag('port', process.env.PORT || 4501))
const host = flag('host', process.env.HOST || '127.0.0.1')
const capacityBytes = Number(flag('capacity', process.env.DRIVE_NODE_CAPACITY_BYTES || 0))

if (!rootDir) {
  console.error('storage-node: DRIVE_NODE_DIR is required (where blobs are stored).')
  process.exit(2)
}
if (!token) {
  console.error('storage-node: DRIVE_NODE_TOKEN is required. An open node is a public write endpoint.')
  process.exit(2)
}
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error('storage-node: PORT must be a port number, received "' + port + '".')
  process.exit(2)
}

const server = createNodeServer({ rootDir, token, name, capacityBytes })
server.listen(port, host, () => {
  console.log('storage node "' + name + '" listening on http://' + host + ':' + port)
  console.log('  blobs: ' + rootDir)
  console.log('  advertise this endpoint to the coordinator: http://' + host + ':' + port)
  if (host === '127.0.0.1') console.log('  (bound to loopback: pass --host 0.0.0.0 to accept other machines)')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(signal + ' received, closing the storage node')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
