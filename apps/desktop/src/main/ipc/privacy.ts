import { z } from 'zod'
import type { CrashReporting } from '../crash/service'
import type { UpdateService } from '../update/service'
import { handler as h, registerAll, type Handler } from '.'

/** Updates and crash reports (Phase 7). Exported for the IPC contract test. */

const none = { parse: (): undefined => undefined }
const DumpId = z.string().regex(/^[\w-]{1,80}$/)
export const RendererErrorSchema = z
  .object({
    name: z.string().max(200),
    message: z.string().max(4000),
    stack: z.string().max(16_000),
    kind: z.enum(['exception', 'rejection', 'render'])
  })
  .strict()

export interface PrivacyDeps {
  updates: UpdateService
  crash: CrashReporting
}

export function privacyHandlers(d: PrivacyDeps): Record<string, Handler> {
  return {
    'update:status': h(none, () => d.updates.status()),
    'update:check': h(none, () => d.updates.check(true)),
    // Refused in main while any session is open (UpdateService.restart).
    'update:restart': h(none, () => d.updates.restart()),
    'crash:status': h(none, () => d.crash.status()),
    'crash:test': h(none, () => d.crash.sendTest()),
    // A renderer error: dropped in main unless the user opted in; scrubbed before it leaves.
    'crash:report': h(RendererErrorSchema, ({ kind, ...e }) => void d.crash.captureRenderer(e, kind)),
    // Each dump is confirmed in main (a native dialog the renderer cannot answer).
    'crash:sendDump': h(DumpId, (id) => d.crash.sendDump(id)),
    'crash:deleteDump': h(DumpId, (id) => d.crash.deleteDump(id)),
    'crash:deleteAllDumps': h(none, () => d.crash.deleteAllDumps())
  }
}

export function registerPrivacyIpc(d: PrivacyDeps): void {
  registerAll(privacyHandlers(d))
}
