# File browsing and editing

## Research and decisions

There is no single file-manager standard that mandates every gesture. This
implementation follows common photo-viewer behavior while keeping independent
pointer and keyboard controls, and makes editing an explicit action.

| Area | Reference behavior | Project decision |
| --- | --- | --- |
| Photo browsing | Apple Photos documents left/right swipes, a visible Back control and returning to the collection. | Swipe on the photo stage in the current view's order. Non-images are excluded; first and last photos do not wrap. The existing Close control returns to the same directory. |
| Gesture alternatives | WCAG 2.5.1 requires an alternative to path-based or multipoint gestures. WAI's carousel pattern retains previous/next buttons and focus. | Keep named arrow buttons, a position counter, a live announcement and desktop Arrow/Page/Home/End keys. Swiping is an additional way to browse. |
| Native gestures | Pointer Events specifies touch-action to distinguish browser panning/zooming from application gestures. | Use `pan-y pinch-zoom` on the photo stage. Vertical intent, additional fingers, cancellation, a zoomed viewport and gestures starting near screen edges do not change photos. |
| Touch targets | WCAG 2.5.8 sets the AA minimum at 24 CSS px; the enhanced 2.5.5 target is 44 CSS px. | Photo controls use at least 44px on the mobile layout, with safe-area padding and wrapping footer actions. |
| Editing and conflicts | File viewers distinguish preview from supported editors. An advisory edit lock alone cannot prevent stale writes. | Read-only preview never claims a lock. Explicit text editing uses a version precondition, history, clear save state and guarded dismissal. |

Sources:

- [Apple: view photos and videos on iPhone](https://support.apple.com/guide/iphone/view-photos-and-videos-iph3d267610/ios)
- [W3C: Pointer Events and touch-action](https://www.w3.org/TR/pointerevents3/#the-touch-action-css-property)
- [WCAG 2.5.1: pointer gestures](https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html)
- [WAI-ARIA: carousel pattern](https://www.w3.org/WAI/ARIA/apg/patterns/carousel/)
- [WAI-ARIA: modal dialogs, focus and dismissal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [Google Drive: activity and file versions](https://support.google.com/drive/answer/2409045?hl=en)
- [WCAG 2.5.8: minimum target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

The swipe thresholds (44–96px, horizontal movement at least 1.5 times vertical
movement, at most 1.2 seconds, 24px edge exclusion) are project choices, not
dimensions prescribed by those references. Native pinch zoom remains available;
the project does not implement a separate photo zoom/pan engine.

## Preview behavior

- A photo can be switched by a deliberate single-finger horizontal swipe, the
  visible buttons or the existing desktop keys. A tap, vertical scroll, pinch or
  cancelled gesture does not navigate. One photo has no navigation controls.
- Image responses carry a render revision. A late download/decode cannot paint
  an older photo over the current one. GIF and other potentially animated
  formats use a native image element instead of a single-frame bitmap.
- Text/PDF/Office scrolling and native media controls retain their own keys.
  Audio/video previews render native controls, and closing stops playback.
- Closing a preview keeps the folder route. Browser Back history management is
  outside this change; the visible Close button and Escape are the supported
  dismissal actions.

## Text editing

Use **编辑文本** in the preview footer. Supported files must be recognized text,
no larger than 2 MiB, valid UTF-8 and free of binary control content. Markdown
edits its source; Office/PDF/media remain previews. Unsupported encodings and
large files can be downloaded for editing in another application.

The editor reads current metadata before content, preserves the UTF-8 BOM and
the file's newline style, and saves with `expectedVersion`. Saving appends a
history version. A concurrent writer produces `409 VERSION_CONFLICT`; the
editor keeps the draft and offers a draft download instead of overwriting.

On narrow screens, editing controls use 44px targets and safe-area padding.
The drawer follows the visual viewport while the page is not zoomed, keeping
the save controls inside the visible height when a keyboard reduces it. Page
zoom restores native viewport behavior. The reduced-height case is covered by
browser simulation; physical iPhone/Android keyboard testing remains separate.

Save or Ctrl/Cmd+S shows saving/saved/error state and prevents duplicate saves.
Closing with the header button, footer button, Escape or scrim checks dirty
state and offers **继续编辑**, **放弃更改** or **保存并关闭**. Failed saves keep the
editor open; browser unload prompts protect a dirty draft. These are in-memory
drafts, not offline autosave or crash recovery.

Edit locks are advisory and begin only after the file passes editing checks.
The editor releases its own client lease, including a claim that returns after
the drawer closes. A previous window cannot release a newer window's lease.
Version preconditions, rather than locks, provide the write-conflict guarantee.

## Verification

Run these against a server with a disposable data directory:

```sh
npm run mobile-preview-check -- --server http://127.0.0.1:4418
npm run preview-race-check -- --server http://127.0.0.1:4418
npm run editor-check -- --server http://127.0.0.1:4418
```

The touch check uses native Chromium touch events at 390×844 and generated
image/audio/video fixtures. The race check delays actual bitmap decoding.
Editor browser checks exercise native keyboard saves, conflict/error paths,
encoding protection and every guarded close entry point. Server tests also race
a streaming upload against a competing write and check blob references.

These verify repository code in an isolated environment. A running deployment
must be updated separately before these behaviors appear on that instance.
