/**
 * Tiny debounce / throttle helpers. No dependencies.
 */

/**
 * Returns a debounced wrapper around `fn`.
 * The wrapper exposes `.cancel()` and `.flush()`.
 *
 * @param {Function} fn
 * @param {number} wait milliseconds
 */
export function debounce(fn, wait = 150) {
  let timer = null
  let lastArgs = null
  let lastThis = null

  function invoke() {
    timer = null
    const args = lastArgs
    const ctx = lastThis
    lastArgs = null
    lastThis = null
    if (args) fn.apply(ctx, args)
  }

  function debounced(...args) {
    lastArgs = args
    lastThis = this
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(invoke, wait)
  }

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastArgs = null
    lastThis = null
  }

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      invoke()
    }
  }

  debounced.pending = () => timer !== null

  return debounced
}

/**
 * Coalesces calls into at most one per animation frame.
 * The wrapper exposes `.cancel()`.
 *
 * @param {Function} fn
 */
export function rafThrottle(fn) {
  let handle = 0
  let lastArgs = null
  let lastThis = null

  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16)
  const caf =
    typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout

  function throttled(...args) {
    lastArgs = args
    lastThis = this
    if (handle) return
    handle = raf(() => {
      handle = 0
      const a = lastArgs
      const c = lastThis
      lastArgs = null
      lastThis = null
      if (a) fn.apply(c, a)
    })
  }

  throttled.cancel = () => {
    if (handle) caf(handle)
    handle = 0
    lastArgs = null
    lastThis = null
  }

  return throttled
}
