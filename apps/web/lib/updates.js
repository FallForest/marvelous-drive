/*
 * updates.js — the release check and the self-update confirmation.
 *
 * Two verbs, deliberately separate:
 *   checkForUpdate()  asks the API what the published release is;
 *   openUpdatePanel() shows the version, the release notes link and — for a
 *                     workspace admin — the button that hands the job to the
 *                     update agent.
 *
 * Nothing here restarts anything. The request returns 202 and the server does
 * the work; this module polls until it reports a terminal state, because a
 * silent no-op is indistinguishable from a broken button.
 */

import { h, raw } from './dom.js';
import { icon } from './format.js';
import { api } from './api.js';
import { toast, drawer } from './ui.js';
import { store } from './session.js';

const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 90;

/** Cached per page load: the answer cannot change while the tab is open. */
let cached = null;

/**
 * Reads the release manifest through the API.
 *
 * Never throws when called silently: a failed check means "unknown", not an
 * error the user has to dismiss. The caller decides what to render.
 */
export async function checkForUpdate(options) {
  const opts = options || {};
  try {
    const result = await api.get('/system/update-check');
    cached = result;
    return result;
  } catch (error) {
    if (opts.silent) return cached || null;
    throw error;
  }
}

/** True when this account may start an update (the workspace admin). */
export function canUpdate() {
  const user = store.state.user;
  const workspace = user && user.workspace;
  return Boolean(workspace && workspace.role === 'admin');
}

const shortVersion = (value) => String(value || '').replace(/^v/i, '');

/**
 * Opens the update drawer.
 *
 * 'info' is the payload from checkForUpdate(); when it is absent the panel
 * fetches it, so opening from the account menu costs one request, not two.
 */
export function openUpdatePanel(info) {
  let state = info || cached;
  let polling = null;

  const host = h('div', { class: 'update-panel' });
  let paint = () => {};

  const start = async () => {
    try {
      const result = await api.post('/system/update');
      if (result && result.started === false) {
        toast(result.message || '已经是最新版本。', { type: 'info' });
        return;
      }
      state = Object.assign({}, state || {}, { status: 'running', error: null, output: '' });
      paint();
      toast('更新已开始，正在备份并重启服务。', { type: 'info' });
      poll();
    } catch (error) {
      state = Object.assign({}, state || {}, { status: 'failed', error: error.message });
      paint();
    }
  };

  const poll = () => {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const result = await api.get('/system/update-status');
        state = Object.assign({}, state || {}, result.update || {});
        paint();
        if (state.status === 'completed') {
          toast('更新完成，正在重新加载…', { type: 'success' });
          window.setTimeout(() => window.location.reload(), 1800);
          return;
        }
        if (state.status === 'failed') return;
      } catch {
        // The instance is restarting under us: keep polling until the API
        // answers again or the budget runs out.
      }
      if (attempts < POLL_LIMIT) polling = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    polling = window.setTimeout(tick, POLL_INTERVAL_MS);
  };

  const renderStatus = () => {
    const tone = state.status === 'failed' ? 'is-danger' : state.status === 'completed' ? 'is-ok' : 'is-busy';
    const label = state.status === 'running' ? '更新进行中' : state.status === 'completed' ? '更新完成' : '更新失败';
    return h('div', { class: 'update-status ' + tone },
      h('b', { text: label }),
      state.error ? h('small', { text: String(state.error) }) : null,
      state.output ? h('pre', { class: 'update-log', text: String(state.output).slice(-2000) }) : null,
    );
  };

  const renderPanel = () => {
    if (!state) {
      return h('p', { class: 'dialog-note', text: '正在读取版本信息…' });
    }
    const latest = state.latestVersion;
    const available = Boolean(state.updateAvailable);
    const manifest = state.manifest || {};
    const running = state.status === 'running';

    let note;
    if (!state.configured) note = '这个部署未配置发布清单，因此没有可检查的更新。';
    else if (state.error) note = '读取发布清单失败：' + state.error;
    else if (!latest) note = '发布清单里没有版本号。';
    else if (available) note = '有新版本可用。更新会先备份数据，再替换容器镜像；健康检查失败会自动回滚。';
    else note = '已经是最新版本。';

    const actions = [];
    if (manifest.releaseUrl) {
      actions.push(h('a', {
        class: 'btn',
        attrs: { href: manifest.releaseUrl, target: '_blank', rel: 'noopener noreferrer' },
      }, raw(icon('external-link', 14)), '发行说明'));
    }
    if (available && state.configured && canUpdate()) {
      actions.push(h('button', {
        class: 'btn btn-primary',
        attrs: { type: 'button', disabled: running ? 'disabled' : null },
        on: { click: () => { if (!running) start(); } },
      }, raw(icon('download', 14)), running ? '更新进行中…' : '立即更新'));
    }

    return h('div', { class: 'update-head' },
      h('div', { class: 'update-version' },
        h('span', { class: 'update-key', text: '当前版本' }),
        h('span', { class: 'update-value', text: shortVersion(state.currentVersion) || '未知' }),
      ),
      latest ? h('div', { class: 'update-version' },
        h('span', { class: 'update-key', text: '最新版本' }),
        h('span', { class: 'update-value' + (available ? ' is-new' : ''), text: shortVersion(latest) }),
      ) : null,
      h('p', { class: 'dialog-note', text: note }),
      state.status && state.status !== 'idle' ? renderStatus() : null,
      actions.length ? h('div', { class: 'update-actions' }, actions) : null,
      available && state.configured && !canUpdate()
        ? h('p', { class: 'dialog-note', text: '只有工作区管理员可以执行更新。' })
        : null,
    );
  };

  paint = () => { host.replaceChildren(renderPanel()); };
  paint();

  // Opened from the menu without a payload: fetch once, then paint again.
  if (!state) {
    checkForUpdate({ silent: true }).then((result) => {
      if (result) { state = result; paint(); }
    });
  }

  return drawer({
    title: '软件更新',
    subtitle: '检查并安装新版本',
    width: 460,
    body: host,
    onClose: () => { if (polling) window.clearTimeout(polling); },
  });
}
