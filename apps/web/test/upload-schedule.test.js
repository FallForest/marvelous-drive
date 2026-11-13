import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createUploadScheduler, etaSeconds, transferLabel, UPLOAD_CONCURRENCY } from '../lib/upload.js'
import { sanitizeHistory, splitHistory, summarizeTask } from '../lib/upload-queue.js'

/** The pure scheduling / bookkeeping half of the uploader (no DOM, no HTTP). */

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A task stub: the scheduler only reads state and starts it. */
function taskStub(state) {
  return { state: state || 'queued', startCalled: 0 }
}

describe('createUploadScheduler', () => {
  it('starts at most the concurrency limit in one round', async () => {
    const gates = new Map()
    const started = []
    const scheduler = createUploadScheduler({
      limit: 3,
      start: (task) => {
        started.push(task)
        const gate = deferred()
        gates.set(task, gate)
        return gate.promise
      },
    })
    const tasks = Array.from({ length: 7 }, () => taskStub())
    scheduler.addAll(tasks)
    await flush()

    assert.equal(scheduler.limit, UPLOAD_CONCURRENCY)
    assert.equal(scheduler.activeCount, 3)
    assert.equal(scheduler.pendingCount, 4)
    assert.deepEqual(started.map((task) => tasks.indexOf(task)), [0, 1, 2])

    // Finishing one task frees exactly one slot.
    tasks[0].state = 'done'
    gates.get(tasks[0]).resolve()
    await flush()
    assert.equal(scheduler.activeCount, 3)
    assert.deepEqual(started.map((task) => tasks.indexOf(task)), [0, 1, 2, 3])

    // Drain everything; the loop never exceeded the limit.
    while (started.length < tasks.length) {
      for (const task of tasks) {
        const gate = gates.get(task)
        if (gate && !task.settled) { task.state = 'done'; task.settled = true; gate.resolve() }
      }
      await flush()
    }
    for (const task of tasks) {
      const gate = gates.get(task)
      if (gate && !task.settled) { task.state = 'done'; gate.resolve() }
    }
    await scheduler.whenIdle()
    assert.equal(scheduler.activeCount, 0)
    assert.equal(started.length, 7)
  })

  it('does not start the rest of the queue when one task fails', async () => {
    const outcome = []
    const scheduler = createUploadScheduler({
      limit: 2,
      start: async (task) => {
        outcome.push(task.id)
        if (task.id === 'b') throw new Error('boom')
        return 'ok'
      },
    })
    const a = { id: 'a', state: 'queued' }
    const b = { id: 'b', state: 'queued' }
    const c = { id: 'c', state: 'queued' }
    scheduler.add(a)
    scheduler.add(b)
    scheduler.add(c)
    await scheduler.whenIdle()
    assert.deepEqual(outcome, ['a', 'b', 'c'])
    assert.equal(scheduler.activeCount, 0)
  })

  it('pauses the running task, parks it and restarts it on resume', async () => {
    const gates = []
    const started = []
    const scheduler = createUploadScheduler({
      limit: 1,
      start: (task) => {
        started.push(task.id)
        const gate = deferred()
        gates.push(gate)
        return gate.promise
      },
    })
    const running = { id: 'a', state: 'queued', pause() { this.state = 'paused' } };
    const waiting = { id: 'b', state: 'queued' };
    scheduler.add(running)
    scheduler.add(waiting)
    await flush()
    assert.deepEqual(started, ['a'])
    assert.equal(scheduler.activeCount, 1)

    scheduler.pause()
    assert.equal(scheduler.paused, true)
    assert.equal(running.state, 'paused')
    gates[0].resolve()
    await flush()
    // Parked, not finished: while paused nothing new may start.
    assert.deepEqual(started, ['a'])
    assert.equal(scheduler.activeCount, 0)

    scheduler.resume()
    await flush()
    // The paused task goes back in front of the queue: it restarts first.
    assert.deepEqual(started, ['a', 'a'])
    assert.equal(scheduler.paused, false)

    running.state = 'done'          // this time it finishes
    gates[1].resolve()
    await flush()
    assert.deepEqual(started, ['a', 'a', 'b'])
  })
})

describe('transferLabel / etaSeconds', () => {
  it('shows speed and remaining time while bytes move', () => {
    const task = { size: 10 * 1024 * 1024, uploaded: 6 * 1024 * 1024, speed: 1024 * 1024, progress: 0.6 }
    assert.equal(etaSeconds(4 * 1024 * 1024, 1024 * 1024), 4)
    assert.equal(transferLabel(task), '1.0 MB/s · 剩余 4s')
  })

  it('falls back to the percentage when there is no speed yet', () => {
    assert.equal(etaSeconds(1000, 0), null)
    assert.equal(transferLabel({ size: 100, uploaded: 42, speed: 0, progress: 0.42 }), '42%')
  })

  it('never reports a zero or negative ETA for moving bytes', () => {
    assert.equal(etaSeconds(10, 1024), 1)
    assert.equal(etaSeconds(0, 1024), 0)
  })
})

describe('upload history records', () => {
  it('summarises a finished task and marks a running one as interrupted', () => {
    const done = summarizeTask({
      name: 'a.bin', size: 9, parentId: 'p', sessionId: 's', state: 'done', deduplicated: true,
    })
    assert.equal(done.name, 'a.bin')
    assert.equal(done.state, 'done')
    assert.equal(done.sessionId, 's')
    assert.equal(done.deduplicated, true)
    assert.ok(done.at)

    const live = summarizeTask({ name: 'b.bin', size: 4, state: 'uploading' })
    assert.equal(live.state, 'interrupted')
  })

  it('drops malformed rows and keeps the newest entries only', () => {
    const rows = [
      { name: 'keep-1', size: 1, state: 'done' },
      { name: '', size: 1, state: 'done' },
      null,
      { name: 'bad-state', size: 1, state: 'whatever' },
      { name: 'keep-2', size: 2, state: 'canceled', sessionId: 's2' },
    ]
    const clean = sanitizeHistory(rows, 5)
    assert.deepEqual(clean.map((row) => row.name), ['keep-1', 'keep-2'])
    assert.equal(clean[1].sessionId, 's2')
    assert.equal(sanitizeHistory(rows, 1).length, 1)
  })

  it('separates restorable history from uploads that were cut off', () => {
    const split = splitHistory([
      { name: 'a', state: 'done' },
      { name: 'b', state: 'error' },
      { name: 'c', state: 'interrupted' },
    ])
    assert.deepEqual(split.history.map((row) => row.name), ['a', 'b'])
    assert.deepEqual(split.interrupted.map((row) => row.name), ['c'])
  })
})
