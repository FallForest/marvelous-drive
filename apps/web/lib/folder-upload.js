/*
 * folder-upload.js — upload a whole directory tree.
 *
 * Two entry points share one plan:
 *   - <input type="file" webkitdirectory> gives a flat list of Files that carry
 *     a `webkitRelativePath`, which already encodes the folders;
 *   - drag & drop gives DataTransferItem.webkitGetAsEntry() trees, which is the
 *     only way to see EMPTY directories (a FileList never contains them).
 *
 * Both are normalised into the same tree, then created depth-first on the server
 * before any bytes are sent, so an empty folder still lands and a failure
 * halfway leaves a navigable skeleton instead of loose files.
 */

import { h } from './dom.js';
import { createUploadTask } from './upload.js';

/**
 * Folder path of a picked file, relative to the upload target.
 *
 * The picker always prefixes the chosen folder's own name, and that folder is
 * part of what the user asked to upload, so it is kept: dropping `Docs/` into
 * the drive creates `Docs`, exactly like a desktop client would.
 */
export function relativeSegments(webkitRelativePath) {
  const parts = String(webkitRelativePath || '').split('/').filter(Boolean);
  return parts.slice(0, -1);
}

/**
 * Builds `{ name, dirs: Set<path>, files: [{ file, path }] }` from a FileList.
 *
 * `path` is the folder path below the upload target (so the selected folder
 * itself is the first segment), and `''` means "directly in the target".
 */
export function planFromFileList(fileList) {
  const files = Array.from(fileList || []);
  const dirs = new Set([''])
  const entries = []
  for (const file of files) {
    const segments = relativeSegments(file.webkitRelativePath)
    let path = ''
    for (const segment of segments) {
      path = path ? path + '/' + segment : segment
      dirs.add(path)
    }
    entries.push({ file, path })
  }
  const root = [...dirs].find((path) => path && !path.includes('/')) || ''
  return { name: root, dirs, files: entries }
}

/**
 * Walks DataTransferItem entries, which is the only API that reports empty
 * directories. Resolves to the same plan shape as `planFromFileList`.
 */
export async function planFromDataTransfer(items) {
  const roots = []
  const list = Array.from(items || []).filter((item) => item.kind === 'file')
  for (const item of list) {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry) roots.push(entry)
  }
  if (!roots.length) {
    const files = list.map((item) => item.getAsFile()).filter(Boolean)
    return planFromFileList(files, '')
  }
  const dirs = new Set([''])
  const files = []
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
      // `path` is the containing directory: a file never appends its own name.
      files.push({ file, path })
      return
    }
    if (!entry.isDirectory) return
    dirs.add(path)
    const reader = entry.createReader()
    let batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    while (batch.length) {
      for (const child of batch) {
        await walk(child, child.isDirectory ? (path ? path + '/' + child.name : child.name) : path)
      }
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    }
  }
  // Start one level above the dropped entry so the dropped folder is created
  // too, and so an empty folder is still part of the plan.
  for (const rootEntry of roots) await walk(rootEntry, rootEntry.name)
  return { name: roots.length === 1 && roots[0].isDirectory ? roots[0].name : '', dirs, files }
}

/**
 * Creates the directory skeleton, then every file.
 *
 * `createFolder(parentId, name)` and `uploadFile(file, parentId)` are injected so
 * the traversal stays testable without HTTP. Returns a summary the caller can
 * toast.
 */
export async function uploadPlan(plan, { parentId = null, createFolder, uploadFile, onFolder, onFile, concurrency = 1 }) {
  const folderIds = new Map([['', parentId]])
  const ordered = [...plan.dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  let folders = 0
  let failedFolders = 0
  for (const path of ordered) {
    if (path === '') continue
    const slash = path.lastIndexOf('/')
    const parentPath = slash === -1 ? '' : path.slice(0, slash)
    const name = path.slice(slash + 1)
    const targetParent = folderIds.get(parentPath) ?? parentId
    try {
      const node = await createFolder(targetParent, name)
      folderIds.set(path, node.id)
      folders += 1
      if (onFolder) onFolder(path, node)
    } catch (error) {
      // A conflict means the folder already exists; reuse it instead of failing.
      if (error && error.status === 409 && error.existing) {
        folderIds.set(path, error.existing.id)
        continue
      }
      failedFolders += 1
      if (onFolder) onFolder(path, null, error)
    }
  }
  // Files run `concurrency` at a time. The default of 1 keeps a caller that
  // wants a strict order (and every test that asserts one) unchanged; the web
  // client passes the whole list and lets its own scheduler decide, because
  // awaiting each file here made a folder of 200 files a 200-request relay: one
  // round trip of latency per file, one connection in flight, and a 200 Mbps
  // link that never went above a few MB/s.
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1)
  const queue = plan.files.slice()
  if (limit > 1) {
    // Largest first: with a fixed number of slots, starting the files that
    // dominate the batch keeps every slot busy to the end instead of leaving
    // one 900 MB file to crawl alone after the small ones are gone.
    queue.sort((a, b) => (Number(b.file && b.file.size) || 0) - (Number(a.file && a.file.size) || 0))
  }
  let uploaded = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length) {
      const entry = queue[cursor]
      cursor += 1
      const targetParent = folderIds.get(entry.path) ?? parentId
      try {
        await uploadFile(entry.file, targetParent)
        uploaded += 1
        if (onFile) onFile(entry, true)
      } catch (error) {
        if (onFile) onFile(entry, false, error)
      }
    }
  }
  const workers = Math.min(limit, queue.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return { folders, failedFolders, uploaded, total: plan.files.length }
}

/**
 * Walks a File System Access `FileSystemDirectoryHandle`.
 *
 * `<input webkitdirectory>` is the widest-compatible picker but its FileList
 * never contains empty directories, so a folder that is only structure would
 * vanish. The handle API enumerates every entry, empty ones included, which is
 * why it is preferred whenever the browser offers it.
 */
export async function planFromDirectoryHandle(handle) {
  const dirs = new Set([''])
  const files = []
  const walk = async (directory, path) => {
    dirs.add(path)
    for await (const entry of directory.values()) {
      const childPath = path ? path + '/' + entry.name : entry.name
      if (entry.kind === 'directory') await walk(entry, childPath)
      else files.push({ file: await entry.getFile(), path })
    }
  }
  await walk(handle, handle.name)
  return { name: handle.name, dirs, files }
}

/**
 * Opens the best available directory picker: the handle API when it exists
 * (empty directories survive), otherwise a hidden `webkitdirectory` input.
 * Resolves to a plan, or null when the user cancels.
 */
export async function pickDirectoryPlan() {
  if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      if (handle) return await planFromDirectoryHandle(handle)
    } catch (error) {
      if (error && error.name === 'AbortError') return null
      // Any other failure falls through to the input, which always works.
    }
  }
  return new Promise((resolve) => {
    const input = h('input', {
      attrs: {
        type: 'file', webkitdirectory: '', directory: '', multiple: 'multiple',
        style: 'position:fixed;left:-9999px;opacity:0', 'aria-hidden': 'true', tabindex: '-1',
      },
      on: {
        change: () => {
          const files = Array.from(input.files || []);
          input.value = '';
          input.remove();
          resolve(files.length ? planFromFileList(files) : null);
        },
        cancel: () => { input.remove(); resolve(null); },
      },
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Legacy helper kept for callers that already have a callback: opens the picker
 * and hands the plan over.
 */
/**
 * Wires a hidden `webkitdirectory` input so the toolbar can offer
 * "上传文件夹" without any extra markup in index.html.
 */
export function pickDirectory(onPicked) {
  const input = h('input', {
    attrs: {
      type: 'file', webkitdirectory: '', directory: '', multiple: 'multiple',
      style: 'position:fixed;left:-9999px;opacity:0', 'aria-hidden': 'true', tabindex: '-1',
    },
    on: {
      change: () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length) onPicked(planFromFileList(files));
      },
    },
  });
  document.body.appendChild(input);
  input.click();
  return input;
}