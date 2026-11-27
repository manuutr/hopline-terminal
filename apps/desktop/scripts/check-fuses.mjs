// Reads the fuses of a packaged Hopline binary and fails unless they match scripts/fuses.cjs.
//   node scripts/check-fuses.mjs <path to hopline / hopline.exe / Hopline.app> <linux|win32|darwin>
// Used by the release workflow after packaging, and by RELEASING.md for local builds.
import { createRequire } from 'node:module'
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses'

const require = createRequire(import.meta.url)
const { fuseValues } = require('./fuses.cjs')

const [bin, platform] = process.argv.slice(2)
if (!bin || !platform) {
  console.error('usage: check-fuses.mjs <binary> <linux|win32|darwin>')
  process.exit(2)
}
const wire = await getCurrentFuseWire(bin)
// FuseState: 0x30 '0' disabled, 0x31 '1' enabled, 0x72 'r' removed, 0x90 inherit.
const state = (v) => (v === 0x31 || v === '1' || v === 49 ? true : v === 0x30 || v === '0' || v === 48 ? false : String(v))
let bad = 0
for (const [name, want] of Object.entries(fuseValues(platform))) {
  const got = state(wire[FuseV1Options[name]])
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got} (want ${want})`)
}
if (bad) {
  console.error(`${bad} fuse(s) wrong in ${bin}`)
  process.exit(1)
}
