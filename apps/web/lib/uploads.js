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
import { toast, openMenu } from './ui.js';
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

export function uploadFiles(uploader, files) {
  const route = store.state.route;
  if (route.name !== 'drive') {
    toast('请先回到某个文件夹再上传。', { type: 'warning' });
    return;
  }
  const parentId = route.folderId || null;
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;

  // Hand the whole list to the scheduler: it keeps UPLOAD_CONCURRENCY transfers
  // in flight and refills a slot as soon as one settles, so dropping 200 files
  // no longer means 200 parallel requests.
  const tasks = uploader.enqueueAll(list, parentId);
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
    const done = tasks.filter((task) => task.state === 'done').length;
    const failed = tasks.length - done;
    toast(failed
      ? done + ' 个上传完成，' + failed + ' 个未完成（可在队列中重试）'
      : '已上传 ' + done + ' 个文件', { type: failed ? 'warning' : 'success' });
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
