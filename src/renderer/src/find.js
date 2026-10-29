/**
 * Find / replace bar for the views that have no find UI of their own (Rich and
 * Read). Source and the source side of Split use CodeMirror's search panel.
 *
 * The bar only drives a target; the target owns matching and highlighting:
 *
 *   target.search(query, { caseSensitive }) -> { count, current }
 *   target.searchStep(dir)                  -> { count, current }   dir = 1 | -1
 *   target.replaceMatch(text)               -> { count, current }   editable only
 *   target.replaceAll(text)                 -> number replaced       editable only
 *   target.clearSearch()
 *
 * `current` is a 0-based index, -1 when there is no match.
 */

/**
 * Lower-case one UTF-16 unit at a time, keeping any unit whose lower-case form
 * has a different length (e.g. 'İ'), so offsets into the folded string stay
 * offsets into the original.
 */
export function foldCase(text) {
  return text.replace(/[\s\S]/g, (c) => {
    const l = c.toLowerCase()
    return l.length === c.length ? l : c
  })
}

/** Start offsets of every non-overlapping occurrence of `query` in `text`. */
export function findOffsets(text, query, caseSensitive) {
  const out = []
  if (!query) return out
  const hay = caseSensitive ? text : foldCase(text)
  const needle = caseSensitive ? query : foldCase(query)
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    out.push(i)
  }
  return out
}

/**
 * @param {HTMLElement} bar  the #find-bar element from index.html
 * @param {{ getTarget: () => any, onClose?: () => void }} opts
 */
export function createFindBar(bar, opts) {
  const findInput = bar.querySelector('.find-input')
  const replaceInput = bar.querySelector('.replace-input')
  const count = bar.querySelector('.find-count')
  const caseBtn = bar.querySelector('[data-act="case"]')
  const replaceRow = bar.querySelector('.find-replace-row')

  let target = null
  let caseSensitive = false

  function paint(info) {
    const n = info?.count || 0
    if (!findInput.value) count.textContent = ''
    else count.textContent = n ? `${(info.current ?? -1) + 1} of ${n}` : 'No results'
    bar.classList.toggle('no-results', !!findInput.value && !n)
  }

  function run() {
    if (!target) return
    paint(target.search(findInput.value, { caseSensitive }))
  }

  function step(dir) {
    if (!target || !findInput.value) return
    paint(target.searchStep(dir))
  }

  function replaceOne() {
    if (!target?.editable || !findInput.value) return
    paint(target.replaceMatch(replaceInput.value))
  }

  function replaceEvery() {
    if (!target?.editable || !findInput.value) return
    target.replaceAll(replaceInput.value)
    run()
  }

  function isOpen() {
    return !bar.hidden
  }

  /** Hide the bar and drop its highlights. `refocus` puts the caret back in the view. */
  function close(refocus = true) {
    if (!isOpen()) return
    bar.hidden = true
    try {
      target?.clearSearch?.()
    } catch {
      /* the view may already be torn down */
    }
    const was = target
    target = null
    if (refocus) was?.focus?.()
    opts.onClose?.()
  }

  /** Open (or re-focus) the bar for the current view. */
  function open({ replace = false } = {}) {
    const next = opts.getTarget()
    if (!next || typeof next.search !== 'function') return false
    if (target && target !== next) close(false)
    target = next

    const wasOpen = isOpen()
    const canReplace = replace && target.editable !== false
    // Once shown, the replace row stays until the bar closes (as in VS Code).
    if (!wasOpen || canReplace) replaceRow.hidden = !canReplace
    if (target.editable === false) replaceRow.hidden = true

    // Seed the query with a short single-line selection, like most editors.
    // Not while the bar has focus: that selection is the query itself.
    const sel = bar.contains(document.activeElement) ? '' : String(window.getSelection?.() || '')
    const seeded = !!sel && sel.length < 200 && !/\n/.test(sel)
    if (seeded) findInput.value = sel

    bar.hidden = false
    // Jump to the replacement only when the query is one the user just chose.
    const focusReplace = canReplace && findInput.value && (seeded || wasOpen)
    const field = focusReplace ? replaceInput : findInput
    field.focus()
    field.select()
    run()
    return true
  }

  findInput.addEventListener('input', run)

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  })

  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.ctrlKey && e.altKey) replaceEvery()
      else replaceOne()
    }
  })

  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.altKey && (e.key === 'c' || e.code === 'KeyC')) {
      e.preventDefault()
      caseBtn.click()
    }
  })

  caseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive
    caseBtn.setAttribute('aria-pressed', String(caseSensitive))
    run()
  })

  bar.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-act]')?.dataset.act
    if (act === 'prev') step(-1)
    else if (act === 'next') step(1)
    else if (act === 'replace') replaceOne()
    else if (act === 'all') replaceEvery()
    else if (act === 'close') close()
  })

  return { open, close, isOpen }
}
