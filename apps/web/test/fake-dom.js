/*
 * fake-dom.js — the smallest DOM the client's overlay code actually touches.
 *
 * The header of focus-trap.test.js explains why these tests drive fakes: a
 * browser check that dispatches events straight at a panel cannot tell "focus
 * moved" from "focus was silently dropped on <body>". This module goes one step
 * further and implements enough of document/element to *run* ui.js and
 * sidebar.js for real, so a test asserts the code path the user hits instead of
 * a re-implementation of it.
 *
 * Supported, and nothing more:
 *   - createElement / createTextNode / template (for dom.js raw())
 *   - attributes, className + classList, dataset, style
 *   - appendChild / remove / children / parentElement / closest
 *   - querySelector(All) with tag, .class, [attr], [attr="value"], :not([attr])
 *     and descendant combinators
 *   - listeners, focus(), contains(), isConnected, offsetParent
 */

const ELEMENT_NODE = 1;

function kebab(name) {
  return String(name).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
}

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }
}

export class FakeElement {
  constructor(tagName) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.offsetParent = {};
    this.disabled = false;
    this._text = '';
    this._classes = new Set();
  }

  /* ── text ───────────────────────────────────────────────────── */
  get textContent() {
    let text = this._text;
    for (const child of this.childNodes) text += child.textContent;
    return text;
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value);
  }

  /* ── identity ───────────────────────────────────────────────── */
  get isConnected() {
    let node = this;
    while (node) {
      if (node === globalThis.document.body) return true;
      node = node.parentNode;
    }
    return false;
  }

  /* ── classes ────────────────────────────────────────────────── */
  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const element = this;
    return {
      add: (...names) => { for (const name of names) element._classes.add(name); },
      remove: (...names) => { for (const name of names) element._classes.delete(name); },
      contains: (name) => element._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !element._classes.has(name) : !!force;
        if (on) element._classes.add(name);
        else element._classes.delete(name);
        return on;
      },
    };
  }

  /* ── attributes ─────────────────────────────────────────────── */
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'class') this.className = value;
    if (name === 'disabled') this.disabled = true;
  }

  getAttribute(name) {
    const value = this.attributes.get(String(name));
    return value === undefined ? null : value;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
    if (name === 'disabled') this.disabled = false;
  }

  get dataset() {
    const element = this;
    return new Proxy({}, {
      get: (target, prop) => {
        const value = element.getAttribute('data-' + kebab(prop));
        return value === null ? undefined : value;
      },
      set: (target, prop, value) => { element.setAttribute('data-' + kebab(prop), String(value)); return true; },
      has: (target, prop) => element.hasAttribute('data-' + kebab(prop)),
    });
  }

  /* ── tree ───────────────────────────────────────────────────── */
  get children() {
    return this.childNodes.filter((node) => node.nodeType === ELEMENT_NODE);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === ELEMENT_NODE) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ── queries ────────────────────────────────────────────────── */
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  /* ── events ─────────────────────────────────────────────────── */
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    const set = this.listeners.get(type);
    if (set) set.delete(handler);
  }

  /** Test helper: run the handlers registered for one event type. */
  emit(type, event) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) handler(event);
  }

  /* ── focus ──────────────────────────────────────────────────── */
  focus(options) {
    // A real browser ignores focus() on an element that is not focusable — the
    // bug that hid behind "the heading gets focus" was exactly this silence, so
    // the fake refuses the same way instead of being more forgiving.
    if (!this.isConnected || !isProgrammaticallyFocusable(this)) return;
    globalThis.document.activeElement = this;
    this.lastFocusOptions = options || null;
    this.focused = (this.focused || 0) + 1;
  }

  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = globalThis.document.body;
  }

  /**
   * Layout for the tests: every element sits in a 120x24 box at the origin, which
   * is all the menu positioner and the "is the anchor still visible" check read.
   * A test that cares about geometry assigns `rect` directly.
   */
  getBoundingClientRect() {
    return this.rect || (this.rect = { left: 0, top: 40, right: 120, bottom: 64, width: 120, height: 24 });
  }

  /* Everything is "laid out": the visibility filter is exercised explicitly by
   * setting offsetParent = null in the one test that needs it. */
  get offsetHeight() { return 24; }
}

const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);

/**
 * What a browser will actually focus from script: an interactive control, or
 * anything carrying a tabindex. An <h1> is neither — the reason focus.js adds
 * tabindex="-1" before it calls focus().
 */
function isProgrammaticallyFocusable(element) {
  if (FOCUSABLE_TAGS.has(element.tagName)) return !element.hasAttribute('disabled');
  return element.hasAttribute('tabindex');
}

/* ── selector matching ──────────────────────────────────────────── */
function matches(element, selector) {
  if (!selector) return false;
  return String(selector).split(',').some((part) => matchCompound(element, part.trim()));
}

function matchCompound(element, selector) {
  const steps = selector.split(/\s+/).filter(Boolean);
  if (!steps.length) return false;
  if (!matchSimple(element, steps[steps.length - 1])) return false;
  let ancestor = element.parentElement;
  for (let index = steps.length - 2; index >= 0; index -= 1) {
    let found = null;
    while (ancestor) {
      if (matchSimple(ancestor, steps[index])) { found = ancestor; break; }
      ancestor = ancestor.parentElement;
    }
    if (!found) return false;
    ancestor = found.parentElement;
  }
  return true;
}

function matchSimple(element, selector) {
  let rest = selector.trim();
  // :not([attr]) — the only pseudo-class this code base uses in a query.
  const negated = [];
  rest = rest.replace(/:not\(\[([\w-]+)\]\)/g, (whole, name) => { negated.push(name); return ''; });
  if (negated.some((name) => element.hasAttribute(name))) return false;

  const tag = rest.match(/^[a-zA-Z][\w-]*/);
  if (tag && element.tagName !== tag[0].toUpperCase()) return false;
  if (tag) rest = rest.slice(tag[0].length);

  for (const cls of rest.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(cls[1])) return false;
  }

  for (const id of rest.matchAll(/#([\w-]+)/g)) {
    if (element.getAttribute('id') !== id[1]) return false;
  }

  for (const attr of rest.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
    const name = attr[1];
    if (!element.hasAttribute(name)) return false;
    const expected = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4];
    if (expected !== undefined && element.getAttribute(name) !== expected) return false;
  }
  return true;
}

/* ── document + window ──────────────────────────────────────────── */
class FakeTemplate {
  constructor() {
    this._html = '';
    this.content = {
      firstElementChild: null,
    };
  }

  set innerHTML(value) {
    this._html = String(value);
    const tag = /^\s*<([a-zA-Z][\w-]*)/.exec(this._html);
    this.content.firstElementChild = new FakeElement(tag ? tag[1] : 'div');
  }

  get innerHTML() {
    return this._html;
  }
}

export function installFakeDom() {
  const body = new FakeElement('body');
  const listenerMap = new Map();
  const document = {
    activeElement: body,
    body,
    documentElement: new FakeElement('html'),
    createElement(tag) {
      if (String(tag).toLowerCase() === 'template') return new FakeTemplate();
      return new FakeElement(tag);
    },
    createTextNode(text) { return new FakeText(text); },
    addEventListener(type, handler) {
      if (!listenerMap.has(type)) listenerMap.set(type, new Set());
      listenerMap.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      const set = listenerMap.get(type);
      if (set) set.delete(handler);
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === body) return true;
        current = current.parentNode;
      }
      return false;
    },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
  document.listeners = listenerMap;
  document.emit = (type, event) => {
    const set = listenerMap.get(type);
    if (set) for (const handler of [...set]) handler(event);
  };

  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    listeners: new Map(),
    addEventListener(type, handler) {
      if (!window.listeners.has(type)) window.listeners.set(type, new Set());
      window.listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      const set = window.listeners.get(type);
      if (set) set.delete(handler);
    },
  };

  globalThis.document = document;
  globalThis.window = window;
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  return { document, window, body };
}

/** A keyboard event good enough for the client's handlers. */
export function keyEvent(key, options) {
  const opts = options || {};
  const event = {
    key,
    shiftKey: !!opts.shiftKey,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.propagationStopped = true; },
    target: opts.target || null,
  };
  return event;
}
