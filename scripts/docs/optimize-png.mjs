#!/usr/bin/env node
/**
 * Shrink screenshots for the docs: 1440 px wide, at most 300 KB each.
 *
 * Each PNG is first re-encoded losslessly at maximum compression (UI captures at 1440x900 land at
 * 30-290 KB). Only a file still over 300 KB is quantised to a 256-colour palette without
 * dithering. Quantising everything was tried and rejected: median cut drops colours that cover few
 * pixels, and those are exactly the safety colours (a 6 px amber guard dot came out red).
 *
 *   node scripts/docs/optimize-png.mjs [inDir] [outDir]
 *
 * Defaults: inDir = $HOPLINE_GUIDE_RAW or <tmp>/hopline-guide-raw (what
 * apps/desktop/e2e/capture/guide.capture.shots.ts writes), outDir = docs/guide/img.
 * Files whose name starts with "_" (failed capture steps) are skipped.
 *
 * Encoder, first that works: $FFMPEG, the `ffmpeg-static` package if installed, `ffmpeg` on PATH
 * (palettegen + paletteuse, dither=none), else python3 with Pillow (fast octree, no dither).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const inDir = resolve(process.argv[2] ?? process.env['HOPLINE_GUIDE_RAW'] ?? join(tmpdir(), 'hopline-guide-raw'))
const outDir = resolve(process.argv[3] ?? join(root, 'docs/guide/img'))
const WIDTH = 1440
const LIMIT = 300 * 1024

const works = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function findFfmpeg() {
  const candidates = [process.env['FFMPEG']]
  try {
    candidates.push(createRequire(join(root, 'package.json'))('ffmpeg-static'))
  } catch {
    /* not installed */
  }
  candidates.push('ffmpeg')
  return candidates.find((c) => c && works(c, ['-version']))
}

const PIL = `
import sys
from PIL import Image
src, dst, width, quantise = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == '1'
im = Image.open(src).convert('RGB')
if im.width != width:
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
if quantise:
    im = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
im.save(dst, optimize=True)
`

const ffmpeg = findFfmpeg()
const usePil = !ffmpeg && works('python3', ['-I', '-c', 'import PIL'])
if (!ffmpeg && !usePil) {
  console.error('Need ffmpeg (on PATH, $FFMPEG or ffmpeg-static) or python3 with Pillow')
  process.exit(1)
}
console.log(`encoder: ${ffmpeg ? `ffmpeg (${ffmpeg})` : 'python3 Pillow'}`)
mkdirSync(outDir, { recursive: true })

const files = readdirSync(inDir).filter((f) => f.endsWith('.png') && !f.startsWith('_') && !f.startsWith('.'))
if (!files.length) {
  console.error(`no PNGs in ${inDir}`)
  process.exit(1)
}
let over = 0
for (const f of files.sort()) {
  const src = join(inDir, f)
  const dst = join(outDir, f)
  const tmp = join(outDir, `.${f}.tmp.png`)
  const encode = (quantise) => {
    if (ffmpeg) {
      // Scale to the doc width (a no-op for 1440 captures); when quantising, build a palette from
      // this image and map it without dithering, so glyph edges stay solid.
      const scale = `scale=${WIDTH}:-1:flags=lanczos`
      const graph = quantise ? `${scale},split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none` : scale
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', src, '-filter_complex', graph, '-frames:v', '1', '-compression_level', '100', '-pred', 'mixed', tmp])
    } else {
      execFileSync('python3', ['-I', '-c', PIL, src, tmp, String(WIDTH), quantise ? '1' : '0'])
    }
  }
  encode(false)
  let quantised = false
  if (statSync(tmp).size > LIMIT) {
    encode(true)
    quantised = true
  }
  renameSync(tmp, dst)
  const size = statSync(dst).size
  if (size > LIMIT) over++
  console.log(`${(size / 1024).toFixed(0).padStart(5)} KB  ${f}${quantised ? '  (quantised)' : ''}${size > LIMIT ? '  (over 300 KB)' : ''}`)
}
console.log(`${files.length} images -> ${outDir}${over ? `, ${over} over 300 KB` : ''}`)
