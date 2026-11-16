import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * The stylesheet contract behind the responsive and contrast fixes.
 *
 * Every assertion here guards something that is invisible in a screenshot and
 * silent in the console: a global min-width that turned a 320px viewport into a
 * sideways-scrolling canvas, a login card that centred itself out of reach on a
 * short screen, an unchecked checkbox at 1.65:1, and action buttons that only
 * existed while the pointer was over the row. Reading the CSS is the cheapest
 * way to keep them from coming back; the geometry itself is measured in the
 * browser, not here.
 */

const read = (name) => readFileSync(new URL('../styles/' + name, import.meta.url), 'utf8')

const base = read('base.css')
const app = read('app.css')
const components = read('components.css')
const tokens = read('tokens.css')

const css = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Body of the at-rule or rule whose selector is exactly `head`, brace-matched.
 *
 * A lazy regex up to the next `\n}` stops at the first single-line rule inside
 * the block, which is how an earlier version of this file "checked" a media
 * query by reading eleven lines of an unrelated one.
 */
function block(text, head, { last = false } = {}) {
  // Some heads recur: the 880px drawer block in app.css is preceded by a
  // one-line ".gcard .card-pick" media query with the same condition.
  const start = last ? text.lastIndexOf(head + '{') : text.indexOf(head + '{')
  assert.ok(start >= 0, 'missing block ' + head)
  let depth = 0
  for (let index = start + head.length; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + head.length + 1, index)
    }
  }
  assert.fail('unbalanced block ' + head)
}

/** Value of a custom property inside :root, as declared. */
function token(name) {
  const match = new RegExp('--' + name + ':\\s*([^;]+);').exec(tokens)
  assert.ok(match, 'tokens.css must declare --' + name)
  return match[1].trim()
}

/* ── WCAG 2.x relative luminance, straight from the specification ─── */
const channels = (hex) => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return full.match(/../g).map((pair) => parseInt(pair, 16))
}
const linear = (channel) => {
  const scaled = channel / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
const luminance = (hex) => {
  const [r, g, b] = channels(hex)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

describe('UI17: narrow viewports reflow instead of being forced to 360px', () => {
  const body = /body\s*\{([\s\S]*?)\}/.exec(css(base))[1]

  it('does not pin the page to a 360px canvas', () => {
    // min-width on body is what made 320px scroll sideways and clip the row end
    assert.ok(!/min-width\s*:\s*360px/.test(body), 'body must not declare min-width:360px')
    assert.ok(!/min-width\s*:/.test(body), 'body must not declare a min-width at all')
  })

  it('declares a <=360px block that retunes the list and the toolbar', () => {
    const narrow = block(css(app), '@media (max-width:360px)')
    // the toolbar already wraps at every width; the block only tightens it
    assert.match(block(css(app), '.toolbar'), /flex-wrap:wrap/)
    // the overflow button owns every per-file action, so it keeps its track
    assert.match(narrow, /\.frow \.more\{/)
    assert.match(narrow, /grid-template-columns:18px minmax\(0,1fr\) 26px/)
  })

  it('leaves the drawer sidebar and its scrim alone', () => {
    const drawer = block(css(base), '@media (max-width:880px)')
    assert.match(drawer, /\.sidebar\{/)
    assert.match(drawer, /transform:translateX\(-100%\)/)
    assert.match(css(base), /\.app-shell\.nav-open\s+\.sidebar\{transform:none/)
    assert.match(css(base), /\.app-shell\.nav-open::after\{opacity:1;pointer-events:auto\}/)
  })
})

describe('UI18: the login card scrolls on a short viewport', () => {
  const shell = /\.auth-shell\{([\s\S]*?)\}/.exec(css(base))[1]
  const card = /\.auth-card\{([\s\S]*?)\}/.exec(css(base))[1]

  it('is a flex centring box, not a grid that centres by overflow', () => {
    assert.match(shell, /display:flex/)
    assert.ok(!/place-items:center/.test(shell), 'place-items:center on a scroll container hides the card top')
    assert.match(shell, /overflow-y:auto/)
    assert.match(shell, /height:100dvh/)
  })

  it('centres the card with an auto margin so nothing is clipped away', () => {
    // auto margins absorb free space and collapse to 0, which is what keeps the
    // top of the card reachable at 390x280
    assert.match(card, /margin:auto/)
  })
})

describe('UI19: input borders clear the 3:1 non-text contrast floor', () => {
  it('defines a dedicated control-border token', () => {
    assert.ok(/#[0-9a-f]{6}/i.test(token('control-border')))
    assert.notEqual(token('control-border'), token('border-strong'))
  })

  it('clears 3:1 against every surface it can sit on', () => {
    const border = token('control-border')
    for (const surface of ['bg', 'surface', 'surface-2', 'surface-3', 'hover']) {
      const ratio = contrast(border, token(surface))
      assert.ok(ratio >= 3, border + ' on --' + surface + ' is ' + ratio.toFixed(2) + ':1')
    }
  })

  it('is the border the checkbox and the fields actually use', () => {
    const pick = /\.pick\{([\s\S]*?)\}/.exec(css(app))[1]
    assert.match(pick, /border:1\.5px solid var\(--control-border\)/)
    // the unchecked box sits on --surface, where --border-strong measures 1.65:1
    const field = /\.input,\.textarea\{([\s\S]*?)\}/.exec(css(components))[1]
    assert.match(field, /border:1px solid var\(--control-border\)/)
    const select = /\.select\{([\s\S]*?)\}/.exec(css(components))[1]
    assert.match(select, /border:1px solid var\(--control-border\)/)
  })

  it('keeps the checked fill and the white mark unchanged', () => {
    assert.match(css(app), /\.pick:checked,\.pick:indeterminate\{background:var\(--accent-solid\);border-color:var\(--accent-solid\)\}/)
    assert.match(css(app), /\.pick:checked::after\{[^}]*solid #fff/)
  })
})

describe('UI20: queue actions are 24px targets with room between them', () => {
  it('sizes the button and its glyph up', () => {
    // width/height alone were not enough: the actions row is a flex line inside a
    // narrow panel, and a shrinkable 24px button measured 23.3px at 390px wide.
    assert.match(css(app), /\.qitem \.icon-btn\{[^}]*width:24px;height:24px;min-width:24px;min-height:24px;flex:0 0 auto\}/)
    assert.match(css(app), /\.qitem \.icon-btn svg\{width:13px;height:13px\}/)
  })

  it('keeps at least 4px between actions', () => {
    const actions = /\.qactions\{([\s\S]*?)\}/.exec(css(app))[1]
    const gap = Number(/gap:(\d+)px/.exec(actions)[1])
    assert.ok(gap >= 4, 'gap was ' + gap + 'px; 24 + 4 is the floor for centre-to-centre')
  })

  it('lets the row grow instead of clipping the taller buttons', () => {
    assert.match(css(app), /\.qactions\{[^}]*flex-wrap:wrap/)
    assert.match(css(app), /\.qitem\{[^}]*gap:4px 8px/)
  })

  it('keeps a focus ring on the larger buttons', () => {
    assert.match(css(app), /\.qitem \.qactions \.icon-btn:focus-visible\{[^}]*outline:2px solid var\(--focus-ring\)/)
  })
})

describe('UI21: row and card actions are visible without hover', () => {
  it('reveals the overflow button when it is focused', () => {
    // it had focus-visible on the star only, so the button that opens every
    // per-file action stayed at opacity:0 while a keyboard user stood on it
    assert.match(css(app), /\.frow \.more:focus-visible/)
    assert.match(css(app), /\.frow:focus-within \.star,\.frow:focus-within \.more/)
  })

  it('reveals the card actions on focus-within', () => {
    assert.match(css(app), /\.gcard:focus-within \.gactions/)
  })

  it('paints them permanently where there is no hover', () => {
    const touch = block(css(app), '@media (hover:none)')
    assert.match(touch, /\.frow \.star,\.frow \.more\{opacity:1\}/)
    assert.match(touch, /\.gcard \.gactions\{opacity:1\}/)
  })

  it('does not change the "a tap may select first" rule', () => {
    // the touch checkbox rule is a separate decision and stays where it was
    const drawer = block(css(app), '@media (max-width:880px)', { last: true })
    assert.match(drawer, /\.row-pick\{opacity:1\}/)
  })
})
