# Forme

A markdown editor and viewer for the desktop. Four views over the same document,
tabs, a folder browser, and a dark/light toggle that actually covers everything —
including syntax highlighting.

## Views

| View | Shortcut | What it is |
| --- | --- | --- |
| **Source** | `Ctrl+1` | Raw markdown in CodeMirror 6, with syntax highlighting and highlighted fenced code |
| **Rich** | `Ctrl+2` | WYSIWYG editing in TipTap — you get formatted text, the file stays markdown |
| **Split** | `Ctrl+4` / `Ctrl+H` | Source on the left, live preview on the right, scroll-synced |
| **Read** | `Ctrl+3` | Rendered output, no editing chrome |

Markdown on disk is the single source of truth. Switching views does **not**
reformat your file — a view only writes markdown back if you actually edited in
it, so opening Rich mode to look at something leaves the source byte-identical.

## Other things it does

- **Tabs** — `Ctrl+T` new, `Ctrl+W` close, `Ctrl+Tab` to cycle, middle-click to close.
  Unsaved tabs show a dot. Open tabs are restored on the next launch.
- **Folder browser** — *File → Open Folder…* puts a markdown-only tree in the
  sidebar, watched for changes on disk.
- **Outline** — live table of contents from your headings, click to jump. Works
  identically in all four views.
- **Word wrap** — on by default, including inside fenced code blocks, so long
  lines wrap instead of running off the right edge. `Alt+Z` toggles it.
- **Theme** — `Ctrl+Shift+D` toggles dark/light, or follow the OS via
  *View → Appearance → System*.
- **Export** — *File → Export as HTML…* writes a self-contained file with the
  current theme's styles inlined.

## Running it

```bash
npm install
npm run dev
```

Package a distributable:

```bash
npm run dist
```

## Stack

Electron + electron-vite. CodeMirror 6 for source, TipTap 3 for rich text,
markdown-it for rendering, turndown for the rich→markdown direction,
highlight.js for code, DOMPurify on all rendered output. No UI framework — the
renderer is plain ES modules.

`CONTRACT.md` documents the module boundaries: the preload API surface, the
settings shape, and the interface every view implements.
