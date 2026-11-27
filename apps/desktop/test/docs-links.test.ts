import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Relative links in the repository's Markdown (README, CONTRIBUTING, SECURITY, CHANGELOG, docs/)
 * must point at a file that exists, and a `#fragment` into a Markdown file at a heading it has.
 * External links (http, mailto, hopline://) are not fetched.
 */
const REPO = resolve(__dirname, '../../..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'release', 'test-results', 'research', 'results'])

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(f) ? [] : markdownFiles(p)
    return f.endsWith('.md') ? [p] : []
  })
}

const FILES = [...['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'RELEASING.md'].map((f) => join(REPO, f)).filter(existsSync), ...markdownFiles(join(REPO, 'docs'))]

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

function anchors(file: string): Set<string> {
  const out = new Set<string>()
  const counts = new Map<string, number>()
  let fence = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slug(m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    out.add(n ? `${base}-${n}` : base)
  }
  for (const m of readFileSync(file, 'utf8').matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) out.add(m[1]!)
  return out
}

/** [text](target) and ![alt](target) outside code spans and fenced blocks, plus <img src="…">. */
function links(file: string): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = []
  let fence = false
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) {
        fence = !fence
        return
      }
      if (fence) return
      const line = raw.replace(/`[^`]*`/g, '')
      for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1]!, line: i + 1 })
      for (const m of line.matchAll(/<img\s[^>]*src="([^"]+)"/g)) out.push({ target: m[1]!, line: i + 1 })
    })
  return out
}

describe('Markdown links', () => {
  it('scans the docs', () => {
    expect(FILES.length).toBeGreaterThan(10)
  })

  it('every relative link and anchor resolves', () => {
    const broken: string[] = []
    for (const file of FILES) {
      for (const { target, line } of links(file)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
        const [path, frag] = target.split('#') as [string, string | undefined]
        const dest = path ? resolve(dirname(file), decodeURIComponent(path)) : file
        const where = `${relative(REPO, file)}:${line} → ${target}`
        if (!existsSync(dest)) {
          broken.push(`${where} (no such file)`)
          continue
        }
        if (frag && dest.endsWith('.md') && !anchors(dest).has(frag.toLowerCase())) broken.push(`${where} (no heading #${frag})`)
      }
    }
    expect(broken).toEqual([])
  })
})
