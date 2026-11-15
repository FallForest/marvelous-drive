#!/usr/bin/env node
/* Late image decodes must not replace the current photo; animated files stay images. */
import { serverUrl, runBrowserCheck, signUpInPage, sleep } from './lib/browser.mjs';
import { makePng } from './lib/png.mjs';

process.exit(await runBrowserCheck({ title: 'Preview loading order check', network: true }, async (page, check) => {
  await page.navigate(serverUrl() + '/');
  await signUpInPage(page, { prefix: 'preview-race' });
  const ids = await page.run(async (pictures) => {
    const headers = { authorization: 'Bearer ' + localStorage.getItem('mdrive-token') };
    const ids = [];
    for (const [name, type, base64] of pictures) {
      const body = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const response = await fetch('/api/v1/uploads?name=' + name, { method: 'PUT', headers: { ...headers, 'content-type': type }, body });
      ids.push((await response.json()).node.id);
    }
    return ids;
  }, [
    ['a.png', 'image/png', makePng(80, 60).toString('base64')],
    ['b.png', 'image/png', makePng(120, 90).toString('base64')],
    ['c.gif', 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'],
  ]);
  await page.reload();
  await page.waitFor("document.querySelectorAll('.frow').length === 3");
  await page.run(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
      const bitmap = await decode(...args);
      // No row thumbnail calls createImageBitmap. Delay A both as visible image
      // and as a neighbour, after decoding so AbortSignal alone cannot hide a race.
      if (bitmap.width === 80) await new Promise(resolve => setTimeout(resolve, 900));
      return bitmap;
    };
  });
  await page.run((id) => document.querySelector('[data-id="' + id + '"]').click(), ids[1]);
  await page.waitFor("document.querySelector('.picture-canvas[aria-label=\"b.png\"]')");
  // Open B (so A is prefetched), move back to slow A, then forward to cached B.
  await page.run(() => document.querySelector('.preview-drawer [aria-label="上一张"]').click());
  await sleep(80);
  await page.run(() => document.querySelector('.preview-drawer [aria-label="下一张"]').click());
  await sleep(1200);
  const afterRace = await page.run(() => ({
    title: document.querySelector('.preview-drawer .title-text').textContent,
    image: document.querySelector('.preview-drawer .picture-canvas')?.getAttribute('aria-label'),
  }));
  check('late decoding never paints the previous photo over the current one', afterRace.title === 'b.png' && afterRace.image === 'b.png', JSON.stringify(afterRace));
  await page.run(() => document.querySelector('.preview-drawer [aria-label="下一张"]').click());
  await page.waitFor("document.querySelector('.preview-drawer img.preview-media[alt=\"c.gif\"]')");
  check('a GIF uses the browser image path and keeps its animation', await page.evaluate("document.querySelector('.preview-drawer img.preview-media').naturalWidth === 1"));
  await page.run(() => document.querySelector('.preview-drawer [aria-label="关闭"]').click());
  await sleep(300);
  check('closing releases the active preview', await page.evaluate("!document.querySelector('.preview-drawer:not(.is-closing)')"));
  check('no console errors', !page.consoleErrors.length, page.consoleErrors.slice(0, 3).join(' | '));
  check('no failed requests', !page.failedRequests.length, page.failedRequests.slice(0, 3).join(' | '));
}));
