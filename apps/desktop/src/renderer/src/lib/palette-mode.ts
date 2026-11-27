/**
 * Command palette prefixes, typed as the first character:
 *   >  commands      @  sessions and open tabs      #  tags and folders
 *   ?  help           !  snippets
 * Without a prefix the palette searches everything, as before.
 */
export type PaletteMode = 'all' | 'commands' | 'sessions' | 'groups' | 'help' | 'snippets'

export const PREFIXES: { prefix: string; mode: PaletteMode; label: string; hint: string }[] = [
  { prefix: '>', mode: 'commands', label: 'Commands', hint: 'run an action' },
  { prefix: '@', mode: 'sessions', label: 'Sessions', hint: 'connect or go to a tab' },
  { prefix: '#', mode: 'groups', label: 'Tags and folders', hint: 'open a group of sessions' },
  { prefix: '!', mode: 'snippets', label: 'Snippets', hint: 'insert or run a snippet' },
  { prefix: '?', mode: 'help', label: 'Help', hint: 'prefixes and shortcuts' }
]

export function parsePalette(search: string): { mode: PaletteMode; query: string } {
  const p = PREFIXES.find((x) => search.startsWith(x.prefix))
  if (!p) return { mode: 'all', query: search }
  return { mode: p.mode, query: search.slice(1).trimStart() }
}

export const PLACEHOLDER: Record<PaletteMode, string> = {
  all: 'Connect to a session, user@host, or run a command…  (? for help)',
  commands: 'Run a command…',
  sessions: 'Go to a session or open tab…',
  groups: 'Pick a tag or folder…',
  help: 'Type a prefix, or pick one…',
  snippets: 'Insert or run a snippet…'
}

let pending = ''
/** The palette opens with this text (a prefix), once. */
export function setPaletteStart(text: string): void {
  pending = text
}
export function takePaletteStart(): string {
  const t = pending
  pending = ''
  return t
}
