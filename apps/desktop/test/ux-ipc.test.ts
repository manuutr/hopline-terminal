import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uxHandlers, type UxPickers } from '../src/main/ipc/ux'
import { UxStore } from '../src/main/ux'
import { errorText } from '../src/renderer/src/lib/errors'
import { TERM_COLOR_KEYS } from '@shared/ux'

const mem = () => {
  const m = new Map<string, string>()
  return new UxStore({ getSetting: (k: string) => m.get(k), setSetting: (k: string, v: string | null) => void (v === null ? m.delete(k) : m.set(k, v)) })
}
const lab = { start: async () => ({ running: true, sessionIds: [], folderId: 'f', ports: {} }) as never, info: () => ({ running: false }) as never }
const call = async (h: ReturnType<typeof uxHandlers>, ch: string, arg?: unknown) => h[ch]!.fn(h[ch]!.schema.parse(arg) as never, { sender: {} } as never)

const term = Object.fromEntries(TERM_COLOR_KEYS.map((k) => [k, '#123456']))
const theme = { id: 'custom-harbor', label: 'Harbor / night', mode: 'dark', term }

describe('ux IPC: main picks and reads the file; a renderer never names a path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-ux-'))
  const pickers = (open: string | null, save: string | null = null): UxPickers => ({ openTheme: async () => open, saveTheme: async () => save })

  it('import: cancelled is null, too large is refused, a bad file explains itself, a good one is parsed but not saved', async () => {
    const store = mem()
    expect(await call(uxHandlers(store, lab, pickers(null)), 'ux:themes:import')).toBeNull()

    const big = join(dir, 'big.json')
    writeFileSync(big, 'x'.repeat(256 * 1024 + 1))
    await expect(call(uxHandlers(store, lab, pickers(big)), 'ux:themes:import')).rejects.toThrow(/too large/)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, 'not json at all')
    await expect(call(uxHandlers(store, lab, pickers(bad)), 'ux:themes:import')).rejects.toThrow()

    const ok = join(dir, 'ok.json')
    writeFileSync(ok, JSON.stringify({ hoplineTheme: 1, ...theme }))
    const parsed = (await call(uxHandlers(store, lab, pickers(ok)), 'ux:themes:import')) as { theme?: { label: string } }
    expect(JSON.stringify(parsed)).toContain('Harbor / night')
    // Nothing is kept until the user keeps it.
    expect(store.themes()).toEqual([])
  })

  it('export writes JSON that reads back, under a safe default name; cancel writes nothing', async () => {
    let asked = ''
    const out = join(dir, 'out.json')
    const h = uxHandlers(mem(), lab, { openTheme: async () => null, saveTheme: async (n) => ((asked = n), out) })
    expect(await call(h, 'ux:themes:export', theme)).toBe(true)
    expect(asked).toBe('Harbor-night.hopline-theme.json')
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ hoplineTheme: 1, id: 'custom-harbor', term: { background: '#123456' } })
    expect(await call(uxHandlers(mem(), lab, pickers(null, null)), 'ux:themes:export', theme)).toBe(false)
  })

  it('every write is validated: a bad theme, an unknown override key or a bad onboarding shape is refused', async () => {
    const h = uxHandlers(mem(), lab, pickers(null))
    expect(() => h['ux:themes:set']!.schema.parse([{ ...theme, id: 'hopline' }])).toThrow()
    expect(() => h['ux:themes:export']!.schema.parse({ ...theme, term: { ...term, background: 'red' } })).toThrow()
    // aiReadOnly is never a per-host setting.
    expect(() => h['ux:overrides:set']!.schema.parse({ folders: { f: { aiReadOnly: false } }, sessions: {} })).toThrow()
    expect(() => h['ux:onboarding:set']!.schema.parse({ stepsDone: 'yes' })).toThrow()
    await call(h, 'ux:overrides:set', { folders: { f: { termFontSize: 16 } }, sessions: {} })
    expect(await call(h, 'ux:overrides:get')).toEqual({ folders: { f: { termFontSize: 16 } }, sessions: {} })
  })
})

describe('errorText', () => {
  it("strips Electron's IPC prefix and keeps plain values", () => {
    expect(errorText(new Error("Error invoking remote method 'audit:list': Error: database is locked"))).toBe('database is locked')
    expect(errorText(new Error('plain'))).toBe('plain')
    expect(errorText('text')).toBe('text')
  })
})
