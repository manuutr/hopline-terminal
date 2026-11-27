import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PlatformId } from '@hopline/cli-model'
import type { AnyPlatform } from './cli'

/**
 * Verdict tokens bind a guard decision to one exact command on one tab, for a short time.
 * Main signs after classifying; the session host verifies before writing anything that didn't
 * come from the user's keyboard. Node-only (main and host); never imported by the renderer.
 */
export interface Verdict {
  tabId: string
  command: string
  kind: 'read' | 'config' | 'disruptive'
  /** The platform main classified for. The host re-checks with this one, not the one it was opened with. */
  platform: AnyPlatform
  /**
   * Disruptive commands only: the hostname the user typed to confirm. The host compares it with the
   * hostname in the device prompt before it sends anything.
   */
  ack?: string
  /**
   * Config and disruptive lines: the device hostnames the approval was given for (the prompt
   * hostname when the proposal was made, plus a new one the proposal itself sets). The host refuses
   * the line when the prompt shows another device (a nested ssh/telnet hop).
   */
  hosts?: string[]
  /**
   * Global read-only mode was on when main signed (review Low 5): the host then refuses anything
   * but a read, whatever the kind says.
   */
  readOnly?: boolean
  /** Auto-detect probe only: the candidate platforms on which the probe was classified read-only. */
  probe?: PlatformId[]
  /**
   * An app-owned safety-net line (cli-model safety-net.ts: arm, commit under a timer, confirm,
   * roll back). Only main's safety-net flow sets it. The host then skips the deny-list for this one
   * line and accepts it only when it matches one of the platform's fixed net templates, in the
   * template's mode, bound to the approved device. The agent's own lines never carry it.
   */
  net?: true
  exp: number
  nonce: string
}

const TTL_MS = 60_000

/** Every field the MAC covers; a token with any other key is refused (A-L5). */
const SIGNED_KEYS = new Set(['tabId', 'command', 'kind', 'platform', 'ack', 'hosts', 'probe', 'readOnly', 'net', 'exp', 'nonce'])

export function newKey(): string {
  return randomBytes(32).toString('base64')
}

const mac = (key: string, v: Verdict) =>
  createHmac('sha256', Buffer.from(key, 'base64'))
    .update(JSON.stringify([v.tabId, v.command, v.kind, v.platform, v.ack ?? null, v.hosts ?? null, v.probe ?? null, v.readOnly ?? null, v.net ?? null, v.exp, v.nonce]))
    .digest('base64url')

export function sign(key: string, v: Omit<Verdict, 'exp' | 'nonce'>, now = Date.now()): string {
  const full: Verdict = { ...v, exp: now + TTL_MS, nonce: randomBytes(9).toString('base64url') }
  return Buffer.from(JSON.stringify(full)).toString('base64url') + '.' + mac(key, full)
}

/** Returns the verdict when the token is authentic, unexpired and for exactly this tab and command. */
export function verify(key: string, token: string, tabId: string, command: string, now = Date.now()): Verdict | null {
  // Phase 8 A-L5: exactly body.sig, and no field the MAC does not cover.
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts as [string, string]
  if (!body || !sig) return null
  let v: Verdict
  try {
    v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Verdict
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !SIGNED_KEYS.has(k))) return null
  const want = Buffer.from(mac(key, v))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  if (v.tabId !== tabId || v.command !== command || v.exp < now) return null
  return v
}
