import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planFromFileList, prepareFolderFiles, relativeSegments, uploadPlan } from '../lib/folder-upload.js'
import { sha256 } from '../lib/upload.js'

/** Directory upload planning: the pure part of the folder upload path. */

const file = (name) => ({ name });

describe('relativeSegments', () => {
  it('keeps the picked folder itself', () => {
    assert.deepEqual(relativeSegments('Projects/2026/q1.md'), ['Projects', '2026']);
  });

  it('returns the root folder for a top-level file', () => {
    assert.deepEqual(relativeSegments('Projects/readme.md'), ['Projects']);
  });

  it('tolerates an empty path', () => {
    assert.deepEqual(relativeSegments(''), []);
  });
});

describe('planFromFileList', () => {
  it('treats the picked folder as part of the upload', () => {
    const files = [
      Object.assign(file('a.md'), { webkitRelativePath: 'Docs/a.md' }),
      Object.assign(file('b.md'), { webkitRelativePath: 'Docs/specs/b.md' }),
      Object.assign(file('c.md'), { webkitRelativePath: 'Docs/specs/deep/c.md' }),
    ];
    const plan = planFromFileList(files);
    assert.equal(plan.name, 'Docs');
    assert.deepEqual([...plan.dirs].sort(), ['', 'Docs', 'Docs/specs', 'Docs/specs/deep']);
    assert.deepEqual(plan.files.map((entry) => entry.path), ['Docs', 'Docs/specs', 'Docs/specs/deep']);
  });

  it('keeps every prefix directory of mixed depths', () => {
    const files = [
      Object.assign(file('x.txt'), { webkitRelativePath: 'Root/x.txt' }),
      Object.assign(file('y.txt'), { webkitRelativePath: 'Root/a/b/y.txt' }),
      Object.assign(file('z.txt'), { webkitRelativePath: 'Root/a/z.txt' }),
    ];
    const plan = planFromFileList(files);
    assert.ok(plan.dirs.has('Root/a'));
    assert.ok(plan.dirs.has('Root/a/b'));
  });

  it('survives a FileList without relative paths', () => {
    const plan = planFromFileList([file('loose.txt')]);
    assert.equal(plan.name, '');
    assert.deepEqual([...plan.dirs], ['']);
    assert.equal(plan.files.length, 1);
  });
});

describe('uploadPlan', () => {
  const plan = {
    name: 'Docs',
    dirs: new Set(['', 'Docs', 'Docs/specs', 'Docs/specs/deep']),
    files: [
      { file: file('a.md'), path: 'Docs' },
      { file: file('b.md'), path: 'Docs/specs' },
      { file: file('c.md'), path: 'Docs/specs/deep' },
    ],
  };

  it('creates the picked folder, then children, and uploads into the right one', async () => {
    const created = [];
    const uploads = [];
    let counter = 0;
    const result = await uploadPlan(plan, {
      parentId: 'root-folder',
      createFolder: async (parentId, name) => { created.push(parentId + '/' + name); return { id: 'id-' + (++counter) }; },
      uploadFile: async (f, parentId) => { uploads.push(f.name + '@' + parentId); },
    });
    assert.deepEqual(created, ['root-folder/Docs', 'id-1/specs', 'id-2/deep']);
    assert.deepEqual(uploads, ['a.md@id-1', 'b.md@id-2', 'c.md@id-3']);
    assert.deepEqual(result, { folders: 3, failedFolders: 0, uploaded: 3, total: 3 });
  });

  it('reuses an existing folder on a conflict instead of failing the branch', async () => {
    const uploads = [];
    const result = await uploadPlan(plan, {
      createFolder: async (parentId, name) => {
        if (name === 'Docs') {
          const error = new Error('conflict');
          error.status = 409;
          error.existing = { id: 'existing-docs' };
          throw error;
        }
        return { id: 'new-' + name };
      },
      uploadFile: async (f, parentId) => { uploads.push(f.name + '@' + parentId); },
    });
    assert.equal(result.folders, 2);
    assert.ok(uploads.includes('a.md@existing-docs'));
    assert.ok(uploads.includes('b.md@new-specs'));
    assert.ok(uploads.includes('c.md@new-deep'));
  });

  it('keeps going after one file fails and reports the summary', async () => {
    const seen = [];
    const result = await uploadPlan(plan, {
      createFolder: async () => ({ id: 'x' }),
      uploadFile: async (f) => {
        if (f.name === 'b.md') throw new Error('boom');
        seen.push(f.name);
      },
    });
    assert.deepEqual(seen, ['a.md', 'c.md']);
    assert.equal(result.uploaded, 2);
    assert.equal(result.total, 3);
  });

  it('runs several files at once when asked, instead of one round trip each', async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({ file: file('f' + index + '.bin'), path: 'Batch' }));
    let inFlight = 0;
    let peak = 0;
    let uploaded = 0;
    const summary = await uploadPlan(
      { name: 'Batch', dirs: new Set(['', 'Batch']), files },
      {
        concurrency: 3,
        createFolder: async () => ({ id: 'dir' }),
        uploadFile: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          uploaded += 1;
        },
      },
    );
    assert.equal(summary.uploaded, 6);
    assert.equal(uploaded, 6);
    // Three slots were busy at the same time: this is the whole point.
    assert.equal(peak, 3);
  });

  it('still uploads one file at a time by default', async () => {
    let inFlight = 0;
    let peak = 0;
    await uploadPlan(
      { name: 'Solo', dirs: new Set(['', 'Solo']), files: [{ file: file('a'), path: 'Solo' }, { file: file('b'), path: 'Solo' }] },
      {
        createFolder: async () => ({ id: 'dir' }),
        uploadFile: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
        },
      },
    );
    assert.equal(peak, 1);
  });

  it('starts the largest files first once it parallelises', async () => {
    const started = [];
    await uploadPlan(
      {
        name: 'Mixed',
        dirs: new Set(['', 'Mixed']),
        files: [
          { file: { name: 'small', size: 10 }, path: 'Mixed' },
          { file: { name: 'huge', size: 900 }, path: 'Mixed' },
          { file: { name: 'medium', size: 100 }, path: 'Mixed' },
        ],
      },
      {
        concurrency: 2,
        createFolder: async () => ({ id: 'dir' }),
        uploadFile: async (entry) => { started.push(entry.name); await new Promise((resolve) => setTimeout(resolve, 2)); },
      },
    );
    // Largest first: the batch ends on small files, not on one huge tail.
    assert.deepEqual(started, ['huge', 'medium', 'small']);
  });

  it('keeps the plan order when the caller asks for one file at a time', async () => {
    const started = [];
    await uploadPlan(
      {
        name: 'Mixed',
        dirs: new Set(['', 'Mixed']),
        files: [
          { file: { name: 'small', size: 10 }, path: 'Mixed' },
          { file: { name: 'huge', size: 900 }, path: 'Mixed' },
        ],
      },
      {
        createFolder: async () => ({ id: 'dir' }),
        uploadFile: async (entry) => { started.push(entry.name); },
      },
    );
    assert.deepEqual(started, ['small', 'huge']);
  });

  it('an empty folder still creates its directory', async () => {
    const result = await uploadPlan({ name: 'Empty', dirs: new Set(['', 'Empty']), files: [] }, {
      createFolder: async () => ({ id: 'n' }),
      uploadFile: async () => { throw new Error('should not upload'); },
    });
    assert.deepEqual(result, { folders: 1, failedFolders: 0, uploaded: 0, total: 0 });
  });

  it('blocks a failed branch instead of placing descendants in the target root', async () => {
    const created = [];
    const uploads = [];
    const result = await uploadPlan(plan, {
      parentId: 'drive',
      createFolder: async (parentId, name) => { created.push(name); throw new Error('forbidden'); },
      uploadFile: async (f, parentId) => uploads.push([f.name, parentId]),
    });
    assert.deepEqual(created, ['Docs']);
    assert.deepEqual(uploads, []);
    assert.equal(result.failedFolders, 3);
    assert.equal(result.uploaded, 0);
  });

  it('does not enqueue anything when the merge decision is canceled', async () => {
    const result = await uploadPlan(plan, {
      createFolder: async () => ({ id: 'dir' }),
      prepareFiles: async () => null,
      uploadFile: async () => { throw new Error('must not run'); },
    });
    assert.equal(result.canceled, true);
    assert.equal(result.uploaded, 0);
  });
});

describe('incremental folder merge', () => {
  const local = (content, name = 'notes.txt') => new File([content], name);
  const remote = async (f, extra = {}) => ({ id: 'old', name: f.name, kind: 'file', size: f.size, version: 3, blobHash: await sha256(f), ...extra });

  it('skips identical small files without prompting or scheduling a transfer', async () => {
    const file = local('same small bytes');
    const existing = await remote(file);
    let transfers = 0;
    const summary = await uploadPlan({ dirs: new Set(['', 'Docs']), files: [{ file, path: 'Docs' }] }, {
      createFolder: async () => ({ id: 'docs' }),
      prepareFiles: (entries) => prepareFolderFiles(entries, {
        listFiles: async () => [existing], hashFile: sha256,
        chooseConflict: async () => { throw new Error('identical content needs no decision'); },
      }),
      uploadFile: async () => transfers++,
    });
    assert.equal(transfers, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.uploaded, 0);
  });

  it('compares hashes even when sizes match, and asks once for all changed files', async () => {
    const a = local('old', 'a.txt'), b = local('old', 'b.txt');
    const nodes = [await remote(a), await remote(b, { id: 'old-b' })];
    let reads = 0, questions = 0;
    const result = await prepareFolderFiles([
      { file: local('new', 'a.txt'), parentId: 'docs' },
      { file: local('new', 'b.txt'), parentId: 'docs' },
    ], {
      listFiles: async () => { reads++; return nodes; }, hashFile: sha256,
      chooseConflict: async (count) => { questions++; assert.equal(count, 2); return 'overwrite'; },
    });
    assert.equal(reads, 1);
    assert.equal(questions, 1);
    assert.equal(result[0].skip, false);
    assert.equal(result[0].options.expectedVersion, 3);
    assert.equal(result[0].options.expectedNodeId, 'old');
    assert.equal(result[0].options.hash, await sha256(local('new')));
    assert.equal(result[0].options.onConflict, 'overwrite');
  });

  it('uploads only new entries and keeps the preflight absence guard', async () => {
    const file = local('new');
    const result = await prepareFolderFiles([{ file, parentId: 'docs' }], {
      listFiles: async () => [], hashFile: sha256,
      chooseConflict: async () => { throw new Error('no conflict'); },
    });
    assert.equal(result[0].options.expectedVersion, 0);
    assert.equal(result[0].skip, false);
  });

  it('keeps paths separate, preserves remote-only files and honours skip/rename', async () => {
    const existing = await remote(local('old'));
    const entries = [{ file: local('new'), parentId: 'a' }, { file: local('new'), parentId: 'b' }];
    for (const strategy of ['skip', 'rename']) {
      const result = await prepareFolderFiles(entries, {
        listFiles: async (id) => id === 'a' ? [existing, { id: 'remote-only', name: 'cloud.txt', kind: 'file' }] : [],
        hashFile: sha256, chooseConflict: async () => strategy,
      });
      assert.equal(result.length, 2, 'cloud-only files produce no deletion');
      assert.equal(result[0].skip, strategy === 'skip');
      assert.equal(result[1].skip, false);
      assert.equal(result[1].options.expectedVersion, 0);
    }
  });

  it('never treats unavailable hashing as proof that the content is unchanged', async () => {
    const file = local('old');
    const existing = await remote(file);
    let questions = 0;
    const result = await prepareFolderFiles([{ file, parentId: 'docs' }], {
      listFiles: async () => [existing], hashFile: async () => '',
      chooseConflict: async () => { questions++; return null; },
    });
    assert.equal(questions, 1);
    assert.equal(result, null);
  });

  it('never lists or hashes a pending destination and still carries the absence guard', async () => {
    const result = await prepareFolderFiles([
      { file: local('new', 'c.txt'), parentId: undefined, pendingDestination: true },
    ], {
      listFiles: async () => { throw new Error('a pending folder cannot be listed'); },
      hashFile: async () => { throw new Error('a new file has nothing to compare'); },
      chooseConflict: async () => { throw new Error('no conflict'); },
    });
    assert.equal(result[0].pendingDestination, true);
    assert.equal(result[0].options.expectedVersion, 0);
    assert.equal(result[0].options.expectedNodeId, undefined);
    assert.equal(result[0].options.onConflict, 'overwrite');
    assert.equal(result[0].skip, false);
  });
});

describe('folder merge preflight', () => {
  // A tiny cloud: `Docs/` already exists with one changed same-named file.
  // Everything else in the local tree below is new, including an empty folder
  // and a nested branch. This is the reported browser case, scaled down.
  const changed = () => new File(['new'], 'a.txt');
  const nested = () => new File(['nest'], 'c.txt');
  const localPlan = async () => {
    const plan = planFromFileList([
      Object.assign(changed(), { webkitRelativePath: 'Docs/a.txt' }),
      Object.assign(nested(), { webkitRelativePath: 'Docs/branch/nested/c.txt' }),
    ]);
    // An empty directory only exists in a real DataTransfer/handle walk; the
    // plan shape is the same, so the fixture adds it directly.
    plan.dirs.add('Docs/new-empty');
    return plan;
  };

  function cloud() {
    const children = new Map([
      ['root', [{ id: 'docs', parentId: 'root', kind: 'folder', name: 'Docs' }]],
      ['docs', [{ id: 'fa', parentId: 'docs', kind: 'file', name: 'a.txt', size: 3, version: 3, blobHash: null }]],
    ]);
    const calls = { lookups: [], lists: [], creates: [], uploads: [], hashes: [], events: [] };
    const add = (parentId, node) => {
      const key = parentId || 'root';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(node);
    };
    const find = (parentId, name) => (children.get(parentId || 'root') || [])
      .find((node) => node.kind === 'folder' && node.name === name) || null;
    return {
      children, calls,
      lookupFolder: async (parentId, name) => {
        calls.lookups.push((parentId || 'root') + '/' + name);
        return find(parentId, name);
      },
      listFiles: async (parentId) => {
        calls.lists.push(parentId || 'root');
        return children.get(parentId || 'root') || [];
      },
      createFolder: async (parentId, name) => {
        calls.creates.push((parentId || 'root') + '/' + name);
        calls.events.push('create');
        const node = { id: 'new:' + name, parentId, kind: 'folder', name };
        add(parentId, node);
        return node;
      },
      uploadFile: async (file, parentId, options) => {
        calls.uploads.push({ name: file.name, parentId, options });
        calls.events.push('upload');
      },
      hashFile: async (file) => {
        calls.hashes.push(file.name);
        calls.events.push('hash:' + file.name);
        return sha256(file);
      },
    };
  }

  async function changedBlobHash() {
    return sha256(new File(['old'], 'a.txt'));
  }

  it('cancels after hashing with zero directories or files created', async () => {
    const plan = await localPlan();
    const fake = cloud();
    fake.children.get('docs')[0].blobHash = await changedBlobHash();
    let questions = 0;
    const summary = await uploadPlan(plan, {
      parentId: 'root',
      lookupFolder: fake.lookupFolder,
      createFolder: fake.createFolder,
      uploadFile: fake.uploadFile,
      prepareFiles: (entries) => prepareFolderFiles(entries, {
        listFiles: fake.listFiles,
        hashFile: fake.hashFile,
        chooseConflict: async (count) => {
          questions += 1;
          fake.calls.events.push('ask');
          assert.equal(count, 1);
          // Every comparison is done and nothing has been mutated yet: the
          // dialog is the last read-only step before a decision.
          assert.deepEqual(fake.calls.creates, []);
          return null;
        },
      }),
    });
    assert.equal(questions, 1);
    assert.deepEqual(fake.calls.hashes, ['a.txt']);
    assert.equal(fake.calls.events.includes('create'), false);
    assert.deepEqual(fake.calls.creates, []);
    assert.deepEqual(fake.calls.uploads, []);
    assert.equal(summary.canceled, true);
    assert.equal(summary.folders, 0);
    assert.equal(summary.uploaded, 0);
    // Existing IDs were resolved read-only; children of a missing folder were
    // never looked up, and only the one real destination was listed.
    assert.deepEqual(fake.calls.lookups, ['root/Docs', 'docs/branch', 'docs/new-empty']);
    assert.deepEqual(fake.calls.lists, ['docs']);
  });

  it('creates missing folders only after confirmation and binds new files by path', async () => {
    const plan = await localPlan();
    const fake = cloud();
    fake.children.get('docs')[0].blobHash = await changedBlobHash();
    let pending = null;
    const summary = await uploadPlan(plan, {
      parentId: 'root',
      lookupFolder: fake.lookupFolder,
      createFolder: fake.createFolder,
      uploadFile: fake.uploadFile,
      prepareFiles: async (entries) => {
        pending = entries.map((entry) => ({
          name: entry.file.name, path: entry.path, parentId: entry.parentId,
          pendingDestination: entry.pendingDestination, blocked: entry.blocked,
        }));
        // Still read-only: the mkdirs happen after this returns.
        assert.deepEqual(fake.calls.creates, []);
        return prepareFolderFiles(entries, {
          listFiles: fake.listFiles,
          hashFile: fake.hashFile,
          chooseConflict: async () => 'overwrite',
        });
      },
    });
    assert.deepEqual(pending, [
      { name: 'a.txt', path: 'Docs', parentId: 'docs', pendingDestination: false, blocked: false },
      { name: 'c.txt', path: 'Docs/branch/nested', parentId: undefined, pendingDestination: true, blocked: false },
    ]);
    // The existing folder is reused, never recreated; the empty folder and the
    // nested branch materialise after the decision.
    assert.deepEqual(fake.calls.creates, [
      'docs/branch', 'docs/new-empty', 'new:branch/nested',
    ]);
    assert.equal(summary.folders, 3);
    assert.equal(summary.failedFolders, 0);
    assert.equal(summary.uploaded, 2);
    assert.equal(summary.total, 2);
    // The overwrite keeps the optimistic version guard from the live node.
    const overwrite = fake.calls.uploads.find((entry) => entry.name === 'a.txt');
    assert.equal(overwrite.parentId, 'docs');
    assert.equal(overwrite.options.expectedVersion, 3);
    assert.equal(overwrite.options.expectedNodeId, 'fa');
    assert.equal(overwrite.options.onConflict, 'overwrite');
    assert.equal(overwrite.options.hash, await sha256(new File(['new'], 'a.txt')));
    // The new nested file is bound to the folder that was actually created.
    const created = fake.calls.uploads.find((entry) => entry.name === 'c.txt');
    assert.equal(created.parentId, 'new:nested');
    assert.equal(created.options.expectedVersion, 0);
  });

  it('proceeds without asking when nothing conflicts and still creates empty new folders', async () => {
    const plan = planFromFileList([
      Object.assign(new File(['x'], 'x.txt'), { webkitRelativePath: 'New/x.txt' }),
    ]);
    plan.dirs.add('New/Empty');
    const fake = cloud();
    const summary = await uploadPlan(plan, {
      parentId: 'root',
      lookupFolder: fake.lookupFolder,
      createFolder: fake.createFolder,
      uploadFile: fake.uploadFile,
      prepareFiles: (entries) => prepareFolderFiles(entries, {
        listFiles: fake.listFiles,
        hashFile: fake.hashFile,
        chooseConflict: async () => { throw new Error('no conflict to confirm'); },
      }),
    });
    assert.deepEqual(fake.calls.lookups, ['root/New']);
    assert.deepEqual(fake.calls.creates, ['root/New', 'new:New/Empty']);
    assert.equal(fake.calls.uploads.length, 1);
    assert.equal(fake.calls.uploads[0].parentId, 'new:New');
    assert.equal(summary.folders, 2);
    assert.equal(summary.uploaded, 1);
  });

  it('issues no mutation when the read-only layout is cancelled', async () => {
    const plan = await localPlan();
    const fake = cloud();
    const controller = new AbortController();
    await assert.rejects(uploadPlan(plan, {
      parentId: 'root',
      signal: controller.signal,
      lookupFolder: async (parentId, name) => { controller.abort(); return fake.lookupFolder(parentId, name); },
      createFolder: fake.createFolder,
      uploadFile: fake.uploadFile,
      prepareFiles: async () => { throw new Error('must not compare after cancel'); },
    }), { name: 'AbortError' });
    assert.deepEqual(fake.calls.creates, []);
    assert.deepEqual(fake.calls.uploads, []);
  });

  it('issues no mutation when hashing is cancelled', async () => {
    const plan = await localPlan();
    const fake = cloud();
    fake.children.get('docs')[0].blobHash = await changedBlobHash();
    const controller = new AbortController();
    await assert.rejects(uploadPlan(plan, {
      parentId: 'root',
      signal: controller.signal,
      lookupFolder: fake.lookupFolder,
      createFolder: fake.createFolder,
      uploadFile: fake.uploadFile,
      prepareFiles: (entries) => prepareFolderFiles(entries, {
        listFiles: fake.listFiles,
        hashFile: async () => {
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
        chooseConflict: async () => { throw new Error('must not ask after cancel'); },
      }),
    }), { name: 'AbortError' });
    assert.deepEqual(fake.calls.creates, []);
    assert.deepEqual(fake.calls.uploads, []);
  });

  it('blocks files under a failed mkdir instead of falling back to the root', async () => {
    const plan = planFromFileList([
      Object.assign(nested(), { webkitRelativePath: 'Docs/branch/c.txt' }),
    ]);
    const fake = cloud();
    fake.createFolder = async (parentId, name) => {
      fake.calls.creates.push((parentId || 'root') + '/' + name);
      throw new Error('forbidden');
    };
    const summary = await uploadPlan(plan, {
      parentId: 'root',
      lookupFolder: fake.lookupFolder,
      createFolder: fake.createFolder,
      uploadFile: fake.uploadFile,
      prepareFiles: (entries) => prepareFolderFiles(entries, {
        listFiles: fake.listFiles,
        hashFile: fake.hashFile,
        chooseConflict: async () => 'overwrite',
      }),
    });
    assert.deepEqual(fake.calls.creates, ['docs/branch']);
    assert.deepEqual(fake.calls.uploads, []);
    assert.equal(summary.failedFolders, 1);
    assert.equal(summary.uploaded, 0);
  });
});
