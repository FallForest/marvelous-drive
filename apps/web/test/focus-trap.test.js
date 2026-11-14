import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { trapFocus } from '../lib/dom.js'

/**
 * The focus contract, driven with fakes.
 *
 * Both bugs this guards against were invisible to a browser check that
 * dispatched events straight at a panel:
 *
 *  - focusing synchronously, before the panel was in the document, was silently
 *    ignored, so a real key press went to <body>;
 *  - `disabled` on the prev/next buttons dropped focus to <body> at the ends.
 *
 * A fake document makes "did focus actually land" an assertion instead of a hope.
 */

function makeElement(tag, { focusable = false, connected = true } = {}) {
  const element = {
    tagName: tag.toUpperCase(),
    className: '',
    offsetParent: connected ? {} : null,
    hasAttribute: () => false,
    isConnected: connected,
    listeners: {},
    focused: false,
    focus(options) {
      if (!element.isConnected) return;
      document.activeElement = element;
      element.focused = true;
      element.lastFocusOptions = options || null;
    },
    addEventListener(type, handler) { element.listeners[type] = handler; },
    removeEventListener(type) { delete element.listeners[type]; },
    querySelectorAll: () => [],
    contains(other) { return other === element; },
  };
  return element;
}

const document = {
  activeElement: null,
  body: null,
  contains: () => true,
  querySelector: () => null,
};

beforeEach(() => {
  document.activeElement = makeElement('body');
  document.body = document.activeElement;
  globalThis.document = document;
  // Run the deferred callback immediately: the point of the fix is *when*
  // focus happens, and a synchronous shim keeps the assertion readable.
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
});

describe('trapFocus', () => {
  it('focuses the first control once the panel is connected', () => {
    const panel = makeElement('div');
    panel.querySelectorAll = () => [makeElement('button', { focusable: true }), makeElement('button', { focusable: true })];
    trapFocus(panel);
    assert.equal(document.activeElement.tagName, 'BUTTON');
  });

  it('does not focus a detached panel', () => {
    document.activeElement = document.body;
    const panel = makeElement('div', { connected: false });
    panel.querySelectorAll = () => [makeElement('button', { connected: false })];
    trapFocus(panel);
    assert.equal(document.activeElement, document.body);
  });

  it('focuses the panel itself when it holds no controls', () => {
    const panel = makeElement('div');
    panel.querySelectorAll = () => [];
    trapFocus(panel);
    assert.equal(document.activeElement, panel);
  });

  it('restores focus to the opener on release', () => {
    const opener = makeElement('button');
    document.activeElement = opener;
    const panel = makeElement('div');
    panel.querySelectorAll = () => [makeElement('button')];
    const release = trapFocus(panel);
    release();
    assert.equal(document.activeElement, opener);
  });

  it('never restores focus to <body> as if it were an opener', () => {
    document.activeElement = document.body;
    const main = makeElement('main');
    main.focus = function focus() { document.activeElement = main; };
    document.querySelector = () => main;
    const panel = makeElement('div');
    panel.querySelectorAll = () => [makeElement('button')];
    const release = trapFocus(panel);
    release();
    assert.notEqual(document.activeElement, document.body);
  });

  it('removes its key listener on release', () => {
    const panel = makeElement('div');
    panel.querySelectorAll = () => [makeElement('button')];
    const release = trapFocus(panel);
    assert.ok(panel.listeners.keydown, 'listener installed');
    release();
    assert.equal(panel.listeners.keydown, undefined);
  });
});
