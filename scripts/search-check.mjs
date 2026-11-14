#!/usr/bin/env node
/**
 * Content-search check: a word that only exists inside a file must find that
 * file, and the result must say so (snippet + "内容中命中").
 *
 *   node scripts/search-check.mjs [--server URL]
 */

import { serverUrl, runBrowserCheck, signUpInPage } from './lib/browser.mjs'

const server = serverUrl()

process.exit(await runBrowserCheck({ title: 'Content search check' }, async (page, check) => {
  await page.navigate(server + '/?t=' + Date.now(), { settle: 1300 })
  await signUpInPage(page, { prefix: 'search', password: 'search check password' })

  await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const headers = { authorization: 'Bearer ' + token }
    const put = (name, type, body) => fetch('/api/v1/uploads?name=' + encodeURIComponent(name), {
      method: 'PUT', headers: { ...headers, 'content-type': type }, body,
    })
    await put('会议记录.md', 'text/markdown', '# 会议记录\n\n讨论了 xylophone 采购预算。')
    await put('无关.txt', 'text/plain', 'nothing to see')
  })

  await page.navigate(server + '/search?q=xylophone&t=' + Date.now(), { settle: 2200 })
  const text = await page.evaluate('document.body.innerText')
  check('a content-only word finds the file', text.includes('会议记录.md'), text.slice(0, 200))
  check('the result says it matched content', /内容中命中/.test(text), text.slice(0, 200))

  const notes = await page.evaluate("document.querySelectorAll('.match-note').length")
  check('a snippet block is rendered', notes >= 1, String(notes))
  const snippet = await page.evaluate("(document.querySelector('.match-note span') || {}).innerText || ''")
  check('the snippet contains the matched word', /xylophone/.test(snippet), JSON.stringify(snippet))

  // An Office document's text must be findable too; the fixture is a tiny docx
  // built in the page with the same minimal OOXML writer the tests use.
  const docxId = await page.run(async () => {
    const token = localStorage.getItem('mdrive-token')
    const buildZip = (entries) => {
      const encoder = new TextEncoder()
      const table = (() => {
        const values = new Uint32Array(256)
        for (let i = 0; i < 256; i += 1) {
          let c = i
          for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
          values[i] = c >>> 0
        }
        return values
      })()
      const crc32 = (bytes) => {
        let crc = 0xffffffff
        for (const b of bytes) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff]
        return (crc ^ 0xffffffff) >>> 0
      }
      const locals = []
      const central = []
      let offset = 0
      for (const [name, content] of Object.entries(entries)) {
        const data = encoder.encode(content)
        const nameBytes = encoder.encode(name)
        const crc = crc32(data)
        const local = new Uint8Array(30 + nameBytes.length + data.length)
        const dv = new DataView(local.buffer)
        dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true)
        dv.setUint16(8, 0, true); dv.setUint32(14, crc, true)
        dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true)
        dv.setUint16(26, nameBytes.length, true)
        local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length)
        const directory = new Uint8Array(46 + nameBytes.length)
        const dd = new DataView(directory.buffer)
        dd.setUint32(0, 0x02014b50, true); dd.setUint16(4, 20, true); dd.setUint16(6, 20, true)
        dd.setUint16(8, 0x0800, true); dd.setUint32(16, crc, true)
        dd.setUint32(20, data.length, true); dd.setUint32(24, data.length, true)
        dd.setUint16(28, nameBytes.length, true); dd.setUint32(42, offset, true)
        directory.set(nameBytes, 46)
        locals.push(local); central.push(directory); offset += local.length
      }
      const centralSize = central.reduce((sum, part) => sum + part.length, 0)
      const end = new Uint8Array(22)
      const ed = new DataView(end.buffer)
      ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, central.length, true)
      ed.setUint16(10, central.length, true); ed.setUint32(12, centralSize, true)
      ed.setUint32(16, offset, true)
      return new Blob([...locals, ...central, end])
    }
    const docx = buildZip({
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>采购合同编号 ZW-9081</w:t></w:r></w:p></w:body></w:document>',
    })
    const response = await fetch('/api/v1/uploads?name=' + encodeURIComponent('采购合同.docx'), {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      body: docx,
    })
    const payload = await response.json()
    return payload.node ? payload.node.id : null
  })
  check('a docx uploads', typeof docxId === 'string', String(docxId))

  await page.navigate(server + '/search?q=ZW-9081&t=' + Date.now(), { settle: 2200 })
  const officeText = await page.evaluate('document.body.innerText')
  check('a word inside a .docx is findable', officeText.includes('采购合同.docx'), officeText.slice(0, 200))

  await page.navigate(server + '/search?q=xylophone&t=' + Date.now(), { settle: 1800 })

  // Landing straight on /search used to leave the sidebar at "已用 0 B".
  const used = await page.evaluate("(document.querySelector('.storage-line') || {}).innerText || ''")
  check('the sidebar reports real usage on the search page', !/已用 0 B/.test(used), JSON.stringify(used))

  await page.shot('search-content')
  check('no console errors', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 2).join(' | '))
}))
