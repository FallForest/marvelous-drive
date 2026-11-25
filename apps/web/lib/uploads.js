/*
 * uploads.js — the client-side upload gestures.
 *
 * The transfer machinery (chunking, resume, dedupe, the 3-slot scheduler) lives
 * in upload.js and upload-queue.js; folder trees in folder-upload.js. What lives
 * here is the glue app.js used to hold: the hidden file input, the
 * "文件 / 文件夹" menu, and the toasts around a batch.
 */

import { h } from './dom.js';
import { request } from './api.js';
import { toast, openMenu, dialog } from './ui.js';
import { bytes } from './format.js';
import { createFolder } from './files.js';
import { pickDirectoryPlan, prepareFolderFiles, uploadPlan } from './folder-upload.js';
import { sha256 } from './upload.js';
import { store, session } from './session.js';
import {
  clearLiveHandle, fileFromHandle, forgetHandle, listHandles, matchSessions, receivedBytes,
  rememberHandle, resumeKey, resumeLabel, setLiveHandle,
} from './upload-resume.js';
import { runtime } from './runtime.js';

/** The lazily created <input type=file>. One per page, kept for the session. */
export function pickFiles(uploader) {
  if (session.filePicker) {
    session.filePicker.click();
    return;
  }
  // The handle picker is preferred when the browser has it: the handle is the
  // only thing that survives a reload, which is what makes an interrupted
  // upload resumable instead of merely reported. Everything about it is
  // optional — a browser without it, or a permission the user declines, falls
  // through to the plain input below.
  if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
    window.showOpenFilePicker({ multiple: true, mode: 'read' }).then(async (handles) => {
      const picked = [];
      for (const handle of handles || []) {
        try {
          const file = await handle.getFile();
          setLiveHandle(file, handle);
          rememberHandle(file, handle);
          picked.push(file);
        } catch { /* a handle that cannot be read is simply skipped */ }
      }
      if (picked.length) uploadFiles(uploader, picked);
    }).catch((error) => {
      if (error && error.name === 'AbortError') return; // the user cancelled
      openPlainPicker(uploader);
    });
    return;
  }
  openPlainPicker(uploader);
}

/** The fallback picker: no handles, so no cross-reload resume for these files. */
function openPlainPicker(uploader) {
  if (!session.filePicker) {
    session.filePicker = h('input', {
      attrs: { type: 'file', multiple: 'multiple', style: 'position:fixed;left:-9999px;opacity:0', 'aria-hidden': 'true', tabindex: '-1' },
      on: { change: () => {
        const files = Array.from(session.filePicker.files || []);
        session.filePicker.value = '';
        if (files.length) uploadFiles(uploader, files);
      } },
    });
    document.body.appendChild(session.filePicker);
  }
  session.filePicker.click();
}

/**
 * The toolbar button opens a menu instead of the file dialog: a drive that can
 * only take loose files is not a drive. Both branches land in the same queue.
 */
export function pickUploadKind(uploader, anchor) {
  openMenu({
    anchor,
    items: [
      { label: '上传文件', icon: 'file', onSelect: () => pickFiles(uploader) },
      {
        label: '上传文件夹',
        icon: 'folder',
        onSelect: async () => {
          const target = currentParentId();
          if (target === undefined) return;
          // The picker is entered as a FACTORY, not as a resolved plan: nothing
          // is queued while the OS dialog is open, and the walk that follows
          // reports its own counts into the same preparation row.
          await uploadFolderPlan(uploader, ({ signal, onProgress }) => pickDirectoryPlan({ signal, onProgress }), target);
        },
      },
    ],
  });
}

/** The folder the upload lands in, or undefined when the route cannot take one. */
export function currentParentId() {
  const route = store.state.route;
  if (route.name !== 'drive') {
    toast('请先回到某个文件夹再上传。', { type: 'warning' });
    return undefined;
  }
  return route.folderId || null;
}

/** The one cancellation shape every stage of a folder walk throws. */
function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error) {
  return !!(error && error.name === 'AbortError');
}

/**
 * Repaints the shell after a walk, swallowing a failure: the caller is already
 * on the error or cancel path and must not be derailed by a refresh.
 */
async function refreshQuietly() {
  try { await runtime.refreshData(); } catch { /* the toast is the report */ }
}

/** "1.2 MB" of hashed bytes, or '' when there is nothing honest to show yet. */
function hashBytesLabel(hashed, total) {
  if (!(Number(total) > 0)) return '';
  return bytes(hashed) + ' / ' + bytes(total);
}

/**
 * Creates the folder skeleton first, then streams every file into it.
 *
 * `planOrFactory` is either a plan (`{ name, dirs, files }`) or a factory
 * `({ signal, onProgress }) => plan|null`. The factory shape exists because the
 * scan can outlive the picker: a directory walk reports `stage: 'scan'` counts
 * as it goes, so the row can name real numbers from the first folder instead of
 * appearing once the whole tree has been read. Nothing is queued while the OS
 * dialog is open — the factory is the thing that opens it.
 */
export async function uploadFolderPlan(uploader, planOrFactory, parentId) {
  try {
    return await mergeFolderPlan(uploader, planOrFactory, parentId);
  } catch (error) {
    if (isAbort(error)) {
      toast('已取消这次上传。', { type: 'info', timeout: 2400 });
      await refreshQuietly();
      return;
    }
    toast('文件夹检查未完成，请稍后重新上传。', { type: 'warning', detail: error.message });
    await refreshQuietly();
  }
}

/**
 * The preparation row for one batch, plus the cancel request that owns it.
 *
 * The row is created LAZILY: opening the OS folder picker must not put a task
 * in the queue, so the controller exists from the start but the row appears
 * only when there is something real to say (the first folder the scan reports,
 * or the plan once it resolves). Patches that arrive before that are buffered,
 * so the row opens already showing the true count instead of 0.
 *
 * Each batch gets its own AbortController: cancelling one folder walk must not
 * touch a transfer, a second walk or the scheduler. `cancelDialog` is how the
 * conflict question is dismissed when the row is cancelled while it is open —
 * without it the dialog would outlive the walk that asked the question and the
 * next answer would land on a batch that no longer exists.
 */
function openPreparation(uploader) {
  const controller = new AbortController();
  let cancelDialog = null;
  let preparation = null;
  let entered = false;
  let pending = null;
  const onCancel = () => {
    // Take the dialog's close handle BEFORE aborting: the abort listener inside
    // the question settles it and clears the handle, so reading it afterwards
    // would find null and skip the close.
    const close = cancelDialog;
    cancelDialog = null;
    controller.abort();
    if (close) {
      try { close(); } catch { /* a dialog that is already gone */ }
    }
  };
  const noopRow = { update() {}, end() {}, cancel() { return false; } };
  const handle = {
    signal: controller.signal,
    get aborted() { return controller.signal.aborted; },
    /**
     * Creates the row on first use. `name`/`count` are only read the first time;
     * later calls keep the row's identity so a scan cannot rename the batch.
     */
    ensure(name, count) {
      // A walk that already finished never resurrects its row: the buffer is
      // dropped instead, so a late report cannot reopen a settled batch.
      if (entered) return null;
      if (preparation) return preparation;
      const label = String(name || '文件夹');
      const total = Math.max(0, Math.floor(Number(count) || 0));
      preparation = uploader && typeof uploader.beginPreparation === 'function'
        ? uploader.beginPreparation(label, total, { onCancel })
        : Object.assign({}, noopRow, { name: label, count: total });
      if (pending) {
        const patch = pending;
        pending = null;
        preparation.update(patch);
      }
      return preparation;
    },
    /** Registers the open conflict dialog so a cancel can close it. */
    setDialog(close) { cancelDialog = close; },
    clearDialog(close) { if (!close || cancelDialog === close) cancelDialog = null; },
    update(patch) {
      if (!patch || entered) return;
      if (!preparation) {
        pending = Object.assign({}, pending || {}, patch);
        return;
      }
      preparation.update(patch);
    },
    /** The first real file owns the panel from here on: the row steps aside. */
    finish() {
      if (entered) return;
      entered = true;
      pending = null;
      if (preparation) preparation.end();
    },
  };
  return handle;
}

/**
 * Turns a stage report from uploadPlan/prepareFolderFiles/pickDirectoryPlan
 * into the row's sentence, count and honest progress.
 *
 * Only a real total becomes a percentage. A scan has none (no entry API reports
 * how many files are left), so it reports `progress: null` — the indeterminate
 * bar — while still showing the real N it has counted. Hashing reports both the
 * file count and the bytes actually read, because one 900 MB file would
 * otherwise sit at the same percentage for minutes.
 */
function presentProgress(state) {
  const patch = { detail: '', progress: null };
  if (!state) return patch;
  if (state.stage === 'scan') {
    const files = Math.max(0, Number(state.files) || 0);
    const dirs = Math.max(0, Number(state.dirs) || 0);
    patch.count = files;
    const where = state.name ? '正在读取「' + state.name + '」' : '正在读取所选文件夹';
    patch.detail = where + ' · 已找到 ' + files + ' 个文件、' + dirs + ' 个文件夹';
    patch.progress = null;
    return patch;
  }
  if (state.stage === 'layout') {
    const done = Math.max(0, Number(state.done) || 0);
    const total = Math.max(0, Number(state.total) || 0);
    patch.detail = '核对目录 ' + done + '/' + total + ' · 只读检查，尚未创建文件夹';
    patch.progress = total ? Math.min(1, done / total) : null;
    return patch;
  }
  if (state.stage === 'directories') {
    const done = Math.max(0, Number(state.done) || 0);
    const total = Math.max(0, Number(state.total) || 0);
    // Only missing folders are ever created, and only after the decision: this
    // is the mutating stage, unlike the read-only `layout` check above.
    patch.detail = '正在创建缺失目录 ' + done + '/' + total;
    patch.progress = total ? Math.min(1, done / total) : null;
    return patch;
  }
  if (state.stage === 'metadata') {
    const done = Math.max(0, Number(state.done) || 0);
    const total = Math.max(0, Number(state.total) || 0);
    patch.detail = '正在核对 ' + done + '/' + total + ' 个目标目录中的同名文件';
    patch.progress = total ? Math.min(1, done / total) : null;
    return patch;
  }
  if (state.stage === 'files') {
    const done = Math.max(0, Number(state.done) || 0);
    const total = Math.max(0, Number(state.total) || 0);
    const hashed = Math.max(0, Number(state.hashedBytes) || 0);
    const hashTotal = Math.max(0, Number(state.hashTotalBytes) || 0);
    const byteText = hashBytesLabel(hashed, hashTotal);
    patch.detail = '正在校验文件内容 ' + done + '/' + total + (byteText ? ' · 已校验 ' + byteText : '');
    // Bytes are the finer, more honest measure — one 900 MB file would hold a
    // file-count bar at 0% for its whole read. With no byte total there is no
    // percentage to draw, so the row stays indeterminate.
    patch.progress = hashTotal > 0 ? Math.min(1, hashed / hashTotal) : null;
    return patch;
  }
  return patch;
}

/**
 * Uses one server folder's subtree manifest when — and only when — it can
 * replace the per-directory listings honestly.
 *
 * A folder merge that is about to reuse an existing root only needs to know
 * what is already below it. The manifest answers that in one request, empty
 * directories included. `complete: false` means the server refused to describe
 * the whole tree (it caps the walk), and a partial answer must never be used:
 * it reads as "these files are gone". Everything then falls back to the
 * original per-directory listing, unchanged.
 */
async function readMergeManifest(root, signal) {
  if (!root || root.kind !== 'folder' || !root.id) return null;
  const payload = await request('/nodes/' + encodeURIComponent(root.id) + '/merge-manifest', { signal });
  if (!payload || payload.complete !== true || !Array.isArray(payload.nodes)) return null;
  return payload.nodes.filter((node) => node && node.id && node.kind);
}

/**
 * Indexes a manifest by parentId, so one lookup fills one directory bucket.
 *
 * Every folder in the manifest also gets a bucket of its own, even when it has
 * no children: an existing EMPTY folder must be found by the createFolder check,
 * not listed again. Files and folders land in their parent's bucket exactly as
 * the listing route would return them.
 */
function manifestDirectories(nodes) {
  const directories = new Map();
  for (const node of nodes) {
    const key = node.parentId || 'root';
    if (!directories.has(key)) directories.set(key, []);
    directories.get(key).push(node);
    if (node.kind === 'folder' && node.id && !directories.has(node.id)) directories.set(node.id, []);
  }
  return directories;
}

/**
 * The root folder's name from a scan report, or '' when this report cannot
 * prove one.
 *
 * Both pickers start one level above the chosen folder, so the FIRST directory
 * a scan reports is the picked folder itself: `dirs === 1` is what makes the
 * name trustworthy. Every later entry is a child and must never rename the
 * batch — which is why the row is not created until this returns a name.
 */
function scanLabel(state) {
  if (Math.max(0, Number(state.dirs) || 0) !== 1) return '';
  return state.name ? String(state.name) : '';
}

async function mergeFolderPlan(uploader, planOrFactory, parentId) {
  const isFactory = typeof planOrFactory === 'function';
  // No row yet: the OS dialog may still be open, and an open picker is not a
  // task. The row is born at the first scan report that can name the batch (the
  // handle and entry walks name it with their root folder), or from the plan
  // itself when the picker could only hand back a flat FileList.
  const prep = openPreparation(uploader);
  let plan = null;
  let summary = null;
  const report = (state) => {
    if (!state) return;
    const patch = presentProgress(state);
    // A scan names the batch with its root folder, so the row can appear the
    // moment one directory has been counted. Earlier reports only buffer.
    if (state.stage === 'scan') {
      const label = scanLabel(state);
      if (label) prep.ensure(label, patch.count);
    }
    prep.update(patch);
  };
  const directories = new Map();
  const listFiles = async (targetParent) => {
    const key = targetParent || 'root';
    if (!directories.has(key)) {
      const live = await request('/nodes?parentId=' + encodeURIComponent(key), { signal: prep.signal });
      directories.set(key, live.nodes || []);
    }
    return directories.get(key);
  };
  try {
    if (isFactory) {
      plan = await planOrFactory({ signal: prep.signal, onProgress: report });
    } else {
      plan = planOrFactory;
    }
    if (prep.aborted) throw abortError();
    if (!plan) {
      // Cancelled at the OS picker: no row was created, and an empty toast
      // would be a lie about a folder the user never chose.
      prep.finish();
      return;
    }
    if (!plan.files.length && plan.dirs.size <= 1) {
      toast('这个文件夹是空的，没有可上传的内容。', { type: 'info' });
      prep.finish();
      return;
    }
    const label = plan.name || '文件夹';
    const total = plan.files.length;
    prep.ensure(label, total);
    prep.update({ count: total, detail: '共 ' + total + ' 个文件，正在准备上传', progress: null });

    // The plan's single top-level folder may already exist under the parent.
    // Finding it here is the one place the manifest can help: it describes that
    // folder's whole subtree, so the per-directory listing below becomes a map
    // lookup instead of one request per folder. A plan with several top-level
    // folders has no single root to match, so it keeps the per-directory walk.
    const topLevel = [...plan.dirs].filter((path) => path && !path.includes('/'));
    const rootDir = topLevel.length === 1 ? topLevel[0] : '';
    const rootName = rootDir ? rootDir.trim().replace(/\s+/g, ' ') : '';
    if (rootName) {
      prep.update({ detail: '正在核对已存在的「' + rootName + '」文件夹', progress: null });
      try {
        const parentNodes = await listFiles(parentId);
        const root = parentNodes.find((node) => node.kind === 'folder' && node.name === rootName);
        if (root) {
          const nodes = await readMergeManifest(root, prep.signal);
          if (nodes) {
            const fromManifest = manifestDirectories(nodes);
            for (const [key, list] of fromManifest) {
              if (!directories.has(key)) directories.set(key, list);
            }
            // An existing EMPTY root has no child row, so it needs its bucket
            // seeded explicitly: otherwise the preflight would list it again.
            if (!directories.has(root.id)) directories.set(root.id, []);
          }
        }
      } catch (error) {
        // A manifest is an optimisation: no route, an old server, a network blip
        // or a cancelled request all leave the original listing in charge.
        if (isAbort(error) || prep.aborted) throw abortError();
      }
    }
    if (prep.aborted) throw abortError();

    summary = await uploadPlan(plan, {
      parentId,
      signal: prep.signal,
      onProgress: report,
      // Read-only: resolves the existing tree and lists each destination
      // directory through the same cache createFolder and the merge manifest
      // already fill, so nothing is fetched twice and nothing is changed. The
      // first mkdir happens only after the file comparison and the user's
      // decision, which is what keeps a cancel from leaving empty folders.
      lookupFolder: async (targetParent, name) => {
        const cleanName = String(name).trim().replace(/\s+/g, ' ');
        const nodes = await listFiles(targetParent);
        return nodes.find((node) => node.kind === 'folder' && node.name === cleanName) || null;
      },
      createFolder: async (targetParent, name) => {
        const cleanName = String(name).trim().replace(/\s+/g, ' ');
        const existingFolder = (await listFiles(targetParent)).find((node) => node.kind === 'folder' && node.name === cleanName);
        if (existingFolder) {
          const conflict = new Error('exists');
          conflict.status = 409;
          conflict.existing = existingFolder;
          throw conflict;
        }
        try {
          const created = await createFolder(targetParent, name);
          const bucket = directories.get(targetParent || 'root');
          if (bucket) bucket.push(created);
          return created;
        } catch (error) {
          // Mirror what the server says: a same-named folder is reusable, not fatal.
          if (error && error.status === 409) {
            const live = await request('/nodes?parentId=' + encodeURIComponent(targetParent || 'root'), { signal: prep.signal });
            const existing = (live.nodes || []).find((node) => node.kind === 'folder' && node.name === cleanName);
            if (existing) {
              const conflict = new Error('exists');
              conflict.status = 409;
              conflict.existing = existing;
              throw conflict;
            }
          }
          throw error;
        }
      },
      // One file per slot, no more: the plan keeps `concurrency` files in flight
      // and the shared scheduler caps the real transfers, so this number only has
      // to be big enough to keep every slot fed. It used to be 1, which meant the
      // three-scheduler never saw a second file until the first had finished
      // — a folder upload was a strict relay of single requests.
      concurrency: Math.max(1, Number(uploader.limit) || 1),
      prepareFiles: async (entries) => {
        prep.update({ count: entries.length, detail: '正在比对文件内容和变更 · 共 ' + entries.length + ' 个文件', progress: null });
        const prepared = await prepareFolderFiles(entries, {
          signal: prep.signal,
          onProgress: report,
          listFiles: (targetParent) => listFiles(targetParent),
          hashFile: (file, options) => sha256(file, options),
          chooseConflict: (count) => {
            prep.update({ detail: '有 ' + count + ' 个文件需要确认如何处理', progress: null });
            return askConflictStrategy(count, true, {
              signal: prep.signal,
              onOpen: (close) => prep.setDialog(close),
              onSettled: (close) => prep.clearDialog(close),
            });
          },
        });
        if (prepared) prep.update({ detail: '准备完成，共 ' + prepared.length + ' 个文件，开始上传', progress: null });
        return prepared;
      },
      uploadFile: (file, targetParent, options) => {
        // Enqueue first: the synchronous head of enqueueAndWait registers the
        // task, so ending the preparation row after it cannot empty the batch
        // and let the summary reset the caller's collapsed folders.
        const pending = uploader.enqueueAndWait(file, targetParent, options.onConflict, options);
        prep.finish();
        return pending;
      },
    });
    if (summary.canceled || prep.aborted) {
      prep.finish();
      toast('已取消这次上传。', { type: 'info', timeout: 2400 });
      await runtime.refreshData();
      return;
    }
    const failed = summary.total - summary.uploaded - summary.skipped;
    const detail = summary.skipped ? '已跳过 ' + summary.skipped + ' 个文件（其中 ' + summary.unchanged + ' 个内容未变，无需重传）。' : undefined;
    await runtime.refreshData();
    if (failed || summary.failedFolders) {
      toast('已上传 ' + summary.uploaded + ' 个文件，' + failed + ' 个文件、' + summary.failedFolders + ' 个文件夹未完成', { type: 'warning', detail });
    } else {
      toast('「' + label + '」已合并：上传 ' + summary.uploaded + ' 个文件，跳过 ' + summary.skipped + ' 个文件', { type: 'success', detail });
    }
    if (plan.name) {
      const rootNode = (await request('/nodes?parentId=' + encodeURIComponent(parentId || 'root'))).nodes
        .find((node) => node.kind === 'folder' && node.name === plan.name);
      if (rootNode) {
        store.state.expanded.add(rootNode.id);
        runtime.renderShell();
      }
    }
  } catch (error) {
    if (isAbort(error) || prep.aborted) {
      prep.finish();
      toast('已取消这次上传。', { type: 'info', timeout: 2400 });
      await refreshQuietly();
      return;
    }
    throw error;
  } finally {
    // Covers the error path, the canceled plan and a tree where every file was
    // skipped or blocked: the row never outlives the walk that owns it.
    prep.finish();
  }
}


/**
 * Names already taken in one folder, as a Set.
 *
 * Only live files are compared: a same-named FOLDER is a different thing the
 * server will happily coexist with, and a trashed file is not in the way. The
 * index answers this synchronously — no request, so the conflict check cannot
 * delay the drop or the picker.
 */
export function existingFileNames(index, parentId) {
  const names = new Set();
  for (const name of existingFilesIn(index, parentId).keys()) names.add(name);
  return names;
}

/** name -> node for the live files of one folder (last one wins, as a Set would). */
export function existingFilesIn(index, parentId) {
  const files = new Map();
  const children = (index && index.children && index.children.get(parentId || 'root')) || [];
  for (const node of children) {
    if (node && node.kind === 'file' && typeof node.name === 'string') files.set(node.name, node);
  }
  return files;
}

/** The names of the picked files that collide with something already there. */
export function conflictingNames(existing, files) {
  const taken = new Set();
  for (const file of Array.from(files || [])) {
    if (file && existing.has(file.name)) taken.add(file.name);
  }
  return taken;
}

const CONFLICT_CHOICES = [
  { value: 'overwrite', label: '替换（保留历史版本）', hint: '新文件成为当前版本，旧内容仍可在「历史版本」中恢复。' },
  { value: 'rename', label: '保留两者（自动重命名）', hint: '新文件改名为「名称 (1)」这样的形式，两份都留下。' },
  { value: 'skip', label: '跳过同名', hint: '同名文件保持原样，不写入这次上传。' },
];

/**
 * Asks what should happen to same-named files, and resolves to the strategy.
 *
 * A single choice for the whole batch is the default because the alternative —
 * one decision per file — makes dropping ten photos an interrogation. The
 * checkbox is there for the batch that is genuinely mixed.
 * Resolves null when the dialog is dismissed, which cancels the upload rather
 * than silently picking overwrite.
 *
 * `{ signal, onOpen, onSettled }` is how a folder walk owns the question: the
 * signal closes the dialog when the preparation row is cancelled (resolving
 * null — exactly what the 取消上传 button does), and the callbacks hand the
 * caller a way to close it that does not require holding the whole options
 * bag. Both fire once; a dialog the user closed first stays closed.
 */
function askConflictStrategy(count, folderMerge = false, options = {}) {
  const opts = options || {};
  return new Promise((resolve) => {
    let settled = false;
    let closeDialog = () => {};
    let detachAbort = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (detachAbort) { detachAbort(); detachAbort = null; }
      if (typeof opts.onSettled === 'function') {
        try { opts.onSettled(closeDialog); } catch { /* a broken listener must not strand the promise */ }
      }
      resolve(value);
    };
    const name = 'mdrive-upload-conflict';
    const radios = CONFLICT_CHOICES.map((choice, index) => h('input', {
      attrs: { type: 'radio', name, value: choice.value, id: name + '-' + choice.value },
      checked: index === 0,
    }));
    const body = h('div', { class: 'field' },
      h('p', { class: 'muted', text: folderMerge
        ? '文件夹中有 ' + count + ' 个同名文件内容不同或无法核对，请选择处理方式。内容未变的文件会自动跳过，云端独有文件会保留。'
        : '当前文件夹里已有 ' + count + ' 个同名的文件，请选择这次上传的处理方式。' }),
      ...CONFLICT_CHOICES.map((choice, index) => h('label', { attrs: { for: name + '-' + choice.value, style: 'display:flex;gap:8px;align-items:flex-start;padding:4px 0' } },
        radios[index],
        h('span', {},
          h('b', { text: choice.label }),
          h('span', { class: 'muted', attrs: { style: 'display:block;font-size:11px' }, text: choice.hint })),
      )),
    );
    const forAll = h('input', { attrs: { type: 'checkbox' }, checked: true });
    body.appendChild(h('label', { attrs: { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' } },
      forAll,
      h('span', { text: '对本批全部 ' + count + ' 个文件使用此选择' }),
    ));
    const chosen = () => {
      // Read the option, not the reflection: a radio built with `attrs.value`
      // carries the strategy on its attribute, and only a real input mirrors
      // that onto `.value`. Falling back keeps the answer correct either way.
      const hit = radios.find((radio) => radio.checked);
      if (!hit) return 'overwrite';
      const value = hit.value || (typeof hit.getAttribute === 'function' ? hit.getAttribute('value') : '');
      return value || 'overwrite';
    };
    // The footer is a factory: dialog() drops an empty footer, so buttons added
    // after it returns would land in a detached node.
    const dlg = dialog({
      title: '有同名文件',
      description: '这一批里有文件和当前文件夹重名。',
      body,
      onClose: () => finish(null),
      footer: (handle) => [
        h('button', { class: 'btn', attrs: { type: 'button' }, text: '取消上传', on: { click: () => handle.close() } }),
        h('span', { class: 'push' }),
        h('button', {
          class: 'btn btn-primary', attrs: { type: 'button' }, text: '继续上传',
          on: { click: () => { finish(chosen()); handle.close(); } },
        }),
      ],
    });
    closeDialog = () => dlg.close();
    // An already-cancelled walk never gets to ask: resolve null and leave the
    // dialog unopened rather than flashing a question nobody is waiting for.
    if (opts.signal && opts.signal.aborted) { finish(null); dlg.close(); return; }
    if (typeof opts.onOpen === 'function') {
      try { opts.onOpen(closeDialog); } catch { /* the question still works */ }
    }
    if (opts.signal && typeof opts.signal.addEventListener === 'function') {
      const onAbort = () => { finish(null); closeDialog(); };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => opts.signal.removeEventListener('abort', onAbort);
    }
  });
}

export async function uploadFiles(uploader, files) {
  const route = store.state.route;
  if (route.name !== 'drive') {
    toast('请先回到某个文件夹再上传。', { type: 'warning' });
    return;
  }
  const parentId = route.folderId || null;
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  try {
    // The visible page is deliberately incomplete. Check the target directory
    // before asking about collisions so an off-page name cannot be overwritten
    // without offering the same replace / keep-both / skip choice.
    const payload = await request('/nodes?parentId=' + encodeURIComponent(parentId || 'root') + '&kind=file');
    const existing = new Map((payload.nodes || []).map((node) => [node.name, node]));
    const conflicts = conflictingNames(new Set(existing.keys()), list);
    if (!conflicts.size) { startUpload(uploader, list, parentId, null, existing); return; }
    const strategy = await askConflictStrategy(conflicts.size);
    if (!strategy) { toast('已取消这次上传。', { type: 'info', timeout: 2400 }); return; }
    startUpload(uploader, list, parentId, strategy, existing);
  } catch (error) {
    toast('无法检查同名文件，本次上传尚未开始。', { type: 'error', detail: error.message });
  }
}

/** How many names in the batch were already taken before the upload started. */
function wasTakenCount(list, existing) {
  let count = 0;
  for (const file of list) if (file && existing.has(file.name)) count += 1;
  return count;
}

/** Queues the batch, watches it, and reports what the conflict strategy did. */
function startUpload(uploader, list, parentId, strategy, existing) {
  // Hand the whole list to the scheduler: it keeps UPLOAD_CONCURRENCY transfers
  // in flight and refills a slot as soon as one settles, so dropping 200 files
  // no longer means 200 parallel requests.
  const tasks = uploader.enqueueAll(list, parentId, strategy);
  // A finished upload has no reason to keep a filesystem handle alive: the
  // entry is what the next page would offer to resume.
  for (const task of tasks) {
    task.on('state', (event) => {
      if (event.state === 'done' || event.state === 'canceled') {
        forgetHandle({ name: task.name, size: task.size, lastModified: task.lastModified });
        const original = list.find((file) => resumeKey(file) === resumeKey(task));
        if (original) clearLiveHandle(original);
      }
    });
  }
  uploader.whenIdle().then(async () => {
    const settled = tasks.filter((task) => task.state === 'done');
    const failed = tasks.length - settled.length;
    // A skipped completion comes back as the node that was already there, so
    // "done, same name, same id" is a skip and "done, other name" is a rename —
    // both read off the response instead of being assumed from the strategy.
    const wasTaken = (task) => existing.has(task.name);
    const skipped = strategy === 'skip'
      ? settled.filter((task) => wasTaken(task) && task.node && task.node.id === existing.get(task.name).id).length
      : 0;
    const renamed = settled.filter((task) => wasTaken(task) && task.node && task.node.name && task.node.name !== task.name).length;
    let detail;
    if (strategy === 'overwrite' && wasTakenCount(list, existing)) {
      detail = '同名文件已更新为新版本，旧版本可在「历史版本」中恢复。';
    } else if (strategy === 'rename' && renamed) {
      detail = renamed + ' 个同名文件已自动重命名，两份都保留在列表中。';
    } else if (strategy === 'skip' && skipped) {
      detail = skipped + ' 个同名文件已跳过，原文件保持不动。';
    }
    const uploaded = settled.length - skipped;
    if (failed) {
      toast(uploaded + ' 个上传完成，' + failed + ' 个未完成（可在队列中重试）', { type: 'warning', detail });
    } else if (skipped) {
      toast('已上传 ' + uploaded + ' 个文件，' + skipped + ' 个同名文件已跳过', { type: 'success', detail });
    } else {
      toast('已上传 ' + uploaded + ' 个文件', { type: 'success', detail });
    }
    await runtime.refreshData();
  });
  toast('开始上传 ' + list.length + ' 个文件', { type: 'info', timeout: 1800 });
}

/**
 * Boot-time recovery for uploads the last page did not finish.
 *
 * Two different things are recovered, and the difference matters:
 *
 *   - finished rows come back as history (they carry no file, only a summary);
 *   - unfinished *sessions* stay alive on the server for 24 h, so they are
 *     claimed and offered as resumable. Where the browser kept a filesystem
 *     handle (showOpenFilePicker was used), resuming needs no interaction at
 *     all; otherwise the row asks for the file again and matches it by
 *     name + size + sha256.
 */
export function restoreUploads(uploader) {
  if (session.uploadsRestored) return;
  session.uploadsRestored = true;
  const interrupted = uploader.restore();
  claimResumables(uploader).then((claimed) => {
    if (claimed === 0) {
      if (interrupted > 0) {
        toast('上次有 ' + interrupted + ' 个上传未完成', {
          type: 'warning',
          detail: '浏览器不能保留文件本身，请重新选择文件上传。',
          timeout: 6000,
        });
      }
      return;
    }
    toast('有 ' + claimed + ' 个上传可以继续', {
      type: 'info',
      detail: '文件已在服务器上分段保存，点队列里的「继续」即可，不必重传。',
      timeout: 6000,
    });
  });
}

/** Matches stored handles to live sessions and parks them in the queue. */
async function claimResumables(uploader) {
  let records = [];
  try {
    records = await listHandles();
  } catch {
    records = [];
  }
  const result = await uploader.claimSessions({
    match: (sessions) => matchSessions(sessions, records).map((hit) => ({
      ...hit,
      label: resumeLabel(hit.session),
    })),
    // Sessions without a stored handle still get a row: the label comes from the
    // session itself, so the user sees how much is already on the server.
    ratio: (session) => {
      const size = Number(session.size) || 0;
      return size > 0 ? receivedBytes(session) / size : 0;
    },
    onResume: (item) => resumeClaimed(uploader, item),
  });
  return result.claimed;
}

/**
 * Starts one claimed session.
 *
 * With a handle the bytes are re-read in place. Without one the picker opens;
 * the chosen file must match the session (name, size, and sha256 when both
 * sides know it), because resuming with different bytes would only fail at
 * complete time with a checksum error after the whole upload.
 */
async function resumeClaimed(uploader, item) {
  const record = item.record || {};
  const session = item.session || {};
  const handle = record.handle || null;
  let file = null;

  if (handle) {
    file = await fileFromHandle(record, handle);
    if (!file) {
      toast('「' + session.name + '」所在文件已改动，无法接着上次的进度。', {
        type: 'warning',
        detail: '请重新选择这个文件，或点「放弃」清掉服务端的分段。',
        timeout: 7000,
      });
      return;
    }
  } else {
    const picked = await pickMatchingFile(session);
    if (!picked) return;
    file = picked;
  }

  uploader.claimSessionRow(session.id);
  const task = uploader.enqueueResume(file, session, record.parentId ?? session.parentId ?? null);
  task.on('state', (event) => {
    if (event.state === 'done' || event.state === 'canceled') forgetHandle(record.key || resumeKey(file));
  });
  toast('继续上传「' + session.name + '」', { type: 'info', timeout: 2000 });
}

/** One-file picker used when a session has no stored handle. */
function pickMatchingFile(session) {
  return new Promise((resolve) => {
    const input = h('input', {
      attrs: { type: 'file', style: 'position:fixed;left:-9999px;opacity:0', 'aria-hidden': 'true', tabindex: '-1' },
      on: {
        change: () => {
          const file = input.files && input.files[0];
          input.remove();
          if (!file) { resolve(null); return; }
          if (Number(file.size) !== Number(session.size)) {
            toast('选择的文件大小不一致，无法继续这个上传。', { type: 'warning' });
            resolve(null);
            return;
          }
          resolve(file);
        },
        cancel: () => { input.remove(); resolve(null); },
      },
    });
    document.body.appendChild(input);
    input.click();
  });
}