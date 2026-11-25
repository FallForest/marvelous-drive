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

/** The cancellation every scanner reports, shaped like upload.js so callers match once. */
function scanAbort() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Always read the signal live: an abort that lands mid-scan must still be seen. */
function aborted(signal) {
  return !!(signal && signal.aborted)
}

function throwIfAborted(signal) {
  if (aborted(signal)) throw scanAbort()
}

/**
 * Running counts for one scan, reported as `{ stage: 'scan', name, files, dirs }`.
 *
 * A directory walk can never know how much is left — neither entry API reports a
 * total — so the callback gets counts instead of a ratio, and `name` names the
 * entry just enumerated ('' for the opening report, when nothing is known yet).
 *
 * The abort check lives here because every count is a step boundary: a cancelled
 * scan must stop before it touches the next file or directory, not after the
 * whole tree has been read. `signal` and `onProgress` are looked up on `options`
 * at call time, so a signal that is attached after the scan started still wins.
 */
function scanProgress(options) {
  const opts = options || {}
  const signal = () => opts.signal || null
  let files = 0
  let dirs = 0
  const report = (name) => {
    if (typeof opts.onProgress !== 'function') return
    opts.onProgress({ stage: 'scan', name, files, dirs })
  }
  return {
    start(name = '') { throwIfAborted(signal()); report(name) },
    file(name) { throwIfAborted(signal()); files += 1; report(String(name || '')) },
    dir(name) { throwIfAborted(signal()); dirs += 1; report(String(name || '')) },
  }
}

/**
 * Reports a flat FileList as a scan, for the pickers that cannot see entries.
 *
 * `planFromFileList` already knows how `webkitRelativePath` encodes the folders,
 * so the plan is built there and only the counts are reported here — one shared
 * progress contract for both the entry tree and the webkitdirectory fallback.
 */
function reportFileListPlan(files, progress) {
  progress.start()
  const plan = planFromFileList(files)
  for (const entry of plan.files) progress.file(entry.file.name)
  for (const path of plan.dirs) if (path) progress.dir(path.slice(path.lastIndexOf('/') + 1))
  return plan
}

/**
 * Walks DataTransferItem entries, which is the only API that reports empty
 * directories. Resolves to the same plan shape as `planFromFileList`.
 *
 * The entries are taken synchronously, before the first await: a DataTransfer is
 * only readable while the drop handler is running and `webkitGetAsEntry()` hands
 * back a dead handle once the handler has yielded. Only the walk is async.
 */
export async function planFromDataTransfer(items, options = {}) {
  const opts = options || {}
  const signal = () => opts.signal || null
  // Synchronous by design — see above.
  const list = Array.from(items || []).filter((item) => item.kind === 'file')
  const roots = []
  for (const item of list) {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry) roots.push(entry)
  }
  const progress = scanProgress(opts)
  if (!roots.length) {
    // No entry tree: fall back to the flat files the items still hand over.
    const files = list.map((item) => item.getAsFile()).filter(Boolean)
    return reportFileListPlan(files, progress)
  }
  progress.start()
  const dirs = new Set([''])
  const files = []
  const readFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject))
  const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject))
  const walk = async (entry, path) => {
    throwIfAborted(signal())
    if (entry.isFile) {
      const file = await readFile(entry)
      // `path` is the containing directory: a file never appends its own name.
      files.push({ file, path })
      progress.file(file.name || entry.name)
      return
    }
    if (!entry.isDirectory) return
    dirs.add(path)
    // Counted on entry, before any read: an empty directory is only visible here.
    progress.dir(entry.name || path)
    const reader = entry.createReader()
    let batch = await readBatch(reader)
    while (batch.length) {
      throwIfAborted(signal())
      for (const child of batch) {
        await walk(child, child.isDirectory ? (path ? path + '/' + child.name : child.name) : path)
      }
      // Between batches is a step boundary too: a deep tree stops here.
      throwIfAborted(signal())
      batch = await readBatch(reader)
    }
  }
  // Start one level above the dropped entry so the dropped folder is created
  // too, and so an empty folder is still part of the plan.
  for (const rootEntry of roots) await walk(rootEntry, rootEntry.isDirectory ? rootEntry.name : '')
  return { name: roots.length === 1 && roots[0].isDirectory ? roots[0].name : '', dirs, files }
}

/**
 * Creates the directory skeleton, then every file.
 *
 * `createFolder(parentId, name)` and `uploadFile(file, parentId)` are injected so
 * the traversal stays testable without HTTP. Returns a summary the caller can
 * toast.
 *
 * Optional `signal` and `onProgress`. The directory stage reports
 * `onProgress({ stage: 'directories', done, total })`: `done` counts every
 * folder that has been created, reused or failed, `total` counts the planned
 * folders that still need creating (not the upload target itself, `''`). File
 * transfers keep their own progress task, so this one does not invent a byte
 * count for them.
 *
 * `lookupFolder(parentId, name)` opts into a read-only preflight. Existing
 * folders are resolved first, then `prepareFiles` compares the files, and only
 * an affirmative decision materialises the missing directories. Cancelling at
 * the picker, during the walk, while hashing, or in the conflict dialog
 * therefore issues zero directory/file mutations. `lookupFolder` must only
 * read: it is called before anything is allowed to change.
 *
 * Files below a folder that could not be resolved yet carry
 * `pendingDestination: true` rather than a null `parentId`, so nothing can
 * accidentally target the upload root. After materialisation they are bound by
 * their path; a failed mkdir leaves them blocked.
 */
export async function uploadPlan(plan, { parentId = null, createFolder, uploadFile, prepareFiles, lookupFolder, onFolder, onFile, onProgress, signal, concurrency = 1 }) {
  // Re-checked after every await: a cancel during one mkdir must stop the next
  // folder instead of finishing the skeleton first.
  const checkAbort = () => throwIfAborted(signal)
  const report = typeof onProgress === 'function' ? onProgress : null
  const preflight = typeof lookupFolder === 'function'
  checkAbort()
  const folderIds = new Map([['', parentId]])
  const ordered = [...plan.dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))

  // Read-only layout pass. Each directory's parent is already known by the time
  // it is visited (depth-first order), so one lookup per directory resolves the
  // whole existing tree. A directory missing from the cloud is not looked up
  // again below itself: nothing can exist under a folder that does not exist.
  if (preflight) {
    const totalLayout = ordered.reduce((count, path) => count + (path === '' ? 0 : 1), 0)
    let doneLayout = 0
    const reportLayout = () => {
      // Genuine work: directories actually visited. This is distinct from the
      // mutating `directories` stage below and never pretends to be upload bytes.
      if (report) report({ stage: 'layout', done: doneLayout, total: totalLayout })
    }
    if (report && totalLayout) reportLayout()
    for (const path of ordered) {
      if (path === '') continue
      checkAbort()
      const slash = path.lastIndexOf('/')
      const parentPath = slash === -1 ? '' : path.slice(0, slash)
      const name = path.slice(slash + 1)
      if (folderIds.has(parentPath)) {
        const existing = await lookupFolder(folderIds.get(parentPath), name)
        checkAbort()
        if (existing && existing.id !== undefined && existing.id !== null) folderIds.set(path, existing.id)
      }
      doneLayout += 1
      reportLayout()
    }
  }

  let folders = 0
  let failedFolders = 0
  const materialise = async () => {
    // Only folders that the read-only pass did not find. Existing folders keep
    // their ids and are never created or listed again.
    const totalDirectories = ordered.reduce((count, path) => count + (path && !folderIds.has(path) ? 1 : 0), 0)
    let doneDirectories = 0
    const reportDirectories = () => { if (report) report({ stage: 'directories', done: doneDirectories, total: totalDirectories }) }
    // No planned folders means there is no real total to show, so no event.
    if (report && totalDirectories) reportDirectories()
    for (const path of ordered) {
      if (path === '') continue
      if (folderIds.has(path)) continue
      checkAbort()
      const slash = path.lastIndexOf('/')
      const parentPath = slash === -1 ? '' : path.slice(0, slash)
      const name = path.slice(slash + 1)
      try {
        if (!folderIds.has(parentPath)) throw new Error('父文件夹创建失败：' + parentPath)
        const targetParent = folderIds.get(parentPath)
        const node = await createFolder(targetParent, name)
        folderIds.set(path, node.id)
        folders += 1
        if (onFolder) onFolder(path, node)
      } catch (error) {
        // A conflict means the folder already exists; reuse it instead of failing.
        if (error && error.status === 409 && error.existing && error.existing.kind !== 'file' && error.existing.id !== undefined && error.existing.id !== null) {
          folderIds.set(path, error.existing.id)
          doneDirectories += 1
          reportDirectories()
          continue
        }
        if (error && error.name === 'AbortError') throw error
        failedFolders += 1
        if (onFolder) onFolder(path, null, error)
      }
      doneDirectories += 1
      reportDirectories()
    }
  }

  // Files run `concurrency` at a time. The default of 1 keeps a caller that
  // wants a strict order (and every test that asserts one) unchanged; the web
  // client passes the whole list and lets its own scheduler decide, because
  // awaiting each file here made a folder of 200 files a 200-request relay: one
  // round trip of latency per file, one connection in flight, and a 200 Mbps
  // link that never went above a few MB/s.
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1)

  let queue
  if (preflight) {
    // No mkdir yet: unresolved destinations stay explicit and unbound.
    queue = plan.files.map((entry) => {
      const known = folderIds.has(entry.path)
      return { ...entry, parentId: known ? folderIds.get(entry.path) : undefined, pendingDestination: !known, blocked: false }
    })
  } else {
    // Original callers keep the original order: skeleton first, then compare.
    await materialise()
    checkAbort()
    queue = plan.files.map((entry) => ({ ...entry, parentId: folderIds.get(entry.path), blocked: !folderIds.has(entry.path) }))
  }

  // Resolve conflicts for the entire tree before scheduling any file. A cancel
  // never leaves some replacements running while the user is still deciding.
  if (prepareFiles) {
    queue = await prepareFiles(queue, { signal, onProgress })
    checkAbort()
    if (!queue) return { folders, failedFolders, uploaded: 0, total: plan.files.length, canceled: true }
  }

  if (preflight) {
    // The user (or the absence of conflicts) said yes. Only now are missing
    // directories created, and prepared files are bound to the ids that really
    // exist. A branch whose mkdir failed stays blocked instead of targeting root.
    checkAbort()
    await materialise()
    checkAbort()
    queue = queue.map((entry) => {
      const known = folderIds.has(entry.path)
      return { ...entry, parentId: known ? folderIds.get(entry.path) : undefined, pendingDestination: !known, blocked: !known }
    })
  }
  if (limit > 1) {
    // Largest first: with a fixed number of slots, starting the files that
    // dominate the batch keeps every slot busy to the end instead of leaving
    // one 900 MB file to crawl alone after the small ones are gone.
    queue.sort((a, b) => (Number(b.file && b.file.size) || 0) - (Number(a.file && a.file.size) || 0))
  }
  let uploaded = 0
  let skipped = 0
  let unchanged = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length) {
      // Cancel between files, not mid-transfer: a running upload owns its task.
      if (aborted(signal)) return
      const entry = queue[cursor]
      cursor += 1
      try {
        if (entry.blocked) throw new Error('目标文件夹创建失败：' + entry.path)
        if (entry.skip) {
          skipped += 1
          if (entry.unchanged) unchanged += 1
          if (onFile) onFile(entry, true)
          continue
        }
        await uploadFile(entry.file, entry.parentId, entry.options)
        uploaded += 1
        if (onFile) onFile(entry, true)
      } catch (error) {
        if (onFile) onFile(entry, false, error)
      }
    }
  }
  const workers = Math.min(limit, queue.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  checkAbort()
  return { folders, failedFolders, uploaded, total: plan.files.length, ...(prepareFiles ? { skipped, unchanged } : {}) }
}

/**
 * Live directory listings and content hashes, never timestamps, decide a merge.
 *
 * Optional `signal` and `onProgress`. Every destination directory is listed
 * once and indexed by file name, so a tree of many files costs one lookup per
 * file instead of one scan per file. Progress is reported only where a real
 * total exists: `metadata` counts directories, `files` counts the hashes that
 * actually need reading (`done` files, `hashedBytes` of `hashTotalBytes`).
 * A hash is only read when the remote node has the same name and size and a
 * cloud hash to compare against; everything else is left untouched.
 *
 * Entries carrying `pendingDestination` (a directory that does not exist yet,
 * so it cannot hold a same-named file) are never listed and never hashed. They
 * still get the same prepared shape — `expectedVersion: 0`, a strategy and the
 * flags — and are bound to their real folder id after the mkdir.
 */
export async function prepareFolderFiles(entries, { listFiles, hashFile, chooseConflict, onProgress, signal } = {}) {
  // Re-checked after every await: a cancel during a listing or a hash must stop
  // the next piece of work, not let the whole tree finish first.
  const checkAbort = () => throwIfAborted(signal)
  const report = typeof onProgress === 'function' ? onProgress : null

  checkAbort()
  const nameOf = (entry) => String(entry.file.name).trim().replace(/\s+/g, ' ')
  // A file under a folder that does not exist yet cannot collide with anything:
  // there is no destination to list, and its parentId is not known until the
  // directories are created (and only after the user says yes).
  const deferred = (entry) => Boolean(entry && entry.pendingDestination)

  // Directory pass: one listing per destination, each indexed by file name.
  const listings = new Map()
  const parents = new Map()
  for (const entry of entries) {
    if (entry.blocked) continue
    if (deferred(entry)) continue
    const key = entry.parentId || 'root'
    if (listings.has(key)) continue
    listings.set(key, new Map())
    parents.set(key, entry.parentId)
  }
  const totalDirectories = parents.size
  let listedDirectories = 0
  const reportMetadata = () => {
    if (report) report({ stage: 'metadata', done: listedDirectories, total: totalDirectories })
  }
  if (report && totalDirectories) reportMetadata()
  for (const [key, targetParent] of parents) {
    checkAbort()
    const nodes = await listFiles(targetParent)
    checkAbort()
    const index = listings.get(key)
    for (const node of nodes || []) {
      // First match wins, exactly like the old per-file search did.
      if (node && node.kind === 'file' && !index.has(node.name)) index.set(node.name, node)
    }
    listedDirectories += 1
    reportMetadata()
  }
  const indexOf = (entry) => listings.get(entry.parentId || 'root') || new Map()

  // Hash pass planning: same name, same size and a cloud hash is the only case
  // where reading local bytes can prove the content is unchanged.
  const candidates = new Set()
  let hashTotalBytes = 0
  for (const entry of entries) {
    if (entry.blocked) continue
    if (deferred(entry)) continue
    const existing = indexOf(entry).get(nameOf(entry))
    if (existing && Number(existing.size) === entry.file.size && existing.blobHash) {
      candidates.add(entry)
      hashTotalBytes += Number(entry.file.size) || 0
    }
  }
  const totalHashes = candidates.size
  let doneHashes = 0
  let hashedBytes = 0
  const reportFiles = () => {
    if (report) report({ stage: 'files', done: doneHashes, total: totalHashes, hashedBytes, hashTotalBytes })
  }
  if (report && totalHashes) reportFiles()

  const prepared = []
  let conflicts = 0
  for (const entry of entries) {
    if (entry.blocked) { prepared.push(entry); continue }
    checkAbort()
    // A pending destination has no folder to look in yet: it is new by
    // construction, so it keeps the absence guard (`expectedVersion: 0`) and
    // the carried flags, and is bound to its real id after the mkdir.
    const existing = deferred(entry) ? null : indexOf(entry).get(nameOf(entry))
    let hash = ''
    if (candidates.has(entry)) {
      let loaded = 0
      const size = Number(entry.file.size) || 0
      hash = await hashFile(entry.file, {
        signal,
        onProgress: (value) => {
          const next = Math.max(0, Math.min(Number(value) || 0, size))
          // Only ever add bytes the hasher really reported, so one big file
          // keeps the bar moving instead of jumping at the end.
          hashedBytes += Math.max(0, next - loaded)
          loaded = next
          reportFiles()
        },
      })
      checkAbort()
      doneHashes += 1
      reportFiles()
    }
    if (hash && hash === existing?.blobHash) {
      prepared.push({ ...entry, skip: true, unchanged: true })
      continue
    }
    if (existing) conflicts += 1
    prepared.push({ ...entry, existing, options: {
      hash,
      expectedVersion: existing ? existing.version : 0,
      expectedNodeId: existing?.id,
    } })
  }
  checkAbort()
  const strategy = conflicts ? await chooseConflict(conflicts) : 'overwrite'
  checkAbort()
  if (!strategy) return null
  return prepared.map((entry) => entry.skip || entry.blocked ? entry : ({
    ...entry,
    skip: Boolean(entry.existing && strategy === 'skip'),
    options: { ...entry.options, onConflict: strategy },
  }))
}

/**
 * Walks a File System Access `FileSystemDirectoryHandle`.
 *
 * `<input webkitdirectory>` is the widest-compatible picker but its FileList
 * never contains empty directories, so a folder that is only structure would
 * vanish. The handle API enumerates every entry, empty ones included, which is
 * why it is preferred whenever the browser offers it.
 *
 * The handle itself is always readable — unlike a DataTransfer — so the walk
 * takes `options` the same way `planFromDataTransfer` does, and a signal that is
 * attached after the picker resolved still stops the next read.
 */
async function planFromDirectoryHandle(handle, options = {}) {
  const opts = options || {}
  const signal = () => opts.signal || null
  const progress = scanProgress(opts)
  progress.start()
  const dirs = new Set([''])
  const files = []
  const walk = async (directory, path) => {
    throwIfAborted(signal())
    dirs.add(path)
    progress.dir(directory.name || path)
    for await (const entry of directory.values()) {
      throwIfAborted(signal())
      const childPath = path ? path + '/' + entry.name : entry.name
      if (entry.kind === 'directory') await walk(entry, childPath)
      else {
        const file = await entry.getFile()
        files.push({ file, path })
        progress.file(file.name || entry.name)
      }
    }
  }
  await walk(handle, handle.name)
  return { name: handle.name, dirs, files }
}

/**
 * Opens the best available directory picker: the handle API when it exists
 * (empty directories survive), otherwise a hidden `webkitdirectory` input.
 * Resolves to a plan, or null when the user cancels or the scan is aborted.
 *
 * `{ signal, onProgress }` reaches the scan; the signal is read live, so one
 * that arrives after the dialog opened still cancels the walk. The
 * `webkitdirectory` fallback reports the same `stage: 'scan'` counts from the
 * picked FileList, so a caller's progress row behaves the same either way.
 */
export async function pickDirectoryPlan(options = {}) {
  const opts = options || {}
  const signal = () => opts.signal || null
  throwIfAborted(signal())
  if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
    let picked = false
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      if (handle) {
        picked = true
        return await planFromDirectoryHandle(handle, opts)
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return null
      // An abort of OUR scan is not a picker failure: never fall through to the
      // input, which would pop a second dialog after the user cancelled.
      if (!picked && aborted(signal())) return null
      // Any other failure falls through to the input, which always works.
    }
  }
  throwIfAborted(signal())
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
          if (aborted(signal())) { resolve(null); return; }
          // The picker always yields files; the plan (and its counts) only start
          // once the user has chosen, so nothing is reported for an empty pick.
          resolve(files.length ? reportFileListPlan(files, scanProgress(opts)) : null);
        },
        cancel: () => { input.remove(); resolve(null); },
      },
    });
    document.body.appendChild(input);
    input.click();
  });
}
