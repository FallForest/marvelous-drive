/*
 * actions.js — everything a row, a keyboard shortcut or a menu can do.
 *
 * These are the verbs of the client: open, rename, move, delete, restore, purge,
 * star, share, download, archive. They were methods on app.js's closure, which is
 * why they could not be tested or reused. They talk to the server through
 * api.js and then ask the shell to repaint through runtime.js — that seam is what
 * keeps this module from importing app.js.
 */

import { h, raw } from './dom.js';
import { icon, relativeTime } from './format.js';
import { api, request, fetchBlob, contentUrl, downloadNode, saveBlob, clearToken } from './api.js';
import { toast, promptDialog, confirmDialog, copyText, drawer, openMenu } from './ui.js';
import { beginInlineRename, toggleStar, renameNode, moveNode, createFolder, deleteNode, restoreNode, purgeNode } from './files.js';
import { openPreview, showDetails } from './preview.js';
import { openShareDialog } from './share.js';
import { chooseFolder } from './move.js';
import { openWorkspacePanel } from './workspace.js';
import { openDuplicatesDrawer } from './duplicates.js';
import { openUpdatePanel } from './updates.js';
import { store, session } from './session.js';
import { runtime } from './runtime.js';
import { visibleNodes } from './views.js';

/** Resolve a node id against the live tree and the current search page. */
export function lookupNode(id) {
  if (!id) return null;
  if (session.index.byId.has(id)) return session.index.byId.get(id);
  const found = (store.state.searchResults || []).find((node) => node.id === id);
  return found || null;
}

/** Escapes an id for use inside a querySelector attribute match. */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Opens the drawer for `node`.
 *
 * The gallery is everything the current view shows, so → walks the rows the
 * user is looking at — in their sort order, in the current folder — and never
 * jumps into a file that is only reachable through another directory.
 */
export function openPreviewFor(node) {
  openPreview(node, {
    gallery: visibleNodes(),
    onDownload: (target) => downloadOne(target),
    onShare: (target) => openShareDialog(target),
    onDetails: (target) => showDetails(target),
    // A restore changes the row's version, so the list has to re-read.
    onChanged: () => runtime.refreshData(),
  });
}

/**
 * Zips whatever is selected and downloads it.
 *
 * Nothing is left behind: the archive node exists only to carry the bytes, so it
 * is deleted as soon as the download starts.
 */
export async function downloadSelectionArchive() {
  const selected = Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (!selected.length) return;
  let archive = null;
  try {
    const payload = await request('/nodes/archive', { method: 'POST', body: { ids: selected.map((node) => node.id) } });
    archive = payload && payload.node;
    if (!archive) throw new Error('服务器没有返回压缩包。');
    await downloadOne(archive);
    toast('已打包 ' + selected.length + ' 项并开始下载。', { type: 'success' });
  } catch (error) {
    toast((error && error.message) || '打包失败。', { type: 'error' });
  } finally {
    if (archive) {
      request('/nodes/' + archive.id, { method: 'DELETE' }).catch(() => {});
      runtime.refreshData();
    }
  }
}

/** Zips one folder and downloads the archive, then deletes the carrier node. */
export async function downloadFolderArchive(node) {
  if (!node || node.kind !== 'folder') return;
  let archive = null;
  try {
    const payload = await request('/nodes/' + node.id + '/archive', { method: 'POST', body: {} });
    archive = payload && payload.node;
    if (!archive) throw new Error('服务器没有返回压缩包。');
    await downloadOne(archive);
    toast('已生成「' + archive.name + '」并开始下载。', { type: 'success' });
  } catch (error) {
    toast((error && error.message) || '打包失败。', { type: 'error' });
  } finally {
    if (archive) {
      // Best effort: the node existed only to carry the download.
      request('/nodes/' + archive.id, { method: 'DELETE' }).catch(() => {});
      runtime.refreshData();
    }
  }
}

export function downloadOne(node) {
  if (!node || node.kind !== 'file') return;
  downloadNode(node)
    .then(() => toast('已开始下载 ' + node.name, { type: 'success', timeout: 2000 }))
    .catch((error) => toast((error && error.message) || '下载失败。', { type: 'error' }));
}

export function startRename(node) {
  const row = session.shellEls
    ? session.shellEls.viewEl.querySelector('.frow[data-id="' + cssEscape(node.id) + '"]')
    : null;
  if (row) {
    beginInlineRename(row, node.name, (value) => { commitRename(node, value); });
    return;
  }
  promptDialog({ title: '重命名', label: '名称', value: node.name }).then((value) => {
    if (value) commitRename(node, value);
  });
}

async function commitRename(node, value) {
  try {
    await renameNode(node, value);
    toast('已重命名为 ' + value, { type: 'success', timeout: 2000 });
    await runtime.refreshData();
  } catch (error) {
    toast((error && error.message) || '重命名失败。', { type: 'error' });
    runtime.renderShell();
  }
}

/**
 * Moves the current selection into one folder.
 *
 * The requests are serial and share one failure tally on purpose: ten parallel
 * PUTs would queue on SQLite's single writer and turn a small batch into a lock
 * pile-up. A name clash (`409 CONFLICT`) is counted, not retried — the server
 * has no "rename during move" knob, so the only honest advice is "rename first,
 * then move that one item on its own".
 */
export async function moveSelection(nodes) {
  const list = (nodes && nodes.length ? nodes : Array.from(store.state.selection).map(lookupNode).filter(Boolean))
    .filter((node) => node.kind);
  if (!list.length) return;
  const target = await chooseFolder({ index: session.index, nodes: list, title: list.length > 1 ? '移动 ' + list.length + ' 项到…' : '移动到…' });
  // undefined = the dialog was dismissed; null = "my drive" root.
  if (target === undefined) return;
  const destination = target || null;
  const stayers = list.filter((node) => (node.parentId || null) === destination);
  const movers = list.filter((node) => (node.parentId || null) !== destination);
  if (!movers.length) {
    toast('这些项目已经在该文件夹中。', { type: 'info' });
    return;
  }
  let moved = 0;
  let failed = 0;
  let conflicts = 0;
  for (const node of movers) {
    try {
      await moveNode(node, destination);
      moved += 1;
    } catch (error) {
      failed += 1;
      if (error && (error.code === 'CONFLICT' || error.status === 409)) conflicts += 1;
    }
  }
  store.state.selection = new Set();
  runtime.paintSelection();
  const folder = destination ? session.index.byId.get(destination) : null;
  const where = folder ? folder.name : '我的云盘';
  const parts = ['已移动 ' + moved + ' 项到 ' + where];
  if (failed) parts.push('失败 ' + failed + ' 项');
  if (conflicts) parts.push('其中 ' + conflicts + ' 项因重名未移动（请先单独重命名）');
  if (stayers.length) parts.push('另有 ' + stayers.length + ' 项已在该文件夹中');
  toast(parts.join('，') + '。', { type: failed ? 'warning' : 'success' });
  await runtime.refreshData();
}

export async function startMove(node) {
  const target = await chooseFolder({ index: session.index, node, title: '移动到…' });
  if (target === null) return;
  if (target === (node.parentId || null)) { toast('文件已经在该文件夹中。', { type: 'info' }); return; }
  try {
    await moveNode(node, target);
    const folder = target ? session.index.byId.get(target) : null;
    toast('已移动到 ' + (folder ? folder.name : '我的云盘'), { type: 'success', timeout: 2200 });
    await runtime.refreshData();
  } catch (error) {
    toast((error && error.message) || '移动失败。', { type: 'error' });
  }
}

export async function startDelete(node) {
  if (store.state.route.name === 'trash') { startPurge(node); return; }
  try {
    await deleteNode(node);
    store.state.selection.delete(node.id);
    toast('已移到回收站：' + node.name, { type: 'info', timeout: 5000, detail: '可在回收站中还原。' });
    await runtime.refreshData();
  } catch (error) {
    toast((error && error.message) || '删除失败。', { type: 'error' });
  }
}

export async function deleteSelection(nodes) {
  const list = nodes && nodes.length ? nodes : Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (!list.length) return;
  if (store.state.route.name === 'trash') {
    const yes = await confirmDialog({
      title: '永久删除 ' + list.length + ' 项',
      description: '回收站中的内容会被永久删除，无法恢复。',
      confirmLabel: '永久删除',
      danger: true,
    });
    if (!yes) return;
    let failed = 0;
    for (const node of list) {
      try { await purgeNode(node); } catch { failed += 1; }
    }
    store.state.selection = new Set();
    toast(failed ? '部分项目永久删除失败（' + failed + '）' : '已永久删除。', { type: failed ? 'warning' : 'success' });
    await runtime.refreshData();
    return;
  }
  const yes = await confirmDialog({
    title: '删除 ' + list.length + ' 项',
    description: '这些项目会进入回收站，之后仍然可以还原。',
    confirmLabel: '移到回收站',
    danger: true,
  });
  if (!yes) return;
  let failed = 0;
  for (const node of list) {
    try { await api.del('/nodes/' + node.id); } catch { failed += 1; }
  }
  store.state.selection = new Set();
  toast(failed ? '部分项目删除失败（' + failed + '）' : '已移到回收站。', { type: failed ? 'warning' : 'success' });
  await runtime.refreshData();
}

export async function downloadSelection(nodes) {
  const files = (nodes || []).filter((node) => node.kind === 'file');
  if (!files.length) { toast('选择的项目中没有可下载的文件。', { type: 'warning' }); return; }
  for (const node of files) {
    try {
      const blob = await fetchBlob(contentUrl(node.id, { download: true }));
      saveBlob(blob, node.name);
      await new Promise((resolve) => setTimeout(resolve, 260));
    } catch (error) {
      toast((error && error.message) || ('下载 ' + node.name + ' 失败。'), { type: 'error' });
    }
  }
  toast('已开始下载 ' + files.length + ' 个文件。', { type: 'success' });
}

export function startRestore(node) {
  restoreNode(node)
    .then(async () => {
      toast('已还原：' + node.name, { type: 'success' });
      await runtime.refreshData();
    })
    .catch((error) => toast((error && error.message) || '还原失败。', { type: 'error' }));
}

export async function startPurge(node) {
  const yes = await confirmDialog({
    title: '永久删除',
    description: '「' + node.name + '」将被永久删除，无法恢复。',
    confirmLabel: '永久删除',
    danger: true,
  });
  if (!yes) return;
  try {
    await purgeNode(node);
    toast('已永久删除。', { type: 'success' });
    await runtime.refreshData();
  } catch (error) {
    toast((error && error.message) || '永久删除失败。', { type: 'error' });
  }
}

export async function startNewFolder(parentId) {
  const name = await promptDialog({ title: '新建文件夹', label: '文件夹名', value: '新建文件夹', confirmLabel: '创建' });
  if (!name) return;
  try {
    await createFolder(parentId, name);
    toast('已创建文件夹 ' + name, { type: 'success' });
    if (parentId) store.state.expanded.add(parentId);
    await runtime.refreshData();
  } catch (error) {
    toast((error && error.message) || '创建文件夹失败。', { type: 'error' });
  }
}

export async function toggleStarWithToast(node) {
  try {
    const starred = await toggleStar(node);
    toast(starred ? '已加入星标。' : '已取消星标。', { type: 'success', timeout: 1800 });
    if (store.state.route.name === 'starred') { await runtime.refreshData(); return; }
    runtime.paintSelection();
    // The star button state lives in the row; re-render the list only.
    runtime.renderShell();
  } catch (error) {
    toast((error && error.message) || '操作失败。', { type: 'error' });
  }
}

export async function copyShareLink(node) {
  if (node.kind === 'folder') {
    const ok = await copyText(node.name);
    toast(ok ? '文件夹名已复制。' : '复制失败。', { type: ok ? 'success' : 'error' });
    return;
  }
  try {
    const payload = await api.post('/nodes/' + node.id + '/share', { permission: 'downloader' });
    const share = payload && payload.share;
    if (!share) throw new Error('未返回分享链接。');
    const ok = await copyText(window.location.origin + (share.url || '/s/' + share.token));
    toast(ok ? '分享链接已复制。' : '复制失败，请使用分享对话框。', { type: ok ? 'success' : 'error' });
  } catch (error) {
    toast((error && error.message) || '创建链接失败。', { type: 'error' });
  }
}

/**
 * The account's activity log.
 *
 * Read-only on purpose: the log is evidence, so the client never offers a way to
 * edit it. Entries are grouped by day so a long history stays scannable.
 */
async function openActivityLog() {
  const body = h('div', { class: 'activity-list', attrs: { 'aria-live': 'polite' } });
  const handle = drawer({
    title: '操作记录',
    sub: '最近 90 天',
    width: '440px',
    body,
    // drawer() takes an element or an array, not a callback — the dialog()
    // signature is different, which is exactly the kind of slip a type checker
    // would catch and a template string will not.
    footer: [
      h('span', { class: 'push' }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => handle.close() } }),
    ],
  });
  body.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在载入…' })));
  let payload;
  try {
    payload = await request('/audit?limit=100');
  } catch (error) {
    body.replaceChildren(h('div', { class: 'empty' },
      raw(icon('file', 26)),
      h('b', { text: '无法载入操作记录' }),
      h('p', { text: (error && error.message) || '请重试。' }),
    ));
    return handle;
  }
  const entries = (payload && payload.entries) || [];
  if (!entries.length) {
    body.replaceChildren(h('div', { class: 'empty' },
      raw(icon('file', 26)),
      h('b', { text: '还没有操作记录' }),
      h('p', { text: '上传、重命名、删除等操作会记录在这里。' }),
    ));
    return handle;
  }
  const LABEL = {
    upload: '上传', 'instant-upload': '秒传', overwrite: '覆盖', rename: '重命名',
    move: '移动', copy: '复制', trash: '移到回收站', restore: '还原', purge: '永久删除',
    star: '星标', 'share-create': '创建分享', 'share-revoke': '撤销分享',
    'version-restore': '恢复版本', archive: '打包下载',
  };
  // The loading placeholder has to go before the first row, otherwise it stays
  // pinned above the list.
  body.replaceChildren();
  let lastDay = null;
  for (const entry of entries) {
    const day = String(entry.createdAt || '').slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      body.appendChild(h('div', { class: 'activity-day', text: day }));
    }
    body.appendChild(h('div', { class: 'activity-row' },
      h('b', { text: LABEL[entry.action] || entry.action }),
      h('span', { class: 'muted', text: entry.detail || '—' }),
      h('time', { attrs: { datetime: entry.createdAt || '' }, text: relativeTime(entry.createdAt) }),
    ));
  }
  return handle;
}

/** Opens the team panel; a membership change can alter the tree, so refresh. */
function openTeam() {
  openWorkspacePanel({
    currentUserId: store.state.user ? store.state.user.id : null,
    onChanged: () => runtime.refreshData(),
  });
}

/** Opens the duplicate report; the list behind it refreshes after any trash. */
function openDuplicates() {
  return openDuplicatesDrawer({ onChanged: () => runtime.refreshData() });
}

/** Opens the release panel; it fetches the manifest itself when it has none. */
function openUpdates() {
  return openUpdatePanel();
}

export function openUserMenu(anchor) {
  const user = store.state.user || {};
  openMenu({
    anchor,
    items: [
      { heading: user.email || '个人云盘' },
      { label: '刷新', icon: 'refresh', onSelect: () => runtime.refreshData() },
      { label: '团队成员', icon: 'user', onSelect: () => openTeam() },
      { label: '操作记录', icon: 'clock', onSelect: () => openActivityLog() },
      { label: '重复文件', icon: 'copy', onSelect: () => openDuplicates() },
      // The panel reports "this deployment publishes no manifest" itself, which
      // is a truthful answer; hiding the entry would leave that state invisible.
      { label: '软件更新', icon: 'cloud', onSelect: () => openUpdates() },
      { separator: true },
      {
        label: '退出登录', icon: 'log-out', danger: true,
        onSelect: () => {
          clearToken();
          store.state.user = null;
          toast('已退出登录。', { type: 'info' });
          runtime.mountAuth();
        },
      },
    ],
  });
}
