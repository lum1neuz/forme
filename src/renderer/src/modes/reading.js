/**
 * Reading mode — a read-only rendered view of the markdown.
 *
 * Also used as the right-hand pane of the split view, which re-renders it on
 * every debounced edit: `setMarkdown` therefore preserves the scroll position
 * across a re-render and re-attaches the code-block copy buttons.
 */

import { renderMarkdown, extractOutline, countStats } from '../markdown.js'
import { rafThrottle } from '../lib/debounce.js'
import { scrollFractionOf, setScrollFractionOf } from '../lib/scroll.js'
import { findOffsets } from '../find.js'

const EXTERNAL_RE = /^(https?:)\/\//i

/** Names in the CSS highlight registry, styled with ::highlight() in markdown.css. */
const HL_ALL = 'forme-find'
const HL_CURRENT = 'forme-find-current'
const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote,dt,dd,figcaption,div,article'

/**
 * @param {{theme?:string, settings?:object, onChange?:Function, onLinkClick?:Function}} opts
 */
export function createReadingMode(opts = {}) {
  let settings = Object.assign(
    { fontSize: 15, fontFamily: 'sans', lineWidth: 'normal' },
    opts.settings || {}
  )
  let theme = opts.theme === 'light' ? 'light' : 'dark'

  let root = null
  let article = null
  let source = ''
  /** A book from setBook() replaces the markdown entirely (Addendum F). */
  let book = null
  let mounted = false
  let rendered = false

  const scrollListeners = new Set()
  const notifyScroll = rafThrottle(() => {
    const f = scrollFractionOf(root)
    for (const cb of scrollListeners) {
      try {
        cb(f)
      } catch {
        /* a bad listener must not break scrolling */
      }
    }
  })
  let scrollHandler = null
  let clickHandler = null
  const copyTimers = new Set()

  /* Find: matches are DOM Ranges painted through the CSS Custom Highlight API,
     so the rendered article is never modified. */
  const find = { query: '', caseSensitive: false, ranges: [], current: -1 }

  function collectRanges() {
    const out = []
    if (!article || !find.query) return out
    // Concatenate the article's text, with a newline between blocks so a match
    // cannot run from one paragraph into the next.
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest('.copy-btn, script, style')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    })
    let text = ''
    const spans = [] // { node, start } — where each text node begins in `text`
    let lastBlock = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = n.parentElement?.closest(BLOCK_SEL) || null
      if (lastBlock && block !== lastBlock) text += '\n'
      lastBlock = block
      spans.push({ node: n, start: text.length })
      text += n.data
    }
    if (!spans.length) return out
    const locate = (offset, end) => {
      // last span starting at/before offset (or before, for an end boundary)
      let lo = 0
      let hi = spans.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (end ? spans[mid].start < offset : spans[mid].start <= offset) lo = mid
        else hi = mid - 1
      }
      const s = spans[lo]
      return { node: s.node, offset: Math.min(offset - s.start, s.node.data.length) }
    }
    for (const i of findOffsets(text, find.query, find.caseSensitive)) {
      const a = locate(i, false)
      const b = locate(i + find.query.length, true)
      const range = document.createRange()
      range.setStart(a.node, a.offset)
      range.setEnd(b.node, b.offset)
      out.push(range)
    }
    return out
  }

  function paintFind(reveal) {
    const reg = typeof CSS !== 'undefined' ? CSS.highlights : null
    if (!reg) return
    reg.delete(HL_ALL)
    reg.delete(HL_CURRENT)
    if (!find.ranges.length) return
    reg.set(HL_ALL, new Highlight(...find.ranges))
    const cur = find.ranges[find.current]
    if (!cur) return
    reg.set(HL_CURRENT, new Highlight(cur))
    if (reveal) {
      const target = cur.startContainer.parentElement
      target?.scrollIntoView({ block: 'center' })
    }
  }

  function findInfo() {
    return { count: find.ranges.length, current: find.current }
  }

  /**
   * Font size, family and column width are driven entirely by the stylesheet
   * (`--content-font-size`, `body[data-font]`, `body[data-width]`), which the
   * controller sets; nothing is needed per-mode here.
   */
  function applyTypography() {}

  /** Inject a copy button into every fenced code block. */
  function attachCopyButtons() {
    if (!article) return
    const blocks = article.querySelectorAll('pre > code')
    for (const code of blocks) {
      const pre = code.parentElement
      if (!pre) continue
      const already = Array.from(pre.children).some(
        (c) => c.classList && c.classList.contains('copy-btn')
      )
      if (already) continue

      const button = document.createElement('button')
      button.type = 'button'
      // `copy-btn`, direct child of <pre> — the stylesheet owns the hover
      // reveal and the `is-copied` flash.
      button.className = 'copy-btn'
      button.textContent = 'Copy'
      button.setAttribute('aria-label', 'Copy code to clipboard')
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const text = code.textContent || ''
        const done = (ok) => {
          button.textContent = ok ? 'Copied' : 'Failed'
          button.classList.toggle('is-copied', ok)
          const timer = setTimeout(() => {
            copyTimers.delete(timer)
            button.textContent = 'Copy'
            button.classList.remove('is-copied')
          }, 1400)
          copyTimers.add(timer)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => done(true),
            () => done(false)
          )
        } else {
          done(false)
        }
      })
      pre.appendChild(button)
    }
  }

  /** Task-list checkboxes are inert in reading mode. */
  function lockCheckboxes() {
    if (!article) return
    for (const input of article.querySelectorAll('input[type="checkbox"]')) {
      input.disabled = true
      input.setAttribute('disabled', '')
      input.classList.add('task-list-item-checkbox')
      input.addEventListener('click', (e) => e.preventDefault())
    }
  }

  function render(preserveScroll) {
    if (!article || !root) return
    const fraction = preserveScroll ? scrollFractionOf(root) : 0
    // A book's HTML was sanitized when it was built (epub.js).
    article.innerHTML = book ? book.html : renderMarkdown(source)
    lockCheckboxes()
    attachCopyButtons()
    if (find.query) {
      // the old Ranges point into the replaced DOM
      find.ranges = collectRanges()
      if (find.current >= find.ranges.length) find.current = find.ranges.length - 1
      paintFind(false)
    }
    if (preserveScroll) {
      // restore after layout so scrollHeight reflects the new content
      setScrollFractionOf(root, fraction)
      requestAnimationFrame(() => setScrollFractionOf(root, fraction))
    } else {
      root.scrollTop = 0
    }
  }

  function onClick(event) {
    const anchor =
      event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    event.preventDefault()

    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      api.scrollToSlug(id)
      return
    }
    if (EXTERNAL_RE.test(href) || /^mailto:/i.test(href)) {
      if (typeof opts.onLinkClick === 'function') opts.onLinkClick(href)
      return
    }
    // relative / file links: hand them to the controller too, never navigate
    if (href && typeof opts.onLinkClick === 'function') opts.onLinkClick(href)
  }

  const api = {
    id: 'reading',
    editable: false,

    mount(host) {
      if (root) api.destroy()
      // `.mode-root` is the app stylesheet's scrolling mode wrapper.
      root = document.createElement('div')
      root.className = 'mode-root mode-reading'

      article = document.createElement('article')
      article.className = 'markdown-body'
      root.appendChild(article)
      host.appendChild(root)
      mounted = true

      clickHandler = onClick
      root.addEventListener('click', clickHandler)
      scrollHandler = () => notifyScroll()
      root.addEventListener('scroll', scrollHandler, { passive: true })

      applyTypography()
      api.setTheme(theme)
      render(false)
      rendered = true
    },

    destroy() {
      api.clearSearch()
      notifyScroll.cancel()
      scrollListeners.clear()
      for (const timer of copyTimers) clearTimeout(timer)
      copyTimers.clear()
      if (root) {
        if (clickHandler) root.removeEventListener('click', clickHandler)
        if (scrollHandler) root.removeEventListener('scroll', scrollHandler)
        if (root.parentNode) root.parentNode.removeChild(root)
      }
      clickHandler = null
      scrollHandler = null
      article = null
      root = null
      mounted = false
      rendered = false
    },

    setMarkdown(markdownText) {
      const text = String(markdownText == null ? '' : markdownText)
      const unchanged = text === source && !book
      source = text
      book = null
      if (!mounted) return
      if (unchanged && rendered) return
      // In split view this runs on every debounced keystroke — keep the reader
      // where it was instead of jumping to the top.
      render(rendered)
      rendered = true
    },

    /** Show a book built by epub.js ({html, outline, stats}) instead of markdown. */
    setBook(next) {
      book = next || null
      source = ''
      if (!mounted) return
      render(false)
      rendered = true
    },

    /** Reading mode never edits, so the original string comes back untouched. */
    getMarkdown() {
      return source
    },

    isDirty() {
      return false
    },

    focus() {
      if (root) {
        root.setAttribute('tabindex', '-1')
        root.focus({ preventScroll: true })
      }
    },

    setTheme(next) {
      theme = next === 'light' ? 'light' : 'dark'
      if (root) root.setAttribute('data-mode-theme', theme)
    },

    applySettings(next) {
      settings = Object.assign({}, settings, next || {})
      applyTypography()
    },

    // Wrapping is pure CSS here (body[data-wrap]); defined for uniformity.
    setWrap() {},

    getStats() {
      return book ? book.stats : countStats(source)
    },

    getOutline() {
      return book ? book.outline : extractOutline(source)
    },

    /** Read-only: formatting commands are no-ops by design. */
    exec() {},

    queryState() {
      return new Set()
    },

    /** No own find UI; the controller's find bar drives the methods below. */
    find() {
      return false
    },

    search(query, { caseSensitive = false } = {}) {
      find.query = String(query || '')
      find.caseSensitive = !!caseSensitive
      find.ranges = collectRanges()
      find.current = find.ranges.length ? 0 : -1
      paintFind(true)
      return findInfo()
    },

    searchStep(dir) {
      const n = find.ranges.length
      if (n) find.current = (((find.current + dir) % n) + n) % n
      paintFind(true)
      return findInfo()
    },

    clearSearch() {
      find.query = ''
      find.ranges = []
      find.current = -1
      paintFind(false)
    },

    scrollToSlug(slug) {
      if (!article || !slug) return
      let el = null
      try {
        el = article.querySelector(`#${CSS.escape(slug)}`)
      } catch {
        el = null
      }
      if (!el) {
        el = Array.from(article.querySelectorAll('[id]')).find((n) => n.id === slug) || null
      }
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },

    getScrollFraction() {
      return scrollFractionOf(root)
    },

    setScrollFraction(fraction) {
      setScrollFractionOf(root, fraction)
    },

    onScroll(cb) {
      if (typeof cb !== 'function') return () => {}
      scrollListeners.add(cb)
      return () => scrollListeners.delete(cb)
    }
  }

  return api
}

export default createReadingMode
