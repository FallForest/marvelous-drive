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
import { toast, dialog, promptDialog, confirmDialog, copyText, drawer, openMenu } from './ui.js';
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
import { moveRoots, planMoves } from './drag-move.js';
import { openShortcutSettings } from './shortcuts.js';

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
 * Downloads one node and reports whether the bytes started.
 *
 * The promise is the point: the archive flows have to know the download really
 * began before they delete the carrier node, and the old fire-and-forget helper
 * resolved immediately — so "已打包" was printed while nothing had downloaded.
 * A rejection is re-thrown for those callers, and a no-op catch is attached so
 * the fire-and-forget call sites (a row menu, the preview drawer) do not log an
 * unhandled rejection for a failed download they already toasted.
 */
export function downloadOne(node, options) {
  const opts = options || {};
  if (!node || node.kind !== 'file') return Promise.resolve();
  const run = downloadNode(node).then(
    () => {
      if (!opts.quiet) toast('已开始下载 ' + node.name, { type: 'success', timeout: 2000 });
    },
    (error) => {
      if (!opts.quiet) toast((error && error.message) || '下载失败。', { type: 'error' });
      throw error;
    },
  );
  run.catch(() => {});
  return run;
}

/**
 * Deletes a carrier archive node, best effort.
 *
 * Only ever called after the download resolved: the node is the only handle on
 * those bytes, so removing it any earlier (the old `finally`) turned one failed
 * download into a lost archive.
 */
function releaseArchive(archive) {
  if (!archive) return;
  request('/nodes/' + archive.id, { method: 'DELETE' }).catch(() => {});
  runtime.refreshData();
}

/** Zips whatever is selected and downloads it, then drops the carrier node. */
export async function downloadSelectionArchive() {
  const selected = Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (!selected.length) return;
  let archive = null;
  try {
    const payload = await request('/nodes/archive', { method: 'POST', body: { ids: selected.map((node) => node.id) } });
    archive = payload && payload.node;
    if (!archive) throw new Error('服务器没有返回压缩包。');
  } catch (error) {
    toast((error && error.message) || '打包失败。', { type: 'error' });
    return;
  }
  try {
    await downloadOne(archive, { quiet: true });
  } catch (error) {
    toast('打包完成，但下载没有开始。', {
      type: 'error',
      detail: '压缩包「' + archive.name + '」保留在列表中，可以再点一次下载：' + ((error && error.message) || '下载失败。'),
    });
    runtime.refreshData();
    return;
  }
  toast('已打包 ' + selected.length + ' 项并开始下载。', { type: 'success' });
  releaseArchive(archive);
}

/** Zips one folder and downloads the archive, then deletes the carrier node. */
export async function downloadFolderArchive(node) {
  if (!node || node.kind !== 'folder') return;
  let archive = null;
  try {
    const payload = await request('/nodes/' + node.id + '/archive', { method: 'POST', body: {} });
    archive = payload && payload.node;
    if (!archive) throw new Error('服务器没有返回压缩包。');
  } catch (error) {
    toast((error && error.message) || '打包失败。', { type: 'error' });
    return;
  }
  try {
    await downloadOne(archive, { quiet: true });
  } catch (error) {
    toast('打包完成，但下载没有开始。', {
      type: 'error',
      detail: '压缩包「' + archive.name + '」保留在列表中，可以再点一次下载：' + ((error && error.message) || '下载失败。'),
    });
    runtime.refreshData();
    return;
  }
  toast('已生成「' + archive.name + '」并开始下载。', { type: 'success' });
  releaseArchive(archive);
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
  await moveItems(list.map((node) => node.id), target);
}

/** The menu, selection bar and drag gesture share one move operation. */
export async function moveItems(ids, target) {
  if (target === undefined) return;
  const destination = target || null;
  const roots = moveRoots(ids, session.index);
  const plan = planMoves(roots, destination, session.index);
  const allowed = plan.allowed.map(lookupNode).filter(Boolean);
  const stayers = allowed.filter((node) => (node.parentId || null) === destination);
  const movers = allowed.filter((node) => (node.parentId || null) !== destination);
  const reasons = {
    self: '不能把文件夹移动到它自己里面。',
    descendant: '不能把文件夹移动到它自己的子文件夹里。',
    'target-missing': '目标文件夹不存在或已删除。',
    'target-not-folder': '只能移动到文件夹。',
    unknown: '项目不存在或已删除，请刷新后重试。',
  };
  if (plan.blocked.length) {
    toast(reasons[plan.blocked[0].reason], { type: 'warning' });
    return;
  }
  if (!movers.length) {
    toast('这些项目已经在该文件夹中。', { type: 'info' });
    return;
  }
  const moved = new Set();
  let failed = 0;
  let conflicts = 0;
  const errors = [];
  for (const node of movers) {
    try {
      await moveNode(node, destination);
      moved.add(node.id);
    } catch (error) {
      failed += 1;
      if (error && (error.code === 'CONFLICT' || error.status === 409)) conflicts += 1;
      errors.push(node.name + '：' + (error.message || '移动失败'));
    }
  }
  // Keep failed items selected so they can be retried. Moving a selected folder
  // also moves its children, without sending separate requests for them.
  for (const id of Array.from(store.state.selection)) {
    let current = id;
    const visited = new Set();
    while (current && !visited.has(current)) {
      if (moved.has(current)) { store.state.selection.delete(id); break; }
      visited.add(current);
      current = session.index.byId.get(current)?.parentId;
    }
  }
  runtime.paintSelection();
  const folder = destination ? session.index.byId.get(destination) : null;
  const where = folder ? folder.name : '我的云盘';
  const parts = [moved.size ? '已移动 ' + moved.size + ' 项到 ' + where : '没有项目被移动'];
  if (failed) parts.push('失败 ' + failed + ' 项');
  if (conflicts) parts.push('其中 ' + conflicts + ' 项因重名未移动（请先单独重命名）');
  if (stayers.length) parts.push('另有 ' + stayers.length + ' 项已在该文件夹中');
  const details = errors.length ? errors.slice(0, 3).join('；') : undefined;
  toast(parts.join('，') + '。', { type: failed ? 'warning' : 'success', detail: details });
  if (moved.size) {
    if (folder) store.state.expanded.add(folder.id);
    const route = store.state.route;
    const remainingSelection = new Set(store.state.selection);
    await runtime.refreshData();
    if (store.state.route === route) {
      const visible = new Set(visibleNodes().map((node) => node.id));
      store.state.selection = new Set([...remainingSelection].filter((id) => visible.has(id)));
      runtime.paintSelection();
    }
  }
}

export async function startMove(node) {
  return moveSelection([node]);
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

/**
 * Deletes a batch and keeps whatever failed selected.
 *
 * "已删除" followed by an empty selection was the whole bug: the user saw a
 * number, lost the rows that were still there, and had no way to find out which
 * ones refused. A failed item stays picked (so Delete / 移到回收站 can be pressed
 * again) and the toast names up to three of them with the server's reason.
 */
async function deleteBatch(list, remove) {
  const failedNodes = [];
  const errors = [];
  for (const node of list) {
    try {
      await remove(node);
      // Only successes leave the selection; the retry set is exactly its complement.
      store.state.selection.delete(node.id);
    } catch (error) {
      failedNodes.push(node);
      errors.push(node.name + '：' + ((error && error.message) || '删除失败'));
    }
  }
  if (!failedNodes.length) store.state.selection = new Set();
  runtime.paintSelection();
  return { failedNodes, errors };
}

/** Names the failed rows (up to three) so the warning is actionable. */
function failureDetail(errors) {
  return errors.slice(0, 3).join('；');
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
    const { failedNodes, errors } = await deleteBatch(list, (node) => purgeNode(node));
    const done = list.length - failedNodes.length;
    if (!failedNodes.length) {
      toast('已永久删除 ' + done + ' 项。', { type: 'success' });
    } else {
      toast((done ? '已永久删除 ' + done + ' 项，' + failedNodes.length + ' 项失败' : '永久删除失败 ' + failedNodes.length + ' 项') + '。可再次按 Delete 重试。', {
        type: 'warning',
        detail: failureDetail(errors),
      });
    }
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
  const { failedNodes, errors } = await deleteBatch(list, (node) => api.del('/nodes/' + node.id));
  const done = list.length - failedNodes.length;
  if (!failedNodes.length) {
    toast('已移到回收站 ' + done + ' 项。', { type: 'success' });
  } else {
    toast((done ? '已移到回收站 ' + done + ' 项，' + failedNodes.length + ' 项失败' : '删除失败 ' + failedNodes.length + ' 项') + '。可再次按 Delete 重试。', {
      type: 'warning',
      detail: failureDetail(errors),
    });
  }
  await runtime.refreshData();
}

/**
 * Downloads several files one at a time.
 *
 * Browsers throttle a burst of `<a download>` clicks, so the 260 ms gap stays.
 * The summary at the end counts what actually started: "已开始下载 N 个文件" even
 * when half of them failed was the misleading part, and a per-file toast alone
 * scrolls away before the batch is over.
 */
export async function downloadSelection(nodes) {
  const files = (nodes || []).filter((node) => node.kind === 'file');
  if (!files.length) { toast('选择的项目中没有可下载的文件。', { type: 'warning' }); return; }
  const failures = [];
  let started = 0;
  for (const node of files) {
    try {
      const blob = await fetchBlob(contentUrl(node.id, { download: true }));
      saveBlob(blob, node.name);
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 260));
    } catch (error) {
      failures.push({ name: node.name, reason: (error && error.message) || '下载失败' });
    }
  }
  const total = files.length;
  const details = failures.slice(0, 3).map((entry) => entry.name + '：' + entry.reason).join('；');
  if (!failures.length) {
    toast('已开始下载 ' + total + ' 个文件。', { type: 'success' });
    return;
  }
  if (!started) {
    toast('没有文件下载成功。', { type: 'error', detail: details });
    return;
  }
  toast('已下载 ' + started + ' 个，' + failures.length + ' 个失败。', { type: 'warning', detail: details });
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
    // This mutation also changes the sidebar count and can reorder a paged
    // starred view. Invalidate the shared metadata instead of repainting it stale.
    await runtime.refreshData();
  } catch (error) {
    toast((error && error.message) || '操作失败。', { type: 'error' });
  }
}

/** Absolute URL of a share row, whatever shape the server returned. */
export function shareUrlOf(share) {
  if (!share) return '';
  const raw = String(share.url || '');
  if (/^https?:\/\//i.test(raw)) return raw;
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  return origin + (raw || '/s/' + share.token);
}

/**
 * An existing link that can be handed out again as-is.
 *
 * Only a link that is still alive, still a downloader link, not password
 * protected and not past its download budget qualifies: copying any of the
 * others would send someone a URL they cannot open, which is exactly the kind
 * of silent failure this menu entry was fixed to stop producing.
 */
export function reusableShareUrl(shares, now) {
  const at = now === undefined ? Date.now() : Number(now);
  const list = Array.isArray(shares) ? shares : [];
  for (const share of list) {
    if (!share || share.permission !== 'downloader') continue;
    if (share.hasPassword) continue;
    if (share.maxDownloads !== null && share.maxDownloads !== undefined
      && Number(share.downloads || 0) >= Number(share.maxDownloads)) continue;
    if (share.expiresAt) {
      const expires = Date.parse(share.expiresAt);
      if (Number.isFinite(expires) && expires <= at) continue;
    }
    const url = shareUrlOf(share);
    if (url) return url;
  }
  return '';
}

/**
 * The "链接已创建" panel: the URL as selectable readonly text, a copy button and
 * the only way out — revoking it.
 *
 * A toast cannot host a button, and a link that exists on the server with no
 * visible handle is a link nobody can take back. The dialog is that handle.
 */
function shareLinkDialog(url, options) {
  const opts = options || {};
  const input = h('input', {
    class: 'input',
    attrs: { type: 'text', readonly: 'readonly', 'aria-label': '下载链接', spellcheck: 'false' },
    value: url,
  });
  const note = h('p', { class: 'muted', attrs: { 'aria-live': 'polite' }, text: opts.note || '' });
  return dialog({
    title: opts.title || '链接已创建',
    description: '任何拿到这条链接的人都能下载，不需要密码，链接永久有效。',
    body: h('div', { class: 'field' }, h('label', { text: '下载链接' }), input, note),
    // A factory, because dialog() removes an empty footer: buttons appended
    // after it returns would end up in a detached <footer>.
    footer: (dlg) => {
      const copyBtn = h('button', {
        class: 'btn', attrs: { type: 'button' }, text: '复制链接',
        on: {
          click: async () => {
            const ok = await copyText(url);
            note.textContent = ok ? '已经复制到剪贴板。' : '浏览器没有允许自动复制，请在上面的输入框里手动选中复制。';
            if (!ok) { input.focus(); input.select(); }
          },
        },
      });
      const revokeBtn = h('button', {
        class: 'btn btn-danger', attrs: { type: 'button' }, text: '撤销链接',
        on: {
          click: async () => {
            revokeBtn.disabled = true;
            copyBtn.disabled = true;
            try {
              await api.del('/shares/' + opts.share.id);
              toast('链接已撤销。', { type: 'success', timeout: 2400 });
              dlg.close();
            } catch (error) {
              revokeBtn.disabled = false;
              copyBtn.disabled = false;
              note.textContent = (error && error.message) || '撤销失败，请重试。';
            }
          },
        },
      });
      const copyAndSelect = () => { input.focus(); input.select(); };
      requestAnimationFrame(copyAndSelect);
      return [
        copyBtn,
        h('span', { class: 'push' }),
        revokeBtn,
        h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => dlg.close() } }),
      ];
    },
  });
}

/**
 * "创建并复制链接" — create a public download link, and only on demand.
 *
 * It used to POST a permanent, password-less, unlimited downloader share on a
 * plain menu click labelled "复制链接", so a copy that failed still left a fresh
 * public link behind on the server. Now an existing live link is reused without
 * touching the server, a new one is confirmed first, and every created link is
 * shown next to its own 撤销 button.
 */
export async function copyShareLink(node) {
  if (!node) return;
  if (node.kind === 'folder') {
    const ok = await copyText(node.name);
    toast(ok ? '文件夹名已复制。' : '复制失败。', { type: ok ? 'success' : 'error' });
    return;
  }
  let existing = '';
  try {
    const payload = await api.get('/nodes/' + node.id + '/shares');
    existing = reusableShareUrl(payload && payload.shares);
  } catch {
    // Listing is a convenience: a failure must not block creating a link, it
    // only means the duplicate check could not be made.
    existing = '';
  }
  if (existing) {
    const ok = await copyText(existing);
    if (ok) { toast('已有下载链接，已直接复制。', { type: 'success', detail: existing }); return; }
    shareLinkDialog(existing, { title: '已有下载链接', note: '浏览器没有允许自动复制，请在这里手动复制。' });
    return;
  }
  const yes = await confirmDialog({
    title: '创建公开下载链接',
    description: '任何拿到这条链接的人都能下载这个文件，不需要密码，链接永久有效。确认后会立即创建并复制。',
    confirmLabel: '创建并复制',
  });
  if (!yes) return;
  let share = null;
  try {
    const payload = await api.post('/nodes/' + node.id + '/share', { permission: 'downloader' });
    share = payload && payload.share;
    if (!share) throw new Error('未返回分享链接。');
  } catch (error) {
    toast((error && error.message) || '创建链接失败。', { type: 'error' });
    return;
  }
  const url = shareUrlOf(share);
  const ok = await copyText(url);
  if (ok) toast('公开下载链接已创建并复制。', { type: 'success', detail: url, timeout: 6000 });
  // Either way the link now exists, so it gets a visible handle with 撤销.
  shareLinkDialog(url, {
    share,
    title: ok ? '链接已创建' : '链接已创建，复制没有成功',
    note: ok ? '已经复制到剪贴板。撤销后这条链接立即失效。' : '浏览器没有允许自动复制，请在这里手动复制；不想要就点撤销。',
  });
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
      { label: '键盘快捷键', icon: 'key', onSelect: () => openShortcutSettings() },
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
