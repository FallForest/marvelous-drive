import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PREVIEW_LONG_EDGE, PREVIEW_MIN_EDGE, pixelBudget, fitSize, isSmallEnough,
  capFor, needsRecap, recapFor,
} from '../lib/image-fit.js'

/**
 * Decoding size is a memory decision. Getting it wrong is invisible in a small
 * test fixture and fatal on a folder of 24 MP photos, so every branch of the
 * clamp is pinned here.
 */

describe('pixelBudget', () => {
  it('scales with the platform texture limit', () => {
    assert.equal(pixelBudget(16384), 16 * 1024 * 1024)
    assert.equal(pixelBudget(8192), 10 * 1024 * 1024)
    assert.equal(pixelBudget(4096), 4 * 1024 * 1024)
  })

  it('falls back to the smallest tier when it knows nothing', () => {
    assert.equal(pixelBudget(undefined), 4 * 1024 * 1024)
    assert.equal(pixelBudget(Number.NaN), 4 * 1024 * 1024)
  })
})

describe('fitSize', () => {
  const budget = 16 * 1024 * 1024

  it('never upscales a small picture', () => {
    const fit = fitSize(400, 300, 560, 800, { dpr: 2, pixelBudget: budget })
    assert.equal(fit.width, 400)
    assert.equal(fit.height, 300)
    assert.equal(fit.scale, 1)
  })

  it('fits a landscape photo to the drawer WIDTH, not its height', () => {
    // The regression this pins: sizing by "the box's longest side" decoded a
    // 6000x4000 photo to 1600px wide in a 559px drawer — 2.4x the pixels that
    // can ever be shown. Contain-fit uses the width, because that is the limit.
    const fit = fitSize(6000, 4000, 560, 800, { dpr: 2, pixelBudget: budget })
    assert.equal(fit.width, 1120)
    assert.equal(fit.height, 747)
    assert.ok(fit.width <= 560 * 2)
    assert.ok(fit.width * fit.height < 1600 * 1067)
  })

  it('fits a portrait photo to the drawer height', () => {
    const fit = fitSize(4000, 6000, 560, 800, { dpr: 2, pixelBudget: budget })
    assert.equal(fit.height, 1600)
    assert.equal(fit.width, 1067)
  })

  it('never exceeds the long-edge cap even in a huge box', () => {
    const fit = fitSize(9000, 6000, 4000, 3000, { dpr: 2, pixelBudget: budget })
    assert.equal(fit.width, PREVIEW_LONG_EDGE)
  })

  it('applies the pixel budget on top of the long-edge cap', () => {
    // 12000x12000 = 144 MP: the long edge would allow 1600, but 1600^2 = 2.5 MP
    // is inside a 16 MP budget, so the cap wins. Use a tiny budget to prove the
    // second clamp exists and runs.
    const fit = fitSize(12000, 12000, 560, 800, { dpr: 2, pixelBudget: 1_000_000 })
    assert.ok(fit.width * fit.height <= 1_000_000 + 2000)
    assert.ok(fit.scale < 0.1)
  })

  it('respects a narrow box instead of guessing 1600', () => {
    const fit = fitSize(4000, 3000, 300, 300, { dpr: 1, pixelBudget: budget })
    assert.equal(Math.max(fit.width, fit.height), PREVIEW_MIN_EDGE)
  })

  it('never goes below the minimum edge for a thumbnail-sized box', () => {
    const fit = fitSize(4000, 3000, 20, 20, { dpr: 1, pixelBudget: budget })
    assert.equal(Math.max(fit.width, fit.height), PREVIEW_MIN_EDGE)
  })

  it('asks for the box at DPR when the source size is unknown', () => {
    const fit = fitSize(0, 0, 560, 800, { dpr: 2, pixelBudget: budget })
    assert.equal(fit.width, 1120)
    assert.equal(fit.height, 1600)
  })

  it('clamps the unknown-size case to the long edge cap', () => {
    const fit = fitSize(0, 0, 4000, 4000, { dpr: 3, pixelBudget: budget })
    assert.equal(fit.width, PREVIEW_LONG_EDGE)
    assert.equal(fit.height, PREVIEW_LONG_EDGE)
  })

  it('treats a zero dpr as 1', () => {
    const fit = fitSize(4000, 3000, 800, 600, { dpr: 0, pixelBudget: budget })
    assert.equal(fit.width, 800)
  })

  it('exposes its two constants', () => {
    assert.equal(PREVIEW_LONG_EDGE, 1600)
    assert.equal(PREVIEW_MIN_EDGE, 320)
  })
})

describe('isSmallEnough', () => {
  it('is true when the fit does not shrink the source', () => {
    assert.equal(isSmallEnough(400, 300, { width: 400, height: 300 }), true)
  })

  it('is false when the source is larger', () => {
    assert.equal(isSmallEnough(6000, 4000, { width: 1600, height: 1067 }), false)
  })

  it('is true when the size is unknown', () => {
    assert.equal(isSmallEnough(0, 0, { width: 100, height: 100 }), true)
  })
})
describe('capFor', () => {
  it('caps the width by default', () => {
    const cap = capFor(560, 800, { dpr: 2 })
    assert.deepEqual(cap, { dimension: 'width', size: PREVIEW_LONG_EDGE })
  })

  it('asks for the box at DPR when it is smaller than the cap', () => {
    assert.deepEqual(capFor(300, 200, { dpr: 1 }), { dimension: 'width', size: 320 })
  })

  it('never goes under the minimum edge', () => {
    assert.equal(capFor(10, 10, { dpr: 1 }).size, PREVIEW_MIN_EDGE)
  })
})

describe('needsRecap', () => {
  it('is false for a landscape picture inside the cap', () => {
    assert.equal(needsRecap(1600, 1067), false)
  })

  it('is true when a portrait picture came back too tall', () => {
    assert.equal(needsRecap(1600, 2400), true)
  })

  it('is true when the area blows the budget', () => {
    assert.equal(needsRecap(1600, 32000, { pixelBudget: 4 * 1024 * 1024 }), true)
  })

  it('is false for a missing size', () => {
    assert.equal(needsRecap(0, 0), false)
  })
})

describe('recapFor', () => {
  it('clamps the height for a portrait picture', () => {
    assert.deepEqual(recapFor(1600, 2400), { dimension: 'height', size: PREVIEW_LONG_EDGE })
  })

  it('clamps the height so the area fits the budget', () => {
    // A portrait shot whose width cap still left 3.8 MP against a 1 MP budget.
    const cap = recapFor(1600, 2400, { pixelBudget: 1_000_000 })
    assert.equal(cap.dimension, 'height')
    assert.equal(cap.size, 1224)
    assert.ok(1224 * (1600 / 2400) * 1224 <= 1_000_000 + 2000)
  })

  it('clamps the width for a panorama', () => {
    const cap = recapFor(4000, 1000, { pixelBudget: 1_000_000 })
    assert.equal(cap.dimension, 'width')
    assert.equal(cap.size, 1600)
  })

  it('falls back to capFor without a size', () => {
    assert.equal(recapFor(0, 0).dimension, 'width')
  })
})
