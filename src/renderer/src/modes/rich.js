/**
 * Rich mode — WYSIWYG editing on top of TipTap v3.
 *
 * There is deliberately no markdown extension here: markdown stays the single
 * source of truth and this mode is only a lens onto it.
 *
 *   setMarkdown(md)  ->  renderMarkdown(md) -> HTML -> setContent(..., {emitUpdate:false})
 *   getMarkdown()    ->  !dirty ? the cached original (byte-identical)
 *                              : htmlToMarkdown(editor.getHTML())
 */

import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import Typography from '@tiptap/extension-typography'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { TaskList, TaskItem } from '@tiptap/extension-list'

import {
  renderMarkdown,
  htmlToMarkdown,
  createSlugger,
  countStats,
  taskListsToTipTap
} from '../markdown.js'
import { debounce, rafThrottle } from '../lib/debounce.js'
import { scrollFractionOf, setScrollFractionOf } from '../lib/scroll.js'
import { findOffsets } from '../find.js'

/**
 * @param {{theme?:string, settings?:object, onChange?:Function, onLinkClick?:Function}} opts
 */
export function createRichMode(opts = {}) {
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  let settings = Object.assign(
    { fontSize: 15, fontFamily: 'sans', lineWidth: 'normal', spellcheck: true },
    opts.settings || {}
  )
  let theme = opts.theme === 'light' ? 'light' : 'dark'

  /** @type {Editor|null} */
  let editor = null
  let root = null
  let scroller = null
  let original = ''
  let pendingHtml = renderMarkdown('')
  let dirty = false
  let destroyed = false
  let suppressUpdate = false

  const scrollListeners = new Set()
  const notifyScroll = rafThrottle(() => {
    const f = api.getScrollFraction()
    for (const cb of scrollListeners) {
      try {
        cb(f)
      } catch {
        /* never let a listener break scrolling */
      }
    }
  })
  let scrollHandler = null

  const emitChange = debounce(() => {
    if (!destroyed) onChange()
  }, 150)

  /**
   * Font size, family and column width are driven entirely by the stylesheet
   * (`--content-font-size`, `body[data-font]`, `body[data-width]`), which the
   * controller sets. The only per-mode setting left is spellcheck.
   */
  function applyTypography() {
    if (editor) editor.setOptions({ editorProps: editorProps() })
  }

  /** Rebuilt whenever settings change — must keep the click handler attached. */
  function editorProps() {
    return {
      attributes: {
        // BOTH classes are required: all content typography is written against
        // `.markdown-body, .ProseMirror`.
        class: 'markdown-body ProseMirror',
        spellcheck: settings.spellcheck ? 'true' : 'false'
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const anchor =
          event.target && event.target.closest ? event.target.closest('a[href]') : null
        if (anchor && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          if (typeof opts.onLinkClick === 'function') {
            opts.onLinkClick(anchor.getAttribute('href'))
          }
          return true
        }
        return false
      }
    }
  }

  /**
   * Heading nodes of the current doc, in document order, with the same
   * duplicate-slug suffixes markdown-it-anchor produces, so the sidebar
   * behaves identically in all three modes.
   */
  function headings() {
    const out = []
    if (!editor) return out
    const slugger = createSlugger()
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        const text = node.textContent.trim()
        out.push({ level: Number(node.attrs.level) || 1, text, slug: slugger(text), pos })
      }
      return true
    })
    return out
  }

  /* ------------------------------------------------------- find / replace */

  const findKey = new PluginKey('formeFind')
  const find = { query: '', caseSensitive: false, matches: [], current: -1, doc: null }

  /**
   * Every match as doc positions. Matching runs per textblock over its whole
   * text, so a match may cross marks ("foo **bar**" finds "foo bar").
   */
  function collectMatches(doc) {
    const out = []
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      let text = ''
      const map = []
      node.forEach((child, offset) => {
        const start = pos + 1 + offset
        if (child.isText) {
          for (let i = 0; i < child.text.length; i++) map.push(start + i)
          text += child.text
        } else {
          // inline leaves (hard breaks, images) take one position
          map.push(start)
          text += '￼'
        }
      })
      for (const i of findOffsets(text, find.query, find.caseSensitive)) {
        out.push({ from: map[i], to: map[i + find.query.length - 1] + 1 })
      }
      return false
    })
    return out
  }

  /** Re-scan only when the doc changed since the last scan. */
  function syncMatches(doc) {
    if (find.doc === doc) return
    find.doc = doc
    find.matches = find.query ? collectMatches(doc) : []
    if (find.current >= find.matches.length) find.current = find.matches.length - 1
    if (find.current < 0 && find.matches.length) find.current = 0
  }

  function findInfo() {
    return { count: find.matches.length, current: find.current }
  }

  /** Index of the first match starting at or after `pos`, wrapping to 0. */
  function matchFrom(pos) {
    if (!find.matches.length) return -1
    return Math.max(0, find.matches.findIndex((m) => m.from >= pos))
  }

  /** Repaint the highlights; with `select`, also select + reveal the current match. */
  function redraw(select) {
    if (!editor) return
    const tr = editor.state.tr.setMeta(findKey, true)
    const m = find.matches[find.current]
    if (select && m) tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView()
    editor.view.dispatch(tr)
  }

  const findExtension = Extension.create({
    name: 'formeFind',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: findKey,
          props: {
            decorations(state) {
              if (!find.query) return null
              syncMatches(state.doc)
              if (!find.matches.length) return null
              return DecorationSet.create(
                state.doc,
                find.matches.map((m, i) =>
                  Decoration.inline(m.from, m.to, {
                    class: i === find.current ? 'find-match find-current' : 'find-match'
                  })
                )
              )
            }
          }
        })
      ]
    }
  })

  function extensions() {
    return [
      findExtension,
      // v3's StarterKit already ships Link, Underline, the list extensions and
      // UndoRedo — adding them again would throw on duplicate names.
      StarterKit.configure({
        codeBlock: { HTMLAttributes: { class: 'code-block' } },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer' }
        },
        heading: { levels: [1, 2, 3, 4, 5, 6] }
      }),
      Typography,
      // TaskList / TaskItem are NOT part of StarterKit v3.
      TaskList.configure({ HTMLAttributes: { class: 'task-list' } }),
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell
    ]
  }

  const api = {
    id: 'rich',
    editable: true,

    mount(host) {
      if (editor) api.destroy()
      destroyed = false

      // `.mode-root` is the app stylesheet's scrolling mode wrapper; the
      // ProseMirror editable must stay its DIRECT child
      // (`#mode-host > .mode-root > .ProseMirror`).
      root = document.createElement('div')
      root.className = 'mode-root mode-rich'
      host.appendChild(root)

      editor = new Editor({
        element: root,
        extensions: extensions(),
        content: pendingHtml,
        autofocus: false,
        editable: true,
        injectCSS: false,
        editorProps: editorProps(),
        onUpdate() {
          if (suppressUpdate) return
          dirty = true
          emitChange()
        }
      })

      scroller = root
      scrollHandler = () => notifyScroll()
      scroller.addEventListener('scroll', scrollHandler, { passive: true })

      applyTypography()
      api.setTheme(theme)
    },

    destroy() {
      destroyed = true
      emitChange.cancel()
      notifyScroll.cancel()
      scrollListeners.clear()
      if (scroller && scrollHandler) scroller.removeEventListener('scroll', scrollHandler)
      scrollHandler = null
      scroller = null
      if (editor) {
        editor.destroy()
        editor = null
      }
      if (root && root.parentNode) root.parentNode.removeChild(root)
      root = null
    },

    setMarkdown(markdownText) {
      const text = String(markdownText == null ? '' : markdownText)
      original = text
      dirty = false
      emitChange.cancel()
      const html = taskListsToTipTap(renderMarkdown(text))
      pendingHtml = html
      if (!editor) return
      suppressUpdate = true
      try {
        editor.commands.setContent(html, { emitUpdate: false })
      } finally {
        suppressUpdate = false
      }
      if (root) root.scrollTop = 0
    },

    getMarkdown() {
      // Never reformat source the user did not touch.
      if (!dirty) return original
      if (!editor) return original
      return htmlToMarkdown(editor.getHTML())
    },

    isDirty() {
      return dirty
    },

    focus() {
      if (editor) editor.commands.focus()
    },

    setTheme(next) {
      theme = next === 'light' ? 'light' : 'dark'
      if (root) root.setAttribute('data-mode-theme', theme)
    },

    applySettings(next) {
      settings = Object.assign({}, settings, next || {})
      applyTypography()
    },

    // Wrapping in rich mode is purely a CSS concern (the styles agent drives it
    // off body[data-wrap]); defined so the controller can call it uniformly.
    setWrap() {},

    getStats() {
      if (!editor) return countStats(original)
      // Derived from the doc text, not from a markdown serialisation — the
      // latter would be far too slow to run on every keystroke.
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', ' ')
      const words = text.match(/\S+/g)
      return {
        words: words ? words.length : 0,
        chars: text.length,
        lines: Math.max(1, editor.state.doc.childCount)
      }
    },

    getOutline() {
      return headings().map(({ level, text, slug }) => ({ level, text, slug }))
    },

    exec(cmd) {
      if (!editor) return
      const chain = () => editor.chain().focus()
      switch (cmd) {
        case 'bold':
          chain().toggleBold().run()
          break
        case 'italic':
          chain().toggleItalic().run()
          break
        case 'strike':
          chain().toggleStrike().run()
          break
        case 'code':
          chain().toggleCode().run()
          break
        case 'h1':
          chain().toggleHeading({ level: 1 }).run()
          break
        case 'h2':
          chain().toggleHeading({ level: 2 }).run()
          break
        case 'h3':
          chain().toggleHeading({ level: 3 }).run()
          break
        case 'paragraph':
          chain().setParagraph().run()
          break
        case 'bulletList':
          chain().toggleBulletList().run()
          break
        case 'orderedList':
          chain().toggleOrderedList().run()
          break
        case 'taskList':
          chain().toggleTaskList().run()
          break
        case 'blockquote':
          chain().toggleBlockquote().run()
          break
        case 'codeBlock':
          chain().toggleCodeBlock().run()
          break
        case 'hr':
          chain().setHorizontalRule().run()
          break
        case 'table':
          chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          break
        case 'link':
          api.toggleLink()
          break
        case 'undo':
          chain().undo().run()
          break
        case 'redo':
          chain().redo().run()
          break
        default:
          break
      }
    },

    /** Prompt-driven link toggle (simple, and adequate for a desktop app). */
    toggleLink() {
      if (!editor) return
      if (editor.isActive('link')) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run()
        return
      }
      const previous = editor.getAttributes('link').href || ''
      let url
      try {
        url = window.prompt('Link URL', previous)
      } catch {
        url = null
      }
      if (url === null) {
        editor.commands.focus()
        return
      }
      const href = String(url).trim()
      if (!href) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run()
        return
      }
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href, rel: 'noopener noreferrer' })
        .run()
    },

    queryState() {
      const active = new Set()
      if (!editor) return active
      const is = (name, attrs) => {
        try {
          return editor.isActive(name, attrs)
        } catch {
          return false
        }
      }
      if (is('bold')) active.add('bold')
      if (is('italic')) active.add('italic')
      if (is('strike')) active.add('strike')
      if (is('code')) active.add('code')
      if (is('link')) active.add('link')
      if (is('heading', { level: 1 })) active.add('h1')
      if (is('heading', { level: 2 })) active.add('h2')
      if (is('heading', { level: 3 })) active.add('h3')
      if (is('paragraph')) active.add('paragraph')
      if (is('bulletList')) active.add('bulletList')
      if (is('orderedList')) active.add('orderedList')
      if (is('taskList')) active.add('taskList')
      if (is('blockquote')) active.add('blockquote')
      if (is('codeBlock')) active.add('codeBlock')
      if (is('horizontalRule')) active.add('hr')
      if (is('table')) active.add('table')
      return active
    },

    /** TipTap has no find UI; the controller's find bar drives the methods below. */
    find() {
      return false
    },

    search(query, { caseSensitive = false } = {}) {
      if (!editor) return { count: 0, current: -1 }
      find.query = String(query || '')
      find.caseSensitive = !!caseSensitive
      find.doc = null
      syncMatches(editor.state.doc)
      // Start at the caret, so typing more of the query keeps the same hit.
      find.current = matchFrom(editor.state.selection.from)
      redraw(true)
      return findInfo()
    },

    searchStep(dir) {
      if (!editor) return { count: 0, current: -1 }
      syncMatches(editor.state.doc)
      const n = find.matches.length
      if (n) find.current = (((find.current + dir) % n) + n) % n
      redraw(true)
      return findInfo()
    },

    replaceMatch(text) {
      if (!editor) return { count: 0, current: -1 }
      syncMatches(editor.state.doc)
      const m = find.matches[find.current]
      if (!m) return findInfo()
      const value = String(text ?? '')
      // A doc-changing transaction: onUpdate marks the tab dirty, and undo works.
      editor.view.dispatch(editor.state.tr.insertText(value, m.from, m.to))
      syncMatches(editor.state.doc)
      find.current = matchFrom(m.from + value.length)
      redraw(true)
      return findInfo()
    },

    replaceAll(text) {
      if (!editor) return 0
      syncMatches(editor.state.doc)
      const list = find.matches
      if (!list.length) return 0
      const value = String(text ?? '')
      const tr = editor.state.tr
      // Back to front, so earlier positions stay valid. One transaction = one undo.
      for (let i = list.length - 1; i >= 0; i--) tr.insertText(value, list[i].from, list[i].to)
      editor.view.dispatch(tr)
      return list.length
    },

    clearSearch() {
      find.query = ''
      find.matches = []
      find.current = -1
      find.doc = null
      redraw(false)
    },

    scrollToSlug(slug) {
      if (!editor || !slug) return
      const target = headings().find((h) => h.slug === slug)
      if (!target) return
      const pos = target.pos
      const dom = editor.view.nodeDOM(pos) || editor.view.domAtPos(pos + 1).node
      const el = dom && dom.nodeType === 1 ? dom : dom && dom.parentElement
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },

    getScrollFraction() {
      return scrollFractionOf(scroller)
    },

    setScrollFraction(fraction) {
      setScrollFractionOf(scroller, fraction)
    },

    onScroll(cb) {
      if (typeof cb !== 'function') return () => {}
      scrollListeners.add(cb)
      return () => scrollListeners.delete(cb)
    }
  }

  return api
}

export default createRichMode
