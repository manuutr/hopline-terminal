/**
 * Provider-neutral chat types. Adapters (Anthropic now, Ollama next) translate to/from these.
 * Runs only in the main process: prompts and keys never touch the renderer.
 */

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool input (object, additionalProperties: false). */
  inputSchema: Record<string, unknown>
}

export type Part =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      input: unknown
      /**
       * The provider received a call it could not use (arguments that are not a JSON object, a
       * name that is not a tool name). The loop answers it with an error and runs nothing.
       */
      geminiThoughtSignature?: string
      invalid?: string
    }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  parts: Part[]
  /**
   * Provider-native content for assistant turns (e.g. Anthropic thinking blocks), replayed
   * verbatim on the next request. Only the provider that produced it reads it.
   */
  native?: { provider: string; content: unknown }
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'

/** One connect-check request as the egress log records it (source `check`). */
export interface CheckRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}
/** Called before each connect-check request; `prevOk` says how the previous one ended. */
export type OnCheckSend = (request: CheckRequest, prevOk?: boolean) => Promise<void>

/** Who a request is for, recorded in the "what left this machine" log (never sent to the model). */
export interface TurnMeta {
  runId?: string
  /** `agent` (chat), `fleet`, `suggest`. */
  source?: string
  sessionName?: string
  lane?: string
}

export interface TurnRequest {
  system: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  signal: AbortSignal
  onText: (delta: string) => void
  onThinking: (delta: string) => void
  meta?: TurnMeta
  /**
   * Called by the adapter with the exact request body, after it is built and before it is sent
   * (llm/egress.ts records it). If it throws, nothing is sent.
   */
  beforeSend?: (body: unknown) => Promise<void>
  /**
   * Called each time the body goes on the wire (the Anthropic SDK retries a connection error or a
   * 429/5xx up to twice): the egress row records the attempt count (review L4).
   */
  onAttempt?: () => void
}

export interface TurnResult {
  message: ChatMessage
  stop: StopReason
  /** Human-readable detail for refusals and errors. */
  detail?: string
  /** Tokens the provider reported for this turn (Anthropic `usage`, Ollama eval counts), when it did. */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

export interface ProviderCapabilities {
  /** The model takes tool definitions and calls tools. False: suggest mode (agent/suggest.ts). */
  tools: boolean
  /** Context window the requests are sized for (tokens). */
  maxContext: number
}

export interface LlmProvider {
  readonly id: string
  /** Known for adapters; wrappers pass it through. */
  readonly capabilities?: ProviderCapabilities
  /** The adapter calls `beforeSend` with its request body (the egress log depends on it). */
  readonly logsWire?: boolean
  turn(req: TurnRequest): Promise<TurnResult>
}
