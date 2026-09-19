/**
 * Recompute the CSP sha256 for the inline pre-paint theme script in index.html.
 *
 * This edits ONLY the `content="..."` attribute of the Content-Security-Policy
 * meta tag. An earlier version matched `script-src 'self'` anywhere in the file,
 * which happily rewrote the prose inside an HTML comment and produced a nested,
 * unterminated comment that swallowed the rest of the head. Hence the narrow
 * anchor below — do not loosen it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const FILE = 'src/renderer/index.html'
const html = readFileSync(FILE, 'utf8')

const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`)

if (!hashes.length) {
  console.log('No inline scripts found; nothing to do.')
  process.exit(0)
}

const META = /(<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=")([^"]*)(")/i
const match = html.match(META)

if (!match) {
  console.error(`No Content-Security-Policy meta tag found in ${FILE}.`)
  process.exit(1)
}

const policy = match[2]
if (!/script-src\s+'self'/.test(policy)) {
  console.error("CSP has no `script-src 'self'` directive to update.")
  process.exit(1)
}

const nextPolicy = policy.replace(/script-src\s+'self'[^;]*/, `script-src 'self' ${hashes.join(' ')}`)

if (nextPolicy === policy) {
  console.log('CSP already up to date:', hashes.join(' '))
  process.exit(0)
}

writeFileSync(FILE, html.replace(META, `$1${nextPolicy}$3`))
console.log('CSP updated:', hashes.join(' '))
