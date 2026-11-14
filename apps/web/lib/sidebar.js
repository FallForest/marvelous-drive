/*
 * sidebar.js — brand, search, nav (云盘 / 星标 / 回收站), the folder tree and
 * the pinned footer (storage usage + account menu).
 *
 * The tree renders only folders, recursively, but expanded state lives in the
 * store so re-rendering any view keeps the same open branches.
 */

import { h, raw } from './dom.js';
import { icon, bytes, initials } from './format.js';
import { renderMenu } from './select.js';

const NAV = [
  { key: 'drive', label: '我的云盘', icon: 'harddrive', path: () => '/' },
  { key: 'starred', label: '星标', icon: 'star', path: () => '/starred' },
  { key: 'trash', label: '回收站', icon: 'trash', path: () => '/trash' },
];

export function renderSidebar(ctx) {
  const state = ctx.state;
  const route = state.route;
  const index = ctx.index;
  const searchInput = h('input', {
    class: 'input',
    attrs: {
      type: 'search', placeholder: '搜索文件', 'aria-label': '搜索文件',
      value: route.name === 'search' ? (route.query || '') : '',
      autocomplete: 'off', spellcheck: 'false',
    },
    on: {
      input: ctx.onSearchInput,
      keydown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); ctx.onSearchCommit(searchInput.value); }
        if (event.key === 'Escape') { searchInput.value = ''; ctx.onSearchClear(); searchInput.blur(); }
      },
    },
  });

  const nav = h('nav', { class: 'side-section', attrs: { 'aria-label': '主导航' } },
    h('div', { class: 'side-label' }, h('span', { text: '导航' })),
    NAV.map((item) => h('button', {
      class: 'side-row',
      attrs: { type: 'button', 'aria-current': route.name === item.key ? 'page' : null },
      on: {
        click: () => ctx.navigate(item.path()),
        ...(item.key === 'drive' ? {
          dragenter: (event) => ctx.onFolderDragOver?.(null, event),
          dragover: (event) => ctx.onFolderDragOver?.(null, event),
          dragleave: (event) => ctx.onFolderDragLeave?.(null, event),
          drop: (event) => ctx.onFolderDrop?.(null, event),
        } : {}),
      },
    }, raw(icon(item.icon, 15)), h('span', { text: item.label }),
      item.key === 'trash' && state.stats && state.stats.trashed
        ? h('span', { class: 'count', text: String(state.stats.trashed) })
        : null,
      item.key === 'starred' && state.stats && state.stats.starred
        ? h('span', { class: 'count', text: String(state.stats.starred) })
        : null,
    )),
  );

  const treeHost = h('div', { class: 'side-section', attrs: { 'aria-label': '文件夹' } },
    h('div', { class: 'side-label' },
      h('span', { text: '文件夹' }),
      h('button', {
        attrs: { type: 'button', 'aria-label': '新建文件夹', title: '新建文件夹' },
        html: icon('plus', 12),
        on: { click: () => ctx.onNewFolder(null) },
      }),
    ),
  );
  const roots = (index.children.get('root') || []).filter((node) => node.kind === 'folder');
  if (!roots.length) {
    treeHost.appendChild(h('p', { class: 'tree-empty', text: '还没有文件夹' }));
  } else {
    const tree = h('div', { class: 'tree', attrs: { role: 'tree', 'aria-label': '文件夹树' } });
    for (const folder of roots) tree.appendChild(treeRow(folder, 0, ctx, route));
    treeHost.appendChild(tree);
  }

  const stats = state.stats;
  const used = stats ? stats.bytes : 0;
  const quota = stats && stats.quotaBytes ? stats.quotaBytes : 0;
  const ratio = quota > 0 ? Math.min(1, used / quota) : 0;

  const storage = h('div', { class: 'storage' },
    h('div', { class: 'storage-line' },
      h('span', { text: '已用 ' + bytes(used) }),
      quota > 0 ? h('span', { text: '共 ' + bytes(quota) }) : null,
    ),
    // scaleX, not width: the bar animates whenever the quota is refreshed, and a
    // width transition relayouts the whole sidebar footer on every frame.
    h('div', { class: 'storage-bar', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-label': '存储使用量' } },
      h('i', { style: { transform: 'scaleX(' + ratio.toFixed(4) + ')' } }),
    ),
    storageBreakdown(stats),
  );

  const user = state.user || {};
  const userRow = h('button', {
    class: 'user-row',
    attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': '账号菜单' },
    on: { click: (event) => ctx.onUserMenu(event.currentTarget) },
  },
    h('span', { class: 'avatar', attrs: { 'aria-hidden': 'true' }, text: initials(user.name || user.email) }),
    h('span', { class: 'user-copy' },
      h('b', { text: user.name || (user.email ? user.email.split('@')[0] : '未登录') }),
      h('small', { text: user.email || '' }),
    ),
    raw(icon('chevron-up', 13)),
  );

  return h('aside', { class: 'sidebar', attrs: { 'aria-label': '侧边栏' } },
    h('div', { class: 'brand' },
      h('span', { class: 'brand-mark', html: icon('harddrive', 14) }),
      h('span', { class: 'brand-text' }, h('b', { text: 'Marvelous Drive' }), h('small', { text: '个人云盘' })),
    ),
    h('div', { class: 'side-scroll' },
      h('div', { class: 'side-search' },
        h('div', { class: 'search-field' }, raw(icon('search', 14)), searchInput, h('kbd', { text: '/' })),
      ),
      nav,
      treeHost,
    ),
    h('div', { class: 'side-foot' },
      storage,
      userRow,
    ),
  );
}

function treeRow(folder, depth, ctx, route) {
  const state = ctx.state;
  const index = ctx.index;
  const children = (index.children.get(folder.id) || []).filter((node) => node.kind === 'folder');
  const expanded = state.expanded.has(folder.id);
  const hasChildren = children.length > 0;
  const active = route.name === 'drive' && route.folderId === folder.id;

  const row = h('button', {
    class: 'side-row folder',
    attrs: {
      type: 'button', role: 'treeitem', 'aria-current': active ? 'page' : null,
      'aria-expanded': hasChildren ? (expanded ? 'true' : 'false') : null,
      style: 'padding-left:' + (8 + depth * 12) + 'px',
      title: folder.name,
    },
    on: {
      click: (event) => {
        if (event.target.closest('.caret')) {
          event.stopPropagation();
          ctx.onToggleFolder(folder.id);
          return;
        }
        ctx.navigate('/folder/' + encodeURIComponent(folder.id));
      },
      // Drop target for a dragged row: the shell installs the handlers because
      // it owns the drop bookkeeping (Files vs. our payload, hover state).
      dragenter: (event) => { if (ctx.onFolderDragOver) ctx.onFolderDragOver(folder.id, event); },
      dragover: (event) => { if (ctx.onFolderDragOver) ctx.onFolderDragOver(folder.id, event); },
      dragleave: (event) => { if (ctx.onFolderDragLeave) ctx.onFolderDragLeave(folder.id, event); },
      drop: (event) => { if (ctx.onFolderDrop) ctx.onFolderDrop(folder.id, event); },
    },
  },
    h('span', {
      class: 'caret',
      style: hasChildren ? null : 'visibility:hidden',
      html: hasChildren ? icon(expanded ? 'chevron-down' : 'chevron-right', 12) : '',
    }),
    raw(icon('folder', 15)),
    h('span', { class: 'truncate', text: folder.name }),
  );

  const group = h('div', { class: 'stack', attrs: { style: 'gap:1px' } }, row);
  if (hasChildren && expanded) {
    const childTree = h('div', { class: 'tree', attrs: { role: 'group' } });
    for (const child of children) childTree.appendChild(treeRow(child, depth + 1, ctx, route));
    group.appendChild(childTree);
  }
  return group;
}

/* ── breadcrumb ───────────────────────────────────────────────── */
const ROUTE_TITLE = {
  trash: '回收站', starred: '星标', search: '搜索',
};

export function renderBreadcrumb(ctx) {
  const state = ctx.state;
  const route = state.route;
  const crumbs = [];

  if (route.name !== 'drive') {
    crumbs.push({ label: '我的云盘', path: '/', folderId: null });
    // Trash / starred / search are views, not folders: nothing can land there.
    crumbs.push({ label: ROUTE_TITLE[route.name] || '未命名', path: null });
  } else {
    crumbs.push({ label: '我的云盘', path: '/', folderId: null });
    const path = ctx.ancestors || [];
    for (let i = 0; i < path.length; i += 1) {
      const node = path[i];
      crumbs.push({
        label: node.name,
        path: i === path.length - 1 ? null : '/folder/' + encodeURIComponent(node.id),
        folderId: node.id,
      });
    }
  }

  const bar = h('nav', { class: 'crumbs', attrs: { 'aria-label': '路径' } });
  crumbs.forEach((crumb, index) => {
    if (index > 0) bar.appendChild(h('span', { class: 'crumb-sep', html: icon('chevron-right', 13) }));
    // Every breadcrumb level is a drop target, including the level being shown
    // (dropping there is a no-op the server accepts without a version bump).
    const dropHandlers = crumb.folderId === undefined ? null : {
      dragenter: (event) => { if (ctx.onFolderDragOver) ctx.onFolderDragOver(crumb.folderId, event); },
      dragover: (event) => { if (ctx.onFolderDragOver) ctx.onFolderDragOver(crumb.folderId, event); },
      dragleave: (event) => { if (ctx.onFolderDragLeave) ctx.onFolderDragLeave(crumb.folderId, event); },
      drop: (event) => { if (ctx.onFolderDrop) ctx.onFolderDrop(crumb.folderId, event); },
    };
    if (crumb.path) {
      bar.appendChild(h('button', {
        class: 'crumb', attrs: { type: 'button' }, text: crumb.label,
        on: Object.assign({ click: () => ctx.navigate(crumb.path) }, dropHandlers || {}),
      }));
    } else {
      bar.appendChild(h('span', {
        class: 'crumb', attrs: { 'aria-current': 'page', title: crumb.label }, text: crumb.label,
        on: dropHandlers || undefined,
      }));
    }
  });
  return bar;
}


/**
 * Coarse "what is taking the space" line under the usage bar.
 *
 * Only the top three kinds are shown; the full report lives in the stats
 * payload, and a footer that lists seven categories is noise.
 */
function storageBreakdown(stats) {
  const byKind = stats && stats.byKind;
  const kinds = byKind && byKind.kinds ? Object.entries(byKind.kinds) : [];
  if (!kinds.length) return null;
  const LABEL = { document: '文档', image: '图片', video: '视频', audio: '音频', archive: '压缩包', code: '代码', other: '其他' };
  const top = kinds
    .slice()
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 3);
  return h('div', { class: 'storage-kinds' },
    top.map(([kind, value]) => h('span', { attrs: { title: value.files + ' 个文件' } },
      h('i', { class: 'dot dot-' + kind }),
      (LABEL[kind] || kind) + ' ' + bytes(value.bytes),
    )),
  );
}

/* ── toolbar ──────────────────────────────────────────────────── */
/**
 * Toolbar contents. Returned as a child list (not a wrapper element) so the
 * caller can mount it straight into the persistent <div class="toolbar">;
 * the row keeps its 40px height and borders across re-renders.
 */
export function renderToolbar(ctx) {
  const state = ctx.state;
  const route = state.route;
  const isTrash = route.name === 'trash';
  const nodes = [];

  if (!isTrash) {
    const uploadBtn = h('button', {
      class: 'btn btn-primary', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      on: { click: (event) => ctx.onUploadClick(event.currentTarget) },
    }, raw(icon('upload', 14)), '上传', raw(icon('chevron-down', 12)));
    nodes.push(uploadBtn);
    nodes.push(h('button', {
      class: 'btn', attrs: { type: 'button' },
      on: { click: () => ctx.onNewFolder(route.name === 'drive' ? (route.folderId || null) : null) },
    }, raw(icon('folder-plus', 14)), '新建文件夹'));
  } else {
    nodes.push(h('span', { class: 'dialog-note', text: '回收站中的文件可以还原，或永久删除。' }));
  }

  nodes.push(h('span', { class: 'push' }));
  nodes.push(h('span', { class: 'seg-label', text: '排序' }));

  // A button, not a <select>: this control sits in a row of 28px buttons, and
  // the native widget brought its own height, its own type scale and an arrow
  // that sat below the optical centre. The menu behind it is the app's own.
  nodes.push(renderMenu({
    label: '排序方式',
    className: 'sort-menu',
    value: state.sortKey,
    options: [
      { value: 'name', label: '按名称' },
      { value: 'size', label: '按大小' },
      { value: 'updated', label: '按更新时间' },
    ],
    onChange: (value) => ctx.onSort(value),
  }));
  nodes.push(h('button', {
    class: 'icon-btn', attrs: {
      type: 'button',
      'aria-label': state.sortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序',
      title: state.sortDir === 'asc' ? '升序' : '降序',
    },
    html: icon(state.sortDir === 'asc' ? 'arrow-up' : 'arrow-down', 13),
    on: { click: () => ctx.onSortDirection() },
  }));

  nodes.push(h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': '视图' } },
    h('button', {
      attrs: { type: 'button', 'aria-pressed': state.view === 'list' ? 'true' : 'false', 'aria-label': '列表视图', title: '列表视图' },
      html: icon('list', 14), on: { click: () => ctx.onViewChange('list') },
    }),
    h('button', {
      attrs: { type: 'button', 'aria-pressed': state.view === 'grid' ? 'true' : 'false', 'aria-label': '网格视图', title: '网格视图' },
      html: icon('grid', 14), on: { click: () => ctx.onViewChange('grid') },
    }),
  ));

  return nodes;
}
