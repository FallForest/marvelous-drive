/* Deliberate, single-finger horizontal navigation; native scrolling/zoom stay native. */
export function swipeDelta(start, end, width) {
  if (!start || !end) return 0;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const elapsed = end.time - start.time;
  const threshold = Math.max(44, Math.min(96, (width || 320) * 0.15));
  if (elapsed < 0 || elapsed > 1200 || Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

export function attachGallerySwipe(host, { enabled, onStep }) {
  const pointers = new Set();
  let start = null;
  const viewport = window.visualViewport;
  const zoomed = () => (viewport?.scale || 1) > 1.01;
  const reset = () => { start = null; };
  const updateZoom = () => {
    host.classList.toggle('is-page-zoomed', zoomed());
    reset();
  };
  const onDown = (event) => {
    if (event.pointerType !== 'touch') return;
    pointers.add(event.pointerId);
    if (pointers.size !== 1) { reset(); return; }
    const width = window.innerWidth;
    // Leave the edges to the browser/OS back gesture, and controls to native input.
    if (!enabled() || zoomed() || event.clientX <= 24 || event.clientX >= width - 24
      || event.target.closest?.('button,a,input,textarea,select,video,audio,iframe,[contenteditable="true"]')) return;
    start = { x: event.clientX, y: event.clientY, time: event.timeStamp, id: event.pointerId, width: host.clientWidth };
    try { host.setPointerCapture(event.pointerId); } catch { /* unavailable for synthetic events */ }
  };
  const onMove = (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    // Once the finger commits to a vertical scroll, returning horizontally
    // must not turn that scroll into a photo change.
    if (dy > 12 && dy > dx || zoomed()) reset();
  };
  const onUp = (event) => {
    pointers.delete(event.pointerId);
    const gesture = start;
    reset();
    if (!gesture || event.pointerId !== gesture.id || pointers.size || !enabled() || zoomed()) return;
    const delta = swipeDelta(gesture, { x: event.clientX, y: event.clientY, time: event.timeStamp }, gesture.width);
    if (delta) onStep(delta);
  };
  const onCancel = (event) => { pointers.delete(event.pointerId); reset(); };
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onCancel);
  host.addEventListener('lostpointercapture', reset);
  viewport?.addEventListener('resize', updateZoom);
  updateZoom();
  return {
    cancel: reset,
    destroy() {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onCancel);
      host.removeEventListener('lostpointercapture', reset);
      viewport?.removeEventListener('resize', updateZoom);
      pointers.clear();
      reset();
    },
  };
}
