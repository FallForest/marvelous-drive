/*
 * runtime.js — the wiring seam between the shell's modules.
 *
 * Splitting app.js into modules creates one problem: the pieces call each other
 * in both directions. The view builds a context whose handlers live in
 * actions.js; actions.js opens a dialog and then asks the shell to repaint;
 * the shell repaints by calling the view. Written as direct imports that is a
 * cycle, and ESM cycles produce `undefined` at call time — a bug that only
 * shows up when the user clicks the one control that crosses the edge.
 *
 * So the verbs live here, and app.js fills them in at boot. A module imports
 * `runtime` and calls `runtime.refreshData()`; nothing imports app.js. The
 * registry is deliberately small: if a module needs a new verb, that is a sign
 * the module boundary is wrong, not that the registry should grow.
 */

/** Verbs every module may call. app.js replaces each one during wire(). */
export const runtime = {
  navigate() {},
  refreshData() {},
  renderShell() {},
  paintSelection() {},
  mountAuth() {},
  lookupNode() {},
  /** Picks files through the hidden input, then uploads them. */
  pickFiles() {},
  /** Opens the "upload file / upload folder" menu anchored at an element. */
  pickUploadKind() {},
  /** Uploads a folder plan into a parent folder. */
  uploadFolderPlan() {},
  /** Uploads a list of File objects into the current folder. */
  uploadFiles() {},
  /** The folder a drop should land in, or undefined when the route cannot take one. */
  currentParentId() { return undefined; },
};

/** Called once by app.js, after every module has defined its functions. */
export function wire(implementations) {
  for (const [name, fn] of Object.entries(implementations)) {
    if (!(name in runtime)) throw new Error('runtime.' + name + ' is not a known verb')
    runtime[name] = fn
  }
}
