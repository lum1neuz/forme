/**
 * Builds a read-only book from an EPUB's extracted files (Addendum F).
 *
 * Input is what the main process sends: `files` (zip path -> markup text) and
 * `images` (zip path -> data URI). Output is one sanitized HTML string with every
 * chapter in spine order, plus an outline built from the book's table of contents.
 *
 * Chapter `n` becomes `<section class="epub-chapter" id="c<n>">`, and every id
 * inside it is prefixed `c<n>-`, so ids stay unique across chapters and can never
 * collide with the app's own. Links between chapters are rewritten to those ids;
 * links that point nowhere inside the book lose their href.
 */

import { sanitizeBookHtml } from './markdown.js'

const XLINK_NS = 'http://www.w3.org/1999/xlink'
/** The controller only opens http(s) externally; anything else would be read as a file. */
const EXTERNAL_LINK = /^https?:/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** `in` would also match prototype keys like "constructor". */
const has = (obj, key) => Object.hasOwn(obj, key)

const byTag = (root, name) => Array.from(root.getElementsByTagNameNS('*', name))
const childrenNamed = (el, name) => Array.from(el.children).filter((c) => c.localName === name)

function parseXml (text, what) {
  const doc = new DOMParser().parseFromString(text || '', 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(`This EPUB is damaged (${what} could not be read).`)
  }
  return doc
}

/** Strict XHTML first; plenty of books are not well-formed, so fall back to HTML. */
function parseChapter (text) {
  const xml = new DOMParser().parseFromString(text || '', 'application/xhtml+xml')
  if (!xml.getElementsByTagName('parsererror').length && xml.body) return xml
  return new DOMParser().parseFromString(text || '', 'text/html')
}

/**
 * Resolve `href` against the zip path of the file it appears in.
 * -> { path, frag } for a reference inside the book, or null for anything with a scheme.
 */
function resolveIn (basePath, href) {
  if (!href || HAS_SCHEME.test(href)) return null
  try {
    const base = 'http://book/' + basePath.split('/').map(encodeURIComponent).join('/')
    const url = new URL(href, base)
    return {
      path: decodeURIComponent(url.pathname.slice(1)),
      frag: decodeURIComponent(url.hash.slice(1))
    }
  } catch {
    return null
  }
}

/** EPUB 3 navigation document: nested <ol> under the toc <nav>. */
function tocFromNav (text) {
  const doc = parseChapter(text)
  const navs = byTag(doc, 'nav')
  const toc = navs.find((n) => (n.getAttribute('epub:type') || '').split(/\s+/).includes('toc')) || navs[0]
  const out = []
  const walk = (ol, depth) => {
    for (const li of childrenNamed(ol, 'li')) {
      const link = childrenNamed(li, 'a')[0] || childrenNamed(li, 'span')[0]
      if (link) {
        out.push({ depth, text: link.textContent.replace(/\s+/g, ' ').trim(), href: link.getAttribute('href') || '' })
      }
      for (const sub of childrenNamed(li, 'ol')) walk(sub, depth + 1)
    }
  }
  if (toc) for (const ol of childrenNamed(toc, 'ol')) walk(ol, 0)
  return out
}

/** EPUB 2 NCX: nested navPoint elements under navMap. */
function tocFromNcx (text) {
  const doc = parseXml(text, 'the table of contents')
  const map = byTag(doc, 'navMap')[0]
  const out = []
  const walk = (parent, depth) => {
    for (const point of childrenNamed(parent, 'navPoint')) {
      const label = byTag(point, 'text')[0]
      const content = childrenNamed(point, 'content')[0]
      out.push({
        depth,
        text: (label?.textContent || '').replace(/\s+/g, ' ').trim(),
        href: content?.getAttribute('src') || ''
      })
      walk(point, depth + 1)
    }
  }
  if (map) walk(map, 0)
  return out
}

/**
 * @param {{files:Object<string,string>, images:Object<string,string>}} epub
 * @returns {{title:string, author:string, html:string,
 *   outline:Array<{level:number,text:string,slug:string}>, stats:{words:number, chars:number}}}
 * @throws {Error} with a message fit for the user when the book cannot be read
 */
export function buildBook (epub) {
  const files = epub?.files || {}
  const images = epub?.images || {}

  const container = parseXml(files['META-INF/container.xml'], 'container.xml')
  const opfPath = byTag(container, 'rootfile')[0]?.getAttribute('full-path')
  if (!opfPath || !has(files, opfPath)) throw new Error('This EPUB is damaged (its package file is missing).')
  const opf = parseXml(files[opfPath], 'the package file')

  const metadata = byTag(opf, 'metadata')[0] || opf
  const title = (byTag(metadata, 'title')[0]?.textContent || '').trim()
  const author = (byTag(metadata, 'creator')[0]?.textContent || '').trim()

  const manifest = new Map()
  for (const item of byTag(opf, 'item')) {
    const resolved = resolveIn(opfPath, item.getAttribute('href') || '')
    if (!resolved) continue
    manifest.set(item.getAttribute('id'), {
      path: resolved.path,
      type: item.getAttribute('media-type') || '',
      props: (item.getAttribute('properties') || '').split(/\s+/)
    })
  }

  const spineEl = byTag(opf, 'spine')[0]
  const itemrefs = spineEl ? childrenNamed(spineEl, 'itemref') : []
  const pick = (refs) => refs
    .map((ref) => manifest.get(ref.getAttribute('idref')))
    .filter((item) => item && has(files, item.path))
  // Non-linear items (pop-up notes and the like) only when nothing else is left.
  let spine = pick(itemrefs.filter((ref) => ref.getAttribute('linear') !== 'no'))
  if (!spine.length) spine = pick(itemrefs)
  if (!spine.length) throw new Error('This EPUB has no readable chapters.')

  const indexOf = new Map(spine.map((item, i) => [item.path, i]))
  /** In-book reference -> element id in the combined page, or null. */
  const targetId = (basePath, href) => {
    const t = resolveIn(basePath, href)
    if (!t || !indexOf.has(t.path)) return null
    const n = indexOf.get(t.path)
    return t.frag ? `c${n}-${t.frag}` : `c${n}`
  }

  const holder = document.implementation.createHTMLDocument('')
  const sections = []
  const firstHeadings = []
  let words = 0
  let chars = 0

  spine.forEach((item, n) => {
    const src = parseChapter(files[item.path])
    const box = holder.createElement('div')
    // Importing turns XHTML nodes into HTML ones, so they serialize as HTML.
    for (const node of Array.from(src.body?.childNodes || [])) box.appendChild(holder.importNode(node, true))

    for (const anchor of box.querySelectorAll('a[name]:not([id])')) anchor.id = anchor.getAttribute('name')
    for (const node of box.querySelectorAll('[id]')) node.id = `c${n}-${node.id}`
    for (const node of box.querySelectorAll('[name]')) node.removeAttribute('name')

    for (const a of box.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')
      if (EXTERNAL_LINK.test(href)) continue
      const id = targetId(item.path, href)
      // Encoded, because reading mode decodes the fragment and ids may contain '%'.
      if (id) a.setAttribute('href', `#${encodeURIComponent(id)}`)
      else a.removeAttribute('href')
    }

    for (const img of box.querySelectorAll('img')) {
      const t = resolveIn(item.path, img.getAttribute('src') || '')
      const uri = t && has(images, t.path) && images[t.path]
      if (uri) img.setAttribute('src', uri)
      else img.remove()
    }
    // SVG covers reference their image through <image href> / <image xlink:href>.
    for (const image of box.querySelectorAll('image')) {
      const ref = image.getAttribute('href') || image.getAttributeNS(XLINK_NS, 'href') || ''
      const t = resolveIn(item.path, ref)
      const uri = t && has(images, t.path) && images[t.path]
      if (!uri) { image.remove(); continue }
      if (image.hasAttribute('href')) image.setAttribute('href', uri)
      else image.setAttributeNS(XLINK_NS, 'xlink:href', uri)
    }

    // The sanitizer drops these anyway; remove them first so they don't count as words.
    for (const node of box.querySelectorAll('script, style')) node.remove()
    const text = box.textContent.replace(/\s+/g, ' ').trim()
    words += (text.match(/\S+/g) || []).length
    chars += text.length
    firstHeadings.push(box.querySelector('h1, h2, h3')?.textContent.replace(/\s+/g, ' ').trim() || '')

    sections.push(`<section class="epub-chapter" id="c${n}">${sanitizeBookHtml(box.innerHTML)}</section>`)
  })

  // Table of contents: EPUB 3 nav document, else the EPUB 2 NCX.
  let toc = []
  const nav = [...manifest.values()].find((item) => item.props.includes('nav') && has(files, item.path))
  try {
    if (nav) {
      toc = tocFromNav(files[nav.path]).map((e) => ({ ...e, base: nav.path }))
    } else {
      const ncx = manifest.get(spineEl?.getAttribute('toc')) ||
        [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml')
      if (ncx && has(files, ncx.path)) toc = tocFromNcx(files[ncx.path]).map((e) => ({ ...e, base: ncx.path }))
    }
  } catch (err) {
    // A broken table of contents is not worth refusing the book over.
    console.warn('EPUB table of contents unreadable', err)
    toc = []
  }

  let outline = toc
    .map((e) => ({ level: Math.min(6, e.depth + 1), text: e.text, slug: targetId(e.base, e.href) }))
    .filter((e) => e.text && e.slug)
  if (!outline.length) {
    outline = spine.map((_, n) => ({ level: 1, text: firstHeadings[n] || `Chapter ${n + 1}`, slug: `c${n}` }))
  }

  return { title, author, html: sections.join('\n'), outline, stats: { words, chars } }
}
