import { describe, expect, it } from 'vitest'
import { deviceKeyFor, isShortcut } from '../src/renderer/src/lib/keys'

const ev = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  key,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods
})

describe('isShortcut', () => {
  it('matches Mod+letter as Ctrl+Shift on Win/Linux and Cmd on macOS', () => {
    expect(isShortcut(ev('W', 'KeyW', { ctrlKey: true, shiftKey: true }), 'Mod+W', false)).toBe(true)
    expect(isShortcut(ev('w', 'KeyW', { ctrlKey: true }), 'Mod+W', false)).toBe(false)
    expect(isShortcut(ev('w', 'KeyW', { metaKey: true }), 'Mod+W', true)).toBe(true)
    expect(isShortcut(ev('w', 'KeyW', { ctrlKey: true, shiftKey: true }), 'Mod+W', true)).toBe(false)
  })

  it('Mod+O (quick connect) is Ctrl+Shift+O / Cmd+O and never plain Ctrl+O, which belongs to the device', () => {
    expect(isShortcut(ev('O', 'KeyO', { ctrlKey: true, shiftKey: true }), 'Mod+O', false)).toBe(true)
    expect(isShortcut(ev('o', 'KeyO', { metaKey: true }), 'Mod+O', true)).toBe(true)
    expect(isShortcut(ev('o', 'KeyO', { ctrlKey: true }), 'Mod+O', false)).toBe(false)
    expect(isShortcut(ev('o', 'KeyO', { ctrlKey: true }), 'Mod+O', true)).toBe(false)
    expect(isShortcut(ev('O', 'KeyO', { ctrlKey: true, shiftKey: true, altKey: true }), 'Mod+O', false)).toBe(false)
  })

  it('matches letters by physical key whatever e.key says (Windows IME, Caps Lock, other layouts)', () => {
    const mod = { ctrlKey: true, shiftKey: true }
    expect(isShortcut(ev('Process', 'KeyO', mod), 'Mod+O', false)).toBe(true) // Windows IME
    expect(isShortcut(ev('Щ', 'KeyO', mod), 'Mod+O', false)).toBe(true) // Russian layout
    expect(isShortcut(ev('\x0f', 'KeyO', mod), 'Mod+O', false)).toBe(true) // control character
    expect(isShortcut(ev('o', 'KeyP', mod), 'Mod+O', false)).toBe(false) // another physical key
    expect(isShortcut(ev('o', '', mod), 'Mod+O', false)).toBe(true) // no code: fall back to e.key
  })

  it('matches Mod+, on Win/Linux although Shift+, gives "<"', () => {
    expect(isShortcut(ev('<', 'Comma', { ctrlKey: true, shiftKey: true }), 'Mod+,', false)).toBe(true)
    expect(isShortcut(ev(',', 'Comma', { metaKey: true }), 'Mod+,', true)).toBe(true)
    expect(isShortcut(ev('<', 'Comma', { ctrlKey: true }), 'Mod+,', false)).toBe(false)
  })

  it('matches other punctuation by physical key', () => {
    expect(isShortcut(ev('?', 'Slash', { ctrlKey: true, shiftKey: true }), 'Mod+/', false)).toBe(true)
    expect(isShortcut(ev('}', 'BracketRight', { ctrlKey: true, shiftKey: true }), 'Mod+]', false)).toBe(true)
    expect(isShortcut(ev('+', 'Equal', { ctrlKey: true, shiftKey: true }), 'Mod+=', false)).toBe(true)
    // A shifted character on another key does not count as the unshifted one.
    expect(isShortcut(ev('<', 'IntlBackslash', { ctrlKey: true, shiftKey: true }), 'Mod+,', false)).toBe(false)
  })

  it('keeps plain Ctrl+] and Ctrl+\\ for the device', () => {
    expect(isShortcut(ev(']', 'BracketRight', { ctrlKey: true }), 'Mod+]', false)).toBe(false)
    expect(isShortcut(ev('\\', 'Backslash', { ctrlKey: true }), 'Mod+\\', false)).toBe(false)
  })

  it('matches digits and named keys', () => {
    expect(isShortcut(ev('Enter', 'Enter', { ctrlKey: true, shiftKey: true }), 'Mod+Enter', false)).toBe(true)
    expect(isShortcut(ev('F', 'KeyF', { ctrlKey: true, shiftKey: true, altKey: true }), 'Mod+Alt+F', false)).toBe(true)
    expect(isShortcut(ev('F', 'KeyF', { ctrlKey: true, shiftKey: true }), 'Mod+Alt+F', false)).toBe(false)
  })
})

describe('deviceKeyFor', () => {
  it('sends Ctrl+^ (0x1E) for Ctrl+Shift+6', () => {
    expect(deviceKeyFor(ev('^', 'Digit6', { ctrlKey: true, shiftKey: true }))).toBe('\x1e')
    // Some layouts report "6" or "&" as the key: the physical key decides.
    expect(deviceKeyFor(ev('6', 'Digit6', { ctrlKey: true, shiftKey: true }))).toBe('\x1e')
  })

  it('leaves everything else to xterm', () => {
    expect(deviceKeyFor(ev('6', 'Digit6', { ctrlKey: true }))).toBeUndefined()
    expect(deviceKeyFor(ev('^', 'Digit6', { shiftKey: true }))).toBeUndefined()
    expect(deviceKeyFor(ev('^', 'Digit6', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeUndefined()
    expect(deviceKeyFor(ev('C', 'KeyC', { ctrlKey: true, shiftKey: true }))).toBeUndefined()
  })
})
