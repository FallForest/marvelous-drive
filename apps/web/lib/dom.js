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
  const first = focusables()[0];
  if (first) first.focus();
  return function release() {
    container.removeEventListener('keydown', onKey);
    if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
  };
}
