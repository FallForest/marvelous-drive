# Marvelous Drive — interaction audit, 2026-11-15

Source snapshot: 0.24.0 (`3630674`). 21 findings: 4 P1, 17 P2. Eighteen had a
browser or production-component reproduction; three were confirmed by reading
the code (UI07, UI08, UI16).

This directory keeps the audit as it was written, so the fix and the finding can
be read side by side. The resolution of every item is in [FIXES.md](FIXES.md),
and each one now has a browser case in [`scripts/ui-regression-check.mjs`](../../../scripts/ui-regression-check.mjs)
(`npm run ui-regression-check -- --server http://127.0.0.1:PORT`).

## Findings

| ID | Pri | Area | Finding |
| --- | --- | --- | --- |
| UI01 | P1 | workflow | The default "仅查看" share cannot be previewed: preview and download both 403 |
| UI02 | P1 | workflow | A folder share can be created, but the recipient cannot obtain its contents |
| UI03 | P2 | workflow | "复制链接" silently creates a new permanent public download link |
| UI04 | P2 | workflow | A same-name upload has no conflict choice and no version explanation |
| UI05 | P2 | workflow | A partly failed batch delete loses the failed selection and the diagnosis |
| UI06 | P2 | workflow | ZIP download reports success too early and deletes its carrier anyway |
| UI07 | P2 | workflow | The batch download summary counts files that failed |
| UI08 | P2 | workflow | The trash retention sentence ignores the deployment setting |
| UI09 | P1 | search | A search race lets an older response overwrite a newer query |
| UI10 | P2 | search | More than 50 hits are truncated silently, with no way to continue |
| UI11 | P1 | a11y | Choosing from the share menu, or tabbing past it, drops focus on `<body>` |
| UI12 | P2 | a11y | The closed mobile sidebar still takes invisible keyboard focus |
| UI13 | P2 | a11y | Entering a folder by keyboard leaves focus on `<body>` |
| UI14 | P2 | a11y | The custom select declares `listbox` but opens a `menu` |
| UI15 | P2 | a11y | The folder tree has no keyboard expand/collapse |
| UI16 | P2 | a11y | Global single-character shortcuts cannot be switched off or remapped |
| UI17 | P2 | responsive | At 320 CSS px the page still forces a 360px canvas and clips actions |
| UI18 | P2 | responsive | The login card has no scroll path on a short viewport |
| UI19 | P2 | visual | The unchecked checkbox boundary is below 3:1 |
| UI20 | P2 | visual | Adjacent queue buttons miss the minimum target size or spacing |
| UI21 | P2 | visual | The more-actions button stays transparent while focused |

Priority is the project's own scheduling judgement, not a WCAG level. "Spec
risk" means a testable WCAG/WAI-ARIA requirement; "pattern guidance" means APG
or focus-order guidance; "convention" means a heuristic or a peer product.
