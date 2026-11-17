import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canPreviewShared,
  shareArchiveUrl,
  shareCapabilities,
  shareChildrenUrl,
  shareContentUrl,
  shareEntryMeta,
  shareFileUrl,
  shareOfficeUrl,
  sharePreviewUrl,
} from '../lib/share.js';

/**
 * The public page's capability contract.
 *
 * Two things used to be wrong here and neither was visible in a unit test of
 * the page itself: every preview asked /content (so a default "viewer" link was
 * a dead end), and the page painted a download button for a permission that
 * cannot download. Both are decisions the module now owns, so both are testable
 * without a browser.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const shareSource = readFileSync(join(webRoot, 'lib/share.js'), 'utf8');

describe('public share URLs', () => {
  it('points previews at /preview, never at /content', () => {
    assert.equal(sharePreviewUrl('abc123'), '/shared/abc123/preview');
    assert.match(sharePreviewUrl('abc123'), /\/preview$/);
  });

  it('carries the password through every route', () => {
    assert.equal(sharePreviewUrl('t', 'open sesame'), '/shared/t/preview?password=open+sesame');
    assert.equal(shareContentUrl('t', 'open sesame'), '/shared/t/content?password=open+sesame');
    assert.equal(shareArchiveUrl('t', 'open sesame'), '/shared/t/archive?password=open+sesame');
    assert.equal(shareOfficeUrl('t', 'open sesame', 'node-1'), '/shared/t/office/node-1?password=open+sesame');
    assert.equal(
      shareFileUrl('t', 'node-1', 'open sesame', false),
      '/shared/t/file/node-1?password=open+sesame&inline=1',
    );
  });

  it('omits an empty password instead of sending password=', () => {
    assert.equal(shareContentUrl('t', ''), '/shared/t/content');
    assert.equal(shareChildrenUrl('t', '', null), '/shared/t/children');
    assert.equal(shareChildrenUrl('t', null, 'folder-1'), '/shared/t/children?parentId=folder-1');
  });

  it('marks a preview of a folder child inline, and a download as an attachment', () => {
    assert.match(shareFileUrl('t', 'n', '', false), /inline=1$/);
    assert.ok(!/inline/.test(shareFileUrl('t', 'n', '', true)), 'a download must not ask for an inline body');
  });

  it('encodes the token and the node id', () => {
    assert.equal(sharePreviewUrl('a/b'), '/shared/a%2Fb/preview');
    assert.equal(shareFileUrl('t', 'a/b', '', false), '/shared/t/file/a%2Fb?inline=1');
  });
});

describe('share capabilities', () => {
  it('gives the downloader both file and folder downloads', () => {
    assert.deepEqual(shareCapabilities('downloader'), { download: true, downloadAll: true });
  });

  it('gives a viewer neither, but still lets it read bytes inline', () => {
    assert.deepEqual(shareCapabilities('viewer'), { download: false, downloadAll: false });
    // Unknown values fall back to the safest reading, the same default the API uses.
    assert.deepEqual(shareCapabilities(undefined), { download: false, downloadAll: false });
  });
});

describe('folder entry rows', () => {
  it('shows a folder as a folder, not as zero bytes', () => {
    assert.equal(shareEntryMeta({ kind: 'folder', name: 'album', size: 0 }), '文件夹');
  });

  it('shows size and modification time for a file', () => {
    const meta = shareEntryMeta({ kind: 'file', name: 'a.png', size: 2048, updatedAt: '2026-11-15T03:40:00.000Z' });
    assert.match(meta, /^2\.0 KB · /);
    assert.ok(!/Invalid/.test(meta), meta);
  });

  it('survives a missing timestamp', () => {
    assert.equal(shareEntryMeta({ kind: 'file', name: 'a.png', size: 0 }), '0 B');
    assert.equal(shareEntryMeta(null), '');
  });
});

describe('previewable formats', () => {
  it('previews images, pdfs and text-like files', () => {
    assert.equal(canPreviewShared('image/png', 'a.png'), true);
    assert.equal(canPreviewShared('application/pdf', 'a.pdf'), true);
    assert.equal(canPreviewShared('text/markdown', 'a.md'), true);
    assert.equal(canPreviewShared('text/plain', 'a.log'), true);
    assert.equal(canPreviewShared('application/octet-stream', 'a.py'), true);
  });

  it('previews browser media and supported Office documents', () => {
    assert.equal(canPreviewShared('video/mp4', 'a.mp4'), true);
    assert.equal(canPreviewShared('audio/mpeg', 'a.mp3'), true);
    assert.equal(canPreviewShared('application/octet-stream', '报告.docx'), true);
    assert.equal(canPreviewShared('application/octet-stream', '演示.pptx'), true);
    assert.equal(canPreviewShared('application/octet-stream', '表格.xlsx'), true);
  });

  it('refuses binary, legacy Office and images the browser cannot decode', () => {
    assert.equal(canPreviewShared('application/zip', 'a.zip'), false);
    assert.equal(canPreviewShared('application/msword', 'a.doc'), false);
    assert.equal(canPreviewShared('application/octet-stream', 'a.odt'), false);
    assert.equal(canPreviewShared('image/heic', 'a.heic'), false);
    assert.equal(canPreviewShared('image/tiff', 'a.tif'), false);
  });
});

describe('public page wiring', () => {
  it('sends every preview through the preview route', () => {
    // The single '/content' string left belongs to the download URL builder; a
    // second one would be a preview that a viewer link cannot open.
    const literals = [...shareSource.matchAll(/'\/content'/g)].length;
    assert.equal(literals, 1, 'only shareContentUrl may build a /content URL');
    assert.match(shareSource, /export function shareContentUrl/);
    assert.match(shareSource, /export function sharePreviewUrl/);
  });

  it('renders the download button behind the capability check', () => {
    assert.match(shareSource, /if \(caps\.download\) \{/, 'a viewer must not be painted a download button');
    assert.match(shareSource, /if \(caps\.downloadAll\) \{/);
  });

  it('asks for folder children instead of inventing entries', () => {
    assert.match(shareSource, /shareChildrenUrl\(token, state\.password, parentId\)/);
    assert.match(shareSource, /shareArchiveUrl\(token, state\.password\)/);
  });
});
