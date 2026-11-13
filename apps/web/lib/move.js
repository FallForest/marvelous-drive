/*
 * move.js — folder picker dialog. Reuses the flat-tree index so the picker
 * cannot offer an invalid destination (a node's own subtree is filtered out).
 */

import { h, raw } from './dom.js';
import { icon } from './format.js';
import { dialog } from './ui.js';

/**
 * chooseFolder({ index, node, nodes, title }) → Promise<string|null|undefined>
 *
 * Resolves the target parentId: `null` is the root, `undefined` means cancelled.
 *
 * `nodes` is the batch form and wins over `node`: every selected folder and its
 * whole folder subtree is blocked, so a batch move can never drop one item into
 * another item's own subtree. A synthetic "multiple selection" object would only
 * describe one id, which is exactly how that mistake happens — hence the array.
 */
export function chooseFolder(options) {
  const opts = options || {};
  const index = opts.index;
  const targets = Array.isArray(opts.nodes) && opts.nodes.length
    ? opts.nodes.filter(Boolean)
    : (opts.node ? [opts.node] : []);
  const node = targets[0] || null;
  let selected = null; // null = root
  const listHost = h('div', { class: 'move-list', attrs: { role: 'tree', style: 'max-height:44vh;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:4px' } });

  const blocked = new Set();
  const blockSubtree = (id) => {
    if (blocked.has(id)) return;
    blocked.add(id);
    for (const child of index.children.get(id) || []) {
      if (child.kind === 'folder') blockSubtree(child.id);
    }
  };
  for (const item of targets) {
    if (item.kind === 'folder') blockSubtree(item.id);
    else blocked.add(item.id);
  }

  const renderLevel = (parentId, depth) => {
    const folders = (index.children.get(parentId || 'root') || [])
      .filter((child) => child.kind === 'folder')
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    const nodes = [];
    for (const folder of folders) {
      const disabled = blocked.has(folder.id);
      const row = h('button', {
        class: 'menu-item', attrs: { type: 'button', role: 'treeitem', disabled: disabled || undefined, style: 'padding-left:' + (8 + depth * 14) + 'px' },
        on: { click: () => { if (disabled) return; selected = folder.id; markRows(); } },
      }, raw(icon('folder', 15)), h('span', { text: folder.name }), disabled ? h('kbd', { text: '不可选' }) : null);
      row.dataset.folderId = folder.id;
      nodes.push(row);
      nodes.push(...renderLevel(folder.id, depth + 1));
    }
    return nodes;
  };

  const rootRow = h('button', {
    class: 'menu-item', attrs: { type: 'button', role: 'treeitem' },
    on: { click: () => { selected = null; markRows(); } },
  }, raw(icon('harddrive', 15)), h('span', { text: '我的云盘（根目录）' }));
  rootRow.dataset.folderId = '';

  const allRows = [rootRow, ...renderLevel(null, 1)];
  for (const row of allRows) listHost.appendChild(row);

  function markRows() {
    for (const row of listHost.querySelectorAll('.menu-item')) {
      const id = row.dataset.folderId || null;
      const isSelected = (id || null) === selected;
      row.classList.toggle('is-active', isSelected);
      row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      if (isSelected) row.style.background = 'var(--accent-soft)';
      else row.style.background = '';
    }
  }
  markRows();

  return new Promise((resolve) => {
    let settled = false;
    const handle = dialog({
      title: opts.title || '移动到…',
      description: targets.length > 1 ? '已选择 ' + targets.length + ' 项 · 目标文件夹' : (node ? node.name : ''),
      body: listHost,
      onClose: () => { if (!settled) { settled = true; resolve(undefined); } },
      footer: (dlg) => [
        h('span', { class: 'dialog-note', text: '选中的目标文件夹' }),
        h('span', { class: 'push' }),
        h('button', { class: 'btn', attrs: { type: 'button' }, text: '取消', on: { click: () => dlg.close() } }),
        h('button', {
          class: 'btn btn-primary', attrs: { type: 'button' }, text: '移动',
          on: { click: () => { settled = true; resolve(selected); dlg.close(); } },
        }),
      ],
    });
    return handle;
  });
}
