/**
 * Device @-mentions in an "@ai …" question (F11): "@ai why is bgp down here and on @edge-r1".
 *
 * Pure text handling, shared by the renderer (autocomplete, routing) and main (which re-parses the
 * raw text it is sent and resolves every mention against saved sessions only: see
 * main/fleet/mentions.ts). A mention is only ever what the user typed: device output is never
 * parsed for mentions.
 *
 * Forms:
 * - `@name` and `@"name with spaces"`: a saved session, by name;
 * - `@#tag`: every saved session with that tag;
 * - `@folder/Name` or `@folder/"Name with spaces"`: every saved session under that folder
 *   (a literal `folder/` prefix; `Name` may be a path, "DC1/Core").
 *
 * An "@" starts a mention only at the start of the text or after whitespace or an opening bracket,
 * so "admin@10.0.0.1" and "user@host" are not mentions. A bare "@" and "@ai" (the trigger itself)
 * are not mentions. Trailing sentence punctuation (".,;:!?)") is not part of an unquoted name.
 */

export type MentionKind = 'session' | 'tag' | 'folder'

export interface Mention {
  kind: MentionKind
  /** The name, tag (without "#") or folder name/path, as typed. */
  ref: string
  /** The exact text of the mention in the message ("@\"core sw\"", "@#edge"). */
  raw: string
  start: number
  end: number
}

/** Characters that end an unquoted mention. */
const BARE = /[^\s"'()[\]{}<>,;]/u
/** Trailing characters that are punctuation, not part of the name ("on @edge-r1?"). */
const TRAILING = /[.,;:!?)]+$/u
const OPENERS = new Set(['(', '[', '{', '"', "'"])
const FOLDER = 'folder/'

const startsMention = (text: string, i: number): boolean => i === 0 || /\s/u.test(text[i - 1]!) || OPENERS.has(text[i - 1]!)

/** A quoted or bare token at `i` (after the "@", "#" or "folder/"): [value, end] or null. */
function token(text: string, i: number): [string, number] | null {
  if (text[i] === '"') {
    const close = text.indexOf('"', i + 1)
    if (close < 0) return null
    const v = text.slice(i + 1, close).trim()
    return v ? [v, close + 1] : null
  }
  let j = i
  while (j < text.length && BARE.test(text[j]!)) j++
  let v = text.slice(i, j)
  const cut = TRAILING.exec(v)
  if (cut) v = v.slice(0, cut.index)
  return v ? [v, i + v.length] : null
}

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (!startsMention(text, i)) continue
    const at = i + 1
    let kind: MentionKind = 'session'
    let from = at
    if (text[at] === '#') (kind = 'tag'), (from = at + 1)
    else if (text.slice(at, at + FOLDER.length).toLowerCase() === FOLDER) (kind = 'folder'), (from = at + FOLDER.length)
    const t = token(text, from)
    if (!t) continue
    const [ref, end] = t
    if (kind === 'session' && text[at] !== '"' && ref.toLowerCase() === 'ai') continue
    if (kind === 'tag' && ref.includes('#')) continue
    out.push({ kind, ref, raw: text.slice(i, end), start: i, end })
    i = end - 1
  }
  return out
}

export const hasMentions = (text: string): boolean => parseMentions(text).length > 0

/** How a mention reads in plain text: "edge-r1", "#edge", "Core". */
export const plainOf = (m: Pick<Mention, 'kind' | 'ref'>): string => (m.kind === 'tag' ? `#${m.ref}` : m.kind === 'folder' ? (m.ref.split('/').at(-1) ?? m.ref) : m.ref)

/** Replace each mention by `name(m)` (default: its plain form). */
export function replaceMentions(text: string, name: (m: Mention, i: number) => string = plainOf): string {
  let out = ''
  let at = 0
  parseMentions(text).forEach((m, i) => {
    out += text.slice(at, m.start) + name(m, i)
    at = m.end
  })
  return out + text.slice(at)
}

/** The mention text that names this session, tag or folder: quoted when it would not parse bare. */
export function formatMention(kind: MentionKind, name: string): string {
  const prefix = kind === 'tag' ? '@#' : kind === 'folder' ? '@folder/' : '@'
  const bare = [...name].every((c) => BARE.test(c)) && !TRAILING.test(name) && !name.startsWith('"') && !(kind === 'session' && name.toLowerCase() === 'ai')
  return bare ? prefix + name : `${prefix}"${name}"`
}

/** The mention being typed at `caret` (autocomplete): where its "@" is and what follows it so far. */
export function activeMention(text: string, caret = text.length): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  for (let i = caret - 1; i >= lineStart && caret - i <= 96; i--) {
    if (text[i] !== '@' || !startsMention(text, i)) continue
    const typed = text.slice(i + 1, caret)
    // Bare so far (no space), or an open quote; a closed quote means the mention is done.
    if (/^[^\s"]*$/u.test(typed.replace(/^(#|folder\/)/i, '')) || /^(#|folder\/)?"[^"]*$/iu.test(typed)) {
      if (typed.toLowerCase() === 'ai') return null
      return { start: i, query: typed }
    }
    return null
  }
  return null
}

// ------------------------------------------------------------------ suggestions

export interface MentionSuggestion {
  kind: MentionKind
  /** Session name, tag or folder name. */
  name: string
  /** Shown beside the name: host, platform, folder… (never inserted). */
  detail: string
  /** The text that replaces the typed mention (with a trailing space). */
  insert: string
}

export interface SuggestSource {
  sessions: readonly { name: string; host: string; tags: readonly string[]; platform?: string; ephemeral?: boolean }[]
  folders: readonly { id: string; name: string; parentId: string | null }[]
}

/** Fuzzy score of `q` in `s` (0 = no match): prefix > word start > substring > in order. */
function score(s: string, q: string): number {
  if (!q) return 1
  const a = s.toLowerCase()
  if (a === q) return 100
  if (a.startsWith(q)) return 80
  const at = a.indexOf(q)
  if (at > 0) return /[\s\-_./:]/.test(a[at - 1]!) ? 60 : 40
  let j = 0
  for (const c of a) if (c === q[j]) j++
  return j === q.length ? 10 : 0
}

/**
 * Saved sessions (fuzzy on name, host and tag), and tags or folders when the query asks for them
 * ("#…", "folder/…") or names one. Host is matched for finding a device; only its name is inserted.
 */
export function suggestMentions(query: string, src: SuggestSource, max = 8): MentionSuggestion[] {
  const raw = query.replace(/^"/, '')
  const out: (MentionSuggestion & { s: number })[] = []
  if (raw.startsWith('#')) {
    const q = raw.slice(1).replace(/^"/, '').toLowerCase()
    const tags = new Map<string, number>()
    for (const s of src.sessions) if (!s.ephemeral) for (const t of s.tags) tags.set(t, (tags.get(t) ?? 0) + 1)
    for (const [t, n] of tags) {
      const sc = score(t, q)
      if (sc) out.push({ kind: 'tag', name: t, detail: `${n} session${n === 1 ? '' : 's'}`, insert: formatMention('tag', t) + ' ', s: sc })
    }
  } else if (/^folder\//i.test(raw)) {
    const q = raw.slice(FOLDER.length).replace(/^"/, '').toLowerCase()
    for (const f of src.folders) {
      const sc = score(f.name, q)
      if (sc) out.push({ kind: 'folder', name: f.name, detail: 'folder', insert: formatMention('folder', folderPath(f, src.folders)) + ' ', s: sc })
    }
  } else {
    const q = raw.toLowerCase()
    for (const s of src.sessions) {
      if (s.ephemeral) continue
      const sc = Math.max(score(s.name, q) * 1.5, score(s.host, q), ...s.tags.map((t) => score(t, q) * 0.8))
      if (sc) out.push({ kind: 'session', name: s.name, detail: s.host, insert: formatMention('session', s.name) + ' ', s: sc })
    }
    if (q) {
      for (const f of src.folders) {
        const sc = score(f.name, q)
        if (sc >= 40) out.push({ kind: 'folder', name: f.name, detail: 'folder', insert: formatMention('folder', folderPath(f, src.folders)) + ' ', s: sc * 0.5 })
      }
    }
  }
  return out
    .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name))
    .slice(0, max)
    .map(({ s: _s, ...m }) => m)
}

/** "Core", or "DC1/Core" when another folder has the same name. */
export function folderPath(f: { id: string; name: string; parentId: string | null }, folders: SuggestSource['folders']): string {
  if (folders.filter((x) => x.name.toLowerCase() === f.name.toLowerCase()).length < 2) return f.name
  const parts = [f.name]
  const seen = new Set([f.id])
  for (let p = folders.find((x) => x.id === f.parentId); p && !seen.has(p.id); p = folders.find((x) => x.id === p!.parentId)) {
    seen.add(p.id)
    parts.unshift(p.name)
  }
  return parts.join('/')
}

/** Replace the mention being typed (from `start` to `caret`) by a suggestion: the new text and caret. */
export function acceptMention(text: string, start: number, caret: number, s: Pick<MentionSuggestion, 'insert'>): { text: string; caret: number } {
  const next = text.slice(0, start) + s.insert + text.slice(caret).replace(/^ /, '')
  return { text: next, caret: start + s.insert.length }
}

// ------------------------------------------------------------------ list keys

/** The typed mention ("dist-eos1", "\"core sw\"") is exactly one of the suggestions already. */
export const mentionComplete = (query: string, items: readonly MentionSuggestion[]): boolean => items.some((s) => s.insert.trimEnd() === `@${query}`)

/**
 * List navigation for a mention popup: returns the new index, 'pick', 'close', or null (key not used).
 * `complete`: what is typed is already a whole mention ("@dist-eos1"), so Enter sends the question
 * instead of inserting the same name again (Tab still inserts it, with the space).
 */
export function mentionKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>, index: number, count: number, complete = false): number | 'pick' | 'close' | null {
  // Only bare keys: anything with Ctrl, Alt or ⌘ (AltGr typing '@' on many layouts is Ctrl+Alt) is
  // left to the field or the app's keymap. Tab, Enter and Esc are used only while the list is open
  // inside an "@ai" capture, where they never reach the device anyway.
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if (e.key === 'ArrowDown') return count ? (index + 1) % count : index
  if (e.key === 'ArrowUp') return count ? (index - 1 + count) % count : index
  if (e.key === 'Enter' && (complete || e.shiftKey)) return null
  if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') return count ? 'pick' : e.key === 'Tab' ? 'close' : null
  if (e.key === 'Escape') return 'close'
  return null
}
