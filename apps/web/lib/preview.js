/*
 * preview.js — right-hand drawer for one node.
 *
 * Binary content needs the bearer header, so images/PDF are fetched as Blobs
 * and shown through object URLs (revoked when the drawer closes). Text and
 * Markdown are decoded and rendered; .md goes through the escaped renderer in
 * format.js, everything else stays inside a <pre>.
 */

import { h, raw, mount } from './dom.js';
import { icon, kindIcon, fileKind, isMarkdown, isTextLike, bytes, formatDate, relativeTime, renderMarkdown, shortHash } from './format.js';
import { drawer, dialog, confirmDialog } from './ui.js';
import { fetchBlob, contentUrl, request, saveBlob } from './api.js';
import { isOfficeKind, loadOfficePreview } from './office-preview.js';
import { highlight, languageOf } from './highlight.js';

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024; // 2 MiB of text is plenty for a peek
const IMAGE_PREVIEW_LIMIT = 40 * 1024 * 1024;
const PDF_PREVIEW_LIMIT = 60 * 1024 * 1024;

export function openPreview(node, options) {
  const opts = options || {};
  const kind = node.kind === 'folder' ? 'folder' : fileKind(node.mime, node.name);
  const body = h('div', { class: 'preview-body centered' });
  const objectUrls = [];
  let disposed = false;
  // Advisory edit lock: taken while the drawer is open, released on close. It
  // never blocks a write — it tells the other tab that this one is looking.
  const lock = createEditLock(node);

  const handle = drawer({
    title: node.name,
    className: 'preview-drawer',
    headActions: h('button', {
      class: 'icon-btn',
      attrs: { type: 'button', 'aria-label': '下载文件', title: '下载' },
      html: icon('download', 15),
      on: { click: () => { if (opts.onDownload) opts.onDownload(node); } },
    }),
    body: h('div', {}, lock.banner, body),
    footer: [
      h('button', {
        class: 'btn', attrs: { type: 'button' },
        on: { click: () => { if (opts.onDownload) opts.onDownload(node); } },
      }, raw(icon('download', 14)), '下载'),
      h('button', {
        class: 'btn', attrs: { type: 'button' },
        on: { click: () => { if (opts.onShare) opts.onShare(node); } },
      }, raw(icon('share', 14)), '分享'),
      // Only files with history get the entry; for a v1 file the panel would be
      // an empty table pretending to be a feature.
      node.kind === 'file' && (node.version || 1) > 1
        ? h('button', {
          class: 'btn', attrs: { type: 'button' },
          on: { click: () => openVersionHistory(node, opts) },
        }, raw(icon('clock', 14)), '历史版本')
        : null,
      h('span', { class: 'push' }),
      h('button', {
        class: 'btn btn-ghost', attrs: { type: 'button' },
        on: { click: () => { if (opts.onDetails) opts.onDetails(node); } },
      }, raw(icon('info', 14)), '详情'),
    ],
    onClose: () => {
      disposed = true;
      lock.release();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.length = 0;
    },
  });

  const status = h('div', { class: 'empty', attrs: { 'aria-live': 'polite' } },
    h('span', { class: 'spinner' }),
    h('p', { text: '正在载入预览…' }),
  );
  body.replaceChildren(status);

  if (node.kind === 'folder') {
    body.classList.remove('centered');
    mount(body, folderPreview(node, opts));
    return handle;
  }

  const objectUrl = (blob) => {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  };

  if (kind === 'image' && node.size > IMAGE_PREVIEW_LIMIT) {
    mount(body, notice('图片过大，未在页面内渲染。', '使用下方"下载"按钮查看原图。', 'file-image'));
    return handle;
  }
  if (kind === 'audio' || kind === 'video') {
    body.classList.remove('centered');
    loadMedia(node, kind, body, objectUrl, disposed);
    return handle;
  }
  if (kind === 'pdf') {
    body.classList.remove('centered');
    body.style.padding = '0';
    loadPdf(node, body, objectUrl);
    return handle;
  }
  if (isTextLike(node.mime, node.name)) {
    loadText(node, body, kind === 'markdown' || isMarkdown(node.mime, node.name));
    return handle;
  }
  if (kind === 'image') {
    loadImage(node, body, objectUrl);
    return handle;
  }
  if (isOfficeKind(kind)) {
    body.classList.remove('centered');
    loadOfficePreview({ host: body, node, request, disposed: () => disposed });
    return handle;
  }
  mount(body, notice('此格式暂不支持在线预览。', '下载后使用本地应用打开。', kindIcon(kind, node.name)));
  return handle;
}

/**
 * Acquires (and releases) the advisory edit lock for a file.
 *
 * Two states are worth showing: "another tab is editing this" when the claim is
 * refused, and nothing at all in the normal case. The banner is the whole UI — a
 * lock that takes over a toolbar would be more intrusive than the problem it
 * solves.
 */
function createEditLock(node) {
  const banner = h('div', { class: 'lock-banner', attrs: { hidden: 'hidden', role: 'status', 'aria-live': 'polite' } });
  if (!node || node.kind !== 'file') return { banner, release() {} };

  const client = 'tab-' + Math.random().toString(36).slice(2, 10);
  let held = false;
  const show = (text, tone) => {
    banner.textContent = text;
    banner.className = 'lock-banner' + (tone ? ' is-' + tone : '');
    banner.removeAttribute('hidden');
  };

  request('/nodes/' + node.id + '/lock', { method: 'POST', body: { client } })
    .then((payload) => {
      held = true
      // A second window of the same user is never blocked, but it is worth a
      // sentence: two tabs editing one file is the case this lock exists for.
      if (payload && payload.supersededClient) {
        show('此文件的编辑锁刚从「' + payload.supersededClient + '」转到这里，那个窗口若继续保存会覆盖。', 'warn')
      }
    })
    .catch((error) => {
      // 409 carries the holder; 401/404 mean there is nothing to say.
      if (error && error.status === 409) {
        // The server puts the holder's client id in the message.
        const who = String((error && error.message) || '').replace(/ is editing this file\.$/, '');
        show((who || '另一个窗口') + ' 正在编辑此文件，保存可能互相覆盖。', 'warn');
        return;
      }
      if (error && error.status === 404) return;
    });

  return {
    banner,
    release() {
      if (!held) return;
      // Fire and forget: the TTL is the safety net if this never arrives.
      request('/nodes/' + node.id + '/lock', { method: 'DELETE' }).catch(() => {});
      held = false;
    },
  };
}

function notice(title, hint, iconName) {
  return h('div', { class: 'empty' },
    raw(icon(iconName || 'file', 30)),
    h('b', { text: title }),
    h('p', { text: hint }),
  );
}

async function loadImage(node, body, objectUrl) {
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    const img = h('img', { class: 'preview-media', attrs: { alt: node.name, src: objectUrl(blob) } });
    body.replaceChildren(img);
  } catch (error) {
    body.replaceChildren(notice('无法载入图片。', (error && error.message) || '请重试。', 'file-image'));
  }
}

async function loadPdf(node, body, objectUrl) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入 PDF…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    const frame = h('iframe', {
      class: 'preview-frame',
      attrs: { src: objectUrl(new Blob([blob], { type: 'application/pdf' })), title: 'PDF 预览：' + node.name },
    });
    body.replaceChildren(frame);
  } catch (error) {
    body.replaceChildren(notice('无法载入 PDF。', (error && error.message) || '请重试。', 'file-pdf'));
  }
}

async function loadMedia(node, kind, body, objectUrl, disposed) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入媒体…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    if (disposed) return;
    if (kind === 'video') {
      body.replaceChildren(h('video', { class: 'preview-media', attrs: { controls: 'controls', src: objectUrl(blob), playsinline: 'playsinline' } }));
    } else {
      body.replaceChildren(h('div', { class: 'stack', style: { gap: '12px', alignItems: 'center', padding: '24px' } },
        raw(icon('file-audio', 30)),
        h('audio', { attrs: { controls: 'controls', src: objectUrl(blob) } }),
      ));
    }
  } catch (error) {
    body.replaceChildren(notice('无法载入媒体。', (error && error.message) || '请重试。', 'file-audio'));
  }
}

/** Escapes a plain suffix so it can sit inside highlighted markup. */
function escapeSuffix(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function loadText(node, body, markdown) {
  body.classList.remove('centered');
  const status = h('div', { class: 'empty', style: { padding: '32px' } }, h('span', { class: 'spinner' }), h('p', { text: '正在载入文本…' }));
  body.replaceChildren(status);
  try {
    const blob = await fetchBlob(contentUrl(node.id));
    const truncated = blob.size > TEXT_PREVIEW_LIMIT;
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_LIMIT) : blob;
    const text = await slice.text();
    if (markdown) {
      const article = h('article', { class: 'preview-md' });
      article.innerHTML = renderMarkdown(text);
      for (const link of article.querySelectorAll('a')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
      body.replaceChildren(truncated
        ? h('div', {}, h('p', { class: 'dialog-note', style: { padding: '10px 18px 0' }, text: '文件较大，仅显示前 2 MiB。' }), article)
        : article);
    } else {
      // Code files get a light token pass; everything else stays a plain <pre>.
      // The highlighter escapes every token, so innerHTML is safe here.
      const language = languageOf(node.name);
      const suffix = truncated ? '\n\n……（已截断，仅显示前 2 MiB）' : '';
      if (language) {
        const pre = h('pre', { class: 'preview-text preview-code' });
        pre.innerHTML = highlight(text, language) + escapeSuffix(suffix);
        body.replaceChildren(pre);
      } else {
        body.replaceChildren(h('pre', { class: 'preview-text', text: text + suffix }));
      }
    }
  } catch (error) {
    body.replaceChildren(notice('无法载入文本。', (error && error.message) || '请重试。', 'file-text'));
  }
}


/**
 * Version history of one file.
 *
 * Each row can be downloaded (the old bytes, without touching the live file) or
 * restored (which appends a new version, so the restore itself is undoable).
 * Restore asks for confirmation because it is the destructive half.
 */
async function openVersionHistory(node, opts) {
  const body = h('div', { class: 'version-list', attrs: { 'aria-live': 'polite' } });
  const handle = drawer({
    title: '历史版本',
    sub: node.name,
    width: '480px',
    body,
    footer: [
      h('span', { class: 'push' }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => handle.close() } }),
    ],
  });
  body.replaceChildren(h('div', { class: 'empty', style: { padding: '28px' } },
    h('span', { class: 'spinner' }), h('p', { text: '正在载入历史…' })));

  let payload;
  try {
    payload = await request('/files/' + node.id + '/versions');
  } catch (error) {
    body.replaceChildren(h('div', { class: 'empty' },
      raw(icon('clock', 26)),
      h('b', { text: '无法载入历史版本' }),
      h('p', { text: (error && error.message) || '请重试。' }),
    ));
    return handle;
  }

  const versions = (payload && payload.versions) || [];
  body.replaceChildren();
  if (!versions.length) {
    body.replaceChildren(h('div', { class: 'empty' },
      raw(icon('clock', 26)),
      h('b', { text: '还没有历史版本' }),
      h('p', { text: '覆盖同名文件后会在这里留下旧内容。' }),
    ));
    return handle;
  }

  for (const entry of versions) {
    const row = h('div', { class: 'version-row' },
      h('span', { class: 'version-tag', text: 'v' + entry.version }),
      h('span', { class: 'version-meta' },
        h('b', { text: bytes(entry.size) }),
        h('small', { text: relativeTime(entry.createdAt) }),
      ),
      h('span', { class: 'push' }),
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button' },
        on: { click: () => downloadVersion(node, entry) },
      }, raw(icon('download', 12)), '下载'),
      h('button', {
        class: 'btn btn-sm', attrs: { type: 'button' },
        on: { click: () => restoreVersion(node, entry, handle, opts) },
      }, raw(icon('rotate-ccw', 12)), '恢复'),
    );
    body.appendChild(row);
  }
  return handle;
}

/** Saves the old bytes; the live file is untouched. */
async function downloadVersion(node, entry) {
  try {
    const blob = await fetchBlob('/files/' + node.id + '/versions/' + entry.id + '/content?download=1');
    // Keep the original name and mark the version, the same convention the
    // server uses in Content-Disposition.
    const dot = node.name.lastIndexOf('.');
    const filename = dot > 0
      ? node.name.slice(0, dot) + ' (v' + entry.version + ')' + node.name.slice(dot)
      : node.name + ' (v' + entry.version + ')';
    saveBlob(blob, filename);
    toast('已下载 v' + entry.version, { type: 'success', timeout: 2000 });
  } catch (error) {
    toast((error && error.message) || '下载失败。', { type: 'error' });
  }
}

/** Restores an old version; the current content becomes a version itself. */
async function restoreVersion(node, entry, drawerHandle, opts) {
  const yes = await confirmDialog({
    title: '恢复到 v' + entry.version,
    description: '当前内容会先保存为历史版本，然后换成 v' + entry.version + '。',
    confirmLabel: '恢复',
  });
  if (!yes) return;
  try {
    await request('/files/' + node.id + '/versions/' + entry.id + '/restore', {
      method: 'POST', body: { expectedVersion: node.version },
    });
    toast('已恢复到 v' + entry.version, { type: 'success' });
    drawerHandle.close();
    if (opts && opts.onChanged) opts.onChanged();
  } catch (error) {
    toast((error && error.message) || '恢复失败。', { type: 'error' });
  }
}

function folderPreview(node, opts) {
  return h('div', { class: 'preview-meta' },
    h('dt', { text: '类型' }), h('dd', { text: '文件夹' }),
    h('dt', { text: '名称' }), h('dd', { text: node.name }),
    h('dt', { text: '创建时间' }), h('dd', { text: formatDate(node.createdAt) }),
    h('dt', { text: '更新时间' }), h('dd', { text: relativeTime(node.updatedAt) }),
    h('dt', { text: '星标' }), h('dd', { text: node.starred ? '已加星标' : '未加星标' }),
  );
}

/** Metadata dialog shared by the preview footer and the row menu. */
export function showDetails(node, options) {
  const opts = options || {};
  const rows = [
    ['名称', node.name],
    ['类型', node.kind === 'folder' ? '文件夹' : (node.mime || '未知')],
    ['大小', node.kind === 'folder' ? '—' : bytes(node.size)],
    ['版本', 'v' + (node.version || 1)],
    ['创建时间', formatDate(node.createdAt)],
    ['更新时间', formatDate(node.updatedAt)],
    ['内容哈希', node.blobHash ? shortHash(node.blobHash) : '—'],
  ];
  const body = h('dl', { class: 'preview-meta' });
  for (const [label, value] of rows) {
    body.appendChild(h('dt', { text: label }));
    body.appendChild(h('dd', { attrs: { title: String(value) }, text: String(value) }));
  }
  return dialog({
    title: '文件详情',
    description: node.name,
    body,
    footer: (dlg) => [
      h('span', { class: 'push' }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => dlg.close() } }),
    ],
    onClose: opts.onClose,
  });
}