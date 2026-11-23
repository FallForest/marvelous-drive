/*
 * image-zoom.js — the zoom layer over one picture in the preview drawer.
 *
 * The viewer already decodes a picture to the drawer's fit size (see
 * image-fit.js) and letterboxes it with CSS. Zoom is therefore a *relative*
 * scale on top of that fit size, not a second decode: 100% is "fit the window",
 * 400% is four times the fitted pixels. Keeping the decode untouched is what
 * preserves the resource ceiling on a 40 MP photograph.
 *
 * Two halves:
 *   - pure functions (steps, labels, pan bounds) driven by node --test;
 *   - a controller that binds those rules to one .picture-frame. It owns the
 *     pointer drag, plain-wheel zoom and double-click toggle, while leaving
 *     Ctrl/Meta+wheel to the browser (page zoom) and two-finger pinch to the
 *     platform (`touch-action: pinch-zoom` only while zoomed).
 */

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

/** Fit, then four deliberate stops: a wheel cannot land on a useless 103%. */
export const ZOOM_STEPS = Object.freeze([1, 1.5, 2, 3, 4]);

/** Clamp any requested multiplier into the supported range. */
export function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

/** The next stop up (direction > 0) or down. Stays put at either end. */
export function stepScale(current, direction) {
  const scale = clampScale(current);
  // "not negative" includes NaN, so a missing direction means "zoom in".
  if (!(Number(direction) < 0)) {
    for (const step of ZOOM_STEPS) if (step > scale + 1e-6) return step;
    return ZOOM_MAX;
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index] < scale - 1e-6) return ZOOM_STEPS[index];
  }
  return ZOOM_MIN;
}

/** "150%" — the visible multiplier beside the controls. */
export function zoomLabel(scale) {
  return Math.round(clampScale(scale) * 100) + '%';
}

/**
 * How far the scaled picture may travel on one axis before its edge leaves the
 * frame. A letterboxed picture whose scaled width is still narrower than the
 * frame has no horizontal travel at all; the answer is clamped at zero.
 */
export function panLimit(renderedSize, frameSize, scale) {
  const rendered = Math.max(0, Number(renderedSize) || 0) * clampScale(scale);
  const frame = Math.max(0, Number(frameSize) || 0);
  return Math.max(0, (rendered - frame) / 2);
}

/** Keeps a pan offset inside `[-limit, limit]`, tolerant of junk input. */
export function clampPan(value, limit) {
  const n = Number(value);
  const bound = Math.max(0, Number(limit) || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.min(bound, Math.max(-bound, n));
}

/**
 * Wheel input as a multiplier. Exponential rather than additive, so a notch
 * near 100% moves a little and a notch near 400% moves proportionally; the
 * result is then snapped by the caller through clampScale().
 */
export function wheelScale(current, deltaY) {
  const scale = clampScale(current);
  const delta = Number(deltaY);
  if (!Number.isFinite(delta) || delta === 0) return scale;
  return clampScale(scale * Math.exp(-delta * 0.0015));
}

/**
 * True when a wheel event belongs to the picture.
 *
 * Ctrl/Meta+wheel is the browser's page zoom (and the way a trackpad reports a
 * pinch); it must pass through untouched. Shift+wheel scrolls horizontally and
 * is not a zoom gesture either.
 */
export function isZoomWheel(event) {
  if (!event) return false;
  return !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/**
 * Bind zoom to one frame.
 *
 * options:
 *   onChange(state)   { scale, label, zoomed, ready } after every change;
 *                     `ready` is false while an <img> has not decoded or broke,
 *                     which is what hides the controls for a bad picture.
 *   onInteract()      a zoom or drag began: the gallery swipe cancels its
 *                     pending start so a drag is never also a photo change.
 *
 * Returns { attach, detach, reset, zoomIn, zoomOut, fit, destroy, state }.
 */
export function createImageZoom(options) {
  const opts = options || {};
  let frame = null;
  let media = null;
  let scale = ZOOM_MIN;
  let panX = 0;
  let panY = 0;
  let ready = false;
  let destroyed = false;
  let resizeObserver = null;
  /** The one pointer that owns a drag; more than one means a pinch. */
  const pointers = new Set();
  let start = null;
  let releaseImage = null;

  const state = () => ({
    scale,
    label: zoomLabel(scale),
    zoomed: scale > ZOOM_MIN + 1e-3,
    ready: Boolean(frame && media && ready),
  });

  const emit = () => {
    if (destroyed || typeof opts.onChange !== 'function') return;
    opts.onChange(state());
  };

  const interact = () => {
    if (typeof opts.onInteract === 'function') opts.onInteract();
  };

  function limits() {
    if (!frame || !media) return { x: 0, y: 0 };
    // offsetWidth/offsetHeight, NOT getBoundingClientRect(): the rect already
    // includes the inline scale, so measuring it at 300% and multiplying again
    // would allow nine times the real overflow and let the picture be dragged
    // into empty space. The layout box is the fitted size; the multiplier is
    // applied here exactly once.
    const fittedWidth = media.offsetWidth || 0;
    const fittedHeight = media.offsetHeight || 0;
    return {
      x: panLimit(fittedWidth, frame.clientWidth, scale),
      y: panLimit(fittedHeight, frame.clientHeight, scale),
    };
  }

  function settlePan() {
    if (scale <= ZOOM_MIN + 1e-3) {
      scale = ZOOM_MIN;
      panX = 0;
      panY = 0;
      return;
    }
    const limit = limits();
    panX = clampPan(panX, limit.x);
    panY = clampPan(panY, limit.y);
  }

  function apply() {
    if (!media) { emit(); return; }
    settlePan();
    // translate precedes scale, so the numbers stay in screen pixels and the
    // browser can clamp them against the frame's real box.
    media.style.transform = scale === ZOOM_MIN
      ? ''
      : 'translate3d(' + panX.toFixed(2) + 'px,' + panY.toFixed(2) + 'px,0) scale(' + scale + ')';
    frame.classList.toggle('is-zoomed', scale > ZOOM_MIN + 1e-3);
    emit();
  }

  /** Set a multiplier, optionally keeping the point under `anchor` fixed. */
  function setScale(next, anchor) {
    if (!frame || !media || !ready) return;
    const target = clampScale(next);
    if (Math.abs(target - scale) < 1e-6) return;
    const wasZoomed = scale > ZOOM_MIN + 1e-3;
    if (anchor && scale > 0 && target > ZOOM_MIN + 1e-3) {
      const ratio = target / scale;
      panX = anchor.x - (anchor.x - panX) * ratio;
      panY = anchor.y - (anchor.y - panY) * ratio;
    }
    scale = target;
    if (scale <= ZOOM_MIN + 1e-3) {
      scale = ZOOM_MIN;
      panX = 0;
      panY = 0;
    }
    apply();
    if (scale !== ZOOM_MIN || !wasZoomed) interact();
  }

  function reset() {
    if (!media) return;
    scale = ZOOM_MIN;
    panX = 0;
    panY = 0;
    apply();
  }

  /* ── pointer drag: mouse and touch share one path ─────────────── */
  function onPointerDown(event) {
    if (!ready || scale <= ZOOM_MIN + 1e-3) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.add(event.pointerId);
    if (pointers.size > 1) {
      // A second finger is a pinch, not a pan: hand it back to the platform.
      start = null;
      return;
    }
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
    frame.classList.add('is-panning');
    try { frame.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
    interact();
  }

  function onPointerMove(event) {
    if (!start || event.pointerId !== start.id || pointers.size !== 1) return;
    event.preventDefault();
    panX = clampPan(start.panX + (event.clientX - start.x), limits().x);
    panY = clampPan(start.panY + (event.clientY - start.y), limits().y);
    media.style.transform = 'translate3d(' + panX.toFixed(2) + 'px,' + panY.toFixed(2) + 'px,0) scale(' + scale + ')';
  }

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (!start || event.pointerId !== start.id) return;
    start = null;
    frame.classList.remove('is-panning');
    try { frame.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }

  function onPointerCancel(event) {
    pointers.delete(event.pointerId);
    if (start && event.pointerId === start.id) {
      start = null;
      frame.classList.remove('is-panning');
    }
  }

  /* ── shortcuts ───────────────────────────────────────────────── */
  function onDoubleClick(event) {
    if (!ready) return;
    event.preventDefault();
    if (scale > ZOOM_MIN + 1e-3) reset();
    else setScale(2);
  }

  function onWheel(event) {
    if (!ready || !isZoomWheel(event)) return;
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    const anchor = {
      x: event.clientX - (rect.left + rect.width / 2),
      y: event.clientY - (rect.top + rect.height / 2),
    };
    setScale(wheelScale(scale, event.deltaY), anchor);
  }

  function onResize() {
    if (frame && media) apply();
  }

  /** An <img> fallback is only zoomable once the bytes decoded. */
  function watchImage(image) {
    ready = false;
    const loaded = () => {
      ready = Boolean(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
      emit();
    };
    const failed = () => {
      ready = false;
      emit();
    };
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
    releaseImage = () => {
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    };
    loaded();
  }

  function detach() {
    if (frame) {
      frame.removeEventListener('pointerdown', onPointerDown);
      frame.removeEventListener('pointermove', onPointerMove);
      frame.removeEventListener('pointerup', endPointer);
      frame.removeEventListener('pointercancel', onPointerCancel);
      frame.removeEventListener('lostpointercapture', endPointer);
      frame.removeEventListener('dblclick', onDoubleClick);
      frame.removeEventListener('wheel', onWheel);
      frame.classList.remove('is-zoomed', 'is-panning');
    }
    if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (releaseImage) { releaseImage(); releaseImage = null; }
    frame = null;
    media = null;
    ready = false;
    pointers.clear();
    start = null;
    scale = ZOOM_MIN;
    panX = 0;
    panY = 0;
    emit();
  }

  function attach(nextFrame) {
    detach();
    if (destroyed || !nextFrame) return;
    frame = nextFrame;
    media = frame.querySelector('.picture-canvas,.preview-media');
    if (!media) { frame = null; emit(); return; }
    frame.addEventListener('pointerdown', onPointerDown);
    frame.addEventListener('pointermove', onPointerMove);
    frame.addEventListener('pointerup', endPointer);
    frame.addEventListener('pointercancel', onPointerCancel);
    frame.addEventListener('lostpointercapture', endPointer);
    frame.addEventListener('dblclick', onDoubleClick);
    // Not passive: a plain wheel zooms the picture instead of scrolling the
    // drawer. Ctrl/Meta+wheel is filtered out before preventDefault.
    frame.addEventListener('wheel', onWheel, { passive: false });
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(frame);
    }
    if (String(media.tagName).toUpperCase() === 'IMG') watchImage(media);
    else ready = true;
    apply();
  }

  return {
    attach,
    detach,
    reset,
    fit: reset,
    zoomIn: () => setScale(stepScale(scale, 1)),
    zoomOut: () => setScale(stepScale(scale, -1)),
    setScale,
    get scale() { return scale; },
    get zoomed() { return scale > ZOOM_MIN + 1e-3; },
    state,
    destroy() {
      detach();
      destroyed = true;
    },
  };
}
