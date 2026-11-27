import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FALLBACK_TERM, parsePlist, parseThemeFile, themeIdFor } from '@shared/theme-file'
import { generateTheme } from '@shared/oklch'
import { CustomThemeSchema } from '../src/main/ux'

const fixture = readFileSync(join(__dirname, '..', 'e2e', 'fixtures', 'Harbor Night.itermcolors'), 'utf8')

describe('iTerm2 .itermcolors import', () => {
  it('reads the colours, names the theme after the file and fills what is missing from Hopline', () => {
    const d = parseThemeFile('/home/x/Harbor Night.itermcolors', fixture)
    expect(d.theme.label).toBe('Harbor Night')
    expect(d.theme.id).toBe('custom-harbor-night')
    expect(d.theme.mode).toBe('dark')
    // 0.07, 0.09, 0.12 → #12171f
    expect(d.theme.term.background).toBe('#12171f')
    expect(d.theme.term.red).toBe('#f26666')
    expect(d.theme.term.brightWhite).toBe(FALLBACK_TERM.dark.brightWhite)
    expect(d.notes.join(' ')).toMatch(/cursorAccent, selectionBackground, brightWhite/)
    // What it builds is something main will store.
    expect(() => CustomThemeSchema.parse(d.theme)).not.toThrow()
  })

  it('a light background reads as a light theme with the light fallbacks', () => {
    const light = fixture.replace('<real>0.07</real>', '<real>0.98</real>').replace('<real>0.09</real>', '<real>0.98</real>').replace('<real>0.12</real>', '<real>0.98</real>')
    const d = parseThemeFile('Paperish.itermcolors', light)
    expect(d.theme.mode).toBe('light')
    expect(d.theme.term.brightWhite).toBe(FALLBACK_TERM.light.brightWhite)
  })

  it('refuses entity declarations, internal DTD subsets and unknown entities', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;">]><plist><dict><key>&b;</key><string>x</string></dict></plist>`
    expect(() => parseThemeFile('x.itermcolors', bomb)).toThrow(/entities/)
    expect(() => parsePlist('<plist><dict><key>&xxe;</key><string>x</string></dict></plist>')).toThrow(/entity/)
    expect(() => parsePlist('<!DOCTYPE plist SYSTEM "file:///etc/passwd" [ ]><plist/>')).toThrow(/entities/)
  })

  it('refuses malformed files with a message, and files without colours', () => {
    expect(() => parseThemeFile('a.itermcolors', '<plist><dict><key>Background Color</key><dict>')).toThrow(/malformed/)
    expect(() => parseThemeFile('a.itermcolors', '<plist><dict><key>x</key><string>y</string></dict></plist>')).toThrow(/no colours/)
    expect(() => parseThemeFile('a.itermcolors', '<plist><foo/></plist>')).toThrow(/unknown element/)
    expect(() => parseThemeFile('a.itermcolors', '<plist><array><real>1e999x</real></array></plist>')).toThrow()
    // Out-of-range components are skipped, not wrapped.
    const bad = fixture.replace('<real>0.95</real>', '<real>7</real>')
    expect(parseThemeFile('a.itermcolors', bad).theme.term.red).toBe(FALLBACK_TERM.dark.red)
  })

  it('plist basics: arrays, booleans, character references, comments', () => {
    expect(parsePlist('<?xml version="1.0"?><!-- c --><plist><array><true/><false/><integer>3</integer><string>a &amp; b &#65;</string></array></plist>')).toEqual([true, false, 3, 'a & b A'])
  })
})

describe('Hopline theme JSON', () => {
  it('round-trips the export format (hoplineTheme: 1)', () => {
    const g = generateTheme({ base: '#1e3a5f', accent: '#5ec9b6', mode: 'dark' })
    const exported = JSON.stringify({ hoplineTheme: 1, id: 'custom-harbor', label: 'Harbor', mode: 'dark', term: g.term, ui: g.ui, source: { base: '#1e3a5f', accent: '#5ec9b6' } })
    const d = parseThemeFile('Harbor.hopline-theme.json', exported)
    expect(d.theme.label).toBe('Harbor')
    expect(d.theme.term).toEqual(g.term)
    expect(d.theme.ui).toEqual(g.ui)
    expect(() => CustomThemeSchema.parse(d.theme)).not.toThrow()
  })

  it('drops unknown UI keys, needs every terminal colour, explains non-JSON', () => {
    const g = generateTheme({ base: '#0d0e10', accent: '#5ec9b6', mode: 'dark' })
    const d = parseThemeFile('t.json', JSON.stringify({ term: g.term, ui: { ...g.ui, ok: '#000000', evil: 'url(x)' } }))
    expect(Object.keys(d.theme.ui!)).not.toContain('ok')
    expect(d.theme.label).toBe('t')
    expect(() => parseThemeFile('t.json', JSON.stringify({ term: { ...g.term, red: 'red' } }))).toThrow(/"red"/)
    expect(() => parseThemeFile('t.json', 'nope')).toThrow(/not valid JSON/)
    expect(() => parseThemeFile('t.json', '[1]')).toThrow(/not a Hopline theme/)
  })

  it('theme ids are prefixed and unique', () => {
    expect(themeIdFor('Nord!')).toBe('custom-nord')
    expect(themeIdFor('Nord', ['custom-nord', 'custom-nord-2'])).toBe('custom-nord-3')
    expect(themeIdFor('***')).toBe('custom-theme')
  })
})

describe('terminal palettes from network clients', () => {
  it('reads only the Colors section of a full MobaXterm profile', () => {
    const data = '[Bookmarks]\nRed=240,0,0\n' + 'x'.repeat(70000) + '\n[Colors]\nForegroundColour= 12, 35, 250\r\nBoldBlue=16,128,255\nRed=999,0,0\n[Passwords]\nBlue=0,0,1\n'
    const { theme } = parseThemeFile('Office.ini', data)
    expect(theme.term).toMatchObject({ foreground: '#0c23fa', brightBlue: '#1080ff', red: FALLBACK_TERM.dark.red, blue: FALLBACK_TERM.dark.blue })
    expect(() => parseThemeFile('Office.ini', '[Passwords]\nBlue=1,2,3')).toThrow(/Colors/)
  })
  it.each(['rtcp', 'termcolors'])('maps the Royal %s terminal palette, including its cursor and bright ANSI colours', (extension) => {
    const colors = [['background', '##FAFAFA'], ['cursorForeground', '#010203'], ['ansiBrightMagenta', '#AABBCC']].map(([terminalMapping, color]) => ({ terminalMapping, color }))
    const d = parseThemeFile('Export.' + extension, '\uFEFF' + JSON.stringify({ terminal: true, paletteName: 'Desk', colors }))
    expect(d.theme).toMatchObject({ label: 'Desk', mode: 'light', term: { background: '#fafafa', cursorAccent: '#010203', brightMagenta: '#aabbcc' } })
    expect(() => CustomThemeSchema.parse(d.theme)).not.toThrow()
  })
})
