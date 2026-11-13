import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareVersions, isNewerVersion, parseManifest } from '../src/release.js'

/**
 * The rules that decide whether an instance offers an update.
 *
 * A wrong answer here is expensive in both directions: "newer" when nothing is
 * newer restarts the stack for no reason, and "not newer" when it is leaves a
 * deployment silently pinned. So comparisons and manifest validation are pinned
 * rather than trusted.
 */

describe('version comparison', () => {
  it('ignores the leading v and missing segments', () => {
    assert.equal(compareVersions('v0.19.0', '0.19.0'), 0)
    assert.equal(compareVersions('0.18', '0.18.0'), 0)
    assert.equal(compareVersions('v1', '0.99.99'), 1)
  })

  it('compares numerically, not lexically', () => {
    // The bug this prevents: '0.9.0' > '0.10.0' as strings.
    assert.equal(isNewerVersion('0.10.0', '0.9.0'), true)
    assert.equal(isNewerVersion('0.9.0', '0.10.0'), false)
    assert.equal(isNewerVersion('0.18.10', '0.18.9'), true)
  })

  it('treats an equal or older release as nothing to install', () => {
    assert.equal(isNewerVersion('0.19.0', '0.19.0'), false)
    assert.equal(isNewerVersion('0.18.9', '0.19.0'), false)
  })

  it('drops build metadata and pre-release suffixes', () => {
    assert.equal(compareVersions('0.19.0+build.7', '0.19.0'), 0)
    assert.equal(compareVersions('0.19.0-rc.1', '0.19.0'), 0)
  })
})

describe('release manifest', () => {
  it('accepts the shape the release workflow publishes', () => {
    const manifest = parseManifest({
      version: 'v0.19.0',
      image: 'ghcr.io/fallforest/marvelous-drive:0.19.0',
      releaseUrl: 'https://github.com/FallForest/marvelous-drive/releases/tag/v0.19.0',
      notesUrl: 'https://github.com/FallForest/marvelous-drive/releases',
    })
    assert.equal(manifest.version, '0.19.0')
    assert.equal(manifest.image, 'ghcr.io/fallforest/marvelous-drive:0.19.0')
    assert.equal(manifest.releaseUrl, 'https://github.com/FallForest/marvelous-drive/releases/tag/v0.19.0')
  })

  it('rejects a manifest with no usable version', () => {
    assert.equal(parseManifest(null), null)
    assert.equal(parseManifest({}), null)
    assert.equal(parseManifest({ version: '' }), null)
    assert.equal(parseManifest({ version: 'latest' }), null)
    assert.equal(parseManifest({ version: 19 }), null)
    assert.equal(parseManifest([]), null)
  })

  it('drops fields it cannot trust instead of failing the whole manifest', () => {
    const manifest = parseManifest({
      version: '0.19.0',
      releaseUrl: 'javascript:alert(1)',
      image: 42,
    })
    assert.equal(manifest.version, '0.19.0')
    // A link the client would render as an anchor must be http(s) or absent.
    assert.equal(manifest.releaseUrl, undefined)
    assert.equal(manifest.image, undefined)
  })
})
