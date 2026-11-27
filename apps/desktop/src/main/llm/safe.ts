import { NetworkPrivacy } from './network-privacy'
import { redact } from '@hopline/guard'
import type { ChatMessage, LlmProvider, Part, TurnRequest, TurnResult } from './types'

/** A whole model turn (one request, streamed). Local models on a laptop CPU are slow; this is a backstop. */
export const LLM_TURN_TIMEOUT_MS = 10 * 60_000

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`The model did not finish answering within ${Math.round(ms / 60_000)} minutes.`)
    this.name = 'LlmTimeoutError'
  }
}

type Transform = (s: string, field?: string) => string

function mapStrings(value: unknown, transform: Transform, field?: string): unknown {
  if (typeof value === 'string') return transform(value, field)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, transform, field))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, transform, k)]))
  }
  return value
}

function mapPart(p: Part, transform: Transform): Part {
  if (p.type === 'text') return { ...p, text: transform(p.text) }
  if (p.type === 'tool_result') return { ...p, content: transform(p.content) }
  return { ...p, input: mapStrings(p.input, transform) }
}

/** Keep signed provider reasoning intact. If newly recognized private data occurs there, stop
 * before sending. Plain text and tool arguments can use the same transform as ordinary history. */
function protectNative(native: ChatMessage['native'], protect: (s: string) => string): ChatMessage['native'] {
  if (native?.provider !== 'anthropic' || !Array.isArray(native.content)) return undefined
  return { ...native, content: native.content.map((b) => {
    if (b.type === 'text') return { ...b, text: protect(b.text) }
    if (b.type === 'tool_use') return { ...b, input: mapStrings(b.input, protect) }
    if (b.type === 'thinking' && protect(b.thinking) !== b.thinking) {
      throw new Error('This signed reasoning history contains a protected value. Start a new chat to continue.')
    }
    return b
  }) }
}

/**
 * The one door to every LLM, whatever the provider: everything in the request (system prompt,
 * user text, tool results) is redacted here, last, so no provider can receive a secret even if
 * an earlier step forgot to redact; and every turn has a hard time limit.
 *
 * The privacy dictionary is shared across turns. Provider-native history is checked before replay.
 */
export function safeProvider(inner: LlmProvider, opts: { privacy?: NetworkPrivacy; turnTimeoutMs?: number; onRedacted?: (n: number) => void } = {}): LlmProvider {
  const privacy = opts.privacy ?? new NetworkPrivacy()
  const ms = opts.turnTimeoutMs ?? LLM_TURN_TIMEOUT_MS
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    logsWire: inner.logsWire,
    async turn(req: TurnRequest): Promise<TurnResult> {
      let count = 0
      const prepare = (text: string, field?: string) => {
        const r = redact(text)
        count += r.count
        if (field) privacy.discoverField(field, r.text)
        privacy.discover(r.text)
        return r.text
      }
      if (req.meta?.sessionName) privacy.remember(req.meta.sessionName, 'device')
      const system = prepare(req.system)
      const prepared = req.messages.map((m) => ({ ...m, parts: m.parts.map((p) => mapPart(p, prepare)) }))
      // Native reasoning has no equivalent in neutral parts. Discover its fields before masking
      // earlier mentions, then let protectNative refuse replay if the signature would be invalid.
      for (const { native } of req.messages) {
        if (native?.provider !== 'anthropic' || !Array.isArray(native.content)) continue
        for (const block of native.content) {
          if (block.type === 'thinking') privacy.discover(block.thinking)
        }
      }
      const protect = (s: string) => privacy.mask(redact(s).text)
      const messages = prepared.map((m) => ({
        ...m, parts: m.parts.map((p) => mapPart(p, (s) => privacy.mask(s))),
        native: protectNative(m.native, protect)
      }))
      if (count) opts.onRedacted?.(count)
      const timer = new AbortController()
      const t = setTimeout(() => timer.abort(new LlmTimeoutError(ms)), ms)
      const stream = privacy.displayStream(req.onText)
      try {
        return await inner.turn({ ...req, system: privacy.mask(system), messages, onText: stream.write, signal: AbortSignal.any([req.signal, timer.signal]) })
      } catch (e) {
        if (timer.signal.aborted && !req.signal.aborted) throw new LlmTimeoutError(ms)
        throw e
      } finally {
        clearTimeout(t)
        stream.flush()
      }
    }
  }
}
