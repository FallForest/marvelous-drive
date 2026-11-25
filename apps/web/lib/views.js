/*
 * views.js — the four top-level pages and the chrome around them.
 *
 * Moved out of app.js unchanged: the drive / trash / starred / search bodies,
 * the skeleton and error states, the status bar, and the hint card. What stayed
 * in app.js is the shell that mounts these — the sidebar, topbar, toolbar and
 * view slots — because that is the part that owns the DOM.
 *
 * Every export takes the context built by context.js, so a view never reaches
 * for module state directly.
 */

import { h, raw } from './dom.js';
import { icon, bytes, sortNodes } from './format.js';
import { renderSearchForm } from './search-form.js';
import { routePath } from './state.js';
import { store, session } from './session.js';
import { renderFileList, trashRetentionClause } from './files.js';
import { renderTrashFilter, isTrashFilterActive } from './trash-filter.js';
import { runtime } from './runtime.js';

/** The rows the current route shows, sorted. */
export function visibleNodes() {
  const state = store.state;
  const route = state.route;
  if (state.serverSorted && route.name !== 'search') return route.name === 'trash' ? state.trash : state.nodes;
  if (route.name === 'trash') return sortNodes(state.trash, state.sortKey, state.sortDir);
  if (route.name === 'starred') return sortNodes(state.nodes.filter((node) => node.starred), state.sortKey, state.sortDir);
  if (route.name === 'search') return state.searchResults || [];
  const children = session.index.children.get(route.folderId || 'root') || [];
  return sortNodes(children, state.sortKey, state.sortDir);
}

/** Everything renderFileList() needs: the visible list plus the handlers. */
function listContext(ctx, nodes) {
  return {
    state: Object.assign({}, store.state, { nodes }),
    index: session.index,
    onSort: ctx.onSort,
    onRowClick: ctx.onRowClick,
    onSelectOnly: ctx.onSelectOnly,
    onSelectToggle: ctx.onSelectToggle,
    onSelectAll: ctx.onSelectAll,
    onRowKey: ctx.onRowKey,
    onToggleStar: ctx.onToggleStar,
    onOpen: ctx.onOpen,
    onShare: ctx.onShare,
    onRename: ctx.onRename,
    onMove: ctx.onMove,
    onDelete: ctx.onDelete,
    onRestore: ctx.onRestore,
    onPurge: ctx.onPurge,
    onPreview: ctx.onPreview,
    onDownload: ctx.onDownload,
    onDownloadArchive: ctx.onDownloadArchive,
    onCopyLink: ctx.onCopyLink,
    onRowDragStart: ctx.onRowDragStart,
    onRowDragEnd: ctx.onRowDragEnd,
    // The three drop handlers are what make a folder ROW a place you can drop
    // onto. They were missing from this list, which is why dragging a folder
    // onto another folder in the main list did nothing while the sidebar (which
    // reads ctx directly) worked — the row guard saw undefined and installed
    // no listener at all.
    onFolderDragOver: ctx.onFolderDragOver,
    onFolderDragLeave: ctx.onFolderDragLeave,
    onFolderDrop: ctx.onFolderDrop,
    navigate: ctx.navigate,
  };
}

/** The loading state: a heading bar and eight rows, so the layout does not jump. */
function skeletonView() {
  const wrap = h('div', { class: 'list' });
  wrap.appendChild(h('div', { class: 'section-head' },
    h('span', { class: 'skeleton', style: { width: '120px', height: '16px' } })));
  for (let i = 0; i < 8; i += 1) {
    wrap.appendChild(h('div', { class: 'frow-skel' },
      h('div', { class: 'skeleton', style: { height: '14px', width: (28 + (i % 4) * 13) + '%', margin: '9px 10px' } })));
  }
  return wrap;
}

/** The hints under the list. Keyboard shortcuts are documented where they are used. */
function hints() {
  const item = (kbd, label) => h('span', {}, h('span', { class: 'kbd', text: kbd }), label);
  return h('div', { class: 'hint-card' },
    // The click model is stated here because it is the one rule a new user has
    // to learn: a click acts, the checkbox selects.
    item('单击', '打开'),
    item('空格', '选择'),
    item('Enter', '打开'),
    item('F2', '重命名'),
    item('Del', '删除'),
    item('/', '搜索'),
    item('Ctrl', '+ 点击 多选'),
    item('Shift', '+ 点击 连选'),
    item('Ctrl+Shift+D', '打包下载'),
    item('Ctrl+Shift+M', '批量移动'),
  );
}

/** "“x” · 3 个结果 · 2 个在内容中命中" */
function describeResults(query, results) {
  const inContent = results.filter((row) => row.matched === 'content').length;
  const base = '“' + query + '” · ' + results.length + ' 个结果';
  return inContent ? base + ' · ' + inContent + ' 个在内容中命中' : base;
}

/**
 * Snippets for the content hits.
 *
 * The snippet is plain text from SQLite; it is rendered as text (never HTML), so
 * a file containing markup cannot inject anything through a search result.
 */
function matchNotes(results) {
  const hits = results.filter((row) => row.matched === 'content' && row.snippet);
  if (!hits.length) return null;
  return h('div', { class: 'match-notes', attrs: { 'aria-label': '内容匹配' } },
    hits.slice(0, 10).map((row) => h('div', { class: 'match-note' },
      h('b', { text: row.name }),
      h('span', { text: row.snippet }),
    )),
  );
}

/**
 * The "there is more" strip under a search page.
 *
 * The server reports `hasMore` because its fetch window overflowed; the client
 * has no total and must not invent one, so the text talks about what is on
 * screen instead of how much exists. The button disables itself while a page is
 * in flight — `searchMore.loading` is owned by the caller, the render just
 * reflects it, so a double click cannot append the same page twice.
 */
function searchMoreBar(ctx) {
  const more = store.state.searchMore;
  if (!more || !more.hasMore) return null;
  const shown = (store.state.searchResults || []).length;
  const loading = Boolean(more.loading);
  const button = h('button', {
    class: 'btn btn-sm' + (loading ? ' is-busy' : ''),
    attrs: { type: 'button', 'aria-busy': loading ? 'true' : 'false' },
    text: loading ? '正在加载…' : '继续加载',
    on: {
      click: () => {
        if (loading) return;
        if (typeof ctx.onSearchMore !== 'function') return;
        ctx.onSearchMore();
      },
    },
  });
  button.disabled = loading;
  // The class is the token for a future .search-more rule; the inline layout is
  // what keeps the strip from collapsing into two stacked lines today.
  return h('div', {
    class: 'search-more',
    attrs: { role: 'status' },
    style: {
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '10px 12px', marginTop: '8px',
      border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-sm)',
      background: 'var(--surface-2)', fontSize: 'var(--fs-sm)',
    },
  },
    h('span', { class: 'muted', text: '当前显示前 ' + shown + ' 项，还有更多匹配。' }),
    h('span', { style: { marginLeft: 'auto' } }, button),
  );
}

/** Loading is explicit: counts and selection refer to the rows already shown. */
function nodeMoreBar(ctx, count) {
  const more = store.state.nodeMore;
  if (!more || !more.hasMore) return null;
  const button = h('button', {
    class: 'btn btn-sm',
    attrs: { type: 'button', 'aria-busy': more.loading ? 'true' : 'false' },
    text: more.loading ? '正在加载…' : '继续加载',
    on: { click: () => { if (!more.loading) ctx.onNodesMore(); } },
  });
  button.disabled = Boolean(more.loading);
  return h('div', {
    class: 'node-more', attrs: { role: 'status' },
    style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', flexWrap: 'wrap' },
  }, h('span', { class: 'muted', text: '已加载 ' + count + ' 项，还有更多。全选仅选择已加载的项目。' }), button);
}

/** The search page. */
function searchView(ctx) {
  const state = store.state;
  const route = state.route;
  const query = state.searchQuery || '';
  const term = query.trim();
  const results = state.searchResults || [];
  const more = state.searchMore;
  // One form instance for every state: the same controls stay on screen while
  // the user switches between the prompt, an empty result and real results.
  const form = renderSearchForm(ctx);
  const header = h('div', { class: 'section-head search-selection-head' },
    h('div', { class: 'search-heading-default' },
      h('h1', { attrs: { 'data-route-heading': '' }, text: '搜索' }),
      h('span', {
        class: 'sub',
        text: more && more.hasMore
          ? '已显示 ' + results.length + ' 项'
          : term
            ? describeResults(term, results)
            : '筛选结果',
      }),
    ),
    results.length ? ctx.selectionSlot : null,
  );
  if (!term && !route.folderId && !route.kind && !route.updatedAfter) {
    return h('div', {}, header, form, h('div', { class: 'empty' },
      raw(icon('search', 30)),
      h('b', { text: '开始搜索' }),
      h('p', { text: '输入关键字，或按文件夹、类型、修改时间筛选；可以搜文件名，也可以搜文件内容。' }),
    ));
  }
  if (!results.length) {
    // If the account's index has gaps, "nothing found" may be a lie; say so
    // instead of letting the user believe the file does not contain the word.
    const coverage = state.stats && state.stats.search;
    const behind = coverage && coverage.missing > 0;
    return h('div', {}, header, form, h('div', { class: 'empty' },
      raw(icon('search', 30)),
      h('b', { text: '没有找到匹配的文件' }),
      h('p', { text: '试试更短的关键字；只有文本类文件的内容会被索引。' }),
      behind ? h('p', { class: 'muted', text: '另有 ' + coverage.missing + ' 个文件还没有建立索引，结果可能不完整。' }) : null,
    ));
  }
  const wrap = h('div', {},
    header,
    form,
    renderFileList(listContext(ctx, results)),
    matchNotes(results),
    searchMoreBar(ctx),
  );
  runtime.paintSelection();
  return wrap;
}

/**
 * The way from the recycle bin to the links whose source file sits in it.
 *
 * A deleted file keeps its share rows (that is what makes "restore brings the
 * link back" true), but the bin itself lists files, not links, so there was no
 * discoverable path to that management view. The link is a real anchor to the
 * canonical URL — middle-click and copy-address work — while a plain click stays
 * in the SPA. The note states only what is true: while the source is trashed the
 * link does not resolve, and after a restore a link that is still within its
 * expiry and download budget works again.
 */
function trashSharesLink(ctx) {
  const href = routePath({ name: 'shares', state: 'trashed' });
  return h('p', { class: 'trash-shares-link' },
    h('a', {
      attrs: { href },
      on: {
        click: (event) => {
          // Leave modified clicks alone: the browser's own "open in new tab" /
          // "open in new window" is a better answer than a same-tab navigation.
          if (event.defaultPrevented || event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          ctx.navigate(href);
        },
      },
    }, raw(icon('link', 13)), '回收站里的分享链接'),
    h('span', {
      text: '文件在回收站时链接打不开；还原后，仍在有效期和下载次数内的链接会恢复可用。',
    }),
  );
}

/** The drive / trash / starred list. */
function listView(ctx) {
  const route = store.state.route;
  const nodes = visibleNodes();
  const trash = route.name === 'trash';
  const filtered = trash && isTrashFilterActive(route);
  const heading = route.name === 'trash'
    ? '回收站'
    : route.name === 'starred'
      ? '星标文件'
      : (ctx.ancestors.length ? ctx.ancestors[ctx.ancestors.length - 1].name : '全部文件');

  const searchScope = route.name === 'drive'
    ? h('button', {
      class: 'btn', attrs: { type: 'button' },
      text: route.folderId ? '搜索此文件夹' : '搜索文件',
      // Only navigates: the search page owns the form, nothing is submitted here.
      on: { click: () => ctx.navigate(routePath({ name: 'search', query: '', folderId: route.folderId })) },
    })
    : null;

  const wrap = h('div', {},
    h('div', { class: 'section-head' },
      // data-route-heading is the anchor the shell focuses after a navigation
      // (a route change must move focus somewhere predictable for the keyboard).
      h('h1', { attrs: { 'data-route-heading': '' }, text: heading }),
      h('span', {
        class: 'sub',
        text: (filtered ? '筛选 · ' : '') + (store.state.nodeMore && store.state.nodeMore.hasMore ? '已加载 ' : '') + nodes.length + ' 项',
      }),
      searchScope,
    ),
    // The filter stays mounted in every trash state — filtered results, a
    // filtered no-match and an empty bin — so the way out is always on screen.
    trash ? renderTrashFilter(ctx) : null,
    route.name === 'trash' && nodes.length
      ? h('p', { class: 'muted', attrs: { style: 'margin:0;padding:0 16px 8px;font-size:var(--fs-xs)' }, text: trashRetentionClause(store.state.stats) })
      : null,
    // Discovery, not an action: the link opens the filtered management list, and
    // it stays mounted in every trash state that can hold a deleted share
    // (filtered results, a filtered no-match, a bin with items) so the way back
    // to a share's own row is always on screen. An empty bin has no trashed
    // source, hence no trashed link, so the footnote would be a dead end there.
    trash && (nodes.length || filtered) ? trashSharesLink(ctx) : null,
    renderFileList(listContext(ctx, nodes)),
    nodeMoreBar(ctx, nodes.length),
    // A matched-empty list does not need the keyboard hints; the no-match state
    // above already says what happened and how to undo it.
    filtered && !nodes.length ? null : hints(),
  );
  runtime.paintSelection();
  return wrap;
}

/** The body of the view slot: skeleton, error, search, or a list. */
export function viewContent(ctx) {
  const state = store.state;
  if (state.loading) return skeletonView();
  if (state.loadError) {
    const error = h('div', { class: 'empty', style: { paddingTop: '64px' } },
      raw(icon('alert', 30)),
      h('b', { text: '加载失败' }),
      h('p', { text: state.loadError }),
      h('button', {
        class: 'btn btn-primary', attrs: { type: 'button', style: 'margin-top:8px' }, text: '重试',
        on: { click: () => runtime.refreshData() },
      }),
    );
    // A search that failed may be the filter's fault (say, a folder that no
    // longer exists), so keep the form above the error to let the user fix it.
    if (state.route.name === 'search') return h('div', {}, renderSearchForm(ctx), error);
    return error;
  }
  return state.route.name === 'search' ? searchView(ctx) : listView(ctx);
}

/** The status bar: counts, selection, usage, account. */
export function statusContent() {
  const state = store.state;
  const route = state.route;
  const nodes = route.name === 'search' ? (state.searchResults || []) : visibleNodes();
  const folders = nodes.filter((node) => node.kind === 'folder').length;
  const files = nodes.length - folders;
  const parts = [];
  parts.push(route.name === 'trash'
    ? '回收站 · ' + nodes.length + ' 项'
    : folders + ' 个文件夹 · ' + files + ' 个文件');
  if (state.selection.size) parts.push('已选择 ' + state.selection.size + ' 项');
  if (state.stats) parts.push('已用 ' + bytes(state.stats.bytes));
  if (state.user) parts.push(state.user.email || '');
  return parts.map((text) => h('span', { text }));
}

/** <title>, so a screenshot and a browser tab agree. */
export function titleFor(route) {
  if (route.name === 'trash') return '回收站 · Marvelous Drive';
  if (route.name === 'starred') return '星标 · Marvelous Drive';
  if (route.name === 'search') return '搜索 · Marvelous Drive';
  if (route.name === 'drive' && route.folderId) {
    const folder = session.index.byId.get(route.folderId);
    if (folder) return folder.name + ' · Marvelous Drive';
  }
  return 'Marvelous Drive';
}
