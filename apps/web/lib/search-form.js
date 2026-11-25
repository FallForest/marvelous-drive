import {h} from './dom.js';
import {routePath, ancestorPath} from './state.js';

const KIND_OPTIONS = [
  ['', '全部类型'],
  ['folder', '文件夹'],
  ['image', '图片'],
  ['pdf', 'PDF'],
  ['document', '文档'],
  ['sheet', '表格'],
  ['slides', '演示文稿'],
  ['video', '视频'],
  ['audio', '音频'],
  ['archive', '压缩包'],
  ['code', '代码'],
  ['other', '其他'],
];

const SCOPE_OPTIONS = [
  ['all', '全部'],
  ['name', '名称'],
  ['content', '内容'],
];

const FORM_STYLE = [
  'display:flex',
  'flex-wrap:wrap',
  'align-items:flex-end',
  'gap:10px',
  'width:100%',
  'max-width:100%',
  'min-width:0',
  'box-sizing:border-box',
  'padding:0 16px',
].join(';');

const FIELD_STYLE = [
  'display:flex',
  'flex-direction:column',
  'gap:4px',
  'flex:1 1 130px',
  'min-width:0',
  'max-width:100%',
  'box-sizing:border-box',
].join(';');

const CONTROL_STYLE = 'width:100%;min-width:0;max-width:100%;box-sizing:border-box;';

const ACTIONS_STYLE = [
  'display:flex',
  'flex-direction:row',
  'flex-wrap:wrap',
  'gap:8px',
  'flex:1 1 100%',
  'min-width:0',
  'box-sizing:border-box',
].join(';');

function dateValue(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localStartIso(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function option(value, label, selected) {
  return h('option', {value, selected}, label);
}

function field(label, control) {
  const isSearch = !!(control && control.type === 'search');
  return h(
    'label',
    {class: 'field', style: isSearch ? `${FIELD_STYLE};flex-basis:100%` : FIELD_STYLE},
    h('span', {class: 'field-label'}, label),
    control,
  );
}

export function renderSearchForm(ctx) {
  const route = (ctx && ctx.state && ctx.state.route) || {};
  const byId = ctx && ctx.index ? ctx.index.byId : null;

  const folders = [...(byId ? byId.values() : [])]
    .filter((node) => node && node.kind === 'folder')
    .map((node) => {
      const id = String(node.id);
      const path = ancestorPath(ctx.index, node.id).map((item) => item.name).join(' / ');
      return {id, path: path || node.name || id};
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));

  const routeQuery = route.query == null ? '' : String(route.query);
  const routeFolderId = route.folderId == null ? '' : String(route.folderId);
  const folderId = folders.some((folder) => folder.id === routeFolderId) ? routeFolderId : '';
  const staleFolderId = routeFolderId && !folderId ? routeFolderId : '';
  const routeKind = route.kind == null ? '' : String(route.kind);
  const kind = KIND_OPTIONS.some(([value]) => value === routeKind) ? routeKind : '';
  const routeScope = route.scope == null ? 'all' : String(route.scope);
  const scope = SCOPE_OPTIONS.some(([value]) => value === routeScope) ? routeScope : 'all';

  const queryInput = h('input', {
    class: 'input',
    type: 'search',
    name: 'q',
    value: routeQuery,
    placeholder: '输入关键词',
    autocomplete: 'off',
    style: CONTROL_STYLE,
  });

  const folderSelect = h(
    'select',
    {class: 'input', name: 'folderId', style: CONTROL_STYLE},
    option('', '整个网盘', folderId === '' && !staleFolderId),
    ...(staleFolderId
      ? [option(staleFolderId, '当前文件夹（不在列表中）', folderId === '' && !!staleFolderId)]
      : []),
    ...folders.map((folder) => option(folder.id, folder.path, folder.id === folderId)),
  );
  folderSelect.value = folderId || staleFolderId;

  const kindSelect = h(
    'select',
    {class: 'input', name: 'kind', style: CONTROL_STYLE},
    ...KIND_OPTIONS.map(([value, label]) => option(value, label, value === kind)),
  );
  kindSelect.value = kind;

  const updatedAfterInput = h('input', {
    class: 'input',
    type: 'date',
    name: 'updatedAfter',
    value: dateValue(route.updatedAfter),
    style: CONTROL_STYLE,
  });

  const scopeSelect = h(
    'select',
    {class: 'input', name: 'scope', style: CONTROL_STYLE},
    ...SCOPE_OPTIONS.map(([value, label]) => option(value, label, value === scope)),
  );
  scopeSelect.value = scope;

  const submitButton = h('button', {class: 'btn', type: 'submit'}, '搜索');
  const clearButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      title: '清除筛选并保留关键词',
      'aria-label': '清除筛选并保留关键词',
    },
    '清除筛选',
  );

  const form = h(
    'form',
    {class: 'search-form', role: 'search', style: FORM_STYLE},
    field('关键词', queryInput),
    field('文件夹', folderSelect),
    field('文件类型', kindSelect),
    field('更新于之后', updatedAfterInput),
    field('匹配方式', scopeSelect),
    h('div', {class: 'field search-form-actions', style: ACTIONS_STYLE}, submitButton, clearButton),
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ctx.navigate(routePath({
      name: 'search',
      query: queryInput.value,
      folderId: folderSelect.value,
      kind: kindSelect.value,
      updatedAfter: localStartIso(updatedAfterInput.value),
      scope: scopeSelect.value,
    }));
  });

  clearButton.addEventListener('click', () => {
    folderSelect.value = '';
    kindSelect.value = '';
    updatedAfterInput.value = '';
    scopeSelect.value = 'all';

    ctx.navigate(routePath({
      name: 'search',
      query: queryInput.value,
      folderId: '',
      kind: '',
      updatedAfter: '',
      scope: 'all',
    }));
  });

  return form;
}
