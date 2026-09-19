import { screen } from 'electron'
import { getSettings, saveSettings } from './settings.js'

export const DEFAULT_WIDTH = 1100
export const DEFAULT_HEIGHT = 780
export const MIN_WIDTH = 640
export const MIN_HEIGHT = 420

/**
 * Turn the persisted window record into bounds that are guaranteed to land on a
 * display that actually exists right now (monitors get unplugged, resolutions change).
 */
export function restoreWindowState() {
  const saved = getSettings().window || {}

  let width = clampNumber(saved.width, MIN_WIDTH, DEFAULT_WIDTH)
  let height = clampNumber(saved.height, MIN_HEIGHT, DEFAULT_HEIGHT)
  let x = Number.isFinite(saved.x) ? Math.round(saved.x) : undefined
  let y = Number.isFinite(saved.y) ? Math.round(saved.y) : undefined

  const hasPosition = x !== undefined && y !== undefined
  // getDisplayMatching picks the display with the largest overlap, falling back to
  // the nearest one, which is exactly the "snap back on screen" behaviour we want.
  const display = hasPosition
    ? screen.getDisplayMatching({ x, y, width, height })
    : screen.getPrimaryDisplay()
  const area = display.workArea

  width = Math.min(width, area.width)
  height = Math.min(height, area.height)

  if (hasPosition) {
    x = Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width))
    y = Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height))
  } else {
    x = undefined
    y = undefined
  }

  return {
    width,
    height,
    x,
    y,
    maximized: !!saved.maximized
  }
}

function clampNumber(value, min, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.round(n))
}

/** Capture the window's *restored* geometry, plus whether it is currently maximized. */
export function captureWindowState(win) {
  if (!win || win.isDestroyed()) return null
  const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
  return {
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    maximized: win.isMaximized()
  }
}

/** Persist geometry on resize/move (debounced) and once more on close. */
export function trackWindowState(win) {
  let timer = null

  const persist = () => {
    const state = captureWindowState(win)
    if (state) saveSettings({ window: state })
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      persist()
    }, 400)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)

  win.on('close', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    persist()
  })
}
