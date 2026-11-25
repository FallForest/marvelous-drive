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
import { imageRequestUrl, loadPicture } from './image-loader.js';
import { attachGallerySwipe } from './gallery-gesture.js';
import { createImageZoom } from './image-zoom.js';
import { canEditText, openTextEditor } from './text-editor.js';

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024; // 2 MiB of text is plenty for a peek
const IMAGE_PREVIEW_LIMIT = 40 * 1024 * 1024;

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
function pictureKey(node) {
  if (!node) return null;
  return node.blobHash || node.id || null;
}

export function openPreview(node, options) {
  const opts = options || {};
  if (!node) return null;

  /**
   * One normalized read of the gallery source.
   *
   * `opts.gallery` is either a plain array — an already-known gallery, which is
   * what the shared reader and the tests hand over — or a function the caller
   * owns (actions.js). That function returns the live rows in the view's sort
   * order, whether the list has another page behind it, and how to fetch that
   * page; it returns null once the route behind the drawer is no longer the one
   * the drawer opened on. Normalising here keeps a single code path for both,
   * and a throwing source must not break the drawer: it degrades to "no more".
   */
  function readSource() {
    const source = opts.gallery;
    if (typeof source !== 'function') {
      // A plain array — or a pre-read { nodes, hasMore, loadMore } object — is a
      // known, fixed gallery: there is nothing behind it to page into.
      const value = Array.isArray(source) || !source ? { nodes: source } : source;
      return {
        nodes: Array.isArray(value.nodes) ? value.nodes : [],
        hasMore: value.hasMore === true,
        loadMore: typeof value.loadMore === 'function' ? value.loadMore : null,
        offset: Number(value.offset) || 0,
      };
    }
    let read = null;
    try { read = source(); } catch { return null; }
    if (!read) return null;
    const value = Array.isArray(read) ? { nodes: read } : read;
    return {
      nodes: Array.isArray(value.nodes) ? value.nodes : [],
      hasMore: value.hasMore === true,
      loadMore: typeof value.loadMore === 'function' ? value.loadMore : null,
      // The caller's page cursor (how many rows the view has already read).
      // A page that arrives without moving it was a failure or a fetch the
      // list already had in flight, which is how the walk stops asking.
      offset: Number(value.offset) || 0,
    };
  }

  // The gallery is the folder's pictures in list order; a non-picture (a PDF, a
  // folder) is a gallery of one, so the drawer still works and simply has no
  // neighbours to arrow to. The rows are re-read through the source whenever a
  // page is appended, so they keep the view's order rather than arrival order.
  const initial = readSource() || { nodes: [], hasMore: false, loadMore: null };
  let list = galleryOf(node, initial.nodes);
  let index = Math.max(0, indexOfId(list, node.id));
  let current = list[index] || node;
  /**
   * True while the source says the folder has a page after the loaded rows.
   * It is a floor, not a total: the counter must never print a final "… / 100"
   * while pictures may still be behind page one (see positionLabel's `more`).
   *
   * A non-picture is a gallery of one and never pages: a folder of 40 photos
   * that also holds a PDF must not offer "next" on that PDF, because the next
   * thing in the gallery source is not something this drawer can paint.
   */
  const pagesPictures = isGalleryImage(node);
  let more = pagesPictures && initial.hasMore;
  const body = h('div', { class: 'preview-body centered' });
  const objectUrls = [];
  let disposed = false;
  let paintRevision = 0;
  let swipe = null;
  /** True while one next-page request is in flight. Repeated → is ignored. */
  let loadingMore = false;
  /** True only while the body holds a picture whose zoom may be used. */
  let zoomable = false;
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
    on: { click: () => openVersionHistory(current, { ...opts, onChanged: onFileChanged }) },
  }, raw(icon('clock', 14)), '历史版本');
  const editBtn = h('button', {
    class: 'btn', attrs: { type: 'button', hidden: !canEditText(current) },
    on: { click: () => openTextEditor(current, { onSaved: onFileChanged }) },
  }, raw(icon('pencil', 14)), '编辑文本');
  const gestureHint = h('p', { class: 'preview-gesture-hint', text: '左右滑动切换照片，也可点按上方箭头' });

  /*
   * Zoom controls.
   *
   * Three explicit verbs and a visible multiplier: 缩小 / 适应窗口 / 放大. The
   * multiplier is relative to the fitted picture (100% = fit), so the number
   * means the same thing on a phone and on a wide drawer. aria-disabled is used
   * at the ends instead of `disabled`: a disabled button loses focus and the
   * keyboard user is stranded. The real <button>s keep these operable by
   * keyboard for free.
   */
  const zoomOutBtn = h('button', {
    class: 'btn btn-sm zoom-step',
    attrs: { type: 'button', 'aria-label': '缩小图片', title: '缩小' },
    on: { click: () => zoom.zoomOut() },
  }, raw(icon('minus', 13)));
  const zoomFitBtn = h('button', {
    class: 'btn btn-sm zoom-fit',
    attrs: { type: 'button', 'aria-label': '适应窗口', title: '适应窗口' },
    on: { click: () => zoom.reset() },
  }, '适应窗口');
  const zoomInBtn = h('button', {
    class: 'btn btn-sm zoom-step',
    attrs: { type: 'button', 'aria-label': '放大图片', title: '放大' },
    on: { click: () => zoom.zoomIn() },
  }, raw(icon('plus', 13)));
  const zoomValue = h('span', {
    class: 'zoom-value',
    // The visible number is the state; the live region below speaks a change
    // once, so dragging a wheel does not narrate every intermediate stop.
    attrs: { 'aria-hidden': 'true' },
    text: '100%',
  });
  const zoomAnnounce = h('span', { class: 'visually-hidden zoom-announce', attrs: { role: 'status', 'aria-live': 'polite' } });
  let zoomAnnounceTimer = 0;
  const zoomBar = h('div', {
    class: 'preview-zoom', attrs: { hidden: 'hidden', role: 'group', 'aria-label': '图片缩放' },
  }, zoomOutBtn, zoomFitBtn, zoomInBtn, zoomValue);

  const zoom = createImageZoom({
    onChange: (state) => {
      if (disposed) return;
      const usable = zoomable && state.ready;
      if (usable) zoomBar.removeAttribute('hidden');
      else zoomBar.setAttribute('hidden', 'hidden');
      zoomValue.textContent = state.label;
      const atFit = !state.zoomed;
      zoomOutBtn.setAttribute('aria-disabled', atFit ? 'true' : 'false');
      zoomOutBtn.classList.toggle('is-disabled', atFit);
      const atMax = state.scale >= 4 - 1e-3;
      zoomInBtn.setAttribute('aria-disabled', atMax ? 'true' : 'false');
      zoomInBtn.classList.toggle('is-disabled', atMax);
      body.classList.toggle('is-zoomed', usable && state.zoomed);
      // The wheel fires dozens of changes a second; one settled sentence per
      // gesture is useful, forty intermediate multipliers are noise. The live
      // region sits outside the zoom bar so folding the bar cannot mute it.
      if (zoomAnnounceTimer) clearTimeout(zoomAnnounceTimer);
      zoomAnnounceTimer = setTimeout(() => {
        zoomAnnounceTimer = 0;
        if (!disposed && usable) zoomAnnounce.textContent = state.label;
      }, 320);
    },
    // A drag or a wheel is not a photo change. Cancelling the pending swipe at
    // the moment the gesture starts is what keeps a pan from paging the gallery.
    onInteract: () => swipe?.cancel(),
  });

  // The layout follows the node that OPENED the drawer, never the file being
  // painted: a gallery of pictures stays a picture viewer while arrowing, and a
  // folder never becomes one. A picture is the one preview with no reading
  // measure, so it asks for the viewport-sized layout in photo-viewer.css
  // (single pictures and animated formats share the `image` kind). The formats
  // that are actually read — PDF, text/Markdown/code, Office and video — get
  // the full-surface reading layout in app.css instead of the narrow rail.
  // Audio, folders and unknown formats keep the plain drawer they always had.
  const kind = current.kind === 'folder' ? 'folder' : fileKind(current.mime, current.name);
  const photoClass = kind === 'image' ? ' photo-viewer' : '';
  // The kind guard is load-bearing, not redundant: isTextLike() looks at the
  // MIME and the extension, and a folder is neither. A folder called
  // `notes.txt` would otherwise be put in the reading layout — a typeset
  // column for a folder preview that is a definition list.
  const reading = kind !== 'folder' && (kind === 'pdf' || kind === 'video' || isOfficeKind(kind)
    || isTextLike(current.mime, current.name));
  const readerClass = !photoClass && reading ? ' reader-viewer' : '';

  const handle = drawer({
    title: current.name,
    sub: hasCounter() ? positionLabel(index, list.length, { more }) : '',
    className: 'preview-drawer' + photoClass + readerClass,
    headActions: [nav, h('button', downloadBtn())],
    // The stage is a flex column so the body can claim the leftover height: as a
    // plain block, `flex:1` on .preview-body is inert and a short picture sits
    // at the top of the drawer instead of in the middle of it.
    body: h('div', { class: 'preview-stage' },
      // Announced on every move: "第 3 张，共 12 张：海边.jpg". A screen reader
      // cannot see that the picture changed, and the counter in the header is
      // aria-hidden decoration next to it.
      h('div', { class: 'visually-hidden preview-announce', attrs: { role: 'status', 'aria-live': 'polite' } }),
      body,
      zoomBar,
      zoomAnnounce,
      gestureHint,
    ),
    footer: [
      editBtn,
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
      swipe?.destroy();
      zoom.destroy();
      if (zoomAnnounceTimer) clearTimeout(zoomAnnounceTimer);
      zoomAnnounceTimer = 0;
      zoomable = false;
      // Removing media nodes stops playback before their object URLs go away.
      for (const media of body.querySelectorAll('video,audio')) media.pause();
      body.replaceChildren();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.length = 0;
      // The module cache outlives the drawer on purpose: reopening the same
      // picture must cost zero bytes. Only this drawer's own URL dies here.
    },
  });

  // Arrow keys belong to the picture, not to the scroll container. The listener
  // lives on the panel because the focus trap keeps focus inside it.
  handle.el.addEventListener('keydown', (event) => {
    if (!hasCounter() || !isGalleryImage(current) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
      || event.target.closest?.('input,textarea,select,video,audio,[contenteditable="true"]')) return;
    const delta = arrowDelta(event.key) || jumpDelta(event.key, index, list.length);
    if (!delta) return;
    event.preventDefault();
    step(delta);
  });
  // A zoomed picture owns the horizontal gesture: one finger pans the enlarged
  // photo, so the gallery swipe must stay off for as long as the multiplier is
  // above fit. Resetting restores normal paging (see the is-zoomed gate).
  swipe = attachGallerySwipe(body, {
    enabled: () => !disposed && hasCounter() && isGalleryImage(current) && !zoom.zoomed,
    onStep: step,
  });

  function onFileChanged(updated) {
    if (disposed) return;
    if (updated) Object.assign(current, updated);
    paint();
    if (opts.onChanged) opts.onChanged(updated);
  }

  /** True when the drawer has something to count: more than one picture, or a
      page still behind the rows already loaded. */
  function hasCounter() {
    return list.length > 1 || more;
  }

  /**
   * Moves the drawer to another picture; the chrome and the body follow.
   *
   * A → at the end of the loaded rows is no longer a dead stop when the folder
   * has another page: the loaded rows are only page one (000.png … 099.png),
   * and the pictures after them live behind loadMoreNodes()/loadMoreSearch().
   * Asking for that page on demand — rather than fetching the whole directory
   * when the drawer opens — is what keeps a 5000-photo folder a 100-row read.
   */
  function step(delta) {
    if (disposed) return;
    const next = stepIndex(index, delta, list.length);
    if (next < 0) return;
    if (next === index) {
      // Clamped at an end. Only forward, and only while a page may still
      // exist, is that an invitation to load the next one.
      if (delta > 0 && more) requestMore();
      return;
    }
    move(delta);
  }

  /** Paints the neighbour `delta` steps away, when there is one. */
  function move(delta) {
    const next = stepIndex(index, delta, list.length);
    if (next < 0 || next === index) { paintChrome(); return; }
    index = next;
    current = list[index];
    cancelPrefetch(cancelDirection(delta));
    paint();
  }

  /**
   * Appends the next page behind the loaded rows, then continues the walk.
   *
   * Pages are fetched one at a time, in series, and a page with no picture in it
   * (a page of text files) is not a dead end: the walk asks for the page after
   * it, so one press still reaches the next picture (…, 200.png). The single
   * `loadingMore` lock spans the whole walk: pressing → five times on a slow
   * connection is five keydowns but one walk, and the button stays where it is
   * (and any failure leaves the current picture painted) so the press can simply
   * be repeated. The walk stops when it found its picture, when the source is no
   * longer the current route, when the drawer closed, when there is no more, or
   * when a round did not move the source's cursor (a failure, or a fetch the
   * list already had in flight) — it never re-requests rows already loaded.
   * The page is appended to the same store the list renders from, so the new
   * rows arrive in the view's own sort order instead of arrival order.
   */
  async function requestMore() {
    if (disposed || loadingMore) return;
    // The picture the user is looking at when they ask. A page that lands after
    // they stepped back must grow the list, never pull them forward again.
    const anchor = current.id;
    loadingMore = true;
    paintChrome();
    // The cursor the request in flight was for; null until one is made.
    let asked = null;
    let found = false;
    try {
      // Pages are fetched one at a time, in series, inside this single lock: a
      // page of text files (…) carries no picture, so the walk has to ask for
      // the page after it, and everything it learns comes from re-reading the
      // source rather than from what the previous page returned.
      for (;;) {
        // Re-read before asking: the page may already have arrived (the list's own
        // "继续加载", or a press that finished after this one was queued), and
        // fetching a page that is on screen would double it.
        const source = readSource();
        if (!source) { more = false; break; }
        if (adopt(source)) { found = true; break; }
        if (!source.hasMore || !source.loadMore) { more = false; break; }
        // Already asked for this page and the cursor has not moved past it: the
        // request failed, or the list's own fetch owns it. Asking again would
        // spin on the same page until the user noticed.
        if (asked !== null && source.offset === asked) break;
        asked = source.offset;
        try {
          await source.loadMore();
        } catch {
          // The failure is the caller's to report (app.js toasts it); the viewer
          // only has to stay exactly where it is, with a working retry.
        }
        // A drawer closed (or a picture re-painted) while the page was in flight
        // must not jump: the user is no longer looking at the place they asked from.
        if (disposed) return;
        const after = readSource();
        if (!after) { more = false; break; }
        if (adopt(after)) { found = true; break; }
        // The source is the only authority on "is there another page": a page that
        // held no picture at all still advances this, and the last page clears it so
        // → becomes a real, disabled end again.
        more = after.hasMore;
        if (after.offset === asked) break;
        if (!after.hasMore) break;
      }
    } finally {
      loadingMore = false;
    }
    if (disposed) return;
    // Only the press that is still on the same picture may advance it; a page
    // that arrived after the user stepped back just widens the arrows.
    if (found && current.id === anchor) { move(1); return; }
    paintChrome();
  }

  /**
   * Takes the source's rows into the gallery when it brought pictures.
   *
   * Returns true when the walk grew. It never shrinks the list: a row deleted
   * from another tab must not pull the picture on screen out from under the
   * user, and a page that contained only text files leaves the index where it
   * was and keeps `more` for the page after it.
   */
  function adopt(source) {
    const rebuilt = galleryOf(node, source.nodes);
    if (!rebuilt.length || rebuilt.length <= list.length) return false;
    const at = indexOfId(rebuilt, current.id);
    if (at < 0) return false;
    list = rebuilt;
    index = at;
    more = source.hasMore;
    return true;
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
    paintChrome();
    paintBody();
  }

  /**
   * The header and the navigation state.
   *
   * Split from paint() because a page load changes what "next" means — one more
   * picture exists, or the folder turned out to have no second page — without
   * changing the picture on screen. Repainting the body for that would throw
   * away the decoded frame and show a spinner, i.e. punish the user for the
   * page arriving.
   */
  function paintChrome() {
    if (disposed) return;
    const nameEl = titleEl();
    if (nameEl) nameEl.textContent = current.name;
    // A source that answers null has lost its route (the drawer outlived a
    // navigation): there is no page to ask for any more, so the boundary is a
    // real one again and the counter stops claiming more.
    if (more && typeof opts.gallery === 'function' && !readSource()) more = false;
    const shown = hasCounter();
    const counter = subEl();
    // `more` makes the total a floor: "100 / 100+" while page two exists.
    if (counter) counter.textContent = shown ? positionLabel(index, list.length, { more }) : '';
    const atStart = index <= 0;
    const atEnd = index >= list.length - 1;
    nav.hidden = !shown;
    // NOT the `disabled` attribute: a disabled button cannot hold focus, so
    // the moment the last picture was reached the focused element fell back
    // to <body> and every further key press went nowhere — the drawer stopped
    // responding exactly when the user was still pressing → to see if it would
    // wrap. aria-disabled keeps the control focusable and announced as
    // unavailable; stepIndex() already clamps, so the click is a no-op.
    //
    // The end of the loaded rows is only a real end when the folder has no
    // further page: an unbounded directory page (000.png … 099.png followed by
    // 100.txt, 101.png, …) used to disable → on the 100th row even though 101
    // was one request away.
    const atRealEnd = atEnd && !more;
    prevBtn.setAttribute('aria-disabled', atStart ? 'true' : 'false');
    nextBtn.setAttribute('aria-disabled', atRealEnd ? 'true' : 'false');
    prevBtn.classList.toggle('is-disabled', atStart);
    nextBtn.classList.toggle('is-disabled', atRealEnd);
    // A load in flight is announced on the control that asked for it, not with
    // a second spinner over the picture the user is looking at. It stays
    // focusable and clickable: the request guard, not a dead button, is what
    // makes a repeated press cheap.
    if (atEnd && more && loadingMore) nextBtn.setAttribute('aria-busy', 'true');
    else nextBtn.removeAttribute('aria-busy');
    // A live region, not the title: the drawer is a layer over the page, and
    // the page's <title> still describes the folder. "共 100 张以上" while a
    // page is still unloaded: an exact total would be an invented one.
    const spoken = handle.el.querySelector('.preview-announce');
    if (spoken) {
      const total = more ? '共 ' + list.length + ' 张以上' : '共 ' + list.length + ' 张';
      spoken.textContent = isGalleryImage(current)
        ? '第 ' + (index + 1) + ' 张，' + total + '：' + current.name
        : '预览：' + current.name;
    }
    const hasHistory = current.kind === 'file' && (current.version || 1) > 1;
    if (hasHistory) historyBtn.removeAttribute('hidden');
    else historyBtn.setAttribute('hidden', 'hidden');
    editBtn.hidden = !canEditText(current);
    const gallery = shown && isGalleryImage(current);
    body.classList.toggle('is-gallery', gallery);
    gestureHint.hidden = !gallery;
  }

  function paintBody() {
    const revision = ++paintRevision;
    const gone = () => disposed || revision !== paintRevision;
    swipe?.cancel();
    // A new picture starts fitted: 300% of the previous photo is meaningless
    // here, and the controls must disappear while the next one loads.
    zoom.detach();
    zoomable = false;
    zoomBar.setAttribute('hidden', 'hidden');
    body.classList.remove('centered', 'is-zoomed');
    body.style.padding = '';
    // Derived per node, not once at open: the layout class is fixed at open
    // time, but the body is painted from whatever `current` is now, so a step
    // to a neighbour still picks the renderer that neighbour needs.
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
      loadImage(current, body, {
        disposed: gone,
        objectUrls,
        track,
        untrack,
        // The zoom layer binds to the frame only once a picture is actually
        // painted, so a spinner, an error card or a non-picture never offers
        // controls that cannot work.
        onFrame: (frame) => {
          if (!frame) { zoomable = false; zoom.detach(); return; }
          zoomable = true;
          zoom.attach(frame);
        },
      });
      prefetchNeighbours();
      return;
    }
    if (kind === 'audio' || kind === 'video') {
      loadMedia(current, kind, body, objectUrl, gone);
      return;
    }
    if (kind === 'pdf') {
      body.style.padding = '0';
      loadPdf(current, body, objectUrl, gone);
      return;
    }
    if (isTextLike(current.mime, current.name)) {
      loadText(current, body, kind === 'markdown' || isMarkdown(current.mime, current.name), gone);
      return;
    }
    body.classList.add('centered');
    if (isOfficeKind(kind)) {
      body.classList.remove('centered');
      loadOfficePreview({ host: body, node: current, request, disposed: gone });
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
function galleryOf(node, gallery) {
  const provided = Array.isArray(gallery) ? galleryFor(gallery) : [];
  if (!isGalleryImage(node)) return [node];
  const list = provided.length ? provided : [node];
  if (indexOfId(list, node.id) >= 0) return list;
  return [node].concat(list);
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
  // Every successful paint reports its frame so the zoom controls can bind to
  // the element that is actually on screen; a failure reports null and the
  // controls stay hidden. Never announced for a stale revision.
  const painted = (frame) => {
    if (gone()) return;
    if (typeof context.onFrame === 'function') context.onFrame(frame);
  };

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
      const frame = legacyImage(node, blob, objectUrls);
      mount(body, frame);
      painted(frame);
    } catch (error) {
      context.untrack(tracked);
      if (error && error.name === 'AbortError') return;
      if (gone()) return;
      mount(body, notice('无法载入图片。', (error && error.message) || '请重试。', 'file-image'));
      painted(null);
    }
    return;
  }

  const cached = imageCache.get(pictureKey(node));
  if (cached) {
    const frame = pictureFrame(node, cached);
    mount(body, frame);
    painted(frame);
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
      const frame = pictureFrame(node, bitmap);
      mount(body, frame);
      painted(frame);
      return;
    }
    // No createImageBitmap (or an undecodable format): the bytes are still here.
    const frame = legacyImage(node, blob, objectUrls);
    mount(body, frame);
    painted(frame);
  } catch (error) {
    context.untrack(tracked);
    if (error && error.name === 'AbortError') return;
    if (gone()) return;
    mount(body, notice('无法载入图片。', (error && error.message) || '请重试。', 'file-image'));
    painted(null);
  }
}

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
  return peekThumbUrl(node);
}

/** Last-resort paint: the raw bytes in an <img>, no bitmap, no resize. */
function legacyImage(node, blob, objectUrls) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return h('div', { class: 'picture-frame' },
    h('img', { class: 'preview-media', attrs: { alt: node.name, src: url } }),
  );
}

async function loadPdf(node, body, objectUrl, disposed) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入 PDF…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    if (disposed()) return;
    const frame = h('iframe', {
      class: 'preview-frame',
      // #view=FitH&navpanes=0 is a hint to the native PDF viewer, not part of
      // the resource: Chrome/Adobe honour it best-effort by fitting the width
      // and hiding the bookmark rail, while their own toolbar (zoom, page
      // field, print) is left alone. A viewer that ignores it still loads the
      // same blob, so there is nothing to feature-detect.
      attrs: {
        src: objectUrl(new Blob([blob], { type: 'application/pdf' })) + '#view=FitH&navpanes=0',
        title: 'PDF 预览：' + node.name,
      },
    });
    body.replaceChildren(frame);
  } catch (error) {
    if (disposed()) return;
    body.replaceChildren(notice('无法载入 PDF。', (error && error.message) || '请重试。', 'file-pdf'));
  }
}

async function loadMedia(node, kind, body, objectUrl, disposed) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入媒体…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    if (disposed()) return;
    if (kind === 'video') {
      body.replaceChildren(h('video', { class: 'preview-media', attrs: { controls: 'controls', src: objectUrl(blob), playsinline: 'playsinline' } }));
    } else {
      body.replaceChildren(h('div', { class: 'stack', style: { gap: '12px', alignItems: 'center', padding: '24px' } },
        raw(icon('file-audio', 30)),
        h('audio', { attrs: { controls: 'controls', src: objectUrl(blob) } }),
      ));
    }
  } catch (error) {
    if (disposed()) return;
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

async function loadText(node, body, markdown, disposed) {
  body.classList.remove('centered');
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入文本…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    const truncated = blob.size > TEXT_PREVIEW_LIMIT;
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_LIMIT) : blob;
    const text = await slice.text();
    if (disposed()) return;
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
    if (disposed()) return;
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
    const restored = await request('/files/' + node.id + '/versions/' + entry.id + '/restore', {
      method: 'POST', body: { expectedVersion: node.version },
    });
    toast('已恢复到 v' + entry.version, { type: 'success' });
    drawerHandle.close();
    if (opts && opts.onChanged) opts.onChanged(restored.node);
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
