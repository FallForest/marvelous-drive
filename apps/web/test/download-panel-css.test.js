import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * The download panel's placement contract.
 *
 * The two things a screenshot at one width cannot guarantee: that the panel is
 * its own stylesheet (it was added without touching app.css, which another
 * change was editing), and that on a narrow screen it stays in the TOP band so
 * the upload queue — which owns the bottom-right corner — never covers it.
 *
 * Geometry is measured in scripts/download-check.mjs against a live page; this
 * case only holds the rules that make that geometry possible.
 */

const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const css = (name) => readFileSync(new URL('../styles/' + name, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

const downloads = css('downloads.css')
const index = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

/** Body of the first rule whose selector is exactly `head`, brace-matched. */
function block(text, head) {
  const start = text.indexOf(head + '{')
  assert.ok(start >= 0, 'missing block ' + head)
  let depth = 0
  for (let position = start + head.length; position < text.length; position += 1) {
    if (text[position] === '{') depth += 1
    else if (text[position] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + head.length + 1, position)
    }
  }
  assert.fail('unbalanced block ' + head)
}

describe('download panel placement', () => {
  it('is loaded after the drive stylesheet without editing it', () => {
    assert.match(index, /@import '\.\/downloads\.css';/)
    const appAt = index.indexOf("@import './app.css';")
    const dlAt = index.indexOf("@import './downloads.css';")
    assert.ok(dlAt > appAt, 'the download panel overrides the app layer')
  })

  it('anchors under the topbar, opposite the upload queue corner', () => {
    const panel = block(downloads, '.downloads')
    assert.match(panel, /position:fixed/)
    assert.match(panel, /top:calc\(var\(--topbar-h\)/)
    assert.match(panel, /right:16px/)
    assert.ok(!/bottom:/.test(panel), 'the bottom edge belongs to the upload queue')
  })

  it('stays within the viewport on a phone and yields to a visible queue', () => {
    const narrow = block(downloads, '@media (max-width:700px)')
    assert.match(narrow, /\.downloads\{left:10px;right:10px;width:auto/)
    // The upload queue is appended to <body>; when it is on screen the download
    // panel shortens so the two surfaces cannot overlap on a short phone.
    assert.match(narrow, /body:has\(> \.queue:not\(\[hidden\]\)\) \.downloads\{max-height:/)
  })

  it('gives the row actions a touch target and a visible focus ring', () => {
    const actions = block(downloads, '.dl-actions')
    assert.match(actions, /display:flex/)
    assert.match(downloads, /\.dl-actions \.icon-btn\{[^}]*width:24px;height:24px;min-width:24px;min-height:24px/)
    assert.match(downloads, /\.dl-actions \.icon-btn:focus-visible\{[^}]*outline:2px solid var\(--focus-ring\)/)
    assert.match(block(downloads, '@media (max-width:700px)'), /\.dl-actions \.icon-btn\{width:28px;height:28px/)
  })

  it('never claims a percentage for an unknown total', () => {
    // The indeterminate sweep replaces the fill entirely; a width-based bar here
    // would show "about 38%" of a size the page does not know.
    const bar = block(downloads, '.dl-bar.is-indeterminate i')
    assert.match(bar, /animation:motion-indeterminate/)
    assert.match(bar, /width:38%/)
    const entry = block(downloads, '.dl-entry-bar.is-indeterminate i')
    assert.match(entry, /animation:motion-indeterminate/)
  })

  it('spends only tokens on motion', () => {
    for (const match of downloads.matchAll(/(?:animation|transition):([^;]+);/g)) {
      const value = match[1].replace(/var\([^)]*\)/g, '')
      assert.ok(!/\d*\.?\d+m?s\b/.test(value), 'literal duration in ' + match[1].trim())
      assert.ok(!/\b(ease|ease-in-out)\b/.test(value), 'literal easing in ' + match[1].trim())
    }
    assert.match(tokens, /--z-panel:/)
  })
})
