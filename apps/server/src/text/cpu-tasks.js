import { Worker } from 'node:worker_threads'

/** Parsing and transcoding share a small, bounded budget, including input reads. */
const CPU_LIMITS = Object.freeze({ concurrency: 2, maxQueued: 32, timeoutMs: 30000 })

export class CpuTaskError extends Error {
  constructor(code, message, status = 503) {
    super(message)
    this.name = 'CpuTaskError'
    this.code = code
    this.status = status
  }
}

/**
 * Each active job owns one worker. Workers exit after one operation, so idle
 * workers neither hold the process open nor retain a decoder's native memory.
 * `prepare(signal)` runs only after admission: remote blobs cannot accumulate
 * in memory while their decodes are still waiting for a worker slot.
 */
export function createCpuTaskQueue({ concurrency = CPU_LIMITS.concurrency, maxQueued = CPU_LIMITS.maxQueued,
  timeoutMs = CPU_LIMITS.timeoutMs } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueued) || maxQueued < 0
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid CPU queue limits.')
  const pending = []
  const active = new Set()
  let closed = false

  function pump() {
    while (!closed && active.size < concurrency && pending.length) start(pending.shift())
  }

  function start(job) {
    active.add(job)
    const controller = new AbortController()
    let worker = null
    let done = false
    let timer
    job.finish = async (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      controller.abort()
      // Wait for termination before reusing the slot. A timed-out native decode
      // must not overlap a new decode outside the configured concurrency budget.
      if (worker) await worker.terminate().catch(() => {})
      active.delete(job)
      if (error) job.reject(error)
      else job.resolve(value)
      pump()
    }
    timer = setTimeout(() => void job.finish(new CpuTaskError('TASK_TIMEOUT', 'Preview processing timed out.')), timeoutMs)
    Promise.resolve().then(() => typeof job.prepare === 'function' ? job.prepare(controller.signal) : job.prepare)
      .then((payload) => {
        if (done) return
        worker = new Worker(new URL('./cpu-worker.js', import.meta.url), {
          workerData: { kind: job.kind, payload },
          // Bound JavaScript parser memory independently of the native codec's
          // pixel/input limits. Native memory is released when the worker exits.
          resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
        })
        worker.once('message', (message) => {
          if (message.error) {
            const { code, message: detail, status } = message.error
            void job.finish(new CpuTaskError(code || 'PREVIEW_UNAVAILABLE', detail, status || 422))
          } else void job.finish(null, message.value)
        })
        worker.once('error', () => void job.finish(new CpuTaskError('PREVIEW_UNAVAILABLE', 'The document or image could not be processed.', 422)))
        worker.once('exit', () => {
          if (!done) void job.finish(new CpuTaskError('PREVIEW_UNAVAILABLE', 'The preview worker stopped before producing a result.', 422))
        })
      })
      .catch((error) => void job.finish(error))
  }

  return {
    run(kind, prepare) {
      if (closed) return Promise.reject(new CpuTaskError('PROCESSOR_CLOSED', 'Preview processing has stopped.'))
      if (active.size >= concurrency && pending.length >= maxQueued) {
        return Promise.reject(new CpuTaskError('PREVIEW_BUSY', 'Preview processing is busy. Try again shortly.'))
      }
      const promise = new Promise((resolve, reject) => pending.push({ kind, prepare, resolve, reject }))
      pump()
      return promise
    },
    async close() {
      closed = true
      const error = new CpuTaskError('PROCESSOR_CLOSED', 'Preview processing has stopped.')
      for (const job of pending.splice(0)) job.reject(error)
      await Promise.all([...active].map((job) => job.finish(error)))
    },
  }
}

const processor = createCpuTaskQueue()

export const runCpuTask = (kind, prepare) => processor.run(kind, prepare)