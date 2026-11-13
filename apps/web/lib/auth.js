/*
 * auth.js — login / register screen.
 * Single card, tab-less toggle, inline validation, aria-live error line.
 * On success the token is stored by api.setToken and the shell navigates.
 */

import { h } from './dom.js';
import { icon, initials } from './format.js';
import { api, setToken } from './api.js';

const MIN_PASSWORD = 8;

export function renderAuth(root, options) {
  const opts = options || {};
  let mode = opts.mode === 'register' ? 'register' : 'login';

  const emailInput = h('input', {
    class: 'input', attrs: {
      id: 'auth-email', type: 'email', name: 'email', autocomplete: 'username',
      placeholder: 'you@example.com', required: 'required', spellcheck: 'false', inputmode: 'email',
    },
  });
  const nameInput = h('input', {
    class: 'input', attrs: {
      id: 'auth-name', type: 'text', name: 'name', autocomplete: 'name',
      placeholder: '显示名称（可选）', maxlength: '80',
    },
  });
  const passwordInput = h('input', {
    class: 'input', attrs: {
      id: 'auth-password', type: 'password', name: 'password', autocomplete: 'current-password',
      placeholder: '至少 ' + MIN_PASSWORD + ' 位', required: 'required', minlength: String(MIN_PASSWORD),
    },
  });
  const errorBox = h('div', { class: 'field-error', attrs: { role: 'alert', hidden: 'hidden' } });
  const submitBtn = h('button', { class: 'btn btn-primary btn-block', attrs: { type: 'submit' } });
  const toggleBtn = h('button', { class: 'btn-link', attrs: { type: 'button' } });
  const nameField = h('div', { class: 'field' }, h('label', { attrs: { for: 'auth-name' }, text: '名称' }), nameInput);
  const passwordLabel = h('label', { attrs: { for: 'auth-password' }, text: '密码' });

  const form = h('form', {
    class: 'stack', attrs: { novalidate: 'novalidate' },
    on: {
      submit: async (event) => {
        event.preventDefault();
        await submit();
      },
    },
  },
    errorBox,
    h('div', { class: 'field' },
      h('label', { attrs: { for: 'auth-email' }, text: '邮箱' }),
      emailInput,
    ),
    mode === 'register' ? nameField : null,
    h('div', { class: 'field' }, passwordLabel, passwordInput),
    h('div', { class: 'stack', style: { gap: '8px', marginTop: '4px' } },
      submitBtn,
    ),
  );

  function setError(message) {
    if (!message) {
      errorBox.setAttribute('hidden', 'hidden');
      errorBox.textContent = '';
      return;
    }
    errorBox.replaceChildren(h('span', { html: icon('alert', 14) }), h('span', { text: message }));
    errorBox.removeAttribute('hidden');
  }

  function applyMode() {
    const isRegister = mode === 'register';
    // Switching 登录/注册 swaps the fields in place: a short disclosure keeps the
    // card from jumping while the extra 名称 field appears.
    form.classList.remove('motion-disclose');
    void form.offsetWidth;
    form.classList.add('motion-disclose');
    // replaceChildren() does not skip null: filter first, or the card shows "null".
    const children = [
      errorBox,
      h('div', { class: 'field' }, h('label', { attrs: { for: 'auth-email' }, text: '邮箱' }), emailInput),
      isRegister ? nameField : null,
      h('div', { class: 'field' }, passwordLabel, passwordInput),
      h('div', { class: 'stack', style: { gap: '8px', marginTop: '4px' } }, submitBtn),
    ].filter(Boolean);
    form.replaceChildren(...children);
    submitBtn.textContent = isRegister ? '创建账号' : '登录';
    toggleBtn.textContent = isRegister ? '已有账号？返回登录' : '还没有账号？立即注册';
    passwordInput.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    passwordLabel.textContent = isRegister ? '密码（至少 8 位）' : '密码';
    document.title = (isRegister ? '注册' : '登录') + ' · Marvelous Drive';
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.classList.toggle('is-busy', busy);
    submitBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function submit() {
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const name = nameInput.value.trim();
    setError('');
    emailInput.removeAttribute('aria-invalid');
    passwordInput.removeAttribute('aria-invalid');

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      setError('请输入有效的邮箱地址。');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      passwordInput.setAttribute('aria-invalid', 'true');
      passwordInput.focus();
      setError('密码至少需要 ' + MIN_PASSWORD + ' 个字符。');
      return;
    }

    setBusy(true);
    try {
      const payload = mode === 'register'
        ? await api.post('/auth/register', { email, password, name: name || undefined })
        : await api.post('/auth/login', { email, password });
      if (!payload || !payload.token) throw new Error('登录响应缺少令牌。');
      setToken(payload.token);
      passwordInput.value = '';
      if (typeof opts.onSuccess === 'function') opts.onSuccess(payload.user);
    } catch (error) {
      const message = error && error.status === 401
        ? '邮箱或密码不正确。'
        : error && error.code === 'CONFLICT'
          ? '该邮箱已注册，请直接登录。'
          : (error && error.message) || '登录失败，请稍后重试。';
      setError(message);
      passwordInput.select();
    } finally {
      setBusy(false);
    }
  }

  toggleBtn.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    applyMode();
    setError('');
    (mode === 'register' ? nameInput : emailInput).focus();
    if (typeof opts.onModeChange === 'function') opts.onModeChange(mode);
  });
  applyMode();

  const heading = h('h1', { text: '' });
  const sub = h('p', { class: 'auth-sub', text: '' });
  const card = h('div', { class: 'auth-card' },
    h('div', { class: 'auth-brand' },
      h('span', { class: 'brand-mark', html: icon('harddrive', 14) }),
      h('span', { text: 'Marvelous Drive' }),
    ),
    heading,
    sub,
    form,
    h('div', { class: 'auth-foot' }, toggleBtn, h('span', { class: 'muted mono', text: 'v1' })),
  );

  function applyCopy() {
    const isRegister = mode === 'register';
    heading.textContent = isRegister ? '创建你的云盘' : '欢迎回来';
    sub.textContent = isRegister
      ? '一个安静的个人文件空间。'
      : '登录以继续访问你的文件。';
  }
  toggleBtn.addEventListener('click', applyCopy);

  applyCopy();
  // The card is the page root here, so it enters once through the shared class
  // (a class the motion layer can mute) rather than animating itself.
  const shell = h('div', { class: 'auth-shell' }, card);
  card.classList.add('motion-sheet');
  root.replaceChildren(shell);
  emailInput.focus();
  return { destroy() { root.replaceChildren(); } };
}

export function avatarFor(user) {
  return h('span', { class: 'avatar', attrs: { 'aria-hidden': 'true' }, text: initials(user && (user.name || user.email)) });
}
