import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source guards for the renderer. Native browser dialogs open as their own OS window (ignoring the
 * off-screen test mode) and look nothing like the app; the system clipboard is the user's and is
 * shared with Windows under WSLg. Both go through in-app replacements: lib/confirm.tsx,
 * lib/prompt.tsx and lib/clipboard.ts.
 */
const root = join(__dirname, '..', 'src', 'renderer', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Source without line and block comments, so docs that name the banned calls don't trip the guard. */
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const rel = (file: string) => relative(root, file).split(sep).join('/')

describe('renderer source guards', () => {
  const files = sources(root)

  it('finds the renderer sources', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('never uses window.alert / confirm / prompt', () => {
    const hits = files.filter((f) => /(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/m.test(code(f))).map(rel)
    expect(hits).toEqual([])
  })

  it('touches the clipboard only through lib/clipboard.ts', () => {
    const hits = files.filter((f) => rel(f) !== 'lib/clipboard.ts' && /navigator\.clipboard/.test(code(f))).map(rel)
    expect(hits).toEqual([])
  })
})
