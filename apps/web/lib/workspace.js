/*
 * workspace.js — the team panel: who is in this drive, and how to add or remove
 * them.
 *
 * Kept out of app.js because it is a self-contained surface: it reads one
 * endpoint, writes two, and knows nothing about the file tree. The only thing it
 * needs from the shell is a way to refresh after a change.
 */

import { h, raw } from './dom.js';
import { icon, initials, relativeTime } from './format.js';
import { drawer, promptDialog, confirmDialog, toast } from './ui.js';
import { request } from './api.js';

/**
 * Opens the team drawer.
 *
 * `onChanged` fires after a membership change so the shell can reload: adding a
 * member changes what the file list contains when a workspace scope is active.
 */
export async function openWorkspacePanel({ onChanged, currentUserId } = {}) {
  const body = h('div', { class: 'member-list', attrs: { 'aria-live': 'polite' } });
  const handle = drawer({
    title: '团队成员',
    sub: '共享这个云盘的账号',
    width: '460px',
    body,
    footer: [
      h('button', {
        class: 'btn', attrs: { type: 'button' },
        on: { click: () => invite() },
      }, raw(icon('plus', 13)), '添加成员'),
      h('span', { class: 'push' }),
      h('button', { class: 'btn', attrs: { type: 'button' }, text: '关闭', on: { click: () => handle.close() } }),
    ],
  });

  const loading = h('div', { class: 'empty', style: { padding: '28px' } },
    h('span', { class: 'spinner' }), h('p', { text: '正在载入成员…' }));
  body.replaceChildren(loading);

  async function load() {
    let payload;
    try {
      payload = await request('/workspace/members');
    } catch (error) {
      body.replaceChildren(h('div', { class: 'empty' },
        raw(icon('user', 26)),
        h('b', { text: '无法载入成员' }),
        h('p', { text: (error && error.message) || '请重试。' }),
      ));
      return;
    }
    const workspace = payload.workspace || {};
    const members = Array.isArray(payload.members) ? payload.members : [];
    body.replaceChildren();

    body.appendChild(h('div', { class: 'member-head' },
      h('b', { text: workspace.name || '我的云盘' }),
      h('span', { class: 'muted', text: members.length + ' 名成员 · 你的角色：' +
        (workspace.role === 'admin' ? '管理员' : '成员') }),
    ));

    for (const member of members) {
      const isOwner = member.id === workspace.ownerId;
      const isSelf = member.id === currentUserId;
      body.appendChild(h('div', { class: 'member-row' },
        h('span', { class: 'avatar', attrs: { 'aria-hidden': 'true' }, text: initials(member.name || member.email) }),
        h('span', { class: 'member-copy' },
          h('b', { text: member.name || member.email }),
          h('small', { text: member.email + (member.joinedAt ? ' · 加入于 ' + relativeTime(member.joinedAt) : '') }),
        ),
        h('span', { class: 'member-role' + (member.role === 'admin' ? ' is-admin' : ''),
          text: isOwner ? '拥有者' : member.role === 'admin' ? '管理员' : '成员' }),
        // Only an admin may remove someone, and never the owner — the server
        // enforces both, this just avoids offering a doomed button.
        workspace.role === 'admin' && !isOwner && !isSelf
          ? h('button', {
            class: 'icon-btn', attrs: { type: 'button', 'aria-label': '移除 ' + member.email, title: '移除' },
            html: icon('x', 12),
            on: { click: () => remove(member) },
          })
          : null,
      ));
    }

    if (workspace.role !== 'admin') {
      body.appendChild(h('p', { class: 'dialog-note', text: '只有工作区管理员可以添加或移除成员。' }));
    }
  }

  async function invite() {
    const email = await promptDialog({
      title: '添加成员',
      label: '对方的账号邮箱',
      description: '对方必须已经有一个云盘账号；这里没有邮件投递。',
      confirmLabel: '添加',
      placeholder: 'you@example.com',
    });
    if (!email) return;
    try {
      await request('/workspace/members', { method: 'POST', body: { email } });
      toast('已添加 ' + email, { type: 'success' });
      await load();
      if (onChanged) onChanged();
    } catch (error) {
      toast((error && error.message) || '添加失败。', { type: 'error' });
    }
  }

  async function remove(member) {
    const yes = await confirmDialog({
      title: '移除成员',
      description: '「' + (member.name || member.email) + '」将无法再访问这个工作区，它自己的文件保留。',
      confirmLabel: '移除',
      danger: true,
    });
    if (!yes) return;
    try {
      await request('/workspace/members/' + member.id, { method: 'DELETE' });
      toast('已移除 ' + (member.name || member.email), { type: 'success' });
      await load();
      if (onChanged) onChanged();
    } catch (error) {
      toast((error && error.message) || '移除失败。', { type: 'error' });
    }
  }

  await load();
  return handle;
}
