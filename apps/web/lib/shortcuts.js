/*
 * shortcuts.js — the single-key shortcut preference.
 *
 * WCAG 2.1.4 (Character Key Shortcuts) allows three ways to make a one-character
 * shortcut acceptable: turn it off, remap it, or only fire it while a component
 * has focus. The third would break "/" (it is meant to be reachable from
 * anywhere on the page), so this module owns the first: a persisted switch, plus
 * modified alternatives (Ctrl/Cmd+K) that keep working when it is off.
 *
 * The switch lives in localStorage so a keyboard-only user does not have to
 * re-disable the shortcuts on every visit — the same reason the view mode is
 * remembered.
 */

import { h } from './dom.js';
import { dialog, toast } from './ui.js';

const STORAGE_KEY = 'mdrive-shortcuts';

/** The single-character shortcuts the shell installs, as shown in the dialog. */
const SINGLE_KEY_SHORTCUTS = [
  { key: '/', label: '聚焦搜索框' },
  { key: 'R', label: '刷新当前页面' },
];

/** Parses the stored preference. Absent (or unreadable) means the default: on. */
export function parseShortcutPreference(raw) {
  return raw !== 'off';
}

let enabled = readStored();

function readStored() {
  // Imported by node tests as well as the page: no window, no stored preference.
  if (typeof window === 'undefined' || !window.localStorage) return true;
  try {
    return parseShortcutPreference(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return true;
  }
}

function writeStored() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* storage disabled */ }
}

/** True when character keys may run their action. */
export function shortcutsEnabled() {
  return enabled;
}

/** Persists the switch and returns the new state. */
export function setShortcutsEnabled(value) {
  enabled = !!value;
  writeStored();
  return enabled;
}

/**
 * The account-menu entry.
 *
 * A dialog rather than a menu checkbox: the switch is a preference with a
 * consequence ("/ does nothing now"), and a checkbox inside a menu closes the
 * menu on every click, which is exactly how a user loses track of what they
 * just changed.
 */
export function openShortcutSettings() {
  const box = h('input', {
    attrs: { type: 'checkbox', id: 'shortcuts-enabled' },
    checked: enabled,
    on: {
      change: () => {
        const next = setShortcutsEnabled(box.checked);
        toast(next ? '单字符快捷键已启用。' : '单字符快捷键已关闭，Ctrl/Cmd+K 仍可搜索。', {
          type: 'info', timeout: 2600,
        });
      },
    },
  });
  const body = h('div', { class: 'stack', attrs: { style: 'gap:12px' } },
    h('p', { class: 'dialog-note', text: '关闭后，按 / 或 R 不会触发任何动作；工具栏按钮仍然可用。' }),
    h('label', { class: 'field', attrs: { for: 'shortcuts-enabled', style: 'flex-direction:row;align-items:center;gap:8px' } },
      box,
      h('span', { text: '启用单字符快捷键' }),
    ),
    h('div', { class: 'stack', attrs: { style: 'gap:6px' } },
      SINGLE_KEY_SHORTCUTS.map((entry) => h('div', { class: 'row', attrs: { style: 'gap:8px' } },
        h('kbd', { class: 'kbd', text: entry.key }),
        h('span', { class: 'muted', text: entry.label }),
      )),
      h('div', { class: 'row', attrs: { style: 'gap:8px' } },
        h('kbd', { class: 'kbd', text: 'Ctrl/Cmd+K' }),
        h('span', { class: 'muted', text: '聚焦搜索框（始终可用）' }),
      ),
    ),
  );
  dialog({
    title: '键盘快捷键',
    description: '单字符快捷键可以由你关闭。',
    body,
    footer: (dlg) => [
      h('span', { class: 'push' }),
      h('button', { class: 'btn btn-primary', attrs: { type: 'button' }, text: '完成', on: { click: () => dlg.close() } }),
    ],
  });
}