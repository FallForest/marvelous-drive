/*
 * share.js — share dialog (create / list / revoke) and the public /s/<token>
 * page.
 *
 * Creation posts the contract shape {permission,expiresInDays,password,
 * maxDownloads}; the returned share.url is same-origin, so it is normalised to
 * an absolute URL before it is shown or copied.
 *
 * The public page owns a download center of its own (one per visit, destroyed
 * with the card): a recipient's tasks are private to the link they opened and
 * never join the signed-in drive's list. Which transport a download uses is a
 * policy of this page, not of the center: a small, pre-known file is assembled
 * in memory and saved as one Blob; a large, unknown or ZIP download is streamed
 * into a file the visitor picks, because saving it in memory first would cost
 * its size in RAM. A browser without the picker keeps the plain anchor.
 */

import { h, raw, mount } from './dom.js';
import { icon, fileKind, bytes, expiryLabel, kindIcon, formatDate, extension } from './format.js';
import { dialog, drawer, toast, copyText, withBusy, confirmDialog } from './ui.js';
import { renderSelect } from './select.js';
import { api, request, fetchBlob, saveDownloadStream, sharedInfoUrl } from './api.js';
import { renderOffice } from './office-preview.js';
import { createDownloadCenter } from './downloads.js';
import { openShareEditor, shareAbsoluteUrl, shareAvailability, shareSettingsLine } from './share-edit.js';

/**
 * The absolute public URL of a share.
 *
 * Same rule as everywhere else: a relative `/s/<token>` is completed against this
 * origin, because the clipboard must receive something a recipient can paste
 * into a browser. Delegated to share-edit.js so every surface agrees.
 */
const absoluteShareUrl = shareAbsoluteUrl;

/* ── public URLs and capability model ─────────────────────────── */
/*
 * Every public route is a function of (token, password): the password is what
 * unlocks the link, so it has to ride along on each follow-up request. Building
 * the URLs in one place keeps a viewer from silently losing the password when
 * it opens the second file of a folder.
 */
function publicQuery(password, extra) {
  const query = new URLSearchParams();
  if (password) query.set('password', password);
  const fields = extra || {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? '?' + text : '';
}

/** Inline bytes of the shared file itself; both permissions may read it. */
export function sharePreviewUrl(token, password) {
  return '/shared/' + encodeURIComponent(token) + '/preview' + publicQuery(password);
}

/** Attachment of the shared file; the server rejects a viewer link. */
export function shareContentUrl(token, password) {
  return '/shared/' + encodeURIComponent(token) + '/content' + publicQuery(password);
}

/** Direct children of a folder share; parentId defaults to the shared folder. */
export function shareChildrenUrl(token, password, parentId) {
  return '/shared/' + encodeURIComponent(token) + '/children' + publicQuery(password, parentId ? { parentId } : null);
}

/** One file inside a folder share, inline (preview) or as an attachment. */
export function shareFileUrl(token, nodeId, password, download) {
  const path = '/shared/' + encodeURIComponent(token) + '/file/' + encodeURIComponent(nodeId);
  return path + publicQuery(password, download ? null : { inline: 1 });
}

/** The folder share as one ZIP; downloader only. */
export function shareArchiveUrl(token, password) {
  return '/shared/' + encodeURIComponent(token) + '/archive' + publicQuery(password);
}

/** Extracted Office content, gated by the same token/password and subtree. */
export function shareOfficeUrl(token, password, nodeId) {
  return '/shared/' + encodeURIComponent(token) + '/office' + (nodeId ? '/' + encodeURIComponent(nodeId) : '') + publicQuery(password);
}

/**
 * What a link may offer, derived from its permission.
 *
 * The server is the authority (it 403s /content and /archive for a viewer); this
 * copy exists so the page does not paint a button that can only fail.
 */
export function shareCapabilities(permission) {
  const downloader = permission === 'downloader';
  return { download: downloader, downloadAll: downloader };
}

/* ── public download transport ────────────────────────────────── */
/*
 * Two routes, one rule: never promise a download the page cannot finish.
 *
 * A small, pre-known file is fetched into a Blob and handed to the browser,
 * because that is a single atomic save and the visitor sees the whole task in
 * the page. Anything larger, anything whose size the page does not know, and
 * every folder ZIP is streamed straight into a file the visitor picks: an
 * archive can be several GiB, and assembling it in memory first would cost its
 * size in RAM (and, on iOS, fail outright). A browser without the picker keeps
 * the plain attachment link — the browser streams to disk itself.
 */

/**
 * The id of the panel the public page's center mounts.
 *
 * The entry's `aria-controls` and the panel's id have to agree, and the id is
 * also what tells this page's center from the signed-in drive's.
 */
const SHARE_DOWNLOAD_PANEL_ID = 'share-downloads-panel';

/**
 * Above this size a public file is streamed to disk instead of held in memory.
 *
 * Fixed on purpose: the cap is about what the page can promise, not about the
 * device. A phone is not given a different threshold from a desktop — the
 * desktop Blob route is not scaled up just because the machine has the RAM.
 */
const PUBLIC_BLOB_LIMIT = 64 * 1024 * 1024;

/**
 * Whether this browser can stream a response into a file the visitor chooses.
 *
 * Both halves matter: the File System Access API is Chromium-only, and the
 * picker is refused outside a secure context — where the method can exist and
 * every call still throw.
 */
function canPickSaveFile() {
  return typeof window !== 'undefined'
    && typeof window.showSaveFilePicker === 'function'
    && window.isSecureContext === true;
}

/**
 * A save-file picker bound to one download control.
 *
 * The picker only opens while the page still holds the click's user activation,
 * and the first `await` spends it. So the promise is opened by the click itself
 * (`begin()`), and the download task consumes *that* dialog through `pick()`
 * instead of opening a second one behind it.
 *
 * A retry then behaves honestly: after a cancel there is no handle, so `pick()`
 * asks once more (a cancel is an answer, not a permanent one); after a network
 * failure the handle is reused, so the bytes are rewritten into the same file
 * rather than prompting the visitor again.
 */
function saveFilePicker(suggestedName) {
  let handle = null;
  /** The dialog the click opened, until a transfer consumes it. */
  let fromClick = null;
  /** An in-flight picker promise (either the click's or a retry's). */
  let pending = null;

  const open = () => {
    if (handle) return Promise.resolve(handle);
    if (!pending) {
      let promise;
      try {
        promise = window.showSaveFilePicker({ suggestedName: String(suggestedName || 'download') });
      } catch (error) {
        // Outside a user gesture the API may throw instead of rejecting;
        // the caller still has to see an AbortError-shaped cancel, not a crash.
        promise = Promise.reject(error);
      }
      pending = promise;
      const settle = () => { if (pending === promise) pending = null; };
      // Handled from the moment it exists: a picker closed before the task is
      // ready to await it must not surface as an unhandled rejection.
      promise.then((picked) => { handle = picked; settle(); }, settle);
    }
    return pending;
  };

  return {
    /** Called from the click, synchronously: this is what keeps the gesture. */
    begin() {
      fromClick = open();
      return fromClick;
    },
    /** Called by the transfer: consumes the click's dialog exactly once. */
    pick() {
      if (fromClick) {
        const promise = fromClick;
        fromClick = null;
        return promise;
      }
      return open();
    },
  };
}

/** Second line of a folder row: a folder is a folder, a file is size + date. */
export function shareEntryMeta(entry) {
  if (!entry) return '';
  if (entry.kind === 'folder') return '文件夹';
  const when = formatDate(entry.updatedAt);
  return when ? bytes(entry.size) + ' · ' + when : bytes(entry.size);
}

/**
 * File kinds the public page can render without a download.
 *
 * Anything else (an archive or a legacy Office file) gets a "download to open"
 * note instead of a broken frame, and the download button is the only action.
 */
const PREVIEWABLE = new Set(['image', 'pdf', 'markdown', 'text', 'code', 'audio', 'video']);
const OFFICE_EXTENSIONS = new Set(['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm']);
const UNSUPPORTED_IMAGES = new Set(['heic', 'heif', 'tif', 'tiff', 'psd', 'jxl']);

/** True when the public page has a renderer for this file. */
export function canPreviewShared(mime, name) {
  if (UNSUPPORTED_IMAGES.has(extension(name))) return false;
  if (OFFICE_EXTENSIONS.has(extension(name))) return true;
  return PREVIEWABLE.has(fileKind(mime, name));
}

/** The subtitle of the reader: what the visitor is looking at, in one word. */
const READER_LABELS = {
  pdf: 'PDF 文档', image: '图片', video: '视频', audio: '音频',
  markdown: 'Markdown', text: '文本', code: '代码',
  slides: '幻灯片', doc: '文档', sheet: '工作表',
};

function readerLabel(kind, name) {
  if (OFFICE_EXTENSIONS.has(extension(name))) return 'Office 文档';
  return READER_LABELS[kind] || '文件';
}

/**
 * The plain-language sentence shown before a link is created.
 *
 * Anyone holding the link — not just the recipient the owner has in mind — can
 * open it, and the password is an extra condition, not a way to pick people.
 * The viewer half deliberately says "no download button" rather than "cannot be
 * downloaded": the page does not paint one, but the bytes still reach the
 * browser, and claiming otherwise would be a promise the server cannot keep.
 *
 * `downloader` only swaps the first clause: the password and trust sentences are
 * the same fact about the link either way, and repeating them in a second note
 * below would read as two different warnings.
 */
function shareAudienceNote(downloader) {
  return (downloader
    ? '拿到链接的人都能访问：可以打开、在线查看并下载这个文件；'
    : '拿到链接的人都能访问：可以打开并在线查看这个文件；')
    + '如果设置了密码，还需要输入密码。仅查看的链接不会显示下载按钮。请只分享给你信任的人。';
}

/**
 * The note as it reads before a permission has been picked.
 *
 * One sentence, two jobs: it says who gets in (whoever holds the link) and it
 * says what the password is (a second lock, not a shortlist of people). It is
 * the copy the product promises about a link, so it is written once here and
 * rewritten in place when the permission changes.
 */
const SHARE_AUDIENCE_NOTE = shareAudienceNote(false);

/** Open the share dialog for one node. options: { onChanged } */
export function openShareDialog(node, options) {
  const opts = options || {};
  const listHost = h('div', { class: 'share-list', attrs: { 'aria-live': 'polite' } }, h('p', { class: 'dialog-note', text: '正在载入已有链接…' }));

  const audienceNote = h('p', { class: 'share-audience', text: SHARE_AUDIENCE_NOTE });
  const permission = renderSelect({
    id: 'share-permission',
    label: '权限',
    value: 'viewer',
    options: [
      { value: 'viewer', label: '仅查看（在线预览）' },
      { value: 'downloader', label: '可下载' },
    ],
    // Fires from the menu, i.e. only after the dialog is mounted.
    onChange: () => applyPermission(),
  });
  const expiry = renderSelect({
    id: 'share-expiry',
    label: '有效期',
    value: '7',
    options: [
      { value: '', label: '永不过期' },
      { value: '1', label: '1 天' },
      { value: '7', label: '7 天' },
      { value: '30', label: '30 天' },
    ],
  });
  const password = h('input', { class: 'input', attrs: { id: 'share-password', type: 'password', autocomplete: 'new-password', placeholder: '留空则不设密码', maxlength: '200' } });
  const maxDownloads = h('input', { class: 'input', attrs: { id: 'share-max', type: 'number', min: '1', step: '1', placeholder: '留空则不限', disabled: 'disabled' } });
  const maxField = h('div', { class: 'field', attrs: { hidden: 'hidden' } }, h('label', { attrs: { for: 'share-max' }, text: '下载上限' }), maxDownloads);
  const formError = h('div', { class: 'field-error', attrs: { role: 'alert', hidden: 'hidden' } });
  const createBtn = h('button', { class: 'btn btn-primary', attrs: { type: 'submit' } }, raw(icon('link', 14)), '创建链接');

  const applyPermission = () => {
    const downloader = permission.value === 'downloader';
    // One note, rewritten in place: the audience is the same fact whichever
    // permission is picked, only what the recipient can do changes.
    audienceNote.textContent = shareAudienceNote(downloader);
    if (downloader) maxField.removeAttribute('hidden');
    else maxField.setAttribute('hidden', 'hidden');
    maxDownloads.disabled = !downloader;
  };

  const form = h('form', { class: 'stack', attrs: { style: 'gap:10px' } },
    formError,
    // Said before the controls, in the owner's own terms: who gets access and
    // what the password does and does not do.
    audienceNote,
    h('div', { class: 'inline-fields' },
      h('div', { class: 'field' }, h('label', { attrs: { for: 'share-permission' }, text: '权限' }), permission),
      h('div', { class: 'field' }, h('label', { attrs: { for: 'share-expiry' }, text: '有效期' }), expiry),
    ),
    h('details', {},
      h('summary', { text: '高级设置' }),
      h('div', { class: 'inline-fields' },
        h('div', { class: 'field' }, h('label', { attrs: { for: 'share-password' }, text: '访问密码' }), password),
        maxField,
      ),
    ),
    h('div', { class: 'row', attrs: { style: 'justify-content:flex-end' } }, createBtn),
  );

  const handle = dialog({
    title: '分享链接',
    description: node.name,
    wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'section-title', text: '已有链接' }),
      listHost,
      h('hr', { class: 'divider' }),
      h('div', { class: 'section-title', text: '创建链接' }),
      form,
    ),
    footer: (dlg) => [
      h('span', { class: 'push' }),
      h('button', { class: 'btn btn-ghost', attrs: { type: 'button' }, text: '完成', on: { click: () => dlg.close() } }),
    ],
  });
  handle.el.classList.add('share-owner-dialog');

  const createdLink = h('div', { class: 'stack', attrs: { 'aria-live': 'polite' } });
  /** Id of the share whose link is currently shown in createdLink, if any. */
  let lastCreatedShareId = null;
  handle.body.appendChild(createdLink);

  const refreshList = async () => {
    try {
      const payload = await api.get('/nodes/' + node.id + '/shares');
      const shares = payload && Array.isArray(payload.shares) ? payload.shares : [];
      renderShares(shares);
    } catch (error) {
      mount(listHost, h('p', { class: 'dialog-note', text: (error && error.message) || '无法载入已有链接。' }));
    }
  };

  /**
   * One existing link in the file's share dialog.
   *
   * Same verbs as a 我分享的 row — 编辑 / 复制 / 撤销 — so the owner does not have
   * to leave the file to change a setting. 编辑 opens the shared editor from
   * lib/share-edit.js; its result replaces this one row in place, so the list
   * shows the server's answer without a full re-read and without ever showing a
   * URL that was not just confirmed.
   */
  const shareItem = (share) => {
    const availability = shareAvailability(share);
    const body = h('div', { class: 'si-main' });
    const actions = h('div', { class: 'share-item-actions' });

    /** Repaints one row from a row the server just returned. */
    const paint = (row) => {
      const url = absoluteShareUrl(row);
      const state = shareAvailability(row);
      mount(body,
        h('code', { attrs: { title: url }, text: url || '（此链接没有可用地址）' }),
        h('small', {
          class: 'share-item-meta',
          text: state.label + ' · ' + shareSettingsLine(row),
        }),
      );
      mount(actions,
        h('button', {
          class: 'icon-btn', attrs: { type: 'button', 'aria-label': '编辑链接设置', title: '编辑链接设置' },
          html: icon('pencil', 13),
          on: { click: () => openShareEditor(row, {
            // The row is repainted from the server's answer, and the caller's own
            // refresh runs so a surface outside this dialog (我分享的) stays in
            // step without waiting for the visitor to come back to it.
            onSaved: (updated) => {
              paint(updated);
              // The standalone "链接已创建" block repeats the same URL. After an
              // edit it can also be stale — the edit may have expired, capped or
              // trashed a link it still invites the owner to copy. Clearing it
              // for this id leaves the edited row above as the one place to read
              // the link, so nothing offers a copy the save just invalidated.
              if (lastCreatedShareId != null && updated.id === lastCreatedShareId) {
                lastCreatedShareId = null;
                createdLink.replaceChildren();
              }
              if (opts.onChanged) opts.onChanged();
            },
            onMissing: refreshList,
          }) },
        }),
        h('button', {
          class: 'icon-btn',
          attrs: {
            type: 'button', 'aria-label': '复制链接',
            title: state.usable ? '复制链接' : '链接' + state.label + '，不能复制',
            ...(state.usable ? {} : { disabled: 'disabled' }),
          },
          html: icon('copy', 13),
          on: {
            click: async () => {
              // Re-check at click time: a link may have expired while the list sat open.
              if (!shareAvailability(row).usable || !url) return;
              const ok = await copyText(url);
              toast(ok ? '链接已复制到剪贴板。' : '复制失败，请手动选择链接。', { type: ok ? 'success' : 'error' });
            },
          },
        }),
        h('button', {
          class: 'icon-btn', attrs: { type: 'button', 'aria-label': '撤销链接', title: '撤销链接' }, html: icon('trash', 13),
          on: {
            click: async () => {
              const yes = await confirmDialog({
                title: '撤销分享链接',
                description: '撤销后该链接立即失效，访问者会看到 404。',
                confirmLabel: '撤销',
                danger: true,
              });
              if (!yes) return;
              try {
                await api.del('/shares/' + encodeURIComponent(row.id));
                // The readonly input and its fallback copy would otherwise offer
                // a link that no longer resolves.
                if (lastCreatedShareId != null && row.id === lastCreatedShareId) {
                  lastCreatedShareId = null;
                  createdLink.replaceChildren();
                }
                toast('分享链接已撤销。', { type: 'success' });
                refreshList();
                if (opts.onChanged) opts.onChanged();
              } catch (error) {
                toast((error && error.message) || '撤销失败。', { type: 'error' });
              }
            },
          },
        }),
      );
    };

    paint(share);
    return h('div', { class: 'share-item', dataset: { id: String(share.id) } }, body, actions);
  };

  const renderShares = (shares) => {
    if (!shares.length) {
      mount(listHost, h('p', { class: 'dialog-note', text: '还没有分享链接。填写下方的选项即可创建第一个。' }));
      return;
    }
    const list = h('div', { class: 'stack', attrs: { style: 'gap:8px' } });
    for (const share of shares) list.appendChild(shareItem(share));
    mount(listHost, list);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (createBtn.disabled) return;
    formError.setAttribute('hidden', 'hidden');
    // The selects expose their value through a property, not `.value`: they are
    // buttons over the app's own menu, not native form controls.
    const body = {
      permission: permission.value,
      expiresInDays: expiry.value ? Number(expiry.value) : undefined,
      password: password.value ? password.value : undefined,
      maxDownloads: permission.value === 'downloader' && maxDownloads.value ? Number(maxDownloads.value) : undefined,
    };
    if (body.maxDownloads !== undefined && (!Number.isInteger(body.maxDownloads) || body.maxDownloads < 1)) {
      formError.textContent = '下载上限需要是大于 0 的整数。';
      formError.removeAttribute('hidden');
      maxDownloads.focus();
      return;
    }
    withBusy(createBtn, true);
    try {
      const payload = await api.post('/nodes/' + node.id + '/share', body);
      const share = payload && payload.share;
      if (share) {
        const url = absoluteShareUrl(share);
        const linkInput = h('input', {
          class: 'input',
          attrs: { readonly: 'readonly', value: url, 'aria-label': '分享链接', spellcheck: 'false' },
        });
        const copyBtn = h('button', {
          class: 'btn btn-sm', attrs: { type: 'button' }, text: '复制链接',
          on: {
            click: async () => {
              const copied = await copyText(url);
              if (copied) {
                toast('链接已复制到剪贴板。', { type: 'success', timeout: 2600 });
              } else {
                linkInput.focus();
                if (typeof linkInput.select === 'function') linkInput.select();
                toast('复制失败，链接已选中，请按 Ctrl+C 手动复制。', { type: 'error', timeout: 4200, detail: url });
              }
            },
          },
        });
        mount(createdLink,
          h('div', { class: 'section-title', text: '链接已创建' }),
          h('div', { class: 'share-link-row' }, linkInput, copyBtn),
        );
        lastCreatedShareId = share.id != null ? share.id : null;
        const ok = await copyText(url);
        toast(ok ? '链接已创建并复制。' : '链接已创建。', {
          type: 'success', title: '分享链接', timeout: 4200,
          detail: url,
        });
      }
      password.value = '';
      maxDownloads.value = '';
      await refreshList();
      if (opts.onChanged) opts.onChanged();
    } catch (error) {
      formError.textContent = (error && error.message) || '创建链接失败。';
      formError.removeAttribute('hidden');
    } finally {
      withBusy(createBtn, false);
    }
  });

  refreshList();
  return handle;
}

/* ── public page ──────────────────────────────────────────────── */
/**
 * renderShared(root, token, ctx) — SPA route /s/<token>.
 * States: loading, locked (401 SHARE_LOCKED), ready, missing (404), error.
 */
export function renderShared(root, token, ctx) {
  const state = { password: '' };
  /** The one open reading surface, if any; see openReader(). */
  let reader = null;
  let destroyed = false;
  /**
   * This visit's download center.
   *
   * Private to the link: it is created with the page and destroyed with it, so
   * a task from one share can never appear on another, and a signed-in visitor
   * leaving the link does not carry a recipient's download list into the drive.
   */
  let center = null;
  let entryMounted = false;
  const wrap = h('div', { class: 'public-wrap' });
  // The public page is a page root: it enters once through the shared class, so
  // a reduced-motion user gets a cross-fade instead of travel.
  const card = h('div', { class: 'public-card motion-sheet', attrs: { 'aria-live': 'polite' } });
  wrap.appendChild(card);
  root.replaceChildren(wrap);
  document.title = '分享链接 · Marvelous Drive';

  /** The header's stable slot: the download entry mounts here, once, in place. */
  const headerTools = h('span', { class: 'public-head-tools' });

  const header = () => h('div', { class: 'public-head' },
    h('span', { class: 'brand-mark', html: icon('harddrive', 14) }),
    h('span', { text: 'Marvelous Drive' }),
    h('span', { class: 'push' }),
    // The same slot in every header, so a repaint (loading → ready) cannot
    // orphan the entry or move the keyboard user's focus.
    headerTools,
    h('button', {
      class: 'btn-link', attrs: { type: 'button' }, text: '打开我的云盘',
      on: { click: () => { if (ctx && ctx.onHome) ctx.onHome(); } },
    }),
  );

  /** The center for this visit, created on first use (never shared across links). */
  const downloadCenter = () => {
    if (!center) center = createDownloadCenter({ panelId: SHARE_DOWNLOAD_PANEL_ID });
    return center;
  };

  /**
   * Mounts the page's single download entry above the card, once.
   *
   * The entry is the panel's way back in: it stays available for the whole
   * visit, reopens a panel the visitor closed, and is only painted for a link
   * that can download. There is no entry for a locked or unavailable link, and
   * none on a viewer link — a control that can only 403 is not an entry.
   */
  const mountDownloadEntry = () => {
    if (entryMounted || destroyed) return;
    entryMounted = true;
    const entry = downloadCenter().entry();
    entry.classList.add('public-dl-entry');
    entry.setAttribute('aria-controls', SHARE_DOWNLOAD_PANEL_ID);
    headerTools.appendChild(entry);
  };

  const loading = () => {
    mount(card, header(), h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在读取分享内容…' })));
  };

  const missing = (message, hint) => {
    // A slow metadata answer must not repaint, or retitle, a page the visitor
    // has already navigated away from.
    if (!wrap.isConnected) return;
    mount(card,
      header(),
      h('div', { class: 'empty' },
        raw(icon('link', 30)),
        h('b', { text: message || '链接不存在或已失效' }),
        h('p', { text: hint || '请向分享者确认链接是否已被撤销、过期或达到下载上限。' }),
      ),
    );
    document.title = '链接不可用 · Marvelous Drive';
  };

  const locked = (share) => {
    if (!wrap.isConnected) return;
    const input = h('input', { class: 'input', attrs: { type: 'password', placeholder: '输入访问密码', autocomplete: 'off', 'aria-label': '访问密码' } });
    const error = h('div', { class: 'field-error', attrs: { role: 'alert', hidden: 'hidden' } });
    const button = h('button', { class: 'btn btn-primary btn-block', attrs: { type: 'submit' } }, raw(icon('lock', 14)), '解锁');
    const form = h('form', {
      class: 'stack', attrs: { style: 'gap:10px' },
      on: {
        submit: async (event) => {
          event.preventDefault();
          const value = input.value;
          if (!value) { input.focus(); return; }
          withBusy(button, true);
          error.setAttribute('hidden', 'hidden');
          try {
            const payload = await request(sharedInfoUrl(token) + '?password=' + encodeURIComponent(value), { auth: false });
            state.password = value;
            ready(payload.share);
          } catch (err) {
            const message = err && err.code === 'SHARE_LOCKED' ? '密码不正确，请重试。' : (err && err.message) || '解锁失败。';
            error.textContent = message;
            error.removeAttribute('hidden');
            input.select();
          } finally {
            withBusy(button, false);
          }
        },
      },
    },
      error,
      h('div', { class: 'field' }, h('label', { text: '访问密码' }), input),
      button,
    );
    mount(card,
      header(),
      h('div', { class: 'public-file' },
        h('span', { class: 'picon', html: icon('lock', 18) }),
        h('div', { class: 'stack', attrs: { style: 'gap:2px;min-width:0' } },
          h('b', { text: share && share.node ? share.node.name : '受保护的分享' }),
          h('small', { text: '该链接需要密码才能访问' }),
        ),
      ),
      form,
      h('p', { class: 'public-note', text: '密码由分享者设置，仅用于本次访问。' }),
    );
    requestAnimationFrame(() => input.focus());
  };

  const copyLinkButton = () => h('button', {
    class: 'btn',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        const ok = await copyText(window.location.href);
        toast(ok ? '链接已复制。' : '复制失败，请手动复制地址栏。', { type: ok ? 'success' : 'error' });
      },
    },
  }, raw(icon('link', 14)), '复制本页链接');

  /**
   * One download control: a real anchor that keeps its local href and `download`
   * attribute, and a managed task when the visitor clicks it plainly.
   *
   * The anchor is the fallback, not a decoration. A modified click, a middle
   * click or a context-menu "save as" is the visitor asking the BROWSER to do
   * the transfer, so it is left alone; the same is true when this browser has
   * no picker for a download the page must stream, in which case the control
   * says so (aria-description is not enough — the state is visible text) and
   * the native path is the only one. Plain left clicks on a client that can
   * finish the transfer are intercepted and become tasks in this page's center.
   *
   * `size` is the byte size when the page knows it before the click (a file's
   * node.size); a folder ZIP never has one. `kind: 'archive'` is never held in
   * memory: an archive is large by nature, and its bytes only exist once the
   * server starts building it.
   */
  const downloadControl = ({ label, url, filename, size, archive, primary, iconName }) => {
    const href = '/api/v1' + url;
    const bytesKnown = !archive && Number.isFinite(size) && size >= 0;
    // A small pre-known file can be assembled and saved as one Blob; everything
    // else has to reach a file the visitor picks, or the browser itself. The
    // Blob route needs the counting stream: without it fetchBlob cannot report
    // progress or stop a chunked body at the limit, so a legacy client keeps
    // the native attachment instead.
    const blobRoute = bytesKnown && size <= PUBLIC_BLOB_LIMIT && typeof TransformStream === 'function';
    const pickerRoute = !blobRoute && canPickSaveFile();
    const nativeOnly = !blobRoute && !pickerRoute;
    const queuedName = filename || label;
    const control = h('a', {
      class: (primary ? 'btn btn-primary' : 'btn btn-ghost')
        + ' public-download'
        + (nativeOnly ? ' is-native-download' : ''),
      attrs: {
        href,
        download: filename,
        rel: 'noopener',
        target: '_blank',
        // A browser that saves this file itself is announced as such, in text
        // the screen reader gets and a title everyone else can see: the click
        // then does not look like it was ignored by this page.
        ...(nativeOnly
          ? { 'data-native-download': 'true', 'aria-label': label + '（由浏览器直接下载）', title: '由浏览器直接下载' }
          : {}),
      },
      on: {
        click: (event) => {
          // Standard click only: any modifier, a non-primary button or a
          // synthetic event with no button information is the browser's cue to
          // open/save the link itself.
          if (event.defaultPrevented || event.button !== 0
            || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (nativeOnly) return;
          event.preventDefault();
          // One picker per click task, created HERE and synchronously so it
          // still holds this click's user activation, and owned by this task:
          // a retry of the same task reuses the chosen handle (and overwrites
          // it), while two distinct clicks never silently share one.
          const picker = pickerRoute ? saveFilePicker(queuedName) : null;
          // Opened now, inside the gesture: the picker is the first thing the
          // transfer needs, and waiting for the task's own first step would put
          // an `await` between the click and the call.
          if (picker) picker.begin();
          downloadCenter().start({
            name: queuedName,
            kind: archive ? 'archive' : 'file',
            // The caller's own /shared/… path; api.js prefixes /api/v1 itself.
            url,
            auth: false,
            ...(blobRoute ? { maxBytes: PUBLIC_BLOB_LIMIT } : {}),
            // A ZIP's bytes do not exist until the server answers with its
            // headers: the row must say so, on an indeterminate bar, instead of
            // printing 0% for however long the build takes.
            ...(archive ? { waitingDetail: '正在打包，完成后开始传输…' } : {}),
            // Resolving a handle is not a download: the bytes still have to be
            // streamed into it. pick() consumes the dialog this click opened;
            // a retry opens one only when there is no file yet.
            ...(pickerRoute ? {
              transfer: async ({ signal, onProgress }) => {
                const handle = await picker.pick();
                if (!handle) {
                  // A picker resolved without a file: the visitor declined.
                  const canceled = new Error('已取消下载。');
                  canceled.name = 'AbortError';
                  throw canceled;
                }
                return saveDownloadStream(url, handle, { auth: false, signal, onProgress });
              },
            } : {}),
          });
        },
      },
    }, raw(icon(iconName || 'download', 14)), label);
    return control;
  };

  /**
   * The page for a link that points at a single file.
   *
   * Viewer: preview is the only action. Downloader: the attachment comes first,
   * because that is the thing they were given access to.
   */
  const readyFile = (share, node) => {
    const kind = fileKind(node.mime, node.name);
    const caps = shareCapabilities(share.permission);
    const previewable = canPreviewShared(node.mime, node.name);
    const downloadUrl = caps.download ? shareContentUrl(token, state.password) : '';

    // Reading no longer happens inside the 476px card: the button hands the file
    // to the full-viewport reader below, which the drawer closes on Escape.
    const previewBtn = h('button', {
      class: caps.download ? 'btn btn-ghost' : 'btn btn-primary',
      attrs: { type: 'button', 'aria-haspopup': 'dialog' },
      on: { click: () => openReader(node, kind, sharePreviewUrl(token, state.password), downloadUrl) },
    }, raw(icon('eye', 14)), '在线预览');

    const actions = h('div', { class: 'public-actions' });
    if (caps.download) {
      // Only a download-capable link paints the header entry: it is the page's
      // one stable way into the panel, and a viewer link has no tasks to show.
      mountDownloadEntry();
      actions.appendChild(downloadControl({
        label: '下载文件',
        url: downloadUrl,
        filename: node.name,
        size: node.size,
        primary: true,
      }));
    }
    if (previewable) actions.appendChild(previewBtn);
    actions.appendChild(copyLinkButton());

    const meta = bytes(node.size) + (caps.download ? ' · 可下载' : ' · 仅在线查看');
    mount(card,
      header(),
      h('div', { class: 'public-file' },
        h('span', { class: 'picon', html: icon(kindIcon(kind, node.name), 18) }),
        h('div', { class: 'stack', attrs: { style: 'gap:2px;min-width:0;flex:1' } },
          h('b', { text: node.name }),
          h('small', { text: meta }),
        ),
      ),
      actions,
      previewable ? null : h('p', {
        class: 'public-note',
        text: caps.download ? '该格式不支持在线预览，请下载后查看。' : '该格式不支持在线预览。',
      }),
      h('p', {
        class: 'public-note',
        text: share.expiresAt
          ? '此链接' + expiryLabel(share.expiresAt) + '，由分享者设置。'
          : '此链接长期有效，分享者可随时撤销。',
      }),
    );
    document.title = node.name + ' · Marvelous Drive';
  };

  /**
   * The page for a link that points at a folder.
   *
   * The browser walks one level at a time through /children (the server only
   * answers for ids inside the shared subtree) and keeps the trail in memory:
   * a recipient's history entry is the link, not every folder they clicked, so
   * the Back button leaves the share instead of un-nesting it.
   */
  const readyFolder = (share, node) => {
    const caps = shareCapabilities(share.permission);
    const trail = [{ id: node.id, name: node.name, kind: 'folder' }];
    const listHost = h('div', { class: 'stack', attrs: { style: 'gap:8px;margin-top:12px' } });
    const crumbHost = h('div', { class: 'crumbs', attrs: { 'aria-label': '所在位置' } });
    let openToken = 0;

    const renderCrumbs = () => {
      const children = [];
      trail.forEach((item, index) => {
        if (index) children.push(h('span', { class: 'crumb-sep', html: icon('chevron-right', 13) }));
        const last = index === trail.length - 1;
        if (last) children.push(h('span', { class: 'crumb', attrs: { 'aria-current': 'page' }, text: item.name }));
        else {
          children.push(h('button', {
            class: 'crumb',
            attrs: { type: 'button', title: item.name },
            text: item.name,
            on: { click: () => { trail.length = index + 1; renderCrumbs(); void openFolder(item.id); } },
          }));
        }
      });
      mount(crumbHost, children);
    };

    const rowFor = (entry) => {
      const kind = entry.kind === 'folder' ? 'folder' : fileKind(entry.mime, entry.name);
      const row = h('button', {
        class: 'public-file',
        attrs: { type: 'button', style: 'width:100%;text-align:left;margin-bottom:0' },
        on: {
          click: () => {
            if (entry.kind === 'folder') {
              trail.push({ id: entry.id, name: entry.name, kind: 'folder' });
              renderCrumbs();
              void openFolder(entry.id);
              return;
            }
            void openEntry(entry);
          },
        },
      },
        h('span', { class: 'picon', html: icon(kindIcon(kind, entry.name), 18) }),
        h('div', { class: 'stack', attrs: { style: 'gap:2px;min-width:0;flex:1' } },
          h('b', { text: entry.name }),
          h('small', { text: shareEntryMeta(entry) }),
        ),
      );
      // The row is a button, so a nested button would be invalid markup: the
      // per-item download rides beside it in the same flex box instead.
      if (caps.download && entry.kind !== 'folder') {
        return h('div', { class: 'row', attrs: { style: 'gap:6px;align-items:stretch' } },
          row,
          downloadControl({
            label: '下载',
            url: shareFileUrl(token, entry.id, state.password, true),
            filename: entry.name,
            // The listing carries each child's size, so a small nested file
            // takes the same Blob route as a standalone one.
            size: entry.size,
            iconName: 'download',
          }),
        );
      }
      return row;
    };

    /** Opens one file of the folder: preview for a viewer, preview + download for a downloader. */
    const openEntry = async (entry) => {
      const kind = fileKind(entry.mime, entry.name);
      if (!canPreviewShared(entry.mime, entry.name)) {
        // The row is not worth a full-screen panel that can only say "no".
        toast(caps.download ? '该格式不支持在线预览，请下载后查看。' : '该格式不支持在线预览。', { type: 'warning' });
        return;
      }
      openReader(
        entry,
        kind,
        shareFileUrl(token, entry.id, state.password, false),
        caps.download ? shareFileUrl(token, entry.id, state.password, true) : '',
      );
    };

    const openFolder = async (parentId) => {
      const requestId = ++openToken;
      mount(listHost, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在读取文件夹…' })));
      try {
        const payload = await request(shareChildrenUrl(token, state.password, parentId), { auth: false });
        // A slower answer for a folder the visitor has already left must not
        // overwrite the one they are looking at.
        if (requestId !== openToken) return;
        const entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
        if (!entries.length) {
          mount(listHost, h('div', { class: 'empty' }, h('b', { text: '这个文件夹是空的' }), h('p', { text: '分享者还没有放东西进来。' })));
          return;
        }
        mount(listHost, entries.map(rowFor));
      } catch (error) {
        if (requestId !== openToken) return;
        mount(listHost, h('p', { class: 'public-note', text: (error && error.message) || '读取文件夹失败。' }));
      }
    };

    const actions = h('div', { class: 'public-actions' });
    if (caps.downloadAll) {
      mountDownloadEntry();
      actions.appendChild(downloadControl({
        label: '下载全部(ZIP)',
        url: shareArchiveUrl(token, state.password),
        filename: node.name + '.zip',
        primary: true,
        iconName: 'file-archive',
        // An archive has no pre-known size and is never held in memory: it is
        // streamed into the visitor's chosen file, or left to the browser.
        archive: true,
      }));
    }
    actions.appendChild(copyLinkButton());

    mount(card,
      header(),
      h('div', { class: 'public-file' },
        h('span', { class: 'picon', html: icon('folder', 18) }),
        h('div', { class: 'stack', attrs: { style: 'gap:2px;min-width:0;flex:1' } },
          h('b', { text: node.name }),
          h('small', { text: caps.download ? '文件夹 · 可下载' : '文件夹 · 仅在线查看' }),
        ),
      ),
      actions,
      crumbHost,
      listHost,
      h('p', {
        class: 'public-note',
        text: share.expiresAt
          ? '此链接' + expiryLabel(share.expiresAt) + '，由分享者设置。'
          : '此链接长期有效，分享者可随时撤销。',
      }),
    );
    document.title = node.name + ' · Marvelous Drive';
    renderCrumbs();
    void openFolder(node.id);
  };

  /**
   * Opens `node` in the shared reading surface: one drawer, full viewport.
   *
   * The reader is the same drawer() the drive uses for a preview, only pinned to
   * all four sides instead of the right rail (see .shared-reader in
   * shared-reader.css). The bytes still come from renderSharedPreview, so the
   * public page and the drive agree on how a PDF, an Office outline, a long
   * Markdown file or a video is drawn.
   *
   * Only one may be open: opening a second file from a folder replaces the
   * first, because the visitor asked for that file, not for two panes.
   */
  const openReader = (node, kind, url, optionalDownloadUrl) => {
    if (reader) reader.close();
    const host = h('div', { class: 'shared-reader-stage' });
    // The panel lives on <body>, so it can outlive the share card it was opened
    // from: a route change replaces the card, and the reader must leave with it
    // rather than float over the drive.
    let observer = null;
    const handle = drawer({
      title: node.name,
      sub: readerLabel(kind, node.name),
      className: 'shared-reader',
      // The attachment rides in the panel header: the card underneath is behind
      // the modal scrim, so a download left there is unreachable while reading.
      // It is the same managed control as the card's, not a second download path.
      headActions: optionalDownloadUrl
        ? [downloadControl({ label: '下载文件', url: optionalDownloadUrl, filename: node.name, size: node.size })]
        : [],
      body: host,
      onClose: () => {
        if (observer) { observer.disconnect(); observer = null; }
        // Aborts an in-flight request, revokes the object URL and stops media
        // before the panel leaves the document.
        clearSharedPreview(host);
        if (reader === handle) reader = null;
      },
    });
    reader = handle;
    observer = new MutationObserver(() => {
      if (wrap.isConnected) return;
      if (observer) { observer.disconnect(); observer = null; }
      handle.close();
    });
    observer.observe(root, { childList: true });
    void renderSharedPreview(host, node, token, state.password, kind, url);
    return handle;
  };

  const ready = (share) => {
    if (!wrap.isConnected) return;
    if (!share || !share.node) { missing(); return; }
    if (share.node.kind === 'folder') readyFolder(share, share.node);
    else readyFile(share, share.node);
  };

  async function load() {
    loading();
    try {
      const payload = await request(sharedInfoUrl(token), { auth: false });
      ready(payload && payload.share);
    } catch (error) {
      if (error && error.code === 'SHARE_LOCKED') {
        // Public metadata is gated too; render a lock card with a generic title.
        locked(null);
        return;
      }
      if (error && error.status === 404) { missing('链接不存在或已失效'); return; }
      missing('无法打开这个链接', (error && error.message) || '请稍后重试。');
    }
  }

  load();
  return {
    destroy() {
      // Nothing this visit started may outlive it. The reader is closed first so
      // its own cleanup runs against a live element, then the page's private
      // center is destroyed: its tasks, its panel and their file names belong
      // to this link and must not follow the visitor to another share or into
      // the drive. A task still transferring is canceled by destroy().
      destroyed = true;
      if (reader) reader.close();
      if (center) {
        center.destroy();
        center = null;
      }
      // Object URLs are per-document and live until revoked: a folder the visitor
      // browsed through would otherwise keep every previewed file in memory.
      for (const element of root.querySelectorAll('[data-shared-preview]')) clearSharedPreview(element);
      root.replaceChildren();
    },
  };
}

/**
 * Loads inline bytes for one public file and renders them.
 *
 * `url` is built by the caller because the two surfaces need different routes:
 * the shared file itself goes through /preview, a file inside a folder share
 * through /file/:nodeId (which the server answers inline for a viewer).
 */
const previewRequests = new WeakMap();

function clearSharedPreview(host) {
  previewRequests.get(host)?.abort();
  previewRequests.delete(host);
  if (host.dataset.objectUrl) {
    URL.revokeObjectURL(host.dataset.objectUrl);
    delete host.dataset.objectUrl;
  }
  for (const media of host.querySelectorAll('audio, video')) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  host.replaceChildren();
}

async function renderSharedPreview(host, node, token, password, kind, url) {
  clearSharedPreview(host);
  host.dataset.sharedPreview = 'true';
  const controller = new AbortController();
  previewRequests.set(host, controller);
  const current = () => previewRequests.get(host) === controller && !controller.signal.aborted;
  mount(host, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在载入预览…' })));
  const source = url || sharePreviewUrl(token, password);
  try {
    if (OFFICE_EXTENSIONS.has(extension(node.name))) {
      const payload = await request(shareOfficeUrl(token, password, node.id), { auth: false, signal: controller.signal });
      if (current()) mount(host, renderOffice(payload.office));
      return;
    }
    if (kind === 'audio' || kind === 'video') {
      // Native media requests stream and seek through Range; a multi-GB video
      // must not be downloaded into a Blob before the visitor can press Play.
      const media = h(kind, {
        class: 'preview-media',
        attrs: { controls: 'controls', preload: 'metadata', src: '/api/v1' + source, 'aria-label': node.name },
        on: { error: () => {
          if (!current()) return;
          mount(host, h('p', { class: 'public-note', text: '浏览器无法播放该文件，可能不支持其编码。可下载后用本地播放器打开。' }));
        } },
      });
      mount(host, media);
      return;
    }
    const blob = await fetchBlob(source, { auth: false, signal: controller.signal });
    if (!current()) return;
    if (kind === 'image' || kind === 'pdf') {
      const objectUrl = URL.createObjectURL(blob);
      host.dataset.objectUrl = objectUrl;
      if (kind === 'image') mount(host, h('img', {
        class: 'preview-media',
        attrs: { alt: node.name, src: objectUrl },
        on: { error: () => {
          if (current()) mount(host, h('p', { class: 'public-note', text: '浏览器无法解码这张图片，文件可能损坏或格式不受支持。' }));
        } },
      }));
      // The public card is a block, not a flex column, so a frame that relies on
      // `flex:1` would fall back to the 150px default and show one page corner.
      // The reader pins the panel to the viewport instead, so the frame keeps
      // the height its layout gives it (see styles/shared-reader.css).
      else mount(host, h('iframe', { class: 'preview-frame', attrs: { src: objectUrl, title: node.name } }));
      return;
    }
    if (kind === 'markdown' || kind === 'text' || kind === 'code') {
      const body = await blob.text();
      if (!current()) return;
      mount(host, h('pre', { class: 'preview-text', text: body }));
      return;
    }
    mount(host, h('p', { class: 'public-note', text: '该格式不支持在线预览，请下载后查看。' }));
  } catch (error) {
    if (!current()) return;
    mount(host, h('p', { class: 'public-note', text: (error && error.message) || '预览载入失败。' }));
  }
}
