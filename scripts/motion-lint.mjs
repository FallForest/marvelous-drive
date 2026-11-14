#!/usr/bin/env node
/**
 * Static motion linter — vendored from the ios-motion-ui skill.
 *
 *   node scripts/motion-lint.mjs apps/web/styles
 *
 * Vendored rather than imported from the skill directory so CI and any teammate
 * can run it without the skill installed. If the upstream skill changes, re-copy
 * this file: the rules are the deliverable, not the code.
 *
 * It parses CSS as blocks, not lines, so an `animation: … both` on an exit is
 * distinguished from the same declaration on an entrance. Exit code 1 on any
 * finding, so it drops into CI unchanged.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.output']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(css|scss|tsx?|jsx?|vue|svelte)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(root).map((path) => ({
  path: relative(root, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));

/**
 * Blanks comments instead of deleting them.
 *
 * Deleting a block comment collapses dozens of lines, so every reported line
 * number would point at the wrong place — and worse, it makes prose look like
 * code, which is how the first version of this linter reported the explanatory
 * comment above a rule as a violation of that rule. Replacing each comment
 * character with a space keeps offsets exact and content inert.
 */
const code = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, (comment) => comment.replace(/[^\n]/g, ' '))

/**
 * Parses top-level CSS rules into { selector, body, line }.
 *
 * Rules are matched as blocks, not as lines. Line matching was the first
 * version's mistake: a declaration has no meaning without its selector, so
 * `animation: ... both` looked the same on an entrance and on an exit, and
 * a correctly scoped transition rule looked like a document-wide one.
 */
function parseRules(text) {
  const source = code(text);
  const rules = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    if (open === -1) break;
    // Match braces, not the next '}': an @media block contains rules of its own,
    // so the first closing brace belongs to the inner rule and truncating there
    // silently drops everything the media query wraps.
    let depth = 0;
    let close = -1;
    for (let scan = open; scan < source.length; scan++) {
      if (source[scan] === '{') depth++;
      else if (source[scan] === '}') {
        depth--;
        if (depth === 0) { close = scan; break; }
      }
    }
    if (close === -1) break;
    const selector = source.slice(index, open).trim();
    const body = source.slice(open + 1, close);
    const line = source.slice(0, open).split('\n').length;
    // @media / @supports wrappers are transparent: descend into them so a
    // rule inside a media query is attributed to its real selector.
    if (selector.startsWith('@') && /media|supports|layer|container/.test(selector)) {
      for (const rule of parseRules(source.slice(open + 1, close))) {
        rules.push({ selector: rule.selector, body: rule.body, line: line + rule.line - 1, atRule: selector });
      }
      index = close + 1;
      continue;
    }
    if (selector) rules.push({ selector: selector, body: body, line: line, atRule: '' });
    index = close + 1;
  }
  return rules;
}

const findings = [];

/**
 * A rule opts out with `motion-check-ignore` on or above the declaration.
 *
 * Some layout animations are the honest choice — a progress bar's width is
 * more truthful than a mirrored scale, because a scaled bar distorts its own
 * corner radius. The exemption is explicit so the next reader knows the
 * decision was made rather than missed.
 */
const IGNORE = /motion-check-ignore/;
const report = (rule, file, line, detail) => findings.push({ rule: rule, file: file, line: line, detail: detail });
const cssFiles = files.filter((f) => /\.(css|scss)$/.test(f.path));
const codeFiles = files.filter((f) => /\.(tsx?|jsx?|vue|svelte)$/.test(f.path));
/**
 * Rule 1 — an ENTRANCE must fill backwards, never both.
 *
 * `both` keeps the final transform applied after the animation. Entrances
 * end on a neutral value so nothing looks wrong today, but the retained
 * frame outranks :hover and :active (the control silently stops responding)
 * and it pins a compositor layer per animated row. Exits are exempt: holding
 * their end state is exactly what they are for.
 */
// Name-based detection cannot work alone: a project invents its own keyframe
// names (fade-up, slide-in, card-appear) and those are exactly the ones that
// get `both` by accident. So an animation also counts as an entrance when it is
// NOT an obvious exit and it is the animation on a rule that is not a
// closing/leaving state.
// Only the keyframe NAME decides direction. The full animation shorthand also
// contains the easing, and matching `out` against `ease-out` would classify
// every entrance as an exit.
const EXIT_NAME = /(^|[^a-z])(out|leave|closing|dismiss|exit|hide|collapse|shrink|fade-?out)\b/i;
const hasExitName = (selector, shorthand) => {
  const keyframe = shorthand.trim().split(/\s+/)[0];
  return EXIT_NAME.test(keyframe) || EXIT_NAME.test(selector.replace(/ease-out/g, ''));
};

// View-transition pseudo elements are not components: they have no :hover or
// :active to lose, so holding their end state is correct.
const isTransitionPseudo = (selector) => /^::view-transition-/.test(selector.trim());
for (const file of cssFiles) {
  for (const rule of parseRules(file.text)) {
    const animation = /animation\s*:\s*([^;]+)/.exec(rule.body);
    if (!animation) continue;
    if (!/\bboth\b/.test(animation[1])) continue;
    if (isTransitionPseudo(rule.selector)) continue;
    if (hasExitName(rule.selector, animation[1])) continue;
    report('entry-fill', file.path, rule.line, 'selector [' + rule.selector.slice(0, 56) + '] fills both; entrance animations fill backwards');
  }
}

/**
 * Rule 2 — will-change must not be permanent.
 *
 * A standing promotion keeps a compositor layer for the element's whole
 * life and can rasterise a subpixel differently from inline rendering, which
 * reads as a flash when the element switches modes. Correct pattern: put the
 * hint on a class that only exists while the animation runs.
 */
const ANIMATING_CLASS = /\.(is-animating|is-playing|animating|is-entering|is-leaving)/;
for (const file of cssFiles) {
  for (const rule of parseRules(file.text)) {
    if (!/will-change\s*:\s*(transform|opacity|filter|all)/.test(rule.body)) continue;
    if (ANIMATING_CLASS.test(rule.selector)) continue;
    report('permanent-will-change', file.path, rule.line, 'selector [' + rule.selector.slice(0, 56) + '] promotes permanently; move it into an .is-animating class');
  }
}

/**
 * Rule 3 — never transition a property that triggers layout.
 */
for (const file of cssFiles) {
  for (const rule of parseRules(file.text)) {
    const transition = /transition\s*:\s*([^;]+)/.exec(rule.body);
    if (!transition) continue;
    if (/max-height|grid-template-rows/.test(transition[1])) continue;
    const match = /\b(width|height|top|left|right|bottom|margin|padding)\b/.exec(transition[1]);
    if (!match) continue;
    // A rule may opt out with a comment, so a deliberate choice is not
    // reported forever. Read the few lines above the declaration.
    const around = file.text.split('\n').slice(Math.max(0, rule.line - 6), rule.line + 2).join('\n');
    if (IGNORE.test(around)) continue;
    report('layout-animation', file.path, rule.line, 'selector [' + rule.selector.slice(0, 56) + '] transitions ' + match[1] + '; animate transform instead');
  }
}

/**
 * Rule 4 — timings and curves come from tokens.
 * A literal 0.2s or ease-out cannot be retuned with the rest of the app.
 */
const TOKEN_FILES = /(tokens|_tokens|variables|theme|motion)\.(css|scss)$/;
for (const file of cssFiles) {
  if (TOKEN_FILES.test(file.path)) continue;
  for (const rule of parseRules(file.text)) {
    const timing = /(?:transition|animation)\s*:\s*([^;]+)/.exec(rule.body);
    if (!timing) continue;
    const value = timing[1].replace(/var\([^)]*\)/g, '');
    if (!/animation-delay/.test(rule.body)) {
      // Compare in milliseconds: 0.2s is 200ms. Testing the raw number against
      // a single threshold would let every sub-second value (which is most of
      // them) through, because 0.2 is not greater than 1.
      const duration = /(\d*\.?\d+)(m?s)\b/.exec(value);
      if (duration) {
        const ms = duration[2] === 's' ? Number(duration[1]) * 1000 : Number(duration[1]);
        if (ms > 1) {
          report('hard-coded-duration', file.path, rule.line, 'selector [' + rule.selector.slice(0, 46) + '] uses literal ' + duration[0] + '; use a --duration-* token');
        }
      }
    }
    const easing = /(?:^|[^\w-])(ease|ease-in|ease-out|ease-in-out)(?![\w-])/.exec(value);
    if (easing) report('hard-coded-easing', file.path, rule.line, 'selector [' + rule.selector.slice(0, 46) + '] uses literal easing; use an --ease-* token');
  }
}
/**
 * Rule 5 — duplicate focus indicators.
 *
 * A bordered wrapper that paints :focus-within plus an input that also takes
 * the global :focus-visible outline gives two rectangles; the inner one also
 * covers whatever sits at the end of the box (a shortcut hint, a unit label).
 * Correct pattern: the wrapper paints, the field is suppressed.
 */
const wrapperPaints = cssFiles.some((f) => parseRules(f.text).some((r) => /:focus-within/.test(r.selector) && /border-color|box-shadow|outline/.test(r.body)));
const suppressesInner = cssFiles.some((f) => parseRules(f.text).some((r) => /(input|textarea)[^{]*:focus-visible/.test(r.selector) && /outline\s*:\s*none/.test(r.body)));
if (wrapperPaints && !suppressesInner) {
  report('double-focus', '(project)', 0, 'a wrapper paints :focus-within but nothing sets the inner input outline to none');
}

/**
 * Rule 6 — view-transition suppression must be scoped to the swapped surface.
 *
 * Scoping it to html mutes every list in the app for the length of the
 * transition; when the flag clears the rows restart from opacity 0, and the
 * sidebar blinks after each navigation.
 */
for (const file of cssFiles) {
  for (const rule of parseRules(file.text)) {
    if (!/active-view-transition|data-vt-swapping/.test(rule.selector)) continue;
    if (!/\.stagger|\.motion-enter/.test(rule.selector)) continue;
    if (/data-vt-scope|main-content/.test(rule.selector)) continue;
    report('transition-overreach', file.path, rule.line, 'selector [' + rule.selector.slice(0, 56) + '] mutes the whole document; scope it to the swapped surface');
  }
}

/**
 * Rule 7 — a page root must not declare its own animation.
 *
 * A page carrying `animation:` cannot be muted by a class the motion layer
 * owns, so a view transition replays it and the content arrives twice.
 */
// A page root is matched by what it ENDS with, not by a prefix list: projects
// name them .home-dashboard, .app-page, .login-screen, .admin-shell. A prefix
// whitelist misses most of them, which makes the rule silently useless.
// The separator before the suffix is `-`, not `.`: `.app-page`, not `.page`.
const PAGE_ROOT = /[.\s-](page|screen|dashboard|view|shell|layout)([-.][a-z]+)?$/;
//
// The mistake is not "this element animates" — it is "this element animates
// WITHOUT going through the shared class", because the motion layer can only
// mute what it owns. `.home-dashboard.motion-enter` is the correct form;
// `.home-dashboard{animation:...}` is the bug.
for (const file of cssFiles) {
  for (const rule of parseRules(file.text)) {
    const selector = rule.selector.split(',').map((s) => s.trim()).find((s) => PAGE_ROOT.test(s));
    if (!selector) continue;
    if (!/animation\s*:/.test(rule.body)) continue;
    if (/\.motion-(enter|rise|sink|sheet|fade|disclose)|\[data-vt-scope/.test(selector)) continue;
    report('page-root-animation', file.path, rule.line, 'selector [' + selector.slice(0, 50) + '] animates itself; use .motion-enter so it can be muted');
  }
}
/**
 * Rule 8 — stagger index capped where the list is rendered.
 *
 * Ten items 28ms apart is 280ms; twenty is over half a second before the last
 * row appears, and the user is waiting for the UI.
 */
for (const file of codeFiles) {
  if (/lib\/motion|motion\.(ts|js)$/.test(file.path)) continue;
  const text = code(file.text);
  // Any guard on the same line, or a constant that caps it, counts.
  text.split('\n').forEach((line, index) => {
    if (!/staggerStyle\s*\(/.test(line)) return;
    if (/Math\.(min|max)|LIMIT|MAX|cap|clamp/.test(line)) return;
    const arg = /staggerStyle\s*\(([^)]*)\)/.exec(line);
    report('uncapped-stagger', file.path, index + 1, 'staggerStyle(' + (arg ? arg[1].trim() : '...') + ') has no cap; clamp it');
  });
}

/**
 * Rule 9 — a dismissal must not be slower than its entrance.
 */
for (const file of cssFiles) {
  for (const rule of parseRules(file.text)) {
    if (!/(leave|closing|exiting|dismiss)/i.test(rule.selector)) continue;
    const decl = /(?:animation|transition)\s*:\s*([^;]+)/.exec(rule.body);
    if (!decl) continue;
    if (!/--duration-slow|--duration-lazy/.test(decl[1])) continue;
    report('slow-exit', file.path, rule.line, 'selector [' + rule.selector.slice(0, 50) + '] dismisses slowly; exits should be quicker than entrances');
  }
}

/**
 * Rule 10 — JS animation must respect prefers-reduced-motion.
 *
 * requestAnimationFrame for measurement is not animation, so only smooth
 * scrolling and the Web Animations API count here.
 */
for (const file of codeFiles) {
  const text = code(file.text);
  const animates = /scrollIntoView\s*\([^)]*smooth|behavior\s*:\s*['\"]smooth|\banimate\s*\(/.test(text);
  if (!animates) continue;
  const checks = /prefersReducedMotion|prefers-reduced-motion|useReducedMotion|reducedMotion/.test(text);
  if (!checks) report('ignores-reduced-motion', file.path, 0, 'drives animation from JS without checking prefers-reduced-motion');
}
/**
 * Rule 11 — @media nested inside @media.
 *
 * Invalid CSS, and a silent one: the parser drops the inner block, the outer
 * block continues, and every declaration after the dropped block stops applying
 * with no warning in any console. A phone-touch stylesheet that "did not work"
 * is usually this.
 *
 * `@media { @supports { ... } }` is valid and is the preferred order, so only
 * media-inside-media is reported.
 */
for (const file of cssFiles) {
  const text = code(file.text);
  // A stack of at-rule names with the brace depth at which each one opened.
  // Popping on every `}` is wrong: an inner rule closes first and would remove
  // the enclosing @media from the stack, so the next @media looked top-level.
  const open = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      const prior = text.slice(Math.max(0, index - 200), index);
      const at = prior.lastIndexOf('@');
      const head = at >= 0 ? prior.slice(at) : '';
      const atName = head && head.indexOf('{') < 0 && head.indexOf('}') < 0 ? (head.match(/^@([a-z-]+)/) || [])[1] : undefined;
      depth++;
      if (atName) {
        if (atName === 'media' && open.some((entry) => entry.name === 'media')) {
          report('nested-media', file.path, text.slice(0, index).split('\n').length, '@media nested inside @media; the parser drops the inner block');
          break;
        }
        open.push({ name: atName, depth: depth });
      }
    } else if (char === '}') {
      if (open.length && open[open.length - 1].depth === depth) open.pop();
      depth--;
    }
    index++;
  }
}
/* ── reporting ─────────────────────────────────────────────────── */
const ORDER = ['entry-fill', 'permanent-will-change', 'layout-animation', 'hard-coded-duration', 'hard-coded-easing', 'double-focus', 'nested-media', 'transition-overreach', 'page-root-animation', 'uncapped-stagger', 'slow-exit', 'ignores-reduced-motion'];
findings.sort((a, b) => ORDER.indexOf(a.rule) - ORDER.indexOf(b.rule) || a.file.localeCompare(b.file));

if (!findings.length) {
  console.log('motion-lint: clean (' + files.length + ' files scanned)');
  process.exit(0);
}

let current = '';
for (const finding of findings) {
  if (finding.rule !== current) {
    current = finding.rule;
    console.log('');
    console.log('-- ' + current + ' --');
  }
  const where = finding.line ? finding.file + ':' + finding.line : finding.file;
  console.log('  ' + where);
  console.log('    ' + finding.detail);
}

console.log('');
console.log(findings.length + ' finding(s) in ' + files.length + ' files');
console.log('motion-lint: a finding is a bug that already shipped once — see docs/UI-MOTION.md');
process.exit(1);