import type { AgentEventBody } from '@shared/types'
import { describeLlmError } from '../llm/anthropic'
import type { NetworkPrivacy } from '../llm/network-privacy'
import { safeProvider } from '../llm/safe'
import type { ChatMessage, LlmProvider, Part, ToolSpec, TurnMeta } from '../llm/types'

/**
 * The provider-agnostic agent loop: one conversation, one tool set, one budget, one event stream.
 *
 * It knows nothing about devices, the guard or the audit log. Those live in the tool set
 * (`DeviceTools` for a terminal session), so a loop over any tool set keeps them. What the loop
 * itself guarantees for every tool set: every model request goes through `safeProvider`
 * (redaction of the whole request and a turn timeout), the iteration and per-turn tool-call caps,
 * cancellation, and a history that stays valid after an error, a cancel or a cut-off turn.
 */

export const MAX_ITERATIONS = 16
/** Tool calls answered per model turn; further calls in the same turn get an error result. */
export const MAX_TOOL_CALLS_PER_TURN = 8

export interface ToolResult {
  text: string
  isError?: boolean
  /**
   * The tool ends the run (a fleet worker's `submit_report`): the turn's results are recorded and
   * the loop stops without asking the model again.
   */
  final?: boolean
}

export interface ToolCallContext {
  runId: string
  signal: AbortSignal
  /**
   * Who approved this call. Unset for the model's own calls (reads need no approval); `user` when
   * the user clicked a suggested command (suggest mode): the audit records the user as approver.
   */
  approver?: 'user'
}

/** What the model is told for a malformed tool call (Ollama: arguments that are not a JSON object). */
export const malformedCall = (name: string, why: string): string =>
  `REJECTED: malformed call to ${name.slice(0, 64)}: ${why}. Nothing was run. Call the tool again with a JSON object that matches its schema.`

/**
 * What a loop can call. Implementations own their own safety (guard, audit, redaction) and turn
 * expected failures into an error result. A `call` that throws ends the run with an error.
 */
export interface ToolSet {
  readonly specs: ToolSpec[]
  call(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolResult>
  /** A malformed call the provider could not use: audit it and answer with an error (nothing runs). */
  reject?(name: string, why: string, ctx: ToolCallContext): ToolResult
}

export interface Conversation {
  privacy?: NetworkPrivacy
  messages: ChatMessage[]
}

export interface AgentLoopOptions {
  /** Resolved once per run, inside the error handling; always wrapped in `safeProvider`. */
  provider: () => Promise<LlmProvider>
  /** Rebuilt every turn (a platform set or detected during the run shows in the next turn). */
  system: () => string
  tools: ToolSet
  emit: (e: AgentEventBody) => void
  maxIterations?: number
  maxToolCallsPerTurn?: number
  /** Recorded with every request in the egress log (the run id is added per run). */
  meta?: Omit<TurnMeta, 'runId'>
  /** The model's final answer of a run that ended normally, before `done` is emitted (suggest mode reads it). */
  onFinal?: (text: string, runId: string) => void
}

export type LoopDone = Extract<AgentEventBody, { type: 'done' }>

/**
 * Keep the history valid for the next request after an error, cancel or cut-off turn:
 * drop an assistant turn whose tool calls never got results, and an unanswered question.
 */
export function repair(conv: Conversation, promptPart: Part): void {
  const last = conv.messages.at(-1)
  if (last?.role === 'assistant' && last.parts.some((p) => p.type === 'tool_call')) conv.messages.pop()
  const tail = conv.messages.at(-1)
  if (tail?.role === 'user' && tail.parts.at(-1) === promptPart) {
    tail.parts.pop()
    if (!tail.parts.length) conv.messages.pop()
  }
}

export class AgentLoop {
  /**
   * @param conversation shared by reference: a per-tab chat passes the same object to every run,
   *   so the history carries over. It is never cloned (repair compares the prompt part by identity).
   */
  constructor(
    readonly conversation: Conversation,
    private readonly o: AgentLoopOptions
  ) {}

  /** One user question to a final answer (or a stop). Emits `done` exactly once and returns it. */
  async run(prompt: string, ctx: ToolCallContext): Promise<LoopDone> {
    const { runId, signal } = ctx
    const conv = this.conversation
    const maxIterations = this.o.maxIterations ?? MAX_ITERATIONS
    const maxCalls = this.o.maxToolCallsPerTurn ?? MAX_TOOL_CALLS_PER_TURN
    const done = (error?: string): LoopDone => {
      const e: LoopDone = error === undefined ? { type: 'done', runId } : { type: 'done', runId, error }
      this.o.emit(e)
      return e
    }

    // If the last run was cut off after tool results, add the question to that user turn so roles still alternate.
    const promptPart: Part = { type: 'text', text: prompt }
    const last = conv.messages.at(-1)
    if (last?.role === 'user') last.parts.push(promptPart)
    else conv.messages.push({ role: 'user', parts: [promptPart] })

    try {
      // Every provider goes through the same door: redaction of the whole request and a turn timeout.
      const provider = safeProvider(await this.o.provider(), { privacy: conv.privacy })
      for (let i = 0; i < maxIterations; i++) {
        if (signal.aborted) throw new Error('Cancelled.')
        const result = await provider.turn({
          system: this.o.system(),
          messages: conv.messages,
          tools: this.o.tools.specs,
          signal,
          meta: { ...this.o.meta, runId },
          onText: (t) => this.o.emit({ type: 'text', runId, text: t }),
          onThinking: (t) => this.o.emit({ type: 'thinking', runId, text: t })
        })
        conv.messages.push(result.message)

        if (result.stop === 'refusal') {
          repair(conv, promptPart)
          return done(`The model declined: ${result.detail}`)
        }
        const calls = result.message.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
        if (result.stop !== 'tool_use' || !calls.length) {
          repair(conv, promptPart)
          if (result.stop !== 'max_tokens') this.o.onFinal?.(result.message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''), runId)
          return result.stop === 'max_tokens' ? done('The answer was cut off (token limit).') : done()
        }

        const results: Part[] = []
        let final = false
        for (const [n, call] of calls.entries()) {
          let content: ToolResult
          if (signal.aborted) content = { text: 'Cancelled by the user before this tool ran.', isError: true }
          else if (final) content = { text: 'Not run: the run already ended with a final tool call in this turn.', isError: true }
          else if (n >= maxCalls) content = { text: `REFUSED: at most ${maxCalls} tool calls are run per turn; this one was not run. Ask for fewer at a time.`, isError: true }
          // A call the provider could not parse never reaches the tool set's `call`.
          else if (call.invalid) content = this.o.tools.reject?.(call.name, call.invalid, ctx) ?? { text: malformedCall(call.name, call.invalid), isError: true }
          // A tool set answers its own errors (DeviceTools audits them and returns ERROR:). If it throws
          // anyway (the audit log itself failed), the run ends: nothing more may reach the device.
          else content = await this.o.tools.call(call.name, call.input, ctx)
          if (content.final) final = true
          results.push({ type: 'tool_result', id: call.id, content: content.text, isError: content.isError })
        }
        conv.messages.push({ role: 'user', parts: results })
        if (final) return done()
      }
      return done(`Stopped after ${maxIterations} steps.`)
    } catch (e) {
      repair(conv, promptPart)
      return done(describeLlmError(e))
    }
  }
}
