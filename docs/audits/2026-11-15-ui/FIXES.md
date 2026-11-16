# Fix status — audit of 2026-11-15

All 21 findings are fixed. The verification column names the case in
`scripts/ui-regression-check.mjs` unless it says otherwise; the unit-level
contracts live in the test files listed at the bottom.

| ID | Fix | Where | Verified by |
| --- | --- | --- | --- |
| UI01 | `/shared/:token/preview` streams inline for both permissions, `nosniff` + `CSP: sandbox`, no download spent; the viewer page renders preview only, never a download button | `apps/server/src/routes/shares.js`, `apps/web/lib/share.js` | UI01 viewer link previews inline · viewer page offers preview and no download promise · viewer preview renders the content |
| UI02 | `/children?parentId=` walks the shared subtree one level at a time, `/archive` zips it for a downloader; the public page browses, previews and downloads | `shares.js`, `share.js` (readyFolder) | UI02 folder share lists its children · folder link browses its contents · ZIP button starts a folder download · a viewer folder cannot be archived |
| UI03 | Menu entry renamed 创建并复制链接; a live link is reused without a request; creating one is confirmed with its scope; the result is shown with 撤销 | `apps/web/lib/actions.js`, `apps/web/lib/files.js` | UI03 the menu promises creation, not a copy · confirmed first and states the scope · created link is shown with its url and a revoke action |
| UI04 | 替换 / 保留两者 / 跳过 with a "this batch" option, wired to `onConflict`; the completion notice names the outcome | `apps/web/lib/uploads.js` | UI04 a same-name upload offers the three strategies · "keep both" leaves two files and says so |
| UI05 | `deleteBatch()` keeps failed rows selected, names up to three with the server's reason; a refresh keeps the live selection and re-paints the bar | `actions.js`, `apps/web/app.js` | UI05 a partial failure names the items and keeps them selected |
| UI06 | `downloadOne()` returns its promise; the carrier is deleted only after the fetch resolves, and a failure leaves it in the list | `actions.js` | UI06 a failed ZIP download never claims success and keeps its carrier |
| UI07 | The batch summary counts started and failed separately | `actions.js` | UI07 a partly failed batch does not claim every file downloaded |
| UI08 | `trashRetentionClause()/trashRetentionNote()` read `stats.trash.retentionDays`; 0 means "no auto-purge" | `apps/web/lib/files.js`, `apps/web/lib/duplicates.js` | UI08 the trash sentence is read from the deployment, not hard-coded · `business-flow.test.js` |
| UI09 | Each `loadRoute()` takes a ticket and only the newest may commit | `apps/web/app.js` | UI09 the input, URL and results agree on the last query |
| UI10 | `/search` answers `{ results, limit, offset, hasMore }` (no invented total); the page appends on demand | `apps/server/src/routes/misc.js`, `apps/web/lib/views.js`, `app.js` | UI10 a truncated page says so · the remaining hits load on demand · `search-paging.test.js` |
| UI11 | A popup registry puts a body-level menu inside its dialog's tab cycle; closing returns to the anchor, Tab leaves for the dialog, never `<body>` | `apps/web/lib/focus.js`, `dom.js`, `ui.js` | UI11 choosing keeps focus in the dialog · Tab leaves for the dialog · `focus-menu.test.js` |
| UI12 | The closed drawer is `inert` at the width where it is a drawer | `app.js` | UI12 a closed drawer is out of the tab order |
| UI13 | A keyboard navigation focuses the page heading; a pointer navigation does not | `focus.js`, `app.js`, `views.js` | UI13 entering a folder moves focus to the new page |
| UI14 | `aria-haspopup="menu"`, menu of `menuitemradio`, current value as the accessible name, field label as description | `apps/web/lib/select.js`, `ui.js` | UI14 the select declares the popup it actually opens · the popup is a menu of radio items · `select-aria.test.js` |
| UI15 | Tree keyboard model with roving tabindex; expand/collapse re-finds its row after the re-render | `apps/web/lib/sidebar.js` | UI15 ArrowRight expands and keeps a visible focus · ArrowLeft collapses it again · `tree-keyboard.test.js` |
| UI16 | A persisted switch in the account menu, plus Ctrl/Cmd+K as the modified alternative | `apps/web/lib/shortcuts.js`, `app.js`, `actions.js` | UI16 "/" does nothing while the switch is off · Ctrl+K still reaches the search field · `shortcuts.test.js` |
| UI17 | `min-width:360px` removed; a ≤360px breakpoint reflows toolbar, row grid and queue | `apps/web/styles/base.css`, `app.css` | UI17 320 CSS pixels lays out without horizontal clipping |
| UI18 | The auth shell centres with an auto margin and scrolls when the card is taller | `base.css` | UI18 a 390×280 login card can scroll to its footer |
| UI19 | `--control-border` (3.06–4.14:1 against every surface) replaces the decorative border on checkboxes, inputs and selects | `tokens.css`, `app.css`, `components.css` | UI19 the unchecked boundary reaches 3:1 · `responsive-css.test.js` |
| UI20 | 24×24 buttons that cannot shrink, 4px gap, larger glyph | `app.css` | UI20 queue controls are at least 24x24 and keep their distance |
| UI21 | `:focus-visible` / `:focus-within` reveal the row actions; `@media (hover:none)` paints them | `app.css` | UI21 the more-actions button is visible when focused |

## Two defects the fixes themselves exposed

Both were found by the regression check and are fixed in the same change:

- **A menu closed itself on its own entrance.** `openMenu()` focused its first
  item with a plain `focus()`, the browser scrolled the item into view, and the
  menu's own `scroll` listener closed it. Focuses inside a menu now use
  `preventScroll`, and a scroll repositions the menu instead of dismissing it —
  only an anchor that leaves the viewport closes it.
- **A dialog's deferred autofocus stole a control the user had just focused.**
  `dialog()` focused its first input on the next frame unconditionally, so
  pressing a key on a control the user had already reached bounced the caret
  back to the first field. It now only takes focus when the caret has none.

## Checks

```
npm run lint                      250 files, 0 failed; motion-lint clean
npm test                          969 tests, 969 pass
npm run dead-code                 no unreachable modules
npm run ui-regression-check       38 browser cases, 0 failed
npm run browser-checks            20 existing cases, all passing
```

The browser case for UI02 reads a ZIP through the server test rather than the
browser: Chrome refuses to hand an attachment-typed ZIP to a page and reports a
synthetic empty `204`, so the page-side evidence is the download event the ZIP
button starts, and `apps/server/test/shares-public.test.js` unzips the bytes.
