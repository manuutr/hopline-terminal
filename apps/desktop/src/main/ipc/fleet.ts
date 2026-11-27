import { z } from 'zod'
import type { FleetService } from '../fleet/service'
import { MAX_TOKEN_BUDGET, MIN_TOKEN_BUDGET } from '../fleet/budget'
import { MAX_FLEET_CONCURRENCY } from '../fleet/pool'
import { handler as h, registerAll, type Handler } from '.'

const none = { parse: (): undefined => undefined }
const id = z.string().min(1).max(128)
const ids = z.array(id).max(500)

export const FleetScopeSchema = z
  .object({
    sessions: ids.optional(),
    folders: ids.optional(),
    tags: z.array(z.string().min(1).max(64)).max(100).optional(),
    topology: z.object({ seed: id, hops: z.union([z.literal(1), z.literal(2)]) }).strict().optional()
  })
  .strict()

export const FleetStartSchema = z
  .object({
    scopeId: id,
    question: z.string().min(1).max(4000),
    concurrency: z.number().int().min(1).max(MAX_FLEET_CONCURRENCY).optional(),
    tokenBudget: z.number().int().min(MIN_TOKEN_BUDGET).max(MAX_TOKEN_BUDGET).optional(),
    sessionIds: ids.optional()
  })
  .strict()

/** "@ai … @edge-r1" (F11): the user's raw text and the current tab's session; main parses and resolves the mentions. */
export const FleetMentionsSchema = z.object({ text: z.string().min(1).max(4000), sessionId: id.nullable() }).strict()

/** Fleet runs (F10, read-only). The asking window owns its scopes and runs. Exported for the IPC contract test. */
export const FleetCancelLaneSchema = z.object({ runId: id, lane: z.string().min(1).max(256) }).strict()

export function fleetHandlers(fleet: Pick<FleetService, 'info' | 'scope' | 'mentions' | 'start' | 'cancel' | 'cancelLane'>): Record<string, Handler> {
  return {
    'fleet:info': h(none, () => fleet.info()),
    'fleet:scope': h(FleetScopeSchema, (spec, e) => fleet.scope(spec, e.sender)),
    'fleet:mentions': h(FleetMentionsSchema, (req, e) => fleet.mentions(req, e.sender)),
    'fleet:start': h(FleetStartSchema, (req, e) => fleet.start(req, e.sender)),
    'fleet:cancel': h(id, (runId, e) => fleet.cancel(runId, e.sender)),
    'fleet:cancel-lane': h(FleetCancelLaneSchema, ({ runId, lane }, e) => fleet.cancelLane(runId, lane, e.sender))
  }
}

export function registerFleetIpc(fleet: FleetService): void {
  registerAll(fleetHandlers(fleet))
}
