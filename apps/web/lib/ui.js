/*
 * ui.js — overlay primitives shared by every view: toast stack, modal
 * dialogs (focus trapped), drawers, anchored menus, confirm/prompt helpers.
 * One overlay stack makes Escape close exactly one layer at a time.
 */

import { h, append, raw, trapFocus, focusMain } from './dom.js';
import { FOCUSABLE_SELECTOR, registerPopup, tabCycle, unregisterPopup } from './focus.js';
import { icon } from './format.js';
import { DURATION, markAnimating, prefersReducedMotion } from './motion.js';

/* ── overlay stack: Escape closes the topmost layer only ──────── */
const layers = [];
function pushLayer(close) {
  const entry = { close };
  layers.push(entry);
  return () => {
    const index = layers.indexOf(entry);
    if (index >= 0) layers.splice(index, 1);
  };
}
export function closeTopLayer() {
  const top = layers[layers.length - 1];
  if (!top) return false;
  try { top.close(); } catch (error) { console.warn('[mdrive] overlay close failed', error); }
  return true;
}


/* ── toasts ───────────────────────────────────────────────────── */
let toastHost = null;
function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = h('div', {
    class: 'toast-stack',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions text' },
  });
  document.body.appendChild(toastHost);
  return toastHost;
}

const TOAST_ICON = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };

/**
 * toast('已保存', { type: 'success', title: '重命名', timeout: 3200 })
 * Returns a dismiss function.
 */
export function toast(message, options) {
  const opts = options || {};
  const type = opts.type || 'info';
  const host = ensureToastHost();
  const node = h('div', { class: 'toast is-' + type },
    raw(icon(TOAST_ICON[type] || 'info', 15)),
    h('div', { class: 'toast-text' },
      opts.title ? h('b', { text: opts.title }) : null,
      h('span', { text: String(message || '') }),
      opts.detail ? h('small', { text: String(opts.detail) }) : null,
    ),
    h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', 'aria-label': '关闭提示' },
      on: { click: () => dismiss() },
      html: icon('x', 13),
    }),
  );
  host.appendChild(node);
  // Promote the layer only while the toast is actually moving (rule 2).
  markAnimating(node);
  // Keep the stack short: older notices fall off the top.
  while (host.children.length > 4) host.removeChild(host.firstElementChild);

  let timer = 0;
  let closed = false;
  function dismiss() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    node.classList.add('is-leaving');
    // Unmount on animationend, not on a guessed timeout: the exit is 140ms out
    // and the fallback only has to catch a node that never animates (reduced
    // motion, or the tab being in the background).
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      node.removeEventListener('animationend', onEnd);
      node.remove();
    };
    const onEnd = (event) => { if (event.target === node) remove(); };
    node.addEventListener('animationend', onEnd);
    setTimeout(remove, prefersReducedMotion() ? 0 : DURATION.fast + 120);
  }
  const timeout = opts.timeout === undefined ? (type === 'error' ? 6000 : 3400) : opts.timeout;
  if (timeout > 0) timer = setTimeout(dismiss, timeout);
  node.addEventListener('mouseenter', () => { if (timer) clearTimeout(timer); });
  node.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1600); });
  return dismiss;
}

/* ── dialogs ──────────────────────────────────────────────────── */
/**
 * dialog({ title, description, body, footer, wide, onClose })
 * body/footer may be nodes or factories receiving the dialog handle.
 * Returns { el, scrim, body, footer, close, setBusy, closed }.
 */
export function dialog(options) {
  const opts = options || {};
  const titleId = 'dlg-title-' + Math.random().toString(36).slice(2, 8);
  const body = h('div', { class: 'dialog-body' });
  const footer = h('footer', { class: 'dialog-foot' });
  const head = h('header', { class: 'dialog-head' }, h('h2', { attrs: { id: titleId }, text: opts.title || '' }));
  if (opts.description) head.appendChild(h('p', { text: opts.description }));
  const panel = h('div', {
    class: 'dialog' + (opts.wide ? ' dialog-wide' : ''),
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
  }, head, body, footer);

  const scrim = h('div', {
    class: 'scrim',
    on: { mousedown: (event) => { if (event.target === scrim) handle.close(); } },
  }, panel);
  document.body.appendChild(scrim);

  const handle = {
    el: panel, scrim, body, footer, closed: false,
    close() {
      if (handle.closed) return;
      handle.closed = true;
      releaseFocus();
      releaseLayer();
      // Play the exit before unmounting, but never hold the promise hostage to
      // it: onClose fires now so a confirm() resolves on the same tick.
      dismissOverlay(panel, scrim);
      if (typeof opts.onClose === 'function') opts.onClose();
    },
    setBusy(busy) {
      for (const button of panel.querySelectorAll('.dialog-foot .btn')) button.disabled = !!busy;
    },
  };
  head.appendChild(h('button', {
    class: 'icon-btn', attrs: { type: 'button', 'aria-label': '关闭对话框' },
    html: icon('x', 15), on: { click: () => handle.close() },
  }));

  const fill = (target, content) => {
    if (content === undefined || content === null) return;
    if (typeof content === 'function') append(target, [content(handle)]);
    else append(target, [content]);
  };
  fill(body, opts.body);
  fill(footer, opts.footer);
  if (!footer.childElementCount) footer.remove();

  const releaseFocus = trapFocus(panel);
  const releaseLayer = pushLayer(() => handle.close());
  // Place the caret once the panel is laid out — but only if it is still
  // unclaimed. The frame is not guaranteed to run before the user's next
  // interaction: a dialog opened by a keyboard shortcut can be met with a Tab
  // (or an autofocusing caller) in between, and stealing focus back reads as
  // "this dialog ignores my keys".
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && panel.contains(active)) return;
    const focusTarget = panel.querySelector('[autofocus]') || panel.querySelector('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
    (focusTarget || panel).focus();
  });
  return handle;
}

/** confirm dialog → Promise<boolean>; resolves false on Escape/scrim. */
export function confirmDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); };
    dialog({
      title: opts.title || '请确认',
      description: opts.description || '',
      body: opts.body || null,
      onClose: () => finish(false),
      footer: (dlg) => [
        h('button', { class: 'btn', attrs: { type: 'button' }, text: opts.cancelLabel || '取消', on: { click: () => dlg.close() } }),
        h('span', { class: 'push' }),
        h('button', {
          class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
          attrs: { type: 'button' },
          text: opts.confirmLabel || '确认',
          on: { click: () => { finish(true); dlg.close(); } },
        }),
      ],
    });
  });
}

/** prompt dialog for one text value → Promise<string|null> (null on cancel). */
export function promptDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let settled = false;
    const errorLine = h('p', { class: 'field-error', attrs: { hidden: 'hidden' } });
    const input = h('input', {
      class: 'input',
      attrs: {
        // `type` and `placeholder` are what make the same dialog usable for a name
        // and for an e-mail (`ui-validate`), without a second prompt component.
        type: opts.type || 'text',
        autofocus: 'autofocus', maxlength: opts.maxlength || 255,
        placeholder: opts.placeholder || null,
        'aria-label': opts.label || opts.title || '名称', 'aria-describedby': '',
      },
      value: opts.value || '',
    });
    const field = h('div', { class: 'field' },
      h('label', { text: opts.label || '名称' }),
      input,
      errorLine,
    );
    const submit = (dlg) => {
      const value = input.value.trim();
      if (!value) {
        errorLine.textContent = '名称不能为空。';
        errorLine.removeAttribute('hidden');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      settled = true;
      resolve(value);
      dlg.close();
    };
    let handle = null;
    handle = dialog({
      title: opts.title || '重命名',
      description: opts.description || '',
      body: field,
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
      footer: () => [
        h('button', { class: 'btn', attrs: { type: 'button' }, text: '取消', on: { click: () => handle.close() } }),
        h('span', { class: 'push' }),
        h('button', {
          class: 'btn btn-primary', attrs: { type: 'button' }, text: opts.confirmLabel || '保存',
          on: { click: () => submit(handle) },
        }),
      ],
    });
    input.addEventListener('input', () => {
      errorLine.setAttribute('hidden', 'hidden');
      input.removeAttribute('aria-invalid');
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submit(handle); }
    });
  });
}

/* ── drawer ───────────────────────────────────────────────────── */
/**
 * drawer({ title, sub, body, footer, width, className, beforeClose, onClose })
 * beforeClose(handle) may asynchronously veto with false; close resolves to
 * whether the drawer closed. Body/footer may be factories receiving the handle.
 * Slides from the right, traps focus, Escape closes it.
 */
export function drawer(options) {
  const opts = options || {};
  const titleId = 'drw-title-' + Math.random().toString(36).slice(2, 8);
  const body = h('div', { class: 'drawer-body' });
  const footer = h('div', { class: 'drawer-foot' });
  const closeBtn = h('button', {
    class: 'icon-btn', attrs: { type: 'button', 'aria-label': '关闭' }, html: icon('x', 15),
    on: { click: () => handle.close() },
  });
  const panel = h('aside', {
    class: 'drawer' + (opts.className ? ' ' + opts.className : ''),
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    style: opts.width ? { width: opts.width } : undefined,
  },
    h('header', { class: 'drawer-head' },
      h('h2', { attrs: { id: titleId } },
        h('span', { class: 'title-text', text: opts.title || '' }),
        opts.sub ? h('span', { class: 'sub', text: opts.sub }) : null,
      ),
      opts.headActions || null,
      closeBtn,
    ),
    body,
    footer,
  );
  const scrim = h('div', {
    class: 'scrim scrim-drawer',
    on: { mousedown: (event) => { if (event.target === scrim) handle.close(); } },
  }, panel);
  document.body.appendChild(scrim);
  const release = trapFocus(panel);
  const pop = pushLayer(() => handle.close());
  let pendingClose = null;
  const finishClose = () => {
    if (handle.closed) return true;
    handle.closed = true;
    release();
    pop();
    dismissOverlay(panel, scrim);
    if (typeof opts.onClose === 'function') opts.onClose();
    return true;
  };
  const handle = {
    el: panel, body, footer, scrim, closed: false,
    close() {
      if (handle.closed) return Promise.resolve(true);
      if (pendingClose) return pendingClose;
      if (typeof opts.beforeClose !== 'function') return Promise.resolve(finishClose());
      pendingClose = Promise.resolve().then(() => opts.beforeClose(handle))
        .then((allowed) => allowed === false ? false : finishClose())
        .catch((error) => { console.warn('[mdrive] drawer close cancelled', error); return false; })
        .finally(() => { pendingClose = null; });
      return pendingClose;
    },
  };
  append(body, [typeof opts.body === 'function' ? opts.body(handle) : opts.body]);
  append(footer, [typeof opts.footer === 'function' ? opts.footer(handle) : opts.footer]);
  if (!footer.childElementCount) footer.remove();
  return handle;
}

/**
 * Play an overlay's exit, then remove it.
 *
 * Two rules from the motion system are load-bearing here:
 *  - the exit is quicker than the entrance (140ms out against 220ms in), so the
 *    scrim fades on --duration-fast and the panel follows on the same beat;
 *  - the node is removed on animationend of the *panel*, not on a timer. The
 *    fallback timer only has to cover "the animation never ran" (reduced motion,
 *    background tab, a panel that was already display:none).
 */
function dismissOverlay(panel, scrim) {
  if (prefersReducedMotion()) { scrim.remove(); return; }
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    panel.removeEventListener('animationend', onEnd);
    scrim.remove();
  };
  const onEnd = (event) => { if (event.target === panel) remove(); };
  scrim.classList.add('is-closing');
  panel.classList.add('is-closing');
  panel.addEventListener('animationend', onEnd);
  setTimeout(remove, DURATION.fast + 120);
}

/* ── anchored menu ────────────────────────────────────────────── */
/**
 * openMenu({ anchor, items, align, label, role, trap }) — items:
 *   { label, icon, kbd, danger, disabled, checked, onSelect }
 *   { separator: true } | { heading: '分组名' }
 * `label` names the menu itself; `trap` overrides which container the Tab cycle
 * belongs to (it defaults to the open dialog).
 * Returns { close }.
 *
 * The focused menu is part of the modal's tab cycle while it is open: it is
 * appended to <body>, so without registering it the dialog's trap could not see
 * it and Tab walked straight out of both (see lib/focus.js).
 */
export function openMenu(options) {
  const opts = options || {};
  const anchor = opts.anchor;
  const role = opts.role || 'menu';
  const menu = h('div', {
    class: 'menu',
    attrs: {
      role,
      'aria-label': opts.label || null,
      // A menu that replaced a <select> keeps the field's own label as its
      // accessible name, so the popup announces *what* it chooses.
      'aria-orientation': role === 'menu' ? 'vertical' : null,
    },
  });

  const onOutside = (event) => {
    if (menu.contains(event.target) || (anchor && anchor.contains(event.target))) return;
    // A click elsewhere is the user choosing a new target: the browser is about
    // to focus it, so do not pull the caret back to the anchor first.
    close({ restore: false });
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const step = event.shiftKey ? -1 : 1;
      const container = opts.trap || activeDialog();
      if (!container) {
        // A toolbar or row menu has no modal to return into: Tab closes it and
        // continues the page's own tab order from the anchor, which is where the
        // user was before the menu existed.
        event.preventDefault();
        event.stopPropagation();
        close({ restore: false });
        moveOnFrom(anchor, step);
        return;
      }
      // Inside a dialog the cycle is the dialog's controls plus this popup, so
      // the neighbour of the last item is the dialog's first control. Focus has
      // to move while the menu is still registered, then the menu closes — the
      // order matters, because closing first would make the menu's own items
      // disappear from the list being stepped through.
      const cycle = tabCycle(container, FOCUSABLE_SELECTOR);
      const items = cycle.length ? cycle : Array.from(menu.querySelectorAll('.menu-item:not([disabled])'));
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      const next = items[(index + step + items.length) % items.length];
      if (!next) return;
      // Handled here means the dialog's trap must not handle it too: it would
      // read the caret's new position as "the user Tabbed past the end" and wrap
      // the focus straight back to the first control.
      event.preventDefault();
      event.stopPropagation();
      if (menu.contains(next)) { next.focus({ preventScroll: true }); return; }
      close({ restore: false });
      next.focus({ preventScroll: true });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const items = Array.from(menu.querySelectorAll('.menu-item:not([disabled])'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    let next = 0;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'End') next = items.length - 1;
    items[next].focus({ preventScroll: true });
  };
  let closed = false;
  const close = (closeOptions) => {
    if (closed) return;
    closed = true;
    // Where the caret is at the moment of closing decides where it goes back to.
    // A chosen item, Escape or Tab all remove the element the caret is standing
    // on, so the anchor takes it back; an outside click leaves the caret to the
    // control the user actually aimed at.
    const active = document.activeElement;
    const allowed = !closeOptions || closeOptions.restore !== false;
    const restore = allowed && Boolean(anchor) && (!active || active === document.body || menu.contains(active));
    menu.remove();
    // Unregister before the removal is observable to anyone else: the trap's
    // cycle must not still contain the items that are about to be detached.
    unregisterPopup(menu);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScroll, true);
    releaseLayer();
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    if (restore) focusAnchor(anchor);
  };

  for (const item of opts.items || []) {
    if (!item) continue;
    if (item.separator) { menu.appendChild(h('div', { class: 'menu-sep', attrs: { role: 'separator' } })); continue; }
    if (item.heading) { menu.appendChild(h('div', { class: 'menu-label', text: item.heading })); continue; }
    // A checked row is a choice, not a command: it gets the tick and the
    // aria state, so a select built on this menu is a radio group of menu items
    // rather than a pile of buttons whose current value is invisible.
    menu.appendChild(h('button', {
      class: 'menu-item'
        + (item.danger ? ' is-danger' : '')
        + (item.checked ? ' is-checked' : ''),
      attrs: {
        type: 'button',
        // The item role follows the item, not the container: passing a container
        // role must not turn every row into a nested menu.
        role: item.role || (item.checked !== undefined ? 'menuitemradio' : 'menuitem'),
        'aria-checked': item.checked === undefined ? null : (item.checked ? 'true' : 'false'),
        disabled: item.disabled || undefined,
      },
      on: { click: () => { close(); if (item.onSelect) item.onSelect(); } },
    },
    raw(icon(item.icon || (item.checked === undefined ? 'file' : item.checked ? 'check' : 'blank'), 15)),
    h('span', { text: item.label }),
    item.kbd ? h('kbd', { text: item.kbd }) : null));
  }

  document.body.appendChild(menu);
  const align = opts.align || 'end';
  if (align === 'start') menu.classList.add('is-start');
  place(align);
  markAnimating(menu);
  if (anchor) anchor.setAttribute('aria-expanded', 'true');

  /**
   * Put the popup next to the anchor, now.
   *
   * Runs again on every scroll: the menu is positioned in viewport coordinates
   * and is appended to <body>, so it does not travel with the control it belongs
   * to. Re-measuring is what keeps it attached instead of closing on the first
   * wheel tick.
   */
  function place(currentAlign) {
    const rect = anchor ? anchor.getBoundingClientRect() : { left: 12, top: 12, bottom: 12, right: 12, width: 0 };
    const menuRect = menu.getBoundingClientRect();
    let left = currentAlign === 'end' ? rect.right - menuRect.width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    let top = rect.bottom + 4;
    const up = top + menuRect.height > window.innerHeight - 8;
    if (up) {
      top = Math.max(8, rect.top - menuRect.height - 4);
    }
    // Opening upward: the menu has to arrive from the bottom edge, or it looks
    // detached from the anchor it is attached to. The class flips the keyframe
    // and the transform-origin together.
    menu.classList.toggle('is-up', up);
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  /**
   * Scrolling follows the anchor; only losing it entirely closes the menu.
   *
   * Closing on every scroll event was wrong twice: the menu's own opening
   * focus() scrolls the item into view (so a menu closed itself the instant it
   * opened), and a two-pixel wheel tick in a long page threw away a menu the
   * user was still looking at.
   */
  const onScroll = () => {
    if (!anchor) { close({ restore: false }); return; }
    const rect = anchor.getBoundingClientRect();
    const gone = rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth;
    if (gone) { close({ restore: false }); return; }
    place(align);
  };

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', onScroll, true);
  const releaseLayer = pushLayer(close);
  registerPopup(menu);
  // preventScroll on every focus inside a popup: focusing an item must not move
  // the page out from under the control the popup is attached to.
  requestAnimationFrame(() => { const first = menu.querySelector('.menu-item'); if (first) first.focus({ preventScroll: true }); });
  // `el` lets a caller move the caret inside the popup on open (Down/Up on a
  // menu button starts on the first/last row, per APG).
  return { close, el: menu };
}

/**
 * Where focus goes when a menu closes while the caret is inside it (Escape, a
 * chosen item, Tab out): the anchor is the honest answer — "you are back on the
 * control you opened". If the anchor was re-rendered away underneath the menu,
 * the page column is the fallback, because leaving the caret on <body> restarts
 * the next Tab at the top of the document.
 */
function focusAnchor(anchor) {
  if (anchor && anchor.isConnected !== false && typeof anchor.focus === 'function') {
    anchor.focus({ preventScroll: true });
    return;
  }
  focusMain();
}

/** Steps the caret one tab stop away from `from` in document order. */
function moveOnFrom(from, step) {
  const all = Array.from(document.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
  const index = all.indexOf(from);
  if (index < 0) { focusMain(); return; }
  const next = all[(index + step + all.length) % all.length];
  if (next) next.focus({ preventScroll: true });
  else focusMain();
}

/** The modal a popup conceptually belongs to: the topmost open dialog/drawer. */
function activeDialog() {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const dialogEl = dialogs[index];
    if (!dialogEl.classList || !dialogEl.classList.contains('is-closing')) return dialogEl;
  }
  return null;
}

/* ── clipboard ────────────────────────────────────────────────── */
export async function copyText(text) {
  const value = String(text || '');
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* fall through to the legacy path */ }
  }
  const area = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' }, value });
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

/* ── busy button state ────────────────────────────────────────── */
export function withBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent || '';
    button.classList.add('is-busy');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.classList.remove('is-busy');
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
