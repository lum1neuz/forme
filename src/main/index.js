import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync
} from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
// Bundled themes are inlined into the bundle by rollup at build time — never read
// from disk, so they need no packaging step and cannot go missing at runtime.
// dark/light are generated from theme.css by `npm run themes:sync` (never hand-edit);
// the rest are hand-authored. Adding one here is a code change; users drop their own
// into <userData>/themes instead (Addendum D).
import builtinDark from '../../resources/themes/dark.json'
import builtinLight from '../../resources/themes/light.json'
import builtinEmber from '../../resources/themes/ember.json'
import builtinForest from '../../resources/themes/forest.json'
import builtinObsidian from '../../resources/themes/obsidian.json'
import builtinParchment from '../../resources/themes/parchment.json'
import { applyMenuState, buildMenu } from './menu.js'
import {
  addRecentFile,
  clearRecentFiles,
  getSettings,
  loadSettings,
  pruneRecentFiles,
  saveSettings
} from './settings.js'
import { MIN_HEIGHT, MIN_WIDTH, restoreWindowState, trackWindowState } from './window-state.js'

/** Single channel for every main -> renderer menu command. */
/** Dev-only window icon; absent from a packaged build, where the exe supplies it. */
const devIconPath = (() => {
  try {
    const p = join(__dirname, '../../build/icon.png')
    return existsSync(p) ? p : null
  } catch {
    return null
  }
})()

const MENU_CHANNEL = 'forme:menu-command'
/** Channel for files opened via OS association / CLI / second instance. */
const OPEN_FILE_CHANNEL = 'forme:open-external-file'
/** Channel for debounced folder-watch notifications. */
const FOLDER_CHANGED_CHANNEL = 'forme:folder-changed'
/** Channel telling the renderer's custom title bar to swap maximize/restore. */
const MAXIMIZE_CHANNEL = 'forme:maximize-change'
/** Channel for debounced user-theme-folder notifications (Addendum C). */
const THEME_CHANGED_CHANNEL = 'forme:theme-changed'

const isDev = !!process.env.ELECTRON_RENDERER_URL
const isMac = process.platform === 'darwin'

/** How long the hidden print window gets to load the export HTML. */
const PDF_RENDER_TIMEOUT = 20000

const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'txt']
const OPENABLE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.mdwn',
  '.mdtext',
  '.mdtxt',
  '.text',
  '.txt'
])

/** Folder-browser scan limits (Addendum A). */
const FOLDER_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])
const FOLDER_MAX_DEPTH = 8
const FOLDER_MAX_ENTRIES = 5000
const FOLDER_WATCH_DEBOUNCE = 300

/** How long main waits for the renderer to answer `app:before-quit`. */
const QUIT_ACK_TIMEOUT = 4000

/** User-theme limits (Addendum C). Hand-edited files are treated as hostile input. */
const THEME_DIR_NAME = 'themes'
const THEME_MAX_FILES = 200
const THEME_MAX_KEYS = 300
const THEME_MAX_BYTES = 256 * 1024
const THEME_WATCH_DEBOUNCE = 300

/**
 * Draft limits (Addendum E). This is the one store whose failure loses the user's
 * unsaved work, so each value here is a guard rather than a preference.
 */
const DRAFT_DIR_NAME = 'drafts'
const DRAFT_MAX_FILES = 200
const DRAFT_MAX_BYTES = 8 * 1024 * 1024
/** A draft written this recently is spared by prune, even if nothing references it. */
const DRAFT_PRUNE_GRACE = 60 * 1000
/** Startup sweep: unreferenced drafts older than this are dropped. */
const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000
/** A draft id becomes a filename, so its shape is an allowlist, never a filter. */
const DRAFT_ID_RE = /^[a-f0-9-]{8,64}$/
const DRAFT_MODES = ['source', 'rich', 'split', 'reading']
const DRAFT_TITLE_MAX = 200
/** Per-call cap on per-file warnings; anything beyond becomes one tail line. */
const DRAFT_MAX_WARNINGS = 20

let mainWindow = null
let rendererReady = false
/** File waiting to be handed to the renderer once it has finished loading. */
let pendingExternalFile = null

let folderWatcher = null
let folderWatchPath = null
let folderWatchTimer = null

let themeWatcher = null
let themeWatchPath = null
let themeWatchTimer = null

/**
 * draftId -> best known updatedAt for every draft currently on disk. Kept warm so
 * that `draft:save` — which the renderer debounces to roughly 1 Hz while the user
 * types — never re-reads the directory. Null means cold; it is rebuilt on first use.
 */
let draftIndex = null

let quitApproved = false
let quitAckTimer = null

/* ------------------------------------------------------------------ helpers */

function windowOf(event) {
  const win = event ? BrowserWindow.fromWebContents(event.sender) : null
  return win && !win.isDestroyed() ? win : targetWindow()
}

function targetWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const all = BrowserWindow.getAllWindows()
  return all.length ? all[0] : null
}

function errorMessage(err) {
  if (!err) return 'Unknown error'
  return typeof err === 'string' ? err : err.message || String(err)
}

function isWebUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function readTextFile(filePath) {
  try {
    const abs = resolve(filePath)
    let content = await readFile(abs, 'utf8')
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1) // strip UTF-8 BOM
    return { path: abs, content }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

async function writeTextFile(filePath, content) {
  try {
    const abs = resolve(filePath)
    await writeFile(abs, typeof content === 'string' ? content : String(content ?? ''), 'utf8')
    return { ok: true, path: abs }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

/** Rebuild the recent-files submenu and push the new settings to the renderer. */
function refreshRecent() {
  applyMenuState()
  const win = targetWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(MENU_CHANNEL, 'settings:changed', getSettings())
  }
}

function resolveTheme(theme) {
  if (theme === 'dark' || theme === 'light') return theme
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/* --------------------------------------------------------------- navigation */

function guardWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    // The app is a single document; nothing should ever navigate the shell away.
    if (url === contents.getURL()) return
    event.preventDefault()
    if (isWebUrl(url)) shell.openExternal(url)
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/* ------------------------------------------------------- external file open */

function markdownFileFromArgv(argv) {
  if (!Array.isArray(argv)) return null
  for (const raw of argv.slice(1)) {
    if (typeof raw !== 'string' || !raw || raw.startsWith('-')) continue
    let candidate
    try {
      candidate = resolve(raw)
    } catch {
      continue
    }
    if (!OPENABLE_EXTENSIONS.has(extname(candidate).toLowerCase())) continue
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function openExternalFile(filePath) {
  if (!filePath) return
  const result = await readTextFile(filePath)
  if (result.error) {
    dialog.showErrorBox('Could not open file', `${filePath}\n\n${result.error}`)
    return
  }

  addRecentFile(result.path)
  refreshRecent()

  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send(OPEN_FILE_CHANNEL, result)
  } else {
    pendingExternalFile = result
  }
}

function flushPendingExternalFile() {
  if (!pendingExternalFile) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const payload = pendingExternalFile
  pendingExternalFile = null
  mainWindow.webContents.send(OPEN_FILE_CHANNEL, payload)
}

/* ---------------------------------------------------------- folder browser */

function compareNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Depth-first scan producing the flat, pre-sorted entry list the renderer turns
 * back into a tree. A directory is only emitted if a markdown file lives somewhere
 * beneath it, so empty branches never show up.
 */
function scanDirectory(dir, depth, state) {
  if (state.truncated || depth >= FOLDER_MAX_DEPTH) return []

  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    // EACCES / EPERM / ENOENT / ELOOP — skip this subtree, never fail the whole scan.
    return []
  }

  const dirNames = []
  const fileNames = []
  for (const item of items) {
    const name = item.name
    // Symlinks are skipped outright: following them invites directory cycles.
    if (item.isSymbolicLink()) continue
    if (item.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      dirNames.push(name)
    } else if (item.isFile()) {
      if (FOLDER_MARKDOWN_EXTENSIONS.has(extname(name).toLowerCase())) fileNames.push(name)
    }
  }

  dirNames.sort(compareNames)
  fileNames.sort(compareNames)

  const out = []

  // Once the cap trips we stop descending, but everything already collected is
  // kept and handed back — a truncated tree must still show its first N entries.
  for (const name of dirNames) {
    if (state.truncated) break
    const full = join(dir, name)
    const children = scanDirectory(full, depth + 1, state)
    if (!children.length) continue // no markdown underneath — omit the branch
    out.push({ name, path: full, dir: true, depth })
    if (++state.count >= FOLDER_MAX_ENTRIES) state.truncated = true
    out.push(...children)
  }

  for (const name of fileNames) {
    if (state.truncated) break
    out.push({ name, path: join(dir, name), dir: false, depth })
    if (++state.count >= FOLDER_MAX_ENTRIES) state.truncated = true
  }

  return out
}

function scanFolder(folderPath) {
  let root
  try {
    root = resolve(folderPath)
    if (!statSync(root).isDirectory()) return { error: 'Not a directory' }
  } catch (err) {
    return { error: errorMessage(err) }
  }

  const state = { count: 0, truncated: false }
  const entries = scanDirectory(root, 0, state)
  return state.truncated ? { path: root, entries, truncated: true } : { path: root, entries }
}

function stopFolderWatch() {
  if (folderWatchTimer) {
    clearTimeout(folderWatchTimer)
    folderWatchTimer = null
  }
  if (folderWatcher) {
    try {
      folderWatcher.close()
    } catch {
      // Already closed / never fully opened.
    }
    folderWatcher = null
  }
  folderWatchPath = null
}

/**
 * Watch one folder at a time. Recursive watching is unsupported on some platforms
 * and fails outright on many network drives — that must degrade to "no live
 * updates", never to a broken folder browser.
 */
function startFolderWatch(folderPath) {
  const abs = resolve(folderPath)
  if (folderWatcher && folderWatchPath === abs) return true

  stopFolderWatch()

  try {
    const watcher = watch(abs, { recursive: true }, () => {
      if (folderWatchTimer) clearTimeout(folderWatchTimer)
      folderWatchTimer = setTimeout(() => {
        folderWatchTimer = null
        const win = targetWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(FOLDER_CHANGED_CHANNEL, { path: abs })
        }
      }, FOLDER_WATCH_DEBOUNCE)
    })
    watcher.on('error', () => stopFolderWatch())
    folderWatcher = watcher
    folderWatchPath = abs
    return true
  } catch {
    folderWatcher = null
    folderWatchPath = null
    return false
  }
}

/* ------------------------------------------------------------------- themes */

/**
 * Every CSS named colour, plus the two keywords. Values are written into inline
 * custom properties on `<html>`, so the accepted grammar is an allowlist: a value
 * is either one of these names or matches one of the anchored regexes below.
 */
// prettier-ignore
const CSS_NAMED_COLORS = new Set([
  'transparent', 'currentcolor',
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
  'whitesmoke', 'yellow', 'yellowgreen'
])

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const CSS_NUMBER = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)'
const CSS_NUM_OR_PCT = `(?:${CSS_NUMBER}%?)`
const CSS_ANGLE = `(?:${CSS_NUMBER}(?:deg|grad|rad|turn)?)`
const CSS_SEP = '(?:\\s*,\\s*|\\s+)'
const CSS_ALPHA_SEP = '(?:\\s*[,/]\\s*)'

/** `rgb(1,2,3)`, `rgba(1 2 3 / 50%)` — legacy and modern separator syntax. */
const RGB_COLOR_RE = new RegExp(
  `^rgba?\\(\\s*${CSS_NUM_OR_PCT}${CSS_SEP}${CSS_NUM_OR_PCT}${CSS_SEP}${CSS_NUM_OR_PCT}` +
    `(?:${CSS_ALPHA_SEP}${CSS_NUM_OR_PCT})?\\s*\\)$`,
  'i'
)

/** `hsl(210, 20%, 30%)`, `hsla(210deg 20% 30% / .5)`. */
const HSL_COLOR_RE = new RegExp(
  `^hsla?\\(\\s*${CSS_ANGLE}${CSS_SEP}${CSS_NUMBER}%${CSS_SEP}${CSS_NUMBER}%` +
    `(?:${CSS_ALPHA_SEP}${CSS_NUM_OR_PCT})?\\s*\\)$`,
  'i'
)

/** Token keys become `--<key>` / `--hl-<key>`, so they get the same treatment. */
// Underscore is allowed because highlight.js class names use it (--hl-built_in).
// It is a valid CSS ident character and carries no injection surface.
const THEME_KEY_RE = /^[a-z][a-z0-9_-]*$/

/**
 * Belt-and-braces: the regexes above are anchored and could never match any of
 * this, but a CSS-injection attempt should be rejected on its own merits (and
 * show up in the log as such) rather than by accident.
 */
const CSS_INJECTION_RE = /[;{}\\]|\/\*|\*\/|url\s*\(|expression\s*\(|[ -]/i

function isCssColor(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v || v.length > 64) return false
  if (CSS_INJECTION_RE.test(v)) return false
  if (HEX_COLOR_RE.test(v)) return true
  if (RGB_COLOR_RE.test(v)) return true
  if (HSL_COLOR_RE.test(v)) return true
  return CSS_NAMED_COLORS.has(v.toLowerCase())
}

function slugifyThemeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Keep every key that is a safe identifier mapped to a safe colour; drop the rest
 * with one aggregated warning per section, so a file full of junk can't flood the
 * console but a single typo is still reported by name.
 */
function sanitizeTokens(raw, section, label) {
  const out = {}
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[themes] ${label}: "${section}" is not an object — ignored`)
    return out
  }

  const dropped = []
  let kept = 0
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= THEME_MAX_KEYS) {
      console.warn(`[themes] ${label}: more than ${THEME_MAX_KEYS} "${section}" keys — rest dropped`)
      break
    }
    if (!THEME_KEY_RE.test(key) || !isCssColor(value)) {
      if (dropped.length < 20) dropped.push(key)
      continue
    }
    out[key] = value.trim()
    kept++
  }

  if (dropped.length) {
    console.warn(`[themes] ${label}: dropped invalid "${section}" entries: ${dropped.join(', ')}`)
  }
  return out
}

/**
 * Turn anything parsed off disk into a well-formed theme, or null if it is too
 * broken to use. Never throws: one bad theme must not break the list.
 */
function sanitizeTheme(raw, fallbackId, fallbackType, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[themes] ${label}: top level is not a JSON object — skipped`)
    return null
  }

  const id = slugifyThemeId(raw.id) || slugifyThemeId(fallbackId)
  if (!id) {
    console.warn(`[themes] ${label}: no usable id — skipped`)
    return null
  }

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : id

  let type = fallbackType === 'light' ? 'light' : 'dark'
  if (raw.type === 'dark' || raw.type === 'light') {
    type = raw.type
  } else if (raw.type !== undefined) {
    console.warn(`[themes] ${label}: unknown type ${JSON.stringify(raw.type)} — using "${type}"`)
  }

  return {
    id,
    name,
    type,
    colors: sanitizeTokens(raw.colors, 'colors', label),
    syntax: sanitizeTokens(raw.syntax, 'syntax', label)
  }
}

function asBuiltin(raw, fallbackId, fallbackType) {
  const theme = sanitizeTheme(raw, fallbackId, fallbackType, `built-in ${fallbackId}`)
  return theme ? { ...theme, builtin: true } : null
}

/**
 * Bundled themes, validated exactly like a user's would be, and pre-ordered the way
 * `theme:list` reports them: the two generated ones first, then the hand-authored
 * ones alphabetically by name.
 */
const BUILTIN_THEMES = [
  asBuiltin(builtinDark, 'dark', 'dark'),
  asBuiltin(builtinLight, 'light', 'light'),
  ...[
    asBuiltin(builtinEmber, 'ember', 'dark'),
    asBuiltin(builtinForest, 'forest', 'dark'),
    asBuiltin(builtinObsidian, 'obsidian', 'dark'),
    asBuiltin(builtinParchment, 'parchment', 'light')
  ]
    .filter(Boolean)
    .sort((a, b) => compareNames(a.name, b.name))
].filter(Boolean)

function builtinOfType(type) {
  return (
    BUILTIN_THEMES.find((theme) => theme.type === type) ||
    BUILTIN_THEMES[0] || { id: type, name: type, type, colors: {}, syntax: {}, builtin: true }
  )
}

function userThemeDir() {
  return join(app.getPath('userData'), THEME_DIR_NAME)
}

/**
 * Read every `*.json` in the user theme folder. A missing folder, an unreadable
 * file, malformed JSON or a non-object root all skip that one file and keep going.
 */
function readUserThemes() {
  const dir = userThemeDir()
  let names
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
      .map((entry) => entry.name)
      .sort(compareNames)
  } catch {
    // No folder yet, or it is unreadable — there are simply no user themes.
    return []
  }

  if (names.length > THEME_MAX_FILES) {
    console.warn(`[themes] more than ${THEME_MAX_FILES} theme files — only the first are loaded`)
    names = names.slice(0, THEME_MAX_FILES)
  }

  const themes = []
  const seen = new Set()
  for (const name of names) {
    const full = join(dir, name)
    let theme = null
    try {
      const size = statSync(full).size
      if (size > THEME_MAX_BYTES) {
        console.warn(`[themes] ${name}: ${size} bytes is over the ${THEME_MAX_BYTES} byte cap`)
        continue
      }
      theme = sanitizeTheme(JSON.parse(readFileSync(full, 'utf8')), basename(name, '.json'), 'dark', name)
    } catch (err) {
      console.warn(`[themes] ${name}: ${errorMessage(err)} — skipped`)
      continue
    }
    if (!theme) continue
    if (seen.has(theme.id)) {
      console.warn(`[themes] ${name}: duplicate id "${theme.id}" — skipped`)
      continue
    }
    seen.add(theme.id)
    themes.push({ ...theme, builtin: false })
  }
  return themes
}

function byThemeName(a, b) {
  return compareNames(a.name, b.name)
}

/** The four chips on a preferences swatch, in the order the card paints them. */
const PREVIEW_TOKENS = ['bg', 'bg-elevated', 'accent', 'fg']

/**
 * Preview colours come off the *merged* theme, so a three-token user theme still
 * previews with its inherited values. A token that is missing even after the merge
 * is left out entirely rather than sent as undefined.
 */
function themeListEntry(theme) {
  const merged = mergeWithBuiltin(theme)
  const preview = {}
  for (const token of PREVIEW_TOKENS) {
    const value = merged.colors[token]
    if (typeof value === 'string' && value) preview[token] = value
  }
  return { id: theme.id, name: theme.name, type: theme.type, builtin: !!theme.builtin, preview }
}

/**
 * Built-ins first (in BUILTIN_THEMES order), then user themes alphabetically by
 * name. A user theme whose id collides with a built-in replaces it outright (and
 * stays `builtin:false`), so the id is never listed twice.
 */
function listThemes() {
  const user = readUserThemes()
  const overridden = new Set(user.map((theme) => theme.id))
  const builtins = BUILTIN_THEMES.filter((theme) => !overridden.has(theme.id))

  return [...builtins, ...user.sort(byThemeName)].map(themeListEntry)
}

/** Resolve an id, user themes winning over a built-in of the same id. */
function findTheme(id) {
  const wanted = slugifyThemeId(id)
  if (!wanted) return null
  return (
    readUserThemes().find((theme) => theme.id === wanted) ||
    BUILTIN_THEMES.find((theme) => theme.id === wanted) ||
    null
  )
}

/**
 * The renderer always gets a complete token set: the built-in of the theme's own
 * type supplies everything the theme itself does not define.
 */
function mergeWithBuiltin(theme) {
  const base = builtinOfType(theme.type)
  return {
    id: theme.id,
    name: theme.name,
    type: theme.type,
    builtin: !!theme.builtin,
    colors: { ...base.colors, ...theme.colors },
    syntax: { ...base.syntax, ...theme.syntax }
  }
}

/* --------------------------------------------------------- first-run seeding */

function seedReadme() {
  const base = builtinOfType('dark')
  const colorKeys = Object.keys(base.colors).sort(compareNames)
  const syntaxKeys = Object.keys(base.syntax).sort(compareNames)
  const list = (keys, prefix) =>
    keys.length ? keys.map((key) => `- \`${key}\` → \`--${prefix}${key}\``).join('\n') : '- (none)'

  return `# Forme themes

Drop a \`.json\` file in this folder and it shows up in the theme picker.
**Saving a file reloads it live — no restart.**

## Format

\`\`\`json
{
  "id": "midnight",
  "name": "Midnight",
  "type": "dark",
  "colors": { "bg": "#0b1020", "fg": "#d7dcf0", "accent": "#7aa2f7" },
  "syntax": { "keyword": "#bb9af7", "string": "#9ece6a" }
}
\`\`\`

- \`id\` — optional; the filename without \`.json\` is used when it is missing.
  Lower-cased and reduced to \`a-z 0-9 -\`. Reusing a built-in id replaces it.
- \`name\` — optional; defaults to the id. Shown in the picker.
- \`type\` — \`"dark"\` or \`"light"\` (anything else becomes \`"dark"\`). It decides
  which built-in fills in missing tokens and which \`data-theme\` the app uses.
- \`colors\` — optional. Key \`k\` sets the CSS custom property \`--k\`.
- \`syntax\` — optional. Key \`k\` sets \`--hl-k\`.

Every token is optional: **anything you leave out comes from the built-in theme of
the same \`type\`**, so a three-line theme is perfectly valid. See
\`example-midnight.json\` in this folder for a partial theme.

## Rules

- Keys must look like \`^[a-z][a-z0-9_-]*$\`; anything else is dropped.
- Values must be a CSS colour: \`#rgb\`, \`#rrggbb\`, \`#rrggbbaa\`, \`rgb()\`/\`rgba()\`,
  \`hsl()\`/\`hsla()\`, or a CSS colour name. Anything else (gradients, \`url(...)\`,
  \`var(...)\`, values with \`;\`) is dropped with a warning — these values go
  straight into inline CSS.
- A file with broken JSON is skipped; the other themes still load.
- Limits: ${THEME_MAX_FILES} files, ${THEME_MAX_KEYS} keys per section, ${Math.round(THEME_MAX_BYTES / 1024)} KB per file.

## Available \`colors\` tokens

${list(colorKeys, '')}

## Available \`syntax\` tokens

${list(syntaxKeys, 'hl-')}
`
}

/** A deliberately partial theme, so the built-in fallback is obvious on sight. */
const SEED_EXAMPLE_THEME = {
  id: 'example-midnight',
  name: 'Example Midnight',
  type: 'dark',
  colors: {
    bg: '#0b1020',
    'bg-elevated': '#131a33',
    'bg-inset': '#080c1a',
    fg: '#d7dcf0',
    accent: '#7aa2f7',
    'accent-fg': '#0b1020',
    border: '#243056'
  },
  syntax: {
    keyword: '#bb9af7',
    string: '#9ece6a',
    comment: '#5a6488'
  }
}

/**
 * First run only: make the folder discoverable rather than empty. If it already
 * exists we touch nothing — the user may have deleted the README on purpose.
 */
function seedUserThemes() {
  const dir = userThemeDir()
  try {
    if (existsSync(dir)) return false
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), seedReadme(), 'utf8')
    writeFileSync(
      join(dir, 'example-midnight.json'),
      JSON.stringify(SEED_EXAMPLE_THEME, null, 2) + '\n',
      'utf8'
    )
    return true
  } catch (err) {
    console.warn(`[themes] could not seed ${dir}: ${errorMessage(err)}`)
    return false
  }
}

/* -------------------------------------------------------------- theme watch */

function stopThemeWatch() {
  if (themeWatchTimer) {
    clearTimeout(themeWatchTimer)
    themeWatchTimer = null
  }
  if (themeWatcher) {
    try {
      themeWatcher.close()
    } catch {
      // Already closed / never fully opened.
    }
    themeWatcher = null
  }
  themeWatchPath = null
}

/**
 * Watch the user theme folder so editing a JSON file re-themes the app live.
 * Same shape as the folder watcher: one watcher at a time, debounced, and a watch
 * that cannot be established degrades to "no live updates", never to an error.
 */
function startThemeWatch() {
  const dir = userThemeDir()
  if (themeWatcher && themeWatchPath === dir) return true

  stopThemeWatch()
  if (!existsSync(dir)) return false

  try {
    const watcher = watch(dir, () => {
      if (themeWatchTimer) clearTimeout(themeWatchTimer)
      themeWatchTimer = setTimeout(() => {
        themeWatchTimer = null
        const win = targetWindow()
        if (win && !win.isDestroyed()) win.webContents.send(THEME_CHANGED_CHANNEL)
      }, THEME_WATCH_DEBOUNCE)
    })
    watcher.on('error', () => stopThemeWatch())
    themeWatcher = watcher
    themeWatchPath = dir
    return true
  } catch {
    themeWatcher = null
    themeWatchPath = null
    return false
  }
}

/* ------------------------------------------------------------------- drafts */

function draftsDir() {
  return join(app.getPath('userData'), DRAFT_DIR_NAME)
}

function isDraftId(value) {
  return typeof value === 'string' && DRAFT_ID_RE.test(value)
}

/** A short, quoted rendering of whatever the renderer sent, safe to put in an error. */
function draftIdLabel(value) {
  if (typeof value !== 'string') return value === null ? 'null' : typeof value
  return JSON.stringify(value.length > 32 ? value.slice(0, 32) + '...' : value)
}

/**
 * The only place a draft id is ever turned into a path. The id is checked against the
 * allowlist *before* it reaches join(), and the resolved path is then verified to sit
 * inside the drafts folder — belt and braces, since the regex already forbids every
 * separator, dot segment and drive letter.
 */
function draftFile(draftId) {
  if (!isDraftId(draftId)) return null
  const dir = resolve(draftsDir())
  const file = resolve(join(dir, `${draftId}.json`))
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  if (!file.startsWith(prefix) || file.length === prefix.length) return null
  return file
}

/** One concise line per bad file, capped so a folder full of junk can't flood the log. */
function draftWarn(state, message) {
  if (state.warnings < DRAFT_MAX_WARNINGS) console.warn(`[drafts] ${message}`)
  state.warnings++
}

function flushDraftWarnings(state) {
  if (state.warnings > DRAFT_MAX_WARNINGS) {
    console.warn(`[drafts] ${state.warnings - DRAFT_MAX_WARNINGS} further problems suppressed`)
  }
}

/** Title as stored, else the file's basename, else the untitled placeholder. */
function draftTitle(raw, path) {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, DRAFT_TITLE_MAX)
  if (typeof path === 'string' && path) {
    const name = basename(path)
    if (name) return name.slice(0, DRAFT_TITLE_MAX)
  }
  return 'Untitled'
}

/**
 * Turn anything parsed off disk into a well-formed draft record, or null if it is too
 * broken to use. Never throws: one hostile file must not cost the user the others.
 */
function sanitizeDraft(raw, stem, fallbackUpdatedAt, state, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    draftWarn(state, `${label}: top level is not a JSON object — skipped`)
    return null
  }
  if (raw.draftId !== stem) {
    draftWarn(
      state,
      `${label}: draftId ${draftIdLabel(raw.draftId)} does not match the filename — skipped`
    )
    return null
  }
  if (typeof raw.markdown !== 'string' || typeof raw.savedMarkdown !== 'string') {
    draftWarn(state, `${label}: markdown/savedMarkdown are not both strings — skipped`)
    return null
  }

  const path = typeof raw.path === 'string' && raw.path ? raw.path : null

  return {
    draftId: stem,
    path,
    title: draftTitle(raw.title, path),
    mode: DRAFT_MODES.includes(raw.mode) ? raw.mode : 'source',
    markdown: raw.markdown,
    savedMarkdown: raw.savedMarkdown,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : fallbackUpdatedAt
  }
}

/**
 * Rebuild the warm index by stat-ing the folder. A file's mtime stands in for its
 * updatedAt — the two only disagree for a hand-edited file, and mtime is the better
 * answer to "when was this last written" anyway.
 */
function refreshDraftIndex() {
  const dir = draftsDir()
  const index = new Map()
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // No folder yet, or it is unreadable — there are simply no drafts.
    draftIndex = index
    return index
  }

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue
    const stem = basename(entry.name, '.json')
    if (!isDraftId(stem)) continue
    try {
      index.set(stem, statSync(join(dir, entry.name)).mtimeMs)
    } catch {
      // Vanished or unreadable between readdir and stat — simply not in the index.
    }
  }

  draftIndex = index
  return index
}

function knownDrafts() {
  return draftIndex || refreshDraftIndex()
}

/**
 * Delete exactly one draft file. Never recursive and always via draftFile(), so it can
 * only ever remove a <draftId>.json inside the drafts folder — never the folder itself,
 * and never anything outside it.
 */
function deleteDraftFile(draftId) {
  const file = draftFile(draftId)
  if (!file) return false
  try {
    rmSync(file, { force: true })
  } catch {
    // A directory wearing a draft's name, or a file held open by something else.
    return false
  }
  if (draftIndex) draftIndex.delete(draftId)
  return true
}

/**
 * Keep the folder under the cap by dropping the oldest drafts rather than refusing the
 * write — the draft being saved is the one the user is typing into right now.
 */
function evictOldestDrafts(keepId) {
  const index = knownDrafts()
  const others = [...index.entries()].filter(([id]) => id !== keepId)
  const excess = others.length - DRAFT_MAX_FILES + 1
  if (excess <= 0) return 0

  others.sort((a, b) => a[1] - b[1])
  let removed = 0
  for (let i = 0; i < excess; i++) {
    if (deleteDraftFile(others[i][0])) removed++
  }
  if (removed) {
    console.warn(
      `[drafts] evicted ${removed} oldest draft(s) to stay under the ${DRAFT_MAX_FILES} draft cap`
    )
  }
  return removed
}

/**
 * Every readable draft, newest first. A corrupt, truncated, oversized or mislabelled
 * file is skipped with one warning while every other draft still loads.
 */
function listDrafts() {
  const dir = draftsDir()
  const state = { warnings: 0 }
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // No folder yet — no drafts, not an error.
    draftIndex = new Map()
    return []
  }

  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue
    const stem = basename(entry.name, '.json')
    if (!isDraftId(stem)) {
      draftWarn(state, `${entry.name}: not a draft filename — ignored`)
      continue
    }
    try {
      const stat = statSync(join(dir, entry.name))
      files.push({ name: entry.name, stem, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch (err) {
      draftWarn(state, `${entry.name}: ${errorMessage(err)} — skipped`)
    }
  }

  // Newest first before the cap bites, so an over-full folder keeps what matters.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // The index tracks every draft on disk, including the ones past the read cap, so
  // prune and eviction still know about them.
  const index = new Map(files.map((file) => [file.stem, file.mtimeMs]))

  let readable = files
  if (readable.length > DRAFT_MAX_FILES) {
    console.warn(`[drafts] more than ${DRAFT_MAX_FILES} drafts — only the newest are loaded`)
    readable = readable.slice(0, DRAFT_MAX_FILES)
  }

  const records = []
  for (const file of readable) {
    if (file.size > DRAFT_MAX_BYTES) {
      draftWarn(
        state,
        `${file.name}: ${file.size} bytes is over the ${DRAFT_MAX_BYTES} byte cap — skipped`
      )
      continue
    }
    let record = null
    try {
      const raw = JSON.parse(readFileSync(join(dir, file.name), 'utf8'))
      record = sanitizeDraft(raw, file.stem, file.mtimeMs, state, file.name)
    } catch (err) {
      draftWarn(state, `${file.name}: ${errorMessage(err)} — skipped`)
      continue
    }
    if (!record) continue
    index.set(file.stem, record.updatedAt)
    records.push(record)
  }

  flushDraftWarnings(state)
  draftIndex = index
  records.sort((a, b) => b.updatedAt - a.updatedAt)
  return records
}

/**
 * Write one draft atomically. Cheap enough for the renderer's ~1 Hz typing debounce:
 * one stringify, one write and one rename, with no directory scan unless the cap is
 * actually in play.
 */
function saveDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Draft record must be an object' }
  }

  // Validated before anything touches the filesystem.
  const draftId = raw.draftId
  const file = draftFile(draftId)
  if (!file) return { error: `Invalid draftId: ${draftIdLabel(draftId)}` }

  if (typeof raw.markdown !== 'string' || typeof raw.savedMarkdown !== 'string') {
    return { error: 'Draft markdown and savedMarkdown must be strings' }
  }

  const path = typeof raw.path === 'string' && raw.path ? raw.path : null
  const record = {
    draftId,
    path,
    title: draftTitle(raw.title, path),
    mode: DRAFT_MODES.includes(raw.mode) ? raw.mode : 'source',
    markdown: raw.markdown,
    savedMarkdown: raw.savedMarkdown,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now()
  }

  let json
  try {
    json = JSON.stringify(record)
  } catch (err) {
    return { error: errorMessage(err) }
  }

  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > DRAFT_MAX_BYTES) {
    // Refused rather than written and skipped on the next read: the renderer can warn
    // that this document is too big to keep safe instead of losing it silently.
    return { error: `Draft is ${bytes} bytes, over the ${DRAFT_MAX_BYTES} byte cap` }
  }

  const tmp = `${file}.tmp`
  try {
    mkdirSync(draftsDir(), { recursive: true })
    evictOldestDrafts(draftId)
    // Write beside the draft and rename over it: a crash mid-write leaves either the
    // previous draft or the new one, never a truncated file.
    writeFileSync(tmp, json, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Nothing more to do — the real draft was never opened for writing.
    }
    return { error: errorMessage(err) }
  }

  knownDrafts().set(draftId, record.updatedAt)
  return { ok: true, draftId }
}

/** Drop one draft — its document was saved, or closed and discarded. */
function removeDraft(draftId) {
  const file = draftFile(draftId)
  if (!file) return { error: `Invalid draftId: ${draftIdLabel(draftId)}` }
  try {
    rmSync(file, { force: true })
  } catch (err) {
    return { error: errorMessage(err) }
  }
  if (draftIndex) draftIndex.delete(draftId)
  return { ok: true }
}

/**
 * Delete every draft the caller did not list. `minAge` is the guard: a draft written
 * inside that window is always spared, so a renderer that prunes before it has saved a
 * brand-new document cannot delete it out from under itself.
 */
function pruneDrafts(keepIds, minAge) {
  if (!Array.isArray(keepIds)) return { error: 'keepIds must be an array' }

  const keep = new Set()
  for (const id of keepIds) if (isDraftId(id)) keep.add(id)

  // Prune is rare (tab close, startup), so it works from a fresh view of the folder.
  const index = refreshDraftIndex()
  const cutoff = Date.now() - minAge
  let removed = 0

  for (const draftId of [...index.keys()]) {
    if (keep.has(draftId)) continue
    const file = draftFile(draftId)
    if (!file) {
      index.delete(draftId)
      continue
    }
    let mtimeMs
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      index.delete(draftId) // already gone
      continue
    }
    if (mtimeMs > cutoff) continue // written too recently to count as stale
    if (deleteDraftFile(draftId)) removed++
  }

  return { ok: true, removed }
}

/**
 * Delete every draft, unconditionally. This is the one path that ignores the recency
 * guard: it backs an explicit, user-initiated "discard all drafts", so a file written a
 * second ago has to go too or the button looks broken. A file that will not unlink is
 * reported and skipped, and the folder itself always stays.
 */
function clearDrafts() {
  const index = refreshDraftIndex()
  const state = { warnings: 0 }
  let removed = 0

  for (const draftId of [...index.keys()]) {
    if (deleteDraftFile(draftId)) removed++
    else draftWarn(state, `${draftId}.json: could not be deleted — kept`)
  }

  flushDraftWarnings(state)
  return { ok: true, removed }
}

/**
 * Startup housekeeping: unreferenced drafts older than 30 days go. Anything the saved
 * session still points at is kept whatever its age, and `restoreSession: false` never
 * deletes a draft — turning the setting back on has to recover them.
 */
function sweepOldDrafts() {
  try {
    const session = getSettings().session
    const tabs = session && Array.isArray(session.tabs) ? session.tabs : []
    const keep = tabs.map((tab) => (tab ? tab.draftId : null)).filter(isDraftId)
    const result = pruneDrafts(keep, DRAFT_MAX_AGE)
    if (result.removed) {
      console.warn(`[drafts] removed ${result.removed} draft(s) unreferenced for over 30 days`)
    }
  } catch (err) {
    console.warn(`[drafts] startup sweep failed: ${errorMessage(err)}`)
  }
}

/* ------------------------------------------------------------------- window */

/**
 * "Maximized" from the custom title bar's point of view: full screen also shows a
 * restore glyph, and a frameless window that is full screen must not offer a
 * maximize action that does nothing.
 */
function isWindowMaximized(win) {
  if (!win || win.isDestroyed()) return false
  return win.isMaximized() || win.isFullScreen()
}

function pushMaximizeState(win) {
  const target = win && !win.isDestroyed() ? win : null
  if (!target) return
  const contents = target.webContents
  if (!contents || contents.isDestroyed()) return
  contents.send(MAXIMIZE_CHANNEL, isWindowMaximized(target))
}

function createWindow() {
  const state = restoreWindowState()
  const settings = getSettings()
  const dark = resolveTheme(settings.theme) === 'dark'

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // Custom in-app chrome. Electron keeps synthesising resize handles for a
    // frameless window (and min/max size still applies), but the title bar, the
    // menu bar and the window buttons are now the renderer's job.
    // macOS deliberately keeps its frame: `frame: false` would take the
    // traffic-light buttons with it, and `hiddenInset` gives the same flush look.
    resizable: true,
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    // Match the renderer's resolved theme so the pre-paint frame doesn't flash white.
    backgroundColor: dark ? '#16181d' : '#ffffff',
    title: 'Forme',
    // In a packaged build the exe already carries the icon; this is for dev,
    // where the window would otherwise show the default Electron logo.
    ...(devIconPath ? { icon: devIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs node builtins
      spellcheck: settings.spellcheck !== false
    }
  })

  // Captured so the listeners below always talk about *this* window, even if a
  // later createWindow() (macOS `activate`) reassigns mainWindow.
  const win = mainWindow

  if (state.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true
    flushPendingExternalFile()
    // The custom title bar has to start with the right maximize/restore icon,
    // including after a reload of an already-maximized window.
    pushMaximizeState(win)
  })

  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false
  })

  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(evt, () => pushMaximizeState(win))
  }

  installAccelerators(mainWindow.webContents)

  mainWindow.on('close', (event) => {
    if (!requestQuitApproval(mainWindow)) event.preventDefault()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
    stopFolderWatch()
    stopThemeWatch()
  })

  // Navigation guards are installed app-wide via the 'web-contents-created' hook,
  // so attaching them again here would double-fire shell.openExternal.
  trackWindowState(mainWindow)

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

/* --------------------------------------------------------------- pdf export */

/**
 * Print a standalone HTML document to a PDF buffer using a hidden window.
 *
 * The HTML goes through a temp file rather than a `data:` URL: an exported
 * document carries every stylesheet inline and routinely runs into the megabytes,
 * which a data URL handles badly (and percent-encoding it would double it again).
 * Scripting is disabled in the print window — the export is static HTML, and
 * nothing in it should ever be allowed to run.
 */
async function renderHtmlToPdf(html) {
  const source = typeof html === 'string' ? html : String(html ?? '')
  const tempFile = join(app.getPath('temp'), `forme-export-${randomUUID()}.html`)
  let pdfWindow = null

  try {
    await writeFile(tempFile, source, 'utf8')

    pdfWindow = new BrowserWindow({
      show: false,
      width: 1024,
      height: 1280,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
        spellcheck: false
      }
    })

    const contents = pdfWindow.webContents
    const loaded = new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) rejectPromise(err)
        else resolvePromise()
      }
      const timer = setTimeout(
        () => finish(new Error('Timed out while rendering the PDF')),
        PDF_RENDER_TIMEOUT
      )

      contents.once('did-finish-load', () => finish())
      contents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
        // Subresource failures (a missing image) must not abort the whole export.
        if (isMainFrame) {
          finish(new Error(errorDescription || `Could not load export content (${errorCode})`))
        }
      })
      contents.once('render-process-gone', () => finish(new Error('The PDF renderer crashed')))
      contents.once('destroyed', () => finish(new Error('The PDF renderer closed unexpectedly')))
    })

    // loadFile rejects on the same failures the listeners above report; swallow the
    // duplicate so it never surfaces as an unhandled rejection.
    pdfWindow.loadFile(tempFile).catch(() => {})
    await loaded

    return await contents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })
  } finally {
    if (pdfWindow && !pdfWindow.isDestroyed()) pdfWindow.destroy()
    try {
      await unlink(tempFile)
    } catch {
      // Never written, or already gone — nothing to clean up.
    }
  }
}

/* ---------------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('file:openDialog', async (event) => {
    try {
      const win = windowOf(event)
      const options = {
        title: 'Open Markdown File',
        properties: ['openFile'],
        filters: [
          { name: 'Markdown', extensions: MARKDOWN_EXTENSIONS },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { canceled: true }
      }
      const file = await readTextFile(result.filePaths[0])
      if (file.error) return file
      addRecentFile(file.path)
      refreshRecent()
      return file
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('file:openPath', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return { error: 'No file path given' }
    const file = await readTextFile(filePath)
    if (file.error) return file
    addRecentFile(file.path)
    refreshRecent()
    return file
  })

  ipcMain.handle('file:save', async (_event, filePath, content) => {
    if (typeof filePath !== 'string' || !filePath) return { error: 'No file path given' }
    const result = await writeTextFile(filePath, content)
    if (result.ok) {
      addRecentFile(result.path)
      refreshRecent()
    }
    return result
  })

  ipcMain.handle('file:saveDialog', async (event, content, suggestedName) => {
    try {
      const win = windowOf(event)
      const options = {
        title: 'Save Markdown File',
        defaultPath: withExtension(suggestedName || 'Untitled.md', '.md'),
        filters: [
          { name: 'Markdown', extensions: MARKDOWN_EXTENSIONS },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }

      const written = await writeTextFile(result.filePath, content)
      if (written.ok) {
        addRecentFile(written.path)
        refreshRecent()
      }
      return written
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('file:exportHtml', async (event, html, suggestedName) => {
    try {
      const win = windowOf(event)
      const options = {
        title: 'Export as HTML',
        defaultPath: withExtension(suggestedName || 'Untitled.html', '.html'),
        filters: [
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }
      return await writeTextFile(result.filePath, html)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('file:exportPdf', async (event, html, suggestedName) => {
    try {
      const win = windowOf(event)
      const options = {
        title: 'Export as PDF',
        defaultPath: withExtension(suggestedName || 'Untitled.pdf', '.pdf'),
        filters: [
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }

      const data = await renderHtmlToPdf(html)
      const target = resolve(result.filePath)
      await writeFile(target, data)
      return { ok: true, path: target }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('file:revealInFolder', async (_event, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return { error: 'No file path given' }
      shell.showItemInFolder(resolve(filePath))
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('folder:choose', async (event) => {
    try {
      const win = windowOf(event)
      const previous = getSettings().folder
      const options = {
        title: 'Open Folder',
        properties: ['openDirectory'],
        ...(previous && existsSync(previous) ? { defaultPath: previous } : {})
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { canceled: true }
      }

      const scan = scanFolder(result.filePaths[0])
      if (scan.error) return scan

      saveSettings({ folder: scan.path })
      startFolderWatch(scan.path)
      return scan
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('folder:list', async (_event, folderPath) => {
    if (typeof folderPath !== 'string' || !folderPath) return { error: 'No folder path given' }
    const scan = scanFolder(folderPath)
    if (scan.error) return scan
    startFolderWatch(scan.path)
    return scan
  })

  ipcMain.handle('folder:unwatch', async () => {
    stopFolderWatch()
    return { ok: true }
  })

  ipcMain.handle('theme:list', async () => {
    try {
      return listThemes()
    } catch (err) {
      // Should be unreachable — listThemes swallows per-file failures itself — but
      // the picker must never be handed a rejected promise.
      console.warn(`[themes] list failed: ${errorMessage(err)}`)
      return BUILTIN_THEMES.map(themeListEntry)
    }
  })

  ipcMain.handle('theme:get', async (_event, id) => {
    try {
      const theme = findTheme(id)
      if (!theme) return { error: `Unknown theme: ${String(id ?? '')}` }
      return mergeWithBuiltin(theme)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  // Not part of the renderer surface: the preload calls this when the first
  // `theme.onChanged` listener subscribes, so a watch that failed earlier (or was
  // torn down with the window) is re-armed.
  ipcMain.handle('theme:watch', async () => {
    try {
      return { ok: startThemeWatch() }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('theme:openFolder', async () => {
    try {
      const dir = userThemeDir()
      mkdirSync(dir, { recursive: true })
      // A freshly created folder has nothing watching it yet.
      startThemeWatch()
      const message = await shell.openPath(dir)
      return message ? { error: message } : { ok: true, path: dir }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  // Drafts (Addendum E). Every handler returns a result object — losing unsaved work
  // to a rejected promise is the one failure this store exists to prevent.
  ipcMain.handle('draft:list', async () => {
    try {
      return listDrafts()
    } catch (err) {
      // Unreachable — listDrafts swallows per-file failures itself — but restore must
      // never be handed a rejected promise.
      console.warn(`[drafts] list failed: ${errorMessage(err)}`)
      return []
    }
  })

  ipcMain.handle('draft:save', async (_event, record) => {
    try {
      return saveDraft(record)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('draft:remove', async (_event, draftId) => {
    try {
      return removeDraft(draftId)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('draft:prune', async (_event, keepIds) => {
    try {
      return pruneDrafts(keepIds, DRAFT_PRUNE_GRACE)
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('draft:clear', async () => {
    try {
      return clearDrafts()
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  // Renderer's answer to `app:before-quit`.
  //   'quit'   -> nothing dirty (or the user said go ahead), tear down now
  //   'cancel' -> user backed out
  //   'wait'   -> renderer is prompting; hold the timeout open
  ipcMain.handle('app:quitResponse', async (_event, decision) => {
    const answer = decision === true ? 'quit' : decision === false ? 'cancel' : decision
    clearQuitAckTimer()

    if (answer === 'quit') {
      quitApproved = true
      app.quit()
    } else if (answer === 'wait') {
      // Renderer took ownership; it must call back with 'quit' or 'cancel'.
    }
    return { ok: true }
  })

  ipcMain.handle('settings:get', async () => {
    try {
      return getSettings()
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('settings:set', async (_event, patch) => {
    try {
      const next = saveSettings(patch)
      // A recent-files change from the renderer has to reach the native menu too.
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'recentFiles')) applyMenuState()
      return next
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('win:setTitle', async (event, title) => {
    try {
      const win = windowOf(event)
      if (win) win.setTitle(typeof title === 'string' && title ? title : 'forme')
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('win:setDocumentEdited', async (event, edited) => {
    try {
      const win = windowOf(event)
      // setDocumentEdited is macOS-only; on Windows/Linux the title (set by the
      // renderer via win:setTitle) already carries the dirty marker.
      if (win && process.platform === 'darwin') win.setDocumentEdited(!!edited)
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('win:minimize', async (event) => {
    try {
      const win = windowOf(event)
      if (win) win.minimize()
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('win:maximizeToggle', async (event) => {
    try {
      const win = windowOf(event)
      if (!win) return { ok: true, maximized: false }
      // Leaving full screen first: while full screen, maximize/unmaximize is a no-op
      // and the title bar's restore glyph would do nothing.
      if (win.isFullScreen()) win.setFullScreen(false)
      else if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return { ok: true, maximized: isWindowMaximized(win) }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('win:close', async (event) => {
    try {
      const win = windowOf(event)
      // Deliberately close(), never destroy(): this runs the window's own `close`
      // handler, which asks the renderer for quit approval (`app:before-quit`) so
      // dirty-tab prompting still happens exactly as it does for the OS close button.
      if (win) win.close()
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  // Synchronous on purpose: the contract says `isMaximized() -> boolean`, and the
  // title bar reads it during its first paint. It stays awaitable either way.
  ipcMain.on('win:isMaximized', (event) => {
    try {
      event.returnValue = isWindowMaximized(windowOf(event))
    } catch {
      event.returnValue = false
    }
  })

  ipcMain.handle('menu:setState', async (_event, state) => {
    try {
      applyMenuState(state)
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('dialog:confirmDiscard', async (event, name) => {
    try {
      const win = windowOf(event)
      const options = {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: 'Unsaved Changes',
        message: `Do you want to save the changes you made to ${name || 'Untitled'}?`,
        detail: "Your changes will be lost if you don't save them."
      }
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      return ['save', 'discard', 'cancel'][result.response] || 'cancel'
    } catch {
      return 'cancel'
    }
  })

  ipcMain.handle('dialog:error', async (_event, title, message) => {
    try {
      dialog.showErrorBox(String(title || 'Error'), String(message || ''))
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })

  ipcMain.handle('shell:openExternal', async (_event, url) => {
    try {
      if (typeof url !== 'string' || !isWebUrl(url)) {
        return { error: 'Only http and https URLs can be opened externally' }
      }
      await shell.openExternal(url)
      return { ok: true }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  })
}

function withExtension(name, ext) {
  const clean = String(name || '').trim() || `Untitled${ext}`
  return extname(clean) ? clean : clean + ext
}

/* ----------------------------------------------------------------- commands */

function handleMenuCommand(command, payload) {
  if (command === 'file:clear-recent') {
    clearRecentFiles()
    refreshRecent()
    return
  }

  const win = targetWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(MENU_CHANNEL, command, payload)
}

/* ------------------------------------------------------ keyboard shortcuts */

/**
 * Without a native menu on Windows/Linux every accelerator declared in menu.js is
 * dead, so main re-implements exactly that set on the raw key stream.
 * `before-input-event` runs ahead of the page, which is the only reliable way in:
 * CodeMirror and ProseMirror both swallow keys before a window-level keydown
 * listener in the renderer would ever see them.
 *
 * Deliberately NOT handled here:
 *  - Ctrl+C/V/X/A/Z/Y and friends — Chromium's own editing bindings.
 *  - Ctrl+Tab / Ctrl+Shift+Tab — owned by the renderer, which already binds them.
 *  - Anything at all on macOS, where the real menu still owns these accelerators
 *    and a second handler would fire every command twice.
 *
 * Returns the menu command string for an input event, or null to let it through.
 */
function commandForInput(input) {
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : ''
  const code = typeof input.code === 'string' ? input.code : ''
  const ctrl = !!input.control
  const shift = !!input.shift
  const alt = !!input.alt
  const meta = !!input.meta

  // Alt+Z toggles word wrap. Requiring !ctrl also rules out AltGr, which Windows
  // reports as Ctrl+Alt and which types real characters on many layouts.
  if (alt) {
    if (ctrl || meta) return null
    return key === 'z' || code === 'KeyZ' ? 'view:toggle-wrap' : null
  }

  if (!ctrl || meta) return null

  // Zoom first: which character the key produces depends on the layout and on
  // Shift, so match the physical key too and tolerate Shift (Ctrl+Shift+= is the
  // same keycap as Ctrl+=, which is why menu.js carried a hidden twin item).
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return 'view:zoom-in'
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
    return 'view:zoom-out'
  }
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'view:zoom-reset'

  if (shift) {
    if (key === 's') return 'file:saveAs'
    if (key === 'd') return 'theme:toggle'
    // Open Folder had no accelerator in the native menu (it was a mouse-only item);
    // with the menu gone it needs one, and Ctrl+Shift+O is otherwise unused.
    if (key === 'o') return 'folder:open'
    return null
  }

  // Digits by character first, by physical key second — on AZERTY the number row
  // reports '&', 'é', '"'… while the codes stay Digit1..Digit4.
  if (key === '1' || code === 'Digit1') return 'mode:source'
  if (key === '2' || code === 'Digit2') return 'mode:rich'
  if (key === '3' || code === 'Digit3') return 'mode:reading'
  if (key === '4' || code === 'Digit4') return 'mode:split'

  switch (key) {
    case 'n':
      return 'file:new'
    case 't':
      return 'tab:new'
    case 'o':
      return 'file:open'
    case 's':
      return 'file:save'
    case 'w':
      return 'tab:close'
    case 'e':
      return 'mode:cycle'
    case 'h':
      return 'mode:split'
    case 'b':
      return 'view:toggle-sidebar'
    case 'f':
      return 'edit:find'
    case ',':
      return 'app:preferences'
    default:
      return null
  }
}

function installAccelerators(contents) {
  if (isMac) return
  if (!contents || contents.isDestroyed()) return

  contents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return
    const command = commandForInput(input)
    if (!command) return
    // Held keys may repeat zoom, but must not open a dialog or a tab per repeat.
    if (input.isAutoRepeat && !command.startsWith('view:zoom')) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    handleMenuCommand(command)
  })
}

/* --------------------------------------------------------------- quit guard */

function clearQuitAckTimer() {
  if (quitAckTimer) {
    clearTimeout(quitAckTimer)
    quitAckTimer = null
  }
}

/**
 * Give the renderer a chance to veto a quit (it may have several dirty tabs to
 * prompt for, sequentially). Returns true if the quit may proceed immediately;
 * false means the caller should preventDefault and wait for `app:quitResponse`.
 */
function requestQuitApproval(win) {
  if (quitApproved) return true

  const target = win && !win.isDestroyed() ? win : targetWindow()
  if (!target || target.isDestroyed() || !rendererReady) {
    quitApproved = true
    return true
  }

  // Already waiting on an answer — don't ask twice.
  if (quitAckTimer) return false

  quitAckTimer = setTimeout(() => {
    quitAckTimer = null
    // A wedged renderer must never make the app unquittable.
    quitApproved = true
    app.quit()
  }, QUIT_ACK_TIMEOUT)

  target.webContents.send(MENU_CHANNEL, 'app:before-quit')
  return false
}

/* ---------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Register as early as possible: macOS can fire open-file before `ready`.
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (app.isReady()) {
      openExternalFile(filePath)
    } else {
      app.whenReady().then(() => openExternalFile(filePath))
    }
  })

  app.on('second-instance', (_event, argv) => {
    const win = targetWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    const filePath = markdownFileFromArgv(argv)
    if (filePath) openExternalFile(filePath)
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.forme.app')

    loadSettings()
    pruneRecentFiles()
    // Drop drafts nothing has referenced for a month (Addendum E).
    sweepOldDrafts()

    // First run only: leave a README and one example behind so the theme folder is
    // never empty, then watch it so edits re-theme the running app.
    seedUserThemes()
    startThemeWatch()

    buildMenu({
      onCommand: handleMenuCommand,
      state: {
        mode: getSettings().mode,
        theme: getSettings().theme,
        dirty: false,
        hasFile: false
      }
    })

    registerIpc()
    createWindow()

    const initialFile = markdownFileFromArgv(process.argv)
    if (initialFile) openExternalFile(initialFile)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents)
  })

  app.on('before-quit', (event) => {
    if (!requestQuitApproval(null)) event.preventDefault()
  })

  app.on('will-quit', () => {
    clearQuitAckTimer()
    stopFolderWatch()
    stopThemeWatch()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
