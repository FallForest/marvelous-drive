import { detectOffice, extractOffice } from './office.js'
import { MAX_PDF_INDEX_BYTES, isPdfDocument, readPdfText } from './pdf-text.js'

/**
 * Flattens a document to searchable text.
 *
 * `office.js` exists so the *preview* can render slides and sheets; search only
 * needs the words, plus a little structure so a snippet reads like prose and not
 * like a column dump. PDFs take the same seat: they are not Office documents, but
 * from the indexer's point of view they are the same kind of thing — a file whose
 * text lives inside a container and has to be extracted before it is searchable.
 *
 * Everything here is deliberately a one-way projection: nothing in this file can
 * influence how a preview renders.
 */

/** 16 MiB: a bigger deck costs more to parse than a search hit is worth. */
export const MAX_OFFICE_INDEX_BYTES = 16 * 1024 * 1024

/** Whether this file is an OOXML document whose text can be indexed. */
export function isOfficeDocument(name, mime) {
  const kind = detectOffice(name, mime)
  return kind === 'pptx' || kind === 'docx' || kind === 'xlsx' ? kind : null
}

function blockText(block) {
  if (!block) return ''
  if (block.type === 'table') {
    // Rows joined by " | " keep a snippet readable when it lands mid-table.
    return (block.rows || [])
      .map((row) => (row || []).map((cell) => String((cell && cell.text) ?? cell ?? '')).filter(Boolean).join(' | '))
      .filter(Boolean)
      .join('\n')
  }
  if (block.type === 'list') return (block.items || []).join('\n')
  if (block.type === 'image') return block.alt ? '[图片：' + block.alt + ']' : ''
  return String(block.text || '')
}

/** Concatenates every block of every page/sheet into one indexable string. */
export function flattenOfficeText(office) {
  if (!office) return ''
  const parts = []
  for (const page of office.pages || []) {
    if (page.title) parts.push(page.title)
    for (const block of page.blocks || []) {
      const text = blockText(block)
      if (text) parts.push(text)
    }
  }
  for (const sheet of office.sheets || []) {
    if (sheet.name) parts.push(sheet.name)
    for (const row of sheet.rows || []) {
      const line = (row || []).map((cell) => String((cell && cell.text) ?? cell ?? '')).filter(Boolean).join(' | ')
      if (line) parts.push(line)
    }
  }
  return parts.join('\n')
}

/**
 * Extracts searchable text from an OOXML buffer.
 *
 * Returns '' for anything that is not a recognised document or cannot be
 * parsed: a search index that silently misses one file is fine, an upload that
 * fails because a deck had an odd part is not.
 */
export function officeText(buffer, name, mime) {
  const kind = isOfficeDocument(name, mime)
  if (!kind) return ''
  try {
    return flattenOfficeText(extractOffice(buffer, kind))
  } catch {
    return ''
  }
}

/**
 * Extracts searchable text from a PDF, or reports why it could not.
 *
 * Separate from `officeText` because a PDF's failure modes are worth naming: an
 * encrypted file and a scanned one both yield nothing, but only one of them is
 * the user's fault, and the coverage report should say which.
 */
export function pdfText(buffer, name, mime) {
  if (!isPdfDocument(name, mime)) return { text: '', reason: 'not-pdf' }
  return readPdfText(buffer)
}

/** Documents whose text is extracted from a container rather than decoded. */
export function isContainerDocument(name, mime) {
  return Boolean(isOfficeDocument(name, mime)) || isPdfDocument(name, mime)
}

/** The size ceiling for a container document, by kind. */
export function containerIndexLimit(name, mime) {
  return isOfficeDocument(name, mime) ? MAX_OFFICE_INDEX_BYTES : MAX_PDF_INDEX_BYTES
}
