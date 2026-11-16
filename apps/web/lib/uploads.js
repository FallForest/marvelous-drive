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
import { createFolder } from './files.js';
import { pickDirectoryPlan, uploadPlan } from './folder-upload.js';
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
          const plan = await pickDirectoryPlan();
          if (plan) await uploadFolderPlan(uploader, plan, target);
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

/** Creates the folder skeleton first, then streams every file into it. */
export async function uploadFolderPlan(uploader, plan, parentId) {
  if (!plan || (!plan.files.length && plan.dirs.size <= 1)) {
    toast('这个文件夹是空的，没有可上传的内容。', { type: 'info' });
    return;
  }
  const label = plan.name || '文件夹';
  toast('正在创建 ' + label + ' 的目录结构…', { type: 'info', timeout: 2000 });
  const summary = await uploadPlan(plan, {
    parentId,
    createFolder: async (targetParent, name) => {
      try {
        return await createFolder(targetParent, name);
      } catch (error) {
        // Mirror what the server says: a same-named folder is reusable, not fatal.
        if (error && error.status === 409) {
          const live = await request('/nodes?parentId=' + encodeURIComponent(targetParent || 'root'));
          const existing = (live.nodes || []).find((node) => node.kind === 'folder' && node.name === name);
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
    // three-slot scheduler never saw a second file until the first had finished
    // — a folder upload was a strict relay of single requests.
    concurrency: Math.max(1, Number(uploader.limit) || 1),
    uploadFile: (file, targetParent) => uploader.enqueueAndWait(file, targetParent),
  });
  const failed = summary.total - summary.uploaded;
  await runtime.refreshData();
  if (failed) {
    toast('已上传 ' + summary.uploaded + ' 个文件，' + failed + ' 个失败（可在队列中重试）', { type: 'warning' });
  } else {
    toast('「' + label + '」已上传：' + summary.folders + ' 个文件夹，' + summary.uploaded + ' 个文件', { type: 'success' });
  }
  if (plan.name) {
    const rootNode = (await request('/nodes?parentId=' + encodeURIComponent(parentId || 'root'))).nodes
      .find((node) => node.kind === 'folder' && node.name === plan.name);
    if (rootNode) {
      store.state.expanded.add(rootNode.id);
      runtime.renderShell();
    }
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
 */
export function askConflictStrategy(count) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const name = 'mdrive-upload-conflict';
    const radios = CONFLICT_CHOICES.map((choice, index) => h('input', {
      attrs: { type: 'radio', name, value: choice.value, id: name + '-' + choice.value },
      checked: index === 0,
    }));
    const body = h('div', { class: 'field' },
      h('p', { class: 'muted', text: '当前文件夹里已有 ' + count + ' 个同名的文件，请选择这次上传的处理方式。' }),
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
      const hit = radios.find((radio) => radio.checked);
      return hit ? hit.value : 'overwrite';
    };
    // The footer is a factory: dialog() drops an empty footer, so buttons added
    // after it returns would land in a detached node.
    dialog({
      title: '有同名文件',
      description: '这一批里有文件和当前文件夹重名。',
      body,
      onClose: () => finish(null),
      footer: (dlg) => [
        h('button', { class: 'btn', attrs: { type: 'button' }, text: '取消上传', on: { click: () => dlg.close() } }),
        h('span', { class: 'push' }),
        h('button', {
          class: 'btn btn-primary', attrs: { type: 'button' }, text: '继续上传',
          on: { click: () => { finish(chosen()); dlg.close(); } },
        }),
      ],
    });
  });
}

export function uploadFiles(uploader, files) {
  const route = store.state.route;
  if (route.name !== 'drive') {
    toast('请先回到某个文件夹再上传。', { type: 'warning' });
    return;
  }
  const parentId = route.folderId || null;
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  const existing = existingFilesIn(session.index, parentId);
  const conflicts = conflictingNames(new Set(existing.keys()), list);
  if (!conflicts.size) { startUpload(uploader, list, parentId, null, existing); return; }
  // The dialog owns the ordering: the files are not queued until it answers, so
  // a cancel leaves nothing running and no strategy half-applied.
  askConflictStrategy(conflicts.size).then((strategy) => {
    if (!strategy) { toast('已取消这次上传。', { type: 'info', timeout: 2400 }); return; }
    startUpload(uploader, list, parentId, strategy, existing);
  });
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
