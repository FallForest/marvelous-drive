/* Explicit UTF-8 text editing with version-checked saves and guarded dismissal. */
import { h } from './dom.js';
import { isTextLike } from './format.js';
import { drawer, dialog, toast } from './ui.js';
import { request, fetchBlob, contentUrl, saveBlob } from './api.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function canEditText(node) {
  return Boolean(node && node.kind === 'file' && Number.isFinite(node.size) && node.size >= 0
    && node.size <= MAX_TEXT_BYTES && isTextLike(node.mime, node.name));
}

export function openTextEditor(node, options = {}) {
  if (!canEditText(node)) return null;
  let current = node;
  let baseline = '';
  let ready = false;
  let disposed = false;
  let saving = null;
  let bom = false;
  let newline = '\n';
  let lease = null;
  let cleanupViewport = () => {};
  const client = 'editor-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const controller = new AbortController();
  const status = h('div', { class: 'editor-status', attrs: { role: 'status', 'aria-live': 'polite' }, text: '正在读取最新内容…' });
  const lockNote = h('div', { class: 'editor-lock-note lock-banner', attrs: { role: 'status', hidden: 'hidden' } });
  const input = h('textarea', {
    class: 'text-editor-input',
    attrs: { 'aria-label': '编辑 ' + node.name, spellcheck: 'false', autocapitalize: 'off', readonly: true },
    on: { input: () => updateStatus() },
  });
  let saveButton;
  let draftButton;
  const dirty = () => ready && input.value !== baseline;
  const beforeUnload = (event) => {
    if (!dirty() && !saving) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  const handle = drawer({
    title: '编辑 · ' + node.name,
    className: 'text-editor-drawer',
    body: h('div', { class: 'text-editor-body' }, status, lockNote, input),
    footer: (panel) => {
      draftButton = h('button', {
        class: 'btn', attrs: { type: 'button', disabled: true }, text: '下载草稿',
        on: { click: () => saveBlob(new Blob([encodedText()], { type: current.mime || 'text/plain' }), current.name) },
      });
      saveButton = h('button', {
        class: 'btn btn-primary', attrs: { type: 'button', disabled: true }, text: '保存',
        on: { click: () => save() },
      });
      return [draftButton, h('span', { class: 'push' }),
        h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => panel.close() } }), saveButton];
    },
    beforeClose: async () => {
      if (saving) await saving;
      if (!dirty()) return true;
      return decideClose();
    },
    onClose: () => {
      disposed = true;
      controller.abort();
      window.removeEventListener('beforeunload', beforeUnload);
      cleanupViewport();
      releaseLease();
    },
  });
  const viewport = window.visualViewport;
  if (viewport) {
    const fitViewport = () => {
      if (disposed) return;
      // The keyboard shrinks/moves the visual viewport without always changing
      // 100dvh. Leave native pinch zoom and panning alone when scale is not 1.
      if (window.matchMedia('(max-width: 880px)').matches && Math.abs(viewport.scale - 1) < 0.01) {
        handle.el.style.setProperty('--editor-viewport-height', viewport.height + 'px');
        handle.el.style.setProperty('--editor-viewport-top', viewport.offsetTop + 'px');
      } else {
        handle.el.style.removeProperty('--editor-viewport-height');
        handle.el.style.removeProperty('--editor-viewport-top');
      }
    };
    viewport.addEventListener('resize', fitViewport);
    viewport.addEventListener('scroll', fitViewport);
    window.addEventListener('resize', fitViewport);
    cleanupViewport = () => {
      viewport.removeEventListener('resize', fitViewport);
      viewport.removeEventListener('scroll', fitViewport);
      window.removeEventListener('resize', fitViewport);
    };
    fitViewport();
  }
  handle.el.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  });

  function encodedText() {
    const text = input.value.replace(/\r\n|\r|\n/g, newline);
    return (bom ? '\uFEFF' : '') + text;
  }
  function updateStatus(message) {
    if (disposed) return;
    saveButton.disabled = !ready || !dirty() || Boolean(saving);
    draftButton.disabled = !ready;
    input.readOnly = !ready || Boolean(saving);
    status.textContent = message || (saving ? '正在保存…' : dirty() ? '有未保存的更改' : '已保存');
    saveButton.textContent = saving ? '保存中…' : '保存';
  }
  function save() {
    if (saving) return saving;
    if (!ready || disposed) return Promise.resolve(false);
    if (!dirty()) return Promise.resolve(true);
    const bytes = new TextEncoder().encode(encodedText());
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      updateStatus('内容超过 2 MiB，请下载草稿后在本地编辑。');
      return Promise.resolve(false);
    }
    saving = (async () => {
      try {
        const payload = await request('/files/' + current.id + '/content?expectedVersion=' + current.version, {
          method: 'PUT', body: new Blob([bytes], { type: current.mime || 'text/plain' }),
        });
        current = payload.node;
        baseline = input.value;
        if (typeof options.onSaved === 'function') {
          try { await options.onSaved(current); }
          catch { toast('内容已保存，列表刷新失败，请手动刷新。', { type: 'warning' }); }
        }
        return true;
      } catch (error) {
        status.dataset.error = error.code || 'SAVE_FAILED';
        updateStatus(error.code === 'VERSION_CONFLICT'
          ? '文件已在别处更改。草稿仍在，请下载草稿并重新打开最新文件。'
          : '保存失败，草稿仍在：' + (error.message || '请重试。'));
        return false;
      } finally {
        saving = null;
        updateStatus(status.dataset.error ? status.textContent : undefined);
      }
    })();
    delete status.dataset.error;
    updateStatus();
    return saving;
  }
  function decideClose() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (answer) => { if (!settled) { settled = true; resolve(answer); } };
      dialog({
        title: '保存更改？', description: current.name + ' 有未保存的内容。',
        onClose: () => finish(false),
        footer: (prompt) => [
          h('button', { class: 'btn', attrs: { type: 'button', autofocus: true }, text: '继续编辑', on: { click: () => prompt.close() } }),
          h('button', { class: 'btn btn-danger', attrs: { type: 'button' }, text: '放弃更改', on: { click: () => { finish(true); prompt.close(); } } }),
          h('button', { class: 'btn btn-primary', attrs: { type: 'button' }, text: '保存并关闭', on: { click: async () => {
            prompt.setBusy(true);
            const saved = await save();
            if (saved) { finish(true); prompt.close(); }
            else { finish(false); prompt.close(); input.focus(); }
          } } }),
        ],
      });
    });
  }
  async function releaseLease() {
    if (!lease) return;
    try {
      const acquired = await lease;
      if (!acquired) return;
      // Match the client atomically: an old window cannot release a newer claim.
      await request('/nodes/' + current.id + '/lock?client=' + encodeURIComponent(client), { method: 'DELETE' });
    } catch { /* The short server TTL is the fallback if the connection is gone. */ }
  }
  async function load() {
    try {
      const latest = await request('/nodes/' + node.id, { signal: controller.signal });
      current = latest.node;
      if (!canEditText(current)) throw new Error('此文件不支持在线文本编辑，或已超过 2 MiB。');
      const blob = await fetchBlob(contentUrl(current.id), { signal: controller.signal });
      if (blob.size > MAX_TEXT_BYTES) throw new Error('文件已超过 2 MiB，请下载后编辑。');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('文件不是有效的 UTF-8 文本，请下载后使用本地编辑器。'); }
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new Error('文件包含二进制内容，不能作为文本编辑。');
      if (disposed) return;
      bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
      input.value = text.replace(/\r\n|\r/g, '\n');
      baseline = input.value;
      ready = true;
      updateStatus();
      input.focus();
      lease = request('/nodes/' + current.id + '/lock', { method: 'POST', body: { client } })
        .then((payload) => {
          if (payload.supersededClient && !disposed) {
            lockNote.hidden = false;
            lockNote.textContent = '编辑状态从「' + payload.supersededClient + '」转到此窗口，保存时会核对版本。';
          }
          return true;
        }).catch((error) => {
          if (!disposed) {
            lockNote.hidden = false;
            lockNote.textContent = error.status === 409 ? '另一个窗口正在编辑；保存时仍会核对版本。' : '暂时无法获取编辑状态；保存时仍会核对版本。';
          }
          return false;
        });
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') updateStatus(error.message || '无法读取文件。');
    }
  }
  load();
  return handle;
}
