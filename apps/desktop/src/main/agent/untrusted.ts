import { randomBytes } from 'node:crypto'
import { redact } from '@hopline/guard'
import { cleanTerminalText } from '@shared/cli'

/**
 * Device text on its way to a model (ARCHITECTURE §6, "Injection"). One transform, used by every
 * path that puts device output in front of a model or records it for evidence checks, so the
 * model, the renderer preview and the fleet ledger all see the same bytes:
 *
 *   strip terminal escapes and controls → drop invisible format characters → NFKC →
 *   neutralise frame tags → redact.
 *
 * - Escapes: CSI/OSC (title, OSC 8 hyperlinks, OSC 52 clipboard), DCS/SOS/PM/APC, C1 controls,
 *   cursor moves and erases (`cleanTerminalText`). The executor already cleans its capture; this
 *   runs again in main so any executor (or a future one) is covered, and a cut sequence can't
 *   hide a secret from redaction (escapes go first, redaction last).
 * - Invisible characters: zero-width and bidi overrides, which can hide or reorder text and split
 *   a tag a model still reads as one.
 * - Frame tags: device text can't open or close an untrusted frame (`<device_output`,
 *   `</device_report>`, fullwidth and spaced variants after NFKC): the bracket becomes `‹`.
 * - Frame ids: every frame Hopline writes carries a fresh random id on its opening AND its closing
 *   tag (`<device_output id="3f9a…" …>` … `</device_output id="3f9a…">`), and the system prompts
 *   say a frame ends only at the closer with its opener's id (Phase 8 review B-5). Device text
 *   can't know the id, so the lookalike list above is defence in depth, not the boundary.
 */

/**
 * Invisible characters: every Default_Ignorable code point (zero-width, bidi, soft hyphen, the
 * combining grapheme joiner U+034F, the Arabic letter mark U+061C, the Hangul fillers, variation
 * selectors and the U+E0000 tag block used for "ASCII smuggling"), plus the Mongolian vowel
 * separator. A model can read some of them as hidden text, and any of them can split a tag.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u180e\u{E0000}-\u{E007F}]/gu
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '')
}

/** Line and paragraph separators: a model reads them as line breaks, so they become one. */
const SEPARATORS = /[\u2028\u2029]/g

/**
 * Letters a device can swap for a lookalike (Cyrillic, Greek, Armenian) and still be read as the
 * frame tag. Matching only: the text keeps its letters, only the bracket is replaced.
 */
const CONFUSABLE: Record<string, string> = {
  a: 'aаαɑ',
  c: 'cсϲ',
  d: 'dԁᴅ',
  e: 'eеҽε',
  i: 'iіɩιı',
  k: 'kкκ',
  l: 'lӏ',
  m: 'mм',
  n: 'nпη',
  o: 'oоοօ',
  p: 'pрρ',
  r: 'rг',
  s: 'sѕ',
  t: 'tтτ',
  u: 'uυսʋ',
  v: 'vѵν'
}
/** Latin letters with a precomposed accent (`é`, `ö`: NFKC composes `e` + U+0301 into one), by base letter. */
const ACCENTED: Record<string, string> = {}
for (let cp = 0xc0; cp <= 0x24f; cp++) addAccented(cp)
for (let cp = 0x1e00; cp <= 0x1eff; cp++) addAccented(cp)
function addAccented(cp: number): void {
  const ch = String.fromCodePoint(cp)
  const base = ch.normalize('NFD')[0]!.toLowerCase()
  if (base !== ch.toLowerCase() && /[a-z]/.test(base)) ACCENTED[base] = (ACCENTED[base] ?? '') + ch
}
const FRAME_NAMES = ['device_output', 'device_report', 'task', 'terminal_output', 'scope', 'untrusted']
/** Combining marks a device can put on or between the letters (`d̶`, `/̸`): matched, then dropped. */
const MARKS = '\\p{M}*'
const fuzzy = (name: string) => [...name].map((ch) => (ch === '_' ? '[\\W_]{0,8}' : `[${CONFUSABLE[ch] ?? ch}${ACCENTED[ch] ?? ''}]${MARKS}`)).join('')
/**
 * Every frame Hopline puts around untrusted text, in any prompt: a `<` or a lookalike bracket
 * (`‹ 〈 ⟨ ˂ ﹤ ＜ ❮ ❬ ᐸ « ≮ ≺ ⋖`; `≮` is what NFKC makes of `<` + U+0338), an optional slash, two,
 * a backslash or a lookalike, then the name with any separator for the underscore
 * (`device‐output`, `device     output`), lookalike or accented letters (`outрut`, `dévice`) and
 * combining marks anywhere in it.
 */
const FRAME_TAG = new RegExp(`[<‹〈〈⟨˂﹤＜❮❬ᐸ«≮≺⋖]${MARKS}\\s*((?:[/∕⁄⧸／\\\\]${MARKS}){0,2})\\s*(${FRAME_NAMES.map(fuzzy).join('|')})`, 'giu')
const stripMarks = (s: string) => s.replace(/\p{M}/gu, '')

/** Invisible characters out, NFKC, frame tags neutralised. Safe on text that is already clean. */
export function neutralise(s: string): string {
  return stripInvisible(s)
    .replace(SEPARATORS, '\n')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(FRAME_TAG, (_m, slash: string, name: string) => `‹${stripMarks(slash)}${stripMarks(name)}`)
}

/** Device bytes as text a model may read: no escapes or controls, no invisible characters, no frame tags. */
export function deviceText(raw: string): string {
  return neutralise(cleanTerminalText(raw))
}

/** `deviceText`, then redaction (last, so an escape can't split a secret). */
export function untrustedText(raw: string): { text: string; count: number } {
  return redact(deviceText(raw))
}

/** A value inside a frame attribute: escaped, one line, bounded. */
export const attr = (s: string, max = 96): string =>
  neutralise(s)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, max)

/** The frames Hopline writes around untrusted text (the system prompts name them). */
export type FrameName = 'device_output' | 'device_report' | 'task' | 'terminal_output'

/** A fresh random frame id (48 bits): one per frame, so no text inside any frame can know another's closer. */
export const frameId = (): string => randomBytes(6).toString('hex')

/**
 * One frame: `<name id="…"{attrs}>`, the body, `</name id="…">` with the same fresh id. The body is
 * taken as given: callers pass text that is already neutralised (or, for `terminal_output` around a
 * tool result, Hopline's own frames and notes). `attrs` starts with a space.
 */
export function frame(name: FrameName, body: string, attrs = ''): string {
  const id = frameId()
  return `<${name} id="${id}"${attrs}>\n${body}\n</${name} id="${id}">`
}

/**
 * One command's output as the model receives it: inside a frame that says it is untrusted device
 * data. The body is neutralised here, whatever the caller did (Phase 8 review B-4: TextFSM rows
 * joined with tabs rebuilt `<` + `/device_output>` from two cells). Hopline's own notes (filter,
 * truncation, parsed rows) are outside the frame, so device text can't forge one.
 */
export function frameOutput(device: string, command: string, body: string, extra = ''): string {
  return frame('device_output', neutralise(body), ` device="${attr(device)}" command="${attr(command, 200)}"${extra} untrusted="true"`)
}
