/*
 * duplicates.js — the "重复文件" report drawer (storage P2-4).
 *
 * The server returns one group per identical payload for the signed-in account;
 * this module only presents it and offers the one destructive shortcut that is
 * safe: keep the first copy, trash the rest (soft delete — the trash can undo
 * it). No byte comparison happens here: the report is authoritative.
 */

import { h, raw } from './dom.js';
import { bytes, formatDate, icon } from './format.js';
import { api } from './api.js';
import { drawer, toast, confirmDialog } from './ui.js';

/** Path label for one file: "报告 / 2026 / c.txt", or just the name at root. */
export function pathLabel(node) {
  const segments = Array.isArray(node && node.path) ? node.path : [];
  const parts = segments
    .map((part) => (part && part.name ? String(part.name) : ''))
    .filter(Boolean);
  if (!parts.length) return String((node && node.name) || '');
  return parts.join(' / ') + ' / ' + String(node.name || '');
}

/** Short human summary of a report, used in the drawer header and toasts. */
export function duplicatesSummary(report) {
  const groups = report && Array.isArray(report.groups) ? report.groups : [];
  const total = Number(report && report.totalWastedBytes) || 0;
  if (!groups.length) return '没有重复文件';
  return groups.length + ' 组 · 可释放 ' + bytes(total);
}

/** The ids to trash for "keep only the first" — never the first node itself. */
export function removableIds(group) {
  const nodes = group && Array.isArray(group.nodes) ? group.nodes : [];
  return nodes.slice(1).map((node) => node.id).filter(Boolean);
}

/**
 * Fetches the report, then renders the drawer. `onChanged` fires after every
 * successful trash so the caller can refresh the file list behind the drawer.
 */
export async function openDuplicatesDrawer(options) {
  const opts = options || {};
  const handle = drawer({
    title: '重复文件',
    sub: '读取中…',
    className: 'duplicates-drawer',
    width: '460px',
    body: h('div', { class: 'dup-list', attrs: { style: 'display:flex;flex-direction:column;gap:10px' } },
      h('div', { class: 'empty', attrs: { style: 'padding:28px 12px' } }, raw(icon('loader', 22)), h('p', { text: '正在统计重复文件…' }))),
  });
  const sub = handle.el.querySelector('.drawer-head .sub');

  const translate = async () => {
    try {
      const report = await api.get('/storage/duplicates');
      render(report);
    } catch (error) {
      setSub('读取失败');
      handle.body.replaceChildren(h('div', { class: 'empty' },
        raw(icon('alert', 26)),
        h('b', { text: '读取重复文件失败' }),
        h('p', { text: (error && error.message) || '请稍后重试。' }),
        h('button', {
          class: 'btn', attrs: { type: 'button', style: 'margin-top:6px' }, text: '重试',
          on: { click: () => { translate(); } },
        }),
      ));
    }
  };

  function setSub(text) {
    if (sub) sub.textContent = text;
  }

  function render(report) {
    const groups = report && Array.isArray(report.groups) ? report.groups : [];
    setSub(duplicatesSummary(report));
    if (!groups.length) {
      handle.body.replaceChildren(h('div', { class: 'empty', attrs: { style: 'padding:40px 16px' } },
        raw(icon('check', 28)),
        h('b', { text: '没有重复文件' }),
        h('p', { text: '这个云盘里的每个文件都是唯一的：没有内容完全相同的两个文件。' }),
        h('p', { class: 'muted', attrs: { style: 'font-size:11px' }, text: '上传同名或同一份内容时，重复项会出现在这里。' }),
      ));
      return;
    }

    const list = h('div', { attrs: { style: 'display:flex;flex-direction:column;gap:10px' } });
    for (const group of groups) list.appendChild(groupCard(group, report));
    handle.body.replaceChildren(
      h('p', { class: 'muted', attrs: { style: 'font-size:11px;line-height:1.6;margin:0 0 2px' },
        text: '按浪费空间从大到小排列。「只保留第一个」会把其余副本移到回收站，30 天内可以还原。' }),
      list,
    );
  }

  function groupCard(group, report) {
    const count = group.nodes.length;
    const detail = h('div', { attrs: { style: 'display:none;flex-direction:column;gap:2px;margin-top:8px' } });
    let filled = false;
    let open = false;
    const toggle = h('button', {
      class: 'btn btn-sm', attrs: { type: 'button', 'aria-expanded': 'false' },
      text: '展开 ' + count + ' 个文件',
      on: { click: () => {
        open = !open;
        if (open && !filled) { fill(detail, group); filled = true; }
        detail.style.display = open ? 'flex' : 'none';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = (open ? '收起' : '展开 ' + count + ' 个文件');
      } },
    });

    const keep = h('button', {
      class: 'btn btn-sm', attrs: { type: 'button' }, text: '只保留第一个',
      on: { click: async () => {
        const ids = removableIds(group);
        if (!ids.length) return;
        const yes = await confirmDialog({
          title: '保留第一个副本',
          description: '其余 ' + ids.length + ' 个副本会移到回收站，之后可以还原。',
          confirmLabel: '移到回收站',
          danger: true,
        });
        if (!yes) return;
        keep.disabled = true;
        let trashed = 0;
        let failed = 0;
        for (const id of ids) {
          try { await api.del('/nodes/' + id); trashed += 1; } catch { failed += 1; }
        }
        keep.disabled = false;
        toast(failed
          ? '已移除 ' + trashed + ' 个副本，' + failed + ' 个失败'
          : '已移除 ' + trashed + ' 个副本，可在回收站还原',
        { type: failed ? 'warning' : 'success' });
        if (typeof opts.onChanged === 'function') opts.onChanged();
        await translate();
      } },
    });

    const card = h('div', {
      class: 'dup-group',
      attrs: { style: 'border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);padding:9px 10px' },
    },
      h('div', { attrs: { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' } },
        h('b', { attrs: { style: 'font-size:var(--fs-sm)' }, text: bytes(group.size) }),
        h('span', { class: 'muted', attrs: { style: 'font-size:var(--fs-xs)' }, text: '浪费 ' + bytes(group.wastedBytes) }),
        h('span', { class: 'muted', attrs: { style: 'font-size:var(--fs-xs)' }, text: '· ' + count + ' 个文件' }),
        h('span', { attrs: { style: 'margin-left:auto;display:flex;gap:6px' } }, toggle, keep),
      ),
      detail,
    );
    return card;
  }

  /** One line per copy: path plus "最早" on the copy that will be kept. */
  function fill(host, group) {
    group.nodes.forEach((node, index) => {
      host.appendChild(h('div', {
        attrs: {
          style: 'display:flex;align-items:baseline;gap:6px;padding:3px 0;'
            + 'border-top:1px solid var(--border-soft);font-size:var(--fs-xs);color:var(--text-secondary)',
        },
      },
        h('span', { html: icon('file', 12), attrs: { style: 'color:var(--text-muted);flex:0 0 auto' } }),
        h('span', { attrs: { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: pathLabel(node) }, text: pathLabel(node) }),
        h('span', { class: 'muted', attrs: { style: 'margin-left:auto;flex:0 0 auto' }, text: index === 0 ? '保留' : formatDate(node.updatedAt) }),
      ));
    });
  }

  translate();
  return handle;
}
