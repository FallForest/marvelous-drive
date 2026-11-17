import { CpuTaskError } from '../text/cpu-tasks.js'

/** Capped source reader for non-local stores; called only after CPU admission. */
export async function previewSource(store, hash, maxBytes, signal) {
  if (signal?.aborted) throw new CpuTaskError('TASK_TIMEOUT', 'Preview processing timed out.')
  const info = await store.stat(hash)
  if (!info) throw new CpuTaskError('BLOB_NOT_FOUND', 'The stored content is missing.', 404)
  if (info.size > maxBytes) throw new CpuTaskError('FILE_TOO_LARGE', 'The preview source exceeds its size limit.', 413)
  if (store.name === 'local' && typeof store.path === 'function') return { inputPath: store.path(hash) }
  const stream = store.get(hash)
  const abort = () => stream.destroy(new CpuTaskError('TASK_TIMEOUT', 'Preview processing timed out.'))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const chunks = []
  let size = 0
  try {
    for await (const chunk of stream) {
      size += chunk.length
      if (size > maxBytes) throw new CpuTaskError('FILE_TOO_LARGE', 'The preview source exceeds its size limit.', 413)
      chunks.push(chunk)
    }
    return { input: Buffer.concat(chunks, size) }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!stream.destroyed) stream.destroy()
  }
}
