import { z } from 'zod'
import type { AuditLog } from '../db/audit'
import type { EgressLog } from '../egress/store'
import type { PolicyService } from '../policy/policy'
import { writePrivateFile } from '../private-file'
import { handler as h, registerAll, type Handler } from '.'

/**
 * Trust UX and team policy (docs/POLICY.md). The egress log's payloads are decrypted here, in main,
 * only when a row is opened, searched or exported; nothing in them is secret by construction (the
 * request body after redaction: no headers, no API key). Exported for the IPC contract test.
 */

const none = { parse: (): undefined => undefined }
const RowId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const EgressQuerySchema = z.object({ search: z.string().max(200).optional(), limit: z.number().int().min(1).max(2000).optional() }).strict()
const Ids = z.array(RowId).max(5000)

export interface TrustDeps {
  egress: EgressLog
  policy: PolicyService
  /** Exports are audited, like the backups and sessions exports. */
  audit?: Pick<AuditLog, 'append'>
  /** A save dialog in main (e2e stubs it). Null: cancelled. */
  saveFile: (defaultName: string) => Promise<string | null>
}

export function trustHandlers(d: TrustDeps): Record<string, Handler> {
  return {
    'egress:list': h(EgressQuerySchema, (q) => d.egress.query(q)),
    'egress:search': h(EgressQuerySchema, (q) => d.egress.search(q)),
    'egress:get': h(RowId, (id) => d.egress.get(id)),
    'egress:stats': h(none, () => d.egress.stats()),
    'egress:export': h(Ids, async (ids) => {
      const file = await d.saveFile(`hopline-egress-${new Date().toISOString().slice(0, 10)}.jsonl`)
      if (!file) return { file: null, rows: 0 }
      const text = await d.egress.exportLines(ids)
      // 0o600 also when it replaces an existing file (a tmp file renamed over it): review M1.
      await writePrivateFile(file, text)
      const rows = text ? text.trimEnd().split('\n').length : 0
      d.audit?.append({
        sessionId: null,
        sessionName: '(model requests)',
        host: '',
        source: 'user',
        command: 'export what left this machine',
        kind: 'export',
        decision: 'executed',
        reason: `exported ${rows} egress row${rows === 1 ? '' : 's'} (redacted request bodies) to ${file}`,
        approver: null,
        durationMs: null,
        bytes: Buffer.byteLength(text),
        redactions: null
      })
      return { file, rows }
    }),
    'policy:info': h(none, () => d.policy.info)
  }
}

export function registerTrustIpc(d: TrustDeps): void {
  registerAll(trustHandlers(d))
}
