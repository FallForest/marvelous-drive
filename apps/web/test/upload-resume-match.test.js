import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchSessions, receivedBytes, resumeKey, resumeLabel } from '../lib/upload-resume.js'

/**
 * Matching a page load's leftovers against the server's live sessions.
 *
 * The whole point of this module is that a refresh must not lose a 4 GB upload,
 * and the only thing that makes that safe is refusing to match bytes that are
 * not provably the same bytes.
 */

const record = (over) => ({ name: 'a.bin', size: 100, lastModified: 5, at: '2026-01-01T00:00:00Z', ...over })
const session = (over) => ({ id: 's1', name: 'a.bin', size: 100, sha256: 'h', chunkSize: 10, receivedChunks: [], ...over })

describe('resumeKey', () => {
  it('is stable for the same file and different across files', () => {
    assert.equal(resumeKey({ name: 'a.bin', size: 10, lastModified: 1 }), 'a.bin:10:1')
    assert.notEqual(
      resumeKey({ name: 'a.bin', size: 10, lastModified: 1 }),
      resumeKey({ name: 'a.bin', size: 10, lastModified: 2 }),
    )
    assert.equal(resumeKey(null), '')
  })
})

describe('receivedBytes', () => {
  it('counts full chunks and a short last chunk', () => {
    assert.equal(receivedBytes({ size: 100, chunkSize: 10, receivedChunks: [0, 1, 2] }), 30)
    // 25 bytes: chunks are 10,10,5 — the third one must not count as 10.
    assert.equal(receivedBytes({ size: 25, chunkSize: 10, receivedChunks: [0, 1, 2] }), 25)
  })

  it('never exceeds the file size and tolerates junk', () => {
    assert.equal(receivedBytes({ size: 10, chunkSize: 10, receivedChunks: [0, 5, 9] }), 10)
    assert.equal(receivedBytes(null), 0)
    assert.equal(receivedBytes({ size: 0, chunkSize: 0, receivedChunks: [0] }), 0)
  })
})

describe('resumeLabel', () => {
  it('reports the percentage already stored', () => {
    assert.equal(resumeLabel({ size: 100, chunkSize: 10, receivedChunks: [0, 1, 2, 3, 4, 5] }), '可继续 · 已传 60%')
    assert.equal(resumeLabel({ size: 100, chunkSize: 10, receivedChunks: [] }), '可继续')
  })
})

describe('matchSessions', () => {
  it('pairs a stored handle with the session the server still holds', () => {
    const matched = matchSessions([session({ sha256: 'h' })], [record({ sha256: 'h' })])
    assert.equal(matched.length, 1)
    assert.equal(matched[0].session.id, 's1')
  })

  it('refuses a session whose name and size agree but whose bytes do not', () => {
    // Two different videos, same length: exactly the case a name+size match
    // would get wrong.
    const matched = matchSessions([session({ sha256: 'other' })], [record({ sha256: 'h' })])
    assert.deepEqual(matched, [])
  })

  it('tolerates a missing hash on either side', () => {
    assert.equal(matchSessions([session({ sha256: null })], [record({ sha256: 'h' })]).length, 1)
    assert.equal(matchSessions([session({ sha256: 'h' })], [record({ sha256: undefined })]).length, 1)
  })

  it('uses each session once and ignores records without a session', () => {
    const matched = matchSessions(
      [session({ id: 's1', sha256: 'h' })],
      [record({ sha256: 'h' }), record({ sha256: 'h' })],
    )
    assert.equal(matched.length, 1)
    assert.equal(matchSessions([], [record({})]).length, 0)
    assert.deepEqual(matchSessions(null, null), [])
  })

  it('does not pair a session of a different size', () => {
    assert.deepEqual(matchSessions([session({ size: 101, sha256: 'h' })], [record({ sha256: 'h' })]), [])
  })
})
