// Release-folder helpers used by .github/workflows/release.yml and RELEASING.md.
// No dependencies, so they run on a bare runner without `npm ci`. The feed files
// are edited line by line, which keeps the layout electron-builder wrote.
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** electron-updater feeds: latest.yml, latest-mac.yml, latest-linux.yml, beta*.yml, alpha*.yml. */
const FEED = /^(latest|beta|alpha)(-[\w.-]+)?\.yml$/

function feeds(dir) {
  return readdirSync(dir).filter((f) => FEED.test(f)).sort()
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function hashFile(path, algo, encoding) {
  return new Promise((resolve, reject) => {
    const h = createHash(algo)
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => h.update(chunk))
      .on('end', () => resolve(h.digest(encoding)))
  })
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/, '$2')
}

/**
 * Set the staged-rollout share (`stagingPercentage`) in every feed.
 * 100 removes the key, so everyone is offered the update.
 * @param {string} dir release folder
 * @param {number|string} percent integer 0-100
 * @returns {string[]} the feed files written
 */
export function stage(dir, percent) {
  const n = typeof percent === 'string' && /^\s*\d+\s*$/.test(percent) ? Number(percent) : percent
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) {
    throw new Error(`staging percentage must be an integer 0-100, got ${JSON.stringify(percent)}`)
  }
  const names = feeds(dir)
  for (const name of names) {
    const path = join(dir, name)
    const kept = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !/^stagingPercentage:/.test(line))
      .join('\n')
      .replace(/\n*$/, '\n')
    writeFileSync(path, n === 100 ? kept : `${kept}stagingPercentage: ${n}\n`)
  }
  return names
}

/**
 * Recompute sha512 (base64) and size in every feed for files whose bytes no
 * longer match, for example after an external tool signed them. Block map sizes
 * are dropped: a block map made before signing describes the old bytes, and
 * without the key electron-updater does a full download instead of failing.
 * @param {string} dir release folder
 * @returns {Promise<string[]>} one "feed: file" entry per rewritten sha512
 */
export async function refreshFeeds(dir) {
  const changed = []
  const cache = new Map()
  const actual = async (url) => {
    if (!cache.has(url)) {
      const path = join(dir, url)
      cache.set(url, isFile(path) ? { sha512: await hashFile(path, 'sha512', 'base64'), size: statSync(path).size } : null)
    }
    return cache.get(url)
  }

  for (const name of feeds(dir)) {
    const path = join(dir, name)
    const lines = readFileSync(path, 'utf8').split('\n')
    const topPath = lines.map((l) => /^path:\s*(.+?)\s*$/.exec(l)).find(Boolean)?.[1]
    const out = []
    let entry = null // url of the current `files:` list item
    for (const line of lines) {
      if (/^\s*blockMapSize:/.test(line)) continue
      let m
      if ((m = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line))) {
        entry = unquote(m[1])
      } else if (/^\S/.test(line)) {
        entry = null // back at the top level
        if ((m = /^sha512:\s*(.+?)\s*$/.exec(line)) && topPath) {
          const a = await actual(unquote(topPath))
          if (a && unquote(m[1]) !== a.sha512) {
            changed.push(`${name}: ${unquote(topPath)}`)
            out.push(`sha512: ${a.sha512}`)
            continue
          }
        }
      } else if (entry && (m = /^(\s+)sha512:\s*(.+?)\s*$/.exec(line))) {
        const a = await actual(entry)
        if (a && unquote(m[2]) !== a.sha512) {
          changed.push(`${name}: ${entry}`)
          out.push(`${m[1]}sha512: ${a.sha512}`)
          continue
        }
      } else if (entry && (m = /^(\s+)size:\s*(\d+)\s*$/.exec(line))) {
        const a = await actual(entry)
        if (a && Number(m[2]) !== a.size) {
          out.push(`${m[1]}size: ${a.size}`)
          continue
        }
      }
      out.push(line)
    }
    writeFileSync(path, out.join('\n'))
  }
  return changed
}

/** Release artifacts: everything except feeds, checksums, signatures and dotfiles. */
function isArtifact(name) {
  return !(FEED.test(name) || name.endsWith('.sha256') || name.endsWith('.asc') || name === 'SHA256SUMS.txt' || name.startsWith('.'))
}

/**
 * Write a sha256sum-format `<file>.sha256` next to each artifact, and
 * SHA256SUMS.txt covering all of them (`sha256sum -c SHA256SUMS.txt` accepts it).
 * @param {string} dir release folder
 * @returns {Promise<string[]>} the SHA256SUMS.txt rows
 */
export async function checksums(dir) {
  const rows = []
  for (const name of readdirSync(dir).sort()) {
    if (!isArtifact(name) || !isFile(join(dir, name))) continue
    const row = `${await hashFile(join(dir, name), 'sha256', 'hex')}  ${name}`
    writeFileSync(join(dir, `${name}.sha256`), `${row}\n`)
    rows.push(row)
  }
  writeFileSync(join(dir, 'SHA256SUMS.txt'), rows.length ? `${rows.join('\n')}\n` : '')
  return rows
}
