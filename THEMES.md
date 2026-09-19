# Writing a theme for forme

A theme is one small JSON file. Drop it in the themes folder, save, and the app
repaints — no restart, no reload.

## Where themes live

| Platform | Folder |
| --- | --- |
| Windows | `%APPDATA%\Forme\themes` |
| macOS | `~/Library/Application Support/forme/themes` |
| Linux | `~/.config/forme/themes` |

Every `*.json` file in that folder is a theme. The folder is created on first
run with a `README.md` and one commented example inside, and the app watches it:
**saving a file applies it immediately** to the open window if that theme is the
active one. A file that fails to parse is skipped and the previous theme stays
on screen, so a stray comma never leaves you with an unstyled app.

The two built-in themes, `dark` and `light`, are not in that folder — they ship
inside the app. They are generated from `src/renderer/src/styles/theme.css` by
`npm run themes:sync` and must not be hand-edited; edit the CSS and re-run the
script instead.

## File format

```json
{
  "id": "gruvbox-dark",
  "name": "Gruvbox Dark",
  "type": "dark",
  "colors": { "bg": "#282828", "fg": "#ebdbb2", "accent": "#83a598" },
  "syntax": { "keyword": "#fb4934", "string": "#b8bb26" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | no | Unique slug. If you leave it out, the filename stem is used (`gruvbox-dark.json` → `gruvbox-dark`). |
| `name` | no | Label shown in the theme menu. Defaults to the id. |
| `type` | **yes** | `"dark"` or `"light"`. Decides which built-in fills in whatever you omit, and which `data-theme` value the app puts on `<html>`. |
| `colors` | no | Key `k` sets the CSS custom property `--k`. |
| `syntax` | no | Key `k` sets `--hl-k`, the highlight.js / editor token palette. |

Rules worth knowing:

- **Every omitted token falls back to the built-in of the same `type`.** A
  three-line theme is valid and is the recommended way to start — set `bg`,
  `fg`, `accent`, look at it, then keep going.
- Values must be a CSS colour: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()`,
  `hsl()/hsla()` or a named colour. Anything else (a length, a gradient, a
  `var()`) is dropped with a console warning rather than written through.
- Unknown keys are ignored, so you can leave notes to yourself in an unused key.
- JSON has no comments — don't add `//` lines, the file will fail to parse.

### Minimal example — complete and valid

```json
{
  "name": "Midnight",
  "type": "dark",
  "colors": {
    "bg": "#0f1116",
    "bg-elevated": "#161922",
    "fg": "#dfe3ec",
    "accent": "#7aa2f7"
  }
}
```

Everything else — borders, syntax colours, scrollbars — comes from the built-in
dark theme.

### Full example — every token set

```json
{
  "id": "solar-light",
  "name": "Solar Light",
  "type": "light",
  "colors": {
    "bg": "#fdf6e3",
    "bg-elevated": "#fffbf0",
    "bg-inset": "#f2ead5",
    "bg-hover": "#eee3c8",
    "fg": "#1f2933",
    "fg-muted": "#586e75",
    "fg-subtle": "#8a9a9a",
    "border": "#e6dcc3",
    "border-strong": "#cfc3a4",
    "accent": "#1f6fb2",
    "accent-fg": "#ffffff",
    "accent-muted": "rgba(31, 111, 178, 0.12)",
    "danger": "#c0392b",
    "success": "#2f7d52",
    "warning": "#9d6f1c",
    "code-bg": "#f2ead5",
    "code-fg": "#2b2d33",
    "selection": "rgba(31, 111, 178, 0.18)",
    "scrollbar-thumb": "#d8cdb0",
    "scrollbar-thumb-hover": "#c2b795"
  },
  "syntax": {
    "keyword": "#8250a8",
    "string": "#326e42",
    "comment": "#93a1a1",
    "number": "#9a5722",
    "function": "#2f56b3",
    "title": "#2f56b3",
    "attr": "#8a6216",
    "built_in": "#0f6d72",
    "literal": "#9a5722",
    "type": "#0f6d72",
    "variable": "#1f2933",
    "tag": "#b03a35",
    "name": "#b03a35",
    "meta": "#767a84",
    "symbol": "#8250a8",
    "operator": "#586e75",
    "punctuation": "#767a84",
    "deletion-fg": "#8f2b25",
    "deletion-bg": "rgba(194, 65, 58, 0.1)",
    "addition-fg": "#1f6040",
    "addition-bg": "rgba(47, 125, 82, 0.1)"
  }
}
```

## Token reference

This is the complete list — 20 `colors` keys and 21 `syntax` keys. There are no
others; anything not here is ignored.

### `colors` — surfaces

| Key | Controls |
| --- | --- |
| `bg` | The app's base background: workspace, editor canvas, reading pane. |
| `bg-elevated` | Raised chrome that sits on top of `bg`: toolbar, tab strip, sidebar, statusbar, menus. |
| `bg-inset` | Recessed areas: gutters, the source-mode gutter background, wells and inputs. |
| `bg-hover` | Hover/active fill for rows, tabs and buttons; also the active editor line. |

### `colors` — text

| Key | Controls |
| --- | --- |
| `fg` | Primary text: document body, editor text, headings. |
| `fg-muted` | Secondary text: statusbar, sidebar item labels, inactive tabs. |
| `fg-subtle` | Tertiary text: line numbers, placeholders, markdown punctuation, empty-state hints. |

### `colors` — borders

| Key | Controls |
| --- | --- |
| `border` | Ordinary separators: toolbar/statusbar rules, table cell lines, panel edges. |
| `border-strong` | Emphasised edges: focus outlines, horizontal rules, dividers you're dragging. |

### `colors` — accent

| Key | Controls |
| --- | --- |
| `accent` | The interactive colour: links, active tab marker, selected sidebar row, focus ring, active format buttons. |
| `accent-fg` | Text drawn *on top of* a filled `accent` surface. Must contrast with `accent`, not with `bg`. |
| `accent-muted` | Translucent accent wash: selected-row fill, search-match highlight, matching-bracket background. Use an `rgba()` so text stays readable through it. |

### `colors` — status

| Key | Controls |
| --- | --- |
| `danger` | Errors, the unsaved-changes dot, invalid syntax, deleted lines in diffs. |
| `success` | Confirmations, checked task-list items, string literals in the editor theme. |
| `warning` | Cautions, numbers and attribute names in the editor theme. |

### `colors` — code, selection, scrollbars

| Key | Controls |
| --- | --- |
| `code-bg` | Background of inline code and fenced code blocks in rendered markdown. |
| `code-fg` | Default text colour inside code, before syntax colours apply. |
| `selection` | Text-selection highlight across the whole app. Keep it translucent. |
| `scrollbar-thumb` | Scrollbar thumb. |
| `scrollbar-thumb-hover` | Scrollbar thumb while hovered or dragged. |

### `syntax` — code token palette

Applied to highlighted fenced code and to the source editor. Each key `k` sets
`--hl-k`.

| Key | Controls |
| --- | --- |
| `keyword` | Language keywords: `if`, `return`, `const`. |
| `string` | String and template literals. |
| `comment` | Comments. |
| `number` | Numeric literals. |
| `function` | Function names at call and definition sites. |
| `title` | Declaration names — class and function titles. |
| `attr` | Object keys, HTML/JSX attribute names, YAML and JSON keys. |
| `built_in` | Built-in identifiers: `console`, `Math`, `window`. |
| `literal` | Language literals: `true`, `false`, `null`, `undefined`. |
| `type` | Type and class names. |
| `variable` | Plain identifiers and variable references. |
| `tag` | HTML/XML tag brackets and tag names. |
| `name` | Named entities in markup, closely paired with `tag`. |
| `meta` | Preprocessor lines, shebangs, decorators, doctypes. |
| `symbol` | Symbols, atoms, and character escapes. |
| `operator` | Operators and punctuation-as-operators. |
| `punctuation` | Structural punctuation: braces, brackets, separators. |
| `deletion-fg` | Text of a removed line in a fenced diff. |
| `deletion-bg` | Background of a removed line in a fenced diff — keep it translucent. |
| `addition-fg` | Text of an added line in a fenced diff. |
| `addition-bg` | Background of an added line in a fenced diff — keep it translucent. |

## How to pick colours

- Start with four keys: `bg`, `bg-elevated`, `fg`, `accent`. Everything else
  inherits from the built-in of your `type` and will already look coherent.
- `bg-elevated` should be a *small* step from `bg` — one or two percent of
  lightness. Big jumps make the toolbar look like a different app.
- **The accent must be legible on both `bg` and `bg-elevated`**, because links
  appear in the document and the active tab marker appears in the chrome. Check
  it against both, not just one. The built-ins land at 5.7:1 / 5.3:1 (dark) and
  5.3:1 / 5.4:1 (light).
- **`fg` on `bg` should clear WCAG AA, 4.5:1.** Both built-ins are far past it —
  14.2:1 for dark, 15.2:1 for light — so there is plenty of headroom if you want
  a softer foreground. Keep `fg-muted` above 4.5:1 too; it carries real
  information in the statusbar.
- `accent-fg` is the odd one out: it is measured against `accent`, not against
  the background. Near-white or near-black is almost always right.
- Keep `accent-muted`, `selection`, `deletion-bg` and `addition-bg` translucent
  (`rgba(...)` at roughly 10–30% alpha) so the text underneath stays readable in
  both code and prose.
- Syntax colours want similar lightness to each other; readability in code comes
  from hue differences, not from one token shouting. `comment` is the exception —
  it should recede, around the level of `fg-subtle`.

## Troubleshooting

- **Nothing changed on save.** The file is probably not valid JSON, or the theme
  isn't the active one. Pick it from the theme menu first, then save again.
- **One colour is ignored.** It isn't a plain CSS colour. `var(--x)`,
  `color-mix(...)`, gradients and lengths are all dropped; use a literal.
- **Everything reverted to the built-in.** The theme failed to load; the app
  falls back to the built-in of the last known type rather than showing an
  unstyled window.
