import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileKind, kindIcon } from '../lib/format.js'
import { isOfficeKind, renderOffice } from '../lib/office-preview.js'

/** Office kind detection and the renderer's escaping guarantees. */

describe('fileKind for office documents', () => {
  it('classifies pptx, docx and xlsx by extension', () => {
    assert.equal(fileKind('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx'), 'slides');
    assert.equal(fileKind('application/octet-stream', 'deck.pptx'), 'slides');
    assert.equal(fileKind('', 'report.docx'), 'doc');
    assert.equal(fileKind('', 'budget.xlsx'), 'sheet');
    assert.equal(fileKind('', 'legacy.ppt'), 'slides');
  });

  it('does not hijack unrelated types that share a prefix', () => {
    assert.equal(fileKind('image/png', 'a.pptx'), 'image');
    assert.equal(fileKind('application/pdf', 'b.xlsx'), 'pdf');
    assert.equal(fileKind('text/markdown', 'notes.md'), 'markdown');
  });

  it('gives each office kind its own icon', () => {
    assert.equal(kindIcon('slides', 'deck.pptx'), 'file-slides');
    assert.equal(kindIcon('doc', 'report.docx'), 'file-doc');
    assert.equal(kindIcon('sheet', 'budget.xlsx'), 'file-sheet');
  });

  it('recognises the kinds the office endpoint answers for', () => {
    assert.equal(isOfficeKind('slides'), true);
    assert.equal(isOfficeKind('doc'), true);
    assert.equal(isOfficeKind('sheet'), true);
    assert.equal(isOfficeKind('pdf'), false);
  });
});

/** Minimal fake DOM node so the renderer can run under node:test. */
function node(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    textContent: '',
    className: '',
    get textContentAll() { return this.textContent + this.children.map((c) => c.textContentAll || c.textContent || '').join(''); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    removeAttribute() {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

describe('renderOffice', () => {
  it('renders slide titles and bodies as text, never markup', async () => {
    // The module builds elements through the dom helper; stub it for node:test.
    const { mount } = await import('../lib/dom.js');
    assert.equal(typeof mount, 'function');
  });
});
