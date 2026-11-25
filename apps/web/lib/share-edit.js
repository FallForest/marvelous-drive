/*
 * share-edit.js — the one dialog that changes an existing link in place.
 *
 * Two surfaces open it: the file's share dialog (已有链接) and a row of
 * 我分享的. It is separate from lib/share.js because it is a management surface,
 * not a public one, and because both callers need the same three guarantees this
 * module exists to keep:
 *
 *   1. Nothing is sent unless something was deliberately changed. The form is
 *      seeded from the *live* row and reports exactly the fields the owner
 *      touched, so "opened and pressed 保存" cannot reset an expiry, drop a
 *      password or clear a download cap that was never on screen.
 *   2. The old password is never in the DOM and never on the wire. The dialog
 *      knows only `hasPassword`; replacing needs a new value, removing needs an
 *      explicit choice, and keeping is the default. There is no request that
 *      asks the server what the current password is, because there is no such
 *      response.
 *   3. Cancel sends nothing. Submitting is single-flight: the button becomes
 *      busy, a second submit is ignored, and a failure keeps the dialog open
 *      with the entered values intact so the owner can retry without retyping.
 *
 * Expiry is the subtle one. The owner sees the link's *current* absolute moment
 * and picks "keep" by default; the offered presets (7 天 / 30 天 / 永不过期) are
 * deliberate replacements, computed from the click, not a silent re-base of an
 * existing expiry. An expired link therefore opens with its real (past) moment
 * shown as 已过期 and stays that way unless the owner renews it — renewing is a
 * change, and it happens on the same token.
 */

import { h, raw, mount } from './dom.js';
import { icon, expiryLabel, formatDate } from './format.js';
import { dialog, toast, withBusy } from './ui.js';
import { renderSelect } from './select.js';
import { api } from './api.js';

/* ── pure model: what the dialog shows and what it would send ──── */

/**
 * This document's origin, or '' when there is no window (a unit test).
 *
 * The module is imported by DOM-free tests for its pure model, and a function
 * that hard-references `window` would make every one of those tests fail on the
 * import path rather than on the rule it asserts.
 */
function shareOrigin() {
  return typeof window !== 'undefined' && window.location ? String(window.location.origin || '') : '';
}

/**
 * The absolute URL of a share.
 *
 * The server builds `url` from the request origin; a same-origin relative value
 * is completed here, exactly as the share dialog and the list do, because the
 * clipboard must receive something a recipient can paste into a browser. A
 * share with neither field yields '' — a caller must treat that as "no URL to
 * offer" rather than copying a relative fragment that resolves nowhere.
 */
export function shareAbsoluteUrl(share) {
  const value = share && share.url ? String(share.url) : '';
  if (!value) return share && share.token ? shareOrigin() + '/s/' + encodeURIComponent(share.token) : '';
  if (/^https?:\/\//i.test(value)) return value;
  return shareOrigin() + (value.startsWith('/') ? value : '/' + value);
}

/**
 * Whether this link's URL actually resolves right now, and the word for why not.
 *
 * The server's `state` is authoritative when present (the management list sends
 * it); the per-node list does not, so it is derived from the same columns in the
 * same order resolveShare() refuses them. `budget` only counts for a downloader:
 * a viewer link may keep a spent counter from its downloader days and is still
 * fully openable, which is what makes a downgrade from an exhausted link usable.
 */
export function shareAvailability(share, now) {
  const reference = Number.isFinite(now) ? now : Date.now();
  if (!share) return { usable: false, state: 'unknown', label: '未知' };
  if (share.node && share.node.deletedAt) return { usable: false, state: 'trashed', label: '文件在回收站' };
  if (share.state === 'trashed') return { usable: false, state: 'trashed', label: '文件在回收站' };
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= reference) {
    return { usable: false, state: 'expired', label: '已过期' };
  }
  const downloader = share.permission === 'downloader';
  if (downloader && share.maxDownloads != null && (Number(share.downloads) || 0) >= share.maxDownloads) {
    return { usable: false, state: 'exhausted', label: '下载次数用完' };
  }
  return { usable: true, state: 'active', label: '有效' };
}

/** The one-line state of a link's settings, shared by every surface. */
export function shareSettingsLine(share) {
  if (!share) return '';
  const bits = [share.permission === 'downloader' ? '可下载' : '仅查看'];
  bits.push(share.hasPassword ? '带密码' : '无密码');
  if (share.permission === 'downloader') {
    if (share.maxDownloads != null) bits.push('已下载 ' + (Number(share.downloads) || 0) + '/' + share.maxDownloads + ' 次');
    else bits.push('已下载 ' + (Number(share.downloads) || 0) + ' 次');
  } else {
    // A viewer link does not spend the counter, so showing "n/m" would read as a
    // budget it is still subject to. The history is still worth a word when the
    // link used to download, because switching back resumes it.
    bits.push((Number(share.downloads) || 0) > 0 ? '仅在线查看（已下载 ' + share.downloads + ' 次）' : '仅在线查看');
  }
  if (share.expiresAt) bits.push(expiryLabel(share.expiresAt));
  else bits.push('永不过期');
  return bits.join(' · ');
}

/**
 * The expiry control's choices for one link.
 *
 * `keep` is first whenever the link has an expiry, and its label carries the
 * real moment: the owner is choosing "leave this alone", and the value they are
 * leaving alone has to be readable without opening a calendar. An expired link
 * says so in the same slot, which is how renewal becomes an intentional choice.
 */
export function expiryOptions(share) {
  const options = [];
  const hasExpiry = Boolean(share && share.expiresAt);
  if (hasExpiry) {
    options.push({ value: 'keep', label: '保持当前（' + expiryLabel(share.expiresAt) + '）' });
  }
  options.push(
    { value: '7', label: '7 天' },
    { value: '30', label: '30 天' },
    { value: 'never', label: '永不过期' },
  );
  return options;
}

/** The expiry value a freshly opened dialog should hold. */
export function initialExpiryValue(share) {
  return share && share.expiresAt ? 'keep' : 'never';
}

/**
 * The PATCH body for a set of form values, or `{ body, error }`.
 *
 * Every rule about "only intentional changes" lives here, in one pure function,
 * so the dialog cannot disagree with what a test asserts:
 *
 *   expiry   'keep' (or the seeded value when the link has no expiry) → omitted
 *            'never' → null (clear)  •  '<days>' → expiresInDays
 *   password 'keep' → omitted  •  'replace' → the typed value  •  'remove' → null
 *   cap      unchanged text → omitted  •  '' → null  •  otherwise the integer
 *
 * The cap is only part of the body when the link is a downloader: a viewer link
 * never sends one, and switching to viewer sends an explicit null so a cap that
 * could never apply again is not left behind to surprise the next switch back.
 */
export function buildSharePatch(values) {
  const form = values || {};
  const body = {};

  const currentPermission = form.permission === 'downloader' ? 'downloader' : 'viewer';
  const nextPermission = form.nextPermission === 'downloader' ? 'downloader' : 'viewer';
  const permissionChanged = nextPermission !== currentPermission;
  if (permissionChanged) body.permission = nextPermission;

  const expiryChoice = String(form.expiryChoice == null ? '' : form.expiryChoice);
  if (expiryChoice === 'never') {
    if (form.hasExpiry) body.expiresInDays = null;
  } else if (expiryChoice === '7' || expiryChoice === '30') {
    body.expiresInDays = Number(expiryChoice);
  }
  // 'keep', or the seeded value of a link that has no expiry, means "unchanged":
  // omit the key so the server keeps the stored absolute moment.

  const passwordChoice = String(form.passwordChoice || 'keep');
  if (passwordChoice === 'replace') {
    const value = typeof form.newPassword === 'string' ? form.newPassword : '';
    if (!value) return { error: '请输入新的访问密码，或选择保持当前密码。', field: 'newPassword' };
    if (value.length > 200) return { error: '访问密码最多 200 个字符。', field: 'newPassword' };
    body.password = value;
  } else if (passwordChoice === 'remove') {
    if (form.hasPassword) body.password = null;
  }

  // The cap only has meaning for a downloader. Switching to viewer clears it, so
  // "viewer" and "a cap nobody can reach" cannot both be true after the save.
  const capText = String(form.capText == null ? '' : form.capText).trim();
  if (nextPermission === 'viewer') {
    if (permissionChanged && form.hasCap) body.maxDownloads = null;
  } else if (capText !== String(form.initialCapText == null ? '' : form.initialCapText).trim()) {
    if (capText === '') {
      body.maxDownloads = null;
    } else {
      const cap = Number(capText);
      if (!Number.isInteger(cap) || cap < 1) return { error: '下载上限需要是大于 0 的整数，或留空表示不限。', field: 'capText' };
      body.maxDownloads = cap;
    }
  }

  return { body, changed: Object.keys(body).length > 0 };
}

/** The values a dialog opens with, read from the live row. */
export function seedShareForm(share) {
  return {
    permission: share && share.permission === 'downloader' ? 'downloader' : 'viewer',
    nextPermission: share && share.permission === 'downloader' ? 'downloader' : 'viewer',
    hasExpiry: Boolean(share && share.expiresAt),
    expiryChoice: initialExpiryValue(share),
    hasPassword: Boolean(share && share.hasPassword),
    passwordChoice: 'keep',
    newPassword: '',
    hasCap: Boolean(share && share.maxDownloads != null),
    capText: share && share.maxDownloads != null ? String(share.maxDownloads) : '',
    initialCapText: share && share.maxDownloads != null ? String(share.maxDownloads) : '',
  };
}

/**
 * The server's PATCH answer, completed with the source state it may omit.
 *
 * The edit response is about settings and can arrive as basic share data: no
 * `node` (the source file), and no derived `state`/`usable` that a listing adds.
 * Availability depends on the source too, so the trashed fact is carried over
 * from the row the dialog opened on — otherwise a link whose file sits in the
 * trash would read 有效 the moment its expiry changed. Expiry and the budget are
 * deliberately NOT carried: they are what this PATCH just wrote, so the answer
 * is newer than the row.
 */
function withSourceState(updated, source) {
  const row = { ...(updated || {}) };
  const sourceNode = source && source.node ? source.node : null;
  const trashedSource = row.state === 'trashed' || (source && source.state === 'trashed')
    || Boolean(sourceNode && sourceNode.deletedAt);
  if (!row.node && sourceNode) row.node = sourceNode;
  // A listing's `state` is the only place the trash fact may live when the
  // source node is not on the row; everything else is read off the fresh answer.
  if (row.state == null && trashedSource) row.state = 'trashed';
  if (!row.url && source && source.url) row.url = source.url;
  return row;
}

/* ── dialog ───────────────────────────────────────────────────── */

/**
 * openShareEditor(share, options) → { el, close }
 *
 * options: { onSaved(updatedShare), description }
 *
 * `share` is the row as some listing returned it; the dialog re-reads nothing,
 * because both callers already have a fresh row and a second round trip would
 * only widen the window in which the owner edits stale values. The row it sends
 * back through onSaved is the server's answer, never the local guess.
 */
export function openShareEditor(share, options) {
  const opts = options || {};
  const seed = seedShareForm(share);
  const availability = shareAvailability(share);
  const url = shareAbsoluteUrl(share);

  /**
   * Ids scoped to this dialog instance.
   *
   * A closing overlay is removed on animationend, not on close(), so for ~140ms
   * two editors can be in the document at once. Static ids would make that a
   * duplicate-id document — every label would point at the dying dialog's field,
   * and a `#share-edit-permission` lookup would address the wrong one. The
   * suffix costs nothing and keeps the markup valid throughout.
   *
   * `data-share-edit` on each control is the stable hook an automated check
   * uses, so a test never has to guess a per-instance id.
   */
  const uid = 'se-' + Math.random().toString(36).slice(2, 8);
  const id = (name) => uid + '-' + name;

  /** Guards against a double submit and against edits after a success. */
  let submitting = false;
  let settled = false;

  const formError = h('div', { class: 'field-error', attrs: { role: 'alert', hidden: 'hidden' } });
  const showError = (message) => {
    formError.textContent = message;
    formError.removeAttribute('hidden');
  };
  const clearError = () => formError.setAttribute('hidden', 'hidden');

  /* the current state, stated once and plainly */
  const stateChip = h('span', { class: 'share-edit-state is-' + availability.state, text: availability.label });
  const current = h('div', { class: 'share-edit-current', attrs: { 'aria-label': '当前设置' } },
    h('div', { class: 'share-edit-url' },
      h('code', { attrs: { title: url }, text: url || '（此链接没有可用地址）' }),
    ),
    h('div', { class: 'share-edit-facts' },
      stateChip,
      h('span', { text: shareSettingsLine(share) }),
      h('span', { text: '创建于 ' + (formatDate(share && share.createdAt) || '—') }),
    ),
    availability.usable
      ? null
      : h('p', { class: 'share-edit-warn', attrs: { role: 'note' },
        text: availability.state === 'trashed'
          ? '源文件在回收站里，链接暂时打不开；调整设置不会改变这一点，恢复文件后立即生效。'
          : availability.state === 'expired'
            ? '这条链接已经过期，拿到的人现在打不开。选择新的有效期即可在原链接上续期，地址和已下载次数都不变。'
            : '下载次数已经用完，拿到的人现在打不开。可以调高或取消上限，也可以改为仅查看——已下载次数不会被重置。' }),
  );

  /* permission */
  const permission = renderSelect({
    id: id('permission'),
    label: '访问权限',
    value: seed.nextPermission,
    options: [
      { value: 'viewer', label: '仅查看（在线预览）' },
      { value: 'downloader', label: '可下载' },
    ],
    onChange: (value) => { seed.nextPermission = value; applyPermission(); },
  });

  /* expiry */
  const expiry = renderSelect({
    id: id('expiry'),
    label: '有效期',
    value: seed.expiryChoice,
    options: expiryOptions(share),
    onChange: (value) => { seed.expiryChoice = value; clearError(); },
  });

  /* password — three explicit choices, and the old one is never here */
  const passwordChoice = renderSelect({
    id: id('password-mode'),
    label: '访问密码',
    value: 'keep',
    options: [
      { value: 'keep', label: seed.hasPassword ? '保持当前密码' : '不设密码' },
      // Only a link that has a password can have it removed, and only then does
      // the option exist: offering "移除" on an unprotected link would be a
      // choice that does nothing.
      ...(seed.hasPassword ? [{ value: 'remove', label: '移除密码' }] : []),
      { value: 'replace', label: seed.hasPassword ? '设置新密码' : '设置密码' },
    ],
    onChange: (value) => { seed.passwordChoice = value; applyPassword(); },
  });
  const newPassword = h('input', {
    class: 'input',
    attrs: {
      id: id('password'), type: 'password', autocomplete: 'new-password', maxlength: '200',
      placeholder: '输入新的访问密码',
    },
  });
  const passwordField = h('div', { class: 'field share-edit-extra' },
    h('label', { attrs: { for: id('password') }, text: '新密码' }), newPassword,
  );
  newPassword.addEventListener('input', () => { seed.newPassword = newPassword.value; clearError(); });

  /* download cap + current usage */
  const capInput = h('input', {
    class: 'input',
    attrs: { id: id('cap'), type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: '留空则不限' },
    value: seed.capText,
  });
  capInput.addEventListener('input', () => { seed.capText = capInput.value; clearError(); });
  const capField = h('div', { class: 'field' },
    h('label', { attrs: { for: id('cap') }, text: '下载上限' }), capInput,
  );
  const usage = h('p', { class: 'field-hint share-edit-usage' });
  const capBlock = h('div', { class: 'share-edit-cap' }, capField, usage);

  // Stable hooks for the browser check: the ids above are per instance, so the
  // test addresses the live control by role, never by a guessed id.
  permission.dataset.shareEdit = 'permission';
  expiry.dataset.shareEdit = 'expiry';
  passwordChoice.dataset.shareEdit = 'password-mode';
  newPassword.dataset.shareEdit = 'password';
  capInput.dataset.shareEdit = 'cap';

  const applyPassword = () => {
    if (seed.passwordChoice === 'replace') passwordField.removeAttribute('hidden');
    else passwordField.setAttribute('hidden', 'hidden');
    // Leaving "replace" and coming back must not resurrect a password the owner
    // has already walked away from: the field and the model are cleared together.
    if (seed.passwordChoice !== 'replace') {
      newPassword.value = '';
      seed.newPassword = '';
    }
  };

  const applyPermission = () => {
    const downloader = seed.nextPermission === 'downloader';
    if (downloader) {
      capBlock.removeAttribute('hidden');
      capInput.disabled = false;
    } else {
      capBlock.setAttribute('hidden', 'hidden');
      capInput.disabled = true;
    }
    // The usage line is the honest place for the counter: it is history, and it
    // keeps counting whether or not the cap is meaningful right now.
    const used = Number(share && share.downloads) || 0;
    const cap = String(capInput.value || '').trim();
    usage.textContent = downloader
      ? '已被下载 ' + used + ' 次' + (cap ? '，上限 ' + cap + ' 次' : '，不设上限') + '。已下载次数不会因为修改设置而重置。'
      : '仅查看的链接不计入下载次数。' + (used ? '这条链接此前已被下载 ' + used + ' 次，改回可下载时会从这次数继续。' : '');
  };
  // The sentence quotes the cap, so it has to follow the field rather than the
  // value the dialog opened with.
  capInput.addEventListener('input', applyPermission);

  const permissionField = h('div', { class: 'field' },
    h('label', { attrs: { for: id('permission') }, text: '访问权限' }), permission,
  );
  const expiryField = h('div', { class: 'field' },
    h('label', { attrs: { for: id('expiry') }, text: '有效期' }), expiry,
  );
  const passwordFieldGroup = h('div', { class: 'field' },
    h('label', { attrs: { for: id('password-mode') }, text: '访问密码' }), passwordChoice,
  );

  const form = h('form', { class: 'stack share-edit-form', attrs: { id: id('form'), style: 'gap:10px' } },
    formError,
    h('div', { class: 'inline-fields' }, permissionField, expiryField),
    h('div', { class: 'stack', attrs: { style: 'gap:8px' } },
      passwordFieldGroup,
      passwordField,
      capBlock,
    ),
    h('p', { class: 'dialog-note', text: '保存只修改你在这里改动的项。链接地址、创建时间和已下载次数都保持不变，已经拿到链接的人不需要换地址。' }),
  );

  const saveBtn = h('button', {
    // The button lives in the dialog footer, outside <form>. `form` binds it to
    // the one form this dialog owns, so a click is a native submit — same path
    // as Enter — and the browser's own validation runs first. The type stays
    // "submit" so that native submit is what the click does.
    class: 'btn btn-primary', attrs: { type: 'submit', form: id('form') }, text: '保存更改',
  });

  const handle = dialog({
    title: '编辑链接设置',
    description: (share && share.node && share.node.name) || opts.description || '',
    wide: true,
    body: h('div', { class: 'stack share-edit' }, current, h('hr', { class: 'divider' }), form),
    footer: (dlg) => {
      const cancel = h('button', {
        class: 'btn', attrs: { type: 'button' }, text: '取消',
        on: { click: () => dlg.close() },
      });
      // No click handler: the button's `form` attribute makes the click a native
      // submit of the one form above, which is the same path Enter takes.
      return [cancel, h('span', { class: 'push' }), saveBtn];
    },
    // Closing while a save is in flight must not leave a request that lands on a
    // dialog nobody sees: the submit result is discarded, and the request itself
    // is allowed to finish because the server has already accepted it.
    onClose: () => { settled = true; },
  });
  handle.el.classList.add('share-edit-dialog');

  async function submit() {
    if (submitting || settled) return;
    clearError();
    // The live controls are the only truth: the seed holds what the row said when
    // the dialog opened, so it can never see the password just typed or a cap the
    // owner edited or cleared. Snapshotting the two inputs at submit (the selects
    // already write their own choice into the seed) is what makes "设置新密码" send
    // a password at all. `initialCapText` is left as seeded so an untouched cap is
    // still recognised as no change.
    const built = buildSharePatch({ ...seed, newPassword: newPassword.value, capText: capInput.value });
    if (built.error) {
      showError(built.error);
      const target = built.field === 'newPassword' ? newPassword : capInput;
      target.focus();
      return;
    }
    // The guard is taken before the no-change branch too: a double click must not
    // produce two "没有需要保存的修改" toasts either.
    submitting = true;
    try {
      if (!built.changed) {
        // Nothing was touched. Saying so is better than a silent close or a PATCH
        // that would only restate the current values.
        toast('没有需要保存的修改。', { type: 'info', timeout: 2400 });
        return;
      }
      // The busy state is the duplicate-submit guard and the progress indicator
      // at once: withBusy disables the button and paints its own spinner, so
      // there is no second label to drift out of sync with it.
      withBusy(saveBtn, true);
      const payload = await api.patch('/shares/' + encodeURIComponent(share.id), built.body);
      const basic = payload && payload.share;
      if (!basic) throw new Error('服务器没有返回更新后的链接。');
      // The response may omit node/state, so post-save availability is judged on
      // the merged row rather than on a link that would look freshly healthy.
      const updated = withSourceState(basic, share);
      settled = true;
      const availabilityAfter = shareAvailability(updated);
      toast(availabilityAfter.usable ? '链接设置已更新，地址保持不变。' : '链接设置已更新，但链接现在仍不可用：' + availabilityAfter.label + '。', {
        type: availabilityAfter.usable ? 'success' : 'warning',
        detail: shareAbsoluteUrl(updated),
        timeout: 4200,
      });
      if (typeof opts.onSaved === 'function') opts.onSaved(updated);
      handle.close();
    } catch (error) {
      // Kept open with the typed values: a failed save must not cost the owner
      // the password they just chose. 404 means the link is gone, and the only
      // honest thing left is to say so and let the caller refresh.
      const message = error && error.status === 404
        ? '这条链接已经不存在（可能已在别处撤销）。'
        : (error && error.message) || '保存失败，请重试。';
      showError(message);
      if (error && error.status === 404 && typeof opts.onMissing === 'function') opts.onMissing();
    } finally {
      submitting = false;
      if (!settled) withBusy(saveBtn, false);
    }
  }

  // Enter submits the form (it is a real form); Escape closes through the
  // dialog's own layer, which is why there is no key handler here.
  form.addEventListener('submit', (event) => { event.preventDefault(); void submit(); });
  applyPassword();
  applyPermission();
  // The dialog focuses its first enabled text input, which is the password field
  // even while "keep" hides it. The permission select is what an owner opens this
  // for, and focusing a hidden field would leave the caret nowhere.
  requestAnimationFrame(() => {
    if (settled) return;
    const active = document.activeElement;
    if (active && active !== document.body && handle.el.contains(active) && !active.closest('[hidden]')) return;
    permission.focus();
  });

  return { el: handle.el, close: handle.close, body: form };
}
