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

const EXTERNAL_RE = /^(https?:)\/\//i

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
    article.innerHTML = renderMarkdown(source)
    lockCheckboxes()
    attachCopyButtons()
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
      const unchanged = text === source
      source = text
      if (!mounted) return
      if (unchanged && rendered) return
      // In split view this runs on every debounced keystroke — keep the reader
      // where it was instead of jumping to the top.
      render(rendered)
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
      return countStats(source)
    },

    getOutline() {
      return extractOutline(source)
    },

    /** Read-only: formatting commands are no-ops by design. */
    exec() {},

    queryState() {
      return new Set()
    },

    /** No own find UI; the controller falls back to its own. */
    find() {
      return false
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
