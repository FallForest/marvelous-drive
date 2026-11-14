/*
 * ui.js — overlay primitives shared by every view: toast stack, modal
 * dialogs (focus trapped), drawers, anchored menus, confirm/prompt helpers.
 * One overlay stack makes Escape close exactly one layer at a time.
 */

import { h, append, raw, trapFocus } from './dom.js';
import { icon } from './format.js';
import { DURATION, markAnimating, prefersReducedMotion } from './motion.js';

/* ── overlay stack: Escape closes the topmost layer only ──────── */
const layers = [];
export function pushLayer(close) {
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
  layers.pop();
  try { top.close(); } catch (error) { console.warn('[mdrive] overlay close failed', error); }
  return true;
}
export function hasLayers() { return layers.length > 0; }

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
  requestAnimationFrame(() => {
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
 * drawer({ title, sub, body, footer, width, className, onClose })
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
  append(body, [opts.body]);
  append(footer, [opts.footer]);
  if (!footer.childElementCount) footer.remove();

  const scrim = h('div', {
    class: 'scrim scrim-drawer',
    on: { mousedown: (event) => { if (event.target === scrim) handle.close(); } },
  }, panel);
  document.body.appendChild(scrim);
  const release = trapFocus(panel);
  const pop = pushLayer(() => handle.close());
  const handle = {
    el: panel, body, footer, scrim, closed: false,
    close() {
      if (handle.closed) return;
      handle.closed = true;
      release();
      pop();
      dismissOverlay(panel, scrim);
      if (typeof opts.onClose === 'function') opts.onClose();
    },
  };
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
 * openMenu({ anchor, items, align }) — items:
 *   { label, icon, kbd, danger, disabled, onSelect }
 *   { separator: true } | { heading: '分组名' }
 * Returns { close }.
 */
export function openMenu(options) {
  const opts = options || {};
  const anchor = opts.anchor;
  const menu = h('div', {
    class: 'menu',
    attrs: { role: opts.role || 'menu', 'aria-label': opts.label || null },
  });

  const onOutside = (event) => {
    if (!menu.contains(event.target) && !(anchor && anchor.contains(event.target))) close();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      if (anchor) anchor.focus();
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
    items[next].focus();
  };
  const close = () => {
    if (!menu.isConnected) return;
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    releaseLayer();
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
  };

  for (const item of opts.items || []) {
    if (!item) continue;
    if (item.separator) { menu.appendChild(h('div', { class: 'menu-sep', attrs: { role: 'separator' } })); continue; }
    if (item.heading) { menu.appendChild(h('div', { class: 'menu-label', text: item.heading })); continue; }
    // A checked row is a choice, not a command: it gets the tick and the
    // aria state, so a select built on this menu is readable to a screen reader
    // as a listbox rather than as a pile of buttons.
    menu.appendChild(h('button', {
      class: 'menu-item'
        + (item.danger ? ' is-danger' : '')
        + (item.checked ? ' is-checked' : ''),
      attrs: {
        type: 'button',
        role: opts.role || (item.checked !== undefined ? 'menuitemradio' : 'menuitem'),
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
  const rect = anchor ? anchor.getBoundingClientRect() : { left: 12, top: 12, bottom: 12, right: 12, width: 0 };
  const menuRect = menu.getBoundingClientRect();
  const align = opts.align || 'end';
  if (align === 'start') menu.classList.add('is-start');
  let left = align === 'end' ? rect.right - menuRect.width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - 8) {
    // Opening upward: the menu has to arrive from the bottom edge, or it looks
    // detached from the anchor it is attached to. The class flips the keyframe
    // and the transform-origin together.
    top = Math.max(8, rect.top - menuRect.height - 4);
    menu.classList.add('is-up');
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  markAnimating(menu);
  if (anchor) anchor.setAttribute('aria-expanded', 'true');

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  const releaseLayer = pushLayer(close);
  requestAnimationFrame(() => { const first = menu.querySelector('.menu-item'); if (first) first.focus(); });
  return { close };
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