import { classify, isPlatform } from '@hopline/guard'
import { commandError } from '@shared/cli'
import type { AuditLog } from '../db/audit'
import type { TabControl } from '../host/client'
import type { SettingsService } from '../settings'

/**
 * Re-run a command block's command. The command text comes from the terminal buffer, which the
 * device controls (a banner can fake a prompt and a command), so it is treated like any other
 * non-user command: main classifies it with the guard, and only a read runs, through the executor
 * (signed verdict, re-checked by the session host, idle-prompt check). Anything else is only
 * inserted at the prompt for the user to read and press Enter on: never sent with Enter from here.
 * Every attempt is audited.
 */
export type RerunResult =
  | { action: 'ran'; status: 'ok' | 'timeout' | 'capped' | 'error'; error?: string }
  | { action: 'insert'; command: string; reason: string }

export interface RerunDeps {
  term: Pick<TabControl, 'get' | 'exec' | 'prompt'>
  audit: Pick<AuditLog, 'append'>
  settings: Pick<SettingsService, 'get'>
}

/** One printable line: no control characters, no separators the guard would refuse anyway. */
// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()

export async function rerunBlock(d: RerunDeps, tabId: string, raw: string): Promise<RerunResult> {
  const tab = d.term.get(tabId)
  if (!tab) throw new Error('No such tab')
  const command = clean(raw)
  if (!command) throw new Error('Empty command')
  const platform = tab.session.platform
  const base = { sessionId: tab.session.id, sessionName: tab.session.name, host: tab.session.host, source: 'user' as const, approver: null, redactions: null }
  const insert = (reason: string): RerunResult => {
    d.audit.append({ ...base, command, kind: 'unknown', decision: 'inserted', reason: `re-run from a command block: ${reason}; inserted at the prompt without Enter`, durationMs: null, bytes: null })
    return { action: 'insert', command, reason }
  }
  if (!isPlatform(platform)) return insert('the device platform is unknown')
  const v = classify(command, platform)
  if (v.kind !== 'read') return insert(`${v.kind}: ${v.reason}`)
  const at = await d.term.prompt(tab)
  if (at.mode !== 'exec' && at.mode !== 'user') return insert(`the session is in ${at.mode} mode`)
  const s = d.settings.get()
  const sent = await d.term.exec(tab, v.command, 'read', { timeoutMs: s.commandTimeoutMs, capBytes: s.outputCapBytes })
  // The device rejected the line (`% Invalid input`): failed, not ok.
  const err = sent.status === 'ok' ? commandError(platform, sent.output) : null
  const r = err ? { ...sent, status: 'error' as const, error: `the device reported an error: ${err.slice(0, 200)}` } : sent
  d.audit.append({
    ...base,
    command: v.command,
    kind: 'read',
    decision: r.status === 'ok' ? 'executed' : r.status,
    reason: r.error ?? 're-run from a command block (read-only)',
    durationMs: r.durationMs,
    bytes: r.bytes
  })
  return { action: 'ran', status: r.status, error: r.error }
}
