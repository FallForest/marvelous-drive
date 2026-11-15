import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swipeDelta } from '../lib/gallery-gesture.js';

const start = { x: 200, y: 300, time: 100 };
test('left and right swipes follow the photo order', () => {
  assert.equal(swipeDelta(start, { x: 100, y: 310, time: 500 }, 390), 1);
  assert.equal(swipeDelta(start, { x: 300, y: 310, time: 500 }, 390), -1);
});
test('taps, vertical/diagonal scrolling and a long press do not change the photo', () => {
  assert.equal(swipeDelta(start, { x: 185, y: 302, time: 300 }, 390), 0);
  assert.equal(swipeDelta(start, { x: 180, y: 450, time: 500 }, 390), 0);
  assert.equal(swipeDelta(start, { x: 100, y: 400, time: 500 }, 390), 0);
  assert.equal(swipeDelta(start, { x: 80, y: 300, time: 1600 }, 390), 0);
});
test('the swipe threshold follows the viewport but remains reachable on a phone', () => {
  assert.equal(swipeDelta(start, { x: 150, y: 300, time: 500 }, 320), 1);
  assert.equal(swipeDelta(start, { x: 150, y: 300, time: 500 }, 880), 0);
  assert.equal(swipeDelta(null, start, 320), 0);
});
