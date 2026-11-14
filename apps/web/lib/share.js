/*
 * share.js — share dialog (create / list / revoke) and the public /s/<token>
 * page.
 *
 * Creation posts the contract shape {permission,expiresInDays,password,
 * maxDownloads}; the returned share.url is same-origin, so it is normalised to
 * an absolute URL before it is shown or copied.
 */

import { h, raw, mount } from './dom.js';
import { icon, fileKind, bytes, expiryLabel, kindIcon } from './format.js';
import { dialog, toast, copyText, withBusy, confirmDialog } from './ui.js';
import { renderSelect } from './select.js';
import { api, request, fetchBlob, saveBlob, sharedInfoUrl } from './api.js';

export function absoluteShareUrl(share) {
  const raw = share && share.url ? String(share.url) : '';
  if (!raw) return share && share.token ? window.location.origin + '/s/' + share.token : '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return window.location.origin + (raw.startsWith('/') ? raw : '/' + raw);
}

function shareStateLabel(share) {
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) return '已过期';
  const bits = [share.permission === 'downloader' ? '可下载' : '仅查看'];
  if (share.hasPassword) bits.push('带密码');
  if (share.maxDownloads) bits.push('限 ' + share.downloads + '/' + share.maxDownloads + ' 次');
  else bits.push('已下载 ' + (share.downloads || 0) + ' 次');
  return bits.join(' · ');
}

/** Open the share dialog for one node. options: { onChanged } */
export function openShareDialog(node, options) {
  const opts = options || {};
  const listHost = h('div', { class: 'share-list', attrs: { 'aria-live': 'polite' } }, h('p', { class: 'dialog-note', text: '正在载入已有链接…' }));

  const permission = renderSelect({
    id: 'share-permission',
    label: '权限',
    value: 'viewer',
    options: [
      { value: 'viewer', label: '仅查看（在线预览）' },
      { value: 'downloader', label: '可下载' },
    ],
  });
  const expiry = renderSelect({
    id: 'share-expiry',
    label: '有效期',
    value: '',
    options: [
      { value: '', label: '永不过期' },
      { value: '1', label: '1 天' },
      { value: '7', label: '7 天' },
      { value: '30', label: '30 天' },
    ],
  });
  const password = h('input', { class: 'input', attrs: { id: 'share-password', type: 'password', autocomplete: 'new-password', placeholder: '留空则不设密码', maxlength: '200' } });
  const maxDownloads = h('input', { class: 'input', attrs: { id: 'share-max', type: 'number', min: '1', step: '1', placeholder: '留空则不限' } });
  const formError = h('div', { class: 'field-error', attrs: { role: 'alert', hidden: 'hidden' } });
  const createBtn = h('button', { class: 'btn btn-primary', attrs: { type: 'submit' } }, raw(icon('link', 14)), '创建链接');

  const form = h('form', { class: 'stack', attrs: { style: 'gap:10px' } },
    formError,
    h('div', { class: 'inline-fields' },
      h('div', { class: 'field' }, h('label', { attrs: { for: 'share-permission' }, text: '权限' }), permission),
      h('div', { class: 'field' }, h('label', { attrs: { for: 'share-expiry' }, text: '有效期' }), expiry),
    ),
    h('div', { class: 'inline-fields' },
      h('div', { class: 'field' }, h('label', { attrs: { for: 'share-password' }, text: '访问密码' }), password),
      h('div', { class: 'field' }, h('label', { attrs: { for: 'share-max' }, text: '下载上限' }), maxDownloads),
    ),
    h('div', { class: 'row', attrs: { style: 'justify-content:flex-end' } }, createBtn),
    h('hr', { class: 'divider' }),
    h('div', { class: 'stack', attrs: { style: 'gap:8px' } },
      h('div', { class: 'section-title' }, '已有链接', h('span', { class: 'muted', text: '' })),
      listHost,
    ),
  );

  const handle = dialog({
    title: '分享',
    description: node.name,
    wide: true,
    body: form,
    footer: (dlg) => [
      h('span', { class: 'dialog-note', text: '链接指向当前服务器，打开即可在线查看。' }),
      h('span', { class: 'push' }),
      h('button', { class: 'btn btn-ghost', attrs: { type: 'button' }, text: '完成', on: { click: () => dlg.close() } }),
    ],
  });

  const refreshList = async () => {
    try {
      const payload = await api.get('/nodes/' + node.id + '/shares');
      const shares = payload && Array.isArray(payload.shares) ? payload.shares : [];
      renderShares(shares);
    } catch (error) {
      mount(listHost, h('p', { class: 'dialog-note', text: (error && error.message) || '无法载入已有链接。' }));
    }
  };

  const renderShares = (shares) => {
    if (!shares.length) {
      mount(listHost, h('p', { class: 'dialog-note', text: '还没有分享链接。填写上面的选项即可创建第一个。' }));
      return;
    }
    const list = h('div', { class: 'share-list' });
    for (const share of shares) {
      const url = absoluteShareUrl(share);
      list.appendChild(h('div', { class: 'share-item' },
        h('div', { class: 'si-main' },
          h('code', { attrs: { title: url }, text: url }),
          h('small', { text: shareStateLabel(share) + (share.expiresAt ? ' · ' + expiryLabel(share.expiresAt) : '') }),
        ),
        h('button', {
          class: 'icon-btn', attrs: { type: 'button', 'aria-label': '复制链接', title: '复制链接' }, html: icon('copy', 13),
          on: {
            click: async () => {
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
                await api.del('/shares/' + share.id);
                toast('分享链接已撤销。', { type: 'success' });
                refreshList();
                if (opts.onChanged) opts.onChanged();
              } catch (error) {
                toast((error && error.message) || '撤销失败。', { type: 'error' });
              }
            },
          },
        }),
      ));
    }
    mount(listHost, list);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.setAttribute('hidden', 'hidden');
    // The selects expose their value through a property, not `.value`: they are
    // buttons over the app's own menu, not native form controls.
    const body = {
      permission: permission.value,
      expiresInDays: expiry.value ? Number(expiry.value) : undefined,
      password: password.value ? password.value : undefined,
      maxDownloads: maxDownloads.value ? Number(maxDownloads.value) : undefined,
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
  const wrap = h('div', { class: 'public-wrap' });
  // The public page is a page root: it enters once through the shared class, so
  // a reduced-motion user gets a cross-fade instead of travel.
  const card = h('div', { class: 'public-card motion-sheet', attrs: { 'aria-live': 'polite' } });
  wrap.appendChild(card);
  root.replaceChildren(wrap);
  document.title = '分享链接 · Marvelous Drive';

  const header = () => h('div', { class: 'public-head' },
    h('span', { class: 'brand-mark', html: icon('harddrive', 14) }),
    h('span', { text: 'Marvelous Drive' }),
    h('span', { class: 'push' }),
    h('button', {
      class: 'btn-link', attrs: { type: 'button' }, text: '打开我的云盘',
      on: { click: () => { if (ctx && ctx.onHome) ctx.onHome(); } },
    }),
  );

  const loading = () => {
    mount(card, header(), h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在读取分享内容…' })));
  };

  const missing = (message, hint) => {
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

  const ready = (share) => {
    if (!share || !share.node) { missing(); return; }
    const node = share.node;
    const kind = fileKind(node.mime, node.name);
    const canDownload = share.permission === 'downloader';
    const passwordSuffix = state.password ? '?password=' + encodeURIComponent(state.password) : '';

    const downloadBtn = h('button', {
      class: 'btn btn-primary',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          withBusy(downloadBtn, true);
          try {
            const blob = await fetchBlob('/shared/' + encodeURIComponent(token) + '/content' + passwordSuffix);
            saveBlob(blob, node.name);
          } catch (err) {
            const message = err && err.code === 'SHARE_NOT_FOUND'
              ? '链接已失效或达到下载上限。'
              : (err && err.message) || '下载失败。';
            toast(message, { type: 'error' });
          } finally {
            withBusy(downloadBtn, false);
          }
        },
      },
    }, raw(icon('download', 14)), canDownload ? '下载文件' : '下载 / 查看');

    const copyBtn = h('button', {
      class: 'btn',
      attrs: { type: 'button' },
      on: {
        click: async () => {
          const ok = await copyText(window.location.href);
          toast(ok ? '链接已复制。' : '复制失败，请手动复制地址栏。', { type: ok ? 'success' : 'error' });
        },
      },
    }, raw(icon('link', 14)), '复制本页链接');

    const previewHost = h('div', { class: 'stack', attrs: { style: 'gap:10px;margin-top:14px' } });
    let previewOpen = false;
    const togglePreview = h('button', {
      class: 'btn btn-ghost',
      attrs: { type: 'button', 'aria-expanded': 'false' },
      text: '在线预览',
      on: {
        click: async () => {
          previewOpen = !previewOpen;
          togglePreview.textContent = previewOpen ? '收起预览' : '在线预览';
          togglePreview.setAttribute('aria-expanded', previewOpen ? 'true' : 'false');
          if (!previewOpen) { previewHost.replaceChildren(); return; }
          await renderSharedPreview(previewHost, node, token, state.password, kind);
        },
      },
    });

    const meta = node.kind === 'folder'
      ? '文件夹'
      : bytes(node.size) + ' · ' + (canDownload ? '可下载' : '仅在线查看');

    mount(card,
      header(),
      h('div', { class: 'public-file' },
        h('span', { class: 'picon', html: icon(kindIcon(kind, node.name), 18) }),
        h('div', { class: 'stack', attrs: { style: 'gap:2px;min-width:0;flex:1' } },
          h('b', { text: node.name }),
          h('small', { text: meta }),
        ),
      ),
      h('div', { class: 'public-actions' }, downloadBtn, copyBtn, togglePreview),
      previewHost,
      h('p', {
        class: 'public-note',
        text: share.expiresAt
          ? '此链接' + expiryLabel(share.expiresAt) + '，由分享者设置。'
          : '此链接长期有效，分享者可随时撤销。',
      }),
    );
    document.title = node.name + ' · Marvelous Drive';
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
    destroy() { root.replaceChildren(); },
  };
}

async function renderSharedPreview(host, node, token, password, kind) {
  mount(host, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: '正在载入预览…' })));
  const suffix = password ? '?password=' + encodeURIComponent(password) : '';
  let objectUrl = null;
  try {
    const blob = await fetchBlob('/shared/' + encodeURIComponent(token) + '/content' + suffix);
    objectUrl = URL.createObjectURL(blob);
    if (kind === 'image') {
      mount(host, h('img', { class: 'preview-media', attrs: { alt: node.name, src: objectUrl } }));
      return;
    }
    if (kind === 'pdf') {
      mount(host, h('iframe', { class: 'preview-frame', attrs: { src: objectUrl, title: node.name } }));
      return;
    }
    if (kind === 'markdown' || kind === 'text' || kind === 'code') {
      const text = await blob.text();
      mount(host, h('pre', { class: 'preview-text', text }));
      return;
    }
    mount(host, h('p', { class: 'public-note', text: '该格式不支持在线预览，请下载后查看。' }));
  } catch (error) {
    mount(host, h('p', { class: 'public-note', text: (error && error.message) || '无法载入预览。' }));
  }
}
