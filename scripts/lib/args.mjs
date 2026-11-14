#!/usr/bin/env node
/**
 * args.mjs — the one "--name value" reader for the operation scripts.
 *
 * Eight scripts grew their own copy of this function, which is how a flag ends
 * up being spelled `--s3-port` in one place and `--s3port` in another. The
 * browser checks already share `scripts/lib/browser.mjs`; this is the same idea
 * for the scripts that never launch a browser.
 *
 *   const flag = argv()               // process.argv.slice(2)
 *   flag('port', 4400)                // "--port 4401" → 4401, otherwise 4400
 *
 * A flag whose value is missing (last argument, or followed by another flag)
 * falls back rather than swallowing the next switch.
 */

/** Reads a named `--flag value` pair out of an argv array. */
export function flagReader(argv) {
  return function flag(name, fallback) {
    const index = argv.indexOf('--' + name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return fallback;
    return value;
  };
}

/** The common case: read from this process's arguments. */
export function argv() {
  return process.argv.slice(2);
}

/** Convenience: a flag reader over this process's arguments. */
export function flag(name, fallback) {
  return flagReader(process.argv.slice(2))(name, fallback);
}
