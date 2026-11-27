import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDeepLink, resolveTarget, searchSettings, settingDef, SETTINGS, SETTINGS_SECTIONS, SETTINGS_TABS } from '@shared/settings-registry'

const renderer = join(__dirname, '..', 'src', 'renderer', 'src')
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const rel = (file: string) => relative(renderer, file).split(sep).join('/')

describe('settings registry: search, openSettings and deep links read one list', () => {
  const files = sources(renderer)
  const keysInSource = new Set(files.flatMap((f) => [...code(f).matchAll(/\b(?:k|data-setting-key)="([A-Za-z0-9]+)"/g)].map((m) => m[1]!)))

  it('every registry row exists in the Settings dialog, and every keyed row is in the registry', () => {
    const listed = new Set(SETTINGS.map((s) => s.key))
    expect([...listed].filter((k) => !keysInSource.has(k))).toEqual([])
    expect([...keysInSource].filter((k) => !listed.has(k))).toEqual([])
  })

  it('keys are unique and every section belongs to a tab', () => {
    expect(new Set(SETTINGS.map((s) => s.key)).size).toBe(SETTINGS.length)
    const tabs = new Set(SETTINGS_TABS.map(([id]) => id))
    for (const s of Object.values(SETTINGS_SECTIONS)) expect(tabs.has(s.tab)).toBe(true)
  })

  it('search matches labels first, then sections and keywords; every word must match', () => {
    expect(searchSettings('keep')[0]!.def.key).toBe('keepAliveSec')
    // A keyword finds it (SecureCRT calls it anti-idle).
    expect(searchSettings('anti-idle').map((h) => h.def.key)).toContain('keepAliveSec')
    // "theme" hits both themes; the label matches outrank keyword-only ones.
    const theme = searchSettings('theme').map((h) => h.def.key)
    expect(theme.slice(0, 2).sort()).toEqual(['termTheme', 'theme'])
    expect(searchSettings('log folder')[0]!.def.key).toBe('logDir')
    expect(searchSettings('notification').map((h) => h.def.key).sort()).toEqual(['notifyApprovals', 'notifyDisconnects'])
    expect(searchSettings('itermcolors')[0]!.def.key).toBe('themeImport')
    expect(searchSettings('zzzz nothing')).toEqual([])
    expect(searchSettings('   ')).toEqual([])
    // Accents and case do not matter.
    expect(searchSettings('KÉEP')[0]!.def.key).toBe('keepAliveSec')
  })

  it('openSettings targets: a key, a section, a tab, section/key; unknown opens General', () => {
    expect(resolveTarget('keepAliveSec')).toEqual({ tab: 'connections', section: 'connections', key: 'keepAliveSec' })
    expect(resolveTarget('notifications')).toEqual({ tab: 'general', section: 'notifications' })
    expect(resolveTarget('security')).toEqual({ tab: 'security', section: 'security' })
    expect(resolveTarget('credentials')).toEqual({ tab: 'credentials', section: 'credentials', key: 'credentials' })
    expect(resolveTarget('themes/fontPreview')).toEqual({ tab: 'themes', section: 'themes', key: 'fontPreview' })
    // A key under the wrong section lands on the section only.
    expect(resolveTarget('themes/keepAliveSec')).toEqual({ tab: 'themes', section: 'themes' })
    expect(resolveTarget('nope')).toEqual({ tab: 'general' })
    expect(resolveTarget(undefined)).toEqual({ tab: 'general' })
    expect(settingDef('aiReadOnly')?.section).toBe('assistant')
  })

  it('deep links: only hopline://settings[/section[/key]] with registry names; anything else is refused', () => {
    expect(parseDeepLink('hopline://settings')).toEqual({ kind: 'settings' })
    expect(parseDeepLink('hopline://settings/')).toEqual({ kind: 'settings' })
    expect(parseDeepLink('hopline://settings/terminal/termFontSize')).toEqual({ kind: 'settings', section: 'terminal', key: 'termFontSize' })
    expect(parseDeepLink('hopline://settings/notifications')).toEqual({ kind: 'settings', section: 'notifications' })
    // Unknown key: the section only. Unknown section: refused.
    expect(parseDeepLink('hopline://settings/terminal/apiKey')).toEqual({ kind: 'settings', section: 'terminal' })
    expect(parseDeepLink('hopline://settings/evil/x')).toBeNull()
    for (const bad of ['hopline://connect/10.0.0.1', 'hopline://settings/terminal/termFontSize?x=1', 'hopline://settings/../../etc', 'https://settings/terminal', 'hopline://settings/terminal/termFont%53ize', 'hopline://settings/__proto__', 'hopline://settings/constructor', `hopline://settings/terminal/${'a'.repeat(300)}`])
      expect(parseDeepLink(bad)).toBeNull()
    expect(parseDeepLink(42 as unknown as string)).toBeNull()
  })

  it('Settings opens only through openSettings (lib/settings-nav.ts), so every link lands on its row', () => {
    const hits = files.filter((f) => rel(f) !== 'lib/settings-nav.ts' && /settingsOpen:\s*true/.test(code(f))).map(rel)
    expect(hits).toEqual([])
    const events = files.filter((f) => /hopline:settings-tab/.test(code(f))).map(rel)
    expect(events).toEqual([])
  })
})
