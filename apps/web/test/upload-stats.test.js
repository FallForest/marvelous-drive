import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aggregateTasks, summaryLabel, formatEta } from '../lib/upload-stats.js'

/** The batch readout above the queue rows. Pure arithmetic, no DOM. */

const MiB = 1024 * 1024

describe('aggregateTasks', () => {
  it('counts bytes across finished, running and queued tasks', () => {
    const stats = aggregateTasks([
      { state: 'done', size: 4 * MiB, uploaded: 4 * MiB },
      { state: 'uploading', size: 10 * MiB, uploaded: 5 * MiB, speed: 1 * MiB },
      { state: 'queued', size: 6 * MiB, uploaded: 0 },
    ])
    assert.equal(stats.files, 3)
    assert.equal(stats.finished, 1)
    assert.equal(stats.running, 1)
    assert.equal(stats.queued, 1)
    assert.equal(stats.active, 2)
    assert.equal(stats.totalBytes, 20 * MiB)
    assert.equal(stats.doneBytes, 9 * MiB)
    assert.equal(stats.remaining, 11 * MiB)
    assert.equal(stats.ratio, (9 * MiB) / (20 * MiB))
    assert.equal(stats.eta, 11)
  })

  it('keeps the bytes a failed upload already delivered', () => {
    const stats = aggregateTasks([
      { state: 'error', size: 8 * MiB, uploaded: 3 * MiB },
      { state: 'uploading', size: 8 * MiB, uploaded: 0, speed: 0 },
    ])
    assert.equal(stats.failed, 1)
    assert.equal(stats.active, 1)
    // The batch bar must not jump backwards because one file died at 37%.
    assert.equal(stats.doneBytes, 3 * MiB)
    assert.equal(stats.remaining, 13 * MiB)
  })

  it('never lets an uploaded count exceed its own size', () => {
    const stats = aggregateTasks([{ state: 'uploading', size: 100, uploaded: 400, speed: 0 }])
    assert.equal(stats.doneBytes, 100)
    assert.equal(stats.ratio, 1)
    assert.equal(stats.remaining, 0)
  })

  it('excludes hashing bytes from the ETA, since they are CPU-bound', () => {
    const stats = aggregateTasks([
      { state: 'uploading', size: 10 * MiB, uploaded: 2 * MiB, speed: 2 * MiB },
      { state: 'hashing', size: 100 * MiB, uploaded: 0 },
    ])
    assert.equal(stats.hashing, 1)
    // 10 MiB of measurable work at 2 MiB/s = 4s, not 54s with hashing folded in.
    assert.equal(stats.eta, 4)
  })

  it('reports no ETA while nothing is moving', () => {
    assert.equal(aggregateTasks([{ state: 'hashing', size: 1024, uploaded: 0 }]).eta, null)
    assert.equal(aggregateTasks([{ state: 'paused', size: 1024, uploaded: 512 }]).eta, null)
    assert.equal(aggregateTasks([]).eta, null)
  })

  it('treats a settled batch of zero-byte files as complete', () => {
    const stats = aggregateTasks([{ state: 'done', size: 0, uploaded: 0 }])
    assert.equal(stats.totalBytes, 0)
    assert.equal(stats.active, 0)
    assert.equal(stats.ratio, 1)
  })

  it('tolerates junk entries', () => {
    const stats = aggregateTasks([null, undefined, {}, { state: 'done', size: 'nope' }])
    assert.equal(stats.files, 2)
    assert.equal(stats.totalBytes, 0)
    assert.equal(stats.finished, 1)
  })
})

describe('summaryLabel', () => {
  it('names the batch while it runs', () => {
    const stats = aggregateTasks([
      { state: 'done', size: 1, uploaded: 1 },
      { state: 'uploading', size: 1, uploaded: 0, speed: 0 },
    ])
    assert.equal(summaryLabel(stats), '已完成 1/2')
  })

  it('collapses to a plain count once everything settled', () => {
    assert.equal(summaryLabel(aggregateTasks([{ state: 'done', size: 1 }])), '1 个已完成')
    assert.equal(summaryLabel(aggregateTasks([{ state: 'done', size: 1 }, { state: 'error', size: 1 }])), '1 个已完成 · 1 个失败')
    assert.equal(summaryLabel(aggregateTasks([])), '0 个任务')
  })

  it('stays quiet for a single file, whose row already says everything', () => {
    assert.equal(summaryLabel(aggregateTasks([{ state: 'uploading', size: 9, uploaded: 3, speed: 0 }])), '1 个进行中')
  })
})

describe('formatEta', () => {
  it('speaks in seconds under a minute and in minutes above it', () => {
    assert.equal(formatEta(8), '剩余 8s')
    assert.equal(formatEta(80), '剩余 1 分 20 秒')
    assert.equal(formatEta(120), '剩余 2 分')
    assert.equal(formatEta(3700), '剩余 1 小时 1 分')
  })

  it('returns nothing for a non-answer', () => {
    assert.equal(formatEta(null), '')
    assert.equal(formatEta(0), '')
    assert.equal(formatEta(-5), '')
  })
})
