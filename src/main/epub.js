/**
 * EPUB extraction for the main process.
 *
 * An .epub is a zip archive. This reads the archive with Node's zlib (no zip
 * dependency) and hands the renderer the parts it can show: markup as text and
 * images as data URIs. Parsing the XML and building the book happens in the
 * renderer, which has DOMParser and DOMPurify.
 *
 * Fonts, stylesheets, audio and video are skipped: the book is shown in the
 * app's own theme, and none of them can be rendered safely without its CSS.
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const MAX_EPUB_BYTES = 256 * 1024 * 1024
/** Uncompressed cap across everything we extract — guards against zip bombs. */
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 20000

const TEXT_EXTENSIONS = new Set(['.xhtml', '.html', '.htm', '.xml', '.opf', '.ncx'])
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** Central directory -> [{ name, method, flags, compressedSize, size, localOffset }]. */
function listZipEntries(buf) {
  // The end-of-central-directory record sits in the last 22 bytes plus an
  // optional comment of up to 64 KiB.
  const floor = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('This file is not a valid EPUB (no zip directory found).')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('This EPUB uses ZIP64, which is not supported.')
  }
  if (count > MAX_ENTRIES) throw new Error('This EPUB has too many files to open.')

  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error('This EPUB is damaged (bad zip directory).')
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ name, method, flags, compressedSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readZipEntry(buf, entry) {
  if (entry.flags & 1) throw new Error('This EPUB is encrypted and cannot be opened.')
  const at = entry.localOffset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== SIG_LOCAL) {
    throw new Error('This EPUB is damaged (bad file header).')
  }
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const data = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) {
    // Stored: the declared size is what the extraction cap counts, so it must be true.
    if (entry.compressedSize !== entry.size) throw new Error('This EPUB is damaged (bad file size).')
    return data
  }
  if (entry.method === 8) {
    // maxOutputLength makes a lying size header throw instead of ballooning.
    return inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
  }
  throw new Error(`This EPUB uses an unsupported compression method (${entry.method}).`)
}

/**
 * DRM shows up as META-INF/encryption.xml listing the book's own pages. Font
 * obfuscation also lives there, but only covers fonts, which we skip anyway.
 */
function isDrmProtected(encryptionXml) {
  const uris = [...encryptionXml.matchAll(/CipherReference[^>]*URI\s*=\s*["']([^"']+)["']/gi)]
  return uris.some(([, uri]) => /\.(x?html?|opf|ncx)$/i.test(uri))
}

/**
 * Read an .epub from disk.
 * @returns {Promise<{path:string, epub:{files:Object<string,string>, images:Object<string,string>}} | {error:string}>}
 *   `files` maps zip paths to markup text, `images` maps zip paths to data URIs.
 */
export async function readEpubFile(filePath) {
  try {
    const abs = resolve(filePath)
    const info = await stat(abs)
    if (info.size > MAX_EPUB_BYTES) return { error: 'This EPUB is too large to open (over 256 MB).' }
    const buf = await readFile(abs)

    const files = {}
    const images = {}
    let total = 0
    for (const entry of listZipEntries(buf)) {
      if (entry.name.endsWith('/')) continue
      const ext = extname(entry.name).toLowerCase()
      const imageType = IMAGE_TYPES[ext]
      if (!TEXT_EXTENSIONS.has(ext) && !imageType) continue

      total += entry.size
      if (total > MAX_EXTRACTED_BYTES) return { error: 'This EPUB is too large to open.' }

      const data = readZipEntry(buf, entry)
      if (imageType) {
        images[entry.name] = `data:${imageType};base64,${data.toString('base64')}`
      } else {
        let text = data.toString('utf8')
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        files[entry.name] = text
      }
    }

    const encryption = files['META-INF/encryption.xml']
    if (encryption && isDrmProtected(encryption)) {
      return { error: 'This book is DRM-protected, so it cannot be opened.' }
    }
    if (!files['META-INF/container.xml']) {
      return { error: 'This file is not a valid EPUB (META-INF/container.xml is missing).' }
    }
    return { path: abs, epub: { files, images } }
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) }
  }
}
