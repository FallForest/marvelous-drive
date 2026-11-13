import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeHtml, highlight, languageOf } from '../lib/highlight.js';

/**
 * The highlighter must be useful *and* harmless: the preview drawer inserts its
 * output with innerHTML, so anything that is not escaped text is a script
 * injection waiting for a file name.
 */

describe('languageOf', () => {
  it('maps extensions to a language id', () => {
    assert.equal(languageOf('app.js'), 'js');
    assert.equal(languageOf('main.ts'), 'ts');
    assert.equal(languageOf('DATA.JSON'), 'js');
    assert.equal(languageOf('notes.py'), 'py');
    assert.equal(languageOf('run.sh'), 'sh');
    assert.equal(languageOf('style.css'), 'css');
    assert.equal(languageOf('index.html'), 'html');
  });

  it('returns nothing for a file it cannot colour', () => {
    assert.equal(languageOf('photo.png'), '');
    assert.equal(languageOf('README'), '');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });
});

describe('highlight', () => {
  it('colours comments, strings and keywords', () => {
    const html = highlight('// note\nconst x = "hi";', 'js');
    assert.match(html, /tok-comment/);
    assert.match(html, /tok-keyword/);
    assert.match(html, /tok-string/);
  });

  it('never lets raw markup through', () => {
    const html = highlight('const evil = "<img src=x onerror=alert(1)>";', 'js');
    assert.ok(!html.includes('<img'), html);
    assert.match(html, /&lt;img/);
  });

  it('escapes a file that is entirely markup', () => {
    const html = highlight('<script>alert(1)</script>', 'js');
    assert.ok(!html.includes('<script'), html);
  });

  it('falls back to plain escaped text for an unknown language', () => {
    const html = highlight('SELECT * FROM t;', 'cobol');
    assert.equal(html, 'SELECT * FROM t;');
  });

  it('handles block comments and escapes inside strings', () => {
    const html = highlight('/* a */ const s = "a\\"b";', 'js');
    assert.match(html, /tok-comment[^<]*<\/span>|tok-comment/);
    assert.match(html, /tok-string/);
  });

  it('colours numbers but not the digits inside identifiers', () => {
    const html = highlight('const a1 = 42;', 'js');
    assert.match(html, /tok-number">42/);
    assert.ok(!/tok-number">1/.test(html));
  });

  it('uses # for python and sh comments, // for js', () => {
    assert.match(highlight('# comment\nx = 1', 'py'), /tok-comment/);
    assert.match(highlight('# comment\necho hi', 'sh'), /tok-comment/);
    assert.ok(!/#/.test(highlight('// c\nlet a', 'js').replace(/<[^>]+>/g, '')), 'js must not treat # as a comment');
  });

  it('terminates a string that never closes', () => {
    const html = highlight('const a = "unterminated', 'js');
    assert.match(html, /tok-string/);
  });

  it('is linear enough for a big file', () => {
    const source = 'const value = 1;\n'.repeat(20000);
    const started = Date.now();
    const html = highlight(source, 'js');
    assert.ok(html.length > source.length);
    assert.ok(Date.now() - started < 2000, 'a 300 KB file must not take seconds');
  });
});
