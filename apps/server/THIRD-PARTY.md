# Third-party notices

Marvelous Drive ships no third-party runtime code by default. One optional
dependency carries obligations, and this file is where they are met.

## libheif-js (LGPL-3.0)

**What it is.** An Emscripten build of [libheif](https://github.com/strukturag/libheif),
the HEIF/HEIC container and codec library. Marvelous Drive uses it for exactly
one thing: turning a `.heic` upload into a PNG preview a browser can display
(`apps/server/src/text/image-normalize.js`, loaded lazily by
`apps/server/src/text/heif-loader.js`).

**Why it is optional.** It is declared under `optionalDependencies`, not
`dependencies`. A deployment that never receives HEIC files does not need it,
and installing it is the only cost of supporting them.

**Licence.** GNU Lesser General Public License, version 3. The full text ships
inside the package at `node_modules/libheif-js/LICENSE`.

**How the licence is satisfied.**

1. *Use, not link.* libheif runs as a separate WebAssembly module loaded at
   runtime through `createRequire`. No libheif source is copied into, compiled
   with, or statically linked against Marvelous Drive's own code.
2. *Replaceable.* The `.wasm` is loaded as a separate file and nothing verifies
   its checksum, so a distributor of a modified Marvelous Drive may swap in
   their own build of libheif and the application still works.
3. *Notice.* This file accompanies every distribution, and the source address
   for the version in use is <https://github.com/catdad-experiments/libheif-js>
   (which packages <https://github.com/strukturag/libheif>).
4. *No contrary claims.* The package's own `license` field says `LGPL-3.0` and
   is not overridden anywhere in this repository.

**What this means for a fork.** If you modify libheif itself, publish your
modified libheif under the LGPL. Changing Marvelous Drive's own code does not
trigger that: the boundary is the WebAssembly module.

## Alternatives that were rejected

- `heic2any` — declares MIT while inlining libheif's compiled output. Bundling
  does not change the licence of the bundled code, so a distributor would
  inherit LGPL obligations it was never told about. Not used.
- `heic-decode` — declares ISC but depends on `libheif-js`, so the net effect
  is the same LGPL obligation with one more layer of indirection. Not used.
- `heif-js` — genuinely MIT, but effectively unmaintained. Not used.

## Everything else

PNG encoding, box-filter downsampling, ZIP/OOXML/ODF/PDF text extraction and
the HTTP layer are implemented in this repository on top of Node's standard
library.
