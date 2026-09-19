import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MAX_RECENT = 12
const MODES = ['source', 'rich', 'split', 'reading']
/**
 * Draft ids become filenames in <userData>/drafts (Addendum E), so the same strict
 * allowlist main validates against applies here — a session entry must never smuggle
 * a path through. Anything else becomes null rather than dropping the tab.
 */
const DRAFT_ID_RE = /^[a-f0-9-]{8,64}$/

/** Default settings — must match the Settings shape in CONTRACT.md + Addendum A. */
function defaults() {
  return {
    theme: 'system',
    themeDark: 'dark',
    themeLight: 'light',
    mode: 'source',
    fontSize: 15,
    fontFamily: 'sans',
    lineWidth: 'normal',
    showLineNumbers: true,
    spellcheck: true,
    sidebarVisible: true,
    sidebarView: 'files',
    sidebarWidth: 260,
    recentFiles: [],
    window: { width: 1100, height: 780, x: undefined, y: undefined, maximized: false },
    wrap: true,
    splitRatio: 0.5,
    folder: null,
    restoreSession: true,
    keepDrafts: true,
    session: { tabs: [], activeIndex: 0 }
  }
}

let cache = null

function settingsPath() {
  return join(app.getPath('userData'), 'settings.json')
}

/** Coerce anything read off disk into a sane, fully-populated settings object. */
function normalize(raw) {
  const base = defaults()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base

  const out = { ...base, ...raw }

  // Addendum C: `theme` is 'system' or any theme id, so it can only be validated
  // as "a non-empty string" — main is the one that knows which ids exist, and an
  // id whose file has been deleted must still round-trip rather than be reset here.
  out.theme = themeIdOr(out.theme, base.theme)
  out.themeDark = themeIdOr(out.themeDark, base.themeDark)
  out.themeLight = themeIdOr(out.themeLight, base.themeLight)

  if (!MODES.includes(out.mode)) out.mode = base.mode
  if (!['sans', 'serif', 'mono'].includes(out.fontFamily)) out.fontFamily = base.fontFamily
  if (!['narrow', 'normal', 'wide'].includes(out.lineWidth)) out.lineWidth = base.lineWidth

  const size = Number(out.fontSize)
  out.fontSize = Number.isFinite(size) ? Math.min(40, Math.max(9, Math.round(size))) : base.fontSize

  out.showLineNumbers = !!out.showLineNumbers
  out.spellcheck = !!out.spellcheck
  out.sidebarVisible = !!out.sidebarVisible
  if (!['files', 'outline', 'recent'].includes(out.sidebarView)) out.sidebarView = base.sidebarView
  const sw = Number(out.sidebarWidth)
  out.sidebarWidth = Number.isFinite(sw) ? Math.min(480, Math.max(160, Math.round(sw))) : base.sidebarWidth
  out.wrap = out.wrap === undefined ? base.wrap : !!out.wrap
  out.restoreSession = out.restoreSession === undefined ? base.restoreSession : !!out.restoreSession
  out.keepDrafts = out.keepDrafts === undefined ? base.keepDrafts : !!out.keepDrafts

  const ratio = Number(out.splitRatio)
  out.splitRatio = Number.isFinite(ratio)
    ? Math.min(0.85, Math.max(0.15, ratio))
    : base.splitRatio

  out.folder = typeof out.folder === 'string' && out.folder ? out.folder : null
  out.session = normalizeSession(out.session, base.session)

  out.recentFiles = Array.isArray(out.recentFiles)
    ? out.recentFiles.filter((p) => typeof p === 'string' && p.length > 0).slice(0, MAX_RECENT)
    : []

  const win = out.window && typeof out.window === 'object' ? out.window : {}
  out.window = {
    width: numOr(win.width, base.window.width),
    height: numOr(win.height, base.window.height),
    x: Number.isFinite(win.x) ? Math.round(win.x) : undefined,
    y: Number.isFinite(win.y) ? Math.round(win.y) : undefined,
    maximized: !!win.maximized
  }

  return out
}

/** The renderer owns the session block; we only guarantee it comes back well-formed. */
function normalizeSession(raw, base) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tabs: [], activeIndex: 0 }

  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs
        .filter((t) => t && typeof t === 'object' && !Array.isArray(t))
        .map((t) => ({
          path: typeof t.path === 'string' && t.path ? t.path : null,
          mode: MODES.includes(t.mode) ? t.mode : 'source',
          draftId: typeof t.draftId === 'string' && DRAFT_ID_RE.test(t.draftId) ? t.draftId : null
        }))
    : base.tabs.slice()

  let activeIndex = Number(raw.activeIndex)
  if (!Number.isInteger(activeIndex) || activeIndex < 0) activeIndex = 0
  if (tabs.length && activeIndex >= tabs.length) activeIndex = tabs.length - 1
  if (!tabs.length) activeIndex = 0

  return { tabs, activeIndex }
}

function themeIdOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 64) : fallback
}

function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

/** Read settings from disk. Any failure (missing file, corrupt JSON) falls back to defaults. */
export function loadSettings() {
  try {
    const file = settingsPath()
    if (existsSync(file)) {
      cache = normalize(JSON.parse(readFileSync(file, 'utf8')))
    } else {
      cache = defaults()
    }
  } catch {
    cache = defaults()
  }
  return cache
}

export function getSettings() {
  if (!cache) loadSettings()
  return cache
}

function persist() {
  try {
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true })
    // Write to a temp file first so a crash mid-write can't leave a truncated settings.json.
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Persistence is best-effort; never let it take the app down.
  }
}

/** Shallow-merge a patch into the current settings and write them out. */
export function saveSettings(patch) {
  const current = getSettings()
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    cache = normalize({ ...current, ...patch })
  }
  persist()
  return cache
}

function sameFile(a, b) {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/** Newest-first, deduped, max 12, pruned of files that no longer exist. */
export function addRecentFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return getSettings().recentFiles
  const abs = resolve(filePath)
  const settings = getSettings()
  const next = [abs, ...settings.recentFiles.filter((p) => !sameFile(resolve(p), abs))]
    .filter((p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    })
    .slice(0, MAX_RECENT)
  cache = { ...settings, recentFiles: next }
  persist()
  return next
}

export function removeRecentFile(filePath) {
  const settings = getSettings()
  if (typeof filePath !== 'string' || !filePath) return settings.recentFiles
  const abs = resolve(filePath)
  const next = settings.recentFiles.filter((p) => !sameFile(resolve(p), abs))
  cache = { ...settings, recentFiles: next }
  persist()
  return next
}

/** Drop any recent entries whose file has since been deleted or moved. */
export function pruneRecentFiles() {
  const settings = getSettings()
  const next = settings.recentFiles.filter((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
  if (next.length !== settings.recentFiles.length) {
    cache = { ...settings, recentFiles: next }
    persist()
  }
  return next
}

export function clearRecentFiles() {
  cache = { ...getSettings(), recentFiles: [] }
  persist()
  return cache.recentFiles
}
