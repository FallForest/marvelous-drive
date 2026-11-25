/*
 * files.js — the file list / grid and everything a row can do.
 * Rendering is delegated: one listener on the container handles clicks, so
 * re-rendering after a star toggle never leaks handlers.
 */

import { h, raw } from './dom.js';
import { icon, kindIcon, fileKind, bytes, relativeTime, formatDate, sortNodes } from './format.js';
import { openMenu } from './ui.js';
import { api, fetchBlob, getToken } from './api.js';
import { rememberThumb, THUMBNAIL_MIMES } from './thumb-cache.js';
import { createThumbnailLoader } from './thumbnail-loader.js';
import { isTrashFilterActive, trashFilterEmptyText } from './trash-filter.js';

const COLUMNS = [
  { key: 'name', label: '名称', cls: 'col-name' },
  { key: 'size', label: '大小', cls: 'col-size num' },
  { key: 'updated', label: '更新时间', cls: 'col-date' },
];

/**
 * The per-row checkbox: the explicit "select without opening" gesture.
 *
 * A plain click on a row opens the item now (see row-action.js), so selection
 * needs its own target — the same split Finder, Google Drive and Notion all
 * arrive at. It is a real <input type=checkbox> so the keyboard, screen readers
 * and the browser's own checked state work without a role of our own.
 */
function selectionBox(ctx, node, selected, extraClass) {
  const box = h('input', {
    class: 'pick' + (extraClass ? ' ' + extraClass : ''),
    attrs: {
      type: 'checkbox',
      'aria-label': '选择 ' + node.name,
      'data-action': 'pick',
      // Not data-id: that attribute means "a row" to the selection painter, the
      // drag layer and every browser check that counts rows.
      'data-for': node.id,
    },
    checked: selected,
    on: {
      // never let the checkbox's click reach the row: that click means select.
      click: (event) => {
        event.stopPropagation();
        ctx.onSelectToggle(node);
      },
      dblclick: (event) => event.stopPropagation(),
      keydown: (event) => event.stopPropagation(),
    },
  });
  return box;
}

/** Header checkbox: select all / clear, with the indeterminate state for a partial pick. */
function selectAllBox(ctx, nodes, selectedCount) {
  const all = nodes.length > 0 && selectedCount >= nodes.length;
  const box = h('input', {
    class: 'pick pick-all',
    attrs: { type: 'checkbox', 'aria-label': '全选', 'data-action': 'pick-all' },
    checked: all,
    on: {
      // The shell's handler reads the live selection; passing a checkbox state
      // captured here would make the second click behave like the first.
      click: (event) => {
        event.stopPropagation();
        ctx.onSelectAll(nodes);
      },
      keydown: (event) => event.stopPropagation(),
    },
  });
  // A half-checked header is the honest picture of "some of these are selected".
  box.indeterminate = selectedCount > 0 && selectedCount < nodes.length;
  return box;
}

/** Whether the current route is the trash list. */
function isTrashRoute(ctx) {
  return Boolean(ctx && ctx.state && ctx.state.route && ctx.state.route.name === 'trash');
}

/**
 * Where a trashed item used to live, as one readable line.
 *
 * The server sends `originalPath` root-to-parent for the trash page, `[]` for
 * an item deleted from the root, and `null` when an ancestor is no longer
 * visible. A missing path on a row whose parentId is still root is also a root
 * item; anything else without a path cannot say where it was.
 */
function trashOrigin(node) {
  const path = node && node.originalPath;
  if (Array.isArray(path)) {
    const names = path
      .map((segment) => (typeof segment === 'string' ? segment : segment && (segment.name || segment.title)) || '')
      .filter(Boolean);
    const segments = ['我的云盘'].concat(names);
    return { text: segments.slice(-2).join(' / '), full: segments.join(' / ') };
  }
  const parentId = node && node.parentId;
  if (parentId === null || parentId === undefined || parentId === '' || parentId === 'root') {
    return { text: '我的云盘', full: '我的云盘' };
  }
  return { text: '原位置不可用', full: '原位置不可用' };
}

/**
 * The one secondary line a trashed row or card carries: when it was deleted
 * plus its original folder, because the date column disappears on narrow
 * screens. The time leads so truncation cannot hide it. Pure formatting — no
 * path request, and no link back into the trash.
 */
function trashMeta(node) {
  const origin = trashOrigin(node);
  const deletedAt = node && node.deletedAt;
  const when = relativeTime(deletedAt);
  const text = when ? when + '删除 · ' + origin.text : origin.text;
  const fullWhen = formatDate(deletedAt);
  const title = fullWhen ? origin.full + ' · 删除于 ' + fullWhen : origin.full;
  return { text, title };
}

/**
 * Muted single-line element for trashMeta, truncated like searchLocation.
 *
 * Rows have no CSS class of their own for this line, so the muted typography
 * is inline; cards already style `.gmeta`, which is why only the truncation is
 * applied there (the caller passes its class name).
 */
function trashMetaEl(node, className, { typography = true } = {}) {
  const meta = trashMeta(node);
  const el = h('div', { class: className, attrs: { title: meta.title }, text: meta.text });
  Object.assign(el.style, {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: '0',
    maxWidth: '100%',
    ...(typography ? { fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', lineHeight: '1.2' } : null),
  });
  return el;
}

/** Rows + header. ctx: { nodes, sortKey, sortDir, selection, view, onSort } */
export function renderFileList(ctx) {
  const state = ctx.state;
  const trash = isTrashRoute(ctx);
  const nodes = state.serverSorted ? state.nodes : sortNodes(state.nodes, state.sortKey, state.sortDir);
  const wrap = h('div', { class: 'list' });

  if (!nodes.length) {
    wrap.appendChild(emptyFolder(ctx));
    return wrap;
  }

  if (state.view === 'grid') {
    // Folders and files may live in two grids of their own; the caller only
    // cares that each one lands in the same list wrapper.
    for (const grid of renderGrid(ctx, nodes)) wrap.appendChild(grid);
    return wrap;
  }

  const head = h('div', { class: 'list-head', attrs: { role: 'row' } });
  const selectedCount = nodes.filter((node) => state.selection.has(node.id)).length;
  head.appendChild(h('span', { class: 'col-pick' }, selectAllBox(ctx, nodes, selectedCount)));
  for (const column of COLUMNS) {
    const active = state.sortKey === column.key;
    // The paged trash is ordered by deleted_at, so the same column is labelled
    // for what it actually sorts there.
    const label = trash && column.key === 'updated' ? '删除时间' : column.label;
    head.appendChild(h('button', {
      class: column.cls,
      attrs: {
        type: 'button',
        role: 'columnheader',
        'aria-sort': active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
        'data-sort': column.key,
      },
      on: { click: () => ctx.onSort(column.key) },
    }, label, active ? raw(icon(state.sortDir === 'asc' ? 'arrow-up' : 'arrow-down', 11)) : null));
  }
  head.appendChild(h('span', { attrs: { 'aria-hidden': 'true' } }));
  head.appendChild(h('span', { attrs: { 'aria-hidden': 'true' } }));
  wrap.appendChild(head);

  const body = h('div', { class: 'list-body', attrs: { role: 'rowgroup' } });
  for (const node of nodes) body.appendChild(renderRow(ctx, node, state.selection.has(node.id)));
  wrap.appendChild(body);
  return wrap;
}

/**
 * The dragover / dragleave / drop trio for a row that can RECEIVE a dragged
 * node.
 *
 * Only folders qualify: dropping a file onto a file has no meaning, and a
 * handler that accepts it would paint a highlight promising something the drop
 * cannot deliver. A folder being dragged is not excluded here — dnd.js asks
 * planMoves(), which owns the "not into yourself, not into your own subtree"
 * rule, so this list and the sidebar cannot disagree.
 */
function dropTargetHandlers(ctx, node) {
  if (!node || node.kind !== 'folder') return {};
  return {
    dragover: (event) => { if (ctx.onFolderDragOver) ctx.onFolderDragOver(node.id, event); },
    dragenter: (event) => { if (ctx.onFolderDragOver) ctx.onFolderDragOver(node.id, event); },
    dragleave: (event) => { if (ctx.onFolderDragLeave) ctx.onFolderDragLeave(node.id, event); },
    drop: (event) => { if (ctx.onFolderDrop) ctx.onFolderDrop(node.id, event); },
  };
}

/**
 * Where a search hit came from, as a small button that opens its folder.
 *
 * Outside /search a row is already in its own folder, so this is null. The
 * last two segments are enough to tell two same-named files apart; the full
 * path stays in the tooltip and the accessible name.
 */
function searchLocation(ctx, node) {
  if (!ctx || !ctx.state || !ctx.state.route || ctx.state.route.name !== 'search') return null;
  const path = node && node.path;
  if (!Array.isArray(path)) return null;
  const names = path
    .map((segment) => (typeof segment === 'string' ? segment : segment && (segment.name || segment.title)) || '')
    .filter(Boolean);
  const segments = ['我的云盘'].concat(names);
  const fullPath = segments.join(' / ');
  const button = h('button', {
    class: 'btn-link',
    text: segments.slice(-2).join(' / '),
    attrs: { type: 'button', title: fullPath, 'aria-label': '打开所在文件夹：' + fullPath },
    on: {
      click: (event) => {
        event.stopPropagation();
        if (ctx.navigate) ctx.navigate(node.parentId ? '/folder/' + encodeURIComponent(node.parentId) : '/');
      },
      // The row listens for keys to open and rename; this button is its own target.
      keydown: (event) => { event.stopPropagation(); },
    },
  });
  Object.assign(button.style, {
    fontSize: 'var(--fs-xs)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: '0',
    maxWidth: '100%',
    display: 'block',
    textAlign: 'left',
  });
  return button;
}

function gnameWithLocation(ctx, node) {
  const locationEl = searchLocation(ctx, node);
  // The span carries the untouched name: a folder name is clamped to two lines,
  // so the full string has to stay reachable as the native tooltip.
  const gname = h('div', { class: 'gname' }, h('span', { text: node.name, attrs: { title: node.name } }), locationEl);
  if (locationEl) gname.style.minWidth = '0';
  return gname;
}

function renderRow(ctx, node, selected) {
  const state = ctx.state;
  const trash = isTrashRoute(ctx);
  const isFolder = node.kind === 'folder';
  const kind = isFolder ? 'folder' : fileKind(node.mime, node.name);
  const nameEl = h('span', { class: 'name', attrs: { title: node.name }, text: node.name });
  const kindEl = h('span', { class: 'kind' + (isFolder ? ' is-folder' : ''), html: icon(kindIcon(kind, node.name), 16) });
  // Only the three formats the server thumbnails get an image; the rest keep the icon.
  // Three routes can supply a list thumbnail, and HEIC used to reach none of
  // them: /thumbnail refuses it (415), so a folder of phone photos rendered as
  // a grid of generic picture icons. The transcoding route answers a PNG the
  // same way, so it is used as the thumbnail source too — the decoded preview
  // is cached on the server by blobHash, so the list and the drawer share one
  // decode.
  //
  // The thumbnail routes only serve live files, so a trashed row keeps its icon
  // instead of issuing a request the server is guaranteed to refuse.
  const thumbSource = trash ? null : thumbnailSourceFor(node);
  if (!isFolder && thumbSource) attachRowThumb(kindEl, node, thumbSource);
  // In search results the name alone does not say where the hit lives, and in
  // the trash the deleted item is no longer there: both grow a second line.
  const locationEl = trash ? null : searchLocation(ctx, node);
  const secondaryEl = trash ? trashMetaEl(node, 'trash-meta') : locationEl;
  const nameBox = secondaryEl ? h('div', { class: 'stack' }, nameEl, secondaryEl) : nameEl;
  if (secondaryEl) nameBox.style.minWidth = '0';
  const main = h('div', { class: 'frow-main' },
    kindEl,
    nameBox,
    // A folder advertises the click that goes in; a file has nothing to promise.
    isFolder ? h('span', { class: 'open-hint', html: icon('chevron-right', 12) }) : null,
  );

  // Trashed items cannot be starred, so the button is not built at all; an
  // empty span keeps the desktop grid's row/column alignment for the actions
  // that remain. It carries `star` so the narrow-screen rules that drop that
  // column (`@media (max-width:880px)`) drop the placeholder too.
  let starSlot = null;
  if (trash) {
    starSlot = h('span', { class: 'star', attrs: { 'aria-hidden': 'true' } });
  } else {
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
    starSlot = starBtn;
  }

  const moreBtn = h('button', {
    class: 'icon-btn more',
    attrs: { type: 'button', 'aria-label': '更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-action': 'more' },
    html: icon('more-horizontal', 14),
    on: {
      click: (event) => { event.stopPropagation(); openRowMenu(ctx, node, moreBtn); },
      keydown: (event) => event.stopPropagation(),
    },
  });

  const dateValue = trash ? node.deletedAt : node.updatedAt;
  const row = h('div', {
    class: 'frow' + (isFolder ? ' is-folder' : ''),
    dataset: { id: node.id, selected: selected ? 'true' : 'false', kind: node.kind || 'file' },
    attrs: { role: 'row', tabindex: '0', draggable: 'true', 'aria-selected': selected ? 'true' : 'false', 'aria-label': node.name },
    on: {
      click: (event) => ctx.onRowClick(node, event),
      keydown: (event) => ctx.onRowKey(event, node),
      contextmenu: (event) => { event.preventDefault(); ctx.onSelectOnly(node, event); openRowMenu(ctx, node, moreBtn); },
      // Dragging a row moves it (or the whole selection). Dropping it back on a
      // FOLDER row in this list is the gesture people actually use, so the row
      // is a drop target too — it was not, and the comment that said "handled
      // by app.js" was describing code that had moved away, which is exactly
      // how a folder became un-droppable while the sidebar kept working.
      dragstart: (event) => { if (ctx.onRowDragStart) ctx.onRowDragStart(node, event); },
      dragend: (event) => { if (ctx.onRowDragEnd) ctx.onRowDragEnd(node, event); },
      ...dropTargetHandlers(ctx, node),
    },
  },
    selectionBox(ctx, node, selected, 'row-pick'),
    main,
    h('span', { class: 'meta num', attrs: { role: 'cell' }, text: isFolder ? '—' : bytes(node.size) }),
    h('span', { class: 'meta date', attrs: { role: 'cell', title: formatDate(dateValue) }, text: relativeTime(dateValue) }),
    starSlot,
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
const thumbInFlight = new Map();
const thumbnailLoader = createThumbnailLoader();

/** Real thumbnails use a smaller list representation and a larger grid one. */
const THUMBNAIL_WIDTH = 320;
const LIST_THUMB_WIDTH = 96;

/** Authenticated server-side thumbnail URL. */
function thumbnailUrl(id, width) {
  return '/api/v1/files/' + encodeURIComponent(id) + '/thumbnail?w=' + (width || THUMBNAIL_WIDTH);
}

function thumbFor(node, width, source) {
  const token = getToken();
  const key = token + ':' + node.id + ':' + (node.blobHash || node.version || '') + ':' + width;
  const cached = thumbCache.get(key);
  if (cached) return Promise.resolve(cached);
  if (thumbInFlight.has(key)) return thumbInFlight.get(key);
  const url = source === 'preview-image'
    ? '/api/v1/files/' + encodeURIComponent(node.id) + '/preview-image?w=' + Math.max(width, 240)
    : thumbnailUrl(node.id, width);
  const version = encodeURIComponent(node.blobHash || String(node.version || 1));
  const pending = fetchBlob(url + '&v=' + version).then((blob) => {
    if (getToken() !== token) throw new Error('Session changed during thumbnail loading.');
    const url = URL.createObjectURL(blob);
    const stored = rememberThumb(thumbCache, key, url, THUMB_CACHE_LIMIT);
    // A concurrent render may have won the race: keep its URL, drop this one.
    if (stored.reused && stored.url !== url) URL.revokeObjectURL(url);
    for (const evicted of stored.evicted) URL.revokeObjectURL(evicted);
    return stored.url;
  }).finally(() => thumbInFlight.delete(key));
  thumbInFlight.set(key, pending);
  return pending;
}

/** The cached render URL of one row thumbnail, or null when it is not fetched yet. */
export function peekThumbUrl(node) {
  const id = typeof node === 'string' ? node : node.id;
  const content = typeof node === 'string' ? '' : (node.blobHash || node.version || '') + ':';
  const prefix = getToken() + ':' + id + ':' + content;
  for (const [key, url] of thumbCache) if (key.startsWith(prefix)) return url;
  return null;
}

/**
 * Where a row's thumbnail comes from, or null when there is none.
 *
 * Two routes, one rule: `/thumbnail` for the three formats a browser always
 * decodes, `/preview-image` for the ones the server transcodes (HEIC/HEIF).
 * Both answer immutable-cacheable bytes keyed by the blob, so the same picture
 * costs one request whether it is seen in the list or in the drawer.
 */
export function thumbnailSourceFor(node) {
  if (!node || node.kind === 'folder') return null;
  const mime = String(node.mime || '').split(';')[0].trim().toLowerCase();
  if (THUMBNAIL_MIMES.has(mime)) return 'thumbnail';
  if (mime === 'image/heic' || mime === 'image/heif') return 'preview-image';
  return null;
}

/** Swaps the row icon for a 32px thumbnail, silently keeping the icon on failure. */
function attachRowThumb(kindEl, node, source) {
  thumbnailLoader.watch(kindEl, () => thumbFor(node, LIST_THUMB_WIDTH, source)
    .then((url) => {
      if (!kindEl.isConnected) return;
      kindEl.classList.add('has-thumb');
      kindEl.replaceChildren(h('img', {
        class: 'thumb-inline',
        attrs: { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', width: '32', height: '32', src: url },
      }));
    })
    .catch(() => { /* no thumbnail: the icon stays */ }));
}

/**
 * The counts line under a folder's name, from the server's childCounts.
 *
 * Only the direct children are counted (that is the server's contract), and a
 * missing field is left out rather than shown as 0 — "unknown" and "none" are
 * different answers. With no counts at all the line falls back to the noun.
 */
function folderMetaText(node) {
  const counts = node && node.childCounts;
  if (!counts) return '文件夹';
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const folders = num(counts.folders);
  const files = num(counts.files);
  if (folders === null && files === null) return '文件夹';
  if (!folders && !files) return '空文件夹';
  const parts = [];
  if (folders) parts.push(folders + ' 个文件夹');
  if (files) parts.push(files + ' 个文件');
  return parts.join(' · ');
}

/** Star + overflow, shared by both card shapes. */
function cardActions(ctx, node) {
  // A trashed card cannot be starred, so only the overflow action remains.
  const starBtn = isTrashRoute(ctx) ? null : h('button', {
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
  return { starBtn, moreBtn };
}

/**
 * The card element and everything a card shares: identity attributes, the
 * single-click / keyboard / context-menu / drag behaviours, and the folder
 * drop target. `children` are appended in order.
 */
function gridCard(ctx, node, selected, extraClass, moreBtn, children) {
  const card = h('div', {
    class: 'gcard' + (extraClass ? ' ' + extraClass : ''),
    dataset: { id: node.id, selected: selected ? 'true' : 'false', kind: node.kind || 'file' },
    attrs: { role: 'listitem', tabindex: '0', draggable: 'true', 'aria-selected': selected ? 'true' : 'false', 'aria-label': node.name },
    on: {
      click: (event) => ctx.onRowClick(node, event),
      keydown: (event) => ctx.onRowKey(event, node),
      contextmenu: (event) => { event.preventDefault(); ctx.onSelectOnly(node, event); openRowMenu(ctx, node, moreBtn); },
      dragstart: (event) => { if (ctx.onRowDragStart) ctx.onRowDragStart(node, event); },
      dragend: (event) => { if (ctx.onRowDragEnd) ctx.onRowDragEnd(node, event); },
      ...dropTargetHandlers(ctx, node),
    },
  });
  for (const child of children) if (child) card.appendChild(child);
  return card;
}

/** A picture/file card: thumbnail on top, the same caption it always had. */
function renderFileCard(ctx, node, selected) {
  const trash = isTrashRoute(ctx);
  const kind = fileKind(node.mime, node.name);
  const thumb = h('div', { class: 'thumb' });
  // Trashed files are not served by the thumbnail routes, so the icon stays.
  const gridSource = trash ? null : thumbnailSourceFor(node);
  if (kind === 'image') {
    thumb.appendChild(raw(icon('file-image', 26)));
    // A format no route can decode has no thumbnail to ask for; the icon IS
    // the answer, and asking would only produce a failed request per row.
    if (gridSource) {
      thumbnailLoader.watch(thumb, () => thumbFor(node, THUMBNAIL_WIDTH, gridSource).then((url) => {
        if (!thumb.isConnected) return;
        const img = h('img', { attrs: { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', src: url } });
        thumb.replaceChildren(img);
      }).catch(() => { /* keep the icon placeholder */ }));
    }
  } else {
    thumb.innerHTML = icon(kindIcon(kind, node.name), 26);
  }

  const { starBtn, moreBtn } = cardActions(ctx, node);
  return gridCard(ctx, node, selected, '', moreBtn, [
    selectionBox(ctx, node, selected, 'card-pick'),
    thumb,
    gnameWithLocation(ctx, node),
    trash
      ? trashMetaEl(node, 'gmeta trash-meta', { typography: false })
      : h('div', { class: 'gmeta', text: bytes(node.size) + ' · ' + relativeTime(node.updatedAt) }),
    h('div', { class: 'gactions' }, starBtn, moreBtn),
  ]);
}

/**
 * A directory card: a warm icon block beside a two-line name and its counts.
 *
 * It has no thumbnail, so it must not borrow the picture card's 88px media
 * box — that empty box and the blank line under it were why a folder looked
 * like a broken photo.
 */
function renderFolderCard(ctx, node, selected) {
  const trash = isTrashRoute(ctx);
  const { starBtn, moreBtn } = cardActions(ctx, node);
  return gridCard(ctx, node, selected, 'is-folder', moreBtn, [
    selectionBox(ctx, node, selected, 'card-pick'),
    h('div', { class: 'gfolder-icon', html: icon('folder', 20) }),
    h('div', { class: 'gfolder-body' },
      gnameWithLocation(ctx, node),
      trash
        ? trashMetaEl(node, 'gmeta trash-meta', { typography: false })
        : h('div', { class: 'gmeta', text: folderMetaText(node) }),
    ),
    h('div', { class: 'gactions' }, starBtn, moreBtn),
  ]);
}

/**
 * Grid view. Folders and files get one grid each: a photo card is 88px tall
 * before its caption, and a folder sharing a row with one was stretched to
 * that height with an empty thumbnail-shaped hole above its name. Source order
 * is kept inside each grid; a folder-only view is a single grid (there is
 * nothing to separate, and it gets no extra heading).
 */
function renderGrid(ctx, nodes) {
  const folders = [];
  const files = [];
  for (const node of nodes) (node.kind === 'folder' ? folders : files).push(node);

  const grids = [];
  if (folders.length) {
    grids.push(gridElement('grid grid-folders', folders, (node) => renderFolderCard(ctx, node, ctx.state.selection.has(node.id))));
  }
  if (files.length) {
    grids.push(gridElement('grid grid-files', files, (node) => renderFileCard(ctx, node, ctx.state.selection.has(node.id))));
  }
  return grids;
}

function gridElement(className, nodes, renderCard) {
  const grid = h('div', { class: className, attrs: { role: 'list' } });
  for (const node of nodes) grid.appendChild(renderCard(node));
  return grid;
}

/**
 * What the trash will actually do with a deleted file, in one sentence.
 *
 * The retention window is a deployment setting (0 = never auto-purge), so a
 * hard-coded "30 天" is a promise the server may not keep. The distinction that
 * has to survive is 0 vs "unknown": `0` means the sweep is off and says so, a
 * missing `stats.trash` means the client has not loaded it yet and falls back
 * to the wording that is true in both cases.
 */
export function trashRetentionClause(stats) {
  const trash = stats && stats.trash ? stats.trash : null;
  const days = trash ? trash.retentionDays : undefined;
  if (days === 0) return '本部署未开启自动清理。';
  if (typeof days === 'number' && Number.isFinite(days) && days > 0) return days + ' 天内可以还原。';
  return '可随时还原。';
}

/** The whole sentence, for the empty trash view. */
export function trashRetentionNote(stats) {
  return '删除的文件会先进入回收站，' + trashRetentionClause(stats);
}

/**
 * The empty list, which is two different answers in the trash.
 *
 * "回收站是空的" must only appear when the bin really holds nothing. A filtered
 * no-match is the filter's answer: it names what was searched for, offers a way
 * back to the unfiltered bin, and never borrows the retention sentence (which
 * would read as "there is nothing to restore").
 */
function emptyFolder(ctx) {
  const route = ctx.state.route;
  const isTrash = route.name === 'trash';
  const isStarred = route.name === 'starred';
  if (isTrash && isTrashFilterActive(route)) {
    return h('div', { class: 'empty' },
      raw(icon('search', 30)),
      h('b', { text: '没有匹配的回收站项目' }),
      h('p', { text: trashFilterEmptyText(route) }),
      h('button', {
        class: 'btn',
        attrs: { type: 'button', title: '清除回收站筛选' },
        // Named for what it does to the list, not just "清除筛选": the form
        // above already has a button with that label, and two identical names
        // a few pixels apart are ambiguous to a screen reader.
        text: '清除筛选并显示全部',
        on: {
          click: () => {
            if (typeof ctx.navigate === 'function') ctx.navigate('/trash');
          },
        },
      }),
    );
  }
  return h('div', { class: 'empty' },
    raw(icon(isTrash ? 'trash' : isStarred ? 'star' : 'folder', 30)),
    h('b', { text: isTrash ? '回收站是空的' : isStarred ? '还没有星标文件' : '这个文件夹还是空的' }),
    h('p', {
      text: isTrash
        ? trashRetentionNote(ctx.state.stats)
        : isStarred
          ? '在文件行左侧点击星标，常用文件会出现在这里。'
          : '把文件拖到这里，或使用上方的上传按钮。',
    }),
  );
}

/** Row context menu — shared by the ⋯ button and right click. */
function openRowMenu(ctx, node, anchor) {
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
    // The label states the consequence: this entry creates a public download
    // link when none exists, it does not merely copy something.
    items.push(!isFolder
      ? { label: '创建并复制链接', icon: 'link', onSelect: () => ctx.onCopyLink(node) }
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
  const draggable = rowEl.getAttribute('draggable');
  rowEl.setAttribute('draggable', 'false');
  nameEl.replaceWith(input);
  input.focus();
  const ext = initialName.lastIndexOf('.');
  if (ext > 0) input.setSelectionRange(0, ext);
  else input.select();
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    if (draggable === null) rowEl.removeAttribute('draggable');
    else rowEl.setAttribute('draggable', draggable);
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
  input.addEventListener('dragstart', (event) => event.stopPropagation());
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