import { PROVIDERS, isAccount, providerName } from '@shared/providers'
import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { z } from 'zod'
import { PLATFORMS } from '@hopline/guard'
import { parseEndpoint } from '@shared/ollama'
import { NO_LOCKS, type PolicyInfo, type PolicyLocks } from '@shared/policy'
import { POLICY_INVALID_RULE } from '@shared/policy-deny'
import { parseDsn } from '@shared/privacy'

/**
 * Team policy file (docs/POLICY.md). JSON, validated with zod, loaded once at start in main.
 *
 * Where it is read from:
 *  1. the admin-managed location for the OS (below). When a file exists there, it is the policy:
 *     nothing a user can set (an environment variable) replaces it;
 *  2. otherwise `HOPLINE_POLICY` (a file path), for deployments that set it in a managed
 *     environment, and for tests. A path that is set but missing or unreadable fails closed.
 *  3. otherwise: no policy.
 *
 * An invalid policy (unreadable, not JSON, an unknown key, a bad value) fails closed: read-only
 * on, AI off, and a banner with the reason.
 */

export const POLICY_ENV = 'HOPLINE_POLICY'
/** The largest policy file read (a policy is a few lines; anything larger is refused). */
export const MAX_POLICY_BYTES = 256 * 1024

/**
 * Windows: the machine-wide ProgramData folder, from the registry (HKLM, admin-writable), never from
 * the `ProgramData` environment variable a user controls (review L7). Falls back to
 * `C:\ProgramData` when the registry cannot be read or holds something unexpected.
 */
export function windowsProgramData(query: () => string = regQueryCommonAppData): string {
  try {
    const m = /Common AppData\s+REG_SZ\s+([A-Za-z]:\\[^\r\n%]*?)\s*$/m.exec(query())
    if (m) return m[1]!.replace(/\\+$/, '')
  } catch {
    // fall through to the default
  }
  return 'C:\\ProgramData'
}

function regQueryCommonAppData(): string {
  // The absolute path of reg.exe, so PATH cannot substitute another program.
  return execFileSync('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', 'Common AppData'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
}

export function adminPolicyPath(platform: NodeJS.Platform = process.platform, programData: () => string = windowsProgramData): string {
  if (platform === 'win32') return `${programData()}\\Hopline\\policy.json`
  if (platform === 'darwin') return '/Library/Application Support/Hopline/policy.json'
  return '/etc/hopline/policy.json'
}

const PATTERN = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x20-\x7e]+$/, 'printable ASCII only')
const PLATFORM_KEYS = ['all', ...PLATFORMS] as const

const Endpoint = z
  .string()
  .max(300)
  .refine((s) => !!parseEndpoint(s), 'must be an http:// or https:// URL without credentials')

export const PolicySchema = z
  .object({
    /** Format version; only 1 exists. */
    version: z.literal(1),
    /** Shown in the banner and the "Managed by" labels. */
    name: z.string().trim().min(1).max(80).optional(),
    /** One line for users: who to contact, why. */
    message: z.string().trim().min(1).max(300).optional(),
    readOnly: z.boolean().optional(),
    blockedCommands: z.partialRecord(z.enum(PLATFORM_KEYS), z.array(PATTERN).max(200)).optional(),
    allowedProviders: z.array(z.enum(PROVIDERS)).max(PROVIDERS.length).optional(),
    allowedOllamaEndpoints: z.array(Endpoint).min(1).max(50).optional(),
    fleet: z
      .object({
        maxConcurrency: z.number().int().min(1).max(8).optional(),
        maxTokenBudget: z.number().int().min(20_000).max(4_000_000).optional()
      })
      .strict()
      .optional(),
    maxRunTokenBudget: z.number().int().min(5_000).max(4_000_000).optional(),
    requireEgressLog: z.boolean().optional(),
    /** `true`: Hopline never checks for updates (Settings shows "Managed by policy"). */
    disableUpdates: z.boolean().optional(),
    updateChannel: z.enum(['stable', 'beta']).optional(),
    /** `true`: crash reports cannot be turned on. A policy can never turn them on for a user. */
    disableCrashReports: z.boolean().optional(),
    /** Where opted-in crash reports go (a self-hosted Sentry or GlitchTip DSN). */
    crashReportDsn: z
      .string()
      .max(300)
      .refine((s) => !!parseDsn(s), 'must be a Sentry DSN: https://<public key>@<host>/<project id>')
      .optional()
  })
  .strict()

export type Policy = z.infer<typeof PolicySchema>

const originOf = (e: string): string => {
  const u = parseEndpoint(e)!
  return `${u.protocol}//${u.host}`
}

export function locksOf(p: Policy): PolicyLocks {
  const blocked: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(p.blockedCommands ?? {})) if (v?.length) blocked[k] = v.map((s) => s.trim())
  return {
    readOnly: !!p.readOnly,
    allowedProviders: p.allowedProviders ? [...new Set(p.allowedProviders)] : null,
    allowedOllamaEndpoints: p.allowedOllamaEndpoints ? p.allowedOllamaEndpoints.map(originOf) : null,
    blockedCommands: blocked,
    fleetMaxConcurrency: p.fleet?.maxConcurrency ?? null,
    fleetMaxTokenBudget: p.fleet?.maxTokenBudget ?? null,
    runMaxTokenBudget: p.maxRunTokenBudget ?? null,
    egressLogRequired: !!p.requireEgressLog,
    aiDisabled: false,
    updatesDisabled: !!p.disableUpdates,
    updateChannel: p.updateChannel ?? null,
    crashReportsDisabled: !!p.disableCrashReports,
    crashReportDsn: p.crashReportDsn ?? null
  }
}

/**
 * Fail closed: read-only on, AI off, logging required, and every command Hopline sends refused
 * (snippets, backups, send-to-many too: the broken file may have meant to block them; review L7).
 */
export const FAIL_CLOSED: PolicyLocks = {
  ...NO_LOCKS,
  readOnly: true,
  allowedProviders: [],
  egressLogRequired: true,
  aiDisabled: true,
  blockedCommands: { all: [POLICY_INVALID_RULE] },
  // Nothing leaves the machine on its own either: the broken file may have been meant for an
  // air-gapped network. The red banner says why updates stopped.
  updatesDisabled: true,
  crashReportsDisabled: true
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A duplicate key in any object (JSON.parse silently keeps the last one), or a prototype key, in a
 * text JSON.parse accepted. Returns a description of the first one, or null.
 */
export function suspiciousKey(text: string): string | null {
  const stack: { obj: boolean; keys: Set<string>; expectKey: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const top = stack.at(-1)
      if (top?.obj && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string
        if (FORBIDDEN_KEYS.has(key)) return `the key "${key}" is not allowed`
        if (top.keys.has(key)) return `the key "${key}" appears twice in one object`
        top.keys.add(key)
        top.expectKey = false
      }
      i = j
    } else if (ch === '{' || ch === '[') stack.push({ obj: ch === '{', keys: new Set(), expectKey: ch === '{' })
    else if (ch === '}' || ch === ']') stack.pop()
    else if (ch === ',') {
      const top = stack.at(-1)
      if (top?.obj) top.expectKey = true
    }
  }
  return null
}

/**
 * The file's bytes as text: UTF-8 (with or without a BOM, as Notepad writes it) or UTF-16 with a
 * BOM (PowerShell 5 `Out-File`). Invalid text throws.
 */
export function decodePolicy(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buf.subarray(2))
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
}

/** Validate a policy text. Pure (the tests use it directly). */
export function parsePolicy(text: string, source: string): PolicyInfo {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { state: 'invalid', source, error: `not valid JSON (${e instanceof Error ? e.message.slice(0, 120) : 'parse error'})`, locks: FAIL_CLOSED }
  }
  const odd = suspiciousKey(text)
  if (odd) return { state: 'invalid', source, error: odd, locks: FAIL_CLOSED }
  const r = PolicySchema.safeParse(raw)
  if (!r.success) {
    const issue = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'policy'}: ${i.message}`).join('; ')
    return { state: 'invalid', source, error: issue, locks: FAIL_CLOSED }
  }
  return { state: 'active', source, name: r.data.name ?? null, message: r.data.message ?? null, locks: locksOf(r.data) }
}

function readPolicy(path: string): PolicyInfo {
  // One descriptor for the check and the read, so the file cannot be swapped in between.
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const st = fstatSync(fd)
    if (!st.isFile()) return { state: 'invalid', source: path, error: 'not a regular file', locks: FAIL_CLOSED }
    if (st.size > MAX_POLICY_BYTES) return { state: 'invalid', source: path, error: `larger than ${MAX_POLICY_BYTES / 1024} KB`, locks: FAIL_CLOSED }
    const buf = Buffer.alloc(MAX_POLICY_BYTES + 1)
    let n = 0
    for (let r = 1; n < buf.length && r > 0; n += r) r = readSync(fd, buf, n, buf.length - n, null)
    if (n > MAX_POLICY_BYTES) return { state: 'invalid', source: path, error: `larger than ${MAX_POLICY_BYTES / 1024} KB`, locks: FAIL_CLOSED }
    let text: string
    try {
      text = decodePolicy(buf.subarray(0, n))
    } catch {
      return { state: 'invalid', source: path, error: 'not valid UTF-8 or UTF-16 text', locks: FAIL_CLOSED }
    }
    return parsePolicy(text, path)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error'
    if (code === 'EISDIR') return { state: 'invalid', source: path, error: 'not a regular file', locks: FAIL_CLOSED }
    return { state: 'invalid', source: path, error: code === 'ENOENT' ? 'the file does not exist' : `cannot be read (${code})`, locks: FAIL_CLOSED }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const exists = (p: string): boolean => {
  try {
    // lstat: a symlink whose target is missing is there (and fails closed when read), not absent.
    lstatSync(p)
    return true
  } catch (e) {
    // Present but not stat-able (EACCES on a parent): treat as there, so reading it fails closed.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR'
  }
}

export interface LoadOptions {
  adminPath?: string
  env?: NodeJS.ProcessEnv
}

/** Find and load the policy (see the module comment for the order). */
export function loadPolicy(o: LoadOptions = {}): PolicyInfo {
  const env = o.env ?? process.env
  const admin = o.adminPath ?? adminPolicyPath(process.platform)
  if (exists(admin)) return readPolicy(admin)
  const fromEnv = env[POLICY_ENV]?.trim()
  if (fromEnv) return readPolicy(fromEnv)
  return { state: 'none', source: null, locks: NO_LOCKS }
}

/** The loaded policy, held in main. Tests build one from a PolicyInfo. */
export class PolicyService {
  constructor(readonly info: PolicyInfo) {}

  get locks(): PolicyLocks {
    return this.info.locks
  }

  static none(): PolicyService {
    return new PolicyService({ state: 'none', source: null, locks: NO_LOCKS })
  }

  /** Why the AI may not be used at all, or null. */
  aiOff(): string | null {
    if (this.info.state === 'invalid') return `AI is turned off: the team policy file ${this.info.source} is invalid (${this.info.error}). Read-only mode is on. Ask your administrator to fix it.`
    return null
  }

  /** Why this provider may not be used, or null. */
  providerRefusal(provider: typeof PROVIDERS[number], endpoint?: string): string | null {
    const off = this.aiOff()
    if (off) return off
    const allowed = this.locks.allowedProviders
    const label = provider === 'ollama' ? 'Ollama' : `${providerName(provider)} (cloud)`
    if (allowed && !allowed.includes(provider)) return `${label} is not allowed by the team policy (allowed: ${allowed.length ? allowed.join(', ') : 'none'}).`
    if (isAccount(provider) && this.locks.egressLogRequired) return 'Team policy requires the complete network request. An account client only exposes the masked prompt Hopline hands to it.'
    if (provider === 'ollama' && endpoint !== undefined && this.locks.allowedOllamaEndpoints) {
      const u = parseEndpoint(endpoint)
      const origin = u ? `${u.protocol}//${u.host}` : ''
      if (!this.locks.allowedOllamaEndpoints.includes(origin)) return `This Ollama server is not allowed by the team policy (allowed: ${this.locks.allowedOllamaEndpoints.join(', ')}).`
    }
    return null
  }
}
