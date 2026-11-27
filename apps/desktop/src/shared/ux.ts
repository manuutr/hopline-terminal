/**
 * Phase 6 per-machine UX state, each under its own key in the settings table (never in `prefs`:
 * General → Save writes every field of `prefs`, and a change there resets an open form):
 *
 * - `onboarding`: the first-run steps and the getting-started checklist.
 * - `hostOverrides`: per-session and per-folder overrides of display and connection settings,
 *   inherited down the folder tree.
 * - `customThemes`: themes built with the theme generator or imported.
 *
 * Like the keymap, these stay on this machine: they are not in the encrypted export or folder sync.
 */
import type { Folder, Session, Settings } from './types'

// ------------------------------------------------------------------ onboarding

export const CHECKLIST_ITEMS = ['connect', 'palette', 'assistant', 'multi'] as const
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number]

export interface OnboardingState {
  /** The three first-run steps were finished or skipped. They never come back by themselves. */
  stepsDone: boolean
  /** Checklist items the user has done, with when. */
  done: Partial<Record<ChecklistItem, number>>
  /** The checklist was closed. It reopens only from the palette or Settings. */
  checklistDismissed: boolean
}

export const ONBOARDING_DEFAULT: OnboardingState = { stepsDone: false, done: {}, checklistDismissed: false }

// ------------------------------------------------------------------ per-host overrides

/**
 * Settings a session or folder may override. Display and connection settings only: never
 * read-only mode, the egress log, budgets or anything a team policy can lock.
 */
export const OVERRIDE_KEYS = ['termTheme', 'termFontFamily', 'termFontSize', 'termLineHeight', 'termCursorStyle', 'termHighlight', 'termAutocomplete', 'keepAliveSec', 'autoReconnect', 'logToFile'] as const
export type OverrideKey = (typeof OVERRIDE_KEYS)[number]

export type HostOverrides = Partial<Pick<Settings, Exclude<OverrideKey, 'logToFile'>> & { logToFile: boolean }>

export interface OverrideStore {
  folders: Record<string, HostOverrides>
  sessions: Record<string, HostOverrides>
}

export const OVERRIDES_DEFAULT: OverrideStore = { folders: {}, sessions: {} }

export interface OverrideOrigin {
  scope: 'folder' | 'session'
  id: string
  name: string
}

export interface ResolvedOverrides {
  values: HostOverrides
  /** Where each overridden value comes from (the nearest scope that sets it). */
  origin: Partial<Record<OverrideKey, OverrideOrigin>>
}

/** Folders from the top of the tree down to `folderId` (a loop in the data stops the walk). */
export function folderChain(folders: readonly Pick<Folder, 'id' | 'parentId' | 'name'>[], folderId: string | null): Pick<Folder, 'id' | 'parentId' | 'name'>[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const chain: Pick<Folder, 'id' | 'parentId' | 'name'>[] = []
  const seen = new Set<string>()
  for (let id = folderId; id && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
    seen.add(id)
    const f = byId.get(id)
    if (!f) break
    chain.unshift(f)
  }
  return chain
}

const clean = (o: HostOverrides | undefined): HostOverrides => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => (OVERRIDE_KEYS as readonly string[]).includes(k) && v !== undefined && v !== null)) as HostOverrides

/**
 * The overrides that apply to a session (or, with `session` null, to a folder's contents): top
 * folder first, each nearer folder on top, the session's own last. `stopAt` resolves only what a
 * scope inherits (the folder's parents, or a session's folders), for "inherited from …" hints.
 */
export function resolveOverrides(
  store: OverrideStore,
  folders: readonly Pick<Folder, 'id' | 'parentId' | 'name'>[],
  target: { session: Pick<Session, 'id' | 'name' | 'folderId'> | null; folderId?: string | null },
  opts: { inheritedOnly?: boolean } = {}
): ResolvedOverrides {
  const folderId = target.session ? target.session.folderId : (target.folderId ?? null)
  let chain = folderChain(folders, folderId)
  if (opts.inheritedOnly && !target.session) chain = chain.slice(0, -1)
  const values: HostOverrides = {}
  const origin: ResolvedOverrides['origin'] = {}
  const apply = (o: HostOverrides, from: OverrideOrigin) => {
    for (const [k, v] of Object.entries(clean(o)) as [OverrideKey, never][]) {
      ;(values as Record<string, unknown>)[k] = v
      origin[k] = from
    }
  }
  for (const f of chain) apply(store.folders[f.id] ?? {}, { scope: 'folder', id: f.id, name: f.name })
  if (target.session && !opts.inheritedOnly) apply(store.sessions[target.session.id] ?? {}, { scope: 'session', id: target.session.id, name: target.session.name })
  return { values, origin }
}

/** Settings as a session sees them: the global value unless an override sets it. */
export function effectiveSettings<S extends Partial<Settings>>(settings: S, o: HostOverrides): S {
  const { logToFile: _l, ...rest } = o
  void _l
  return { ...settings, ...rest }
}

/**
 * Log to file: the session's own switch (in the session dialog), or a folder that turns logging on
 * for everything below it. Nothing below turns it off again: a folder can only add logging, so a
 * session that logs keeps logging wherever it is moved.
 */
export const effectiveLogToFile = (session: Pick<Session, 'logToFile'>, o: HostOverrides): boolean => session.logToFile || o.logToFile === true

/** Drop overrides of sessions and folders that no longer exist. */
export function pruneOverrides(store: OverrideStore, live: { sessions: Iterable<string>; folders: Iterable<string> }): OverrideStore {
  const s = new Set(live.sessions)
  const f = new Set(live.folders)
  const keep = (m: Record<string, HostOverrides>, ids: Set<string>) => Object.fromEntries(Object.entries(m).filter(([id, o]) => ids.has(id) && Object.keys(clean(o)).length > 0))
  return { sessions: keep(store.sessions, s), folders: keep(store.folders, f) }
}

// ------------------------------------------------------------------ custom themes

/** The 16 ANSI colours plus the terminal's own, as #rrggbb. */
export interface TermColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const TERM_COLOR_KEYS: readonly (keyof TermColors)[] = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
]

/** UI tokens a custom theme may set (the `--c-*` custom properties in styles.css). */
export const UI_TOKEN_KEYS = ['canvas', 'surface', 'raised', 'overlay', 'fg', 'fg-muted', 'fg-subtle', 'accent', 'accent-fg'] as const
export type UiTokenKey = (typeof UI_TOKEN_KEYS)[number]

export interface CustomTheme {
  /** `custom-…`: never collides with a built-in id, which are stored in settings and never renamed. */
  id: string
  label: string
  mode: 'dark' | 'light'
  /** What the generator was given, so the theme can be edited again (absent for imports). */
  source?: { base: string; accent: string; chroma?: number }
  term: TermColors
  /** UI colours for the app chrome; absent for a terminal-only theme (an iTerm2 import). */
  ui?: Partial<Record<UiTokenKey, string>>
}

export const CUSTOM_PREFIX = 'custom-'
export const isCustomThemeId = (id: string): boolean => id.startsWith(CUSTOM_PREFIX)
