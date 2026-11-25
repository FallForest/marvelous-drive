/*
 * trash-filter.js — the recycle bin's compact name / kind / deletion-time filter.
 *
 * The filter is route state, not client-side row pruning: /trash?q=…&kind=file&
 * deletedWithin=7d is loaded from the server, which applies all of it before
 * paging. That is what makes a match on a later page reachable, and what makes
 * Back / refresh / clearing the filter start again at page one.
 *
 * state.js owns parsing, the preset vocabulary and routePath(); this module only
 * builds the canonical trash URL and renders the controls, so the filter can be
 * tested without the shell. The serialization deliberately matches
 * routePath({name:'trash',…}) so the two cannot drift: bare /trash stays the
 * unfiltered page.
 */

import { h } from './dom.js';
import { isTrashDeletedWithin, routePath } from './state.js';

/** Keep in step with the server's TRASH_QUERY_MAX; the field enforces it too. */
export const TRASH_QUERY_MAX = 100;

const KIND_LABELS = { file: '文件', folder: '文件夹' };
const KIND_OPTIONS = [
  ['', '全部类型'],
  ['file', '文件'],
  ['folder', '文件夹'],
];

/**
 * The deletion-time presets, worded the way Dropbox's "when" filter reads.
 *
 * The values are the durations state.js and the server agree on; the labels
 * never say "今天" or "本周" because the window is a rolling duration, not a
 * calendar boundary. "全部时间" is the empty value, so it also clears.
 */
const WITHIN_LABELS = { '24h': '最近 24 小时', '7d': '最近 7 天', '30d': '最近 30 天' };
const WITHIN_OPTIONS = [['', '全部时间']].concat(Object.keys(WITHIN_LABELS).map((value) => [value, WITHIN_LABELS[value]]));

const FORM_STYLE = [
  'display:flex',
  'flex-wrap:wrap',
  'align-items:flex-end',
  'gap:8px',
  'width:100%',
  'max-width:100%',
  'min-width:0',
  'box-sizing:border-box',
  'padding:0 16px 8px',
].join(';');

const FIELD_STYLE = [
  'display:flex',
  'flex-direction:column',
  'gap:4px',
  'min-width:0',
  'box-sizing:border-box',
].join(';');

const CONTROL_STYLE = 'width:100%;min-width:0;max-width:100%;box-sizing:border-box;';

/** The trimmed query the server will actually receive. */
export function trashQuery(route) {
  return String((route && route.query) || '').trim().slice(0, TRASH_QUERY_MAX);
}

/** 'file' / 'folder', or '' for every type. Anything else is no filter. */
export function trashKind(route) {
  const kind = route && route.kind;
  return kind === 'file' || kind === 'folder' ? kind : '';
}

/**
 * The deletion-time preset ('24h' / '7d' / '30d'), or '' for 全部时间.
 *
 * Read through the same predicate the route and the request use, so a stale
 * value can never be painted as a selected option the server would reject.
 */
export function trashDeletedWithin(route) {
  const value = route && route.deletedWithin;
  return isTrashDeletedWithin(value) ? value : '';
}

/** Whether anything is narrowing the recycle bin right now. */
export function isTrashFilterActive(route) {
  return Boolean(trashQuery(route) || trashKind(route) || trashDeletedWithin(route));
}

/**
 * The canonical /trash URL for a filter; an empty filter is bare /trash.
 *
 * Delegates to routePath() instead of re-serializing: the URL the form pushes
 * and the URL the shell rebuilds from a route object are then literally the same
 * code, so a new filter can never be in one and missing from the other.
 */
export function trashFilterPath({ query = '', kind = '', deletedWithin = '' } = {}) {
  const term = String(query || '').trim().slice(0, TRASH_QUERY_MAX);
  return routePath({ name: 'trash', query: term, kind, deletedWithin });
}

/**
 * One sentence for the filtered no-match state, never the "empty trash" one.
 *
 * It names every narrowing the user applied, including the time preset: a
 * "最近 7 天" view that finds nothing must say so, otherwise the empty list reads
 * as "nothing was deleted" instead of "nothing was deleted in that window".
 * The name-only and kind-only sentences are unchanged from before the time
 * filter existed.
 */
export function trashFilterEmptyText(route) {
  const term = trashQuery(route);
  const kind = KIND_LABELS[trashKind(route)] || '';
  const within = WITHIN_LABELS[trashDeletedWithin(route)] || '';
  const subject = kind || '回收站项目';
  if (term) {
    // The window qualifies the noun it filters: "最近 24 小时删除的项目".
    return '没有名称包含“' + term + '”的' + (within ? within + '删除的' : '') + subject + '。';
  }
  if (within) return '没有' + within + '删除的' + subject + '。';
  if (kind) return '回收站里没有' + kind + '。';
  return '回收站里没有' + subject + '。';
}

/**
 * One <option>. `value` is written as an attribute (not the IDL property) so the
 * markup and the live control agree before any script touches the select, and
 * `select.value = kind` then reflects the route.
 */
function option(value, label, selected) {
  return h('option', { attrs: { value, selected: selected ? true : null } }, label);
}

/**
 * The filter control that triggered the current navigation, by field name.
 *
 * A filter change IS a navigation, and the shell rebuilds the form for it, so
 * the <select> the user was arrow-keying through is detached and the caret falls
 * to <body>: the next Tab restarted at the top of the page and a second arrow
 * press went nowhere. The element cannot be kept (it is replaced), but its name
 * can.
 *
 * It is NOT restored on the next render unconditionally: a navigation paints a
 * loading skeleton first, and the real form only arrives when the request
 * settles. The intent therefore waits for the first render that actually
 * contains a connected control of that name, and gives up after a few seconds so
 * a navigation that never completes cannot steal the caret later.
 */
const FIELD_FOCUS_TTL_MS = 5000;
let pendingFieldFocus = null;

/** Restores the caret on the first rendered form that has the control. */
function scheduleFieldFocus(form) {
  const pending = pendingFieldFocus;
  if (!pending) return;
  if (Date.now() - pending.at > FIELD_FOCUS_TTL_MS) { pendingFieldFocus = null; return; }
  const move = () => {
    // Another render may have consumed it (or a later filter change replaced it).
    if (pendingFieldFocus !== pending) return;
    const target = form.querySelector('[name="' + pending.name + '"]');
    // isConnected is false when a render was never mounted (a test, or a paint
    // superseded in the same task); focusing it would be a silent no-op and a
    // lie about what the caret did. Keep the intent for the next paint instead.
    if (!target || target.isConnected === false || typeof target.focus !== 'function') return;
    // Never pull the caret away from somewhere the user chose: the restore is
    // for the detached control's caret, which means <body>, a removed element,
    // or the route heading the shell parks focus on after a keyboard
    // navigation. If the user has moved on since, the intent is dropped.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const parked = !active || active === document.body || active.isConnected === false
      || (typeof active.closest === 'function' && active.closest('[data-route-heading]'));
    if (!parked) { pendingFieldFocus = null; return; }
    pendingFieldFocus = null;
    target.focus({ preventScroll: true });
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(move);
  else move();
}

/**
 * Applies one filter revision and returns to page one.
 *
 * `source` names the control that caused it, so the caret comes back to that
 * control (or to the search field after a clear, whose button disappears).
 * Navigate() replaces the route, which resets the page window, so the same
 * filters are read from offset 0 rather than appended to what was on screen.
 */
function applyFilter(ctx, next, source) {
  if (typeof ctx.navigate !== 'function') return;
  pendingFieldFocus = { name: source || 'q', at: Date.now() };
  ctx.navigate(trashFilterPath(next));
}

/** The compact filter form above the trash list. */
export function renderTrashFilter(ctx) {
  const route = (ctx && ctx.state && ctx.state.route) || {};
  const query = trashQuery(route);
  const kind = trashKind(route);
  const deletedWithin = trashDeletedWithin(route);
  const active = isTrashFilterActive(route);

  const input = h('input', {
    class: 'input',
    type: 'search',
    name: 'q',
    value: query,
    placeholder: '按名称搜索回收站',
    autocomplete: 'off',
    // The same cap the server applies, so a pasted novel cannot be accepted
    // here and silently truncated there.
    maxlength: String(TRASH_QUERY_MAX),
    attrs: { 'aria-label': '搜索回收站中的名称' },
    style: CONTROL_STYLE,
  });

  const select = h('select', {
    class: 'input',
    name: 'kind',
    attrs: { 'aria-label': '按类型筛选回收站' },
    style: CONTROL_STYLE,
  }, ...KIND_OPTIONS.map(([value, label]) => option(value, label, value === kind)));
  select.value = kind;

  // Same native <select> pattern as the type filter: one keystroke choice, the
  // platform's own picker on a phone, and the value IS the route value. A row of
  // segmented buttons would look nice and cost a custom tab/arrow implementation
  // for no extra information.
  const withinSelect = h('select', {
    class: 'input',
    name: 'deletedWithin',
    attrs: { 'aria-label': '按删除时间筛选回收站' },
    style: CONTROL_STYLE,
  }, ...WITHIN_OPTIONS.map(([value, label]) => option(value, label, value === deletedWithin)));
  withinSelect.value = deletedWithin;

  const submit = h('button', { class: 'btn', attrs: { type: 'submit' } }, '搜索');

  const form = h('form', {
    class: 'search-form trash-filter',
    attrs: { role: 'search', 'aria-label': '筛选回收站' },
    style: FORM_STYLE,
  },
    h('label', { class: 'field', style: FIELD_STYLE + ';flex:1 1 180px' },
      h('span', { class: 'field-label' }, '搜索名称'),
      input,
    ),
    h('label', { class: 'field', style: FIELD_STYLE + ';flex:0 1 130px' },
      h('span', { class: 'field-label' }, '类型'),
      select,
    ),
    h('label', { class: 'field', style: FIELD_STYLE + ';flex:0 1 150px' },
      h('span', { class: 'field-label' }, '删除时间'),
      withinSelect,
    ),
    h('div', {
      class: 'trash-filter-actions',
      // align-self keeps the buttons on the control row without inventing an
      // empty label above them (the field before them has one).
      style: 'display:flex;flex-wrap:wrap;gap:8px;align-self:flex-end;min-width:0',
    },
      submit,
      // Clearing is a real action only when it would change the route.
      active
        ? h('button', {
          class: 'btn',
          attrs: { type: 'button', title: '清除回收站筛选', 'aria-label': '清除回收站筛选' },
          // The clear button is removed with the filter it clears, so the caret
          // goes back to the search field rather than to <body>.
          on: { click: () => applyFilter(ctx, {}, 'q') },
        }, '清除筛选')
        : null,
    ),
    // One sentence, only while a window is in effect: it says the window is a
    // rolling duration measured from now, which is the one thing a "最近 7 天"
    // label cannot convey on its own (it is not "since Monday").
    deletedWithin
      ? h('p', {
        class: 'field-hint',
        style: 'flex:1 1 100%;margin:0',
        text: '按删除时间从当前时刻向前计算，不按自然日。',
      })
      : null,
  );

  // Enter in the search field submits natively; the handler keeps the URL
  // canonical (trimmed, capped) and drops an empty, filterless form back to /trash.
  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    applyFilter(ctx, { query: input.value, kind: select.value, deletedWithin: withinSelect.value }, 'q');
  });

  // A type or time choice is a filter on its own, so it applies without a second
  // click. The event comes from the select, not from state, so a keyboard
  // arrow-key change and a pointer pick take the exact same path.
  select.addEventListener('change', () => applyFilter(ctx, { query: input.value, kind: select.value, deletedWithin: withinSelect.value }, 'kind'));
  withinSelect.addEventListener('change', () => applyFilter(ctx, { query: input.value, kind: select.value, deletedWithin: withinSelect.value }, 'deletedWithin'));

  scheduleFieldFocus(form);
  return form;
}
