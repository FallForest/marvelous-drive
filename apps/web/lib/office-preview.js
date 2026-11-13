/*
 * office-preview.js — renders the /files/:id/office payload in the drawer.
 *
 * The server extracts OOXML into a shape we control (pages/blocks or
 * sheets/rows), so this module never parses a document: it only lays text out.
 * Every string is escaped — a slide title is file content, not markup.
 */

import { h, raw, mount } from './dom.js';
import { icon } from './format.js';

const KIND_LABEL = { slides: '幻灯片', document: '文档', sheet: '工作表' };

export function isOfficeKind(kind) {
  return kind === 'slides' || kind === 'doc' || kind === 'sheet';
}

/** Fetches the extracted outline and mounts it into `host`. */
export async function loadOfficePreview({ host, node, request, disposed }) {
  const status = h('div', { class: 'empty', style: { padding: '32px' } },
    h('span', { class: 'spinner' }),
    h('p', { text: '正在解析 ' + (node.name || '').replace(/^.*\./, '').toUpperCase() + '…' }),
  );
  host.replaceChildren(status);
  let payload;
  try {
    payload = await request('/files/' + node.id + '/office');
  } catch (error) {
    if (disposed && disposed()) return;
    const message = error && error.status === 422
      ? '这个文件的内容无法解析，可能是加密文档或旧版 .doc/.ppt/.xls 格式。'
      : (error && error.message) || '解析失败。';
    mount(host, [h('div', { class: 'empty' },
      raw(icon('file', 30)),
      h('b', { text: '无法预览' }),
      h('p', { text: message }),
      h('p', { class: 'muted', text: '下载后可用本地应用打开。' }),
    )]);
    return;
  }
  if (disposed && disposed()) return;
  const office = payload && payload.office;
  if (!office) {
    mount(host, [h('div', { class: 'empty' }, raw(icon('file', 30)), h('b', { text: '没有可显示的内容' }))]);
    return;
  }
  mount(host, [renderOffice(office)]);
}

export function renderOffice(office) {
  if (office.kind === 'sheet') return renderSheets(office);
  return renderPages(office);
}

function renderPages(office) {
  const pages = Array.isArray(office.pages) ? office.pages : [];
  const meta = office.meta || {};
  const wrap = h('div', { class: 'office' });
  const head = h('div', { class: 'office-head' },
    h('b', { text: KIND_LABEL[office.kind] || '文档' }),
    h('span', { class: 'muted', text: describePages(office, pages, meta) }),
  );
  wrap.appendChild(head);
  if (!pages.length) {
    wrap.appendChild(h('div', { class: 'empty' }, h('p', { text: '文档里没有可提取的文字（可能只有图片或形状）。' })));
    return wrap;
  }
  const list = h('div', { class: 'office-pages' });
  for (const page of pages) {
    const card = h('article', { class: 'office-page' });
    if (office.kind === 'slides') {
      // Decks built in PowerPoint or WPS often have no title placeholder at all
      // (the title was a plain text box), so fall back to the first text block;
      // showing "（无标题）" on every slide would be useless.
      const heading = page.title || firstText(page) || '（无标题）';
      card.appendChild(h('header', { class: 'office-page-head' },
        h('span', { class: 'office-index', text: String(page.index || '') }),
        h('b', { text: heading }),
      ));
    } else if (page.title) {
      card.appendChild(h('header', { class: 'office-page-head' }, h('b', { text: page.title })));
    }
    for (const block of page.blocks || []) card.appendChild(renderBlock(block));
    list.appendChild(card);
  }
  wrap.appendChild(list);
  if (meta.truncated) {
    wrap.appendChild(h('p', { class: 'office-note', text: '内容较多，仅显示前 ' + pages.length + ' 页。下载可查看完整文件。' }));
  }
  return wrap;
}

/** First non-empty paragraph of a page, used as a slide heading fallback. */
export function firstText(page) {
  for (const block of (page && page.blocks) || []) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      const text = String(block.text || '').trim();
      if (text) return text;
    }
    if (block.type === 'list' && Array.isArray(block.items) && block.items.length) {
      const text = String(block.items[0] || '').trim();
      if (text) return text;
    }
  }
  return '';
}

function describePages(office, pages, meta) {
  const parts = [];
  if (office.kind === 'slides') parts.push(pages.length + ' 张幻灯片');
  else parts.push(pages.length + ' 页');
  if (meta.wordCount) parts.push('约 ' + meta.wordCount + ' 字');
  return parts.join(' · ');
}

function renderBlock(block) {
  if (!block) return h('span');
  if (block.type === 'heading') {
    const level = Math.min(4, Math.max(1, Number(block.level) || 2));
    return h('h' + (level + 1), { class: 'office-h', text: block.text || '' });
  }
  if (block.type === 'list') {
    const items = Array.isArray(block.items) ? block.items : [];
    return h('ul', { class: 'office-list' }, items.map((item) => h('li', { text: item })));
  }
  if (block.type === 'table') {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    return h('div', { class: 'office-table-wrap' }, h('table', { class: 'office-table' },
      h('tbody', {}, rows.map((row) => h('tr', {}, (row || []).map((cell) => {
        const text = cell && typeof cell === 'object' ? cell.text : cell;
        const isHeader = cell && typeof cell === 'object' && cell.header;
        return isHeader ? h('th', { text: String(text ?? '') }) : h('td', { text: String(text ?? '') });
      })))),
    ));
  }
  if (block.type === 'image') {
    return h('p', { class: 'office-image', text: block.alt ? '［图片：' + block.alt + '］' : '［图片］' });
  }
  return h('p', { class: 'office-p', text: block.text || '' });
}

function renderSheets(office) {
  const sheets = Array.isArray(office.sheets) ? office.sheets : [];
  const meta = office.meta || {};
  const wrap = h('div', { class: 'office' });
  wrap.appendChild(h('div', { class: 'office-head' },
    h('b', { text: '工作表' }),
    h('span', { class: 'muted', text: sheets.length + ' 个' }),
  ));
  if (!sheets.length) {
    wrap.appendChild(h('div', { class: 'empty' }, h('p', { text: '这个工作簿里没有可显示的数据。' })));
    return wrap;
  }
  for (const sheet of sheets) {
    const section = h('section', { class: 'office-sheet' });
    section.appendChild(h('header', { class: 'office-page-head' }, h('b', { text: sheet.name || 'Sheet' })));
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (!rows.length) {
      section.appendChild(h('p', { class: 'muted', text: '空表。' }));
    } else {
      const body = h('tbody', {}, rows.map((row, index) => h('tr', {},
        (row || []).map((cell) => {
          const text = cell && typeof cell === 'object' ? cell.text : cell;
          return index === 0 ? h('th', { text: String(text ?? '') }) : h('td', { text: String(text ?? '') });
        }),
      )));
      section.appendChild(h('div', { class: 'office-table-wrap' }, h('table', { class: 'office-table office-grid' }, body)));
    }
    wrap.appendChild(section);
  }
  if (meta.truncated) wrap.appendChild(h('p', { class: 'office-note', text: '表格较大，仅显示前 200 行 × 50 列。下载可查看完整文件。' }));
  return wrap;
}
