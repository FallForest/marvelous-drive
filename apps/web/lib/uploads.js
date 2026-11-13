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
import { toast } from './ui.js';
import { createFolder } from './files.js';
import { openMenu } from './ui.js';
import { pickDirectoryPlan, uploadPlan } from './folder-upload.js';
import { store, session } from './session.js';
import { runtime } from './runtime.js';

/** The lazily created <input type=file>. One per page, kept for the session. */
export function pickFiles(uploader) {
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
    // The folder plan is sequential by design (it reuses one directory id at a
    // time), so it queues each file and waits for it instead of starting it.
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

/* The queue survives a reload as history only: a File object cannot be rebuilt,
   so finished rows are shown again and unfinished ones are just counted. */
export function restoreUploads(uploader) {
  if (session.uploadsRestored) return;
  session.uploadsRestored = true;
  const interrupted = uploader.restore();
  if (interrupted > 0) {
    toast('上次有 ' + interrupted + ' 个上传未完成', {
      type: 'warning',
      detail: '浏览器不能保留文件本身，请重新选择文件上传。',
      timeout: 6000,
    });
  }
}
