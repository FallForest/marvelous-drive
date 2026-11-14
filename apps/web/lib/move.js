/* Destination picker shared by single and batch moves. */
import { h, raw } from './dom.js';
import { icon } from './format.js';
import { dialog } from './ui.js';
import { ancestorPath } from './state.js';
import { moveRoots, planMoves } from './drag-move.js';

/** null is the drive root; undefined means the user cancelled. */
export function chooseFolder(options = {}) {
  const { index } = options;
  const targets = options.nodes?.length ? options.nodes.filter(Boolean) : (options.node ? [options.node] : []);
  const ids = moveRoots(targets.map((node) => node.id), index);
  const parents = new Set(targets.map((node) => node.parentId || null));
  let selected = parents.size === 1 ? targets[0].parentId || null : null;
  let moveButton;
  let destinationNote;
  const listHost = h('div', {
    class: 'move-list',
    attrs: { role: 'listbox', 'aria-label': '目标文件夹', style: 'max-height:44vh;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:4px' },
    on: { keydown: (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const rows = allRows.filter((row) => !row.disabled);
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
      rows[next].click();
      rows[next].focus();
    } },
  });
  const pathFor = (id) => ['我的云盘', ...ancestorPath(index, id).map((node) => node.name)].join(' / ');
  const canMoveTo = (id) => {
    const plan = planMoves(ids, id, index);
    return !plan.blocked.length && plan.allowed.some((nodeId) => (index.byId.get(nodeId).parentId || null) !== id);
  };
  const makeRow = (id, name, depth) => {
    const disabled = !canMoveTo(id);
    return h('button', {
      class: 'menu-item', dataset: { folderId: id || '' },
      attrs: {
        type: 'button', role: 'option', disabled: disabled || undefined,
        'aria-label': pathFor(id), title: pathFor(id),
        style: 'padding-left:' + (8 + depth * 14) + 'px',
      },
      on: { click: () => { selected = id; markRows(); } },
    }, raw(icon(id ? 'folder' : 'harddrive', 15)), h('span', { text: name }),
    disabled ? h('kbd', { text: targets.every((node) => (node.parentId || null) === id) ? '当前位置' : '不可选' }) : null);
  };
  const renderLevel = (parentId, depth) => {
    const folders = (index.children.get(parentId || 'root') || []).filter((node) => node.kind === 'folder')
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    return folders.flatMap((folder) => [makeRow(folder.id, folder.name, depth), ...renderLevel(folder.id, depth + 1)]);
  };
  const allRows = [makeRow(null, '我的云盘（根目录）', 0), ...renderLevel(null, 1)];
  for (const row of allRows) listHost.appendChild(row);

  function markRows() {
    for (const row of allRows) {
      const active = (row.dataset.folderId || null) === selected;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-selected', String(active));
      row.tabIndex = active && !row.disabled ? 0 : -1;
      row.style.background = active ? 'var(--accent-soft)' : '';
    }
    if (!allRows.some((row) => row.tabIndex === 0)) {
      const first = allRows.find((row) => !row.disabled);
      if (first) first.tabIndex = 0;
    }
    if (moveButton) moveButton.disabled = !canMoveTo(selected);
    if (destinationNote) destinationNote.textContent = '目标：' + pathFor(selected);
  }

  return new Promise((resolve) => {
    let settled = false;
    dialog({
      title: options.title || '移动到…',
      description: targets.length > 1 ? '已选择 ' + targets.length + ' 项 · 选择目标文件夹' : (targets[0]?.name || ''),
      body: listHost,
      onClose: () => { if (!settled) { settled = true; resolve(undefined); } },
      footer: (dlg) => {
        destinationNote = h('span', { class: 'dialog-note move-destination', attrs: { 'aria-live': 'polite' } });
        moveButton = h('button', {
          class: 'btn btn-primary', attrs: { type: 'button' }, text: '移动',
          on: { click: () => { if (!canMoveTo(selected)) return; settled = true; resolve(selected); dlg.close(); } },
        });
        return [destinationNote, h('span', { class: 'push' }),
          h('button', { class: 'btn', attrs: { type: 'button' }, text: '取消', on: { click: () => dlg.close() } }), moveButton];
      },
    });
    markRows();
  });
}
