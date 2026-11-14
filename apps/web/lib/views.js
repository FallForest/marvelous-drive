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
import { store, session } from './session.js';
import { renderFileList } from './files.js';
import { runtime } from './runtime.js';

/** The rows the current route shows, sorted. */
export function visibleNodes() {
  const state = store.state;
  const route = state.route;
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

/** The search page. */
function searchView(ctx) {
  const state = store.state;
  const query = state.searchQuery || '';
  const results = state.searchResults || [];
  const header = h('div', { class: 'section-head' },
    h('h1', { text: '搜索' }),
    h('span', { class: 'sub', text: query ? describeResults(query, results) : '在侧边栏输入关键字' }),
  );
  if (!query) {
    return h('div', {}, header, h('div', { class: 'empty' },
      raw(icon('search', 30)),
      h('b', { text: '开始搜索' }),
      h('p', { text: '按 / 聚焦搜索框，可以搜文件名，也可以搜文件内容。' }),
    ));
  }
  if (!results.length) {
    // If the account's index has gaps, "nothing found" may be a lie; say so
    // instead of letting the user believe the file does not contain the word.
    const coverage = state.stats && state.stats.search;
    const behind = coverage && coverage.missing > 0;
    return h('div', {}, header, h('div', { class: 'empty' },
      raw(icon('search', 30)),
      h('b', { text: '没有找到匹配的文件' }),
      h('p', { text: '试试更短的关键字；只有文本类文件的内容会被索引。' }),
      behind ? h('p', { class: 'muted', text: '另有 ' + coverage.missing + ' 个文件还没有建立索引，结果可能不完整。' }) : null,
    ));
  }
  const wrap = h('div', {}, header, ctx.selectionSlot, renderFileList(listContext(ctx, results)), matchNotes(results));
  runtime.paintSelection();
  return wrap;
}

/** The drive / trash / starred list. */
function listView(ctx) {
  const route = store.state.route;
  const nodes = visibleNodes();
  const heading = route.name === 'trash'
    ? '回收站'
    : route.name === 'starred'
      ? '星标文件'
      : (ctx.ancestors.length ? ctx.ancestors[ctx.ancestors.length - 1].name : '全部文件');

  const wrap = h('div', {},
    h('div', { class: 'section-head' },
      h('h1', { text: heading }),
      h('span', { class: 'sub', text: nodes.length + ' 项' }),
    ),
    ctx.selectionSlot,
    renderFileList(listContext(ctx, nodes)),
    hints(),
  );
  runtime.paintSelection();
  return wrap;
}

/** The body of the view slot: skeleton, error, search, or a list. */
export function viewContent(ctx) {
  const state = store.state;
  if (state.loading) return skeletonView();
  if (state.loadError) {
    return h('div', { class: 'empty', style: { paddingTop: '64px' } },
      raw(icon('alert', 30)),
      h('b', { text: '加载失败' }),
      h('p', { text: state.loadError }),
      h('button', {
        class: 'btn btn-primary', attrs: { type: 'button', style: 'margin-top:8px' }, text: '重试',
        on: { click: () => runtime.refreshData() },
      }),
    );
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
