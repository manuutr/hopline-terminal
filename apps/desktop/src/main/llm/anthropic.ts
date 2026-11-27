import Anthropic from '@anthropic-ai/sdk'
import { ANTHROPIC_MODELS, type AiTestCode, type AiTestResult } from '@shared/types'
import type { ChatMessage, LlmProvider, OnCheckSend, Part, StopReason, TurnRequest, TurnResult } from './types'

/** Test seam: e2e (dev builds only) and unit tests point the SDK at a local fake server. */
export interface AnthropicClientOptions {
  baseURL?: string
}

/**
 * Where Anthropic requests go. Always passed to the SDK explicitly: left unset, the SDK falls back
 * to the ANTHROPIC_BASE_URL environment variable, which would send the key and device data to a
 * host the user never chose in Hopline while the egress log says api.anthropic.com (P8 D-L1).
 */
export const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com'
export const anthropicBaseURL = (baseURL: string | undefined): string => baseURL || ANTHROPIC_DEFAULT_URL
/** The host the egress log records: the one requests really go to. */
export function anthropicHostOf(baseURL: string | undefined): string {
  try {
    return new URL(anthropicBaseURL(baseURL)).host
  } catch {
    return new URL(ANTHROPIC_DEFAULT_URL).host
  }
}

type Block = Anthropic.Beta.BetaContentBlock
type MessageParam = Anthropic.Beta.BetaMessageParam

const PROVIDER = 'anthropic'

function toParams(messages: ChatMessage[]): MessageParam[] {
  return messages.map((m): MessageParam => {
    if (m.role === 'assistant' && m.native?.provider === PROVIDER) {
      // Replay the exact content (thinking blocks included) as the API returned it.
      return { role: 'assistant', content: m.native.content as Anthropic.Beta.BetaContentBlockParam[] }
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = m.parts.map((p) => {
      switch (p.type) {
        case 'text':
          return { type: 'text', text: p.text }
        case 'tool_call':
          return { type: 'tool_use', id: p.id, name: p.name, input: p.input as Record<string, unknown> }
        case 'tool_result':
          return { type: 'tool_result', tool_use_id: p.id, content: p.content, is_error: p.isError }
      }
    })
    return { role: m.role, content }
  })
}

function fromBlocks(blocks: Block[]): Part[] {
  const parts: Part[] = []
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input })
  }
  return parts
}

function stopOf(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

/**
 * Server-side refusal fallback where the model supports it. Claude Haiku 5.5 has none, and an
 * unknown (custom) model id gets none, so the request can't 400 on a parameter it doesn't know.
 */
function fallbackParams(model: string): { betas?: ['server-side-fallback-2026-07-01']; fallbacks?: 'default' } {
  return /^claude-(opus-5(-5)?|sonnet-5-5|fable-5(-[12])?)$/.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}
}

export const anthropicLabel = (model: string): string => ANTHROPIC_MODELS.find((m) => m.id === model)?.label ?? model

export class AnthropicProvider implements LlmProvider {
  readonly id = PROVIDER
  readonly logsWire = true
  readonly capabilities = { tools: true, maxContext: 200_000 }
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly opts: AnthropicClientOptions = {}
  ) {}

  /**
   * A client for one turn whose fetch counts the attempts: the SDK retries (maxRetries 2) happen
   * inside it, so each one is reported through `onAttempt` and the egress row says how many
   * times the body was sent (review L4).
   */
  private clientFor(req: TurnRequest): Anthropic {
    const counted: typeof fetch = (input, init) => {
      req.onAttempt?.()
      return fetch(input, init)
    }
    return new Anthropic({ apiKey: this.apiKey, maxRetries: 2, fetch: counted, baseURL: anthropicBaseURL(this.opts.baseURL) })
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
        stream: true,
        model: this.model,
        max_tokens: 32000,
        // Opus 5.5: thinking is always on; show a readable summary in the panel.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium' },
        // Server-side refusal fallback: route a declined turn to another model by category.
        ...fallbackParams(this.model),
        // Cache the stable prefix (tools + system) across agent iterations.
        cache_control: { type: 'ephemeral' },
        system: req.system,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
          // Server-validated inputs. Inputs are short CLI lines, so eager streaming buys nothing.
          strict: true
        })),
        messages: toParams(req.messages)
      }
    // The egress log records exactly the body the SDK sends: `betas` travels as a header
    // (anthropic-beta), like the key, so it is not part of it.
    const { betas: _betas, ...body } = params
    void _betas
    await req.beforeSend?.(body)
    const stream = this.clientFor(req).beta.messages.stream(params, { signal: req.signal })
    stream.on('text', (d) => req.onText(d))
    stream.on('thinking', (d) => req.onThinking(d))

    const msg = await stream.finalMessage()
    const stop = stopOf(msg.stop_reason)
    return {
      message: { role: 'assistant', parts: fromBlocks(msg.content), native: { provider: PROVIDER, content: msg.content } },
      stop,
      detail: stop === 'refusal' ? (msg.stop_details?.explanation ?? 'the model declined this request') : undefined,
      usage: {
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0
      }
    }
  }
}

/**
 * Classify an SDK error by class and structured fields (`type`), never by message text.
 * Returns null for anything that is not an Anthropic API error.
 */
export function classifyAnthropicError(e: unknown): { code: AiTestCode; message: string } | null {
  if (e instanceof Anthropic.APIUserAbortError) return { code: 'other', message: 'Cancelled.' }
  if (e instanceof Anthropic.APIConnectionTimeoutError) return { code: 'network', message: 'The Anthropic API did not answer in time. Check your network or proxy.' }
  if (e instanceof Anthropic.APIConnectionError) return { code: 'network', message: 'Cannot reach api.anthropic.com. Check your network, proxy or firewall.' }
  if (e instanceof Anthropic.AuthenticationError) return { code: 'invalid_key', message: 'Invalid API key. Check that you copied the whole key (sk-ant-…).' }
  if (e instanceof Anthropic.PaymentRequiredError || (e instanceof Anthropic.APIError && e.type === 'billing_error'))
    return { code: 'no_credits', message: 'The key works, but the account has no credits. Add credits in the Anthropic Console (Billing).' }
  if (e instanceof Anthropic.PermissionDeniedError) return { code: 'no_access', message: 'This key does not have access to the selected model.' }
  if (e instanceof Anthropic.NotFoundError) return { code: 'model_not_found', message: 'Model not found. Pick another model.' }
  if (e instanceof Anthropic.RateLimitError) return { code: 'rate_limit', message: 'Rate limited by the Anthropic API. The key is valid; try again in a minute.' }
  if (e instanceof Anthropic.OverloadedError || (e instanceof Anthropic.APIError && e.type === 'overloaded_error'))
    return { code: 'overloaded', message: 'The Anthropic API is overloaded right now. Try again shortly.' }
  if (e instanceof Anthropic.APIError) return { code: 'other', message: `Anthropic API error ${e.status ?? ''}: ${e.apiMessage ?? e.message}`.replace(/\s+:/, ':') }
  return null
}

/** Map SDK errors to short, user-facing messages (no string matching on messages). */
export function describeLlmError(e: unknown): string {
  return classifyAnthropicError(e)?.message ?? (e instanceof Error ? e.message : String(e))
}

/**
 * Connect check: the model exists for this key (models.retrieve, no tokens), then a one-line
 * message request (a few tokens), the only call that shows a missing credit balance.
 * No retries and a short timeout, so a bad network fails fast with a clear message.
 */
/** The connect check's message body (also what the egress log records for it, source `check`). */
export const anthropicTestBody = (model: string) => ({
  model,
  max_tokens: 16,
  output_config: { effort: 'low' as const },
  messages: [{ role: 'user' as const, content: 'Reply with the word OK.' }]
})

export async function testAnthropic(apiKey: string, model: string, opts: AnthropicClientOptions & { timeoutMs?: number; onSend?: OnCheckSend } = {}): Promise<AiTestResult> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: opts.timeoutMs ?? 20_000, baseURL: anthropicBaseURL(opts.baseURL) })
  try {
    await opts.onSend?.({ method: 'GET', path: `/v1/models/${model}` })
    const info = await client.models.retrieve(model)
    const body = anthropicTestBody(model)
    await opts.onSend?.({ method: 'POST', path: '/v1/messages', body }, true)
    await client.messages.create(body)
    const label = info.display_name || anthropicLabel(model)
    return { ok: true, code: 'ok', message: `Connected to ${label}`, modelLabel: label }
  } catch (e) {
    const c = classifyAnthropicError(e) ?? { code: 'other' as const, message: e instanceof Error ? e.message : String(e) }
    return { ok: false, ...c }
  }
}
