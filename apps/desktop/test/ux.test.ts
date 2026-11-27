import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effectiveLogToFile, effectiveSettings, folderChain, OVERRIDE_KEYS, pruneOverrides, resolveOverrides, type OverrideStore } from '@shared/ux'
import { UxStore } from '../src/main/ux'
import { Notifier, type DesktopNote } from '../src/main/notify'
import { toastId } from '../src/renderer/src/lib/notify'

const folders = [
  { id: 'dc', name: 'DC', parentId: null },
  { id: 'core', name: 'Core', parentId: 'dc' },
  { id: 'edge', name: 'Edge', parentId: 'dc' }
]
const sw = { id: 's1', name: 'core-sw1', folderId: 'core' }

describe('per-host overrides: inherited down the folder tree, the nearest scope wins', () => {
  const store: OverrideStore = {
    folders: { dc: { keepAliveSec: 10, termFontSize: 15, logToFile: true }, core: { termFontSize: 17, termTheme: 'nord' } },
    sessions: { s1: { termTheme: 'paper' } }
  }

  it('walks top folder → nearer folder → the session itself, and says where each value comes from', () => {
    const r = resolveOverrides(store, folders, { session: sw })
    expect(r.values).toEqual({ keepAliveSec: 10, termFontSize: 17, logToFile: true, termTheme: 'paper' })
    expect(r.origin.keepAliveSec).toEqual({ scope: 'folder', id: 'dc', name: 'DC' })
    expect(r.origin.termFontSize).toEqual({ scope: 'folder', id: 'core', name: 'Core' })
    expect(r.origin.termTheme).toEqual({ scope: 'session', id: 's1', name: 'core-sw1' })
  })

  it('inheritedOnly: what a session gets from its folders, what a folder gets from its parents', () => {
    expect(resolveOverrides(store, folders, { session: sw }, { inheritedOnly: true }).values).toEqual({ keepAliveSec: 10, termFontSize: 17, logToFile: true, termTheme: 'nord' })
    expect(resolveOverrides(store, folders, { session: null, folderId: 'core' }, { inheritedOnly: true }).values).toEqual({ keepAliveSec: 10, termFontSize: 15, logToFile: true })
    expect(resolveOverrides(store, folders, { session: null, folderId: 'edge' }).values).toEqual({ keepAliveSec: 10, termFontSize: 15, logToFile: true })
  })

  it('a session at the top level or in an unknown folder gets nothing; a folder loop stops the walk', () => {
    expect(resolveOverrides(store, folders, { session: { ...sw, folderId: null } }).values).toEqual({ termTheme: 'paper' })
    expect(resolveOverrides(store, folders, { session: { ...sw, folderId: 'gone' } }).values).toEqual({ termTheme: 'paper' })
    const loop = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' }
    ]
    expect(folderChain(loop, 'a').map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('ignores keys that are not overridable (a hand-edited store cannot override read-only mode)', () => {
    const evil = { folders: { dc: { aiReadOnly: false, egressLog: false, keepAliveSec: 5 } as never }, sessions: {} }
    expect(resolveOverrides(evil, folders, { session: sw }).values).toEqual({ keepAliveSec: 5 })
    expect(OVERRIDE_KEYS).not.toContain('aiReadOnly')
  })

  it('effective settings: overrides on top of the globals; logging can only be added by a folder', () => {
    const g = { keepAliveSec: 30, termFontSize: 13, aiReadOnly: true }
    expect(effectiveSettings(g, { keepAliveSec: 5, logToFile: true })).toEqual({ keepAliveSec: 5, termFontSize: 13, aiReadOnly: true })
    expect(effectiveLogToFile({ logToFile: false }, { logToFile: true })).toBe(true)
    expect(effectiveLogToFile({ logToFile: true }, { logToFile: false })).toBe(true)
    expect(effectiveLogToFile({ logToFile: false }, {})).toBe(false)
  })

  it('prune drops deleted sessions and folders and empty entries', () => {
    const p = pruneOverrides({ folders: { dc: { keepAliveSec: 1 }, gone: { keepAliveSec: 2 }, core: {} }, sessions: { s1: { termTheme: 'nord' }, s9: { termTheme: 'nord' } } }, { sessions: ['s1'], folders: ['dc', 'core'] })
    expect(p).toEqual({ folders: { dc: { keepAliveSec: 1 } }, sessions: { s1: { termTheme: 'nord' } } })
  })
})

describe('UxStore: each piece under its own key, validated on write, defaults on a bad read', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { m, repo: { getSetting: (k: string) => m.get(k), setSetting: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)) } }
  }

  it('round-trips onboarding, overrides and themes, never touching prefs', () => {
    const { m, repo } = mem()
    const s = new UxStore(repo)
    expect(s.onboarding()).toEqual({ stepsDone: false, done: {}, checklistDismissed: false })
    s.setOnboarding({ stepsDone: true, done: { connect: 1 }, checklistDismissed: false })
    expect(s.onboarding().done).toEqual({ connect: 1 })
    s.setOverrides({ folders: { dc: { keepAliveSec: 10 } }, sessions: {} })
    expect(s.overrides().folders['dc']).toEqual({ keepAliveSec: 10 })
    expect(m.has('prefs')).toBe(false)
    expect([...m.keys()].sort()).toEqual(['ux.hostOverrides', 'ux.onboarding'])
  })

  it('refuses non-overridable keys, out-of-range values, bad theme ids and duplicate themes', () => {
    const s = new UxStore(mem().repo)
    expect(() => s.setOverrides({ folders: { dc: { aiReadOnly: false } as never }, sessions: {} })).toThrow()
    expect(() => s.setOverrides({ folders: { dc: { keepAliveSec: 99999 } }, sessions: {} })).toThrow()
    expect(() => s.setOverrides({ folders: {}, sessions: { s: { termFontFamily: 'x; } body { color: red' } } })).toThrow()
    const term = Object.fromEntries(['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map((k) => [k, '#112233']))
    const t = { id: 'custom-a', label: 'A', mode: 'dark' as const, term: term as never }
    expect(s.setThemes([t])).toHaveLength(1)
    // Built-in ids can never be shadowed: custom ids carry the prefix.
    expect(() => s.setThemes([{ ...t, id: 'nord' }])).toThrow()
    expect(() => s.setThemes([t, t])).toThrow(/same id/)
    expect(() => s.setThemes([{ ...t, term: { ...term, red: 'red' } as never }])).toThrow()
  })

  it('reads a corrupt or hand-edited value as the default', () => {
    const { m, repo } = mem()
    m.set('ux.onboarding', '{not json')
    m.set('ux.hostOverrides', JSON.stringify({ folders: { dc: { aiReadOnly: false } }, sessions: {} }))
    const s = new UxStore(repo)
    expect(s.onboarding().stepsDone).toBe(false)
    expect(s.overrides()).toEqual({ folders: {}, sessions: {} })
  })
})

describe('desktop notifications: approvals waiting and unexpected disconnects only', () => {
  const make = (opts: { approvals?: boolean; disconnects?: boolean; focused?: boolean } = {}) => {
    const shown: DesktopNote[] = []
    let t = 0
    let revealed = 0
    const n = new Notifier({
      settings: () => ({ notifyApprovals: opts.approvals ?? true, notifyDisconnects: opts.disconnects ?? true }),
      focused: () => opts.focused ?? false,
      show: (note, onClick) => (shown.push(note), onClick()),
      reveal: () => void revealed++,
      now: () => t
    })
    return { n, shown, tick: (ms: number) => (t += ms), revealed: () => revealed }
  }

  it('an approval notifies once per proposal; a click only reveals the window', () => {
    const { n, shown, revealed } = make()
    expect(n.approval('p1', 'core-sw1', 3, false)).toBe(true)
    expect(n.approval('p1', 'core-sw1', 3, false)).toBe(false)
    expect(shown[0]).toEqual({ kind: 'approval', title: 'Approval waiting · core-sw1', body: 'A change of 3 lines waits for your approval in Hopline.' })
    expect(n.approval('p2', 'core-sw1', 1, true)).toBe(true)
    expect(shown[1]!.body).toMatch(/^A disruptive change/)
    expect(revealed()).toBe(2)
  })

  it('a dropped session notifies once a minute per session, with the reason', () => {
    const { n, shown, tick } = make()
    expect(n.disconnect('s1', 'core-sw1', 'Connection reset; retry in 2s', true)).toBe(true)
    expect(shown[0]!.body).toBe('Connection reset. Reconnecting…')
    expect(n.disconnect('s1', 'core-sw1', 'again', true)).toBe(false)
    expect(n.disconnect('s2', 'dist-eos1', undefined, false)).toBe(true)
    expect(shown[1]!.body).toBe('Press Enter in the tab to reconnect.')
    tick(61_000)
    expect(n.disconnect('s1', 'core-sw1', 'again', false)).toBe(true)
  })

  it('opt-out per kind, and nothing while a Hopline window has focus', () => {
    expect(make({ approvals: false }).n.approval('p', 'x', 1, false)).toBe(false)
    expect(make({ disconnects: false }).n.disconnect('s', 'x', '', false)).toBe(false)
    const f = make({ focused: true })
    expect(f.n.approval('p', 'x', 1, false)).toBe(false)
    expect(f.n.disconnect('s', 'x', '', false)).toBe(false)
  })
})

describe('toast discipline', () => {
  it('the same message maps to one id (sonner refreshes it instead of stacking a copy)', () => {
    expect(toastId('error', 'Could not connect', 'timeout')).toBe(toastId('error', 'Could not connect', 'timeout'))
    expect(toastId('error', 'Could not connect', 'timeout')).not.toBe(toastId('error', 'Could not connect', 'refused'))
    expect(toastId('success', 'Saved')).not.toBe(toastId('error', 'Saved'))
    expect(toastId('default', { type: 'span' })).toBeUndefined()
  })

  it('only lib/notify.ts (and the Toaster in main.tsx) import sonner', () => {
    const root = join(__dirname, '..', 'src', 'renderer', 'src')
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []))
    const hits = walk(root)
      .filter((f) => /from 'sonner'/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split(sep).join('/'))
    expect(hits.sort()).toEqual(['lib/notify.ts', 'main.tsx'])
  })
})
