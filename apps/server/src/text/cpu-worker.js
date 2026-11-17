import { parentPort, workerData } from 'node:worker_threads'
import { readFile, stat } from 'node:fs/promises'

const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_PIXELS = 40 * 1000 * 1000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const rejectInput = (code, message, status = 422) => Object.assign(new Error(message), { code, status })

async function inputBytes(payload) {
  if (payload.inputPath) {
    const info = await stat(payload.inputPath).catch(() => null)
    if (!info) throw rejectInput('BLOB_NOT_FOUND', 'The stored content is missing.', 404)
    if (info.size > MAX_SOURCE_BYTES) throw rejectInput('FILE_TOO_LARGE', 'Preview source exceeds 64 MiB.', 413)
    return readFile(payload.inputPath)
  }
  const input = Buffer.from(payload.input || [])
  if (input.length > MAX_SOURCE_BYTES) throw rejectInput('FILE_TOO_LARGE', 'Preview source exceeds 64 MiB.', 413)
  return input
}

async function imageThumbnail(payload) {
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch {
    throw rejectInput('DECODER_UNAVAILABLE', 'This deployment has no image thumbnail decoder installed.', 503)
  }
  sharp.cache(false)
  sharp.concurrency(1)
  const input = await inputBytes(payload)
  const image = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false })
  const metadata = await image.metadata()
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw rejectInput('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and WebP thumbnails are supported.', 415)
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) {
    throw rejectInput('IMAGE_TOO_LARGE', 'The image exceeds the thumbnail pixel limit.', 413)
  }
  const result = await image.rotate()
    .resize({ width: payload.width, height: payload.width, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75, effort: 3 })
    .toBuffer({ resolveWithObject: true })
  if (result.data.length > MAX_OUTPUT_BYTES) throw rejectInput('IMAGE_TOO_LARGE', 'The thumbnail output exceeds its size limit.', 413)
  return { buffer: result.data, width: result.info.width, height: result.info.height }
}

/** Pure worker dispatcher, also imported by tests to validate malformed jobs. */
export async function processCpuTask(kind, payload) {
  if (kind === 'thumbnail') return imageThumbnail(payload)
  const input = await inputBytes(payload)
  if (kind === 'office') {
    const { extractOffice } = await import('./office.js')
    return extractOffice(input, payload.kind)
  }
  if (kind === 'office-text' || kind === 'pdf-text') {
    const { officeText, pdfText } = await import('./office-text.js')
    return kind === 'office-text' ? officeText(input, payload.name, payload.mime) : pdfText(input, payload.name, payload.mime)
  }
  throw rejectInput('INVALID_TASK', 'Unknown preview processing task.', 400)
}

if (parentPort) {
  processCpuTask(workerData.kind, workerData.payload).then(
    (value) => parentPort.postMessage({ value }),
    (error) => {
      const publicCodes = new Set(['NOT_OFFICE', 'PREVIEW_UNAVAILABLE', 'UNSUPPORTED_MEDIA_TYPE', 'FILE_TOO_LARGE',
        'IMAGE_TOO_LARGE', 'BLOB_NOT_FOUND', 'DECODER_UNAVAILABLE', 'INVALID_TASK'])
      let code = publicCodes.has(error.code) ? error.code : 'PREVIEW_UNAVAILABLE'
      let message = publicCodes.has(error.code) ? error.message : 'The document or image could not be processed.'
      let status = error.status || 422
      if (/exceeds pixel limit/i.test(error.message || '')) {
        code = 'IMAGE_TOO_LARGE'; message = 'The image exceeds the thumbnail pixel limit.'; status = 413
      }
      if (error.code === 'ENOENT') {
        code = 'BLOB_NOT_FOUND'; message = 'The stored content is missing.'; status = 404
      }
      parentPort.postMessage({ error: { code, message, status } })
    },
  )
}
