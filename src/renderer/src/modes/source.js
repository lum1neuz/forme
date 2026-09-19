/**
 * Source mode — raw markdown in CodeMirror 6.
 *
 * Implements the full `Mode` interface from CONTRACT.md.
 */

import { EditorState, Compartment, EditorSelection, Annotation } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo as cmUndo,
  redo as cmRedo,
  indentWithTab
} from '@codemirror/commands'
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap
} from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'

import { extractOutline, countStats } from '../markdown.js'
import { debounce, rafThrottle } from '../lib/debounce.js'
import { scrollFractionOf, setScrollFractionOf } from '../lib/scroll.js'

/** Marks transactions the app made itself, so they never count as user edits. */
const programmatic = Annotation.define()

/* ------------------------------------------------------------------ *
 * Theming                                                             *
 * ------------------------------------------------------------------ */

function editorTheme(dark) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--fg)',
        backgroundColor: 'var(--bg)'
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: '1.65',
        overflow: 'auto'
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: 'var(--selection)' },
      '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
      '.cm-gutters': {
        backgroundColor: 'var(--bg)',
        color: 'var(--fg-subtle)',
        border: 'none',
        borderRight: '1px solid var(--border)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--bg-hover)',
        color: 'var(--fg-muted)'
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--bg-inset)',
        border: '1px solid var(--border)',
        color: 'var(--fg-muted)'
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--accent-muted)',
        outline: '1px solid var(--accent)'
      },
      '.cm-nonmatchingBracket': { color: 'var(--danger)' },
      '.cm-selectionMatch': { backgroundColor: 'var(--accent-muted)' },
      '.cm-searchMatch': {
        backgroundColor: 'var(--accent-muted)',
        outline: '1px solid var(--accent)'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--accent)',
        color: 'var(--accent-fg)'
      },
      '.cm-panels': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--fg)',
        borderTop: '1px solid var(--border)'
      },
      '.cm-panels input, .cm-panels button, .cm-panels select': {
        backgroundColor: 'var(--bg-inset)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '2px 6px',
        font: 'inherit'
      },
      '.cm-panels button:hover': { backgroundColor: 'var(--bg-hover)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--fg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)'
      }
    },
    { dark }
  )
}

function markdownHighlightStyle() {
  return HighlightStyle.define([
    // markdown structure
    { tag: t.heading1, color: 'var(--fg)', fontWeight: '700', fontSize: '1.45em' },
    { tag: t.heading2, color: 'var(--fg)', fontWeight: '700', fontSize: '1.28em' },
    { tag: t.heading3, color: 'var(--fg)', fontWeight: '700', fontSize: '1.14em' },
    { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--fg)', fontWeight: '700' },
    { tag: t.strong, fontWeight: '700', color: 'var(--fg)' },
    { tag: t.emphasis, fontStyle: 'italic', color: 'var(--fg)' },
    { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--fg-muted)' },
    { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
    { tag: t.url, color: 'var(--accent)' },
    { tag: t.monospace, color: 'var(--code-fg)', backgroundColor: 'var(--code-bg)' },
    { tag: t.quote, color: 'var(--fg-muted)', fontStyle: 'italic' },
    { tag: t.list, color: 'var(--accent)' },
    { tag: t.contentSeparator, color: 'var(--border-strong)' },
    { tag: t.processingInstruction, color: 'var(--fg-subtle)' },
    { tag: t.labelName, color: 'var(--fg-muted)' },
    { tag: t.escape, color: 'var(--fg-subtle)' },

    // embedded code (fenced blocks get real languages via language-data)
    { tag: t.comment, color: 'var(--fg-subtle)', fontStyle: 'italic' },
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--accent)' },
    { tag: [t.string, t.special(t.string)], color: 'var(--success)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warning)' },
    { tag: [t.variableName, t.propertyName], color: 'var(--fg)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--accent)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--warning)' },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--fg-muted)' },
    { tag: t.tagName, color: 'var(--accent)' },
    { tag: t.attributeName, color: 'var(--warning)' },
    { tag: t.regexp, color: 'var(--success)' },
    { tag: t.invalid, color: 'var(--danger)' },
    { tag: t.definition(t.variableName), color: 'var(--fg)' },
    { tag: t.meta, color: 'var(--fg-muted)' }
  ])
}

const FONT_STACKS = {
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)'
}

/**
 * Font size and column width come from the custom properties the controller
 * sets on `<html>` (`--editor-font-size`, `--line-width`), so the mode never
 * fights the stylesheet over the content column or its padding. Only the font
 * family is decided here, since `.cm-editor` otherwise hard-codes mono.
 */
function typographyTheme(settings) {
  const family = FONT_STACKS[settings && settings.fontFamily] || FONT_STACKS.mono
  return EditorView.theme({
    '&': {
      fontSize: 'var(--editor-font-size)',
      fontFamily: family
    }
  })
}

/* ------------------------------------------------------------------ *
 * markdown source transforms                                          *
 * ------------------------------------------------------------------ */

const INLINE_MARKERS = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`'
}

const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)\S+$/i

function toggleInline(view, marker) {
  const len = marker.length
  const spec = view.state.changeByRange((range) => {
    const doc = view.state.doc
    const inner = doc.sliceString(range.from, range.to)

    // empty selection -> insert the pair, park the cursor in the middle
    if (range.empty) {
      return {
        changes: { from: range.from, insert: marker + marker },
        range: EditorSelection.cursor(range.from + len)
      }
    }

    // selection already contains the markers -> unwrap
    if (inner.length >= len * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
      const stripped = inner.slice(len, inner.length - len)
      return {
        changes: { from: range.from, to: range.to, insert: stripped },
        range: EditorSelection.range(range.from, range.from + stripped.length)
      }
    }

    // markers sit just outside the selection -> unwrap those
    const before = doc.sliceString(Math.max(0, range.from - len), range.from)
    const after = doc.sliceString(range.to, Math.min(doc.length, range.to + len))
    if (before === marker && after === marker) {
      return {
        changes: [
          { from: range.from - len, to: range.from },
          { from: range.to, to: range.to + len }
        ],
        range: EditorSelection.range(range.from - len, range.to - len)
      }
    }

    return {
      changes: { from: range.from, to: range.to, insert: marker + inner + marker },
      range: EditorSelection.range(range.from + len, range.from + len + inner.length)
    }
  })
  view.dispatch(spec, { scrollIntoView: true })
}

/** Every line touched by any selection range, in document order. */
function selectedLines(state) {
  const seen = new Set()
  const lines = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      if (!seen.has(n)) {
        seen.add(n)
        lines.push(state.doc.line(n))
      }
    }
  }
  lines.sort((a, b) => a.from - b.from)
  return lines
}

function applyLineTransform(view, transform) {
  const lines = selectedLines(view.state)
  if (!lines.length) return
  const next = transform(lines.map((l) => l.text))
  const changes = []
  lines.forEach((line, i) => {
    const text = next[i]
    if (typeof text === 'string' && text !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: text })
    }
  })
  if (changes.length) view.dispatch({ changes, scrollIntoView: true })
}

const ATX_RE = /^(\s*)(#{1,6})\s+/
const BULLET_RE = /^(\s*)([-*+])\s+/
const ORDERED_RE = /^(\s*)(\d+)([.)])\s+/
const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+/
const QUOTE_RE = /^(\s*)>\s?/

function stripBlockPrefix(text) {
  return text
    .replace(TASK_RE, '$1')
    .replace(BULLET_RE, '$1')
    .replace(ORDERED_RE, '$1')
}

function setHeading(level) {
  return (texts) => {
    const allAtLevel = texts.every((txt) => {
      const m = txt.match(ATX_RE)
      return m && m[2].length === level
    })
    return texts.map((txt) => {
      const indent = (txt.match(/^\s*/) || [''])[0]
      const body = txt.replace(ATX_RE, '').replace(/^\s*#{1,6}\s*$/, '').trimStart()
      if (level === 0 || allAtLevel) return indent + body
      return `${indent}${'#'.repeat(level)} ${body}`
    })
  }
}

function toggleBullet(texts) {
  const all = texts.every((txt) => !txt.trim() || BULLET_RE.test(txt))
  return texts.map((txt) => {
    if (!txt.trim()) return txt
    const indent = (txt.match(/^\s*/) || [''])[0]
    const body = stripBlockPrefix(txt).slice(indent.length)
    return all ? indent + body : `${indent}- ${body}`
  })
}

function toggleOrdered(texts) {
  const all = texts.every((txt) => !txt.trim() || ORDERED_RE.test(txt))
  let n = 0
  return texts.map((txt) => {
    if (!txt.trim()) return txt
    const indent = (txt.match(/^\s*/) || [''])[0]
    const body = stripBlockPrefix(txt).slice(indent.length)
    if (all) return indent + body
    n += 1
    return `${indent}${n}. ${body}`
  })
}

function toggleTask(texts) {
  const all = texts.every((txt) => !txt.trim() || TASK_RE.test(txt))
  return texts.map((txt) => {
    if (!txt.trim()) return txt
    const indent = (txt.match(/^\s*/) || [''])[0]
    const body = stripBlockPrefix(txt).slice(indent.length)
    return all ? indent + body : `${indent}- [ ] ${body}`
  })
}

function toggleQuote(texts) {
  const meaningful = texts.filter((txt) => txt.trim())
  const all = meaningful.length > 0 && meaningful.every((txt) => QUOTE_RE.test(txt))
  return texts.map((txt) => {
    if (all) return txt.replace(QUOTE_RE, '$1')
    const indent = (txt.match(/^\s*/) || [''])[0]
    return `${indent}> ${txt.slice(indent.length)}`
  })
}

function wrapCodeBlock(view) {
  const state = view.state
  const range = state.selection.main
  const firstLine = state.doc.lineAt(range.from)
  const lastLine = state.doc.lineAt(range.to)
  const body = state.doc.sliceString(firstLine.from, lastLine.to)
  const insert = `\`\`\`\n${body}\n\`\`\``
  view.dispatch({
    changes: { from: firstLine.from, to: lastLine.to, insert },
    // park the cursor on the opening fence so a language can be typed
    selection: EditorSelection.cursor(firstLine.from + 3),
    scrollIntoView: true
  })
}

function insertLink(view) {
  const spec = view.state.changeByRange((range) => {
    const selected = view.state.doc.sliceString(range.from, range.to)
    let label
    let href
    let selectHref
    if (range.empty) {
      label = 'text'
      href = 'url'
      selectHref = false
    } else if (URL_RE.test(selected.trim())) {
      label = 'text'
      href = selected.trim()
      selectHref = false
    } else {
      label = selected
      href = 'url'
      selectHref = true
    }
    const insert = `[${label}](${href})`
    const start = range.from
    const selFrom = selectHref ? start + label.length + 3 : start + 1
    const selTo = selectHref ? selFrom + href.length : selFrom + label.length
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(selFrom, selTo)
    }
  })
  view.dispatch(spec, { scrollIntoView: true })
}

function insertBlock(view, block) {
  const state = view.state
  const range = state.selection.main
  const line = state.doc.lineAt(range.to)
  const atLineStart = range.to === line.from
  const atLineEnd = range.to === line.to
  const prefix = atLineStart ? '' : '\n'
  const suffix = atLineEnd ? '\n' : '\n'
  const insert = `${prefix}${block}${suffix}`
  const at = atLineStart ? line.from : line.to
  view.dispatch({
    changes: { from: at, to: at, insert },
    selection: EditorSelection.cursor(at + insert.length),
    scrollIntoView: true
  })
}

const TABLE_SKELETON = [
  '| Column 1 | Column 2 | Column 3 |',
  '| --- | --- | --- |',
  '|  |  |  |',
  '|  |  |  |',
  '|  |  |  |'
].join('\n')

/* ------------------------------------------------------------------ *
 * queryState helpers                                                  *
 * ------------------------------------------------------------------ */

function cursorInsideMarker(lineText, offset, marker) {
  const m = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${m}([^\\s][\\s\\S]*?)${m}`, 'g')
  let match
  while ((match = re.exec(lineText)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (offset >= start && offset <= end) return true
    if (re.lastIndex === match.index) re.lastIndex += 1
  }
  return false
}

/* ------------------------------------------------------------------ *
 * heading line lookup (fence aware)                                   *
 * ------------------------------------------------------------------ */

function headingLineNumbers(docText) {
  const lines = docText.split('\n')
  const result = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
      result.push(i + 1)
      continue
    }
    const next = lines[i + 1]
    if (line.trim() && next && /^\s{0,3}(=+|-{2,})\s*$/.test(next) && !/^\s*[-*+]\s/.test(line)) {
      result.push(i + 1)
    }
  }
  return result
}

/* ------------------------------------------------------------------ *
 * factory                                                             *
 * ------------------------------------------------------------------ */

/**
 * @param {{theme?:string, settings?:object, onChange?:Function, onLinkClick?:Function}} opts
 */
export function createSourceMode(opts = {}) {
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  let settings = Object.assign(
    {
      fontSize: 15,
      fontFamily: 'mono',
      lineWidth: 'normal',
      showLineNumbers: true,
      spellcheck: true
    },
    opts.settings || {}
  )
  let theme = opts.theme === 'light' ? 'light' : 'dark'
  let wrapEnabled = true

  /** @type {EditorView|null} */
  let view = null
  let container = null
  let doc = ''
  let original = ''
  let dirty = false
  let destroyed = false

  const themeComp = new Compartment()
  const lineNumbersComp = new Compartment()
  const wrapComp = new Compartment()
  const typographyComp = new Compartment()
  const spellcheckComp = new Compartment()

  const scrollListeners = new Set()
  const notifyScroll = rafThrottle(() => {
    const f = api.getScrollFraction()
    for (const cb of scrollListeners) {
      try {
        cb(f)
      } catch {
        /* a listener must not break scrolling */
      }
    }
  })
  let scrollHandler = null

  const emitChange = debounce(() => {
    if (!destroyed) onChange()
  }, 150)

  function themeExtensions() {
    return [editorTheme(theme === 'dark'), syntaxHighlighting(markdownHighlightStyle())]
  }

  function buildExtensions() {
    return [
      lineNumbersComp.of(settings.showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      wrapComp.of(wrapEnabled ? EditorView.lineWrapping : []),
      typographyComp.of(typographyTheme(settings)),
      spellcheckComp.of(
        EditorView.contentAttributes.of({
          spellcheck: settings.spellcheck ? 'true' : 'false',
          autocorrect: 'off',
          autocapitalize: 'off'
        })
      ),
      themeComp.of(themeExtensions()),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      rectangularSelection(),
      crosshairCursor(),
      search({ top: true }),
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        click(event) {
          const anchor = event.target && event.target.closest && event.target.closest('a[href]')
          if (anchor && typeof opts.onLinkClick === 'function') {
            event.preventDefault()
            opts.onLinkClick(anchor.getAttribute('href'))
          }
        }
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const isProgrammatic = update.transactions.some((tr) => tr.annotation(programmatic))
        doc = update.state.doc.toString()
        if (isProgrammatic) return
        dirty = true
        emitChange()
      })
    ]
  }

  const api = {
    id: 'source',
    editable: true,

    mount(host) {
      if (view) api.destroy()
      destroyed = false
      // CodeMirror's own `.cm-editor` becomes the direct child of the host,
      // which is what styles/editor.css expects (`#mode-host > .cm-editor`).
      container = host
      view = new EditorView({
        state: EditorState.create({ doc, extensions: buildExtensions() }),
        parent: host
      })
      view.dom.classList.add('mode-source')

      scrollHandler = () => notifyScroll()
      view.scrollDOM.addEventListener('scroll', scrollHandler, { passive: true })
    },

    destroy() {
      destroyed = true
      emitChange.cancel()
      notifyScroll.cancel()
      scrollListeners.clear()
      if (view) {
        if (scrollHandler) view.scrollDOM.removeEventListener('scroll', scrollHandler)
        view.destroy()
      }
      scrollHandler = null
      view = null
      container = null
    },

    setMarkdown(markdownText) {
      const text = String(markdownText == null ? '' : markdownText)
      original = text
      doc = text
      dirty = false
      emitChange.cancel()
      if (!view) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(0),
        annotations: [programmatic.of(true)],
        scrollIntoView: false
      })
      view.scrollDOM.scrollTop = 0
    },

    getMarkdown() {
      if (!dirty) return original
      return view ? view.state.doc.toString() : doc
    },

    isDirty() {
      return dirty
    },

    focus() {
      if (view) view.focus()
    },

    setTheme(next) {
      theme = next === 'light' ? 'light' : 'dark'
      if (view) view.dispatch({ effects: themeComp.reconfigure(themeExtensions()) })
    },

    applySettings(next) {
      settings = Object.assign({}, settings, next || {})
      if (!view) return
      view.dispatch({
        effects: [
          typographyComp.reconfigure(typographyTheme(settings)),
          lineNumbersComp.reconfigure(
            settings.showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []
          ),
          spellcheckComp.reconfigure(
            EditorView.contentAttributes.of({
              spellcheck: settings.spellcheck ? 'true' : 'false',
              autocorrect: 'off',
              autocapitalize: 'off'
            })
          )
        ]
      })
    },

    setWrap(enabled) {
      wrapEnabled = enabled !== false
      if (!view) return
      view.dispatch({
        effects: wrapComp.reconfigure(wrapEnabled ? EditorView.lineWrapping : [])
      })
    },

    getStats() {
      return countStats(api.getMarkdown())
    },

    getOutline() {
      return extractOutline(api.getMarkdown())
    },

    exec(cmd) {
      if (!view) return
      switch (cmd) {
        case 'bold':
        case 'italic':
        case 'strike':
        case 'code':
          toggleInline(view, INLINE_MARKERS[cmd])
          break
        case 'h1':
          applyLineTransform(view, setHeading(1))
          break
        case 'h2':
          applyLineTransform(view, setHeading(2))
          break
        case 'h3':
          applyLineTransform(view, setHeading(3))
          break
        case 'paragraph':
          applyLineTransform(view, setHeading(0))
          break
        case 'bulletList':
          applyLineTransform(view, toggleBullet)
          break
        case 'orderedList':
          applyLineTransform(view, toggleOrdered)
          break
        case 'taskList':
          applyLineTransform(view, toggleTask)
          break
        case 'blockquote':
          applyLineTransform(view, toggleQuote)
          break
        case 'codeBlock':
          wrapCodeBlock(view)
          break
        case 'link':
          insertLink(view)
          break
        case 'hr':
          insertBlock(view, '---')
          break
        case 'table':
          insertBlock(view, TABLE_SKELETON)
          break
        case 'undo':
          cmUndo(view)
          break
        case 'redo':
          cmRedo(view)
          break
        default:
          break
      }
      view.focus()
    },

    queryState() {
      const active = new Set()
      if (!view) return active
      const state = view.state
      const range = state.selection.main
      const line = state.doc.lineAt(range.head)
      const offset = range.head - line.from
      const text = line.text

      const heading = text.match(ATX_RE)
      if (heading) {
        const level = heading[2].length
        if (level === 1) active.add('h1')
        else if (level === 2) active.add('h2')
        else if (level === 3) active.add('h3')
      } else if (text.trim()) {
        active.add('paragraph')
      }

      if (TASK_RE.test(text)) active.add('taskList')
      else if (BULLET_RE.test(text)) active.add('bulletList')
      if (ORDERED_RE.test(text)) active.add('orderedList')
      if (QUOTE_RE.test(text)) active.add('blockquote')

      const selected = state.doc.sliceString(range.from, range.to)
      const check = (marker) =>
        cursorInsideMarker(text, offset, marker) ||
        (selected.length >= marker.length * 2 &&
          selected.startsWith(marker) &&
          selected.endsWith(marker))

      if (check('**')) active.add('bold')
      if (check('~~')) active.add('strike')
      if (check('`')) active.add('code')
      // single `*` only counts when it isn't part of a `**` pair
      const withoutStrong = text.replace(/\*\*/g, '--')
      if (cursorInsideMarker(withoutStrong, offset, '*') || cursorInsideMarker(text, offset, '_')) {
        active.add('italic')
      }

      // fenced code block: count fences above the cursor
      let fenceCount = 0
      for (let n = 1; n < line.number; n++) {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(state.doc.line(n).text)) fenceCount += 1
      }
      if (fenceCount % 2 === 1) active.add('codeBlock')

      if (/^\s*\|.*\|\s*$/.test(text)) active.add('table')
      if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) active.add('hr')
      if (/\[[^\]]*\]\([^)]*\)/.test(text)) active.add('link')

      return active
    },

    find() {
      if (!view) return
      view.focus()
      openSearchPanel(view)
    },

    scrollToSlug(slug) {
      if (!view || !slug) return
      const text = view.state.doc.toString()
      const outline = extractOutline(text)
      const index = outline.findIndex((h) => h.slug === slug)
      if (index < 0) return
      const lineNumbers_ = headingLineNumbers(text)
      let lineNumber = lineNumbers_[index]
      if (lineNumber == null) {
        // fall back to matching by heading text
        const wanted = outline[index].text
        for (const n of lineNumbers_) {
          if (view.state.doc.line(n).text.includes(wanted)) {
            lineNumber = n
            break
          }
        }
      }
      if (lineNumber == null) return
      const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines))
      view.dispatch({
        selection: EditorSelection.cursor(line.from),
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        annotations: [programmatic.of(true)]
      })
    },

    getScrollFraction() {
      return view ? scrollFractionOf(view.scrollDOM) : 0
    },

    setScrollFraction(fraction) {
      if (view) setScrollFractionOf(view.scrollDOM, fraction)
    },

    onScroll(cb) {
      if (typeof cb !== 'function') return () => {}
      scrollListeners.add(cb)
      return () => scrollListeners.delete(cb)
    }
  }

  return api
}

export default createSourceMode
