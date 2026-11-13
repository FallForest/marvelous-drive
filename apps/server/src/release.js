/**
 * Release manifests and version comparison.
 *
 * The update checker reads a manifest published next to each GitHub release
 * (`release/latest.json`, attached as an asset). Nothing here writes: the
 * manifest is produced by `.github/workflows/release.yml`, so a running instance
 * only has to answer "what is newer than me, and where do I get it".
 */

/**
 * Parses a dotted version into numeric segments.
 *
 * A leading `v` and any `+build` / `-prerelease` suffix are dropped: release
 * tags carry a `v`, package.json does not, and comparing the two must not depend
 * on which spelling the caller used.
 */
function parseVersion(value) {
  const core = String(value || '').trim().replace(/^v/i, '').split(/[+-]/)[0]
  return core.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

/**
 * Compares two dotted versions.
 *
 * Returns a negative number when `left` is older, 0 when they are equal and a
 * positive number when `left` is newer. Missing segments count as zero, so
 * `0.18` and `0.18.0` compare equal.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] || 0
    const y = b[index] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/**
 * Validates a release manifest.
 *
 * Returns null rather than throwing: the manifest is fetched over the network
 * from a file the deployment may have mis-configured, and a bad answer must
 * degrade to "no update available", never to a 500 in the account menu.
 */
export function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  if (!version || !/^v?\d+(\.\d+)*$/i.test(version)) return null
  const text = (key) => (typeof value[key] === 'string' && value[key].trim() ? value[key].trim() : undefined)
  const manifest = { version: version.replace(/^v/i, '') }
  for (const key of ['image', 'releaseUrl', 'notesUrl', 'sha256']) {
    const entry = text(key)
    if (!entry) continue
    if (key.endsWith('Url') && !/^https?:\/\//i.test(entry)) continue
    manifest[key] = entry
  }
  return manifest
}
