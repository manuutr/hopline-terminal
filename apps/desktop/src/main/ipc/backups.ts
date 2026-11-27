import { redact } from '@hopline/guard'
import { userInfo } from 'node:os'
import { z } from 'zod'
import type { BackupService } from '../backups/service'
import type { BackupStore } from '../backups/store'
import { Retention } from '../backups/store'
import type { AuditLog } from '../db/audit'
import { writePrivateFile } from '../private-file'
import { handler as h, registerAll, type Handler } from '.'

const id = z.string().min(1).max(64)
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')

const Schedule = z
  .object({
    id: id.optional(),
    kind: z.enum(['folder', 'tag']),
    target: z.string().trim().min(1).max(120),
    cadence: z.enum(['daily', 'weekly']),
    weekday: z.number().int().min(0).max(6),
    time,
    enabled: z.boolean()
  })
  .strict()

export interface BackupIpcDeps {
  service: BackupService
  store: BackupStore
  /** Main's own save dialog: the renderer never supplies a path. Null when cancelled. */
  saveFile(defaultName: string): Promise<string | null>
  /** A main-side confirmation (exporting a version with its secrets). */
  confirm(message: string, detail: string, ok: string): Promise<boolean>
  /** Exports are audited (with or without secrets). */
  audit?: AuditLog
}

const fileName = (name: string, ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'config'
  return `${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`
}

/**
 * `backups:*`. Config text crosses to the renderer only redacted. There is no restore channel:
 * Hopline never pushes a stored configuration to a device.
 */
export function backupHandlers(d: BackupIpcDeps): Record<string, Handler> {
  return {
    'backups:list': h(z.object({ sessionId: id.optional() }).strict(), ({ sessionId }) => d.store.list(sessionId)),
    'backups:get': h(id, (v) => d.service.view(v)),
    // Only the asking window's tabs are used; without one, the background connection (as today).
    'backups:take': h(z.object({ sessionIds: z.array(id).min(1).max(500) }).strict(), ({ sessionIds }, e) => d.service.take(sessionIds, 'manual', e.sender)),
    'backups:live': h(id, (sessionId, e) => d.service.live(sessionId, e.sender)),
    // The user says the device was renamed: one more backup that accepts exactly this new name (audited).
    'backups:acceptRename': h(z.object({ sessionId: id, hostname: z.string().trim().min(1).max(253) }).strict(), ({ sessionId, hostname }, e) => d.service.acceptRename(sessionId, hostname, e.sender)),
    'backups:remove': h(id, (v) => {
      const m = d.store.meta(v)
      d.store.remove(v)
      // Deleting history is audited (review A2), like exports.
      if (m)
        d.audit?.append({
          sessionId: m.sessionId,
          sessionName: m.sessionName,
          host: '',
          source: 'backup',
          command: `delete config version ${v.slice(0, 8)}`,
          kind: 'delete',
          decision: 'executed',
          reason: `deleted the version of ${new Date(m.ts).toISOString()}`,
          approver: userInfo().username,
          durationMs: null,
          bytes: m.size,
          redactions: null
        })
    }),
    'backups:export': h(z.object({ id, includeSecrets: z.boolean() }).strict(), async ({ id: vid, includeSecrets }) => {
      const m = d.store.meta(vid)
      if (!m) throw new Error('No such backup version')
      if (includeSecrets && !(await d.confirm('Export this configuration with its secrets?', 'Passwords, keys and SNMP communities are written to the file in clear text.', 'Export with secrets'))) return { file: null }
      const file = await d.saveFile(fileName(m.sessionName, m.ts))
      if (!file) return { file: null }
      const text = await d.store.text(vid)
      const red = includeSecrets ? null : redact(text)
      // 0o600 also when it replaces an existing file (a tmp file renamed over it).
      await writePrivateFile(file, (red ? red.text : text) + '\n')
      d.audit?.append({
        sessionId: m.sessionId,
        sessionName: m.sessionName,
        host: '',
        source: 'backup',
        command: `export config version ${vid.slice(0, 8)}`,
        kind: 'export',
        decision: 'executed',
        reason: includeSecrets ? `exported with secrets in clear text to ${file}` : `exported with secrets redacted to ${file}`,
        approver: includeSecrets ? userInfo().username : null,
        durationMs: null,
        bytes: Buffer.byteLength(red ? red.text : text),
        redactions: red ? red.count : null
      })
      return { file }
    }),
    'backups:schedules': h(z.undefined(), () => d.store.schedules().map((s) => ({ ...s, sessions: d.service.targets(s).length }))),
    'backups:saveSchedule': h(Schedule, (s) => d.store.saveSchedule(s)),
    'backups:removeSchedule': h(id, (v) => d.store.removeSchedule(v)),
    'backups:retention': h(z.undefined(), () => d.store.retention()),
    'backups:setRetention': h(Retention, (r) => d.store.setRetention(r))
  }
}

export function registerBackupIpc(d: BackupIpcDeps): void {
  registerAll(backupHandlers(d))
}
