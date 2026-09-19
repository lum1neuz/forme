# Forme — internal interface contract

Single source of truth for module boundaries. Do not change a signature here without
updating this file. Plain JavaScript (ESM), no TypeScript, no UI framework.

## Layout

```
src/main/index.js       app lifecycle, BrowserWindow, IPC handlers
src/main/menu.js        native application menu + accelerators
src/main/settings.js    JSON settings persisted in app.getPath('userData')
src/preload/index.js    contextBridge -> window.forme
src/renderer/index.html  DOM shell
src/renderer/src/main.js       app controller (owned by orchestrator)
src/renderer/src/markdown.js   shared markdown-it / turndown pipeline
src/renderer/src/modes/source.js
src/renderer/src/modes/rich.js
src/renderer/src/modes/reading.js
src/renderer/src/styles/*.css
```

## Core principle

**Markdown text is the single source of truth.** The controller holds one string.
Modes convert to/from it on mount and unmount. A mode that was never edited must
return the exact markdown it was given (byte-identical) so that merely visiting
rich mode never reflows the user's source.

## Preload API — `window.forme`

```js
window.forme = {
  platform: 'win32' | 'darwin' | 'linux',

  file: {
    openDialog(),                  // -> {canceled:true} | {path, content}
    openPath(path),                // -> {path, content} | {error}
    save(path, content),           // -> {ok:true, path} | {error}
    saveDialog(content, suggestedName), // -> {canceled:true} | {ok:true, path}
    exportHtml(html, suggestedName),    // -> {canceled:true} | {ok:true, path}
    revealInFolder(path),
  },

  settings: {
    get(),                         // -> Settings
    set(patch),                    // shallow merge -> Settings
  },

  win: {
    setTitle(title),
    setDocumentEdited(bool),
  },

  menu: {
    onCommand(cb),                 // cb(command: string, payload?: any)
    setState(state),               // {mode, theme, dirty, hasFile} -> syncs checkmarks
  },

  dialog: {
    confirmDiscard(name),          // -> 'save' | 'discard' | 'cancel'
    error(title, message),
  },

  shell: { openExternal(url) },

  onOpenExternalFile(cb),          // cb({path, content}) - file opened via OS assoc
}
```

### Menu command strings

`file:new` `file:open` `file:save` `file:saveAs` `file:export-html`
`mode:source` `mode:rich` `mode:reading` `mode:cycle`
`theme:toggle` `theme:dark` `theme:light` `theme:system`
`view:toggle-sidebar` `view:zoom-in` `view:zoom-out` `view:zoom-reset`
`edit:find` `help:about`

`file:open` may carry a payload of `{path}` when launched from the recent-files
submenu.

## Settings shape

```js
{
  theme: 'dark' | 'light' | 'system',
  mode: 'source' | 'rich' | 'reading',
  fontSize: 15,                 // px
  fontFamily: 'sans'|'serif'|'mono',
  lineWidth: 'narrow'|'normal'|'wide',
  showLineNumbers: true,
  spellcheck: true,
  sidebarVisible: true,
  recentFiles: [],              // absolute paths, newest first, max 12
  window: { width, height, x, y, maximized }
}
```

## Mode module interface

Each mode file exports one factory. All three share this shape.

```js
export function createSourceMode(opts) -> Mode   // modes/source.js
export function createRichMode(opts)   -> Mode   // modes/rich.js
export function createReadingMode(opts)-> Mode   // modes/reading.js

// opts: { theme, settings, onChange, onLinkClick }
//   onChange()          called (debounced ~150ms) after a real user edit
//   onLinkClick(href)   called when the user activates a link

Mode = {
  id,                         // 'source' | 'rich' | 'reading'
  editable,                   // boolean - reading mode is false
  mount(container),           // build DOM inside container
  destroy(),
  setMarkdown(md),            // load content; must NOT fire onChange
  getMarkdown(),              // current content as markdown
  isDirty(),                  // true only if edited since last setMarkdown()
  focus(),
  setTheme(theme),            // 'dark' | 'light'
  applySettings(settings),    // font size/family, line width, line numbers...
  getStats(),                 // { words, chars, lines }
  getOutline(),               // [{ level, text, slug }]
  exec(cmd),                  // optional formatting command, see below
  queryState(),               // optional -> Set of active cmd names
  find(),                     // optional - open the mode's own find UI
  scrollToSlug(slug),         // scroll a heading into view
}
```

`exec` command names (source + rich only; unsupported ones are a no-op):
`bold` `italic` `strike` `code` `link` `h1` `h2` `h3` `paragraph`
`bulletList` `orderedList` `taskList` `blockquote` `codeBlock` `hr` `table`
`undo` `redo`

## `markdown.js` exports

```js
export const md                       // configured markdown-it instance
export function renderMarkdown(src)   // -> sanitized HTML string
export function htmlToMarkdown(html)  // -> markdown string (turndown + gfm)
export function extractOutline(src)   // -> [{ level, text, slug }]
export function slugify(text)
export function countStats(src)       // -> { words, chars, lines }
```

markdown-it config: `html: true, linkify: true, typographer: true, breaks: false`,
GFM tables, task lists, heading anchors (`id` = slug), highlight.js fenced code.
All output passes through DOMPurify. Links are rendered as-is; the renderer
intercepts clicks.

## Theming contract

`<html>` carries `data-theme="dark"` or `data-theme="light"` — always one of the
two concrete values, never `system` (the controller resolves `system`).

CSS custom properties defined for both themes in `styles/theme.css`:

```
--bg  --bg-elevated  --bg-inset  --bg-hover
--fg  --fg-muted  --fg-subtle
--border  --border-strong
--accent  --accent-fg  --accent-muted
--danger  --success  --warning
--code-bg  --code-fg  --selection  --shadow
--font-sans  --font-serif  --font-mono
--radius  --line-width
```

## DOM shell contract (index.html)

```html
<div id="app">
  <header id="toolbar">
    <div id="toolbar-left">   #btn-sidebar #btn-new #btn-open #btn-save
    <div id="format-bar">     button[data-cmd="bold"] ... (hidden in reading mode)
    <div id="toolbar-right">  #mode-switch button[data-mode="source|rich|reading"]
                              #btn-theme
  </header>
  <div id="body">
    <aside id="sidebar">  #outline  #recent-files  </aside>
    <main id="workspace"> <div id="mode-host"></div> </main>
  </div>
  <footer id="statusbar">
    #status-file  #status-dirty  #status-mode  #status-stats
  </footer>
</div>
```

Modes mount into `#mode-host` and own everything inside it.
`<body data-mode="...">` is set by the controller so CSS can react to mode.

---

# Addendum A — split view, wrapping, tabs, folder browser

Added after the initial fan-out. Everything above still holds.

## Soft wrapping

Wrapping is ON by default and user-toggleable (`#btn-wrap` in the statusbar,
persisted as `settings.wrap`). The controller sets `body[data-wrap="on"|"off"]`;
CSS drives wrapping for rendered/rich content, while source mode also needs
`mode.setWrap(enabled)` because CodeMirror wraps via a JS extension.

## Fourth view: `split`

`mode` is now `'source' | 'rich' | 'split' | 'reading'`. In split view the
controller builds inside `#mode-host`:

```html
<div class="split-pane" id="pane-a"></div>
<div id="split-divider" role="separator" tabindex="0"></div>
<div class="split-pane" id="pane-b"></div>
```

and mounts a source mode into `#pane-a` and a reading mode into `#pane-b`,
pushing edits to the preview debounced. Pane ratio lives in
`--split-ratio` on `#mode-host` (0.15–0.85, persisted as `settings.splitRatio`).

Every mode gains: `setWrap(enabled)`, `getScrollFraction()`,
`setScrollFraction(f)`, `onScroll(cb)`.

Menu: `mode:split` (CmdOrCtrl+4), and Ctrl+H also toggles split.

## Tabs (multi-document)

The app holds N open documents. A `Doc` is owned by the controller:

```js
Doc = {
  id,                  // internal, stable
  path,                // absolute path or null for an untitled doc
  title,               // basename, or 'Untitled N'
  markdown,            // source of truth
  savedMarkdown,       // last persisted text, for dirty comparison
  mode,                // per-tab view mode
  scroll,              // per-tab scroll fraction
  dirty,               // derived: markdown !== savedMarkdown
}
```

Mode instances are NOT per-tab — the controller keeps one instance per mode and
swaps content on tab switch, restoring that tab's scroll position.

DOM, above `#toolbar`:

```html
<div id="tabbar">
  <div id="tabs"></div>          <!-- controller fills -->
  <button id="btn-new-tab"></button>
</div>
```

Each tab the controller renders:

```html
<div class="tab" data-tab-id="..." role="tab" aria-selected="true|false">
  <span class="tab-title"></span>
  <span class="tab-dot"></span>        <!-- unsaved indicator -->
  <button class="tab-close"></button>
</div>
```

Shortcuts: `tab:new` (CmdOrCtrl+T), `tab:close` (CmdOrCtrl+W),
`tab:next` (Ctrl+Tab), `tab:prev` (Ctrl+Shift+Tab). Middle-click closes.
Closing a dirty tab goes through `dialog.confirmDiscard`.

## Folder browser

```js
window.forme.folder = {
  choose(),              // -> {canceled:true} | {path, entries}
  list(path),            // -> {entries} | {error}
  onChanged(cb),         // debounced fs.watch notification -> cb({path})
  unwatch(),
}
```

`entries` is a flat, pre-sorted array — directories before files, each
alphabetical — which the controller renders as a collapsible tree:

```js
{ name, path, dir: boolean, depth: number }
```

Scan rules: markdown files only (`.md .markdown .mdown .mkd`) plus the
directories on the way to them; skip `node_modules`, `.git`, and any dotted
directory; cap at depth 8 and 5000 entries, returning `{truncated: true}` past
that. Never throw on a permission error — skip that subtree.

Sidebar gains a `#folder-tree` section with `#btn-choose-folder` and a header
showing the chosen folder's basename.

## Settings additions

```js
{
  wrap: true,
  splitRatio: 0.5,
  folder: null,                 // last opened folder path
  session: {                    // restored on launch
    tabs: [{ path, mode }],
    activeIndex: 0,
  },
}
```

---

# Addendum B — VS Code-style collapsible sidebar

Replaces the single stacked `#sidebar` from Addendum A. The sidebar is now an
always-visible icon rail plus one swappable panel, resizable by dragging.

## DOM

```html
<div id="body">
  <nav id="activitybar" role="tablist">
    <button class="activity-item" data-view="files"   aria-label="Explorer">
    <button class="activity-item" data-view="outline" aria-label="Outline">
    <button class="activity-item" data-view="recent"  aria-label="Recent">
  </nav>
  <aside id="sidebar">
    <div id="sidebar-header">
      <span id="sidebar-title"></span>
      <div id="sidebar-actions"> #btn-choose-folder ... </div>
    </div>
    <div id="sidebar-panels">
      <section id="folder-tree"  data-view="files">   ... #folder-name, ul, .empty
      <section id="outline"      data-view="outline"> ... ul, .empty
      <section id="recent-files" data-view="recent">  ... ul, .empty
    </div>
  </aside>
  <div id="sidebar-resizer" role="separator" aria-orientation="vertical" tabindex="0"></div>
  <main id="workspace"> <div id="mode-host"></div> </main>
</div>
```

## Behaviour

- `body[data-sidebar-view="files"|"outline"|"recent"]` decides which `section`
  in `#sidebar-panels` is visible. Exactly one is shown.
- `body[data-sidebar="hidden"]` collapses `#sidebar` to zero width and hides
  `#sidebar-resizer`. **`#activitybar` stays visible** — that is the VS Code
  behaviour and the only way back.
- Clicking the already-active activity item collapses the sidebar; clicking any
  other one expands it and switches the panel.
- Width lives in `--sidebar-width` on `#body`, dragged via `#sidebar-resizer`,
  clamped 160–480px, persisted as `settings.sidebarWidth`.
- `Ctrl+B` toggles collapse (`view:toggle-sidebar`).

## Settings additions

```js
{
  sidebarView: 'files',   // 'files' | 'outline' | 'recent'
  sidebarWidth: 260,
}
```

---

# Addendum C — JSON themes

Themes become data. `theme.css` stays as the **fallback baseline** (it guarantees
the app is styled before any JSON loads, and covers the pre-paint script), and a
loaded theme overlays it by setting the same custom properties inline on
`<html>`.

## Theme file

```json
{
  "id": "gruvbox-dark",
  "name": "Gruvbox Dark",
  "type": "dark",
  "colors": { "bg": "#282828", "fg": "#ebdbb2", "accent": "#83a598" },
  "syntax": { "keyword": "#fb4934", "string": "#b8bb26" }
}
```

- `id` — unique slug. For a user theme, the filename stem wins if `id` is absent.
- `type` — `"dark"` or `"light"`. Decides which built-in supplies missing tokens,
  and which `data-theme` value goes on `<html>` so CSS that keys off it still works.
- `colors` — key `k` maps to the custom property `--k`. Every token in the
  theming contract is accepted; **any omitted token falls back to the built-in of
  the same `type`**, so a three-line theme is valid.
- `syntax` — key `k` maps to `--hl-k`. Entirely optional.
- Unknown keys are ignored. Values must be a CSS color; anything else is dropped
  with a console warning rather than written through.

## Locations

- **Built-ins** live at `resources/themes/dark.json` and `light.json` and are
  `import`ed by the main process, so they are inlined into the bundle at build
  time and need no packaging step. They are generated from `theme.css` by
  `npm run themes:sync` — never hand-edit them, or they will drift from the CSS
  fallback.
- **User themes** live in `<userData>/themes/*.json`, are read at runtime and
  watched for changes.

## Preload API

```js
window.forme.theme = {
  list(),          // -> [{ id, name, type, builtin }]  built-ins first, then user, each alphabetical
  get(id),         // -> full theme object (already merged over its type's built-in) | {error}
  onChanged(cb),   // debounced fs.watch on the user theme dir -> cb(); returns unsubscribe
  openFolder(),    // shell.openPath(<userData>/themes) so the user can add one
}
```

On first run the main process creates `<userData>/themes/` containing a
`README.md` and one commented example theme, so the folder is never empty and
the format is discoverable.

## Settings additions

```js
{
  theme: 'system',      // 'system' | <themeId>
  themeDark: 'dark',    // theme id used when `theme` is 'system' and the OS is dark
  themeLight: 'light',  // ...and when the OS is light
}
```

`theme` was previously `'dark' | 'light' | 'system'`; those two values are still
valid because they are now the built-in theme ids. No migration needed.

## Renderer behaviour

The controller resolves `theme` (following the OS when `'system'`), fetches that
theme, applies `--*` properties inline on `<html>`, sets `data-theme` to the
theme's `type`, and clears any properties the previous theme set but this one
does not. A theme that fails to load falls back to the built-in of the last
known type rather than leaving the app unstyled. `onChanged` re-applies the
active theme live, so editing a JSON file updates the app without a restart.

---

# Addendum D — bundled themes and the preferences modal

## Bundled themes

Beyond the two generated built-ins, `resources/themes/` also holds hand-authored
themes. They are imported by the main process and reported with `builtin: true`.
Adding one is a code change (an import plus a list entry); users add their own to
`<userData>/themes` instead, which needs no code change.

Generated (never hand-edit): `dark.json`, `light.json`.
Hand-authored: `obsidian.json`, `ember.json`, `forest.json`, `parchment.json`.

## Preferences modal

Opened by `app:preferences` (Ctrl+,), from the app menu, and from the statusbar.

```html
<div id="prefs-overlay" hidden>
  <div id="prefs-dialog" role="dialog" aria-modal="true" aria-labelledby="prefs-title">
    <header id="prefs-header">
      <h2 id="prefs-title">Preferences</h2>
      <button id="prefs-close" aria-label="Close preferences"></button>
    </header>
    <nav id="prefs-nav" role="tablist">
      <button class="prefs-tab" data-pane="appearance" role="tab">Appearance</button>
      <button class="prefs-tab" data-pane="editor"     role="tab">Editor</button>
      <button class="prefs-tab" data-pane="general"    role="tab">General</button>
    </nav>
    <div id="prefs-body">
      <section class="prefs-pane" data-pane="appearance"> ... </section>
      <section class="prefs-pane" data-pane="editor">     ... </section>
      <section class="prefs-pane" data-pane="general">    ... </section>
    </div>
  </div>
</div>
```

`body[data-prefs-pane="appearance|editor|general"]` selects the visible pane.

### Controls (ids the controller binds)

| Id | Kind | Setting |
| --- | --- | --- |
| `#prefs-theme-grid` | filled by controller | `theme` |
| `#pref-follow-system` | toggle | `theme: 'system'` |
| `#btn-open-themes-folder` | button | — |
| `#pref-font-family` | segmented `sans/serif/mono` | `fontFamily` |
| `#pref-font-size` | range 10–32 + `#pref-font-size-value` | `fontSize` |
| `#pref-line-width` | segmented `narrow/normal/wide` | `lineWidth` |
| `#pref-wrap` | toggle | `wrap` |
| `#pref-line-numbers` | toggle | `showLineNumbers` |
| `#pref-spellcheck` | toggle | `spellcheck` |
| `#pref-default-mode` | select `source/rich/split/reading` | `mode` |
| `#pref-restore-session` | toggle | `restoreSession` |
| `#prefs-reset` | button | restore defaults |

Row markup: `.prefs-row` > `.prefs-label` (+ optional `.prefs-hint`) + `.prefs-control`.
Segmented controls are `button[data-value]` inside `.prefs-segmented`, with
`aria-pressed`. Toggles are `button.prefs-toggle[role="switch"][aria-checked]`.

Each theme swatch the controller renders:

```html
<button class="theme-swatch" data-theme-id="..." aria-pressed="false">
  <span class="swatch-chips">
    <span class="chip" style="background:#..."></span>   <!-- bg, bg-elevated, accent, fg -->
  </span>
  <span class="swatch-name"></span>
  <span class="swatch-badge"></span>   <!-- "Custom" for non-builtin -->
</button>
```

### Settings addition

```js
{ restoreSession: true }
```

When false, the app opens a single empty document instead of reopening tabs.

---

# Addendum E — draft persistence

Unsaved work survives a restart. An untitled scratch tab comes back untitled; a
saved file with unsaved edits comes back still dirty, showing its unsaved dot.

## Storage

One JSON file per draft at `<userData>/drafts/<draftId>.json`:

```js
{
  draftId,        // uuid, generated once per document and stable for its lifetime
  path,           // absolute path, or null for an untitled document
  title,          // basename, or 'Untitled N'
  mode,           // the document's view mode
  markdown,       // the live buffer
  savedMarkdown,  // what is on disk (=== markdown would mean clean, so it is never written then)
  updatedAt       // epoch ms
}
```

A draft exists **only while a document is dirty, or untitled with content**. It is
deleted the moment the document is saved, or when its tab is closed and the user
discards. Clean saved files are never duplicated into drafts — the session record
already has the path, and the file is re-read from disk.

## Preload API

```js
window.forme.draft = {
  list(),           // -> [record], newest first; skips unreadable/oversized files
  save(record),     // -> {ok, draftId} | {error}
  remove(draftId),  // -> {ok}
  prune(keepIds),   // -> {ok, removed}  deletes drafts not in keepIds
}
```

Caps: 8 MB per draft, 200 drafts. Hostile/corrupt files are skipped, never fatal.

## Session record

`session.tabs` entries gain a `draftId`:

```js
session.tabs = [{ path, mode, draftId }]   // path null for untitled, draftId always present
```

## Restore order per tab

1. A draft file for `draftId` exists → use it, restoring the dirty state.
2. Else `path` → read from disk, clean.
3. Else skip.

`restoreSession: false` suppresses restoring tabs but does **not** delete drafts,
so turning it back on recovers them. Unreferenced drafts older than 30 days are
pruned at startup.
