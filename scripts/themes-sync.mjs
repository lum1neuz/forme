/**
 * themes-sync — generate the built-in JSON themes from the CSS fallback baseline.
 *
 *   node scripts/themes-sync.mjs        (npm run themes:sync)
 *
 * Input : src/renderer/src/styles/theme.css   (INPUT ONLY — never written to)
 * Output: resources/themes/dark.json, resources/themes/light.json
 *
 * THE GENERATED JSON FILES MUST NOT BE HAND-EDITED. They are derived from
 * theme.css so the built-in themes provably cannot drift from the CSS fallback
 * that styles the app before any theme JSON loads. Edit theme.css, then re-run
 * `npm run themes:sync` and commit both the CSS and the regenerated JSON.
 *
 * What it does:
 *   - strips /* *\/ comments, then walks the stylesheet rule by rule (at-rules
 *     included) instead of pattern-matching declarations in raw text, so
 *     reordering, blank lines, multi-line values and `!important` are all fine;
 *   - keeps declarations from selectors carrying [data-theme="dark"|"light"];
 *   - treats theme-independent tokens (the bare `:root` block: fonts, radii,
 *     spacing, metrics, transitions) as context for var() lookups only — they
 *     are shared, so they belong in neither theme file;
 *   - resolves var(--x) indirection down to a literal;
 *   - emits only color-ish values (#hex, rgb/rgba, hsl/hsla, named colors);
 *   - routes --hl-* into `syntax` (minus the prefix) and everything else into
 *     `colors` (minus the leading --).
 *
 * Deterministic: source order is preserved, so running it twice produces
 * byte-identical files.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSS_FILE = join(ROOT, 'src', 'renderer', 'src', 'styles', 'theme.css')
const OUT_DIR = join(ROOT, 'resources', 'themes')

const THEMES = [
  { id: 'dark', name: 'Dark', type: 'dark' },
  { id: 'light', name: 'Light', type: 'light' }
]

const SYNTAX_PREFIX = '--hl-'
const MAX_VAR_DEPTH = 8

/* --------------------------------------------------------------------------
   CSS parsing
   -------------------------------------------------------------------------- */

/** Remove /* ... *\/ comments. Unterminated comments swallow the rest, as CSS does. */
function stripComments(css) {
  let out = ''
  let i = 0
  while (i < css.length) {
    const start = css.indexOf('/*', i)
    if (start === -1) {
      out += css.slice(i)
      break
    }
    out += css.slice(i, start)
    const end = css.indexOf('*/', start + 2)
    if (end === -1) break
    // Keep a space so `a/*x*/b` does not become `ab`.
    out += ' '
    i = end + 2
  }
  return out
}

/**
 * Walk a stylesheet into a flat list of { selector, body } rules, descending
 * into at-rules (@media, @supports, ...) so a theme block wrapped in one is
 * still found. Quotes and parens are tracked so a `{` inside a string or a
 * `content:` value cannot desynchronise the walker.
 */
function parseRules(css, out = []) {
  let i = 0
  let prelude = ''
  let quote = null
  let paren = 0

  while (i < css.length) {
    const ch = css[i]

    if (quote) {
      prelude += ch
      if (ch === '\\') {
        prelude += css[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      prelude += ch
      i++
      continue
    }

    if (ch === '(') paren++
    if (ch === ')' && paren > 0) paren--

    if (ch === '{' && paren === 0) {
      const { body, end } = readBlock(css, i)
      const selector = prelude.trim()
      if (selector.startsWith('@')) {
        // Nested rules live inside; declaration-only at-rules (@font-face…)
        // simply yield nothing interesting.
        parseRules(body, out)
      } else if (selector) {
        out.push({ selector, body })
      }
      prelude = ''
      i = end + 1
      continue
    }

    if (ch === ';' && paren === 0) {
      // A statement at-rule such as @import / @charset.
      prelude = ''
      i++
      continue
    }

    prelude += ch
    i++
  }

  return out
}

/** Given the index of a `{`, return its balanced body and the index of the `}`. */
function readBlock(css, openIndex) {
  let depth = 0
  let quote = null
  for (let i = openIndex; i < css.length; i++) {
    const ch = css[i]
    if (quote) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { body: css.slice(openIndex + 1, i), end: i }
    }
  }
  // Unbalanced — treat the remainder as the body.
  return { body: css.slice(openIndex + 1), end: css.length }
}

/** Split a declaration block on top-level semicolons and return custom properties. */
function parseDeclarations(body) {
  const decls = []
  let buf = ''
  let quote = null
  let paren = 0

  const flush = () => {
    const text = buf.trim()
    buf = ''
    if (!text) return
    const colon = text.indexOf(':')
    if (colon === -1) return
    const prop = text.slice(0, colon).trim()
    if (!prop.startsWith('--')) return
    let value = text.slice(colon + 1).trim()
    value = value.replace(/!\s*important\s*$/i, '').trim()
    // Normalise whitespace so a multi-line value becomes a tidy one-liner.
    value = value
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
    if (!value) return
    decls.push({ prop, value })
  }

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      buf += ch
      if (ch === '\\') {
        buf += body[i + 1] ?? ''
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(') paren++
    if (ch === ')' && paren > 0) paren--
    if (ch === ';' && paren === 0) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  return decls
}

/* --------------------------------------------------------------------------
   Selector classification
   -------------------------------------------------------------------------- */

/** Split a selector list on top-level commas. */
function splitSelectorList(selector) {
  const parts = []
  let buf = ''
  let quote = null
  let depth = 0
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf.trim())
  return parts
}

const DATA_THEME = /\[\s*data-theme\s*[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/i

/** -> 'dark' | 'light' | 'shared' | null for one compound selector. */
function classifySelector(sel) {
  const m = sel.match(DATA_THEME)
  if (m) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim().toLowerCase()
    return value === 'dark' || value === 'light' ? value : null
  }
  // A bare root-ish selector defines the theme-independent tokens.
  const bare = sel.replace(/\s+/g, '')
  return bare === ':root' || bare === 'html' || bare === ':root,html' ? 'shared' : null
}

/* --------------------------------------------------------------------------
   Colour detection
   -------------------------------------------------------------------------- */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOR_FN = /^(rgb|rgba|hsl|hsla)\(/i

// CSS Color Module Level 4 named colours, plus `transparent`.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent'
  ).split(' ')
)

/** True when the whole value is a single literal colour. */
function isColor(value) {
  const v = value.trim()
  if (HEX.test(v)) return true
  if (NAMED_COLORS.has(v.toLowerCase())) return true
  if (COLOR_FN.test(v)) {
    // Must be one balanced function call spanning the entire value, otherwise
    // this is a composite (a box-shadow, a gradient, …) and not a colour.
    const open = v.indexOf('(')
    let depth = 0
    for (let i = open; i < v.length; i++) {
      if (v[i] === '(') depth++
      else if (v[i] === ')') {
        depth--
        if (depth === 0) return i === v.length - 1
      }
    }
    return false
  }
  return false
}

/* --------------------------------------------------------------------------
   var() resolution
   -------------------------------------------------------------------------- */

const VAR_CALL = /^var\(\s*(--[^\s,)]+)\s*(?:,([\s\S]*))?\)$/

/**
 * Resolve a value to a literal, following var(--x) through the theme's own map
 * and then the shared map. Returns { value } or { error }.
 */
function resolveValue(value, themeMap, sharedMap) {
  let current = value.trim()
  const seen = new Set()

  for (let depth = 0; depth <= MAX_VAR_DEPTH; depth++) {
    const m = current.match(VAR_CALL)
    if (!m) return { value: current }

    const name = m[1]
    const fallback = m[2] != null ? m[2].trim() : null
    if (seen.has(name)) return { error: `circular var() reference at ${name}` }
    seen.add(name)

    const next = themeMap.has(name) ? themeMap.get(name) : sharedMap.get(name)
    if (next != null) {
      current = next.trim()
      continue
    }
    if (fallback) {
      current = fallback
      continue
    }
    return { error: `var(${name}) is not defined in this theme or in the shared tokens` }
  }
  return { error: `var() indirection deeper than ${MAX_VAR_DEPTH} levels` }
}

/* --------------------------------------------------------------------------
   Main
   -------------------------------------------------------------------------- */

function fail(message) {
  console.error(`themes-sync: ${message}`)
  process.exit(1)
}

if (!existsSync(CSS_FILE)) {
  fail(`input stylesheet not found: ${CSS_FILE}`)
}

const css = stripComments(readFileSync(CSS_FILE, 'utf8'))
const rules = parseRules(css)

// Ordered maps of prop -> raw value. Later declarations win, order of first
// appearance is kept, which is what the cascade does for a flat file like this.
const buckets = { dark: new Map(), light: new Map(), shared: new Map() }

for (const rule of rules) {
  const kinds = new Set()
  for (const sel of splitSelectorList(rule.selector)) {
    const kind = classifySelector(sel)
    if (kind) kinds.add(kind)
  }
  if (!kinds.size) continue
  const decls = parseDeclarations(rule.body)
  for (const kind of kinds) {
    for (const { prop, value } of decls) buckets[kind].set(prop, value)
  }
}

for (const theme of THEMES) {
  if (buckets[theme.type].size === 0) {
    fail(
      `no custom properties found for the "${theme.type}" theme block in ${CSS_FILE} — ` +
        `expected a selector carrying [data-theme="${theme.type}"]`
    )
  }
}

mkdirSync(OUT_DIR, { recursive: true })

let totalSkipped = 0

for (const theme of THEMES) {
  const map = buckets[theme.type]
  const colors = {}
  const syntax = {}
  const skipped = []

  for (const [prop, raw] of map) {
    const { value, error } = resolveValue(raw, map, buckets.shared)
    if (error) {
      skipped.push({ prop, raw, reason: `unresolved — ${error}` })
      continue
    }
    if (!isColor(value)) {
      const via = value === raw.trim() ? '' : ` (resolved to \`${value}\`)`
      skipped.push({ prop, raw, reason: `not a colour value${via}` })
      continue
    }
    if (prop.startsWith(SYNTAX_PREFIX)) syntax[prop.slice(SYNTAX_PREFIX.length)] = value
    else colors[prop.slice(2)] = value
  }

  const doc = { id: theme.id, name: theme.name, type: theme.type, colors, syntax }
  const file = join(OUT_DIR, `${theme.id}.json`)
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')

  console.log(
    `${theme.id}.json  ${Object.keys(colors).length} colour tokens, ` +
      `${Object.keys(syntax).length} syntax tokens  ->  resources/themes/${theme.id}.json`
  )
  if (skipped.length) {
    console.log(`  skipped ${skipped.length}:`)
    for (const s of skipped) console.log(`    ${s.prop}: ${s.raw}  —  ${s.reason}`)
  }
  totalSkipped += skipped.length
}

console.log(
  `\nShared (theme-independent) tokens ignored by design: ${buckets.shared.size}` +
    ` — they are identical in both themes, so they stay in theme.css only.`
)
console.log(`Total skipped inside theme blocks: ${totalSkipped}`)
