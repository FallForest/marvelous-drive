# File interaction conventions

The client keeps its existing click model: click opens a folder or previews a
file; a checkbox, Space, Ctrl/Cmd-click or Shift-click selects without opening.
Actions on nested controls (star, menu, rename input) keep their own keyboard
behavior. Delete on a selected row acts on the current selection, including in
the trash; the confirmation lists how many items will be affected.

## Moving files and folders

- Drag from a file name, row, card or thumbnail to a folder in the list, grid or
  sidebar. Breadcrumbs accept moves to an ancestor. The My Drive navigation item
  accepts moves to the root. Views such as Starred and Trash are not destinations.
- Dragging a selected item carries the selection; dragging an unselected item
  carries only that item. Source rows fade and a badge names the item/count and
  the destination. A valid destination highlights; a file, the same parent, the
  source folder and its descendants refuse the drop.
- Internal node MIME/state takes precedence over browser-provided `Files`.
  Thumbnail images disable native image dragging, so moving an image does not
  accidentally become an upload. External file drops retain the existing upload
  flow into the current directory.
- Escape or ending the drag removes all feedback. A cancelled drag cannot be
  revived by a stale drop payload, and cancelling preserves the selection.
- The context menu and selection bar provide **移动到…** as an alternative to
  dragging. The picker shows the full selected destination path, disables
  invalid/current destinations, and supports Up/Down and Home/End. Tab reaches
  the Move and Cancel buttons. Root is a valid destination (`null`); dismissal
  is a different result (`undefined`) and never moves anything.
- Every move entry point uses the same executor. A selected folder carries its
  selected descendants without separate moves that would flatten the tree.
  Existing names are never overwritten. Failures explain the affected names,
  and failed selected items remain selected after the successful items refresh.

## Reference behavior

- [Google Drive: organize and move files](https://support.google.com/drive/answer/2375091?hl=en)
  provides both drag-to-folder and a destination picker, in the main window,
  sidebar and search results.
- [WCAG 2.2 SC 2.5.7: Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
  calls for a pointer alternative that does not require dragging.
- [WAI-ARIA listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/)
  informs the destination picker's focus, selection and navigation keys. The
  picker is an always-visible destination list, rather than an expandable tree.
- [HTML drag-and-drop model](https://html.spec.whatwg.org/multipage/dnd.html)
  defines the source/target events, allowed effects and protected payload access
  during hover. Browser-generated image payloads need testing with native mouse
  input; synthetic `DataTransfer` events alone cannot reproduce them.

## Public links

A viewer link previews and nothing else: `/shared/:token/preview` streams bytes
inline, the folder share lists one level at a time, and no button offers a
download the server would refuse. A downloader link adds attachments — the file,
one entry, or the whole folder as a ZIP — and those are what spend a link's
download budget; opening the page never does.

## Batch outcomes

A batch that partly fails says so and keeps the failed items selected, so the
same key or the same button retries exactly those. A ZIP reports success only
after its fetch resolved, and its carrier node is deleted only then — a failed
download leaves the archive in the list to be clicked again.

Every download, single or batched, is a task in the download center: the topbar
entry carries a count and a hairline of progress, the panel lists the tasks with
their real percentage (or "total unknown" while packaging), and each task keeps
its own cancel and retry. A canceled or failed task stays in the panel with its
reason in visible text — a cancel is not a failure, so the batch summary counts
the two apart.

## Related regression checks

Run `npm run download-check` and `npm run queue-panel-check` for the two panels:
the download center under a throttled DevTools connection, and the upload queue
folded, reopened and measured at 320px.

## Regression checks

Run `npm run dnd-check`, `npm run interaction-check`, `npm run move-check` and
`npm run ui-regression-check` against a disposable server, or include them via
`npm run browser-checks`. `ui-regression-check` is the browser half of
`docs/audits/2026-11-15-ui`: one case per audit id, including the public link, the
search race, the modal menu, the tree keys and the 320px layout.
Use `-- --server http://127.0.0.1:PORT` for a specific instance. The drag check
uses native Chromium mouse input and verifies the resulting parent IDs through
the API; it also checks prohibited targets and drag cleanup. The interaction
and move checks cover native keyboard activation and picker outcomes. These
checks create throwaway accounts and files, so use a temporary `DRIVE_DATA_DIR`.
