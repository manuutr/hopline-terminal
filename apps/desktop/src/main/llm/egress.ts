import type { EgressLog } from '../egress/store'
import type { LlmProvider, TurnRequest, TurnResult } from './types'

/**
 * Records every request in the "what left this machine" log (egress/store.ts), as sent.
 *
 * `AiService.provider()` returns the adapter wrapped in this, and `AgentLoop` wraps that in
 * `safeProvider`, so what arrives here is already redacted, and the adapter hands back its exact
 * request body through `beforeSend` (llm/types.ts) just before it sends it. The row is written
 * before the request leaves; tokens and status are added after, and a failed or cancelled request
 * keeps its row (it may still have left).
 *
 * `required` (team policy, `requireEgressLog`): a request that cannot be recorded is not sent.
 */

export const NOT_LOGGED = 'Not sent: the request could not be recorded in the "what left this machine" log, which the team policy requires'

export interface EgressTarget {
  provider: string
  model: string
  destination: string
}

export function egressProvider(inner: LlmProvider, d: { log: EgressLog | null; required: boolean; target: EgressTarget; now?: () => number }): LlmProvider {
  const now = d.now ?? Date.now
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    logsWire: true,
    async turn(req: TurnRequest): Promise<TurnResult> {
      if (d.required && (!d.log || !inner.logsWire)) throw new Error(`${NOT_LOGGED} (the log is not available).`)
      let id: number | null = null
      let t0 = 0
      let attempts = 0
      const onAttempt = () => {
        attempts++
        req.onAttempt?.()
      }
      const beforeSend = async (body: unknown) => {
        await req.beforeSend?.(body)
        t0 = now()
        if (!d.log) return
        let error: Error | undefined
        try {
          const r = await d.log.record({ ...d.target, source: req.meta?.source ?? 'agent', sessionName: req.meta?.sessionName, runId: req.meta?.runId, lane: req.meta?.lane, body })
          id = r.id
          error = r.error
        } catch (e) {
          error = e instanceof Error ? e : new Error(String(e))
        }
        if (error && d.required) {
          if (id !== null) d.log.finish(id, { status: 'cancelled' })
          id = null
          throw new Error(`${NOT_LOGGED} (${error.message}).`)
        }
      }
      try {
        const r = await inner.turn({ ...req, beforeSend, onAttempt })
        if (id !== null) d.log?.finish(id, { status: 'ok', inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens, durationMs: now() - t0, attempts })
        return r
      } catch (e) {
        if (id !== null) d.log?.finish(id, { status: req.signal.aborted ? 'cancelled' : 'error', durationMs: now() - t0, attempts })
        throw e
      }
    }
  }
}
