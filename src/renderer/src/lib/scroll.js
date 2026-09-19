/**
 * Scroll-fraction helpers shared by all three modes (used by the split view's
 * synchronised scrolling).
 */

/**
 * Current scroll position of `el` as a fraction in [0, 1].
 * Returns 0 when the content is not taller than the viewport.
 *
 * @param {HTMLElement|null} el
 * @returns {number}
 */
export function scrollFractionOf(el) {
  if (!el) return 0
  const max = el.scrollHeight - el.clientHeight
  if (max <= 1) return 0
  const f = el.scrollTop / max
  if (!Number.isFinite(f)) return 0
  return Math.min(1, Math.max(0, f))
}

/**
 * Scroll `el` to a fraction in [0, 1]. Idempotent: a value that resolves to the
 * current scrollTop is a no-op, so no scroll event is emitted.
 *
 * @param {HTMLElement|null} el
 * @param {number} fraction
 */
export function setScrollFractionOf(el, fraction) {
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  if (max <= 1) return
  const f = Number(fraction)
  if (!Number.isFinite(f)) return
  const target = Math.round(Math.min(1, Math.max(0, f)) * max)
  if (Math.abs(el.scrollTop - target) < 1) return
  el.scrollTop = target
}
