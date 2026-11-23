import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { installFakeDom } from './fake-dom.js'

/**
 * The upload panel's two behavioural promises.
 *
 * A browser check can see that the panel is hidden; it cannot see *why*, and the
 * old bug was exactly a why: every progress tick called show(), so 收起 was
 * undone by the next byte of network traffic. This drives the real panel module
 * against the fake DOM and asserts that only the user re-opens the panel, that a
 * failure reason is real visible text, and that a row in the middle of server
 * finalisation never claims success.
 */

let dom
let createQueuePanel

beforeEach(async () => {
  // The import must come first: `dom = installFakeDom()` immediately followed by
  // a parenthesised assignment would be parsed as a call (ASI does not apply).
  const module = await import('../lib/queue.js')
  createQueuePanel = module.createQueuePanel
  dom = installFakeDom()
})

afterEach(() => {
  delete globalThis.document
  delete globalThis.window
})

/** A task stub with the emitter surface the panel subscribes to. */
function taskOf(overrides) {
  const handlers = new Map()
  const task = {
    id: 't-' + Math.random().toString(36).slice(2, 7),
    name: 'photo.jpg',
    size: 10 * 1024 * 1024,
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

const isOpen = (panel) => !panel.panel.hasAttribute('hidden')
const isFoldVisible = (panel) => !panel.launcher.hasAttribute('hidden')

describe('createQueuePanel: the collapse is the user\'s', () => {
  it('opens when the first task arrives', () => {
    const panel = createQueuePanel({})
    panel.track(taskOf({}))
    assert.equal(isOpen(panel), true)
    assert.equal(isFoldVisible(panel), false)
  })

  it('stays folded through progress and state updates', () => {
    const panel = createQueuePanel({})
    const task = taskOf({})
    panel.track(task)
    // The user folds it.
    panel.fold()
    assert.equal(isOpen(panel), false)
    assert.equal(isFoldVisible(panel), true)

    // The network keeps talking: bytes, then a state change, then more bytes.
    task.state = 'uploading'
    task.progress = 0.4
    task.uploaded = 4 * 1024 * 1024
    task.emit('state', { state: 'uploading' })
    task.emit('progress', { progress: 0.4 })
    task.progress = 0.8
    task.emit('progress', { progress: 0.8 })
    assert.equal(isOpen(panel), false, 'a progress event must not re-open a folded panel')
    assert.equal(isFoldVisible(panel), true)

    // Only the user's click brings it back.
    panel.show()
    assert.equal(isOpen(panel), true)
    assert.equal(isFoldVisible(panel), false)
  })

  it('keeps the batch counts on the folded launcher', () => {
    const panel = createQueuePanel({})
    panel.track(taskOf({ state: 'uploading', progress: 0.5, uploaded: 5 * 1024 * 1024, speed: 1024 * 1024 }))
    panel.fold()
    const text = panel.launcher.querySelector('.qlaunch-text').textContent
    assert.match(text, /已完成 0\/1|1 个进行中/)
  })

  it('folds away entirely when nothing is tracked', () => {
    const panel = createQueuePanel({})
    panel.track(taskOf({}))
    panel.clear()
    assert.equal(isOpen(panel), false)
    assert.equal(isFoldVisible(panel), false)
  })
})

/** The visible action button whose aria-label starts with `word`. */
function action(row, word) {
  const buttons = row.querySelectorAll('.qactions .icon-btn')
  return buttons.find((button) => String(button.getAttribute('aria-label') || '').startsWith(word)) || null
}

describe('createQueuePanel: rows are readable', () => {
  it('shows the failure reason as text, not only a title', () => {
    const panel = createQueuePanel({})
    const task = taskOf({
      state: 'error',
      uploaded: 1024,
      error: { message: '存储配额已满，请清理回收站。' },
    })
    panel.track(task)
    const row = panel.panel.querySelector('.qitem')
    const detail = row.querySelector('.qdetail')
    assert.equal(detail.textContent, '存储配额已满，请清理回收站。')
    assert.equal(row.querySelector('.qstate').textContent, '失败')
    assert.equal(row.querySelector('.qstate').getAttribute('title'), null)
  })

  it('does not call server finalisation 100% or success', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ state: 'finalizing', uploaded: 10 * 1024 * 1024, progress: 1 })
    panel.track(task)
    const row = panel.panel.querySelector('.qitem')
    assert.equal(row.querySelector('.qstate').textContent, '服务端收尾')
    assert.ok(!/成功|100%/.test(row.textContent))
  })

  it('keeps pause and cancel on a live transfer', () => {
    const panel = createQueuePanel({})
    const task = taskOf({ name: 'live.bin', state: 'uploading', progress: 0.2, uploaded: 2 * 1024 * 1024 })
    panel.track(task)
    const row = panel.panel.querySelector('.qitem')
    assert.equal(action(row, '暂停').hasAttribute('hidden'), false)
    assert.equal(action(row, '取消').hasAttribute('hidden'), false)
  })

  it('offers retry on a failure and resume on a pause', () => {
    const panel = createQueuePanel({})
    const failed = taskOf({ name: 'broken.bin', state: 'error', error: { message: '网络中断' } })
    panel.track(failed)
    const failedRow = panel.panel.querySelector('.qitem[data-id="' + failed.id + '"]')
    assert.equal(action(failedRow, '重试').hasAttribute('hidden'), false)

    const parked = taskOf({ name: 'parked.bin', state: 'paused', uploaded: 1024 })
    panel.track(parked)
    const parkedRow = panel.panel.querySelector('.qitem[data-id="' + parked.id + '"]')
    assert.equal(action(parkedRow, '继续').hasAttribute('hidden'), false)
    assert.equal(action(parkedRow, '暂停').hasAttribute('hidden'), true)
  })

  it('announces state changes but never byte progress', () => {
    const panel = createQueuePanel({})
    const task = taskOf({})
    panel.track(task)
    const announce = dom.body.querySelector('.queue-announce')
    task.state = 'uploading'
    task.emit('state', { state: 'uploading' })
    assert.match(announce.textContent, /上传中/)

    // A screen reader must not hear 42%, 43%, 44%… on every progress event.
    announce.textContent = ''
    task.emit('progress', { progress: 0.43 })
    task.emit('progress', { progress: 0.44 })
    assert.equal(announce.textContent, '')
  })

  it('counts a cancellation separately from a failure', () => {
    const panel = createQueuePanel({})
    panel.track(taskOf({ id: 'a', state: 'error', error: { message: '坏了' } }))
    panel.track(taskOf({ id: 'b', state: 'canceled' }))
    const summary = dom.body.querySelector('.qsummary')
    assert.match(summary.textContent, /1 个失败/)
    assert.match(summary.textContent, /1 个已取消/)
  })
})
