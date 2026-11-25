import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { installFakeDom } from './fake-dom.js'

/**
 * Hashing is a stage, not a percentage the client may invent.
 *
 * The transport reports `task.hashBytes` only once it has really read bytes; until
 * then the row must stay busy (an indeterminate bar), and the moment the network
 * starts the bar and the line must go back to the real transfer numbers. These
 * tests drive the real panel against the fake DOM so the guard is on the DOM the
 * user sees, not on a re-implementation.
 */

const MiB = 1024 * 1024

let createQueuePanel
let hashStageProgress
let taskRowStatus
let bytes

beforeEach(async () => {
  // Import before installing the fake DOM: queue.js builds nothing at import
  // time, but the module graph must not be re-evaluated per test.
  const queue = await import('../lib/queue.js')
  const stats = await import('../lib/upload-stats.js')
  const format = await import('../lib/format.js')
  createQueuePanel = queue.createQueuePanel
  hashStageProgress = stats.hashStageProgress
  taskRowStatus = stats.taskRowStatus
  bytes = format.bytes
  installFakeDom()
})

afterEach(() => {
  delete globalThis.document
  delete globalThis.window
})

/** A task stub with the emitter surface the panel subscribes to. */
function taskOf(overrides) {
  const handlers = new Map()
  const task = {
    id: 'h-' + Math.random().toString(36).slice(2, 7),
    name: 'video.mp4',
    size: 10 * MiB,
    state: 'queued',
    progress: 0,
    uploaded: 0,
    speed: 0,
    error: null,
    ...overrides,
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type).add(handler)
      return () => handlers.get(type).delete(handler)
    },
    emit(type, payload) {
      for (const handler of handlers.get(type) || []) handler(payload)
    },
    retry() { return Promise.resolve(null) },
    pause() { return true },
    resume() { return Promise.resolve(null) },
    cancel() {},
  }
  return task
}

/** The transfer bar (the determinate one the row always carries). */
const transferBar = (row) => row.querySelector('.qbar')
/** The native indeterminate <progress> reused verbatim from the preparation row. */
const busyBar = (row) => row.querySelector('progress.qbar-prep-busy')

describe('the stylesheet already paints an indeterminate bar', () => {
  // The row reuses .qbar-prep-busy rather than introducing a second look (and a
  // second dependency-free CSS block) for "hashing, no honest number yet".
  it('keeps the prep-row indeterminate element style in app.css', () => {
    const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8')
    assert.match(css, /\.qbar-prep-busy\{/)
    assert.match(css, /\.qbar-prep-busy\[hidden\]\{display:none\}/)
  })
})

describe('hashStageProgress', () => {
  it('reads real hashed bytes against the file size', () => {
    const stage = hashStageProgress({ state: 'hashing', size: 10 * MiB, hashBytes: 4 * MiB })
    assert.equal(stage.known, true)
    assert.equal(stage.hashed, 4 * MiB)
    assert.equal(stage.size, 10 * MiB)
    assert.equal(stage.ratio, 0.4)
    assert.equal(stage.pct, 40)
  })

  it('does not round up to 100% before every byte has been read', () => {
    const stage = hashStageProgress({ state: 'hashing', size: 1000, hashBytes: 999 })
    assert.equal(stage.known, true)
    assert.equal(stage.pct, 99)
    assert.equal(hashStageProgress({ state: 'hashing', size: 1000, hashBytes: 1000 }).pct, 100)
  })

  it('clamps a report that overshoots the file size', () => {
    const stage = hashStageProgress({ state: 'hashing', size: 100, hashBytes: 400 })
    assert.equal(stage.hashed, 100)
    assert.equal(stage.pct, 100)
  })

  it('is unknown, not 0%, until a real byte count arrives', () => {
    for (const hashBytes of [null, undefined, '', 'nope', NaN]) {
      const stage = hashStageProgress({ state: 'hashing', size: 100, hashBytes })
      assert.equal(stage.known, false, 'hashBytes=' + String(hashBytes))
      assert.equal(stage.pct, null)
      assert.equal(stage.ratio, null)
    }
  })

  it('has no percentage for an empty file or a missing size', () => {
    assert.equal(hashStageProgress({ state: 'hashing', size: 0, hashBytes: 0 }).known, false)
    assert.equal(hashStageProgress({ state: 'hashing', hashBytes: 0 }).known, false)
    assert.equal(hashStageProgress({ state: 'hashing', size: -5, hashBytes: 0 }).known, false)
  })

  it('only answers while the task is hashing', () => {
    assert.equal(hashStageProgress({ state: 'uploading', size: 100, hashBytes: 50 }), null)
    assert.equal(hashStageProgress({ state: 'queued', size: 100, hashBytes: 0 }), null)
    assert.equal(hashStageProgress(null), null)
  })
})

describe('taskRowStatus: the hashing line is its own sentence', () => {
  it('accepts a real zero report as 0%, unlike a missing one', () => {
    const status = taskRowStatus({ state: 'hashing', size: 10 * MiB, hashBytes: 0 })
    assert.equal(status.detail, '0% · ' + bytes(0) + ' / ' + bytes(10 * MiB))
  })

  it('shows an honest percentage and hashed / total bytes', () => {
    const status = taskRowStatus({ state: 'hashing', size: 10 * MiB, hashBytes: 4 * MiB, progress: 0.9, uploaded: 9 * MiB })
    assert.equal(status.label, '校验中')
    assert.notEqual(status.label, '上传中')
    assert.equal(status.detail, '40% · ' + bytes(4 * MiB) + ' / ' + bytes(10 * MiB))
    // Transfer numbers belong to the network stage and must not leak in here.
    assert.ok(!status.detail.includes(bytes(9 * MiB)), 'hashing must not read network bytes')
  })

  it('stays honest when the transport has not reported yet', () => {
    const status = taskRowStatus({ state: 'hashing', size: 10 * MiB, hashBytes: null })
    assert.equal(status.label, '校验中')
    assert.ok(!/\d+%/.test(status.detail), 'no invented percentage: ' + status.detail)
    assert.ok(!status.detail.includes('/'), 'no invented byte ratio: ' + status.detail)
  })

  it('keeps uploading on the real network numbers', () => {
    const status = taskRowStatus({ state: 'uploading', size: 10 * MiB, uploaded: 6 * MiB, hashBytes: 10 * MiB, speed: 0 })
    assert.equal(status.label, '上传中')
    assert.equal(status.detail, bytes(6 * MiB) + ' / ' + bytes(10 * MiB))
  })
})

describe('createQueuePanel: the row switches meters with the stage', () => {
  const rowOf = (panel, task) => panel.panel.querySelector('.qitem[data-id="' + task.id + '"]')

  it('draws real hashing progress on the row bar and in the line', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ state: 'hashing', hashBytes: 4 * MiB })
    panel.track(task)
    const row = rowOf(panel, task)
    assert.equal(row.querySelector('.qstate').textContent, '校验中')
    assert.equal(row.querySelector('.qdetail').textContent, '40% · ' + bytes(4 * MiB) + ' / ' + bytes(10 * MiB))
    assert.equal(transferBar(row).hasAttribute('hidden'), false)
    assert.equal(transferBar(row).getAttribute('aria-valuenow'), '40')
    assert.match(transferBar(row).getAttribute('aria-label'), /校验进度/)
    assert.equal(busyBar(row).hasAttribute('hidden'), true)
  })

  it('uses the indeterminate bar, not a fake 0%, while hashBytes is unknown', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ state: 'hashing', hashBytes: null })
    panel.track(task)
    const row = rowOf(panel, task)
    const busy = busyBar(row)
    assert.equal(busy.hasAttribute('hidden'), false, 'indeterminate bar must be visible')
    // No value attribute at all: assistive tech reports busy, not a percentage.
    assert.equal(busy.hasAttribute('value'), false)
    assert.equal(busy.hasAttribute('aria-valuenow'), false)
    assert.match(busy.getAttribute('aria-label'), /校验进度/)
    assert.equal(transferBar(row).hasAttribute('hidden'), true, 'the determinate bar steps aside')
    assert.equal(row.querySelector('.qdetail').textContent, '正在读取文件内容')
    assert.ok(!/\d+%/.test(row.textContent), 'the line must not claim a percentage: ' + row.textContent)
  })

  it('stays graceful for a zero-byte file', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ name: 'empty.txt', size: 0, state: 'hashing', hashBytes: 0 })
    panel.track(task)
    const row = rowOf(panel, task)
    assert.equal(busyBar(row).hasAttribute('hidden'), false)
    assert.ok(!/\d+%/.test(row.textContent))
  })

  it('updates the bar from a hash report without touching the network count', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ state: 'hashing', hashBytes: null })
    panel.track(task)
    task.hashBytes = 5 * MiB
    task.emit('hash-progress', { task, loaded: 5 * MiB, total: 10 * MiB })
    const row = rowOf(panel, task)
    assert.equal(transferBar(row).getAttribute('aria-valuenow'), '50')
    // The aggregate reads transfer bytes only; hashing must not move them.
    assert.equal(task.uploaded, 0)
    assert.equal(task.progress, 0)
  })

  it('also repaints from a hashing tick that arrives on the progress event', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ state: 'hashing', hashBytes: null })
    panel.track(task)
    // The transport publishes the same numbers on `progress` with the transfer
    // fields passed through unchanged: the row must read the hash stage either way.
    task.hashBytes = 7 * MiB
    task.emit('progress', { task, phase: 'hashing', hashBytes: 7 * MiB, loaded: 0, total: 10 * MiB, progress: 0 })
    const row = rowOf(panel, task)
    assert.equal(transferBar(row).getAttribute('aria-valuenow'), '70')
    assert.equal(row.querySelector('.qdetail').textContent, '70% · ' + bytes(7 * MiB) + ' / ' + bytes(10 * MiB))
    assert.equal(task.uploaded, 0)
    assert.equal(task.progress, 0)
  })

  it('switches back to network progress when uploading starts', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ state: 'hashing', hashBytes: null })
    panel.track(task)
    task.state = 'uploading'
    task.progress = 0.3
    task.uploaded = 3 * MiB
    task.speed = 0
    task.emit('state', { state: 'uploading' })
    const row = rowOf(panel, task)
    assert.equal(row.querySelector('.qstate').textContent, '上传中')
    assert.equal(row.querySelector('.qdetail').textContent, bytes(3 * MiB) + ' / ' + bytes(10 * MiB))
    assert.equal(transferBar(row).hasAttribute('hidden'), false)
    assert.equal(transferBar(row).getAttribute('aria-valuenow'), '30')
    assert.equal(transferBar(row).getAttribute('aria-valuetext'), null)
    assert.match(transferBar(row).getAttribute('aria-label'), /上传进度/)
    assert.equal(busyBar(row).hasAttribute('hidden'), true)
  })

  it('leaves a history record without hashBytes read-only and determinate', () => {
    const panel = createQueuePanel({})
    panel.trackHistory([{ name: 'old.bin', size: 2048, state: 'done', at: '2026-01-01T00:00:00.000Z' }])
    const row = panel.panel.querySelector('.qitem')
    assert.ok(row, 'history row must render')
    assert.equal(busyBar(row).hasAttribute('hidden'), true)
    assert.equal(transferBar(row).getAttribute('aria-valuenow'), '100')
  })

  it('gives a server-resume row its transfer bar only, with no hash field anywhere', () => {
    const panel = createQueuePanel({})
    panel.trackResumable({ session: { id: 's1', name: 'partial.bin', size: 4 * MiB }, ratio: 0.5 })
    const row = panel.panel.querySelector('.qitem.is-resumable')
    assert.ok(row, 'resumable row must render')
    assert.equal(busyBar(row), null, 'a resumable row is not a hashing row')
    assert.equal(transferBar(row).getAttribute('aria-valuenow'), '50')
  })
})
