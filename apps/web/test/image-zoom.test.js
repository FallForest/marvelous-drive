import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ZOOM_MIN, ZOOM_MAX, ZOOM_STEPS, clampScale, stepScale, zoomLabel, panLimit, clampPan,
  wheelScale, isZoomWheel,
} from '../lib/image-zoom.js'

/**
 * The zoom arithmetic behind the picture viewer.
 *
 * All of it is relative to the *fitted* picture: 100% is "fits the window", so
 * none of these numbers can ask the loader for a second, larger decode. The
 * boundary rules are what a browser check can only observe indirectly (an edge
 * that keeps sliding), so they are pinned here instead.
 */

describe('clampScale', () => {
  it('keeps the multiplier inside 100–400%', () => {
    assert.equal(ZOOM_MIN, 1)
    assert.equal(ZOOM_MAX, 4)
    assert.equal(clampScale(0.2), 1)
    assert.equal(clampScale(9), 4)
    assert.equal(clampScale(2.5), 2.5)
  })

  it('treats junk as fit instead of NaN', () => {
    assert.equal(clampScale(Number.NaN), 1)
    assert.equal(clampScale(undefined), 1)
    assert.equal(clampScale('wat'), 1)
  })
})

describe('stepScale', () => {
  it('walks the stops without skipping one', () => {
    assert.equal(stepScale(1, 1), 1.5)
    assert.equal(stepScale(1.5, 1), 2)
    assert.equal(stepScale(2, 1), 3)
    assert.equal(stepScale(3, 1), 4)
    assert.equal(stepScale(2, -1), 1.5)
    assert.equal(stepScale(4, -1), 3)
  })

  it('stops at both ends instead of wrapping', () => {
    assert.equal(stepScale(4, 1), 4)
    assert.equal(stepScale(1, -1), 1)
  })

  it('snaps a wheel value onto the neighbouring stop', () => {
    assert.equal(stepScale(1.42, 1), 1.5)
    assert.equal(stepScale(1.42, -1), 1)
  })

  it('treats no direction as "up"', () => {
    assert.equal(stepScale(1, 0), ZOOM_STEPS[1])
    assert.equal(stepScale(1, undefined), ZOOM_STEPS[1])
  })
})

describe('zoomLabel', () => {
  it('reads as a percentage of the fitted size', () => {
    assert.equal(zoomLabel(1), '100%')
    assert.equal(zoomLabel(1.5), '150%')
    assert.equal(zoomLabel(2), '200%')
    assert.equal(zoomLabel(4), '400%')
  })

  it('clamps before it prints', () => {
    assert.equal(zoomLabel(12), '400%')
    assert.equal(zoomLabel(0), '100%')
  })
})

describe('panLimit', () => {
  it('is zero while the picture still fits', () => {
    assert.equal(panLimit(400, 600, 1), 0)
    assert.equal(panLimit(400, 600, 1.2), 0)
  })

  it('is half the overflow at the current multiplier', () => {
    // 400px wide in a 600px frame at 200%: 800-600 = 200, so 100px each side.
    assert.equal(panLimit(400, 600, 2), 100)
    assert.equal(panLimit(300, 300, 4), 450)
  })

  it('tolerates missing measurements', () => {
    assert.equal(panLimit(0, 0, 4), 0)
    assert.equal(panLimit(Number.NaN, 500, 4), 0)
  })
})

describe('clampPan', () => {
  it('keeps the offset inside the limit', () => {
    assert.equal(clampPan(80, 100), 80)
    assert.equal(clampPan(180, 100), 100)
    assert.equal(clampPan(-180, 100), -100)
  })

  it('collapses an unmeasurable axis to no travel', () => {
    assert.equal(clampPan(50, 0), 0)
    assert.equal(clampPan(Number.NaN, 100), 0)
  })
})

describe('wheelScale', () => {
  it('grows upward and shrinks downward, then clamps', () => {
    assert.ok(wheelScale(1, -120) > 1)
    assert.ok(wheelScale(2, 120) < 2)
    assert.equal(wheelScale(4, -5000), 4)
    assert.equal(wheelScale(1, 5000), 1)
  })

  it('ignores a zero delta', () => {
    assert.equal(wheelScale(2, 0), 2)
    assert.equal(wheelScale(2, Number.NaN), 2)
  })
})

describe('isZoomWheel', () => {
  it('leaves browser and horizontal gestures alone', () => {
    assert.equal(isZoomWheel({ deltaY: -120 }), true)
    // Ctrl/Meta+wheel is the browser's page zoom (and the pinch report).
    assert.equal(isZoomWheel({ deltaY: -120, ctrlKey: true }), false)
    assert.equal(isZoomWheel({ deltaY: -120, metaKey: true }), false)
    assert.equal(isZoomWheel({ deltaY: -120, shiftKey: true }), false)
    assert.equal(isZoomWheel(null), false)
  })
})
