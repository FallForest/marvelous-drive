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
import { api, request, requestArchive, clearToken, archiveDownloadUrl } from './api.js';
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
import { downloadCenter } from './downloads.js';

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
 *
 * `gallery` is a function, not a snapshot, because a directory is paged: the
 * rows the drawer can walk grow when the folder's next page arrives, and the
 * answer to "is there another picture?" is only true while this route is still
 * the one on screen. The function is re-read by the drawer after every appended
 * page, and returns null once the route behind it has moved — a drawer left open
 * across a navigation must not pull page two of the folder the user just left.
 */
export function openPreviewFor(node) {
  // The route the drawer belongs to, captured once: a later navigation must be
  // detectable even though the store is one shared object. Paging is only ever
  // allowed into the folder/query the drawer was opened on — a drawer left open
  // across a navigation must not pull page two of the directory the user left.
  const route = store.state.route;
  openPreview(node, {
    gallery: () => {
      if (store.state.route !== route) return null;
      // `searchMore` and `nodeMore` are per-load cursors: app.js replaces them
      // on every loadRoute(), so the offset/hasMore read here is always the one
      // the list on screen belongs to.
      const more = route.name === 'search' ? store.state.searchMore : store.state.nodeMore;
      const hasMore = Boolean(more && more.hasMore);
      return {
        nodes: visibleNodes(),
        hasMore,
        // How many rows the view has already read: the drawer compares it
        // across a request to tell an arrived page from one still in flight.
        offset: Number(more && more.offset) || 0,
        // Only the verbs the shell already owns: no request is built here and
        // no page is fetched until the viewer actually runs out of pictures.
        loadMore: hasMore
          ? () => (route.name === 'search' ? runtime.loadMoreSearch() : runtime.loadMoreNodes())
          : null,
      };
    },
    onDownload: (target) => downloadOne(target),
    onShare: (target) => openShareDialog(target),
    onDetails: (target) => showDetails(target),
    // A restore changes the row's version, so the list has to re-read.
    onChanged: () => runtime.refreshData(),
  });
}

/**
 * Downloads one node through the page's download center.
 *
 * The promise still means "the bytes reached the browser and the save was
 * handed over", because the archive flows delete their carrier only after that.
 * Every task, including a failed one, stays in the download panel, so a failure
 * is never just a toast that scrolls away: it carries a retry there.
 */
export function downloadOne(node, options) {
  const opts = options || {};
  if (!node || node.kind !== 'file') return Promise.resolve(null);
  const handle = downloadCenter().start({
    node,
    name: node.name,
    kind: 'file',
    // A ZIP carrier already exists before downloadOne() sees it, so no prepare.
  });
  const run = handle.done.then((result) => {
    if (result.state !== 'done') {
      if (!opts.quiet) {
        // A cancel is something the user did, not something that went wrong:
        // "下载失败" over a deliberate stop is the wrong word, and the toast has
        // to say where the retry is. A real failure keeps the error tone and its
        // own reason.
        if (result.state === 'canceled') {
          toast('已取消下载 ' + node.name + '。', { type: 'info', detail: '仍保留在下载面板中，可以重试。' });
        } else {
          toast(result.message || '下载失败。', { type: 'error' });
        }
      }
      const error = result.error || new Error(result.message || '下载已取消。');
      if (result.state === 'canceled' && !error.name) error.name = 'AbortError';
      throw error;
    }
    if (!opts.quiet) toast('已开始下载 ' + node.name, { type: 'success', timeout: 2000 });
    return result;
  });
  // The fire-and-forget call sites (a row menu, the preview drawer) already see
  // the failure in a toast and in the panel; this only stops the browser from
  // logging an unhandled rejection for it.
  run.catch(() => {});
  return run;
}

/** Resolves a packaging response to its carrier node, or throws. */
function archiveCarrier(payload) {
  const archive = payload && payload.node;
  if (!archive) throw new Error('服务器没有返回压缩包。');
  return archive;
}

/** A carrier built by the archive-download registry instead of a real node. */
function isTemporaryArchive(archive) {
  return Boolean(archive) && archive.temporary === true;
}

/**
 * Drops a carrier archive, best effort.
 *
 * Only ever called after the download resolved: the carrier is the only handle
 * on those bytes, so removing it any earlier (the old `finally`) turned one
 * failed download into a lost archive. The download panel keeps the carrier
 * too: a failed or canceled transfer can be retried without zipping the folder
 * again.
 *
 * The two kinds are dropped differently. A temporary one is a registry row, so
 * it is released through its own route and needs no list refresh: no node was
 * ever created, and refreshing for one would repaint the whole tree for nothing.
 * A legacy one is a real node, so it is deleted exactly as before and the list
 * refreshes once that delete completed — if it failed, the node is still there
 * and the rows on screen are still correct.
 */
function releaseArchive(archive) {
  if (!archive) return;
  if (isTemporaryArchive(archive)) {
    request(archiveDownloadUrl(archive.id), { method: 'DELETE' })
      .catch(() => {});
    return;
  }
  request('/nodes/' + archive.id, { method: 'DELETE' })
    .then(() => runtime.refreshData())
    .catch(() => {});
}

/**
 * Report a ZIP task that did not deliver.
 *
 * The carrier is deliberately not released: it is still the only copy of the
 * bytes, and the panel's retry reuses it. The sentence names where the retry
 * is, because "打包完成，但下载没有开始" without it reads as "your archive is
 * gone".
 *
 * A temporary carrier is never in the list — it is not a node — so its copy
 * points at the download panel only, and no list refresh is needed. A legacy
 * carrier is a row the user can see, so it keeps saying "列表" and repaints.
 */
function reportArchiveFailure(archive, result) {
  const reason = (result && result.message) || '下载失败。';
  const temporary = isTemporaryArchive(archive);
  if (result && result.state === 'canceled') {
    toast('已取消下载压缩包。', {
      type: 'info',
      detail: temporary
        ? '压缩包「' + archive.name + '」保留在下载面板中，可以再点一次下载。'
        : '压缩包「' + archive.name + '」保留在列表和下载面板中，可以再点一次下载。',
    });
  } else {
    toast('打包完成，但下载没有开始。', {
      type: 'error',
      detail: temporary
        ? '压缩包「' + archive.name + '」保留在下载面板中，可以重试：' + reason
        : '压缩包「' + archive.name + '」保留在列表中，可以在下载面板重试：' + reason,
    });
  }
  if (!temporary) runtime.refreshData();
}

/** Zips whatever is selected and downloads it, then drops the carrier node. */
export async function downloadSelectionArchive() {
  const selected = Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (!selected.length) return;
  const handle = downloadCenter().start({
    name: selected.length > 1 ? selected.length + ' 个项目的压缩包' : (selected[0].name || '压缩包') + '.zip',
    kind: 'archive',
    prepare: async ({ signal, onProgress }) => {
      // The build can be followed over SSE on the same route; a server that
      // answers in one JSON body is understood by requestArchive() itself.
      const payload = await requestArchive('/nodes/archive', {
        body: { ids: selected.map((node) => node.id) },
        signal,
        onProgress,
      });
      return archiveCarrier(payload);
    },
    // The carrier may only be dropped once the browser really got the blob; the
    // panel fires this on a successful execution, including a successful retry.
    onDelivered: releaseArchive,
  });
  const result = await handle.done;
  const archive = result.carrier;
  if (!archive) {
    // Packaging failed: nothing was created, so the panel's retry runs it again.
    if (result.state !== 'canceled') toast(result.message || '打包失败。', { type: 'error' });
    return;
  }
  if (result.state !== 'done') { reportArchiveFailure(archive, result); return; }
  toast('已打包 ' + selected.length + ' 项并开始下载。', { type: 'success' });
}

/** Zips one folder and downloads the archive, then deletes the carrier node. */
export async function downloadFolderArchive(node) {
  if (!node || node.kind !== 'folder') return;
  const handle = downloadCenter().start({
    name: (node.name || '文件夹') + '.zip',
    kind: 'archive',
    prepare: async ({ signal, onProgress }) => {
      // A folder build can be the long one: the same negotiated stream reports
      // its progress and lets a cancel stop it before the carrier is named.
      const payload = await requestArchive('/nodes/' + node.id + '/archive', {
        body: {},
        signal,
        onProgress,
      });
      return archiveCarrier(payload);
    },
    // Same contract as the selection archive: release only after the save landed.
    onDelivered: releaseArchive,
  });
  const result = await handle.done;
  const archive = result.carrier;
  if (!archive) {
    if (result.state !== 'canceled') toast(result.message || '打包失败。', { type: 'error' });
    return;
  }
  if (result.state !== 'done') { reportArchiveFailure(archive, result); return; }
  toast('已生成「' + archive.name + '」并开始下载。', { type: 'success' });
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
async function deleteBatch(list, remove, coveredIds) {
  const failedNodes = [];
  const errors = [];
  for (const node of list) {
    try {
      await remove(node);
      // Only successes leave the selection; the retry set is exactly its complement.
      // A collapsed root also covers its selected descendants, which the one
      // request already acted on.
      for (const id of coveredIds ? coveredIds(node) : [node.id]) store.state.selection.delete(id);
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

/** The ids in a trashed row's originalPath, or null when the page gave none. */
function originalPathIds(node) {
  if (!Array.isArray(node && node.originalPath)) return null;
  return node.originalPath
    .map((segment) => (typeof segment === 'string' ? segment : segment && segment.id))
    .filter(Boolean);
}

/**
 * Root-to-parent ids via parentId, reading each link from the selection first
 * and the loaded tree second.
 *
 * The fallback for rows whose originalPath the page could not resolve (a
 * missing segment is null, never a partial chain): the trash page still knows
 * the parent id, and a selected parent does not need to be on the same page.
 */
function ancestorIds(node, selectedById, index) {
  const ids = [];
  const visited = new Set([node.id]);
  const byId = (index && index.byId) || session.index.byId;
  let current = node.parentId || null;
  while (current && !visited.has(current) && ids.length < 256) {
    visited.add(current);
    ids.unshift(current);
    const parent = selectedById.get(current) || byId.get(current);
    current = (parent && parent.parentId) || null;
  }
  return ids;
}

/** The trash row's delete-operation group, or null on a server without it. */
function trashGroupOf(node) {
  const value = node && node.trashGroup;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Root-to-parent ids for one selected trashed row.
 *
 * `originalPath` is the primary answer because the parent may be on another
 * page and therefore absent from the loaded index. Rows the page could not
 * resolve keep the parentId fallback the purge planner already uses.
 */
function trashAncestors(node, selectedById, index) {
  const path = originalPathIds(node);
  if (path !== null) return path;
  return ancestorIds(node, selectedById, index);
}

/** The selected ancestor nearest to `node` on its trash path, or null. */
function nearestSelectedAncestor(chain, selectedById) {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const ancestor = selectedById.get(chain[index]);
    if (ancestor) return ancestor;
  }
  return null;
}

/**
 * The selected nodes to request, with every selected descendant folded into the
 * selected ancestor that already covers it.
 *
 * A trashed parent and its trashed child are one subtree: purging the parent
 * already acts on the child, so requesting both would make the child answer
 * "not in the trash" after its parent succeeded. `originalPath` is what makes
 * that visible in a paged trash view where the parent may be on another page;
 * rows without it fall back to the existing moveRoots/index rule.
 *
 * Restore does NOT use this collapse — see planRestore, where a separately
 * deleted child must keep its own request. Delete and permanent delete keep it.
 *
 * Returns the roots plus, per root, the selected ids it covers (including
 * itself). A failed root therefore keeps exactly the rows it would retry.
 */
function topmostSelection(nodes) {
  const list = [];
  const selectedById = new Map();
  for (const node of nodes || []) {
    if (!node || !node.id || selectedById.has(node.id)) continue;
    selectedById.set(node.id, node);
    list.push(node);
  }
  if (!list.length) return { nodes: [], coverage: new Map() };

  const candidates = list.filter((node) => {
    const path = originalPathIds(node);
    if (!path) return true;
    return !path.some((id) => selectedById.has(id));
  });
  const rootIds = new Set(moveRoots(candidates.map((node) => node.id), session.index));
  const roots = candidates.filter((node) => rootIds.has(node.id));
  const coverage = new Map(roots.map((node) => [node.id, new Set([node.id])]));
  for (const node of list) {
    if (coverage.has(node.id)) continue;
    // Nearest ancestor first: with roots already collapsed there is at most one
    // selected root above this row, and it is the closest one.
    const path = originalPathIds(node);
    if (coverByAncestors(path, coverage, node)) continue;
    coverByAncestors(ancestorIds(node, selectedById, session.index), coverage, node);
  }
  return { nodes: roots, coverage };
}

/** Adds `node` to the coverage of the nearest planned (or selected) id. */
function coverByAncestors(ancestors, coverage, node) {
  const covered = nearestAncestorCoverage(ancestors, coverage);
  if (!covered) return false;
  covered.add(node.id);
  return true;
}

/**
 * The coverage set of the nearest ancestor that is planned or already covered.
 *
 * `coverage` carries the request roots and, after the single pass that folds
 * rows in, the selected descendants each root covers. Nearby entries therefore
 * let a grandchild join its parent's request instead of becoming another one.
 */
function nearestAncestorCoverage(ancestors, coverage) {
  let nearest = null;
  let at = -1;
  for (let index = (ancestors || []).length - 1; index >= 0; index -= 1) {
    const covered = coverage.get(ancestors[index]);
    if (covered && index > at) { nearest = covered; at = index; }
  }
  return nearest;
}

/**
 * The requests one restore batch should send, parent-first.
 *
 * A restore differs from a purge: the server restores a trashed node plus the
 * descendants it trashed in the *same* operation (same `trashGroup`). A child
 * that was deleted on its own therefore sits under a trashed folder with a
 * different group, and the folder's restore will not bring it back. Requesting
 * it is required — collapsing it into the folder is the bug this planner exists
 * to prevent.
 *
 * The rules, in order:
 *  - a row joins a selected ancestor's request when its nearest selected
 *    ancestor is proven to share its group (same non-empty `trashGroup`);
 *  - a row stays its own request when that ancestor's group is unknown or
 *    different — a boundary cannot be collapsed across, even if some higher
 *    row is from the same group again;
 *  - a batch where no row carries a group at all (an old server) keeps the
 *    previous topmostSelection collapse unchanged.
 *
 * Returns the requests plus, per request, the selected ids it covers (itself
 * included), and the same coverage entries for selected rows that were folded
 * into a request — that is what keeps a failure retrying exactly its own rows.
 */
function planRestore(nodes, index) {
  const list = [];
  const selectedById = new Map();
  for (const node of nodes || []) {
    if (!node || !node.id || selectedById.has(node.id)) continue;
    selectedById.set(node.id, node);
    list.push(node);
  }
  if (!list.length) return { nodes: [], coverage: new Map() };

  // A server that sends no groups at all is the old one: nothing can be proven
  // about which restore covered which child, so the previous collapse stays
  // exactly as it was instead of inventing one request per selected child.
  if (!list.some((node) => trashGroupOf(node))) return topmostSelection(list);

  // The nearest selected ancestor is the only comparison that matters: the
  // server collapses a restore along the same group, and "a different group
  // above, the same group again higher up" must not cross that known boundary.
  const chains = new Map();
  const parents = new Map();
  for (const node of list) {
    const chain = trashAncestors(node, selectedById, index);
    chains.set(node.id, chain);
    const parent = nearestSelectedAncestor(chain, selectedById);
    if (parent) parents.set(node.id, parent);
  }
  const sameGroup = (child, ancestor) => {
    const group = trashGroupOf(child);
    return group !== null && group === trashGroupOf(ancestor);
  };

  const requestOf = new Map();
  const resolving = new Set();
  const requestFor = (node) => {
    if (requestOf.has(node.id)) return requestOf.get(node.id);
    if (resolving.has(node.id)) { requestOf.set(node.id, node); return node; }
    resolving.add(node.id);
    const parent = parents.get(node.id);
    // A row folds into the request its nearest selected ancestor speaks
    // through, and only when both provably share one deletion group. Comparing
    // against the resolved request (not the immediate parent) is what keeps a
    // selected grandchild from splitting off when its parent already folded.
    const request = parent && sameGroup(node, parent) ? requestFor(parent) : node;
    resolving.delete(node.id);
    requestOf.set(node.id, request);
    return request;
  };

  const requested = [];
  const coverage = new Map();
  for (const node of list) {
    if (requestFor(node) !== node) continue;
    requested.push(node);
    coverage.set(node.id, new Set([node.id]));
  }
  // Every folded row joins the coverage of the request it speaks through. The
  // resolver above already proved that request is itself a request.
  for (const node of list) {
    if (coverage.has(node.id)) continue;
    const request = requestFor(node);
    const bucket = coverage.get(request.id);
    if (bucket) bucket.add(node.id);
  }

  // Parent-first, stable within a depth: the original selection order breaks
  // ties, so no comparator has to re-walk a path and the sort is N log N.
  const ordered = requested
    .map((node, order) => ({ node, order, depth: chains.get(node.id).length }))
    .sort((left, right) => (left.depth - right.depth) || (left.order - right.order))
    .map((entry) => entry.node);
  return { nodes: ordered, coverage };
}

/** The server's actual name, which changes when a restore had to rename. */
function restoredName(payload, fallback) {
  return payload && payload.node && payload.node.name ? payload.node.name : fallback;
}

/** How many selected rows one request speaks for: the root plus its covered group. */
function coveredCount(coverage, node) {
  return coverage.get(node.id)?.size ?? 1;
}

/**
 * The restore plan, exported for the focused regression.
 *
 * Purge and permanent delete must keep collapsing every selected descendant
 * into its selected ancestor: `topmostSelection` stays exactly as it was. Only
 * restore needs to respect the server's deletion groups.
 */
export function planRestoreRequests(nodes, index) {
  return planRestore(nodes, index || session.index);
}

export async function deleteSelection(nodes) {
  const list = nodes && nodes.length ? nodes : Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (!list.length) return;
  if (store.state.route.name === 'trash') {
    // A trashed folder and its trashed contents are one request. Collapsing the
    // selection first is what keeps a child from being reported as a failure
    // after the parent's purge already removed it.
    const { nodes: roots, coverage } = topmostSelection(list);
    if (!roots.length) return;
    const folders = roots.filter((node) => node.kind === 'folder');
    // The title counts what the user picked, not the number of requests: one
    // request for a folder speaks for every selected row inside it.
    const totalSelected = roots.reduce((total, node) => total + coveredCount(coverage, node), 0);
    const yes = await confirmDialog({
      title: '永久删除 ' + totalSelected + ' 项',
      description: '回收站中的内容会被永久删除，无法恢复。'
        + (folders.length ? '所选文件夹中的内容会一并永久删除。' : ''),
      confirmLabel: '永久删除',
      danger: true,
    });
    if (!yes) return;
    const { failedNodes, errors } = await deleteBatch(
      roots,
      (node) => purgeNode(node),
      (node) => coverage.get(node.id) || [node.id],
    );
    const failedIds = new Set(failedNodes.map((node) => node.id));
    const done = roots.filter((node) => !failedIds.has(node.id))
      .reduce((total, node) => total + coveredCount(coverage, node), 0);
    const failedCount = roots.filter((node) => failedIds.has(node.id))
      .reduce((total, node) => total + coveredCount(coverage, node), 0);
    if (!failedNodes.length) {
      toast('已永久删除 ' + done + ' 项。', {
        type: 'success',
        detail: folders.length ? '所选文件夹中的内容已一并删除。' : undefined,
      });
    } else {
      toast((done ? '已永久删除 ' + done + ' 项，' + failedCount + ' 项失败' : '永久删除失败 ' + failedCount + ' 项') + '。可再次按 Delete 重试。', {
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
 * Each file is its own task in the same download panel, so the batch is visible
 * while it runs and every failure has a retry that does not repeat the files
 * that already went through. The summary at the end counts what actually
 * started: "已开始下载 N 个文件" even when half of them failed was the
 * misleading part, and a per-file toast alone scrolls away before the batch is
 * over.
 */
export async function downloadSelection(nodes) {
  const files = (nodes || []).filter((node) => node.kind === 'file');
  if (!files.length) { toast('选择的项目中没有可下载的文件。', { type: 'warning' }); return; }
  const failures = [];
  let started = 0;
  let first = true;
  for (const node of files) {
    const handle = downloadCenter().start({ node, name: node.name, kind: 'file', reveal: first });
    first = false;
    const result = await handle.done;
    // A canceled file is not a failure of the batch: the panel still offers it.
    if (result.state === 'done') started += 1;
    else if (result.state === 'failed') failures.push({ name: node.name, reason: result.message || '下载失败' });
    if (result.state === 'done' || result.state === 'canceled') {
      await new Promise((resolve) => setTimeout(resolve, 260));
    }
  }
  const total = files.length;
  if (!failures.length) {
    const canceled = total - started;
    if (!started) { toast('已取消下载。', { type: 'info' }); return; }
    toast(canceled ? '已下载 ' + started + ' 个，' + canceled + ' 个已取消。' : '已开始下载 ' + total + ' 个文件。', {
      type: canceled ? 'warning' : 'success',
      detail: canceled ? '已取消的文件仍在下载面板中，可以重试。' : '',
    });
    return;
  }
  const details = failures.slice(0, 3).map((entry) => entry.name + '：' + entry.reason).join('；');
  if (!started) {
    toast('没有文件下载成功。', { type: 'error', detail: details + '。可在下载面板重试。' });
    return;
  }
  toast('已下载 ' + started + ' 个，' + failures.length + ' 个失败。', {
    type: 'warning',
    detail: details + '。可在下载面板重试。',
  });
}

/*
 * True while one restore batch is running.
 *
 * The bar disables its button for the duration, but the row menu, the keyboard
 * and a second press can still reach this function. Two serial loops over the
 * same roots would race the trash boundary — the second pass would ask for rows
 * the first one already restored and report failures that are not failures.
 * Module-level because the guard has to outlive any one selection bar: the
 * refresh at the end of a batch remounts that bar.
 */
let restorePending = false;

/**
 * Restores a batch from the trash.
 *
 * A restore is recoverable (undoing it is one delete), so unlike purge it asks
 * nothing: the whole point of the bar in the trash is "put these back". The
 * requests are serial because a parent restore already brings its subtree back,
 * and two parallel requests on one branch would race — the child could answer
 * "restore the parent first" while the parent is being restored, or arrive
 * second and answer "not in the trash".
 *
 * The selected subtree is collapsed first: only the topmost selected rows are
 * requested, and a root's success clears itself plus the selected descendants
 * it covered. That collapse is restore-specific (see planRestore): a child
 * deleted in a separate operation keeps its own request even when its trashed
 * parent is selected, because the server's restore only follows the same
 * deletion group. A failed root leaves that same group selected, so pressing
 * 还原 again retries exactly what is still broken. One refresh at the end, after
 * paintSelection(), keeps the toasts off a list that is about to be reloaded.
 *
 * `onProgress(done, total)` is optional: it is told 0 once the batch is
 * accepted, then once per attempted root — failures included — so a caller can
 * say "还原中 1/2" instead of leaving a long serial batch looking stuck.
 */
export async function restoreSelection(nodes, onProgress) {
  const list = nodes && nodes.length ? nodes : Array.from(store.state.selection).map(lookupNode).filter(Boolean);
  if (!list.length) return;
  const { nodes: roots, coverage } = planRestore(list, session.index);
  if (!roots.length) return;
  // Checked after the roots are known: an empty call is not a duplicate batch
  // and must not swallow the progress report of the real one.
  if (restorePending) return;
  restorePending = true;

  const report = typeof onProgress === 'function' ? onProgress : null;
  const total = roots.length;
  // "0/2" is the accepted state: the press did something, the batch is running.
  if (report) report(0, total);

  const errors = [];
  const restored = [];
  const failedIds = new Set();
  try {
    let done = 0;
    for (const node of roots) {
      try {
        const payload = await restoreNode(node);
        // A restore that collided with a live name comes back renamed; say the
        // name the user will actually see in the list, not the stale one.
        const name = restoredName(payload, node.name);
        restored.push({ node, name, renamed: name !== node.name });
        for (const id of coverage.get(node.id) || [node.id]) store.state.selection.delete(id);
      } catch (error) {
        failedIds.add(node.id);
        errors.push(node.name + '：' + ((error && error.message) || '还原失败'));
      }
      // After every attempt, failed or not: the next root is a step forward, and
      // the caller's only way to know a slow batch is still moving.
      done += 1;
      if (report) report(done, total);
    }
    // Whatever failed is still selected for the next press; a successful root has
    // already cleared itself and the descendants it covered.
    runtime.paintSelection();

    // Count selected rows, not requests: restoring a folder also restores the
    // children that were picked with it.
    const count = roots.filter((node) => !failedIds.has(node.id))
      .reduce((total, node) => total + coveredCount(coverage, node), 0);
    const failedCount = roots.filter((node) => failedIds.has(node.id))
      .reduce((total, node) => total + coveredCount(coverage, node), 0);
    const renamed = restored.filter((entry) => entry.renamed);
    const renamedDetail = renamed.slice(0, 3).map((entry) => entry.node.name + ' → ' + entry.name).join('；');
    if (!errors.length) {
      toast(count === 1 ? '已还原：' + restored[0].name : '已还原 ' + count + ' 项。', {
        type: 'success',
        detail: renamedDetail ? '原位置已有同名项目，已重命名：' + renamedDetail : undefined,
      });
    } else {
      toast((count ? '已还原 ' + count + ' 项，' + failedCount + ' 项失败' : '还原失败 ' + failedCount + ' 项') + '。可再次按还原重试。', {
        type: 'warning',
        detail: [failureDetail(errors), renamedDetail ? '已重命名：' + renamedDetail : ''].filter(Boolean).join('；'),
      });
    }
    // One refresh for the batch: the restored rows leave the trash, the failed
    // ones are still there and keep the selection painted above.
    await runtime.refreshData();
  } finally {
    // A thrown refresh must not leave the guard latched forever.
    restorePending = false;
  }
}

/** Row-level 还原: one node, the same rules as the batch. */
export function startRestore(node) {
  return restoreSelection([node]);
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
