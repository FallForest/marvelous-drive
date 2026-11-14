/*
 * dom.js — tiny DOM helpers. No framework, no virtual DOM: elements are
 * created directly and re-created only where re-rendering is cheap.
 */

/** Create an element. props: class, attrs, style, dataset, html, on, value/checked. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && typeof props === 'object') applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined || value === null || value === false) continue;
    switch (key) {
      case 'class':
      case 'className':
        el.className = String(value);
        break;
      case 'html':
        el.innerHTML = String(value);
        break;
      case 'text':
        el.textContent = String(value);
        break;
      case 'style':
        if (typeof value === 'string') el.setAttribute('style', value);
        else for (const prop of Object.keys(value)) {
          const v = value[prop];
          if (v === undefined || v === null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
          else el.style[prop] = v;
        }
        break;
      case 'dataset':
        for (const prop of Object.keys(value)) {
          if (value[prop] === undefined || value[prop] === null) continue;
          el.dataset[prop] = String(value[prop]);
        }
        break;
      case 'on':
        for (const type of Object.keys(value)) {
          if (typeof value[type] === 'function') el.addEventListener(type, value[type]);
        }
        break;
      case 'value':
        el.value = value === null || value === undefined ? '' : String(value);
        break;
      case 'checked':
        el.checked = !!value;
        break;
      case 'ref':
        if (typeof value === 'function') value(el);
        break;
      case 'attrs':
        for (const name of Object.keys(value)) {
          const v = value[name];
          if (v === undefined || v === null || v === false) continue;
          el.setAttribute(name, v === true ? '' : String(v));
        }
        break;
      default:
        if (key.startsWith('aria-') || key === 'role' || key === 'tabindex' || key === 'for' || key === 'id' || key === 'title' || key === 'type' || key === 'placeholder' || key === 'name' || key === 'autocomplete' || key === 'spellcheck' || key === 'inputmode' || key === 'maxlength' || key === 'min' || key === 'max' || key === 'step' || key === 'href' || key === 'target' || key === 'rel' || key === 'download' || key === 'disabled' || key === 'hidden' || key === 'readonly') {
          if (key === 'disabled' || key === 'hidden' || key === 'readonly') {
            if (value) el.setAttribute(key === 'readonly' ? 'readonly' : key, '');
          } else {
            el.setAttribute(key, String(value));
          }
        } else {
          el.setAttribute(key, String(value));
        }
    }
  }
}

export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { append(parent, child); continue; }
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else {
      parent.appendChild(child);
    }
  }
  return parent;
}

/** Build a fragment from a list of children. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Replace all children of an element. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(parent, ...children) {
  clear(parent);
  append(parent, children);
  return parent;
}

/** Parse a trusted HTML string (icons only) into one element. */
export function raw(htmlString) {
  const template = document.createElement('template');
  template.innerHTML = String(htmlString).trim();
  return template.content.firstElementChild;
}

export function qs(selector, root) {
  return (root || document).querySelector(selector);
}

/** Delegated listener: on(root, '.selector', 'click', handler). */
export function on(root, selector, type, handler, options) {
  const listener = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const match = target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

export function debounce(fn, wait) {
  let timer = 0;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = 0; };
  return wrapped;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab / Shift-Tab inside a container. Returns a release function.
 * The caller owns Escape handling so it can decide between "close" and "back".
 */
export function trapFocus(container) {
  const previous = document.activeElement;
  const focusables = () => Array.from(container.querySelectorAll(FOCUSABLE))
    .filter((el) => !el.hasAttribute('hidden') && el.offsetParent !== null);
  const onKey = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) { event.preventDefault(); container.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  // Focus AFTER the panel is in the document and laid out.
  //
  // Focusing synchronously — the caller's node is still detached at that moment
  // — is silently ignored: the element does not exist yet, the browser keeps
  // focus on <body>, and every key handler the panel installed is then dead.
  // A real click on a row proved it: the drawer opened and the arrow keys did
  // nothing, while a synthetic key dispatched straight at the panel worked,
  // which is exactly how this hid from the tests.
  //
  // `previous` is read at RELEASE time, not here: the caller usually opens an
  // overlay from inside a click handler, so at this point the active element is
  // still the old one — but by release time the browser may have moved focus
  // (a row re-render, a toast). What the user expects is "focus goes back where
  // I left it", and the opener is the honest answer.
  const opener = previous && previous !== document.body ? previous : null;
  const focusFirst = () => {
    if (!container.isConnected) return;
    const target = focusables()[0];
    if (target) target.focus();
    else if (typeof container.focus === 'function') container.focus({ preventScroll: true });
    // A panel that lost the race (nothing focusable, or focus was moved on
    // purpose) still needs to be the active element to receive key events.
    if (document.activeElement === document.body && typeof container.focus === 'function') {
      container.focus({ preventScroll: true });
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusFirst);
  else focusFirst();
  return function release() {
    container.removeEventListener('keydown', onKey);
    // Restore in a microtask-free frame: the overlay is removed synchronously
    // after this returns, and focusing a node that is about to be detached is
    // another silent no-op.
    const restore = () => {
      const target = opener && document.contains(opener) ? opener : null;
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
        return;
      }
      // Nothing to go back to: at least do not leave the caret on <body>, where
      // the next Tab restarts from the top of the document.
      if (document.activeElement === document.body) {
        const main = document.querySelector('[data-vt-scope="main"], main');
        if (main && typeof main.focus === 'function') main.focus({ preventScroll: true });
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
  };
}
