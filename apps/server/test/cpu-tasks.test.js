import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCpuTaskQueue } from '../src/text/cpu-tasks.js'
import { processCpuTask } from '../src/text/cpu-worker.js'

test('CPU admission bounds source reads and rejects excess waiters', async () => {
  const queue = createCpuTaskQueue({ concurrency: 1, maxQueued: 1, timeoutMs: 5000 })
  let release
  let prepared = 0
  const gate = new Promise((resolve) => { release = resolve })
  const prepare = async () => { prepared += 1; await gate; return { input: Buffer.alloc(0) } }
  const first = assert.rejects(queue.run('unknown', prepare), { code: 'INVALID_TASK' })
  const second = assert.rejects(queue.run('unknown', prepare), { code: 'INVALID_TASK' })
  await assert.rejects(queue.run('unknown', prepare), { code: 'PREVIEW_BUSY', status: 503 })
  await Promise.resolve()
  assert.equal(prepared, 1, 'waiting jobs must not read remote blobs before admission')
  release()
  await Promise.all([first, second])
  assert.equal(prepared, 2)
  await queue.close()
})

test('a timed-out source read receives abort and its successor can run', async () => {
  const queue = createCpuTaskQueue({ concurrency: 1, maxQueued: 1, timeoutMs: 1000 })
  let aborted = false
  const first = assert.rejects(queue.run('unknown', (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ input: Buffer.alloc(0) }) }, { once: true })
  })), { code: 'TASK_TIMEOUT' })
  const second = assert.rejects(queue.run('unknown', { input: Buffer.alloc(0) }), { code: 'INVALID_TASK' })
  await Promise.all([first, second])
  assert.equal(aborted, true)
  await queue.close()
})

test('closing a queue aborts in-flight preparation and rejects waiting jobs', async () => {
  const queue = createCpuTaskQueue({ concurrency: 1, maxQueued: 1 })
  let signal
  const active = assert.rejects(queue.run('unknown', (value) => { signal = value; return new Promise(() => {}) }), { code: 'PROCESSOR_CLOSED' })
  const pending = assert.rejects(queue.run('unknown', { input: Buffer.alloc(0) }), { code: 'PROCESSOR_CLOSED' })
  await Promise.resolve()
  await queue.close()
  await Promise.all([active, pending])
  assert.equal(signal.aborted, true)
  await assert.rejects(queue.run('unknown', {}), { code: 'PROCESSOR_CLOSED' })
})

test('worker dispatch does not accept arbitrary operation names', async () => {
  await assert.rejects(processCpuTask('unknown', { input: Buffer.alloc(0) }), { code: 'INVALID_TASK', status: 400 })
})
