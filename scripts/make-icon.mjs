/**
 * Generates the application icon from code, so it is reproducible and versioned
 * as source rather than an opaque binary.
 *
 * Writes build/icon.png (512) for electron-builder and build/icon.ico (256,
 * PNG-compressed entry) for Windows. No image dependencies — the PNG encoder
 * below is ~40 lines of zlib + CRC.
 *
 * Run: npm run icon
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

/* ------------------------------------------------------------ PNG encoding */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng (rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8            // bit depth
  ihdr[9] = 6            // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  // one filter byte (0 = none) per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const src = y * size * 4
    const dst = y * (size * 4 + 1)
    raw[dst] = 0
    rgba.copy(raw, dst + 1, src, src + size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ----------------------------------------------------------------- drawing */

const BG = [0x16, 0x18, 0x1d]      // --bg, dark theme
const PLATE = [0x1f, 0x23, 0x2c]   // a touch above --bg-elevated for contrast
const ACCENT = [0x6f, 0x8f, 0xe8]  // --accent
const INK = [0xe4, 0xe6, 0xeb]     // --fg

/**
 * Inside-test for a rounded rectangle: the distance from the point to the
 * rectangle inset by r must not exceed r. Straight edges give a zero component
 * on one axis; only the corners actually measure against the radius.
 */
function inRoundRect (x, y, rx, ry, w, h, r) {
  const dx = Math.max(rx + r - x, 0, x - (rx + w - r))
  const dy = Math.max(ry + r - y, 0, y - (ry + h - r))
  return dx * dx + dy * dy <= r * r
}

/**
 * A "forme" is the block of type locked up ready to print: a plate with an
 * accent rule down its left edge and four set lines. Reads as text at 16px.
 */
function shade (x, y, S) {
  const r = S * 0.215
  if (!inRoundRect(x, y, 0, 0, S, S, r)) return null

  const pad = S * 0.17
  const pw = S - pad * 2
  const plateTop = S * 0.20
  const plateH = S * 0.60

  if (!inRoundRect(x, y, pad, plateTop, pw, plateH, S * 0.045)) return BG

  // accent rule down the left edge of the plate
  if (x < pad + S * 0.055) return ACCENT

  // four set lines
  const lines = [0.00, 0.28, 0.56, 0.84]
  const widths = [0.74, 0.92, 0.60, 0.82]
  const lineH = S * 0.075
  const inner = pad + S * 0.115
  const avail = pw - (inner - pad) - S * 0.085

  for (let i = 0; i < 4; i++) {
    const top = plateTop + S * 0.085 + lines[i] * (plateH - S * 0.24)
    if (y >= top && y < top + lineH && x >= inner && x < inner + avail * widths[i]) {
      return i === 0 ? ACCENT : INK
    }
  }
  return PLATE
}

function render (size) {
  const SS = 4 // supersample factor for antialiasing
  const out = Buffer.alloc(size * size * 4)
  const S = size * SS

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(x * SS + sx + 0.5, y * SS + sy + 0.5, S)
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255 }
        }
      }
      const n = SS * SS
      const i = (y * size + x) * 4
      // premultiply-free average; transparent samples contribute no colour
      const opaque = a / 255
      out[i] = opaque ? Math.round(r / opaque) : 0
      out[i + 1] = opaque ? Math.round(g / opaque) : 0
      out[i + 2] = opaque ? Math.round(b / opaque) : 0
      out[i + 3] = Math.round(a / n)
    }
  }
  return out
}

/* -------------------------------------------------------------------- main */

mkdirSync('build', { recursive: true })

const png512 = encodePng(render(512), 512)
writeFileSync('build/icon.png', png512)

const png256 = encodePng(render(256), 256)
// ICO with a single PNG-compressed 256x256 entry (Vista+).
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry[0] = 0 // 0 means 256
entry[1] = 0
entry[2] = 0
entry[3] = 0
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(png256.length, 8)
entry.writeUInt32LE(22, 12)
writeFileSync('build/icon.ico', Buffer.concat([header, entry, png256]))

console.log('build/icon.png', png512.length, 'bytes (512x512)')
console.log('build/icon.ico', 22 + png256.length, 'bytes (256x256 PNG entry)')
