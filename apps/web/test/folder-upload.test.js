import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planFromFileList, relativeSegments, uploadPlan } from '../lib/folder-upload.js'

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

  it('an empty folder still creates its directory', async () => {
    const result = await uploadPlan({ name: 'Empty', dirs: new Set(['', 'Empty']), files: [] }, {
      createFolder: async () => ({ id: 'n' }),
      uploadFile: async () => { throw new Error('should not upload'); },
    });
    assert.deepEqual(result, { folders: 1, failedFolders: 0, uploaded: 0, total: 0 });
  });
});
