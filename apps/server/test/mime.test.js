import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveMime, shouldRepairMime, extensionOf, EXTENSION_MIME } from '../src/mime.js'

/**
 * The type a stored file carries decides its icon and whether any preview is
 * attempted, so this table is not cosmetic: a .heic written as octet-stream is
 * a file the product cannot even describe to the user.
 */

describe('extensionOf', () => {
  it('reads the last extension, lower-cased', () => {
    assert.equal(extensionOf('Photo.HEIC'), 'heic')
    assert.equal(extensionOf('archive.tar.gz'), 'gz')
  })

  it('answers nothing for a name without one', () => {
    assert.equal(extensionOf('README'), '')
    assert.equal(extensionOf('.hidden'), '')
    assert.equal(extensionOf('trailing.'), '')
    assert.equal(extensionOf(null), '')
  })
})

describe('resolveMime', () => {
  it('names the formats browsers refuse to name', () => {
    // This is the whole reason the table exists: a phone photo and a scan.
    assert.equal(resolveMime('IMG_4021.heic', 'application/octet-stream'), 'image/heic')
    assert.equal(resolveMime('scan.tiff', 'application/octet-stream'), 'image/tiff')
    assert.equal(resolveMime('clip.mov', ''), 'video/quicktime')
  })

  it('lets the extension correct an empty or generic declaration', () => {
    assert.equal(resolveMime('a.png', ''), 'image/png')
    assert.equal(resolveMime('a.png', 'binary/octet-stream'), 'image/png')
    assert.equal(resolveMime('a.png', 'application/octet-stream'), 'image/png')
  })

  it('keeps a specific declared type when the extension is unknown', () => {
    assert.equal(resolveMime('mystery', 'image/avif'), 'image/avif')
    assert.equal(resolveMime('data.unknownext', 'application/x-custom'), 'application/x-custom')
  })

  it('strips parameters before comparing', () => {
    assert.equal(resolveMime('a.txt', 'text/plain; charset=utf-8'), 'text/plain')
  })

  it('falls back to the generic type', () => {
    assert.equal(resolveMime('README', ''), 'application/octet-stream')
    assert.equal(resolveMime('README', 'application/octet-stream'), 'application/octet-stream')
  })

  it('covers the document formats the drive previews', () => {
    for (const [name, mime] of [
      ['a.pdf', 'application/pdf'], ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['a.epub', 'application/epub+zip'], ['a.md', 'text/markdown'],
    ]) {
      assert.equal(resolveMime(name, 'application/octet-stream'), mime, name)
    }
  })

  it('agrees with its own table for every entry', () => {
    for (const [ext, mime] of Object.entries(EXTENSION_MIME)) {
      assert.equal(resolveMime('file.' + ext, 'application/octet-stream'), mime, ext)
    }
  })
})

describe('shouldRepairMime', () => {
  it('repairs a generic stored type', () => {
    assert.equal(shouldRepairMime('a.heic', 'application/octet-stream'), true)
    assert.equal(shouldRepairMime('a.heic', ''), true)
  })

  it('leaves a specific stored type alone', () => {
    assert.equal(shouldRepairMime('a.png', 'image/png'), false)
  })

  it('has no opinion about an unknown extension', () => {
    assert.equal(shouldRepairMime('a.unknownext', 'application/octet-stream'), false)
  })
})
