/*
 * files.js — the file list / grid and everything a row can do.
 * Rendering is delegated: one listener on the container handles clicks, so
 * re-rendering after a star toggle never leaks handlers.
 */

import { h, raw } from './dom.js';
import { icon, kindIcon, fileKind, bytes, relativeTime, formatDate, sortNodes } from './format.js';
import { openMenu } from './ui.js';
import { api, fetchBlob } from './api.js';
import { canThumbnail, clearThumbs, rememberThumb } from './thumb-cache.js';

const COLUMNS = [
  { key: 'name', label: '名称', cls: 'col-name' },
  { key: 'size', label: '大小', cls: 'col-size num' },
  { key: 'updated', label: '更新时间', cls: 'col-date' },
];

/** Rows + header. ctx: { nodes, sortKey, sortDir, selection, view, onSort } */
export function renderFileList(ctx) {
  const state = ctx.state;
  const nodes = sortNodes(state.nodes, state.sortKey, state.sortDir);
  const wrap = h('div', { class: 'list' });

  if (!nodes.length) {
    wrap.appendChild(emptyFolder(ctx));
    return wrap;
  }

  if (state.view === 'grid') {
    wrap.appendChild(renderGrid(ctx, nodes));
    return wrap;
  }

  const head = h('div', { class: 'list-head', attrs: { role: 'row' } });
  for (const column of COLUMNS) {
    const active = state.sortKey === column.key;
    head.appendChild(h('button', {
      class: column.cls,
      attrs: {
        type: 'button',
        role: 'columnheader',
        'aria-sort': active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
        'data-sort': column.key,
      },
      on: { click: () => ctx.onSort(column.key) },
    }, column.label, active ? raw(icon(state.sortDir === 'asc' ? 'arrow-up' : 'arrow-down', 11)) : null));
  }
  head.appendChild(h('span', { attrs: { 'aria-hidden': 'true' } }));
  head.appendChild(h('span', { attrs: { 'aria-hidden': 'true' } }));
  wrap.appendChild(head);

  const body = h('div', { class: 'list-body', attrs: { role: 'rowgroup' } });
  for (const node of nodes) body.appendChild(renderRow(ctx, node, state.selection.has(node.id)));
  wrap.appendChild(body);
  return wrap;
}

function renderRow(ctx, node, selected) {
  const state = ctx.state;
  const isFolder = node.kind === 'folder';
  const kind = isFolder ? 'folder' : fileKind(node.mime, node.name);
  const nameEl = h('span', { class: 'name', attrs: { title: node.name }, text: node.name });
  const kindEl = h('span', { class: 'kind' + (isFolder ? ' is-folder' : ''), html: icon(kindIcon(kind, node.name), 16) });
  // Only the three formats the server thumbnails get an image; the rest keep the icon.
  if (!isFolder && canThumbnail(node.mime)) attachRowThumb(kindEl, node);
  const main = h('div', { class: 'frow-main' },
    kindEl,
    nameEl,
  );

  const starBtn = h('button', {
    class: 'icon-btn star',
    attrs: {
      type: 'button',
      'aria-label': node.starred ? '取消星标' : '加星标',
      'aria-pressed': node.starred ? 'true' : 'false',
      'data-action': 'star',
    },
    html: icon('star', 13),
    on: {
      click: (event) => { event.stopPropagation(); ctx.onToggleStar(node); },
      keydown: (event) => event.stopPropagation(),
    },
  });
  if (node.starred) starBtn.classList.add('is-on');

  const moreBtn = h('button', {
    class: 'icon-btn more',
    attrs: { type: 'button', 'aria-label': '更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-action': 'more' },
    html: icon('more-horizontal', 14),
    on: {
      click: (event) => { event.stopPropagation(); openRowMenu(ctx, node, moreBtn); },
      keydown: (event) => event.stopPropagation(),
    },
  });

  const row = h('div', {
    class: 'frow',
    dataset: { id: node.id, selected: selected ? 'true' : 'false' },
    attrs: { role: 'row', tabindex: '0', draggable: 'true', 'aria-selected': selected ? 'true' : 'false', 'aria-label': node.name },
    on: {
      click: (event) => ctx.onRowClick(node, event),
      dblclick: (event) => { event.preventDefault(); ctx.onOpen(node); },
      keydown: (event) => ctx.onRowKey(event, node),
      contextmenu: (event) => { event.preventDefault(); ctx.onRowClick(node, event); openRowMenu(ctx, node, moreBtn); },
      // Dragging a row moves it (or the whole selection); dropping it on a
      // folder row / breadcrumb is handled by the drop targets in app.js.
      dragstart: (event) => { if (ctx.onRowDragStart) ctx.onRowDragStart(node, event); },
      dragend: (event) => { if (ctx.onRowDragEnd) ctx.onRowDragEnd(node, event); },
    },
  },
    main,
    h('span', { class: 'meta num', attrs: { role: 'cell' }, text: isFolder ? '—' : bytes(node.size) }),
    h('span', { class: 'meta date', attrs: { role: 'cell', title: formatDate(node.updatedAt) }, text: relativeTime(node.updatedAt) }),
    starBtn,
    moreBtn,
  );
  return row;
}

/* Thumbnails need the bearer header, so images are fetched as blobs and cached
   as object URLs. One module-level map serves the list and the grid; it is not
   cleared when the view re-renders or the page changes (200 entries), because
   re-downloading every thumbnail on each navigation is the whole problem. */
const thumbCache = new Map();
const THUMB_CACHE_LIMIT = 200;
const LIST_THUMB_WIDTH = 96;
const GRID_THUMB_WIDTH = 240;

/** Server-side thumbnail URL. Width is a hint; the bytes are the original. */
export function thumbnailUrl(id, width) {
  return '/api/v1/files/' + encodeURIComponent(id) + '/thumbnail?w=' + (width || LIST_THUMB_WIDTH);
}

function thumbFor(node, width) {
  const cached = thumbCache.get(node.id);
  if (cached) return Promise.resolve(cached);
  return fetchBlob(thumbnailUrl(node.id, width)).then((blob) => {
    const url = URL.createObjectURL(blob);
    const stored = rememberThumb(thumbCache, node.id, url, THUMB_CACHE_LIMIT);
    // A concurrent render may have won the race: keep its URL, drop this one.
    if (stored.reused && stored.url !== url) URL.revokeObjectURL(url);
    for (const evicted of stored.evicted) URL.revokeObjectURL(evicted);
    return stored.url;
  });
}

export function clearThumbCache() {
  for (const url of clearThumbs(thumbCache)) URL.revokeObjectURL(url);
}

/** Swaps the row icon for a 32px thumbnail, silently keeping the icon on failure. */
function attachRowThumb(kindEl, node) {
  thumbFor(node, LIST_THUMB_WIDTH)
    .then((url) => {
      if (!kindEl.isConnected) return;
      kindEl.classList.add('has-thumb');
      kindEl.replaceChildren(h('img', {
        class: 'thumb-inline',
        attrs: { alt: '', loading: 'lazy', decoding: 'async', width: '32', height: '32', src: url },
      }));
    })
    .catch(() => { /* no thumbnail: the icon stays */ });
}

function renderGrid(ctx, nodes) {
  const grid = h('div', { class: 'grid', attrs: { role: 'list' } });
  for (const node of nodes) {
    const isFolder = node.kind === 'folder';
    const kind = isFolder ? 'folder' : fileKind(node.mime, node.name);
    const selected = ctx.state.selection.has(node.id);
    const thumb = h('div', { class: 'thumb' });
    if (kind === 'image') {
      const placeholder = raw(icon('file-image', 26));
      thumb.appendChild(placeholder);
      thumbFor(node, GRID_THUMB_WIDTH).then((url) => {
        if (!thumb.isConnected) return;
        const img = h('img', { attrs: { alt: '', loading: 'lazy', decoding: 'async', src: url } });
        thumb.replaceChildren(img);
      }).catch(() => { /* keep the icon placeholder */ });
    } else {
      thumb.innerHTML = icon(kindIcon(kind, node.name), 26);
    }

    const starBtn = h('button', {
      class: 'icon-btn' + (node.starred ? ' is-on' : ''),
      attrs: { type: 'button', 'aria-label': node.starred ? '取消星标' : '加星标', 'aria-pressed': node.starred ? 'true' : 'false' },
      html: icon('star', 13),
      on: { click: (event) => { event.stopPropagation(); ctx.onToggleStar(node); } },
    });
    const moreBtn = h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', 'aria-label': '更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      html: icon('more-horizontal', 13),
      on: { click: (event) => { event.stopPropagation(); openRowMenu(ctx, node, event.currentTarget); } },
    });

    grid.appendChild(h('div', {
      class: 'gcard',
      dataset: { id: node.id, selected: selected ? 'true' : 'false' },
      attrs: { role: 'listitem', tabindex: '0', draggable: 'true', 'aria-selected': selected ? 'true' : 'false', 'aria-label': node.name },
      on: {
        click: (event) => ctx.onRowClick(node, event),
        dblclick: (event) => { event.preventDefault(); ctx.onOpen(node); },
        keydown: (event) => ctx.onRowKey(event, node),
        contextmenu: (event) => { event.preventDefault(); ctx.onRowClick(node, event); openRowMenu(ctx, node, moreBtn); },
        dragstart: (event) => { if (ctx.onRowDragStart) ctx.onRowDragStart(node, event); },
        dragend: (event) => { if (ctx.onRowDragEnd) ctx.onRowDragEnd(node, event); },
      },
    },
      thumb,
      h('div', { class: 'gname' },
        h('span', { text: node.name }),
      ),
      h('div', { class: 'gmeta', text: isFolder ? '文件夹' : bytes(node.size) + ' · ' + relativeTime(node.updatedAt) }),
      h('div', { class: 'gactions' }, starBtn, moreBtn),
    ));
  }
  return grid;
}

function emptyFolder(ctx) {
  const route = ctx.state.route;
  const isTrash = route.name === 'trash';
  const isStarred = route.name === 'starred';
  return h('div', { class: 'empty' },
    raw(icon(isTrash ? 'trash' : isStarred ? 'star' : 'folder', 30)),
    h('b', { text: isTrash ? '回收站是空的' : isStarred ? '还没有星标文件' : '这个文件夹还是空的' }),
    h('p', {
      text: isTrash
        ? '删除的文件会先进入回收站，30 天内可以还原。'
        : isStarred
          ? '在文件行左侧点击星标，常用文件会出现在这里。'
          : '把文件拖到这里，或使用上方的上传按钮。',
    }),
  );
}

/** Row context menu — shared by the ⋯ button and right click. */
export function openRowMenu(ctx, node, anchor) {
  const isTrash = ctx.state.route.name === 'trash';
  const isFolder = node.kind === 'folder';
  const items = [];
  if (isTrash) {
    items.push(
      { label: '还原', icon: 'rotate-ccw', onSelect: () => ctx.onRestore(node) },
      { separator: true },
      { label: '永久删除', icon: 'trash', danger: true, onSelect: () => ctx.onPurge(node) },
    );
  } else {
    if (!isFolder) items.push({ label: '预览', icon: 'eye', onSelect: () => ctx.onPreview(node) });
    if (isFolder) items.push({ label: '打开', icon: 'folder', onSelect: () => ctx.onOpen(node) });
    if (!isFolder) items.push({ label: '下载', icon: 'download', onSelect: () => ctx.onDownload(node) });
    // A folder has no bytes of its own; the server zips it into a sibling file.
    if (isFolder) items.push({ label: '下载为 ZIP', icon: 'download', onSelect: () => ctx.onDownloadArchive(node) });
    items.push({ label: '分享', icon: 'share', onSelect: () => ctx.onShare(node) });
    items.push({ separator: true });
    items.push({ label: '重命名', icon: 'pencil', kbd: 'F2', onSelect: () => ctx.onRename(node) });
    items.push({ label: '移动到…', icon: 'move', onSelect: () => ctx.onMove(node) });
    items.push(!isFolder
      ? { label: '复制链接', icon: 'link', onSelect: () => ctx.onCopyLink(node) }
      : { label: '复制文件夹名', icon: 'copy', onSelect: () => ctx.onCopyLink(node) });
    items.push({ separator: true });
    items.push({ label: '删除', icon: 'trash', danger: true, kbd: 'Del', onSelect: () => ctx.onDelete(node) });
  }
  return openMenu({ anchor, items });
}

/* ── inline rename ────────────────────────────────────────────── */
/** Swap a row's name for an input; Enter commits, Escape cancels. */
export function beginInlineRename(rowEl, initialName, commit) {
  if (!rowEl) return;
  const nameEl = rowEl.querySelector('.name');
  if (!nameEl) return;
  const input = h('input', {
    class: 'name-input',
    attrs: { 'aria-label': '文件名', maxlength: '255' },
    value: initialName,
  });
  nameEl.replaceWith(input);
  input.focus();
  const ext = initialName.lastIndexOf('.');
  if (ext > 0) input.setSelectionRange(0, ext);
  else input.select();
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    if (value && value !== initialName) commit(value);
    else {
      const restored = h('span', { class: 'name', attrs: { title: initialName }, text: initialName });
      input.replaceWith(restored);
    }
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); finish(input.value.trim()); }
    else if (event.key === 'Escape') { event.preventDefault(); input.value = initialName; finish(null); }
  });
  input.addEventListener('blur', () => finish(input.value.trim()));
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());
}

/* ── row-level API actions (used by app.js) ───────────────────── */
export async function toggleStar(node) {
  const payload = await api.put('/nodes/' + node.id + '/star', { starred: !node.starred });
  const starred = payload && typeof payload.starred === 'boolean' ? payload.starred : !node.starred;
  node.starred = starred;
  return starred;
}

export async function createFolder(parentId, name) {
  const payload = await api.post('/nodes', { name, kind: 'folder', parentId: parentId || undefined });
  return payload.node;
}

export async function renameNode(node, name) {
  const payload = await api.put('/nodes/' + node.id, { name });
  return payload.node;
}

export async function moveNode(node, parentId) {
  const payload = await api.put('/nodes/' + node.id, { parentId: parentId || null });
  return payload.node;
}

export async function deleteNode(node) {
  return api.del('/nodes/' + node.id);
}

export async function restoreNode(node) {
  return api.post('/nodes/' + node.id + '/restore');
}

export async function purgeNode(node) {
  return api.del('/nodes/' + node.id + '/permanent');
}

export async function copyNode(node, parentId) {
  const payload = await api.post('/nodes/' + node.id + '/copy', { parentId: parentId || undefined });
  return payload.node;
}

/** Absolute URL for a share token (same origin). */
export function shareUrl(token) {
  return window.location.origin + '/s/' + encodeURIComponent(token);
}
