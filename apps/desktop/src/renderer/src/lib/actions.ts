/**
 * The action registry: one list of everything the user can do, with its title, icon and keys. It
 * drives the command palette (`>`), the shortcut dispatcher, the shortcut sheet, tooltips and menu
 * hints, and the keymap editor in Settings. Features register their own actions.
 */
import type { LucideIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { inTerminal, isShortcut, modalOpen } from './keys'
import { physicalId, withoutReserved } from './keymap'

export type ActionCategory = 'Sessions' | 'Tabs and panes' | 'View' | 'Terminal' | 'Assistant' | 'Automation' | 'App'
export const CATEGORY_ORDER: ActionCategory[] = ['Sessions', 'Tabs and panes', 'Terminal', 'Automation', 'Assistant', 'View', 'App']

export interface Action {
  id: string
  title: string | (() => string)
  category: ActionCategory
  icon?: LucideIcon
  /** Extra words the palette matches on. */
  keywords?: string
  /** Default keys, rebindable in Settings → Keyboard. The first is the one shown in hints. */
  keys?: string[]
  /** Fixed alternates that are not shown or rebindable (Ctrl+K, which only works outside the terminal). */
  extraKeys?: { combo: string; outsideTerminal?: boolean }[]
  /** Keys can't be changed (tab jumps, Ctrl+Tab, copy and paste). */
  fixed?: boolean
  /** Another handler owns the keys (Ctrl+Tab hold-to-cycle, terminal copy/paste): the dispatcher skips them. */
  external?: boolean
  /** Shown in the palette (default true when the action can run). */
  palette?: boolean
  /** Extra condition for listing it in the palette (the key may still work without it). */
  paletteWhen?: () => boolean
  /** Available now (palette shows it, keys fire). */
  when?: () => boolean
  /** Ignore auto-repeat of a held key (open/close/open…). */
  noRepeat?: boolean
  /** Fires even while a modal is open: a dialog's own toggle (Mod+K closes the palette). */
  whileModal?: () => boolean
  /**
   * How it shows in the menu bar and context menus (shared/menu.ts). `label` has an `&` before the
   * mnemonic; without one the title is used. `checked` makes it a checkbox (or a radio).
   */
  menu?: MenuMeta
  /** `arg`: the session or tab a menu entry was built for (Open recent, the Window menu's tab list). */
  run: (e?: KeyboardEvent, arg?: string) => void
}

export interface MenuMeta {
  label?: string
  /** A key shown but not bound here (Ctrl+Z in a text field is the field's own). */
  hint?: string
  kind?: 'checkbox' | 'radio'
  checked?: () => boolean
}

const registry = new Map<string, Action>()
let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version++
  for (const l of listeners) l()
}

/** Add actions (replacing any with the same id). Returns a function that removes them. */
export function registerActions(list: Action[]): () => void {
  for (const a of list) registry.set(a.id, a)
  bump()
  return () => {
    for (const a of list) if (registry.get(a.id) === a) registry.delete(a.id)
    bump()
  }
}

export const allActions = (): Action[] => [...registry.values()]
export const getAction = (id: string): Action | undefined => registry.get(id)
export const titleOf = (a: Action): string => (typeof a.title === 'function' ? a.title() : a.title)
export const available = (a: Action): boolean => !a.when || a.when()
/** Listed in the palette right now. */
const menuMeta = new Map<string, MenuMeta>()
/** Menu labels and checkbox state for actions defined elsewhere (features/menu/actions.ts). */
export function setMenuMeta(m: Record<string, MenuMeta>): void {
  for (const [k, v] of Object.entries(m)) menuMeta.set(k, v)
  bump()
}
export const menuOf = (a: Action): MenuMeta | undefined => a.menu ?? menuMeta.get(a.id)
/** The label a menu shows (with its `&` mnemonic). */
export const menuLabelOf = (a: Action): string => menuOf(a)?.label ?? titleOf(a).replace(/&/g, '&&')
export const inPalette = (a: Action): boolean => a.palette !== false && available(a) && (!a.paletteWhen || a.paletteWhen())

/** Called when actions are registered or removed, or their menu labels change. */
export function subscribeActions(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Re-render when actions are registered or removed. */
export function useActionsVersion(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version
  )
}

// ---------------------------------------------------------------- keymap (user overrides)

export type Keymap = Record<string, string[]>

interface KeymapState {
  overrides: Keymap
  loaded: boolean
  load: () => Promise<void>
  /** Set an action's keys ([] removes them; undefined restores the default). Saved in main. */
  setKeys: (id: string, keys: string[] | undefined) => Promise<void>
  reset: () => Promise<void>
}

export const useKeymap = create<KeymapState>((set, get) => ({
  overrides: {},
  loaded: false,
  load: async () => {
    const km = await window.hopline?.keymap?.get().catch(() => ({}))
    // Main already drops reserved combos; again here, so nothing that arrives can bind them (L10).
    set({ overrides: withoutReserved(km ?? {}), loaded: true })
  },
  setKeys: async (id, keys) => {
    const next = { ...get().overrides }
    const a = registry.get(id)
    if (keys === undefined || (a && same(keys, a.keys ?? []))) delete next[id]
    else next[id] = keys
    set({ overrides: next })
    await window.hopline.keymap.set(next)
  },
  reset: async () => {
    set({ overrides: {} })
    await window.hopline.keymap.set({})
  }
}))

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => physicalId(x) === physicalId(b[i]!))

/** An action's current keys: the user's, else the defaults. */
export function keysOf(a: Action, overrides: Keymap = useKeymap.getState().overrides): string[] {
  if (a.fixed) return a.keys ?? []
  return overrides[a.id] ?? a.keys ?? []
}

/** The first key of an action, for hints ("Split right  Ctrl+Shift+D"). Reactive. */
export function useShortcut(id: string): string | undefined {
  useActionsVersion()
  const overrides = useKeymap((s) => s.overrides)
  const a = registry.get(id)
  return a ? keysOf(a, overrides)[0] : undefined
}

/** Every action's keys, for conflict checks and the shortcut sheet. */
export function bindingOwners(overrides: Keymap = useKeymap.getState().overrides): { id: string; title: string; keys: string[] }[] {
  return allActions().map((a) => ({ id: a.id, title: titleOf(a), keys: [...keysOf(a, overrides), ...(a.extraKeys ?? []).map((k) => k.combo)] }))
}

// ---------------------------------------------------------------- dispatch

let recording = false
/** The keymap editor is recording a combo: no shortcut fires meanwhile. */
export function setRecording(on: boolean): void {
  recording = on
}

/** The action a keydown is bound to, if any (pure lookup; `available` is not checked). */
export function actionFor(e: KeyboardEvent): Action | undefined {
  const overrides = useKeymap.getState().overrides
  for (const a of registry.values()) {
    if (a.external) continue
    if (keysOf(a, overrides).some((k) => isShortcut(e, k))) return a
    if (a.extraKeys?.some((k) => (!k.outsideTerminal || !inTerminal(e)) && isShortcut(e, k.combo))) return a
  }
  return undefined
}

/**
 * AltGr typing a character (@ { [ \ | € on many layouts; Windows reports it as Ctrl+Alt) is text
 * for the device or a field such as the approval card's hostname, never a shortcut, even when a
 * Ctrl+Alt binding matches its physical key. A plain Ctrl+Alt+K (the key's own letter) still is.
 */
export function altGrText(e: Pick<KeyboardEvent, 'key' | 'code'> & { getModifierState?: (k: string) => boolean }): boolean {
  if (e.key.length !== 1 || !e.getModifierState?.('AltGraph')) return false
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1]
  if (letter && e.key.toUpperCase() === letter) return false
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1]
  if (digit && e.key === digit) return false
  return true
}

/**
 * The app's one keydown handler (capture phase, so keys bound to the app never reach xterm).
 * Unbound keys, including everything reserved for the device, pass through untouched.
 */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (recording) return false
  if (altGrText(e)) return false
  const a = actionFor(e)
  if (!a) return false
  if (e.repeat && a.noRepeat) {
    e.preventDefault()
    e.stopPropagation()
    return true
  }
  // Behind a modal dialog only the dialog's own toggles work; e.g. Mod+W must not close the pane
  // behind a host-key prompt.
  if (modalOpen() && !a.whileModal?.()) return false
  if (!available(a)) return false
  e.preventDefault()
  e.stopPropagation()
  a.run(e)
  return true
}

/**
 * Run an action from a menu (the menu bar, the macOS menu, a context menu, the dock): the same
 * gate as a key press. Behind a modal dialog only the dialog's own toggles run, an action that is
 * not available now does nothing, and the keymap editor's recording blocks everything. Read-only
 * mode and approvals are enforced where they always are (the action's own code and main), so a
 * menu can't reach anything the palette or a key can't.
 */
export function runAction(id: string, arg?: string): boolean {
  if (recording) return false
  const a = registry.get(id)
  if (!a) return false
  if (modalOpen() && !a.whileModal?.()) return false
  if (!available(a)) return false
  a.run(undefined, arg)
  return true
}

/** A getter for many actions' first keys in one component (call once, at the top). Reactive. */
export function useShortcutMap(): (id: string) => string | undefined {
  useActionsVersion()
  const overrides = useKeymap((s) => s.overrides)
  return (id) => {
    const a = registry.get(id)
    return a ? keysOf(a, overrides)[0] : undefined
  }
}
