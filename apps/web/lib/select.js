/*
 * select.js — a dropdown that is part of the design system, not of the OS.
 *
 * The native <select> cannot be styled where it counts: the popup list and its
 * highlight are painted by the browser/OS, so a carefully themed control still
 * opens a white (or system-blue) sheet. It also sizes itself from its widest
 * option, which is why one select in a toolbar drags the row out of alignment.
 *
 * So there are two surfaces here:
 *
 *   renderSelect({ value, options, ... })      a control that looks like a field
 *   renderMenu({ label, value, options, ... }) a control that looks like a button
 *
 * Both are buttons that open the app's own menu (lib/ui.js openMenu), which is
 * already the pattern every other popup in this app uses — same radius, same
 * shadow, same spring, same keyboard handling, same Escape stack.
 *
 * What they are NOT is a listbox: openMenu builds role="menu" with
 * role="menuitemradio" rows carrying aria-checked, so the trigger advertises
 * aria-haspopup="menu". Claiming "listbox" made a screen reader describe a
 * widget that never appears and hide the checked state that does.
 */
import { h, raw } from './dom.js';
import { icon } from './format.js';
import { openMenu } from './ui.js';

// Ids for the two text nodes a trigger needs to point its ARIA at. A counter
// rather than config options: the caller should not have to invent ids for
// "this button's own value".
let sequence = 0;
function localId(kind) {
  sequence += 1;
  return 'sel-' + kind + '-' + sequence;
}

/**
 * A field-shaped select.
 *
 * options: [{ value, label }]
 * callback receives the chosen value (a string), never the option object, so a
 * caller cannot accidentally start depending on our internal shape.
 */
export function renderSelect(options) {
  const opts = options || {};
  const items = Array.isArray(opts.options) ? opts.options : [];
  const labelFor = (value) => {
    const found = items.find((item) => String(item.value) === String(value));
    return found ? String(found.label) : '';
  };

  let value = opts.value === undefined || opts.value === null ? '' : String(opts.value);

  const valueId = localId('value');
  const text = h('span', { class: 'select-value truncate', attrs: { id: valueId } });
  // The name of a menu button should be the answer it currently shows, not the
  // question it answers: "仅查看" is what a user needs to hear, "权限" is already
  // on screen next to it. aria-label used to overwrite the value with the field
  // name; the field name now rides along as a description instead, and the
  // visible value stays the accessible name.
  const hintId = opts.label ? localId('hint') : null;
  const control = h('button', {
    class: 'select' + (opts.className ? ' ' + opts.className : ''),
    attrs: {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-labelledby': valueId,
      'aria-describedby': hintId,
      id: opts.id || null,
      disabled: opts.disabled || undefined,
    },
    on: {
      click: () => open({}),
      // APG menu button: Down/Up open the popup with the first/last item in
      // focus. Enter and Space already open it through the native click.
      keydown: (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); open({ last: false }); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); open({ last: true }); }
      },
    },
  }, text, raw(icon('chevron-down', 13)),
  hintId ? h('span', { class: 'visually-hidden', attrs: { id: hintId }, text: opts.label || '' }) : null);

  function open(openOptions) {
    const menu = openMenu({
      anchor: control,
      label: opts.label || null,
      align: opts.align || 'start',
      items: items.map((item) => ({
        label: String(item.label),
        icon: null,
        kbd: opts.kbdFor ? opts.kbdFor(item.value) : null,
        // A tick on the active row: a menu without state reads as a command
        // list, and the user cannot tell what is currently chosen.
        checked: String(item.value) === value,
        onSelect: () => {
          setValue(item.value);
          if (typeof opts.onChange === 'function') opts.onChange(String(item.value));
        },
      })),
    });
    if (openOptions && openOptions.last && menu.el) {
      const rows = menu.el.querySelectorAll('.menu-item:not([disabled])');
      const last = rows[rows.length - 1];
      if (last) last.focus();
    }
    return menu;
  }

  function setValue(next) {
    value = next === undefined || next === null ? '' : String(next);
    const label = labelFor(value);
    text.textContent = label;
    // An empty label would collapse the control; keep the caret aligned by
    // marking the placeholder state instead of leaving the box blank.
    control.classList.toggle('is-placeholder', !label);
    if (opts.title) control.setAttribute('title', label);
  }

  // A caller reads `control.value` exactly as it would from a native select, so
  // moving a form onto this control does not have to rewrite the submit handler.
  Object.defineProperty(control, 'value', {
    get: () => value,
    set: (next) => setValue(next),
  });

  setValue(value);
  return control;
}

/**
 * A button-shaped select: same menu, toolbar weight.
 *
 * Used where the control sits in a row of buttons (the sort control), so the
 * label and the menu are shared but the chrome is a button, not a field.
 */
export function renderMenu(options) {
  const opts = options || {};
  const items = Array.isArray(opts.options) ? opts.options : [];
  let value = opts.value === undefined || opts.value === null ? '' : String(opts.value);

  const labelFor = (next) => {
    const found = items.find((item) => String(item.value) === String(next));
    return found ? String(found.label) : '';
  };

  const valueId = localId('value');
  const text = h('span', { attrs: { id: valueId }, text: labelFor(value) });
  const hintId = opts.label ? localId('hint') : null;
  const control = h('button', {
    class: 'btn btn-menu' + (opts.className ? ' ' + opts.className : ''),
    attrs: {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-labelledby': valueId,
      'aria-describedby': hintId,
      disabled: opts.disabled || undefined,
    },
    on: {
      click: () => open({}),
      keydown: (event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); open({ last: false }); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); open({ last: true }); }
      },
    },
  }, text, raw(icon('chevron-down', 12)),
  hintId ? h('span', { class: 'visually-hidden', attrs: { id: hintId }, text: opts.label || '' }) : null);

  function open(openOptions) {
    const menu = openMenu({
      anchor: control,
      label: opts.label || null,
      align: opts.align || 'end',
      items: items.map((item) => ({
        label: String(item.label),
        checked: String(item.value) === value,
        onSelect: () => {
          value = String(item.value);
          text.textContent = labelFor(value);
          if (typeof opts.onChange === 'function') opts.onChange(value);
        },
      })),
    });
    if (openOptions && openOptions.last && menu.el) {
      const rows = menu.el.querySelectorAll('.menu-item:not([disabled])');
      const last = rows[rows.length - 1];
      if (last) last.focus();
    }
    return menu;
  }

  // Same contract as renderSelect: `.value` reads like a form control.
  Object.defineProperty(control, 'value', {
    get: () => value,
    set: (next) => {
      value = next === undefined || next === null ? '' : String(next);
      text.textContent = labelFor(value);
    },
  });

  return control;
}
