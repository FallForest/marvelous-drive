import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createThumbnailLoader } from '../lib/thumbnail-loader.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(concurrency = 2) {
  let notify;
  const observed = new Set();
  class Observer {
    constructor(callback) { notify = callback; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
  }
  const loader = createThumbnailLoader({ concurrency, Observer });
  return { loader, observed, intersect: (element) => notify([{ target: element, isIntersecting: true }]) };
}

test('offscreen thumbnails start only after entering the viewport', async () => {
  const { loader, observed, intersect } = setup();
  const element = { isConnected: true };
  let calls = 0;
  loader.watch(element, () => { calls += 1; });
  await tick();
  assert.equal(calls, 0);
  assert.ok(observed.has(element));
  intersect(element);
  intersect(element);
  await tick();
  assert.equal(calls, 1);
  assert.equal(observed.size, 0);
});

test('visible image requests respect concurrency and release failed slots', async () => {
  const { loader, intersect } = setup(2);
  const release = [];
  let active = 0;
  let peak = 0;
  let started = 0;
  for (let i = 0; i < 5; i += 1) {
    const element = { isConnected: true };
    loader.watch(element, async () => {
      started += 1;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => release.push(resolve));
      active -= 1;
      if (i === 0) throw new Error('decode failed');
    });
    intersect(element);
  }
  await tick();
  assert.equal(started, 2);
  for (let i = 0; i < 5; i += 1) { release[i](); await tick(); }
  assert.equal(started, 5);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('removed rows never start queued requests', async () => {
  const { loader, intersect } = setup(1);
  let finish;
  const first = { isConnected: true };
  const removed = { isConnected: true };
  let calls = 0;
  loader.watch(first, () => new Promise((resolve) => { finish = resolve; }));
  intersect(first);
  loader.watch(removed, () => { calls += 1; });
  intersect(removed);
  removed.isConnected = false;
  await tick();
  finish();
  await tick();
  assert.equal(calls, 0);
});
