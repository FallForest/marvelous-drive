import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'

let fixtureDir
let thumbnail
let previewSource
let THUMBNAIL_LIMITS
let cachedir
const savedDataDir = process.env.DRIVE_DATA_DIR

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'mdrive-thumbnail-'))
  process.env.DRIVE_DATA_DIR = fixtureDir
  ;({ thumbnail, THUMBNAIL_LIMITS } = await import('../src/ops/thumbnail.js'))
  ;({ previewSource } = await import('../src/ops/preview-source.js'))
  cachedir = join(fixtureDir, 'cache')
})

after(async () => {
  const { db } = await import('../src/db.js')
  db.close()
  if (savedDataDir === undefined) delete process.env.DRIVE_DATA_DIR
  else process.env.DRIVE_DATA_DIR = savedDataDir
  if (resolve(dirname(fixtureDir)) !== resolve(tmpdir()) || !basename(fixtureDir).startsWith('mdrive-thumbnail-')) {
    throw new Error('Unexpected thumbnail fixture directory.')
  }
  await rm(fixtureDir, { recursive: true, force: true })
})

async function source(buffer) {
  const hash = createHash('sha256').update(buffer).digest('hex')
  const path = join(fixtureDir, hash)
  await writeFile(path, buffer)
  const store = { name: 'local', path: () => path, stat: async () => ({ size: buffer.length }) }
  return { hash, store }
}

test('JPEG, PNG and WebP sources become real bounded WebP thumbnails', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const original = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#5a80b0' } })[format]().toBuffer()
    const { hash, store } = await source(original)
    const image = await thumbnail(hash, 128, { store, cacheDir: cachedir })
    const meta = await sharp(image.buffer).metadata()
    assert.equal(image.mime, 'image/webp')
    assert.equal(meta.format, 'webp')
    assert.equal(meta.width, 128)
    assert.ok(meta.height <= 128)
    assert.ok(image.buffer.length < original.length, format + ' thumbnail must be smaller than its original')
    assert.notDeepEqual(image.buffer, original)
  }
})

test('portrait images are bounded by their long edge and tiny images are not enlarged', async () => {
  const original = await sharp({ create: { width: 200, height: 2000, channels: 4, background: '#80d2a0' } }).png().toBuffer()
  const fixture = await source(original)
  const portrait = await thumbnail(fixture.hash, 128, { store: fixture.store, cacheDir: cachedir })
  const meta = await sharp(portrait.buffer).metadata()
  assert.equal(meta.height, 128)
  assert.ok(meta.width <= 128)
  const tiny = await source(await sharp({ create: { width: 2, height: 1, channels: 3, background: 'red' } }).png().toBuffer())
  const small = await thumbnail(tiny.hash, 128, { store: tiny.store, cacheDir: cachedir })
  assert.equal((await sharp(small.buffer).metadata()).width, 2)
})

test('cache hits do not read the source and content changes get different cache entries', async () => {
  const a = await source(await sharp({ create: { width: 500, height: 500, channels: 3, background: 'red' } }).png().toBuffer())
  const b = await source(await sharp({ create: { width: 500, height: 500, channels: 3, background: 'blue' } }).png().toBuffer())
  const first = await thumbnail(a.hash, 64, { store: a.store, cacheDir: cachedir })
  const hit = await thumbnail(a.hash, 64, { store: { stat() { throw new Error('cache hit must not read source') } }, cacheDir: cachedir })
  assert.equal(hit.cache, 'hit')
  assert.deepEqual(hit.buffer, first.buffer)
  const changed = await thumbnail(b.hash, 64, { store: b.store, cacheDir: cachedir })
  assert.notDeepEqual(changed.buffer, first.buffer)
})

test('concurrent requests for one hash and width perform one source read', async () => {
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#bbddff' } }).png().toBuffer()
  let reads = 0
  const hash = createHash('sha256').update(bytes).digest('hex')
  const store = { name: 'remote', stat: async () => ({ size: bytes.length }), get() { reads += 1; return Readable.from([bytes]) } }
  const results = await Promise.all(Array.from({ length: 8 }, () => thumbnail(hash, 63, { store, cacheDir: cachedir })))
  assert.equal(reads, 1)
  for (const value of results) assert.deepEqual(value.buffer, results[0].buffer)
})

test('corrupt images and unsupported content never fall back to original bytes', async () => {
  const invalid = await source(Buffer.from('this is not an image'))
  await assert.rejects(thumbnail(invalid.hash, 64, { store: invalid.store, cacheDir: cachedir }), { code: 'PREVIEW_UNAVAILABLE', status: 422 })
  await assert.rejects(thumbnail(invalid.hash, 64, { store: invalid.store, cacheDir: cachedir }), { code: 'PREVIEW_UNAVAILABLE' })
  const svg = await source(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'))
  await assert.rejects(thumbnail(svg.hash, 64, { store: svg.store, cacheDir: cachedir }), { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 })
})

test('source byte ceilings apply to declared size and a dishonest remote stream', async () => {
  let reads = 0
  const oversized = { stat: async () => ({ size: THUMBNAIL_LIMITS.maxSourceBytes + 1 }), get() { reads += 1 } }
  await assert.rejects(previewSource(oversized, 'a'.repeat(64), THUMBNAIL_LIMITS.maxSourceBytes), { code: 'FILE_TOO_LARGE', status: 413 })
  assert.equal(reads, 0)
  const dishonest = { stat: async () => ({ size: 1 }), get: () => Readable.from([Buffer.alloc(20)]) }
  await assert.rejects(previewSource(dishonest, 'b'.repeat(64), 10), { code: 'FILE_TOO_LARGE', status: 413 })
})

test('a compressed image with excessive declared pixels is rejected before decoding', async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } }).png().toBuffer()
  // A forged IHDR represents a decompression bomb without allocating its pixels.
  png.writeUInt32BE(7000, 16)
  png.writeUInt32BE(7000, 20)
  let crc = 0xffffffff
  for (const byte of png.subarray(12, 29)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29)
  const fixture = await source(png)
  await assert.rejects(thumbnail(fixture.hash, 64, { store: fixture.store, cacheDir: cachedir }), { code: 'IMAGE_TOO_LARGE', status: 413 })
})

test('generated cache files hold complete WebP representations and width variants stay separate', async () => {
  const fixture = await source(await sharp({ create: { width: 500, height: 500, channels: 3, background: '#f0a0b0' } }).png().toBuffer())
  for (const width of [32, 160]) {
    const image = await thumbnail(fixture.hash, width, { store: fixture.store, cacheDir: cachedir })
    const saved = await readFile(join(cachedir, fixture.hash + '@' + width + '.webp'))
    assert.deepEqual(saved, image.buffer)
    assert.equal((await sharp(saved).metadata()).width, width)
  }
})

test('a failed cache write still returns a valid downscaled thumbnail', async () => {
  const fixture = await source(await sharp({ create: { width: 300, height: 100, channels: 3, background: '#507030' } }).png().toBuffer())
  const file = join(fixtureDir, 'not-a-directory')
  await writeFile(file, 'occupied')
  const image = await thumbnail(fixture.hash, 80, { store: fixture.store, cacheDir: file })
  assert.equal((await sharp(image.buffer).metadata()).width, 80)
})

test('invalid hashes and unsafe dimensions are rejected before filesystem access', async () => {
  await assert.rejects(thumbnail('../escape', 64), { code: 'INVALID_INPUT', status: 400 })
  for (const width of [0, 1.5, Infinity, 1025]) {
    await assert.rejects(thumbnail('a'.repeat(64), width), { code: 'INVALID_INPUT', status: 400 })
  }
})
