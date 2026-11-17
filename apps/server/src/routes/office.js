import { userFromRequest } from '../auth.js'
import { backend } from '../storage/backend.js'
import { fail, sendJson } from '../http.js'
import { requireFile } from '../nodes.js'
import { detectOffice } from '../text/office.js'
import { runCpuTask } from '../text/cpu-tasks.js'
import { previewSource } from '../ops/preview-source.js'

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
const MAX_OFFICE_BYTES = 64 * 1024 * 1024

export function registerOfficeRoutes(router) {
  router.get('/api/v1/files/:id/office', async (ctx) => {
    const user = userFromRequest(ctx.req, ctx.url)
    const row = requireFile(user.id, ctx.params.id)
    sendJson(ctx.res, 200, await officePreview(row))
  })
}

/** Extract content after the caller has authorized the file or share token. */
export async function officePreview(row) {
  if (!row.blob_hash) throw fail(404, 'NOT_FOUND', 'This file has no content yet.')

  const kind = detectOffice(row.name, row.mime)
  if (!kind) {
    throw fail(400, 'NOT_OFFICE', 'This file is not a .pptx, .docx or .xlsx document.')
  }

  // Backend, not a path: the store may be remote.
  const info = await backend.stat(row.blob_hash)
  if (!info) throw fail(404, 'NOT_FOUND', 'The stored content is missing.')
  if (info.size > MAX_OFFICE_BYTES) {
    throw fail(413, 'FILE_TOO_LARGE', 'Office previews are limited to ' + MAX_OFFICE_BYTES + ' bytes.')
  }

  let office
  try {
    office = await runCpuTask('office', async (signal) => ({
      ...(await previewSource(backend, row.blob_hash, MAX_OFFICE_BYTES, signal)), kind,
    }))
  } catch (error) {
    if (error.code === 'NOT_OFFICE') {
      throw fail(400, 'NOT_OFFICE', error.message)
    }
    if (error.status === 503 || error.status === 413 || error.status === 404) {
      throw fail(error.status, error.code, error.message)
    }
    throw fail(422, 'PREVIEW_UNAVAILABLE', error && error.message
      ? error.message
      : 'The office document could not be parsed.')
  }

  return {
    office,
    file: { id: row.id, name: row.name, mime: row.mime, size: row.size },
  }
}
