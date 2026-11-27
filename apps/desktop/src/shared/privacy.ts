/**
 * Updates and crash reports (Phase 7, decisions D7 and D8): what the renderer learns about them.
 * Pure types and helpers, no Node APIs. The updater and the crash reporter live in main.
 */
import type { UpdateChannel } from './policy'

export type { UpdateChannel }

/**
 * How this install can update itself:
 * - `auto`: download in the background, install when Hopline quits. Only where the update's signature
 *   is checked before it runs: signed Windows (with a publisher name) and signed macOS;
 * - `notify`: say a new version exists and link to it (every Linux package, unsigned Windows and macOS),
 *   because nothing would check the download's signature, or installing would need a root prompt.
 */
export type UpdateMode = 'auto' | 'notify'

export type UpdateState =
  /** Never checked in this run. */
  | { kind: 'idle' }
  /** Checks are off: by the team policy, by the user, before the privacy screen, or in a dev build. */
  | { kind: 'off'; reason: 'policy' | 'setting' | 'consent' | 'dev' }
  | { kind: 'checking' }
  | { kind: 'current'; checkedAt: number }
  /** A newer version exists. In `notify` mode this is the end state; `url` is its release page. */
  | { kind: 'available'; version: string; url: string | null }
  | { kind: 'downloading'; version: string; percent: number }
  /** Downloaded and verified: installs when Hopline quits. */
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string; at: number }

export interface UpdateStatus {
  state: UpdateState
  current: string
  mode: UpdateMode
  channel: UpdateChannel
  autoCheck: boolean
  /** Set by the team policy (docs/POLICY.md). */
  managed: { disabled: boolean; channel: boolean }
  lastCheckedAt: number | null
}

export type RestartResult = { ok: true } | { ok: false; reason: 'sessions'; open: number } | { ok: false; reason: 'not-ready' }

/** A native crash dump kept on this machine. It is process memory and cannot be scrubbed. */
export interface CrashDump {
  id: string
  at: number
  bytes: number
}

export interface CrashStatus {
  /** The user opted in and nothing forbids it. */
  enabled: boolean
  /** The team policy forbids crash reports. */
  managed: boolean
  /** Where reports would go, as "host / project" (never the key). Null: no DSN at all. */
  target: string | null
  /** Which DSN applies. */
  dsnSource: 'policy' | 'user' | 'built-in' | null
  /** Native crash dumps waiting for a decision (sent one at a time, only after a confirmation). */
  dumps: CrashDump[]
}

/** A JavaScript error from the renderer, forwarded to main (which scrubs it before anything leaves). */
export interface RendererError {
  name: string
  message: string
  stack: string
}

export interface Dsn {
  protocol: 'https' | 'http'
  publicKey: string
  host: string
  /** Path before the project id (self-hosted Sentry under a sub-path), without slashes at the ends. */
  path: string
  projectId: string
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i

/**
 * A Sentry/GlitchTip DSN: `https://<public key>@<host>[/path]/<project id>`. A DSN with a secret
 * key (the legacy `key:secret@` form) is refused: the client must never hold a secret. Plain http
 * only to loopback (tests, a local relay).
 */
export function parseDsn(s: string): Dsn | null {
  let u: URL
  try {
    u = new URL(s.trim())
  } catch {
    return null
  }
  const protocol = u.protocol.replace(':', '')
  if (protocol !== 'https' && protocol !== 'http') return null
  if (protocol === 'http' && !LOOPBACK.test(u.hostname)) return null
  if (!u.username || u.password || !/^[A-Za-z0-9]{8,64}$/.test(u.username)) return null
  if (u.search || u.hash) return null
  const parts = u.pathname.split('/').filter(Boolean)
  const projectId = parts.pop()
  if (!projectId || !/^\d{1,20}$/.test(projectId)) return null
  return { protocol, publicKey: u.username, host: u.host, path: parts.join('/'), projectId }
}

/** "sentry.example.com / 42": what Settings shows about a DSN. */
export const dsnTarget = (d: Dsn): string => `${d.host}${d.path ? `/${d.path}` : ''} / ${d.projectId}`

/** The status-bar line for an update that is ready. */
export const UPDATE_READY_TEXT = 'Update ready — restart when you’re done'
