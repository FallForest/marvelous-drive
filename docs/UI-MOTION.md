# UI motion

Motion is a layer of this app, not a decoration sprinkled on components. It has
three layers, a vocabulary, and ten rules — each rule is a bug that shipped once
and cost an afternoon to find.

```
styles/tokens.css    values only: colour, radii, --duration-*, --ease-*, --press-scale
styles/motion.css    keyframes + utilities (.motion-rise, .stagger, .press) + the contract
components/screens   consume names; never invent a duration, curve or scale
lib/motion.js        the same semantics on the JS side (timings, stagger cap, VT guard)
```

Each layer may only reference the ones above it. A component that needs a new
value adds a token first — that is what keeps "make everything 20% snappier" a
one-edit change.

## The vocabulary

Choose by intent, never by duration.

| The user… | Use | Token |
| --- | --- | --- |
| pressed a control | `.press` / `:active{transform:scale(var(--press-scale))}` | `--duration-instant` (80ms) |
| hovered a row | colour cross-fade | `--duration-fast` (140ms) |
| opened a menu | `.motion-rise` below the anchor / `.motion-sink` above it | `--duration-base` (220ms) |
| opened a dialog | `motion-sheet-in` from `scale(.97)` | `--duration-base` |
| switched screen | View Transition + `.motion-enter` on the swapped column | `--duration-base` |
| saw a list appear | `--i` stagger through `announceEntrance()` | 28ms steps, capped at 10 |
| expanded a folder | `motion-disclose` on the tree group | `--duration-fast` |
| waits on the network | `.spinner` / `.skeleton` | `--duration-loop` |

**Exits are always at least as fast as entrances** — 140ms out against 220ms in.
A dialog that takes as long to leave as to arrive feels stuck.

Springs (`--ease-spring-snappy`, `--ease-spring-bouncy`) are sampled from a
damped harmonic oscillator, not hand-tuned bezier, which is why the overshoot
reads like UIKit. Move with a spring; change colour or opacity with
`--ease-standard` — overshoot on a colour looks like a rendering glitch.

## The ten rules

| # | Rule | The failure it prevents |
| --- | --- | --- |
| 1 | Entrances fill `backwards`, never `both` | Hover and `:active` silently stop working |
| 2 | No standing `will-change` | A flash when the element changes render mode |
| 3 | Never transition `width`/`height`/`top`/`left` | Layout on every frame (jank) |
| 4 | Durations and curves come from tokens | "Make it 20% snappier" becomes a rewrite |
| 5 | One focus indicator per control | Two nested rings; the inner one hides content |
| 6 | Scope transition suppression to the swapped surface | The whole sidebar blinks on navigation |
| 7 | Page roots animate via a class, not inline | The page's entrance replays after the cross-fade |
| 8 | Cap the stagger index (10) | 20 items = half a second of waiting |
| 9 | Exits are never slower than entrances | The surface feels stuck |
| 10 | JS animation checks `prefers-reduced-motion` | The OS setting is ignored outside CSS |

## How the drive uses it

- **Press feedback** — every pressable surface (`.btn`, `.icon-btn`, `.side-row`,
  `.frow`, `.gcard`, `.menu-item`, `.segmented button`, `.crumb`, `.user-row`)
  shrinks on `:active`. This one line does more for perceived quality than any
  entrance animation.
- **One entrance per navigation** — `paintRoute()` in `app.js` cross-fades the
  `.view` column through `withViewTransition()` when the route token changes. A
  local re-render (star toggle, sort, view switch) keeps the same token and paints
  plainly, so the list never replays.
- **First paint** — when there is no previous paint to cross-fade from, the page
  root wears `.motion-enter` and the rows stagger. `onceOnRoute()` keys the run on
  the route, and the class is removed only after the **last** row has settled
  (`--duration-base + cap × step`), because cancelling a staggered row mid-flight
  leaves no fill and it snaps back to `opacity:0` — a flash.
- **Overlays** — dialogs spring in from `scale(.97)`, drawers slide from the inline
  end, menus arrive from the edge they are anchored to. All three play a faster
  exit before unmounting (`dismissOverlay()` in `lib/ui.js`).
- **Reduced motion** — `tokens.css` collapses the durations, so travel becomes a
  cross-fade without a component opting in. JS paths check
  `prefersReducedMotion()` before adding a class or starting a transition.

## Verifying

```sh
npm run motion-lint     # static: the ten rules, via scripts/motion-lint.mjs
npm run motion-check    # static + runtime feel check (needs a running server)
```

`scripts/motion-lint.mjs` is vendored from the skill so CI does not need the skill
installed. `scripts/feel-check.mjs` covers what a linter cannot see: that a real
pointer press actually shrinks a row, that row 13 waits 280ms and not 364, that a
star toggle does not replay the entrance, that the view-transition flag is
released, and that no `will-change` is left standing afterwards. It drives Chrome
over the DevTools protocol, so it needs `npm start` and Chrome or Edge.

## Adding motion to a new surface

1. **Name the intent** from the vocabulary table. Do not start from a duration.
2. **Check the utilities first** — `.motion-rise`, `.motion-sheet`, `.stagger`,
   `.press`. A second copy of the same entrance is how a system starts to drift.
3. **If nothing fits**, add the token to `tokens.css`, then the keyframe and
   utility to `motion.css`, then use it. Three files, in that order.
4. **If JS needs the timing**, read it from `lib/motion.js` rather than repeating
   the literal.
5. **Run the linter** and, for anything interactive, the feel check.
