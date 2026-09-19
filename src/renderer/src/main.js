/**
 * Forme — renderer controller.
 *
 * Owns application state: the open documents, which view each is in, the theme,
 * the folder tree and the sidebar. Everything under #mode-host belongs to a mode
 * module; everything else on screen is rendered from here.
 *
 * See CONTRACT.md for the module boundaries this file depends on.
 */

// Stylesheets are linked from index.html so they load before this module runs.
import { createSourceMode } from './modes/source.js'
import { createRichMode } from './modes/rich.js'
import { createReadingMode } from './modes/reading.js'
import { renderMarkdown } from './markdown.js'

const api = window.forme

/* ------------------------------------------------------------------ utils */

function debounce (fn, ms) {
  let t
  const wrapped = (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  wrapped.cancel = () => clearTimeout(t)
  return wrapped
}

const $ = (sel) => document.querySelector(sel)
const basename = (p) => (p ? p.split(/[\\/]/).pop() : null)
const dirname = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))

let docSeq = 0
let untitledSeq = 0

/* ------------------------------------------------------------------ state */

const state = {
  settings: null,
  docs: [],
  activeId: null,
  theme: 'dark',
  themeId: 'dark',
  themes: [],
  /** live mode instances for the current layout; [] when nothing is mounted */
  mounted: [],
  /** the mode instance that owns the markdown in the current layout */
  primary: null,
  folder: { path: null, entries: [], truncated: false, open: new Set() },
  /** Transient dark/light flip while following the OS; cleared when the OS changes. */
  themeOverride: null,
  quitting: false
}

const el = {}

function activeDoc () {
  return state.docs.find((d) => d.id === state.activeId) || null
}

function isDirty (doc) {
  return doc ? doc.markdown !== doc.savedMarkdown : false
}

/** Stable per-document id used as the draft filename; survives restarts. */
function newDraftId () {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

function makeDoc ({ path = null, markdown = '', mode = null, savedMarkdown, draftId, title, ephemeral = false } = {}) {
  if (!path) untitledSeq += 1
  return {
    id: `doc-${++docSeq}`,
    draftId: draftId || newDraftId(),
    /** Generated boilerplate: not worth persisting until the user touches it. */
    ephemeral,
    path,
    title: title || basename(path) || `Untitled ${untitledSeq}`,
    markdown,
    savedMarkdown: savedMarkdown === undefined ? markdown : savedMarkdown,
    mode: mode || state.settings?.mode || 'source',
    scroll: 0
  }
}

/* ------------------------------------------------------------------ theme */

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

/** Custom properties written by the active theme, so we can clear them on switch. */
let appliedThemeProps = []

function resolveThemeId () {
  const pref = state.settings.theme
  if (pref && pref !== 'system') return pref
  if (state.themeOverride) return state.themeOverride
  return systemDark.matches
    ? (state.settings.themeDark || 'dark')
    : (state.settings.themeLight || 'light')
}

async function fetchTheme (id) {
  try {
    const res = await api.theme?.get?.(id)
    return res && !res.error ? res : null
  } catch {
    return null
  }
}

/**
 * theme.css remains the styled fallback; a theme overlays it by setting the same
 * custom properties inline. A theme that fails to load falls back to the built-in
 * of the last known type rather than leaving the app unstyled.
 */
async function applyTheme () {
  const id = resolveThemeId()
  let theme = await fetchTheme(id)
  if (!theme) theme = await fetchTheme(state.theme === 'light' ? 'light' : 'dark')

  const root = document.documentElement
  for (const prop of appliedThemeProps) root.style.removeProperty(prop)
  appliedThemeProps = []

  if (theme) {
    for (const [k, v] of Object.entries(theme.colors || {})) {
      root.style.setProperty(`--${k}`, v)
      appliedThemeProps.push(`--${k}`)
    }
    for (const [k, v] of Object.entries(theme.syntax || {})) {
      root.style.setProperty(`--hl-${k}`, v)
      appliedThemeProps.push(`--hl-${k}`)
    }
  }

  const type = theme?.type === 'light' ? 'light' : 'dark'
  state.theme = type
  state.themeId = theme?.id || id
  root.setAttribute('data-theme', type)
  // The pre-paint script in index.html reads a concrete type, never 'system'.
  try { localStorage.setItem('forme:theme', type) } catch {}

  for (const m of state.mounted) m.setTheme?.(type)
  syncMenuState()
  paintToolbar()
}

async function loadThemeList () {
  try {
    const list = await api.theme?.list?.()
    state.themes = Array.isArray(list) ? list : []
  } catch {
    state.themes = []
  }
}

async function selectTheme (id) {
  if (!id) return
  // An explicit pick beats any transient flip.
  state.themeOverride = null
  const entry = state.themes.find((t) => t.id === id)
  const patch = { theme: id }
  // Remember the pick per type, so 'Follow System' honours the user's taste.
  if (entry?.type === 'dark') patch.themeDark = id
  if (entry?.type === 'light') patch.themeLight = id
  updateSettings(patch, { immediate: true })
  await applyTheme()
}

/**
 * Flip between the user's dark and light themes. While following the system this
 * sets a temporary override instead of silently switching that preference off;
 * the override is dropped the next time the OS changes appearance.
 */
function toggleThemeMode () {
  const next = state.theme === 'dark'
    ? (state.settings.themeLight || 'light')
    : (state.settings.themeDark || 'dark')
  if (state.settings.theme === 'system') {
    state.themeOverride = next
    return applyTheme()
  }
  return selectTheme(next)
}

systemDark.addEventListener('change', () => {
  if (state.settings?.theme !== 'system') return
  // The OS has spoken; drop any manual flip and follow it again.
  state.themeOverride = null
  applyTheme()
})

/* --------------------------------------------------------------- settings */

const persistSettings = debounce((patch) => { api.settings.set(patch) }, 250)

/**
 * While the preferences dialog is open, edits preview live but are NOT written
 * to disk — they accumulate here until Apply. Cancel puts the snapshot back.
 */
let prefsStaging = null

function updateSettings (patch, { immediate = false } = {}) {
  Object.assign(state.settings, patch)
  if (prefsStaging) {
    for (const key of Object.keys(patch)) {
      if (!(key in prefsStaging.snapshot)) prefsStaging.snapshot[key] = prefsStaging.original[key]
    }
    Object.assign(prefsStaging.patch, patch)
    paintPrefsFooter()
    return
  }
  if (immediate) api.settings.set(patch)
  else persistSettings(patch)
}

function applyBodySettings () {
  const s = state.settings
  document.body.dataset.font = s.fontFamily || 'sans'
  document.body.dataset.width = s.lineWidth || 'normal'
  document.body.dataset.wrap = s.wrap === false ? 'off' : 'on'
  document.body.dataset.sidebar = s.sidebarVisible === false ? 'hidden' : 'visible'
  document.body.dataset.sidebarView = s.sidebarView || 'files'
  const size = s.fontSize || 15
  document.documentElement.style.setProperty('--editor-font-size', `${size}px`)
  document.documentElement.style.setProperty('--content-font-size', `${size}px`)
  el.body?.style.setProperty('--sidebar-width', `${s.sidebarWidth || 260}px`)
  for (const m of state.mounted) {
    m.applySettings?.(s)
    m.setWrap?.(s.wrap !== false)
  }
}

/**
 * A document earns a draft file while it is dirty, or while it is untitled with
 * something in it. Clean saved files are not duplicated — the session record has
 * the path and the content is re-read from disk.
 */
function needsDraft (doc) {
  if (state.settings.keepDrafts === false) return false
  if (doc.ephemeral && !isDirty(doc)) return false
  return isDirty(doc) || (!doc.path && doc.markdown.trim() !== '')
}

const persistSession = debounce(() => {
  // Untitled documents are now kept too, because a draft can restore them.
  const tabs = state.docs.filter((d) => d.path || needsDraft(d))
  api.settings.set({
    session: {
      tabs: tabs.map((d) => ({ path: d.path, mode: d.mode, draftId: d.draftId })),
      activeIndex: Math.max(0, tabs.findIndex((d) => d.id === state.activeId))
    }
  })
}, 500)

/** Written on the same cadence as the session, so a crash loses at most ~600ms. */
const persistDrafts = debounce(async () => {
  if (!api.draft) return
  for (const doc of state.docs) {
    if (!needsDraft(doc)) continue
    const res = await api.draft.save({
      draftId: doc.draftId,
      path: doc.path,
      title: doc.title,
      mode: doc.mode,
      markdown: doc.markdown,
      savedMarkdown: doc.savedMarkdown,
      updatedAt: Date.now()
    })
    if (res && res.error) console.warn('draft save failed', doc.title, res.error)
  }
}, 600)

/** Drop a document's draft once it is clean or gone. */
function dropDraft (doc) {
  if (doc?.draftId) api.draft?.remove?.(doc.draftId)
}

/* ------------------------------------------------------------- mode layer */

const FACTORIES = {
  source: createSourceMode,
  rich: createRichMode,
  reading: createReadingMode
}

function buildMode (id, container, onChange) {
  const mode = FACTORIES[id]({
    theme: state.theme,
    settings: state.settings,
    onChange,
    onLinkClick: handleLinkActivation
  })
  mode.mount(container)
  mode.setTheme?.(state.theme)
  mode.applySettings?.(state.settings)
  mode.setWrap?.(state.settings.wrap !== false)
  return mode
}

/** Pull the live text and scroll position out of the mounted modes. */
function syncFromModes () {
  const doc = activeDoc()
  if (!doc || !state.primary) return
  if (state.primary.isDirty?.()) doc.markdown = state.primary.getMarkdown()
  const f = state.primary.getScrollFraction?.()
  if (typeof f === 'number' && !Number.isNaN(f)) doc.scroll = f
}

function teardownLayout () {
  syncFromModes()
  for (const m of state.mounted) {
    try { m.destroy?.() } catch (err) { console.error('mode teardown failed', err) }
  }
  state.mounted = []
  state.primary = null
  el.modeHost.innerHTML = ''
  el.modeHost.style.removeProperty('--split-ratio')
}

const onEditDebounced = debounce(() => {
  const doc = activeDoc()
  if (!doc || !state.primary) return
  doc.markdown = state.primary.getMarkdown()
  paintTabs()
  paintStatus()
  paintOutline()
  updateTitle()
  persistDrafts()
  // The tab may only now have earned a place in the session record.
  persistSession()
}, 150)

function handleEdit () {
  onEditDebounced()
}

function mountLayout () {
  const doc = activeDoc()
  if (!doc) return
  teardownLayout()

  document.body.dataset.mode = doc.mode

  if (doc.mode === 'split') {
    mountSplit(doc)
  } else {
    const mode = buildMode(doc.mode, el.modeHost, handleEdit)
    mode.setMarkdown(doc.markdown)
    mode.setScrollFraction?.(doc.scroll || 0)
    state.mounted = [mode]
    state.primary = mode
    if (mode.editable) mode.focus?.()
  }

  paintToolbar()
  paintStatus()
  paintOutline()
  syncMenuState()
}

/* ------------------------------------------------------------ split view */

function mountSplit (doc) {
  const paneA = document.createElement('div')
  paneA.className = 'split-pane'
  paneA.id = 'pane-a'
  const divider = document.createElement('div')
  divider.id = 'split-divider'
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-label', 'Resize panes')
  divider.tabIndex = 0
  const paneB = document.createElement('div')
  paneB.className = 'split-pane'
  paneB.id = 'pane-b'
  el.modeHost.append(paneA, divider, paneB)

  setSplitRatio(state.settings.splitRatio ?? 0.5, { persist: false })

  const pushPreview = debounce(() => {
    preview.setMarkdown(editor.getMarkdown())
  }, 160)

  const editor = buildMode('source', paneA, () => { handleEdit(); pushPreview() })
  const preview = buildMode('reading', paneB, () => {})

  editor.setMarkdown(doc.markdown)
  preview.setMarkdown(doc.markdown)
  editor.setScrollFraction?.(doc.scroll || 0)
  preview.setScrollFraction?.(doc.scroll || 0)

  state.mounted = [editor, preview]
  state.primary = editor

  // Two-way scroll sync, guarded so a programmatic scroll can't echo back.
  let syncing = false
  const linkScroll = (from, to) => {
    from.onScroll?.(() => {
      if (syncing) return
      syncing = true
      const f = from.getScrollFraction?.()
      if (typeof f === 'number' && !Number.isNaN(f)) to.setScrollFraction?.(f)
      requestAnimationFrame(() => { syncing = false })
    })
  }
  linkScroll(editor, preview)
  linkScroll(preview, editor)

  wireDivider(divider)
  editor.focus?.()
}

function setSplitRatio (ratio, { persist = true } = {}) {
  const clamped = Math.min(0.85, Math.max(0.15, ratio))
  el.modeHost.style.setProperty('--split-ratio', String(clamped))
  if (persist) updateSettings({ splitRatio: clamped })
}

function wireDivider (divider) {
  divider.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    const rect = el.modeHost.getBoundingClientRect()
    document.body.classList.add('is-resizing')
    divider.classList.add('is-dragging')
    const onMove = (e) => setSplitRatio((e.clientX - rect.left) / rect.width, { persist: false })
    const onUp = (e) => {
      document.body.classList.remove('is-resizing')
      divider.classList.remove('is-dragging')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setSplitRatio((e.clientX - rect.left) / rect.width)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
  divider.addEventListener('dblclick', () => setSplitRatio(0.5))
  divider.addEventListener('keydown', (e) => {
    const cur = parseFloat(el.modeHost.style.getPropertyValue('--split-ratio')) || 0.5
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSplitRatio(cur - 0.02) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSplitRatio(cur + 0.02) }
    if (e.key === 'Home') { e.preventDefault(); setSplitRatio(0.5) }
  })
}

/* ------------------------------------------------------------------ modes */

const MODE_CYCLE = ['source', 'rich', 'split', 'reading']

function setMode (modeId) {
  const doc = activeDoc()
  if (!doc || doc.mode === modeId || !MODE_CYCLE.includes(modeId)) return
  syncFromModes()
  doc.mode = modeId
  updateSettings({ mode: modeId })
  mountLayout()
  persistSession()
}

function cycleMode () {
  const doc = activeDoc()
  if (!doc) return
  const i = MODE_CYCLE.indexOf(doc.mode)
  setMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length])
}

/* ------------------------------------------------------------------- tabs */

function openDoc (doc, { activate = true } = {}) {
  state.docs.push(doc)
  if (activate) {
    state.activeId = doc.id
    mountLayout()
    paintTabs()
    updateTitle()
    paintFolderTree()
  } else {
    paintTabs()
  }
  persistSession()
  return doc
}

function setActive (id) {
  if (state.activeId === id) return
  syncFromModes()
  state.activeId = id
  mountLayout()
  paintTabs()
  updateTitle()
  paintFolderTree()
  persistSession()
}

function focusExisting (path) {
  if (!path) return null
  const norm = path.toLowerCase()
  return state.docs.find((d) => d.path && d.path.toLowerCase() === norm) || null
}

function newTab () {
  openDoc(makeDoc({ mode: state.settings.mode }))
}

async function closeTab (id) {
  const idx = state.docs.findIndex((d) => d.id === id)
  if (idx === -1) return true
  const doc = state.docs[idx]
  if (doc.id === state.activeId) syncFromModes()

  if (isDirty(doc)) {
    if (doc.id !== state.activeId) setActive(doc.id)
    const choice = await api.dialog.confirmDiscard(doc.title)
    if (choice === 'cancel') return false
    if (choice === 'save' && !(await saveDoc(doc))) return false
  }

  const at = state.docs.findIndex((d) => d.id === id)
  dropDraft(doc)
  state.docs.splice(at, 1)

  if (state.docs.length === 0) {
    const fresh = makeDoc({ mode: state.settings.mode })
    state.docs.push(fresh)
    state.activeId = fresh.id
    mountLayout()
  } else if (doc.id === state.activeId) {
    state.activeId = state.docs[Math.min(at, state.docs.length - 1)].id
    mountLayout()
  }
  paintTabs()
  updateTitle()
  paintFolderTree()
  persistSession()
  return true
}

function stepTab (delta) {
  if (state.docs.length < 2) return
  const i = state.docs.findIndex((d) => d.id === state.activeId)
  const next = (i + delta + state.docs.length) % state.docs.length
  setActive(state.docs[next].id)
}

/* -------------------------------------------------------------- file i/o */

async function openPath (path) {
  const existing = focusExisting(path)
  if (existing) { setActive(existing.id); return existing }
  const res = await api.file.openPath(path)
  if (res.error) { api.dialog.error('Could not open file', res.error); return null }
  return adoptOpened(res)
}

/** Reuse a pristine untitled tab rather than stacking an empty one up. */
function adoptOpened (res) {
  const current = activeDoc()
  if (current && !current.path && !isDirty(current) && current.markdown === '') {
    current.path = res.path
    current.title = basename(res.path)
    current.markdown = res.content
    current.savedMarkdown = res.content
    mountLayout()
    paintTabs()
    updateTitle()
    paintFolderTree()
    persistSession()
    return current
  }
  return openDoc(makeDoc({ path: res.path, markdown: res.content, mode: state.settings.mode }))
}

async function openViaDialog () {
  const res = await api.file.openDialog()
  if (res.canceled || res.error) return
  const existing = focusExisting(res.path)
  if (existing) setActive(existing.id)
  else adoptOpened(res)
}

async function saveDoc (doc) {
  if (doc.id === state.activeId) syncFromModes()
  if (doc.path) {
    const res = await api.file.save(doc.path, doc.markdown)
    if (res.error) { api.dialog.error('Could not save file', res.error); return false }
  } else {
    const res = await api.file.saveDialog(doc.markdown, `${doc.title}.md`)
    if (res.canceled) return false
    if (res.error) { api.dialog.error('Could not save file', res.error); return false }
    doc.path = res.path
    doc.title = basename(res.path)
  }
  doc.savedMarkdown = doc.markdown
  dropDraft(doc)
  paintTabs(); paintStatus(); updateTitle(); persistSession()
  return true
}

async function saveDocAs (doc) {
  if (doc.id === state.activeId) syncFromModes()
  const res = await api.file.saveDialog(doc.markdown, `${doc.title}.md`)
  if (res.canceled) return false
  if (res.error) { api.dialog.error('Could not save file', res.error); return false }
  doc.path = res.path
  doc.title = basename(res.path)
  doc.savedMarkdown = doc.markdown
  dropDraft(doc)
  paintTabs(); paintStatus(); updateTitle(); persistSession()
  return true
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** Inline the app's own stylesheets so an exported file is self-contained. */
function collectStyles () {
  let out = ''
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) out += rule.cssText + '\n'
    } catch {
      // cross-origin sheet; nothing we can do about it
    }
  }
  return out
}

function buildExportHtml (doc) {
  return `<!doctype html>
<html data-theme="${state.theme}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>${collectStyles()}</style>
</head>
<body class="exported">
<article class="markdown-body">${renderMarkdown(doc.markdown)}</article>
</body>
</html>`
}

function exportBaseName (doc) {
  return doc.title.replace(/\.[^.]+$/, '')
}

async function exportHtml () {
  const doc = activeDoc()
  if (!doc) return
  syncFromModes()
  const res = await api.file.exportHtml(buildExportHtml(doc), `${exportBaseName(doc)}.html`)
  if (res && res.error) api.dialog.error('Could not export', res.error)
}

async function exportPdf () {
  const doc = activeDoc()
  if (!doc) return
  if (!api.file.exportPdf) { api.dialog.error('Export as PDF', 'PDF export is not available in this build.'); return }
  syncFromModes()
  const res = await api.file.exportPdf(buildExportHtml(doc), `${exportBaseName(doc)}.pdf`)
  if (res && res.error) api.dialog.error('Could not export', res.error)
}

/* ----------------------------------------------------------------- links */

function handleLinkActivation (href) {
  if (!href) return
  if (href.startsWith('#')) {
    state.primary?.scrollToSlug?.(decodeURIComponent(href.slice(1)))
    return
  }
  if (/^https?:\/\//i.test(href)) { api.shell.openExternal(href); return }
  // Anything else is treated as a sibling file next to the current document.
  const doc = activeDoc()
  if (!doc?.path) return
  const sep = doc.path.includes('\\') ? '\\' : '/'
  openPath(`${dirname(doc.path)}${sep}${href.replace(/^\.[\\/]/, '')}`)
}

/* -------------------------------------------------------------- painting */

function paintTabs () {
  const frag = document.createDocumentFragment()
  for (const doc of state.docs) {
    const tab = document.createElement('div')
    tab.className = 'tab'
    tab.dataset.tabId = doc.id
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(doc.id === state.activeId))
    tab.title = doc.path || doc.title
    if (isDirty(doc)) tab.dataset.dirty = 'true'

    const title = document.createElement('span')
    title.className = 'tab-title'
    title.textContent = doc.title

    const dot = document.createElement('span')
    dot.className = 'tab-dot'
    dot.setAttribute('aria-hidden', 'true')

    const close = document.createElement('button')
    close.className = 'tab-close'
    close.setAttribute('aria-label', `Close ${doc.title}`)
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

    tab.append(title, dot, close)
    frag.append(tab)
  }
  el.tabs?.replaceChildren(frag)
  el.tabs?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function paintToolbar () {
  const doc = activeDoc()
  for (const btn of document.querySelectorAll('#mode-switch [data-mode]')) {
    const on = !!doc && btn.dataset.mode === doc.mode
    btn.setAttribute('aria-pressed', String(on))
    btn.classList.toggle('is-active', on)
  }
  const editable = state.primary ? state.primary.editable !== false : true
  el.formatBar?.toggleAttribute('hidden', !editable)
  el.btnWrap?.classList.toggle('is-active', state.settings.wrap !== false)
  el.btnTheme?.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`)
  paintFormatState()
}

function paintFormatState () {
  if (!el.formatBar || !state.primary?.queryState) return
  let active
  try { active = state.primary.queryState() } catch { return }
  if (!active) return
  for (const btn of el.formatBar.querySelectorAll('[data-cmd]')) {
    btn.classList.toggle('is-active', active.has(btn.dataset.cmd))
  }
}

const MODE_LABEL = { source: 'Source', rich: 'Rich text', split: 'Split', reading: 'Reading' }

function paintStatus () {
  const doc = activeDoc()
  if (!doc) return
  if (el.statusFile) {
    el.statusFile.textContent = doc.path || doc.title
    el.statusFile.title = doc.path || ''
  }
  if (el.statusDirty) el.statusDirty.textContent = isDirty(doc) ? 'Unsaved' : ''
  if (el.statusMode) el.statusMode.textContent = MODE_LABEL[doc.mode] || doc.mode
  const stats = state.primary?.getStats?.()
  if (el.statusStats && stats) {
    el.statusStats.textContent = `${stats.words} words · ${stats.chars} chars · ${stats.lines} lines`
  }
}

function paintOutline () {
  if (!el.outlineList) return
  let items = []
  try { items = state.primary?.getOutline?.() || [] } catch {}
  el.outlineEmpty?.toggleAttribute('hidden', items.length > 0)
  const frag = document.createDocumentFragment()
  for (const h of items) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.className = 'outline-item'
    btn.dataset.slug = h.slug
    btn.dataset.level = String(h.level || 1)
    li.dataset.level = String(h.level || 1)
    btn.style.setProperty('--depth', String(Math.max(0, (h.level || 1) - 1)))
    btn.textContent = h.text
    btn.title = h.text
    li.append(btn)
    frag.append(li)
  }
  el.outlineList.replaceChildren(frag)
}

function paintRecent () {
  if (!el.recentList) return
  const recents = state.settings.recentFiles || []
  el.recentEmpty?.toggleAttribute('hidden', recents.length > 0)
  const frag = document.createDocumentFragment()
  for (const p of recents) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.className = 'recent-item'
    btn.dataset.path = p
    btn.textContent = basename(p)
    btn.title = p
    li.append(btn)
    frag.append(li)
  }
  el.recentList.replaceChildren(frag)
}

/** Flat depth-tagged entries -> only the rows whose ancestors are all open. */
function visibleTreeEntries () {
  const out = []
  let hideBelow = Infinity
  for (const e of state.folder.entries) {
    if (e.depth > hideBelow) continue
    hideBelow = Infinity
    out.push(e)
    if (e.dir && !state.folder.open.has(e.path)) hideBelow = e.depth
  }
  return out
}

function paintFolderTree () {
  if (!el.treeList) return
  if (el.folderName) el.folderName.textContent = basename(state.folder.path) || ''
  el.treeEmpty?.toggleAttribute('hidden', !!state.folder.path)
  const activePath = activeDoc()?.path?.toLowerCase()
  const frag = document.createDocumentFragment()
  for (const e of visibleTreeEntries()) {
    const li = document.createElement('li')
    li.className = 'tree-item'
    li.dataset.path = e.path
    li.dataset.depth = String(e.depth)
    li.style.setProperty('--depth', String(e.depth))
    if (e.dir) li.dataset.open = String(state.folder.open.has(e.path))
    else if (activePath && e.path.toLowerCase() === activePath) li.dataset.active = 'true'

    const tw = document.createElement('span')
    tw.className = e.dir ? 'tree-twisty' : 'tree-twisty is-leaf'
    if (e.dir) {
      tw.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    }
    const label = document.createElement('span')
    label.className = 'tree-label'
    label.textContent = e.name
    label.title = e.path
    li.append(tw, label)
    frag.append(li)
  }
  el.treeList.replaceChildren(frag)
}

function updateTitle () {
  const doc = activeDoc()
  if (!doc) return
  const title = `${isDirty(doc) ? '● ' : ''}${doc.title} — Forme`
  api.win.setTitle(title)
  api.win.setDocumentEdited(isDirty(doc))
  document.title = title
}

function syncMenuState () {
  const doc = activeDoc()
  api.menu.setState({
    mode: doc?.mode || state.settings.mode,
    theme: state.settings.theme,
    dirty: isDirty(doc),
    hasFile: !!doc?.path
  })
}

function repaintAll () {
  paintTabs(); paintToolbar(); paintStatus(); paintOutline()
  paintRecent(); paintFolderTree(); paintSidebar(); updateTitle(); syncMenuState()
  if (typeof paintPrefs === 'function') paintPrefs()
}

/* ---------------------------------------------------------------- sidebar */

const SIDEBAR_TITLE = { files: 'Explorer', outline: 'Outline', recent: 'Recent' }

function paintSidebar () {
  const view = state.settings.sidebarView || 'files'
  const collapsed = state.settings.sidebarVisible === false
  for (const btn of document.querySelectorAll('#activitybar .activity-item')) {
    const on = btn.dataset.view === view && !collapsed
    btn.classList.toggle('is-active', on)
    btn.setAttribute('aria-selected', String(on))
  }
  if (el.sidebarTitle) el.sidebarTitle.textContent = SIDEBAR_TITLE[view] || ''
}

function toggleSidebar () {
  updateSettings({ sidebarVisible: state.settings.sidebarVisible === false }, { immediate: true })
  applyBodySettings()
  paintSidebar()
}

/** Clicking the active rail icon collapses, as it does in VS Code. */
function setSidebarView (view) {
  if (!SIDEBAR_TITLE[view]) return
  const collapsed = state.settings.sidebarVisible === false
  if (view === state.settings.sidebarView && !collapsed) { toggleSidebar(); return }
  updateSettings({ sidebarView: view, sidebarVisible: true }, { immediate: true })
  applyBodySettings()
  paintSidebar()
}

function setSidebarWidth (px, { persist = true } = {}) {
  const clamped = Math.min(480, Math.max(160, Math.round(px)))
  el.body?.style.setProperty('--sidebar-width', `${clamped}px`)
  if (persist) updateSettings({ sidebarWidth: clamped })
}

/* ------------------------------------------------------------- folder ops */

function adoptFolder (res) {
  state.folder.path = res.path
  state.folder.entries = res.entries || []
  state.folder.truncated = !!res.truncated
  // Open the top level so the tree isn't a wall of closed folders.
  state.folder.open = new Set(
    state.folder.entries.filter((e) => e.dir && e.depth === 0).map((e) => e.path)
  )
  paintFolderTree()
}

async function chooseFolder () {
  const res = await api.folder.choose()
  if (!res || res.canceled) return
  if (res.error) { api.dialog.error('Could not open folder', res.error); return }
  adoptFolder(res)
  updateSettings({ folder: res.path }, { immediate: true })
}

async function refreshFolder () {
  if (!state.folder.path) return
  const res = await api.folder.list(state.folder.path)
  if (!res || res.error) return
  const wasOpen = state.folder.open
  state.folder.entries = res.entries || []
  state.folder.open = new Set(
    [...wasOpen].filter((p) => state.folder.entries.some((e) => e.dir && e.path === p))
  )
  paintFolderTree()
}

/* -------------------------------------------------------------- commands */

function toggleWrap () {
  updateSettings({ wrap: state.settings.wrap === false }, { immediate: true })
  applyBodySettings()
  paintToolbar()
}

function zoom (dir) {
  const next = Math.min(32, Math.max(10, (state.settings.fontSize || 15) + dir))
  updateSettings({ fontSize: next }, { immediate: true })
  applyBodySettings()
}

/**
 * Main gives us a 4s window to answer before it quits regardless. Answering
 * 'wait' holds that timer open, which we re-send before every dialog so a long
 * sequence of save prompts can't get quit out from under the user.
 */
async function handleBeforeQuit () {
  if (state.quitting) return
  state.quitting = true
  syncFromModes()

  const dirty = state.docs.filter((d) => isDirty(d))
  if (!dirty.length) { api.app.quitResponse('quit'); return }

  const abort = () => { state.quitting = false; api.app.quitResponse('cancel') }

  for (const doc of dirty) {
    api.app.quitResponse('wait')
    setActive(doc.id)
    const choice = await api.dialog.confirmDiscard(doc.title)
    if (choice === 'cancel') { abort(); return }
    if (choice === 'save') {
      if (!(await saveDoc(doc))) { abort(); return }
    } else {
      // Explicitly discarded — do not resurrect it on next launch.
      doc.savedMarkdown = doc.markdown
      dropDraft(doc)
    }
  }
  api.app.quitResponse('quit')
}

const commands = {
  'file:new': () => newTab(),
  'tab:new': () => newTab(),
  'file:open': (payload) => (payload?.path ? openPath(payload.path) : openViaDialog()),
  'folder:open': () => chooseFolder(),
  'file:save': () => { const d = activeDoc(); if (d) saveDoc(d) },
  'file:saveAs': () => { const d = activeDoc(); if (d) saveDocAs(d) },
  'file:export-html': () => exportHtml(),
  'file:export-pdf': () => exportPdf(),
  'app:exit': () => api.win.close?.(),
  'tab:close': () => { if (state.activeId) closeTab(state.activeId) },
  'tab:next': () => stepTab(1),
  'tab:prev': () => stepTab(-1),
  'mode:source': () => setMode('source'),
  'mode:rich': () => setMode('rich'),
  'mode:split': () => setMode(activeDoc()?.mode === 'split' ? 'source' : 'split'),
  'mode:reading': () => setMode('reading'),
  'mode:cycle': () => cycleMode(),
  'theme:toggle': () => toggleThemeMode(),
  'theme:dark': () => selectTheme(state.settings.themeDark || 'dark'),
  'theme:light': () => selectTheme(state.settings.themeLight || 'light'),
  'theme:system': () => {
    state.themeOverride = null
    updateSettings({ theme: 'system' }, { immediate: true })
    applyTheme()
  },
  'app:preferences': () => openPrefs(),
  'view:toggle-sidebar': () => toggleSidebar(),
  'view:toggle-wrap': () => toggleWrap(),
  'view:zoom-in': () => zoom(1),
  'view:zoom-out': () => zoom(-1),
  'view:zoom-reset': () => { updateSettings({ fontSize: 15 }, { immediate: true }); applyBodySettings() },
  'edit:find': () => state.primary?.find?.(),
  'help:about': () => api.dialog.error(
    'Forme',
    'Forme — a markdown editor with source, rich text, split and reading views.\n\nElectron · CodeMirror 6 · TipTap · markdown-it'
  ),
  'settings:changed': (payload) => {
    if (!payload) return
    Object.assign(state.settings, payload)
    paintRecent()
  },
  'app:before-quit': () => handleBeforeQuit()
}

/* --------------------------------------------------- window chrome + menu */

/**
 * The app menu replaces the native menu bar on Windows/Linux. Accelerators are
 * still owned by the main process (before-input-event), so the strings here are
 * labels only — they do not bind anything.
 */
function appMenuSpec () {
  const doc = activeDoc()
  const mode = doc?.mode
  const recents = (state.settings.recentFiles || []).slice(0, 5)

  const items = [
    { section: 'File' },
    { command: 'tab:new', label: 'New File', accel: 'Ctrl+T' },
    { command: 'file:open', label: 'Open File…', accel: 'Ctrl+O' },
    { command: 'folder:open', label: 'Open Folder…', accel: 'Ctrl+Shift+O' }
  ]

  if (recents.length) {
    items.push({ separator: true }, { section: 'Recent' })
    for (const p of recents) {
      items.push({ command: 'file:open', payload: { path: p }, label: basename(p), title: p })
    }
  }

  items.push(
    { separator: true },
    { command: 'file:save', label: 'Save', accel: 'Ctrl+S' },
    { command: 'file:saveAs', label: 'Save As…', accel: 'Ctrl+Shift+S' },
    { separator: true },
    { command: 'file:export-html', label: 'Export as HTML…' },
    { command: 'file:export-pdf', label: 'Export as PDF…' },
    { separator: true },
    { section: 'View' },
    { command: 'mode:source', label: 'Source', accel: 'Ctrl+1', checked: mode === 'source' },
    { command: 'mode:rich', label: 'Rich Text', accel: 'Ctrl+2', checked: mode === 'rich' },
    { command: 'mode:reading', label: 'Reading', accel: 'Ctrl+3', checked: mode === 'reading' },
    { command: 'mode:split', label: 'Split', accel: 'Ctrl+H', checked: mode === 'split' },
    { separator: true },
    { command: 'view:toggle-sidebar', label: 'Toggle Sidebar', accel: 'Ctrl+B', checked: state.settings.sidebarVisible !== false },
    { command: 'view:toggle-wrap', label: 'Word Wrap', accel: 'Alt+Z', checked: state.settings.wrap !== false },
    { command: 'theme:toggle', label: 'Toggle Theme', accel: 'Ctrl+Shift+D' },
    { separator: true },
    { command: 'app:preferences', label: 'Preferences…', accel: 'Ctrl+,' },
    { command: 'help:about', label: 'About Forme' },
    { command: 'app:exit', label: 'Exit', accel: 'Ctrl+Q' }
  )
  return items
}

function renderAppMenu () {
  if (!el.appMenu) return
  const frag = document.createDocumentFragment()
  for (const spec of appMenuSpec()) {
    if (spec.separator) {
      frag.append(Object.assign(document.createElement('div'), { className: 'menu-separator' }))
      continue
    }
    if (spec.section) {
      const s = document.createElement('div')
      s.className = 'menu-section-label'
      s.textContent = spec.section
      frag.append(s)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'menu-item'
    btn.type = 'button'
    btn.setAttribute('role', 'menuitem')
    btn.dataset.command = spec.command
    if (spec.payload) btn.dataset.payload = JSON.stringify(spec.payload)
    if (spec.checked) btn.dataset.checked = 'true'
    if (spec.title) btn.title = spec.title

    const label = document.createElement('span')
    label.className = 'menu-item-label'
    label.textContent = spec.label
    btn.append(label)

    if (spec.accel) {
      const a = document.createElement('span')
      a.className = 'menu-item-accel'
      a.textContent = spec.accel
      btn.append(a)
    }
    frag.append(btn)
  }
  el.appMenu.replaceChildren(frag)
}

function appMenuOpen () {
  return el.appMenu && !el.appMenu.hasAttribute('hidden')
}

function openAppMenu () {
  if (!el.appMenu) return
  renderAppMenu()
  el.appMenu.removeAttribute('hidden')
  el.btnAppMenu?.setAttribute('aria-expanded', 'true')
  el.appMenu.querySelector('.menu-item')?.focus()
}

function closeAppMenu ({ restoreFocus = false } = {}) {
  if (!el.appMenu) return
  el.appMenu.setAttribute('hidden', '')
  el.btnAppMenu?.setAttribute('aria-expanded', 'false')
  if (restoreFocus) el.btnAppMenu?.focus()
}

function toggleAppMenu () {
  appMenuOpen() ? closeAppMenu({ restoreFocus: true }) : openAppMenu()
}

function wireAppMenu () {
  el.btnAppMenu?.addEventListener('click', (e) => { e.stopPropagation(); toggleAppMenu() })

  el.appMenu?.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item')
    if (!item || item.disabled) return
    const command = item.dataset.command
    const payload = item.dataset.payload ? JSON.parse(item.dataset.payload) : undefined
    closeAppMenu()
    commands[command]?.(payload)
  })

  // Roving focus with the arrow keys, Escape to dismiss.
  el.appMenu?.addEventListener('keydown', (e) => {
    const items = [...el.appMenu.querySelectorAll('.menu-item:not([disabled])')]
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus() }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus() }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus() }
    else if (e.key === 'Escape') { e.preventDefault(); closeAppMenu({ restoreFocus: true }) }
    else if (e.key === 'Tab') closeAppMenu()
  })

  document.addEventListener('pointerdown', (e) => {
    if (!appMenuOpen()) return
    if (e.target.closest('#app-menu') || e.target.closest('#btn-app-menu')) return
    closeAppMenu()
  })
  window.addEventListener('blur', () => closeAppMenu())
}

function setMaximized (max) {
  document.body.dataset.maximized = String(!!max)
  el.btnWinMax?.setAttribute('data-maximized', String(!!max))
  el.btnWinMax?.setAttribute('aria-label', max ? 'Restore' : 'Maximise')
}

function wireWindowControls () {
  el.btnWinMin?.addEventListener('click', () => api.win.minimize?.())
  el.btnWinMax?.addEventListener('click', () => api.win.maximizeToggle?.())
  el.btnWinClose?.addEventListener('click', () => api.win.close?.())
  api.win.onMaximizeChange?.((max) => setMaximized(max))
  api.win.isMaximized?.().then?.((max) => setMaximized(max))
}

/* ------------------------------------------------------------ preferences */

const PREFS_PANES = ['appearance', 'editor', 'general']

/** The element focused before the modal opened, so we can hand focus back. */
let prefsReturnFocus = null

function prefsOpen () {
  return el.prefsOverlay && !el.prefsOverlay.hasAttribute('hidden')
}

function paintThemeGrid () {
  if (!el.prefsThemeGrid) return
  const following = state.settings.theme === 'system'
  const frag = document.createDocumentFragment()

  for (const t of state.themes) {
    const btn = document.createElement('button')
    btn.className = 'theme-swatch'
    btn.type = 'button'
    btn.dataset.themeId = t.id
    btn.setAttribute('aria-pressed', String(!following && state.themeId === t.id))

    const chips = document.createElement('span')
    chips.className = 'swatch-chips'
    for (const key of ['bg', 'bg-elevated', 'accent', 'fg']) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.style.background = (t.preview && t.preview[key]) || 'transparent'
      chips.append(chip)
    }

    const name = document.createElement('span')
    name.className = 'swatch-name'
    name.textContent = t.name

    btn.append(chips, name)
    if (!t.builtin) {
      const badge = document.createElement('span')
      badge.className = 'swatch-badge'
      badge.textContent = 'Custom'
      btn.append(badge)
    }
    frag.append(btn)
  }
  el.prefsThemeGrid.replaceChildren(frag)
}

function setSegmented (root, value) {
  if (!root) return
  for (const b of root.querySelectorAll('[data-value]')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === value))
  }
}

function setToggle (btn, on) {
  btn?.setAttribute('aria-checked', String(!!on))
}

/** Push current settings into every control. One-way: state -> DOM. */
function paintPrefs () {
  if (!el.prefsOverlay) return
  const s = state.settings

  paintThemeGrid()
  setToggle(el.prefFollowSystem, s.theme === 'system')

  setSegmented(el.prefFontFamily, s.fontFamily || 'sans')
  setSegmented(el.prefLineWidth, s.lineWidth || 'normal')
  if (el.prefFontSize) el.prefFontSize.value = String(s.fontSize || 15)
  if (el.prefFontSizeValue) el.prefFontSizeValue.textContent = `${s.fontSize || 15}px`

  setToggle(el.prefWrap, s.wrap !== false)
  setToggle(el.prefLineNumbers, s.showLineNumbers !== false)
  setToggle(el.prefSpellcheck, s.spellcheck !== false)
  setToggle(el.prefRestoreSession, s.restoreSession !== false)
  setToggle(el.prefKeepDrafts, s.keepDrafts !== false)
  refreshDraftCount()
  if (el.prefDefaultMode) el.prefDefaultMode.value = s.mode || 'source'
}

/** Report how much unsaved work is actually being held, so the button is honest. */
async function refreshDraftCount () {
  if (!el.draftsCount) return
  let drafts = []
  try { drafts = (await api.draft?.list?.()) || [] } catch {}
  const n = drafts.length
  el.draftsCount.textContent = n === 0
    ? 'No drafts stored.'
    : `${n} draft${n === 1 ? '' : 's'} held on disk.`
  if (el.btnDiscardDrafts) el.btnDiscardDrafts.disabled = n === 0
}

let discardArmed = null

/** Two-step confirm rather than a dialog — this deletes unsaved work. */
async function discardDrafts () {
  const btn = el.btnDiscardDrafts
  if (!btn) return
  if (!discardArmed) {
    btn.dataset.confirm = 'true'
    btn.textContent = 'Really discard?'
    discardArmed = setTimeout(() => {
      discardArmed = null
      delete btn.dataset.confirm
      btn.textContent = 'Discard drafts'
    }, 4000)
    return
  }
  clearTimeout(discardArmed)
  discardArmed = null
  delete btn.dataset.confirm
  btn.textContent = 'Discard drafts'

  if (api.draft?.clear) {
    await api.draft.clear()
  } else {
    // Older preload without clear(): remove them one by one.
    for (const d of (await api.draft?.list?.()) || []) await api.draft.remove(d.draftId)
  }
  // Anything still open keeps its own buffer; it just no longer has a draft file.
  refreshDraftCount()
}

function paintPrefsFooter () {
  if (!el.prefsApply) return
  const dirty = prefsStaging ? Object.keys(prefsStaging.patch).length > 0 : false
  el.prefsApply.disabled = !dirty
}

/** Write the staged changes to disk and close. */
function applyPrefs () {
  if (prefsStaging && Object.keys(prefsStaging.patch).length) {
    api.settings.set({ ...prefsStaging.patch })
  }
  prefsStaging = null
  closePrefs()
}

/** Put back everything the dialog changed, then close without writing. */
async function cancelPrefs () {
  if (!prefsStaging) { closePrefs(); return }
  const { snapshot, patch } = prefsStaging
  const themeTouched = ['theme', 'themeDark', 'themeLight'].some((k) => k in patch)
  for (const key of Object.keys(patch)) state.settings[key] = snapshot[key]
  prefsStaging = null

  applyBodySettings()
  if (themeTouched) await applyTheme()
  paintPrefs()
  paintToolbar()
  closePrefs()
}

function setPrefsPane (pane) {
  if (!PREFS_PANES.includes(pane)) return
  document.body.dataset.prefsPane = pane
  for (const tab of document.querySelectorAll('.prefs-tab')) {
    const on = tab.dataset.pane === pane
    tab.setAttribute('aria-selected', String(on))
    tab.classList.toggle('is-active', on)
  }
}

function openPrefs () {
  if (!el.prefsOverlay) return
  // Snapshot before anything can change, so Cancel has something to restore.
  prefsStaging = { patch: {}, snapshot: {}, original: { ...state.settings } }
  prefsReturnFocus = document.activeElement
  closeAppMenu()
  loadThemeList().then(paintThemeGrid)
  paintPrefs()
  if (!document.body.dataset.prefsPane) setPrefsPane('appearance')
  paintPrefsFooter()
  el.prefsOverlay.removeAttribute('hidden')
  el.prefsDialog?.querySelector('.prefs-tab')?.focus()
}

function closePrefs () {
  if (!el.prefsOverlay) return
  el.prefsOverlay.setAttribute('hidden', '')
  if (prefsReturnFocus && document.contains(prefsReturnFocus)) prefsReturnFocus.focus()
  prefsReturnFocus = null
  state.primary?.focus?.()
}

/** Settings that only need a body attribute + a nudge to the live modes. */
function prefsApplyLive (patch) {
  updateSettings(patch, { immediate: true })
  applyBodySettings()
  paintPrefs()
  paintToolbar()
}

async function resetPrefs () {
  const choice = await api.dialog.confirmDiscard?.('all preferences')
  // confirmDiscard is phrased for documents; treat anything but an explicit
  // 'discard' as a decline so a stray Enter cannot wipe settings.
  if (choice !== 'discard') return
  // Staged like any other edit: nothing is written until Apply.
  prefsApplyLive({
    keepDrafts: true,
    theme: 'system',
    themeDark: 'dark',
    themeLight: 'light',
    fontFamily: 'sans',
    fontSize: 15,
    lineWidth: 'normal',
    wrap: true,
    showLineNumbers: true,
    spellcheck: true,
    restoreSession: true,
    mode: 'source'
  })
  await applyTheme()
  paintPrefs()
}

function wirePrefs () {
  el.prefsOverlay = $('#prefs-overlay')
  el.prefsDialog = $('#prefs-dialog')
  el.prefsThemeGrid = $('#prefs-theme-grid')
  el.prefFollowSystem = $('#pref-follow-system')
  el.prefFontFamily = $('#pref-font-family')
  el.prefFontSize = $('#pref-font-size')
  el.prefFontSizeValue = $('#pref-font-size-value')
  el.prefLineWidth = $('#pref-line-width')
  el.prefWrap = $('#pref-wrap')
  el.prefLineNumbers = $('#pref-line-numbers')
  el.prefSpellcheck = $('#pref-spellcheck')
  el.prefDefaultMode = $('#pref-default-mode')
  el.prefRestoreSession = $('#pref-restore-session')
  el.prefsApply = $('#prefs-apply')
  el.prefsCancel = $('#prefs-cancel')
  el.prefKeepDrafts = $('#pref-keep-drafts')
  el.btnDiscardDrafts = $('#btn-discard-drafts')
  el.draftsCount = $('#drafts-count')

  if (!el.prefsOverlay) return

  // Scrim click closes; clicks inside the dialog must not.
  // Dismissing without Apply discards, which is what Cancel/Esc/✕ should mean
  // once the dialog has an explicit Apply button.
  el.prefsOverlay.addEventListener('pointerdown', (e) => {
    if (e.target === el.prefsOverlay) cancelPrefs()
  })
  $('#prefs-close')?.addEventListener('click', () => cancelPrefs())
  el.prefsCancel?.addEventListener('click', () => cancelPrefs())
  el.prefsApply?.addEventListener('click', () => applyPrefs())

  $('#prefs-nav')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.prefs-tab')
    if (tab) setPrefsPane(tab.dataset.pane)
  })

  el.prefsThemeGrid?.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-theme-id]')
    if (!sw) return
    selectTheme(sw.dataset.themeId).then(paintPrefs)
  })

  el.prefFollowSystem?.addEventListener('click', async () => {
    const following = state.settings.theme === 'system'
    if (following) {
      await selectTheme(state.theme === 'dark'
        ? (state.settings.themeDark || 'dark')
        : (state.settings.themeLight || 'light'))
    } else {
      updateSettings({ theme: 'system' }, { immediate: true })
      await applyTheme()
    }
    paintPrefs()
  })

  $('#btn-open-themes-folder')?.addEventListener('click', () => api.theme?.openFolder?.())

  el.prefFontFamily?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]')
    if (b) prefsApplyLive({ fontFamily: b.dataset.value })
  })
  el.prefLineWidth?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]')
    if (b) prefsApplyLive({ lineWidth: b.dataset.value })
  })

  el.prefFontSize?.addEventListener('input', () => {
    const v = Number(el.prefFontSize.value) || 15
    if (el.prefFontSizeValue) el.prefFontSizeValue.textContent = `${v}px`
    // Live preview while dragging, but only persist on release.
    Object.assign(state.settings, { fontSize: v })
    applyBodySettings()
  })
  el.prefFontSize?.addEventListener('change', () => {
    prefsApplyLive({ fontSize: Number(el.prefFontSize.value) || 15 })
  })

  el.prefWrap?.addEventListener('click', () => prefsApplyLive({ wrap: state.settings.wrap === false }))
  el.prefLineNumbers?.addEventListener('click', () => prefsApplyLive({ showLineNumbers: state.settings.showLineNumbers === false }))
  el.prefSpellcheck?.addEventListener('click', () => prefsApplyLive({ spellcheck: state.settings.spellcheck === false }))
  el.prefRestoreSession?.addEventListener('click', () => prefsApplyLive({ restoreSession: state.settings.restoreSession === false }))
  el.prefKeepDrafts?.addEventListener('click', () => {
    prefsApplyLive({ keepDrafts: state.settings.keepDrafts === false })
    if (state.settings.keepDrafts !== false) persistDrafts()
  })
  el.btnDiscardDrafts?.addEventListener('click', () => discardDrafts())
  el.prefDefaultMode?.addEventListener('change', () => prefsApplyLive({ mode: el.prefDefaultMode.value }))
  $('#prefs-reset')?.addEventListener('click', () => resetPrefs())

  // Escape closes; Tab is trapped inside the dialog while it is open.
  el.prefsOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelPrefs(); return }
    if (e.key !== 'Tab') return
    const focusable = [...el.prefsDialog.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((n) => n.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  })
}

/* ------------------------------------------------------------------ wiring */

function wireSidebar () {
  $('#activitybar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]')
    if (btn) setSidebarView(btn.dataset.view)
  })

  const resizer = $('#sidebar-resizer')
  // Width is measured from the right edge of the always-visible icon rail.
  const railEdge = () => {
    const rail = $('#activitybar')?.getBoundingClientRect()
    return rail ? rail.right : (el.body?.getBoundingClientRect().left || 0)
  }
  resizer?.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    const edge = railEdge()
    document.body.classList.add('is-resizing')
    resizer.classList.add('is-dragging')
    const onMove = (e) => setSidebarWidth(e.clientX - edge, { persist: false })
    const onUp = (e) => {
      document.body.classList.remove('is-resizing')
      resizer.classList.remove('is-dragging')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setSidebarWidth(e.clientX - edge)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
  resizer?.addEventListener('dblclick', () => setSidebarWidth(260))
  resizer?.addEventListener('keydown', (e) => {
    const cur = parseInt(state.settings.sidebarWidth, 10) || 260
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSidebarWidth(cur - 16) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSidebarWidth(cur + 16) }
  })
}

function wireDom () {
  el.body = $('#body')
  el.sidebarTitle = $('#sidebar-title')
  el.appMenu = $('#app-menu')
  el.btnAppMenu = $('#btn-app-menu')
  el.btnWinMin = $('#btn-win-min')
  el.btnWinMax = $('#btn-win-max')
  el.btnWinClose = $('#btn-win-close')
  el.tabs = $('#tabs')
  el.btnNewTab = $('#btn-new-tab')
  el.formatBar = $('#format-bar')
  el.modeHost = $('#mode-host')
  el.btnTheme = $('#btn-theme')
  el.btnWrap = $('#btn-wrap')
  el.statusFile = $('#status-file')
  el.statusDirty = $('#status-dirty')
  el.statusMode = $('#status-mode')
  el.statusStats = $('#status-stats')
  el.folderName = $('#folder-name')
  el.treeList = $('#folder-tree ul')
  el.treeEmpty = $('#folder-tree .empty')
  el.outlineList = $('#outline ul')
  el.outlineEmpty = $('#outline .empty')
  el.recentList = $('#recent-files ul')
  el.recentEmpty = $('#recent-files .empty')

  el.tabs?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab')
    if (!tab) return
    if (e.target.closest('.tab-close')) { e.stopPropagation(); closeTab(tab.dataset.tabId) }
    else setActive(tab.dataset.tabId)
  })
  el.tabs?.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const tab = e.target.closest('.tab')
    if (tab) { e.preventDefault(); closeTab(tab.dataset.tabId) }
  })
  el.tabs?.addEventListener('wheel', (e) => {
    if (e.deltaY) el.tabs.scrollLeft += e.deltaY
  }, { passive: true })
  el.btnNewTab?.addEventListener('click', () => newTab())

  $('#mode-switch')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]')
    if (btn) setMode(btn.dataset.mode)
  })

  el.formatBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]')
    if (!btn) return
    state.primary?.exec?.(btn.dataset.cmd)
    state.primary?.focus?.()
    handleEdit()
    paintFormatState()
  })

  $('#btn-new')?.addEventListener('click', () => newTab())
  $('#btn-open')?.addEventListener('click', () => openViaDialog())
  $('#btn-save')?.addEventListener('click', () => { const d = activeDoc(); if (d) saveDoc(d) })
  $('#btn-sidebar')?.addEventListener('click', () => commands['view:toggle-sidebar']())
  el.btnTheme?.addEventListener('click', () => commands['theme:toggle']())
  el.btnWrap?.addEventListener('click', () => toggleWrap())
  $('#btn-choose-folder')?.addEventListener('click', () => chooseFolder())
  $('#btn-prefs')?.addEventListener('click', () => openPrefs())

  el.outlineList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-slug]')
    if (btn) state.primary?.scrollToSlug?.(btn.dataset.slug)
  })
  el.recentList?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-path]')
    if (btn) openPath(btn.dataset.path)
  })
  el.treeList?.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-item')
    if (!row) return
    const entry = state.folder.entries.find((x) => x.path === row.dataset.path)
    if (!entry) return
    if (entry.dir) {
      if (state.folder.open.has(entry.path)) state.folder.open.delete(entry.path)
      else state.folder.open.add(entry.path)
      paintFolderTree()
    } else {
      openPath(entry.path)
    }
  })

  wireSidebar()
  wireAppMenu()
  wireWindowControls()
  wirePrefs()

  document.addEventListener('selectionchange', () => paintFormatState())

  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl) return
    if (e.key === 'Tab') { e.preventDefault(); stepTab(e.shiftKey ? -1 : 1) }
    else if (e.key === 'PageDown') { e.preventDefault(); stepTab(1) }
    else if (e.key === 'PageUp') { e.preventDefault(); stepTab(-1) }
  })
}

/* ------------------------------------------------------------------- boot */

const WELCOME = `# Forme

A markdown editor with four views. Switch between them from the toolbar, the
**View** menu, or with \`Ctrl+1\` – \`Ctrl+4\`.

| View | Shortcut | What it is |
| --- | --- | --- |
| Source | \`Ctrl+1\` | Raw markdown with syntax highlighting |
| Rich | \`Ctrl+2\` | WYSIWYG editing — the markdown is written for you |
| Split | \`Ctrl+4\` / \`Ctrl+H\` | Source on the left, live preview on the right |
| Read | \`Ctrl+3\` | Distraction-free rendered output |

## Getting started

- \`Ctrl+O\` opens a file, \`Ctrl+T\` opens a new tab
- **Open Folder…** in the File menu puts your notes in the sidebar
- \`Ctrl+Shift+D\` toggles dark and light
- \`Alt+Z\` toggles word wrap — long lines in code blocks wrap by default

\`\`\`js
// Fenced code is highlighted, and wraps instead of running off the edge.
const views = { source: true, rich: true, split: true, reading: true }
\`\`\`

- [x] Task lists survive the round trip between views
- [ ] Try editing this line in Rich mode, then switch back to Source

> Everything is markdown underneath. Switching views never rewrites your file
> unless you actually edit it.
`

async function boot () {
  state.settings = await api.settings.get()
  document.body.dataset.platform = api.platform

  // wireDom first: applyBodySettings writes --sidebar-width onto #body.
  wireDom()
  await loadThemeList()
  await applyTheme()
  applyBodySettings()

  api.menu.onCommand((command, payload) => {
    const fn = commands[command]
    if (fn) fn(payload)
  })

  api.onOpenExternalFile((res) => {
    if (!res) return
    const existing = focusExisting(res.path)
    if (existing) setActive(existing.id)
    else adoptOpened(res)
  })

  api.folder?.onChanged?.(() => refreshFolder())

  // Editing a theme JSON on disk re-applies it without a restart.
  api.theme?.onChanged?.(async () => {
    await loadThemeList()
    await applyTheme()
  })

  // Restore the last session's tabs, skipping anything that has gone away.
  // A draft beats the file on disk: it holds edits that were never saved.
  const restoring = state.settings.restoreSession !== false
  const session = restoring ? (state.settings.session || {}) : {}

  const drafts = new Map()
  if (restoring && state.settings.keepDrafts !== false) {
    try {
      for (const d of (await api.draft?.list?.()) || []) drafts.set(d.draftId, d)
    } catch (err) {
      console.warn('could not read drafts', err)
    }
  }

  const restored = []
  const usedDrafts = new Set()

  const fromDraft = (d, mode) => makeDoc({
    draftId: d.draftId,
    path: d.path,
    title: d.title,
    markdown: d.markdown,
    savedMarkdown: d.savedMarkdown,
    mode: d.mode || mode
  })

  for (const t of session.tabs || []) {
    const draft = t.draftId ? drafts.get(t.draftId) : null
    if (draft) {
      usedDrafts.add(draft.draftId)
      restored.push(fromDraft(draft, t.mode))
      continue
    }
    if (!t.path) continue
    const res = await api.file.openPath(t.path)
    if (res.error) continue
    restored.push(makeDoc({ path: res.path, markdown: res.content, mode: t.mode, draftId: t.draftId }))
  }

  // A draft the session never mentioned is still unsaved work — recover it
  // rather than letting the prune below delete it.
  for (const d of drafts.values()) {
    if (usedDrafts.has(d.draftId)) continue
    restored.push(fromDraft(d, state.settings.mode))
  }

  if (restored.length) {
    state.docs = restored
    state.activeId = (restored[session.activeIndex] || restored[0]).id
  } else {
    const fresh = makeDoc({ markdown: WELCOME, mode: state.settings.mode, ephemeral: true })
    state.docs = [fresh]
    state.activeId = fresh.id
  }

  // Only reap drafts when we actually restored; with session restore off the
  // tabs are not rebuilt, and deleting their drafts would destroy the work.
  if (restoring) api.draft?.prune?.(state.docs.map((d) => d.draftId))

  if (state.settings.folder) {
    const res = await api.folder.list(state.settings.folder)
    if (res && !res.error) adoptFolder({ path: state.settings.folder, ...res })
  }

  mountLayout()
  repaintAll()
  // Record the restored set straight away, including any recovered drafts.
  persistSession()
}

boot().catch((err) => {
  console.error('Forme failed to start', err)
  document.body.innerHTML =
    `<pre style="padding:2rem;font:13px ui-monospace,monospace;white-space:pre-wrap">Forme failed to start\n\n${escapeHtml(err?.stack || String(err))}</pre>`
})
