/*
 * highlight.js — a tiny, dependency-free syntax highlighter for the preview.
 *
 * Two hard requirements shape it:
 *   1. it must never inject markup — every token is escaped, and the output is
 *      built as a string of safe spans rather than by mutating parsed HTML;
 *   2. it must be tiny and boring. This is not a parser: it tokenises a handful
 *      of lexical categories (comment, string, number, keyword, punctuation)
 *      which is enough to make code readable in a preview pane, and it degrades
 *      to plain escaped text for any language it does not know.
 *
 * Supported by name: js/ts/json/css/html/md/sh/sql/py/go/rs/java/yaml/toml.
 * Everything else falls through to escape-only.
 */

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof delete in of null undefined true false yield static get set',
  ts: 'const let var function return if else for while do switch case break continue new class extends super this import export from default async await try catch finally throw typeof instanceof delete in of null undefined true false yield static get set interface type enum implements readonly public private protected as satisfies keyof infer never unknown any',
  py: 'def class return if elif else for while break continue import from as with try except finally raise lambda pass None True False and or not in is global nonlocal yield assert del async await',
  go: 'package import func return if else for range switch case break continue defer go chan select map struct interface type var const nil true false',
  rs: 'fn let mut pub use mod struct enum impl trait for while loop match if else return self Self true false const static async await move ref where',
  java: 'public private protected class interface extends implements static final void int long double float boolean char String new return if else for while switch case break continue try catch finally throw import package this super null true false',
  sh: 'if then else elif fi for while do done case esac function return export local readonly echo cd ls cp mv rm mkdir source set unset exit trap',
  sql: 'select from where join left right inner outer group by order having limit offset insert into values update set delete create table alter drop index primary key foreign references not null and or as distinct union all',
  css: 'important media supports keyframes font-face import charset root',
  yaml: 'true false null yes no on off',
  toml: 'true false',
};

const EXTENSION_LANGUAGE = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts',
  json: 'js',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  md: 'md', markdown: 'md',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  sql: 'sql',
  py: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml',
};

/** Language id for a file name, or '' when the file is not code we colour. */
export function languageOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  if (!match) return '';
  return EXTENSION_LANGUAGE[match[1].toLowerCase()] || '';
}

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SPAN = (className, text) => '<span class="tok-' + className + '">' + escapeHtml(text) + '</span>';

/**
 * Highlights `source` as `language`.
 *
 * Returns HTML built only from escaped text and a fixed set of span classes, so
 * a file containing `<script>` cannot execute inside the preview drawer.
 */
export function highlight(source, language, options) {
  const opts = options || {};
  const text = String(source === undefined || source === null ? '' : source);
  const lang = String(language || '');
  const keywords = new Set((KEYWORDS[lang] || '').split(/\s+/).filter(Boolean));
  if (!keywords.size && lang !== 'html' && lang !== 'css' && lang !== 'md') {
    return escapeHtml(text);
  }

  const lineComment = lang === 'py' || lang === 'sh' || lang === 'yaml' || lang === 'toml' ? '#' : '//';
  let out = '';
  let index = 0;
  const push = (className, value) => { out += className ? SPAN(className, value) : escapeHtml(value); };

  while (index < text.length) {
    const rest = text.slice(index);
    const char = rest[0];

    // Line comment: everything to the end of the line.
    if (rest.startsWith(lineComment)) {
      const end = rest.indexOf('\n');
      const stop = end === -1 ? text.length : index + end;
      push('comment', text.slice(index, stop));
      index = stop;
      continue;
    }
    // Block comment.
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      const stop = end === -1 ? text.length : index + end + 2;
      push('comment', text.slice(index, stop));
      index = stop;
      continue;
    }
    // HTML comment.
    if (lang === 'html' && rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      const stop = end === -1 ? text.length : index + end + 3;
      push('comment', text.slice(index, stop));
      index = stop;
      continue;
    }
    // Strings: ' " `
    if (char === '"' || char === "'" || char === '`') {
      let stop = index + 1;
      while (stop < text.length) {
        if (text[stop] === '\\') { stop += 2; continue; }
        if (text[stop] === char) { stop += 1; break; }
        if (text[stop] === '\n' && char !== '`') break;
        stop += 1;
      }
      push('string', text.slice(index, Math.min(stop, text.length)));
      index = Math.min(stop, text.length);
      continue;
    }
    // Numbers.
    if (/[0-9]/.test(char) && !/[A-Za-z0-9_$]/.test(text[index - 1] || '')) {
      const match = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
      push('number', match[0]);
      index += match[0].length;
      continue;
    }
    // Words: keyword, tag, or plain identifier.
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      const word = match[0];
      if (keywords.has(word)) push('keyword', word);
      else if (lang === 'html' && /^<\/?$/.test(text.slice(Math.max(0, index - 2), index))) push('tag', word);
      else push('', word);
      index += word.length;
      continue;
    }
    push('', char);
    index += 1;
  }
  if (opts.limit && out.length > opts.limit) return escapeHtml(text);
  return out;
}
