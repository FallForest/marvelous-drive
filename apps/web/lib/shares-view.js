/*
 * shares-view.js — the owner's private /shares page ("我分享的").
 *
 * This is the management view, not the public page: /s/<token> is untouched and
 * keeps its own module (lib/share.js). Here the signed-in owner sees every link
 * their account created — files and folders, anywhere in the drive, newest
 * first — and can copy, open or revoke it.
 *
 * Two rules this module owns:
 *
 *   1. The server decides whether a link works (`state` + `usable`), and the
 *      page only offers 复制/打开 for a usable one. The state word is never
 *      re-derived from the clock here: an expired link must not look usable
 *      because this tab's clock disagrees, and a page left open must not keep
 *      offering a link whose budget ran out in another tab.
 *   2. Revoking is allowed for every listed link, including one whose source is
 *      in the trash, and it always says what changes (recipient access ends)
 *      and what does not (the file stays).
 *
 * Paging is bounded and append-only: `hasMore` comes from the server, a failed
 * page leaves the rows already on screen alone, and a revoke re-reads from the
 * first page so no stale row survives it.
 *
 * Filtering is route state, not row pruning: /shares?q=…&state=… is loaded from
 * the server, which applies both before LIMIT/OFFSET. That is what makes a
 * match on a later page reachable and what makes Back / reload / clearing the
 * filter start again at page one. The filter controls are built once and kept
 * mounted across a same-page query change, so pressing Enter in the name field
 * does not drop the caret the user was typing into.
 */

import { h, raw, mount } from './dom.js';
import { icon, kindIcon, fileKind, formatDate } from './format.js';
import { toast, confirmDialog, copyText, withBusy } from './ui.js';
import { api } from './api.js';
import { openShareEditor, shareAbsoluteUrl, shareAvailability, shareSettingsLine } from './share-edit.js';
import { sharesPagePath } from './route-data.js';
import { isShareState, routePath } from './state.js';
import { runtime } from './runtime.js';

/** Page size asked of GET /api/v1/shares; the server caps at 100. */
const PAGE_SIZE = 50;

/** Keep in step with the server's SHARE_QUERY_MAX; the field enforces it too. */
export const SHARE_QUERY_MAX = 100;

/* ── pure helpers (unit-testable without a DOM) ───────────────── */

/**
 * The trimmed name filter the server will actually receive.
 *
 * Sliced rather than rejected: a hand-edited URL gets a normal page instead of
 * a 400, and the substring query stays bounded however the URL was built.
 */
export function sharesQuery(route) {
  return String((route && route.query) || '').trim().slice(0, SHARE_QUERY_MAX);
}

/** The effective-state filter ('active' / …), or '' for 全部状态. */
export function sharesState(route) {
  const state = route && route.state;
  return isShareState(state) ? state : '';
}

/** Whether anything is narrowing the owner's link list right now. */
export function isSharesFilterActive(route) {
  return Boolean(sharesQuery(route) || sharesState(route));
}

/**
 * The canonical /shares URL for a filter; an empty filter is bare /shares.
 *
 * Delegates to routePath() instead of re-serializing, so the URL the form
 * pushes and the URL the shell rebuilds from a route object are the same code.
 */
export function sharesFilterPath({ query = '', state = '' } = {}) {
  return routePath({ name: 'shares', query: String(query || '').trim().slice(0, SHARE_QUERY_MAX), state });
}

const SHARES_STATE_LABEL = {
  active: '有效',
  expired: '已过期',
  exhausted: '下载次数用完',
  trashed: '文件在回收站',
};

/**
 * The filtered no-match sentence, never the "no links yet" one.
 *
 * It names both narrowings that are in effect so a filtered empty list cannot
 * read as "this account never shared anything".
 */
export function sharesFilterEmptyText(route) {
  const term = sharesQuery(route);
  const state = SHARES_STATE_LABEL[sharesState(route)] || '';
  if (term && state) return '没有名称包含“' + term + '”且状态为「' + state + '」的分享链接。';
  if (term) return '没有名称包含“' + term + '”的分享链接。';
  if (state) return '没有状态为「' + state + '」的分享链接。';
  return '没有匹配的分享链接。';
}

/** The words a row shows, in the priority the server reports. */
const SHARE_STATE_LABEL = {
  active: '有效',
  expired: '已过期',
  exhausted: '下载次数用完',
  trashed: '文件在回收站',
};

/** True only for a link the recipient can still open. */
function shareUsable(share) {
  return Boolean(share && share.usable);
}

/** The effective state word for one listed link. */
function shareStateLabel(share) {
  if (!share) return SHARE_STATE_LABEL.trashed;
  return SHARE_STATE_LABEL[share.state] || SHARE_STATE_LABEL.trashed;
}

/**
 * The absolute public URL of a listed link.
 *
 * Delegated to share-edit.js so the list and the editor cannot disagree about
 * what a row's address is: a copy that handed the clipboard a relative fragment
 * would be a silently invalid link.
 */
const ownerShareUrl = shareAbsoluteUrl;

/**
 * "可下载 · 带密码 · 已下载 2/5 次 · 7 天后过期", or the viewer alternative.
 *
 * share-edit.js owns the sentence because the editor shows the same facts; this
 * wrapper only keeps the page's own name for it.
 */
function shareDetailLine(share) {
  return shareSettingsLine(share);
}

/**
 * The sentence above the list that explains what a link is.
 *
 * Stated plainly and once: anyone holding the link can read the file, plus the
 * password if one was set. A viewer link has no download button — that is a
 * limit on the page's buttons, not a claim that the bytes cannot be saved, and
 * saying "不能下载" would be the DRM lie this copy avoids.
 */
const AUDIENCE_NOTE = '拿到链接的人可以打开并查看这个文件；如果创建时设置了密码，还需要输入密码。仅查看的链接不会显示下载按钮。';

/* ── row rendering ────────────────────────────────────────────── */

function kindOf(share) {
  const node = share && share.node ? share.node : null;
  if (!node) return 'file';
  return node.kind === 'folder' ? 'folder' : fileKind(null, node.name);
}

/**
 * One link row.
 *
 * The row is a definition list in spirit — source, state, details — and puts
 * its buttons in a trailing group that wraps under the text at 390px instead of
 * overflowing. `data-id` is the share id, not the node id: revoke addresses the
 * link, and the node id would collide when one file has two links.
 */
function shareRow(share, ctx) {
  const usable = shareUsable(share);
  const state = share.state || 'trashed';
  const node = share.node || {};
  const url = ownerShareUrl(share);

  const copyBtn = h('button', {
    class: 'btn btn-sm',
    attrs: {
      type: 'button',
      'aria-label': '复制链接：' + (node.name || '分享链接'),
      title: usable ? '复制链接' : '链接' + shareStateLabel(share) + '，不能复制',
      ...(usable ? {} : { disabled: 'disabled' }),
    },
  }, raw(icon('copy', 13)), '复制');

  const openBtn = h('button', {
    class: 'btn btn-sm',
    attrs: {
      type: 'button',
      'aria-label': '打开链接：' + (node.name || '分享链接'),
      title: usable ? '在新标签页打开' : '链接' + shareStateLabel(share) + '，不能打开',
      ...(usable ? {} : { disabled: 'disabled' }),
    },
  }, raw(icon('eye', 13)), '打开');

  const revokeBtn = h('button', {
    class: 'btn btn-sm btn-ghost share-revoke',
    attrs: { type: 'button', 'aria-label': '撤销链接：' + (node.name || '分享链接') },
  }, raw(icon('trash', 13)), '撤销');

  const editBtn = h('button', {
    class: 'btn btn-sm share-edit',
    attrs: {
      type: 'button',
      'aria-label': '编辑链接设置：' + (node.name || '分享链接'),
      title: '编辑有效期、密码和下载权限',
    },
  }, raw(icon('pencil', 13)), '编辑');

  copyBtn.addEventListener('click', async () => {
    // Re-checked at click time: the page may have sat open past the expiry.
    if (!shareUsable(share)) return;
    const ok = await copyText(url);
    toast(ok ? '链接已复制到剪贴板。' : '复制失败，请手动选择链接。', {
      type: ok ? 'success' : 'error',
      detail: ok ? '' : url,
    });
  });

  openBtn.addEventListener('click', () => {
    if (!shareUsable(share)) return;
    window.open(url, '_blank', 'noopener');
  });

  // Editing is allowed for every listed link, exactly like revoking: an expired
  // or exhausted link is the one most in need of a new expiry or a higher cap,
  // and a trashed source can be restored afterwards. The dialog explains the
  // current unavailability instead of hiding the fix behind a disabled button.
  editBtn.addEventListener('click', () => {
    openShareEditor(share, {
      onSaved: (updated) => { void ctx.onEdited(share, updated); },
      onMissing: () => { void ctx.onRevoked(share); },
    });
  });

  revokeBtn.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: '撤销这条链接？',
      // Both halves matter: the recipient loses access, the owner keeps the file.
      // The source may already be in the trash, so the sentence says the file
      // stays where it is instead of naming a location it might not be in.
      description: '撤销后，拿到这条链接的人将失去访问权限。原文件保留在当前位置。',
      confirmLabel: '撤销链接',
      cancelLabel: '保留链接',
      danger: true,
    });
    if (!yes) return;
    withBusy(revokeBtn, true);
    try {
      await api.del('/shares/' + encodeURIComponent(share.id));
      toast('链接已撤销，访问者已无法再打开。', { type: 'success' });
      await ctx.onRevoked(share);
    } catch (error) {
      toast((error && error.message) || '撤销失败，请重试。', { type: 'error' });
      withBusy(revokeBtn, false);
    }
  });

  return h('div', {
    class: 'share-row' + (usable ? '' : ' is-inert'),
    dataset: { id: String(share.id), state },
  },
    h('span', { class: 'share-row-icon', attrs: { 'aria-hidden': 'true' }, html: icon(kindIcon(kindOf(share), node.name), 17) }),
    h('div', { class: 'share-row-main' },
      h('div', { class: 'share-row-title' },
        h('span', { class: 'truncate', attrs: { title: node.name || '' }, text: node.name || '（源文件已不存在）' }),
        // A lock beside the name is the fastest read of "this link has a
        // password"; the same fact is spelled out in the detail line below for
        // anyone who does not take the glyph. Neither is the only cue.
        share.hasPassword
          ? h('span', { class: 'share-kind share-lock', attrs: { title: '这条链接需要访问密码' } }, raw(icon('lock', 11)), '带密码')
          : null,
        node.kind === 'folder' ? h('span', { class: 'share-kind', text: '文件夹' }) : null,
      ),
      // State, detail and creation date share one wrapping line: on a wide
      // window a link row is a single 32px line like a file row, and on a phone
      // the same markup folds into short lines instead of truncating a date.
      h('div', { class: 'share-meta' },
        h('span', { class: 'share-state is-' + state, text: shareStateLabel(share) }),
        h('span', { class: 'share-detail', text: shareDetailLine(share) }),
        h('span', { class: 'share-created', text: '创建于 ' + (formatDate(share.createdAt) || '—') }),
      ),
    ),
    h('div', { class: 'share-row-actions' }, editBtn, copyBtn, openBtn, revokeBtn),
  );
}

/* ── filter controls ──────────────────────────────────────────── */

const STATE_OPTIONS = [
  ['', '全部状态'],
  ['active', '有效'],
  ['expired', '已过期'],
  ['exhausted', '下载次数用完'],
  ['trashed', '文件在回收站'],
];

const FORM_STYLE = [
  'display:flex',
  'flex-wrap:wrap',
  'align-items:flex-end',
  'gap:8px',
  'width:100%',
  'max-width:100%',
  'min-width:0',
  'box-sizing:border-box',
  'margin:0 0 10px',
  'padding:0 16px',
].join(';');

const FIELD_STYLE = 'display:flex;flex-direction:column;gap:4px;min-width:0;box-sizing:border-box;';
const CONTROL_STYLE = 'width:100%;min-width:0;max-width:100%;box-sizing:border-box;';

/** One <option>, written as an attribute so markup and control agree on load. */
function option(value, label, selected) {
  return h('option', { attrs: { value, selected: selected ? true : null } }, label);
}

/**
 * The compact name + state filter above the list.
 *
 * A filter change is a navigation (the server applies it), and the shell
 * replaces this form for it. The caret would then fall to <body> mid-typing, so
 * the field that triggered the change is remembered and refocused on the first
 * render of the same page that still has it — the same rule the recycle bin's
 * filter follows.
 */
const FIELD_FOCUS_TTL_MS = 5000;
let pendingFieldFocus = null;

/** Restores the caret on the first rendered form that has the named control. */
function scheduleFieldFocus(form) {
  const pending = pendingFieldFocus;
  if (!pending) return;
  if (Date.now() - pending.at > FIELD_FOCUS_TTL_MS) { pendingFieldFocus = null; return; }
  const move = () => {
    if (pendingFieldFocus !== pending) return;
    const target = form.querySelector('[name="' + pending.name + '"]');
    if (!target || target.isConnected === false || typeof target.focus !== 'function') return;
    // Never pull the caret away from somewhere the user chose: the restore is
    // only for the detached control's caret (body, a removed element, or the
    // route heading the shell parks focus on after a keyboard navigation).
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

/** One filter revision, always from page one (a new route, a new page window). */
function applyFilter(ctx, next, source) {
  if (typeof ctx.navigate !== 'function') return;
  pendingFieldFocus = { name: source || 'q', at: Date.now() };
  ctx.navigate(sharesFilterPath(next));
}

/** The filter form. `initial` is the route it is first built for. */
function renderSharesFilter(ctx, initial) {
  const route = initial || (ctx && ctx.state && ctx.state.route) || {};
  const query = sharesQuery(route);
  const state = sharesState(route);
  const active = isSharesFilterActive(route);

  const input = h('input', {
    class: 'input',
    type: 'search',
    name: 'q',
    value: query,
    placeholder: '按文件名或文件夹名搜索',
    autocomplete: 'off',
    // The same cap the server applies, so a pasted novel cannot be accepted
    // here and silently truncated there.
    maxlength: String(SHARE_QUERY_MAX),
    attrs: { 'aria-label': '按文件名或文件夹名筛选分享链接' },
    style: CONTROL_STYLE,
  });

  const select = h('select', {
    class: 'input',
    name: 'state',
    attrs: { 'aria-label': '按链接状态筛选分享链接' },
    style: CONTROL_STYLE,
  }, ...STATE_OPTIONS.map(([value, label]) => option(value, label, value === state)));
  select.value = state;

  const submit = h('button', { class: 'btn', attrs: { type: 'submit' } }, '筛选');

  const form = h('form', {
    class: 'search-form shares-filter',
    attrs: { role: 'search', 'aria-label': '筛选分享链接' },
    style: FORM_STYLE,
  },
    h('label', { class: 'field', style: FIELD_STYLE + ';flex:1 1 200px' },
      h('span', { class: 'field-label' }, '搜索名称'),
      input,
    ),
    h('label', { class: 'field', style: FIELD_STYLE + ';flex:0 1 150px' },
      h('span', { class: 'field-label' }, '状态'),
      select,
    ),
    h('div', {
      class: 'shares-filter-actions',
      // align-self keeps the buttons on the control row without inventing an
      // empty label above them (the field before them has one).
      style: 'display:flex;flex-wrap:wrap;gap:8px;align-self:flex-end;min-width:0',
    },
      submit,
      // Clearing is a real action only when it would change the route.
      active
        ? h('button', {
          class: 'btn',
          attrs: { type: 'button', title: '清除分享链接筛选', 'aria-label': '清除分享链接筛选' },
          on: { click: () => applyFilter(ctx, {}, 'q') },
        }, '清除筛选')
        : null,
    ),
  );

  // Enter in the name field submits natively; the handler keeps the URL
  // canonical (trimmed, capped) and drops an empty, filterless form back to
  // bare /shares.
  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    applyFilter(ctx, { query: input.value, state: select.value }, 'q');
  });

  // A state choice is a filter on its own, so it applies without a second
  // click. The event comes from the select, so a keyboard arrow-key change and
  // a pointer pick take the exact same path.
  select.addEventListener('change', () => applyFilter(ctx, { query: input.value, state: select.value }, 'state'));

  scheduleFieldFocus(form);
  return form;
}

/* ── page ─────────────────────────────────────────────────────── */

/**
 * createSharesView(initialRoute) — the body of the /shares route.
 *
 * Returns { el, reload, show }. `el` is built once per visit and re-mounted on
 * a local repaint, so a toolbar change or a statusbar update does not throw the
 * list away; `reload` is the shell's refresh verb (the topbar button and R);
 * `show(route)` is how a /shares?q=… navigation reaches the page: the shell
 * keeps one page per visit and hands it the new route instead of rebuilding it,
 * so the filter controls (and the caret in them) survive a query change.
 *
 * The page owns its own list; nothing here reuses the drive's file list,
 * selection or row actions, because a link row is not a file row: it has no
 * rename/move/star and its primary verb is revoke.
 */
export function createSharesView(initialRoute) {
  const listHost = h('div', { class: 'share-rows', attrs: { 'aria-live': 'polite', 'aria-busy': 'true' } });
  const moreHost = h('div', { class: 'share-more' });
  const countEl = h('span', { class: 'sub', text: '正在载入…' });
  const filterHost = h('div', { class: 'shares-filter-host' });

  /** The filter this page currently shows; '' for an unfiltered page. */
  let route = filterRoute(initialRoute);

  /** Loaded rows, in server order (newest first). */
  let rows = [];
  let hasMore = false;
  let offset = 0;
  let loading = false;
  /** Bumped by every reload so a slower earlier answer cannot overwrite it. */
  let generation = 0;
  /** The first-load failure, kept so a repaint cannot silently turn it into "empty". */
  let loadFailure = null;
  /**
   * A refill that failed: { message, gone }.
   *
   * The loaded window is no longer known to be complete, so pagination from the
   * old offset is refused until this same filtered window has been re-read.
   * `gone` keeps the retry the identical question to the refill that failed.
   */
  let refillFailure = null;

  function filterRoute(value) {
    return { name: 'shares', query: sharesQuery(value), state: sharesState(value) };
  }

  // The audience note already sits above the list and applies to an empty page
  // too, so the empty state only says how to create the first link.
  const emptyState = () => h('div', { class: 'empty share-empty' },
    raw(icon('link', 30)),
    h('b', { text: '你还没有创建分享链接' }),
    h('p', { text: '在文件上点击「分享」，创建链接后就能在这里统一查看和管理。' }),
  );

  /** A filtered no-match is the filter's answer, never "this account is empty". */
  const filteredEmptyState = () => h('div', { class: 'empty share-empty' },
    raw(icon('search', 30)),
    h('b', { text: '没有匹配的分享链接' }),
    h('p', { text: sharesFilterEmptyText(route) }),
    h('button', {
      class: 'btn',
      attrs: { type: 'button', title: '清除分享链接筛选' },
      // Named for what it does to the list, not just "清除筛选": the form above
      // already has a button with that label, and two identical names a few
      // pixels apart are ambiguous to a screen reader.
      text: '清除筛选并显示全部',
      on: { click: () => applyFilter(ctx, {}, 'q') },
    }),
  );

  const errorState = (message, retry) => h('div', { class: 'empty share-empty' },
    raw(icon('alert', 30)),
    h('b', { text: '无法载入分享链接' }),
    h('p', { text: message || '请稍后重试。' }),
    h('button', {
      class: 'btn btn-primary', attrs: { type: 'button', style: { marginTop: '8px' } }, text: '重试',
      on: { click: retry },
    }),
  );

  const paint = () => {
    listHost.setAttribute('aria-busy', loading ? 'true' : 'false');
    const filtered = isSharesFilterActive(route);
    if (!rows.length) {
      // Loading comes first: both the first load and a refill that emptied the
      // list arrive here with `loading` already true, and painting the empty
      // account over that spinner said "你还没有创建分享链接" for as long as the
      // request took.
      if (loading) {
        countEl.textContent = '正在载入…';
        mount(listHost, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在读取分享链接…' })));
        mount(moreHost);
        return;
      }
      // A failed first load is not an empty account. Paint the error and its
      // retry, which a repaint of the shell would otherwise drop.
      countEl.textContent = loadFailure || refillFailure ? '' : (filtered ? '没有匹配 · 筛选' : '0 条链接');
      if (loadFailure) mount(listHost, errorState(loadFailure.message, () => { loadFailure = null; void loadFirst(); }));
      // A failed refill is not "no links": the window is re-readable, so offer
      // the retry of that same filtered window instead of the empty account.
      else if (refillFailure) mount(listHost, errorState(refillFailure.message, () => { void refillWindow(refillFailure.gone); }));
      else mount(listHost, filtered ? filteredEmptyState() : emptyState());
      mount(moreHost);
      return;
    }
    mount(listHost, rows.map((share) => shareRow(share, {
      onRevoked: (revoked) => refillWindow(revoked && revoked.id),
      onEdited: applyEdited,
    })));
    countEl.textContent = (filtered ? '筛选 · ' : '') + rows.length + ' 条链接' + (hasMore ? ' · 还有更多' : '');
    // A refill that failed leaves the offsets of the loaded window unknown. The
    // only honest next step is re-reading that window; an append from the old
    // offset would already have skipped the row that shifted up.
    if (refillFailure) {
      mount(moreHost, h('div', { class: 'share-more-bar is-error' },
        h('span', { class: 'muted', text: refillFailure.message }),
        h('button', {
          class: 'btn btn-sm', attrs: { type: 'button' }, text: '重试',
          on: { click: () => { void refillWindow(refillFailure.gone); } },
        }),
      ));
      return;
    }
    if (hasMore) {
      const button = h('button', {
        class: 'btn btn-sm',
        attrs: { type: 'button', 'aria-busy': loading ? 'true' : 'false' },
        text: loading ? '正在载入…' : '继续加载',
        on: { click: () => { if (!loading) void loadPage(); } },
      });
      button.disabled = loading;
      mount(moreHost, h('div', { class: 'share-more-bar' },
        h('span', { class: 'muted', text: '已显示 ' + rows.length + ' 条，还有更早的链接。' }),
        button,
      ));
      return;
    }
    mount(moreHost);
  };

  /**
   * Fetches one page of the current filter and appends it.
   *
   * The query travels on every page, so "继续加载" stays on the same narrowed
   * set instead of appending unfiltered rows. The answer is discarded when the
   * filter moved on while it was in flight: a late page must never paint a
   * different query than the one the heading and controls now show.
   */
  async function loadPage() {
    if (loading) return;
    // A failed refill means the loaded window's offsets are unknown. Appending
    // from the old offset would skip the row that shifted up, so the page offers
    // the refill's retry instead (see paint()).
    if (refillFailure) return;
    loading = true;
    const ticket = generation;
    const asked = route;
    paint();
    try {
      const payload = await api.get(sharesPagePath(asked, { limit: PAGE_SIZE, offset }));
      if (ticket !== generation) return;
      const page = payload && Array.isArray(payload.shares) ? payload.shares : [];
      rows = offset === 0 ? page : rows.concat(page);
      offset = Number(payload && payload.offset) + Number(payload && payload.limit);
      hasMore = Boolean(payload && payload.hasMore);
      loadFailure = null;
      loading = false;
      paint();
    } catch (error) {
      if (ticket !== generation) return;
      loading = false;
      if (!rows.length) {
        loadFailure = { message: (error && error.message) || '请稍后重试。' };
        paint();
      } else {
        // A failed extra page must not wipe the links already shown: keep the
        // rows and put an explicit retry under them.
        paint();
        mount(moreHost, h('div', { class: 'share-more-bar is-error' },
          h('span', { class: 'muted', text: (error && error.message) || '加载更多失败。' }),
          h('button', {
            class: 'btn btn-sm', attrs: { type: 'button' }, text: '重试',
            on: { click: () => { void loadPage(); } },
          }),
        ));
      }
    }
  }

  /** Reads page one again from scratch (first paint, retry and after revoke). */
  async function loadFirst() {
    generation += 1;
    rows = [];
    offset = 0;
    hasMore = false;
    loading = false;
    loadFailure = null;
    refillFailure = null;
    mount(moreHost);
    listHost.setAttribute('aria-busy', 'true');
    mount(listHost, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在读取分享链接…' })));
    await loadPage();
  }

  /**
   * Adopts a /shares route the shell navigated to.
   *
   * A filter change is a new question, so page one is read again from offset 0
   * (page 3 of the old filter means nothing in the new one). The form is
   * rebuilt for the new values but only after pendingFieldFocus had a chance to
   * find the old control: the shell calls show() from the same navigation that
   * would otherwise detach the field the user pressed Enter in.
   */
  function show(nextRoute, options) {
    const next = filterRoute(nextRoute);
    const same = next.query === route.query && next.state === route.state;
    if (same) {
      // The shell re-mounts the page on every repaint; only a forced refresh
      // re-reads. Anything else would be a silent refetch of the same question.
      if (options && options.force === true) void loadFirst();
      return;
    }
    route = next;
    mount(filterHost, renderSharesFilter(ctx, route));
    void loadFirst();
  }

  /**
   * Whether a row's source name answers the current ?q= filter.
   *
   * The same substring test the server's LIKE makes for the common case (ASCII
   * case is folded; `%`/`_` were literal there and are literal here). It is only
   * used to decide whether an edited row still belongs on this page — a wrong
   * "no" merely re-reads the list, never hides a row.
   */
  function nameMatchesFilter(name, term) {
    if (!term) return true;
    return String(name || '').toLowerCase().includes(String(term).toLowerCase());
  }

  /**
   * After an edit: take the server's row, then reconcile the list.
   *
   * The row itself is replaced in place (identity, order and the loaded window
   * do not change), so an edit that keeps the link inside the current filter
   * costs no request. When the filter makes the row no longer a member — the
   * owner renewed an expired link while viewing 已过期 — the loaded window is
   * re-read so the row leaves the filtered set instead of sitting there
   * contradicting the control, and the page does not silently jump to page one.
   */
  function applyEdited(before, updated) {
    if (!updated) { void loadFirst(); return; }
    const index = rows.findIndex((share) => share.id === updated.id);
    if (index < 0) { void loadFirst(); return; }
    // A list row carries fields the patch response does not repeat (node name
    // and kind) and, critically, `state`/`usable`/`canDownload`, which the
    // PATCH body does not send because they are derived. Carrying the old ones
    // over would show the link as it was before the edit, so they are dropped
    // and re-derived from the merged row — the same rule the page already
    // applies to every listed link (see shareAvailability).
    const merged = { ...rows[index], ...updated };
    const availability = shareAvailability(merged);
    const next = {
      ...merged,
      state: availability.state,
      usable: availability.usable,
      canDownload: merged.permission === 'downloader',
    };
    // The visible filter is a server question, so membership is decided by the
    // same rule the server's WHERE clause uses (see shareState()).
    if ((route.state && next.state !== route.state)
      || !nameMatchesFilter(next.node && next.node.name, route.query)) {
      // The row left the filtered set: refill the same window so the offsets of
      // the remaining rows stay accurate (a row deleted above them shifts up).
      void refillWindow(updated.id);
      return;
    }
    rows[index] = next;
    paint();
  }

  /**
   * After a revision: refill every page that was on screen.
   *
   * Offset paging is not stable across a delete, so simply appending page one
   * over the previous rows would leave the item that shifted up shown twice and
   * the one that shifted down missing. Re-reading `offset` rows keeps the list
   * complete, and generation guards against a concurrent filter change.
   *
   * `gone` is the row that left the set (a revoke, or an edit that made the row
   * stop matching the filter). The change already succeeded on the server, so
   * the row is removed immediately and is not offered again; if the refill
   * itself fails, its retry asks the same filtered window again.
   *
   * The window is marked busy before the first await: while the refill is in
   * flight the loaded rows belong to neither the old offset nor the new one, so
   * 继续加载 must not paginate from the stale offset under the same generation.
   */
  async function refillWindow(gone) {
    const wanted = Math.max(PAGE_SIZE, offset);
    generation += 1;
    const ticket = generation;
    const asked = route;
    loading = true;
    refillFailure = null;
    rows = rows.filter((share) => share.id !== gone);
    paint();
    try {
      const collected = [];
      let next = 0;
      let more = true;
      // Two different questions, kept apart: `more` is the server's answer about
      // what is left on the whole list, `collected.length < wanted` only bounds
      // how many pages this refill reads. Folding them together was the bug —
      // revoking on a full first page stopped the refill at exactly `wanted`
      // rows and then recorded "nothing more" while the server still had 5.
      while (more && collected.length < wanted) {
        const payload = await api.get(sharesPagePath(asked, { limit: PAGE_SIZE, offset: next }));
        if (ticket !== generation) return;
        const page = payload && Array.isArray(payload.shares) ? payload.shares : [];
        collected.push(...page);
        more = Boolean(payload && payload.hasMore);
        next = Number(payload && payload.offset) + Number(payload && payload.limit);
        if (!page.length) break;
      }
      if (ticket !== generation) return;
      rows = collected;
      offset = next;
      hasMore = more;
      loadFailure = null;
      refillFailure = null;
      loading = false;
      paint();
    } catch (error) {
      if (ticket !== generation) return;
      // The offsets of the loaded window are now unknown. Keep the shortened
      // rows, refuse the old-offset page and offer a retry of this same window.
      refillFailure = { message: (error && error.message) || '列表刷新失败，请重试。', gone };
      loading = false;
      paint();
      toast((error && error.message) || '列表刷新失败，请点击重试。', { type: 'warning' });
    }
  }

  const ctx = {
    get state() { return { route }; },
    // The shell's navigate() is the same verb every other view's filter uses:
    // it pushes a real URL (so Back and reload mean the filter) and re-runs the
    // route, which calls show() with the new query.
    navigate: (path) => runtime.navigate(path),
  };

  // The shell hands the page the route it is being built for, so the controls
  // start on the filtered URL (Back into ?state=trashed shows that state).
  mount(filterHost, renderSharesFilter(ctx, route));

  const wrap = h('div', { class: 'shares-page' },
    h('div', { class: 'section-head' },
      h('h1', { attrs: { 'data-route-heading': '' }, text: '我分享的' }),
      countEl,
      h('span', { class: 'push' }),
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button', 'aria-label': '刷新分享链接列表' },
        on: { click: () => { void loadFirst(); } },
      }, raw(icon('refresh', 13)), '刷新'),
    ),
    h('p', { class: 'shares-note', text: AUDIENCE_NOTE }),
    filterHost,
    listHost,
    moreHost,
  );

  void loadFirst();
  return { el: wrap, reload: loadFirst, show };
}
