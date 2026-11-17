/* Start authenticated image requests near the viewport, with a bounded queue. */
export function createThumbnailLoader(options = {}) {
  const limit = options.concurrency || 4;
  const Observer = options.Observer ?? globalThis.IntersectionObserver;
  const Changes = options.Changes ?? globalThis.MutationObserver;
  const waiting = new Map();
  const queue = [];
  let active = 0;
  let observer;
  let changes;

  function drain() {
    while (active < limit && queue.length) {
      const { element, load } = queue.shift();
      if (!element.isConnected) continue;
      active += 1;
      Promise.resolve().then(load).catch(() => {}).finally(() => { active -= 1; drain(); });
    }
  }

  function ready(element) {
    const load = waiting.get(element);
    if (!load) return;
    waiting.delete(element);
    observer?.unobserve(element);
    queue.push({ element, load });
    drain();
  }

  function sweep() {
    for (const element of waiting.keys()) {
      if (!element.isConnected) { waiting.delete(element); observer?.unobserve(element); }
    }
  }

  return {
    watch(element, load) {
      waiting.set(element, load);
      if (Observer) {
        observer ||= new Observer((entries) => {
          for (const entry of entries) if (entry.isIntersecting) ready(entry.target);
        }, { rootMargin: '160px' });
        observer.observe(element);
        if (Changes && !changes && globalThis.document?.body) {
          changes = new Changes(sweep);
          changes.observe(document.body, { childList: true, subtree: true });
        }
      } else {
        // Rendering builds detached rows; give the caller time to mount them.
        queueMicrotask(() => ready(element));
      }
    },
  };
}
