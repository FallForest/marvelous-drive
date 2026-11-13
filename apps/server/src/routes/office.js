import { readFile, stat } from 'node:fs/promises'
import { userFromRequest } from '../auth.js'
import { blobPath } from '../storage/blobs.js'
import { backend, readBlobBuffer } from '../storage/backend.js'
import { fail, sendJson } from '../http.js'
import { requireFile } from '../nodes.js'
import { OfficeError, detectOffice, extractOffice } from '../text/office.js'

/**
 * The OOXML preview endpoint.
 *
 * The web client cannot render pptx/docx/xlsx itself, so the server extracts a
 * neutral structure (pages of blocks, or sheets of rows) with ./office.js and
 * the client only has to draw it.
 *
 *   GET /api/v1/files/:id/office
 *     -> { office: <extractOffice result>, file: { id, name, mime, size } }
 *
 * Errors:
 *   400 INVALID_INPUT / NOT_OFFICE        extension or magic bytes say "not OOXML"
 *   413 FILE_TOO_LARGE                    blob is bigger than 64 MiB
 *   422 PREVIEW_UNAVAILABLE               OOXML, but the parts could not be parsed
 */

/** Above this the extraction would cost more memory than a preview is worth. */
export const MAX_OFFICE_BYTES = 64 * 1024 * 1024

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ZIP_MAGIC_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06])

const hasZipMagic = (buffer) => {
  if (buffer.length < 4) return false
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC)) return true
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC_EMPTY)) return true
  return false
}

export function registerOfficeRoutes(router) {
  router.get('/api/v1/files/:id/office', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    if (!row.blob_hash) ctx.fail(404, 'NOT_FOUND', 'This file has no content yet.')

    const kind = detectOffice(row.name, row.mime)
    if (!kind) {
      ctx.fail(400, 'NOT_OFFICE', 'This file is not a .pptx, .docx or .xlsx document.')
    }

    // Backend, not a path: the store may be remote.
    const info = await backend.stat(row.blob_hash)
    if (!info) ctx.fail(404, 'NOT_FOUND', 'The stored content is missing.')
    if (info.size > MAX_OFFICE_BYTES) {
      ctx.fail(413, 'FILE_TOO_LARGE', 'Office previews are limited to ' + MAX_OFFICE_BYTES + ' bytes.')
    }

    const buffer = await readBlobBuffer(backend, row.blob_hash)
    if (!hasZipMagic(buffer)) {
      ctx.fail(400, 'NOT_OFFICE', 'The file header is not an OOXML (ZIP) container.')
    }

    let office
    try {
      office = extractOffice(buffer, kind)
    } catch (error) {
      if (error instanceof OfficeError && error.code === 'NOT_OFFICE') {
        ctx.fail(400, 'NOT_OFFICE', error.message)
      }
      ctx.fail(422, 'PREVIEW_UNAVAILABLE', error && error.message
        ? error.message
        : 'The office document could not be parsed.')
    }

    sendJson(ctx.res, 200, {
      office,
      file: { id: row.id, name: row.name, mime: row.mime, size: row.size },
    })
  })
}