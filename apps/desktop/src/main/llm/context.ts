import type { ChatMessage, Part, ToolSpec } from './types'

/**
 * Fit a conversation into a local model's context window (Ollama truncates silently otherwise,
 * and the part it drops is the beginning: the system prompt and the safety rules).
 *
 * Works on a copy at request time: the shared conversation is never changed (`repair()` in
 * agent/loop.ts relies on part identity). What arrives here is already redacted (llm/safe.ts), so
 * shortening a tool result cannot split a secret past the redaction.
 *
 * 1. Whole exchanges (a question with every call and result after it) are dropped, oldest first;
 *    a call is never separated from its result. The newest exchange is always kept.
 * 2. If that is not enough, the long parts of what is left (tool results, and text parts: suggest-mode
 *    results of up to 40k characters, a selection of up to 20k) are shortened, oldest first, to their
 *    head and tail with a marker. A framed part keeps its opening and closing frame (agent/untrusted.ts).
 * 3. A note at the top tells the model that earlier messages were left out.
 * 4. When even that does not fit, or the system prompt and tool definitions alone leave no room,
 *    `ContextTooSmallError` is thrown and nothing is sent (review M2): Ollama would otherwise drop the
 *    start of the request, which is the system prompt with the untrusted-output and suggest rules.
 */

/** The request cannot be made to fit the window: refused before anything is sent. */
export class ContextTooSmallError extends Error {
  constructor(
    readonly numCtx: number,
    readonly needed: number
  ) {
    super(
      `Context too small: this model's context window (${numCtx.toLocaleString('en-US')} tokens) cannot hold the assistant's instructions and this request (about ${needed.toLocaleString('en-US')} tokens even shortened). Nothing was sent. Pick a model with a larger context, or ask about less output.`
    )
    this.name = 'ContextTooSmallError'
  }
}

/** Below this, what is left of a long part is no longer useful; a request that still does not fit is refused. */
const MIN_KEEP = 1_000
/** The smallest room left for the conversation itself, after the instructions and the answer's reserve. */
const MIN_ROOM = 512

/** Characters per token for the estimate: CLI output tokenises densely, so this errs on the large side. */
export const CHARS_PER_TOKEN = 3

export const estimate = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN)

function partTokens(p: Part): number {
  if (p.type === 'text') return estimate(p.text)
  if (p.type === 'tool_result') return estimate(p.content) + 8
  return estimate(JSON.stringify(p.input ?? null)) + estimate(p.name) + 8
}

const msgTokens = (m: ChatMessage): number => 4 + m.parts.reduce((a, p) => a + partTokens(p), 0)

export interface Fitted {
  messages: ChatMessage[]
  /** Messages left out. */
  dropped: number
  /** Tool results shortened. */
  shortened: number
  /** Estimated prompt tokens of the result. */
  tokens: number
}

/** Room for the answer: an eighth of the window, at least 1,024 tokens. */
export const outputReserve = (numCtx: number): number => Math.max(1024, Math.floor(numCtx / 8))

const isQuestion = (m: ChatMessage) => m.role === 'user' && m.parts.some((p) => p.type === 'text')

function shorten(text: string, keep: number): string {
  if (text.length <= keep) return text
  const head = Math.floor(keep * 0.4)
  const tail = keep - head
  return `${text.slice(0, head)}\n[… ${(text.length - keep).toLocaleString('en-US')} characters left out to fit the model's context window …]\n${text.slice(-tail)}`
}

export function fitContext(system: string, messages: ChatMessage[], tools: ToolSpec[], numCtx: number): Fitted {
  const fixed = estimate(system) + (tools.length ? estimate(JSON.stringify(tools)) : 0)
  const budget = numCtx - outputReserve(numCtx) - fixed
  if (budget < MIN_ROOM) throw new ContextTooSmallError(numCtx, fixed + outputReserve(numCtx) + MIN_ROOM)
  const total = (ms: ChatMessage[]) => ms.reduce((a, m) => a + msgTokens(m), 0)
  let out = messages
  if (total(out) <= budget) return { messages: out, dropped: 0, shortened: 0, tokens: fixed + total(out) }

  // 1. Drop whole exchanges from the front.
  const starts = out.flatMap((m, i) => (isQuestion(m) ? [i] : []))
  let dropped = 0
  // The earliest start whose tail fits; else the newest exchange alone.
  let cut = starts.at(-1) ?? 0
  for (const s of starts) {
    if (s === 0) continue
    if (total(messages.slice(s)) + 40 <= budget) {
      cut = s
      break
    }
  }
  if (cut > 0) {
    dropped = cut
    out = messages.slice(cut).map((m) => ({ ...m, parts: [...m.parts] }))
    // A cut-off run's question can share its message with the results of calls now left out.
    out[0] = { ...out[0]!, parts: out[0]!.parts.filter((p) => p.type !== 'tool_result') }
    const note: Part = { type: 'text', text: `[Hopline Terminal: ${dropped} earlier message${dropped === 1 ? ' was' : 's were'} left out to fit this model's context window.]` }
    out[0] = { ...out[0]!, parts: [note, ...out[0]!.parts] }
  } else out = messages.map((m) => ({ ...m, parts: [...m.parts] }))

  // 2. Shorten long tool results and text parts, oldest first, until it fits.
  let shortened = 0
  for (let i = 0; i < out.length && total(out) > budget; i++) {
    const m = out[i]!
    for (let j = 0; j < m.parts.length && total(out) > budget; j++) {
      const p = m.parts[j]!
      const text = p.type === 'tool_result' ? p.content : p.type === 'text' ? p.text : null
      if (text === null || text.length < 2_000) continue
      const over = (total(out) - budget) * CHARS_PER_TOKEN
      const keep = Math.max(MIN_KEEP, text.length - over - 200)
      if (keep >= text.length) continue
      if (p.type === 'tool_result') m.parts[j] = { ...p, content: shorten(text, keep) }
      else if (p.type === 'text') m.parts[j] = { ...p, text: shorten(text, keep) }
      out[i] = { ...m, parts: m.parts }
      shortened++
    }
  }
  // 4. Still too large (many long parts in the newest exchange): refuse rather than let Ollama cut the start.
  if (total(out) > budget) throw new ContextTooSmallError(numCtx, fixed + outputReserve(numCtx) + total(out))
  return { messages: out, dropped, shortened, tokens: fixed + total(out) }
}
