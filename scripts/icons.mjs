#!/usr/bin/env node
// Render apps/desktop/build/icon.svg into every icon the packages need, and commit the results
// (the Windows local build must not need a generation step):
//   build/icon.png            1024 px (electron-builder's source; also the Linux fallback)
//   build/icons/NxN.png       16…1024 px (Linux hicolor set: AppImage, deb, rpm)
//   build/icon.ico            16, 24, 32, 48, 64, 128, 256 px, PNG-compressed entries (Windows)
//   build/icon.icns           16…1024 px incl. @2x, PNG entries (macOS)
// Usage: npm run icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(root, 'apps/desktop/build')
const svg = readFileSync(join(build, 'icon.svg'), 'utf8')

const render = (size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng())
const cache = new Map()
const png = (size) => (cache.has(size) ? cache.get(size) : (cache.set(size, render(size)), cache.get(size)))

mkdirSync(join(build, 'icons'), { recursive: true })
writeFileSync(join(build, 'icon.png'), png(1024))
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) writeFileSync(join(build, 'icons', `${s}x${s}.png`), png(s))

// ICO: ICONDIR + one ICONDIRENTRY per image, each image a whole PNG (Vista and later).
function ico(sizes) {
  const images = sizes.map(png)
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i
    head.writeUInt8(s >= 256 ? 0 : s, e)
    head.writeUInt8(s >= 256 ? 0 : s, e + 1)
    head.writeUInt8(0, e + 2)
    head.writeUInt8(0, e + 3)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(images[i].length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += images[i].length
  })
  return Buffer.concat([head, ...images])
}
writeFileSync(join(build, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))

// ICNS: 'icns' + total length, then (type, length incl. 8-byte header, PNG data) chunks.
function icns(entries) {
  const chunks = entries.map(([type, size]) => {
    const data = png(size)
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([h, data])
  })
  const body = Buffer.concat(chunks)
  const h = Buffer.alloc(8)
  h.write('icns', 0, 'ascii')
  h.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([h, body])
}
writeFileSync(
  join(build, 'icon.icns'),
  icns([
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512]
  ])
)
console.log('icons written to', build)
