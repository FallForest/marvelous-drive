/*
 * preview.js — right-hand drawer for one node.
 *
 * Binary content needs the bearer header, so images/PDF are fetched as Blobs
 * and shown through object URLs (revoked when the drawer closes). Text and
 * Markdown are decoded and rendered; .md goes through the escaped renderer in
 * format.js, everything else stays inside a <pre>.
 */

import { h, raw, mount } from './dom.js';
import { icon, kindIcon, fileKind, isMarkdown, isTextLike, bytes, formatDate, relativeTime, renderMarkdown, shortHash } from './format.js';
import { drawer, dialog, confirmDialog, toast } from './ui.js';
import { fetchBlob, contentUrl, request, saveBlob } from './api.js';
import { isOfficeKind, loadOfficePreview } from './office-preview.js';
import { highlight, languageOf } from './highlight.js';
import { peekThumbUrl } from './files.js';
import {
  arrowDelta, cancelDirection, galleryFor, indexOfId, isAnimated, isGalleryImage, jumpDelta,
  positionLabel, prefetchWindow, stepIndex,
} from './gallery.js';
import { createImageCache } from './image-cache.js';
import { loadPicture } from './image-loader.js';

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024; // 2 MiB of text is plenty for a peek
const IMAGE_PREVIEW_LIMIT = 40 * 1024 * 1024;
const PDF_PREVIEW_LIMIT = 60 * 1024 * 1024;

/**
 * One cache for the whole page, not one per drawer.
 *
 * Opening a picture, arrowing away and coming back is the normal gesture, and
 * it has to cost zero bytes the second time. The cache is byte-bounded and LRU
 * (see image-cache.js), and object URLs are revoked as entries are evicted —
 * so "keep it across opens" does not mean "leak until the tab dies".
 */
const imageCache = createImageCache();

/**
 * Decoded bitmaps are cached, not object URLs.
 *
 * A cached bitmap costs one decode for the whole session; a cached object URL
 * still costs a decode on every paint, and on a photograph that decode is the
 * slowest part of showing it. The entry stores the encoded size for accounting
 * even though the resident cost is the bitmap's RGBA — see image-fit.js for why
 * the bitmap is capped well below its source size.
 */
function storeBitmap(node, bitmap, encodedSize) {
  // The cache calls the disposer on eviction, replacement and clear, so a
  // bitmap never outlives its entry: ImageBitmap holds GPU memory that GC
  // does not free promptly on its own.
  imageCache.set(pictureKey(node), bitmap, encodedSize, () => {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  });
}

/**
 * The cache key for one picture: the blob hash, not the node id.
 *
 * Blobs are content-addressed and deduplicated, so two nodes with the same
 * bytes must share one decoded bitmap; and when a file is overwritten its hash
 * changes, which makes "the drawer showed me the old version" impossible
 * without any explicit invalidation. The id is only a fallback for a node whose
 * hash the API did not report.
 */
export function pictureKey(node) {
  if (!node) return null;
  return node.blobHash || node.id || null;
}

export function openPreview(node, options) {
  const opts = options || {};
  if (!node) return null;

  // The gallery is the folder's pictures in list order; a non-picture (a PDF, a
  // folder) is a gallery of one, so the drawer still works and simply has no
  // neighbours to arrow to.
  const list = galleryOf(node, opts.gallery);
  let index = Math.max(0, indexOfId(list, node.id));
  let current = list[index] || node;
  // A drawer showing one non-picture has no gallery to speak of: printing
  // "1 / 1" next to a PDF would promise navigation that does not exist.
  const counted = list.length > 1;

  const body = h('div', { class: 'preview-body centered' });
  const bannerHost = h('div', { class: 'lock-host' });
  const objectUrls = [];
  let disposed = false;
  let lock = null;
  /** Pending picture requests: { controller, targetIndex }. See cancelPrefetch(). */
  const inflight = new Set();
  const track = (controller, targetIndex) => {
    const entry = { controller, targetIndex };
    inflight.add(entry);
    return entry;
  };
  const untrack = (entry) => inflight.delete(entry);

  const titleEl = () => handle.el.querySelector('.title-text');
  const subEl = () => handle.el.querySelector('.drawer-head .sub');

  const downloadBtn = () => ({
    class: 'icon-btn',
    attrs: { type: 'button', 'aria-label': '下载文件', title: '下载' },
    html: icon('download', 15),
    on: { click: () => { if (opts.onDownload) opts.onDownload(current); } },
  });

  const prevBtn = h('button', {
    class: 'icon-btn preview-step',
    attrs: { type: 'button', 'aria-label': '上一张', title: '上一张 (←)' },
    html: icon('arrow-left', 15),
    on: { click: () => step(-1) },
  });
  const nextBtn = h('button', {
    class: 'icon-btn preview-step',
    attrs: { type: 'button', 'aria-label': '下一张', title: '下一张 (→)' },
    html: icon('arrow-right', 15),
    on: { click: () => step(1) },
  });
  const nav = h('div', { class: 'preview-nav' }, prevBtn, nextBtn);
  const historyBtn = h('button', {
    class: 'btn', attrs: { type: 'button', hidden: 'hidden' },
    on: { click: () => openVersionHistory(current, opts) },
  }, raw(icon('clock', 14)), '历史版本');

  const handle = drawer({
    title: current.name,
    sub: counted ? positionLabel(index, list.length) : '',
    className: 'preview-drawer',
    headActions: [nav, h('button', downloadBtn())],
    // The stage is a flex column so the body can claim the leftover height: as a
    // plain block, `flex:1` on .preview-body is inert and a short picture sits
    // at the top of the drawer instead of in the middle of it.
    body: h('div', { class: 'preview-stage' },
      bannerHost,
      // Announced on every move: "第 3 张，共 12 张：海边.jpg". A screen reader
      // cannot see that the picture changed, and the counter in the header is
      // aria-hidden decoration next to it.
      h('div', { class: 'visually-hidden preview-announce', attrs: { role: 'status', 'aria-live': 'polite' } }),
      body,
    ),
    footer: [
      h('button', {
        class: 'btn', attrs: { type: 'button' },
        on: { click: () => { if (opts.onDownload) opts.onDownload(current); } },
      }, raw(icon('download', 14)), '下载'),
      h('button', {
        class: 'btn', attrs: { type: 'button' },
        on: { click: () => { if (opts.onShare) opts.onShare(current); } },
      }, raw(icon('share', 14)), '分享'),
      historyBtn,
      h('span', { class: 'push' }),
      h('button', {
        class: 'btn btn-ghost', attrs: { type: 'button' },
        on: { click: () => { if (opts.onDetails) opts.onDetails(current); } },
      }, raw(icon('info', 14)), '详情'),
    ],
    onClose: () => {
      disposed = true;
      for (const { controller } of inflight) controller.abort();
      inflight.clear();
      if (lock) lock.release();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.length = 0;
      // The module cache outlives the drawer on purpose: reopening the same
      // picture must cost zero bytes. Only this drawer's own URL dies here.
    },
  });

  // Arrow keys belong to the picture, not to the scroll container. The listener
  // lives on the panel because the focus trap keeps focus inside it.
  handle.el.addEventListener('keydown', (event) => {
    const delta = arrowDelta(event.key) || jumpDelta(event.key, index, list.length);
    if (!delta) return;
    event.preventDefault();
    step(delta);
  });

  /** Moves the drawer to another picture; the chrome and the body follow. */
  function step(delta) {
    if (disposed) return;
    const next = stepIndex(index, delta, list.length);
    if (next < 0 || next === index) return;
    index = next;
    current = list[index];
    cancelPrefetch(cancelDirection(delta));
    paint();
  }

  /**
   * Aborts the prefetches a move has just made pointless.
   *
   * Each request remembers which side it was warming; "behind" is everything at
   * or before the old index, "ahead" everything after it. On a fast connection
   * this never fires; on a slow one it is the difference between one download
   * and four for the same picture.
   */
  function cancelPrefetch(side) {
    if (side === 'all') {
      for (const entry of inflight) entry.controller.abort();
      inflight.clear();
      return;
    }
    for (const entry of Array.from(inflight)) {
      const behind = entry.targetIndex <= index;
      if ((side === 'behind' && behind) || (side === 'ahead' && !behind)) {
        entry.controller.abort();
        inflight.delete(entry);
      }
    }
  }

  /** Repaints the header, the lock banner and the body for `current`. */
  function paint() {
    if (!disposed) {
      const nameEl = titleEl();
      if (nameEl) nameEl.textContent = current.name;
      const counter = subEl();
      if (counter) counter.textContent = counted ? positionLabel(index, list.length) : '';
      const atStart = index <= 0;
      const atEnd = index >= list.length - 1;
      nav.hidden = !counted;
      // NOT the `disabled` attribute: a disabled button cannot hold focus, so
      // the moment the last picture was reached the focused element fell back
      // to <body> and every further key press went nowhere — the drawer stopped
      // responding exactly when the user was still pressing → to see if it would
      // wrap. aria-disabled keeps the control focusable and announced as
      // unavailable; stepIndex() already clamps, so the click is a no-op.
      prevBtn.setAttribute('aria-disabled', atStart ? 'true' : 'false');
      nextBtn.setAttribute('aria-disabled', atEnd ? 'true' : 'false');
      prevBtn.classList.toggle('is-disabled', atStart);
      nextBtn.classList.toggle('is-disabled', atEnd);
      // A live region, not the title: the drawer is a layer over the page, and
      // the page's <title> still describes the folder.
      const spoken = handle.el.querySelector('.preview-announce');
      if (spoken) spoken.textContent = '第 ' + (index + 1) + ' 张，共 ' + list.length + ' 张：' + current.name;
      const hasHistory = current.kind === 'file' && (current.version || 1) > 1;
      if (hasHistory) historyBtn.removeAttribute('hidden');
      else historyBtn.setAttribute('hidden', 'hidden');
    }
    if (lock) lock.release();
    // A picture is not a document: there is nothing to lock, and one POST per
    // arrow press would be pure noise.
    lock = pictureKind(current) ? NO_LOCK : createEditLock(current);
    if (lock.banner) mount(bannerHost, lock.banner);
    else bannerHost.replaceChildren();
    paintBody();
  }

  function paintBody() {
    body.classList.remove('centered');
    body.style.padding = '';
    const kind = current.kind === 'folder' ? 'folder' : fileKind(current.mime, current.name);

    if (current.kind === 'folder') {
      body.classList.add('centered');
      mount(body, folderPreview(current, opts));
      return;
    }
    if (kind === 'image' && current.size > IMAGE_PREVIEW_LIMIT) {
      body.classList.add('centered');
      mount(body, notice('图片过大，未在页面内渲染。', '使用下方"下载"按钮查看原图。', 'file-image'));
      return;
    }
    if (kind === 'image') {
      loadImage(current, body, { disposed: () => disposed, objectUrls, track, untrack });
      prefetchNeighbours();
      return;
    }
    if (kind === 'audio' || kind === 'video') {
      loadMedia(current, kind, body, objectUrl, () => disposed);
      return;
    }
    if (kind === 'pdf') {
      body.style.padding = '0';
      loadPdf(current, body, objectUrl);
      return;
    }
    if (isTextLike(current.mime, current.name)) {
      loadText(current, body, kind === 'markdown' || isMarkdown(current.mime, current.name));
      return;
    }
    body.classList.add('centered');
    if (isOfficeKind(kind)) {
      body.classList.remove('centered');
      loadOfficePreview({ host: body, node: current, request, disposed: () => disposed });
      return;
    }
    mount(body, notice('此格式暂不支持在线预览。', '下载后使用本地应用打开。', kindIcon(kind, current.name)));
  }

  /**
   * Warms the pictures the user is about to ask for.
   *
   * Only the neighbours the policy allows (gallery.js decides distance and
   * size), never the one on screen, never one already in the cache. Every
   * request carries an AbortController so leaving the drawer or arrowing past
   * them does not leave a 30 MB download running for nothing.
   */
  function prefetchNeighbours() {
    const box = pictureBox(body);
    for (const { node: neighbour } of prefetchWindow(list, index)) {
      const key = pictureKey(neighbour);
      if (!key || imageCache.has(key)) continue;
      if (neighbour.kind !== 'file' || !neighbour.id) continue;
      // Warming an animation would decode frame one and cache a still of it.
      if (isAnimated(neighbour.mime)) continue;
      const controller = new AbortController();
      const tracked = track(controller, list.indexOf(neighbour));
      loadPicture(neighbour, {
        boxWidth: box.width,
        boxHeight: box.height,
        dpr: window.devicePixelRatio || 1,
        signal: controller.signal,
      })
        .then(({ bitmap, blob }) => {
          untrack(tracked);
          if (!bitmap) return;
          // A neighbour that arrived after the drawer closed, or after the user
          // moved past it, must not sit in memory; close it and move on.
          if (disposed) { if (typeof bitmap.close === 'function') bitmap.close(); return; }
          if (imageCache.has(key)) { if (typeof bitmap.close === 'function') bitmap.close(); return; }
          storeBitmap(neighbour, bitmap, blob ? blob.size : 0);
        })
        .catch(() => { untrack(tracked); });
    }
  }

  const objectUrl = (blob) => {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  };

  paint();
  return handle;
}

/** The picture list for this drawer; a non-picture gets a list of one. */
export function galleryOf(node, gallery) {
  const provided = Array.isArray(gallery) ? galleryFor(gallery) : [];
  if (!isGalleryImage(node)) return [node];
  const list = provided.length ? provided : [node];
  if (indexOfId(list, node.id) >= 0) return list;
  return [node].concat(list);
}


/**
 * Acquires (and releases) the advisory edit lock for a file.
 *
 * Two states are worth showing: "another tab is editing this" when the claim is
 * refused, and nothing at all in the normal case. The banner is the whole UI — a
 * lock that takes over a toolbar would be more intrusive than the problem it
 * solves.
 */
function createEditLock(node) {
  const banner = h('div', { class: 'lock-banner', attrs: { hidden: 'hidden', role: 'status', 'aria-live': 'polite' } });
  if (!node || node.kind !== 'file') return { banner, release() {} };

  const client = 'tab-' + Math.random().toString(36).slice(2, 10);
  let held = false;
  const show = (text, tone) => {
    banner.textContent = text;
    banner.className = 'lock-banner' + (tone ? ' is-' + tone : '');
    banner.removeAttribute('hidden');
  };

  request('/nodes/' + node.id + '/lock', { method: 'POST', body: { client } })
    .then((payload) => {
      held = true
      // A second window of the same user is never blocked, but it is worth a
      // sentence: two tabs editing one file is the case this lock exists for.
      if (payload && payload.supersededClient) {
        show('此文件的编辑锁刚从「' + payload.supersededClient + '」转到这里，那个窗口若继续保存会覆盖。', 'warn')
      }
    })
    .catch((error) => {
      // 409 carries the holder; 401/404 mean there is nothing to say.
      if (error && error.status === 409) {
        // The server puts the holder's client id in the message.
        const who = String((error && error.message) || '').replace(/ is editing this file\.$/, '');
        show((who || '另一个窗口') + ' 正在编辑此文件，保存可能互相覆盖。', 'warn');
        return;
      }
      if (error && error.status === 404) return;
    });

  return {
    banner,
    release() {
      if (!held) return;
      // Fire and forget: the TTL is the safety net if this never arrives.
      request('/nodes/' + node.id + '/lock', { method: 'DELETE' }).catch(() => {});
      held = false;
    },
  };
}

function notice(title, hint, iconName) {
  return h('div', { class: 'empty' },
    raw(icon(iconName || 'file', 30)),
    h('b', { text: title }),
    h('p', { text: hint }),
  );
}

/**
 * Paints one picture into the drawer.
 *
 * Four things happen, in this order, and the order is the point:
 *
 *  1. a cached bitmap is painted on the same tick — no network, no decode, so
 *     arrowing back to a picture already seen never shows a spinner;
 *  2. otherwise the 96px list thumbnail (already fetched for the row) is
 *     stretched as a blurred backdrop, so the frame is never an empty hole;
 *  3. the picture is fetched from the immutable thumbnail route and decoded
 *     straight to the drawer's box, never to its native size;
 *  4. the bitmap fades in over the backdrop. A failure falls back to an <img>
 *     over the object URL rather than an error card.
 */
async function loadImage(node, body, context) {
  // `disposed` arrives as a getter: the drawer can close while this await is in
  // flight, and a captured boolean would always read "not closed".
  const gone = () => (typeof context.disposed === 'function' ? context.disposed() : !!context.disposed);
  const { objectUrls } = context;

  // An animated picture must NOT go through createImageBitmap(): a bitmap is a
  // single frame, so a GIF, an APNG or an animated WebP would be drawn once and
  // sit there frozen while the timeline it carries is thrown away. These four
  // formats have been natively decoded by every engine for years, so the
  // browser's own <img> is both correct and cheaper — no decode on our side.
  if (isAnimated(node.mime)) {
    const controller = new AbortController();
    const tracked = context.track(controller, -1);
    try {
      const blob = await fetchBlob(imageRequestUrl(node), { signal: controller.signal });
      context.untrack(tracked);
      if (gone() || controller.signal.aborted) return;
      // No cache entry: a Blob held for an animation would pin the whole file,
      // and re-fetching a GIF is answered by the HTTP cache anyway.
      mount(body, legacyImage(node, blob, objectUrls));
    } catch (error) {
      context.untrack(tracked);
      if (error && error.name === 'AbortError') return;
      if (gone()) return;
      mount(body, notice('无法载入图片。', (error && error.message) || '请重试。', 'file-image'));
    }
    return;
  }

  const cached = imageCache.get(pictureKey(node));
  if (cached) {
    mount(body, pictureFrame(node, cached));
    return;
  }

  const controller = new AbortController();
  // -1: the picture on screen is never cancelled by a direction, only by close.
  const tracked = context.track(controller, -1);
  const backdrop = blurredBackdrop(node);
  // The spinner is delayed by CSS, not by a timer: a picture that arrives in
  // 80ms must never flash a loading state, and a delayed animation is cheaper
  // than keeping a timeout in step with the network.
  mount(body, h('div', { class: 'picture-frame' },
    backdrop,
    h('span', { class: 'spinner picture-spinner' }),
  ));

  try {
    const box = pictureBox(body);
    const { bitmap, blob } = await loadPicture(node, {
      boxWidth: box.width,
      boxHeight: box.height,
      dpr: window.devicePixelRatio || 1,
      signal: controller.signal,
    });
    context.untrack(tracked);
    if (gone() || controller.signal.aborted) {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      return;
    }
    if (bitmap) {
      storeBitmap(node, bitmap, blob ? blob.size : 0);
      mount(body, pictureFrame(node, bitmap));
      return;
    }
    // No createImageBitmap (or an undecodable format): the bytes are still here.
    mount(body, legacyImage(node, blob, objectUrls));
  } catch (error) {
    context.untrack(tracked);
    if (error && error.name === 'AbortError') return;
    if (gone()) return;
    mount(body, notice('无法载入图片。', (error && error.message) || '请重试。', 'file-image'));
  }
}

/** True when the node renders as a picture in this drawer. */
function pictureKind(node) {
  return !!node && fileKind(node.mime, node.name) === 'image';
}

/** A picture is not a document: there is nothing to edit, so nothing to lock. */
const NO_LOCK = Object.freeze({ banner: null, release() {} });

/** The frame a bitmap is painted into; the canvas keeps the aspect ratio. */
function pictureFrame(node, bitmap) {
  const width = bitmap.width || 1;
  const height = bitmap.height || 1;
  const canvas = h('canvas', {
    class: 'picture-canvas',
    // The intrinsic size is the decoded size, so CSS can letterbox it with
    // object-fit and the layout never jumps when a neighbour is taller.
    attrs: { width: String(width), height: String(height), role: 'img', 'aria-label': node.name },
  });
  const context = canvas.getContext('2d');
  if (context) {
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
  }
  return h('div', { class: 'picture-frame' }, canvas);
}

/** The drawer's usable picture box, in CSS pixels. */
function pictureBox(body) {
  const rect = body.getBoundingClientRect ? body.getBoundingClientRect() : { width: 0, height: 0 };
  return { width: rect.width || 0, height: rect.height || 0 };
}

/**
 * The 96px list thumbnail, blown up and blurred.
 *
 * It is already in the row cache, so it costs no request; it is only there to
 * give the eye the right colours while the real picture decodes, which is the
 * job Immich's thumbhash does when it has one.
 */
function blurredBackdrop(node) {
  const thumb = thumbUrlFor(node);
  if (!thumb) return null;
  return h('img', {
    class: 'picture-backdrop',
    attrs: { alt: '', 'aria-hidden': 'true', src: thumb },
  });
}

/** The row thumbnail's object URL, when the list has already fetched it. */
function thumbUrlFor(node) {
  return peekThumbUrl(node.id);
}

/** Last-resort paint: the raw bytes in an <img>, no bitmap, no resize. */
function legacyImage(node, blob, objectUrls) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return h('div', { class: 'picture-frame' },
    h('img', { class: 'preview-media', attrs: { alt: node.name, src: url } }),
  );
}

async function loadPdf(node, body, objectUrl) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入 PDF…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    const frame = h('iframe', {
      class: 'preview-frame',
      attrs: { src: objectUrl(new Blob([blob], { type: 'application/pdf' })), title: 'PDF 预览：' + node.name },
    });
    body.replaceChildren(frame);
  } catch (error) {
    body.replaceChildren(notice('无法载入 PDF。', (error && error.message) || '请重试。', 'file-pdf'));
  }
}

async function loadMedia(node, kind, body, objectUrl, disposed) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入媒体…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    if (disposed) return;
    if (kind === 'video') {
      body.replaceChildren(h('video', { class: 'preview-media', attrs: { controls: 'controls', src: objectUrl(blob), playsinline: 'playsinline' } }));
    } else {
      body.replaceChildren(h('div', { class: 'stack', style: { gap: '12px', alignItems: 'center', padding: '24px' } },
        raw(icon('file-audio', 30)),
        h('audio', { attrs: { controls: 'controls', src: objectUrl(blob) } }),
      ));
    }
  } catch (error) {
    body.replaceChildren(notice('无法载入媒体。', (error && error.message) || '请重试。', 'file-audio'));
  }
}

/** Escapes a plain suffix so it can sit inside highlighted markup. */
function escapeSuffix(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function loadText(node, body, markdown) {
  body.classList.remove('centered');
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入文本…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    const truncated = blob.size > TEXT_PREVIEW_LIMIT;
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_LIMIT) : blob;
    const text = await slice.text();
    if (markdown) {
      const article = h('article', { class: 'preview-md' });
      article.innerHTML = renderMarkdown(text);
      for (const link of article.querySelectorAll('a')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
      body.replaceChildren(truncated
        ? h('div', {}, h('p', { class: 'dialog-note', style: { padding: '10px 18px 0' }, text: '文件较大，仅显示前 2 MiB。' }), article)
        : article);
    } else {
      // Code files get a light token pass; everything else stays a plain <pre>.
      // The highlighter escapes every token, so innerHTML is safe here.
      const language = languageOf(node.name);
      const suffix = truncated ? '\n\n……（已截断，仅显示前 2 MiB）' : '';
      if (language) {
        const pre = h('pre', { class: 'preview-text preview-code' });
        pre.innerHTML = highlight(text, language) + escapeSuffix(suffix);
        body.replaceChildren(pre);
      } else {
        body.replaceChildren(h('pre', { class: 'preview-text', text: text + suffix }));
      }
    }
  } catch (error) {
    body.replaceChildren(notice('无法载入文本。', (error && error.message) || '请重试。', 'file-text'));
  }
}


/**
 * Version history of one file.
 *
 * Each row can be downloaded (the old bytes, without touching the live file) or
 * restored (which appends a new version, so the restore itself is undoable).
 * Restore asks for confirmation because it is the destructive half.
 */
async function openVersionHistory(node, opts) {
  const body = h('div', { class: 'version-list', attrs: { 'aria-live': 'polite' } });
  const handle = drawer({
    title: '历史版本',
    sub: node.name,
    width: '480px',
    body,
    footer: [
      h('span', { class: 'push' }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => handle.close() } }),
    ],
  });
  body.replaceChildren(h('div', { class: 'empty', style: { padding: '28px' } },
    h('span', { class: 'spinner' }), h('p', { text: '正在载入历史…' })));

  let payload;
  try {
    payload = await request('/files/' + node.id + '/versions');
  } catch (error) {
    body.replaceChildren(h('div', { class: 'empty' },
      raw(icon('clock', 26)),
      h('b', { text: '无法载入历史版本' }),
      h('p', { text: (error && error.message) || '请重试。' }),
    ));
    return handle;
  }

  const versions = (payload && payload.versions) || [];
  body.replaceChildren();
  if (!versions.length) {
    body.replaceChildren(h('div', { class: 'empty' },
      raw(icon('clock', 26)),
      h('b', { text: '还没有历史版本' }),
      h('p', { text: '覆盖同名文件后会在这里留下旧内容。' }),
    ));
    return handle;
  }

  for (const entry of versions) {
    const row = h('div', { class: 'version-row' },
      h('span', { class: 'version-tag', text: 'v' + entry.version }),
      h('span', { class: 'version-meta' },
        h('b', { text: bytes(entry.size) }),
        h('small', { text: relativeTime(entry.createdAt) }),
      ),
      h('span', { class: 'push' }),
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button' },
        on: { click: () => downloadVersion(node, entry) },
      }, raw(icon('download', 12)), '下载'),
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button' },
        on: { click: () => restoreVersion(node, entry, handle, opts) },
      }, raw(icon('rotate-ccw', 12)), '恢复'),
    );
    body.appendChild(row);
  }
  return handle;
}

/** Saves the old bytes; the live file is untouched. */
async function downloadVersion(node, entry) {
  try {
    const blob = await fetchBlob('/files/' + node.id + '/versions/' + entry.id + '/content?download=1');
    // Keep the original name and mark the version, the same convention the
    // server uses in Content-Disposition.
    const dot = node.name.lastIndexOf('.');
    const filename = dot > 0
      ? node.name.slice(0, dot) + ' (v' + entry.version + ')' + node.name.slice(dot)
      : node.name + ' (v' + entry.version + ')';
    saveBlob(blob, filename);
    toast('已下载 v' + entry.version, { type: 'success', timeout: 2000 });
  } catch (error) {
    toast((error && error.message) || '下载失败。', { type: 'error' });
  }
}

/** Restores an old version; the current content becomes a version itself. */
async function restoreVersion(node, entry, drawerHandle, opts) {
  const yes = await confirmDialog({
    title: '恢复到 v' + entry.version,
    description: '当前内容会先保存为历史版本，然后换成 v' + entry.version + '。',
    confirmLabel: '恢复',
  });
  if (!yes) return;
  try {
    await request('/files/' + node.id + '/versions/' + entry.id + '/restore', {
      method: 'POST', body: { expectedVersion: node.version },
    });
    toast('已恢复到 v' + entry.version, { type: 'success' });
    drawerHandle.close();
    if (opts && opts.onChanged) opts.onChanged();
  } catch (error) {
    toast((error && error.message) || '恢复失败。', { type: 'error' });
  }
}

function folderPreview(node, opts) {
  return h('div', { class: 'preview-meta' },
    h('dt', { text: '类型' }), h('dd', { text: '文件夹' }),
    h('dt', { text: '名称' }), h('dd', { text: node.name }),
    h('dt', { text: '创建时间' }), h('dd', { text: formatDate(node.createdAt) }),
    h('dt', { text: '更新时间' }), h('dd', { text: relativeTime(node.updatedAt) }),
    h('dt', { text: '星标' }), h('dd', { text: node.starred ? '已加星标' : '未加星标' }),
  );
}

/** Metadata dialog shared by the preview footer and the row menu. */
export function showDetails(node, options) {
  const opts = options || {};
  const rows = [
    ['名称', node.name],
    ['类型', node.kind === 'folder' ? '文件夹' : (node.mime || '未知')],
    ['大小', node.kind === 'folder' ? '—' : bytes(node.size)],
    ['版本', 'v' + (node.version || 1)],
    ['创建时间', formatDate(node.createdAt)],
    ['更新时间', formatDate(node.updatedAt)],
    ['内容哈希', node.blobHash ? shortHash(node.blobHash) : '—'],
  ];
  const body = h('dl', { class: 'preview-meta' });
  for (const [label, value] of rows) {
    body.appendChild(h('dt', { text: label }));
    body.appendChild(h('dd', { attrs: { title: String(value) }, text: String(value) }));
  }
  return dialog({
    title: '文件详情',
    description: node.name,
    body,
    footer: (dlg) => [
      h('span', { class: 'push' }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => dlg.close() } }),
    ],
    onClose: opts.onClose,
  });
}