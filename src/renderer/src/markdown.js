/**
 * Shared markdown pipeline.
 *
 * Markdown text is the single source of truth for the whole app; this module is
 * the only place that knows how to turn it into HTML and (for rich mode) back.
 *
 * Exports (see CONTRACT.md):
 *   md, renderMarkdown, htmlToMarkdown, extractOutline, slugify, countStats
 */

import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import anchor from 'markdown-it-anchor'
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

import hljs from 'highlight.js/lib/core'

import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import less from 'highlight.js/lib/languages/less'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import diff from 'highlight.js/lib/languages/diff'
import markdownLang from 'highlight.js/lib/languages/markdown'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import powershell from 'highlight.js/lib/languages/powershell'
import plaintext from 'highlight.js/lib/languages/plaintext'

/* ------------------------------------------------------------------ *
 * highlight.js — deliberately a small, common subset (not the bundle) *
 * ------------------------------------------------------------------ */

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('scss', scss)
hljs.registerLanguage('less', less)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('python', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('php', php)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('plaintext', plaintext)

// JSX/TSX are close enough to js/ts for display purposes; toml is ini-shaped.
hljs.registerAliases(['jsx', 'mjs', 'cjs', 'node'], { languageName: 'javascript' })
hljs.registerAliases(['tsx'], { languageName: 'typescript' })
hljs.registerAliases(['toml'], { languageName: 'ini' })
hljs.registerAliases(['html', 'vue', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['text', 'txt', 'plain'], { languageName: 'plaintext' })

hljs.configure({ classPrefix: 'hljs-', ignoreUnescapedHTML: true })

/** Resolve a fence info string to a registered hljs language name, or ''. */
function resolveLanguage(info) {
  const name = String(info || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
  if (!name) return ''
  return hljs.getLanguage(name) ? name : ''
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------ *
 * slugify                                                             *
 * ------------------------------------------------------------------ */

/**
 * GitHub-ish heading slug. Used both by markdown-it-anchor (so the rendered
 * `id` attributes match) and by the outline builders in every mode.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const slug = String(text == null ? '' : text)
    .trim()
    .toLowerCase()
    // strip punctuation & symbols, keep word chars, spaces, dashes
    .replace(/[ -⁯⸀-⹿'"`!@#$%^&*()+=,.?;:[\]{}<>~|\\/]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/* ------------------------------------------------------------------ *
 * markdown-it                                                         *
 * ------------------------------------------------------------------ */

/** @type {import('markdown-it')} configured markdown-it instance */
export const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
  langPrefix: 'language-',
  highlight(str, info) {
    const raw = String(info || '').trim().split(/\s+/)[0]
    const lang = resolveLanguage(info)
    let body
    if (lang) {
      try {
        body = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      } catch {
        body = escapeHtml(str)
      }
    } else {
      body = escapeHtml(str)
    }
    // Keep the ORIGINAL info string as the class so the html -> markdown
    // direction can restore the fence language even for unknown languages.
    const cls = raw ? ` class="language-${escapeHtml(raw)}"` : ''
    return `<pre class="hljs"><code${cls}>${body}</code></pre>`
  }
})

md.use(taskLists, { enabled: false, label: false, labelAfter: false })
md.use(anchor, {
  level: 1,
  slugify,
  tabIndex: false,
  permalink: false,
  uniqueSlugStartIndex: 1
})

// Links: add rel="noopener noreferrer". No `target` — the renderer intercepts
// clicks and routes external links through the main process.
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]
  const href = token.attrGet('href') || ''
  if (!href.startsWith('#')) {
    token.attrSet('rel', 'noopener noreferrer')
  }
  const targetIndex = token.attrIndex('target')
  if (targetIndex >= 0) token.attrs.splice(targetIndex, 1)
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/* ------------------------------------------------------------------ *
 * DOMPurify                                                           *
 * ------------------------------------------------------------------ */

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ALLOW_DATA_ATTR: true,
  ADD_TAGS: ['input'],
  ADD_ATTR: [
    'class',
    'id',
    'rel',
    'type',
    'checked',
    'disabled',
    'align',
    'colspan',
    'rowspan',
    'start',
    'title'
  ],
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'srcset', 'onerror', 'onload']
}

let purifyHookInstalled = false
function installPurifyHooks() {
  if (purifyHookInstalled || typeof DOMPurify.addHook !== 'function') return
  purifyHookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      // never navigate the window from rendered content
      node.removeAttribute('target')
    }
    if (node.tagName === 'INPUT') {
      // task-list checkboxes only; anything else is dropped
      const type = (node.getAttribute('type') || '').toLowerCase()
      if (type !== 'checkbox') {
        node.parentNode && node.parentNode.removeChild(node)
        return
      }
      node.setAttribute('disabled', '')
      for (const attr of Array.from(node.attributes)) {
        if (!['type', 'checked', 'disabled', 'class'].includes(attr.name)) {
          node.removeAttribute(attr.name)
        }
      }
    }
  })
}

/**
 * Render markdown to sanitized HTML.
 *
 * @param {string} src
 * @returns {string} HTML
 */
export function renderMarkdown(src) {
  const text = String(src == null ? '' : src)
  const html = md.render(text, {})
  if (typeof window === 'undefined' || !DOMPurify.sanitize) return html
  installPurifyHooks()
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/* ------------------------------------------------------------------ *
 * turndown (HTML -> markdown)                                         *
 * ------------------------------------------------------------------ */

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  hr: '---',
  fence: '```',
  br: '  '
})

turndown.use(gfm)

// Fenced code blocks keep their language (`language-xxx` -> ```xxx).
turndown.addRule('fencedCodeBlockWithLanguage', {
  filter(node, options) {
    return (
      options.codeBlockStyle === 'fenced' &&
      node.nodeName === 'PRE' &&
      node.firstChild &&
      node.firstChild.nodeName === 'CODE'
    )
  },
  replacement(_content, node, options) {
    const codeEl = node.firstChild
    const classNames = `${codeEl.getAttribute('class') || ''} ${node.getAttribute('class') || ''}`
    const match = classNames.match(/(?:^|\s)language-([^\s]+)/)
    const language = match ? match[1] : ''

    const code = (codeEl.textContent || '').replace(/\n+$/, '')

    // Widen the fence if the body itself contains a run of backticks.
    const runs = code.match(/`{3,}/gm) || []
    let fenceLength = 3
    for (const run of runs) fenceLength = Math.max(fenceLength, run.length + 1)
    const fence = (options.fence || '```').charAt(0).repeat(fenceLength)

    return `\n\n${fence}${language}\n${code}\n${fence}\n\n`
  }
})

// Heading anchors etc. must never become part of the text.
turndown.addRule('stripHeaderAnchors', {
  filter(node) {
    return (
      node.nodeName === 'A' &&
      (node.getAttribute('class') || '').split(/\s+/).includes('header-anchor')
    )
  },
  replacement: () => ''
})

// turndown-plugin-gfm emits single tildes; GFM wants `~~strike~~`.
turndown.addRule('strikethroughGfm', {
  filter: ['del', 's', 'strike'],
  replacement: (content) => (content ? `~~${content}~~` : '')
})

// turndown's stock list item uses `-   ` (three spaces) and a four-space
// continuation indent. Emit idiomatic `- ` / `1. ` instead.
turndown.addRule('listItemTight', {
  filter: 'li',
  replacement(content, node, options) {
    let body = content.replace(/^\n+/, '').replace(/\n+$/, '\n')
    let prefix = `${options.bulletListMarker} `
    const parent = node.parentNode
    if (parent && parent.nodeName === 'OL') {
      const start = parent.getAttribute('start')
      const index = Array.prototype.indexOf.call(parent.children, node)
      prefix = `${start ? Number(start) + index : index + 1}. `
    }
    body = body.replace(/\n/gm, `\n${' '.repeat(prefix.length)}`)
    return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '')
  }
})

turndown.keep(['sub', 'sup', 'kbd'])
turndown.remove(['script', 'style'])

/** Direct element children of `el` matching `nodeName`. */
function childrenNamed(el, nodeName) {
  const out = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1 && child.nodeName === nodeName) out.push(child)
  }
  return out
}

/* -------- task list normalisation (the fragile bit) --------------- *
 *
 * markdown-it-task-lists emits:
 *   <ul class="contains-task-list">
 *     <li class="task-list-item"><input class="..." disabled type="checkbox"> text</li>
 *
 * TipTap expects:
 *   <ul data-type="taskList">
 *     <li data-type="taskItem" data-checked="true"><p>text</p></li>
 *
 * We convert in both directions so that `- [ ]` / `- [x]` survives
 * markdown -> rich -> markdown untouched.
 * ------------------------------------------------------------------ */

function parseFragment(html) {
  const doc = new DOMParser().parseFromString(
    `<body>${String(html == null ? '' : html)}</body>`,
    'text/html'
  )
  return doc.body
}

/**
 * markdown-it flavoured HTML -> TipTap flavoured HTML.
 * Exported implicitly through rich mode; kept module-local on purpose.
 */
export function taskListsToTipTap(html) {
  if (typeof DOMParser === 'undefined') return html
  const body = parseFragment(html)

  const lists = body.querySelectorAll('ul.contains-task-list, ol.contains-task-list')
  for (const list of lists) {
    list.setAttribute('data-type', 'taskList')
    list.classList.remove('contains-task-list')
    if (!list.getAttribute('class')) list.removeAttribute('class')
  }

  const items = body.querySelectorAll('li.task-list-item')
  for (const li of items) {
    const input = li.querySelector('input[type="checkbox"]')
    const checked = !!(input && (input.checked || input.hasAttribute('checked')))
    if (input) {
      // drop the label wrapper markdown-it may have produced, keep its text
      const label = input.closest('label')
      if (label && label.parentNode === li) {
        while (label.firstChild) label.parentNode.insertBefore(label.firstChild, label)
        label.remove()
      }
      input.remove()
      // markdown-it-task-lists strips `[x]` but leaves the separating space
      const firstNode = li.firstChild
      if (firstNode && firstNode.nodeType === 3) {
        firstNode.nodeValue = firstNode.nodeValue.replace(/^\s+/, '')
      }
    }
    li.setAttribute('data-type', 'taskItem')
    li.setAttribute('data-checked', checked ? 'true' : 'false')
    li.classList.remove('task-list-item')
    li.classList.remove('enabled')
    if (!li.getAttribute('class')) li.removeAttribute('class')

    // TipTap's taskItem content is `paragraph block*`; make sure loose text
    // (markdown-it emits bare inline content for tight lists) is wrapped.
    const hasBlock = Array.from(li.childNodes).some(
      (n) => n.nodeType === 1 && /^(P|DIV|UL|OL|PRE|BLOCKQUOTE|H[1-6])$/.test(n.nodeName)
    )
    if (!hasBlock) {
      const p = body.ownerDocument.createElement('p')
      while (li.firstChild) p.appendChild(li.firstChild)
      li.appendChild(p)
    } else {
      // leading loose text nodes before the first block -> own paragraph
      const leading = []
      for (const n of Array.from(li.childNodes)) {
        if (n.nodeType === 1 && /^(P|DIV|UL|OL|PRE|BLOCKQUOTE|H[1-6])$/.test(n.nodeName)) break
        leading.push(n)
      }
      if (leading.some((n) => (n.textContent || '').trim())) {
        const p = body.ownerDocument.createElement('p')
        for (const n of leading) p.appendChild(n)
        li.insertBefore(p, li.firstChild)
      }
    }
  }

  return body.innerHTML
}

/** TipTap flavoured HTML -> markdown-it flavoured HTML (turndown-friendly). */
export function taskListsFromTipTap(html) {
  if (typeof DOMParser === 'undefined') return html
  const body = parseFragment(html)
  const doc = body.ownerDocument

  for (const list of body.querySelectorAll('[data-type="taskList"]')) {
    list.removeAttribute('data-type')
    list.classList.add('contains-task-list')
  }

  for (const li of body.querySelectorAll('li[data-type="taskItem"]')) {
    const checked = li.getAttribute('data-checked') === 'true' || li.getAttribute('data-checked') === ''
    li.removeAttribute('data-type')
    li.removeAttribute('data-checked')
    li.classList.add('task-list-item')

    // TipTap renders <label><input><span></span></label><div>content</div>
    for (const label of childrenNamed(li, 'LABEL')) label.remove()
    for (const div of childrenNamed(li, 'DIV')) {
      while (div.firstChild) li.insertBefore(div.firstChild, div)
      div.remove()
    }

    // The first paragraph must be unwrapped: turndown's gfm taskListItems rule
    // only fires for an <input> that is a DIRECT child of the <li>, and a block
    // sibling would push the item text onto its own line.
    const firstElement = Array.from(li.childNodes).find((n) => n.nodeType === 1)
    const firstP = childrenNamed(li, 'P')[0]
    if (firstP && firstP === firstElement) {
      while (firstP.firstChild) li.insertBefore(firstP.firstChild, firstP)
      firstP.remove()
    }

    const input = doc.createElement('input')
    input.setAttribute('type', 'checkbox')
    input.setAttribute('disabled', '')
    if (checked) {
      input.setAttribute('checked', '')
      input.checked = true
    }
    li.insertBefore(input, li.firstChild)
  }

  return body.innerHTML
}

/**
 * Convert HTML (as produced by the rich-text editor) back to markdown.
 *
 * @param {string} html
 * @returns {string} markdown
 */
export function htmlToMarkdown(html) {
  const normalized = taskListsFromTipTap(String(html == null ? '' : html))
  let out = turndown.turndown(normalized)
  // turndown leaves a `[x] ` marker glued to the bullet; tidy stray spacing and
  // collapse runs of more than two blank lines.
  out = out
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return out ? `${out}\n` : ''
}

/* ------------------------------------------------------------------ *
 * outline + stats                                                     *
 * ------------------------------------------------------------------ */

/**
 * Heading outline, parsed from markdown-it tokens (so `#` inside a fenced code
 * block is not mistaken for a heading). Slugs are read straight off the tokens
 * after markdown-it-anchor has run, so they are byte-identical to the `id`
 * attributes `renderMarkdown` produces, duplicate suffixes included.
 *
 * @param {string} src
 * @returns {Array<{level:number, text:string, slug:string}>}
 */
export function extractOutline(src) {
  const text = String(src == null ? '' : src)
  if (!text) return []

  let tokens
  try {
    tokens = md.parse(text, {})
  } catch {
    return []
  }

  const outline = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== 'heading_open') continue
    const inline = tokens[i + 1]
    let headingText = ''
    if (inline && Array.isArray(inline.children)) {
      headingText = inline.children
        .filter((c) => c.type === 'text' || c.type === 'code_inline')
        .map((c) => c.content)
        .join('')
    } else if (inline) {
      headingText = inline.content || ''
    }
    headingText = headingText.trim()
    const level = Number(token.tag.slice(1)) || 1
    const slug = token.attrGet('id') || slugify(headingText)
    outline.push({ level, text: headingText, slug })
  }
  return outline
}

/**
 * @param {string} src
 * @returns {{words:number, chars:number, lines:number}}
 */
export function countStats(src) {
  const text = String(src == null ? '' : src)
  const words = text.match(/\S+/g)
  return {
    words: words ? words.length : 0,
    chars: text.length,
    lines: text.split('\n').length
  }
}

/**
 * Same duplicate-suffix rule markdown-it-anchor applies, for callers that build
 * an outline without re-parsing markdown (rich mode walks the ProseMirror doc).
 *
 * @returns {(text:string) => string}
 */
export function createSlugger() {
  const seen = Object.create(null)
  return (text) => {
    const base = slugify(text)
    let slug = base
    let n = 1
    while (seen[slug]) {
      slug = `${base}-${n}`
      n += 1
    }
    seen[slug] = true
    return slug
  }
}
