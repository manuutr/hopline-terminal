import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bindingProblem, comboFromEvent, findConflicts, physicalId, reservedReason } from '../src/renderer/src/lib/keymap'
import { parsePalette } from '../src/renderer/src/lib/palette-mode'

type Mods = Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>>
const ev = (key: string, code: string, mods: Mods = {}) => ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent

describe('keymap: normalising combos', () => {
  it('Mod means Ctrl+Shift on Windows/Linux and ⌘ on macOS', () => {
    expect(physicalId('Mod+K', false)).toBe(physicalId('Ctrl+Shift+K', false))
    expect(physicalId('Mod+K', true)).toBe('Meta+K')
    expect(physicalId('Mod+K', true)).not.toBe(physicalId('Ctrl+Shift+K', true))
    expect(physicalId('mod+k', false)).toBe('Ctrl+Shift+K')
  })

  it('records by physical key, in the app\'s Mod form', () => {
    // Ctrl+Shift+K on a Cyrillic layout: e.key is "Л", e.code is KeyK.
    expect(comboFromEvent(ev('Л', 'KeyK', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+K')
    expect(comboFromEvent(ev('?', 'Slash', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+/')
    expect(comboFromEvent(ev('k', 'KeyK', { metaKey: true }), true)).toBe('Mod+K')
    expect(comboFromEvent(ev('K', 'KeyK', { ctrlKey: true, altKey: true }), false)).toBe('Ctrl+Alt+K')
    expect(comboFromEvent(ev('F5', 'F5'), false)).toBe('F5')
    expect(comboFromEvent(ev('ArrowLeft', 'ArrowLeft', { ctrlKey: true, altKey: true }), false)).toBe('Ctrl+Alt+ArrowLeft')
    // Modifiers alone are not a combo yet.
    expect(comboFromEvent(ev('Control', 'ControlLeft', { ctrlKey: true }), false)).toBeNull()
    expect(comboFromEvent(ev('Shift', 'ShiftLeft', { shiftKey: true, ctrlKey: true }), false)).toBeNull()
  })
})

describe('keymap: reserved keys belong to the device', () => {
  const reserved = ['Ctrl+C', 'Ctrl+Z', 'Ctrl+D', 'Ctrl+R', 'Ctrl+A', 'Ctrl+W', 'Tab', 'Shift+Tab', 'Ctrl+Shift+6', 'Ctrl+]', 'Ctrl+\\', 'Ctrl+Space', 'Alt+B', 'Alt+F', 'A', 'Shift+A', 'Enter', 'Escape', 'ArrowUp', '?', 'Mod+C', 'Mod+V']
  it.each(reserved)('%s is refused on Windows/Linux', (k) => {
    expect(reservedReason(k, false)).toBeTruthy()
  })
  it('Mod+6 is Ctrl+Shift+6 (Cisco break) on Windows/Linux, but free as ⌘6 on macOS', () => {
    expect(reservedReason('Mod+6', false)).toMatch(/Cisco break/)
    expect(reservedReason('Mod+6', true)).toBeNull()
  })
  it('Ctrl+letter stays the device\'s on macOS too; ⌘C/⌘V/⌘Q are taken', () => {
    expect(reservedReason('Ctrl+C', true)).toBeTruthy()
    expect(reservedReason('Mod+C', true)).toMatch(/Copy/)
    expect(reservedReason('Mod+Q', true)).toMatch(/quits/)
  })
  it.each(['Mod+K', 'Mod+J', 'Ctrl+Alt+K', 'Mod+Alt+F', 'F6', 'Shift+F6', 'Ctrl+Alt+ArrowLeft', 'Mod+1'])('%s may be bound', (k) => {
    expect(reservedReason(k, false)).toBeNull()
  })
})

describe('keymap: conflicts', () => {
  const owners = [
    { id: 'palette.open', title: 'Command palette', keys: ['Mod+K'] },
    { id: 'pane.splitRight', title: 'Split right', keys: ['Mod+D'] }
  ]
  it('refuses a combo another action uses, however it is written', () => {
    expect(bindingProblem('Ctrl+Shift+K', 'pane.splitRight', owners, false)).toMatch(/Command palette/)
    expect(bindingProblem('Mod+K', 'pane.splitRight', owners, false)).toMatch(/Command palette/)
  })
  it('allows re-binding an action to its own key and to a free key', () => {
    expect(bindingProblem('Mod+D', 'pane.splitRight', owners, false)).toBeNull()
    expect(bindingProblem('Mod+J', 'pane.splitRight', owners, false)).toBeNull()
  })
  it('says why a reserved key is refused', () => {
    expect(bindingProblem('Ctrl+C', 'pane.splitRight', owners, false)).toMatch(/device CLI.*can't be a shortcut/)
  })
  it('lists keys two actions answer to (an update can add a default a user binding took), however written', () => {
    expect(findConflicts(owners, false)).toEqual([])
    const clash = [...owners, { id: 'new.thing', title: 'New thing', keys: ['Ctrl+Shift+K', 'Ctrl+Shift+K'] }]
    expect(findConflicts(clash, false)).toEqual([{ combo: 'Ctrl+Shift+K', owners: [{ id: 'palette.open', title: 'Command palette' }, { id: 'new.thing', title: 'New thing' }] }])
    // On macOS Mod is ⌘, so Ctrl+Shift+K no longer clashes with Mod+K.
    expect(findConflicts(clash, true)).toEqual([])
  })
})

describe('palette prefixes', () => {
  it.each([
    ['> split', 'commands', 'split'],
    ['@core', 'sessions', 'core'],
    ['#lab', 'groups', 'lab'],
    ['?', 'help', ''],
    ['!vlan', 'snippets', 'vlan'],
    ['core-sw1', 'all', 'core-sw1'],
    ['admin@10.0.0.1', 'all', 'admin@10.0.0.1']
  ])('%s → %s', (input, mode, query) => {
    expect(parsePalette(input)).toEqual({ mode, query })
  })
})

describe('action registry: dispatch', () => {
  const mod: Mods = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true, shiftKey: true }
  let actions: typeof import('../src/renderer/src/lib/actions')
  let modal = false
  beforeAll(async () => {
    ;(globalThis as { document?: unknown }).document = { querySelector: () => (modal ? {} : null) }
    actions = await import('../src/renderer/src/lib/actions')
  })
  afterEach(() => {
    modal = false
    actions.useKeymap.setState({ overrides: {} })
  })
  const press = (key: string, code: string, mods: Mods = {}, extra: Partial<KeyboardEvent> = {}) => {
    let prevented = false
    const e = { ...ev(key, code, mods), repeat: false, target: null, preventDefault: () => void (prevented = true), stopPropagation: () => {}, ...extra } as unknown as KeyboardEvent
    return { handled: actions.dispatchKey(e), prevented: () => prevented }
  }

  it('runs the bound action, honours overrides, and lets unbound keys through', () => {
    const hits: string[] = []
    const off = actions.registerActions([
      { id: 't.a', title: 'A', category: 'App', keys: ['Mod+J'], run: () => hits.push('a') },
      { id: 't.b', title: 'B', category: 'App', keys: ['Mod+L'], when: () => false, run: () => hits.push('b') }
    ])
    try {
      expect(press('J', 'KeyJ', mod).handled).toBe(true)
      // Plain Ctrl+J is the device's: untouched.
      expect(press('j', 'KeyJ', { ctrlKey: true }).handled).toBe(false)
      // Unavailable: not handled, not swallowed.
      const b = press('L', 'KeyL', mod)
      expect(b.handled).toBe(false)
      expect(b.prevented()).toBe(false)
      actions.useKeymap.setState({ overrides: { 't.a': ['Ctrl+Alt+J'] } })
      expect(press('J', 'KeyJ', mod).handled).toBe(false)
      expect(press('j', 'KeyJ', { ctrlKey: true, altKey: true }).handled).toBe(true)
      expect(hits).toEqual(['a', 'a'])
    } finally {
      off()
    }
  })

  it('ignores held-key repeats on toggles, and only dialog toggles work behind a modal', () => {
    let n = 0
    let own = false
    const off = actions.registerActions([{ id: 't.t', title: 'T', category: 'App', keys: ['Mod+J'], noRepeat: true, whileModal: () => own, run: () => void n++ }])
    try {
      const r = press('J', 'KeyJ', mod, { repeat: true })
      expect(r.handled).toBe(true)
      expect(n).toBe(0)
      modal = true
      expect(press('J', 'KeyJ', mod).handled).toBe(false)
      own = true
      expect(press('J', 'KeyJ', mod).handled).toBe(true)
      expect(n).toBe(1)
    } finally {
      off()
    }
  })

  it('does nothing while the keymap editor records a combo', () => {
    let n = 0
    const off = actions.registerActions([{ id: 't.r', title: 'R', category: 'App', keys: ['Mod+J'], run: () => void n++ }])
    actions.setRecording(true)
    try {
      expect(press('J', 'KeyJ', mod).handled).toBe(false)
      expect(n).toBe(0)
    } finally {
      actions.setRecording(false)
      off()
    }
  })
})
