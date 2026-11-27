import { redact } from '@hopline/guard'
import type { FleetScopeDevice, FleetScopeSpec, FleetUnmatched } from '@shared/fleet'
import type { CredentialInfo, Folder, Session } from '@shared/types'
import type { AuditLog } from '../db/audit'
import type { TabControl } from '../host/client'
import { DeviceTools } from '../agent/device-tools'
import type { SettingsService } from '../settings'
import type { LanePool } from './pool'
import { matchSession, parseNeighbors, TOPOLOGY_COMMANDS, type Neighbor } from './topology'
import { fleetAudit, Refusals } from './worker'

/**
 * Scope resolution (FLEET-AGENT §2), in main only: the renderer names sessions, folders, tags or a
 * topology seed; this decides which saved sessions the run may touch and why the others may not.
 * The result is stored by id; the user's final selection from it is frozen when the run starts
 * (run.ts resolves device names only against it).
 *
 * The topology walk (review H2): neighbour names and addresses are device-controlled text, so:
 * - a match is only ever PROPOSED (`optIn`: unselected until the user ticks it), with how it matched;
 * - the walk connects only to sessions whose host key is already stored (no first-use trust here);
 * - past the first hop it walks only through matches in the seed's folder (with subfolders) or
 *   sharing one of its tags: a spoofed name elsewhere is listed, never logged into;
 * - at most MAX_FLEET_DEVICES connections per walk, and the walk stops when the cap is reached;
 * - the walk is cancelled with the asking window (service.ts passes the signal).
 */

export const MAX_FLEET_DEVICES = 32
export const MAX_TOPOLOGY_HOPS = 2
export const MAX_UNMATCHED = 50
/** Devices a preview may list (the user then selects at most MAX_FLEET_DEVICES of them). */
export const MAX_SCOPE_CANDIDATES = 200

export interface ScopeRepo {
  listSessions(): Session[]
  /** Folder names are used by @folder/ mentions (F11) only. */
  listFolders(): (Pick<Folder, 'id' | 'parentId'> & { name?: string })[]
  getSession(id: string): Session | undefined
  getCredential(id: string): Pick<CredentialInfo, 'kind'> | undefined
  /** Stored SSH host keys for host:port (the topology walk only connects where one is known). */
  hostKeys(host: string, port: number): string[]
}

export interface ScopeDeps {
  repo: ScopeRepo
  /** For the topology walk: background tabs, guarded reads, audit (source `fleet`). */
  pool?: LanePool
  term?: TabControl
  settings?: Pick<SettingsService, 'get'>
  audit?: Pick<AuditLog, 'append'>
}

export interface ResolvedScope {
  devices: FleetScopeDevice[]
  unmatched: FleetUnmatched[]
  walked: { device: string; command: string; status: string }[]
}

function subtree(folderId: string, folders: Pick<Folder, 'id' | 'parentId'>[]): Set<string> {
  const ids = new Set([folderId])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
  }
  return ids
}

/**
 * Why a session can't be a lane, or null. The rules of background connections (multi-device runs,
 * backups): stored credentials only, a known platform, SSH. A lane never uses the user's open tab
 * (it may be at a nested hop to another device, and the user may be typing in it).
 */
export function exclusion(s: Session, repo: Pick<ScopeRepo, 'getCredential'>): string | null {
  if (s.ephemeral) return 'a quick-connect session can\'t be used in a fleet run: save it first'
  if (s.platform === 'auto') return 'the platform is not known yet: connect once so Hopline can detect it, or set it in the session'
  if (s.protocol === 'serial') return 'serial ports are not used in fleet runs'
  if (s.protocol !== 'ssh') return 'telnet sign-in is typed at the device, which a background connection can\'t do'
  const cred = s.credentialId ? repo.getCredential(s.credentialId) : undefined
  if (!cred && !s.options.ssh?.useAgent) return 'needs sign-in: give the session a stored credential'
  if (cred?.kind === 'prompt') return 'needs sign-in: its credential asks for the password every time'
  return null
}

export class FleetScope {
  constructor(private readonly d: ScopeDeps) {}

  /** Sessions, folders and tags; then, for a topology seed, a CDP/LLDP walk of up to two hops. */
  async resolve(spec: FleetScopeSpec, signal?: AbortSignal, scopeId = 'scope'): Promise<ResolvedScope> {
    const repo = this.d.repo
    const sessions = repo.listSessions().filter((s) => !s.ephemeral)
    const out = new Map<string, FleetScopeDevice>()
    const add = (s: Session, via: FleetScopeDevice['via'], extra: Partial<FleetScopeDevice> = {}) => {
      if (out.has(s.id)) return
      const why = exclusion(s, repo)
      out.set(s.id, { sessionId: s.id, name: s.name, platform: s.platform, tags: [...s.tags], via, ...extra, ...(why ? { excluded: why } : {}) })
    }
    const wanted = new Set(spec.sessions ?? [])
    const folders = repo.listFolders()
    const inFolders = new Set((spec.folders ?? []).flatMap((f) => [...subtree(f, folders)]))
    const tags = new Set((spec.tags ?? []).map((t) => t.toLowerCase()))
    for (const s of sessions) {
      if (wanted.has(s.id)) add(s, 'session')
      else if (s.folderId && inFolders.has(s.folderId)) add(s, 'folder')
      else if (s.tags.some((t) => tags.has(t.toLowerCase()))) add(s, 'tag')
    }
    const unmatched: FleetUnmatched[] = []
    const walked: ResolvedScope['walked'] = []
    if (spec.topology) {
      const seed = repo.getSession(spec.topology.seed)
      if (!seed || seed.ephemeral) throw new Error('The starting device is not a saved session')
      add(seed, 'seed')
      await this.walk(seed, Math.min(Math.max(1, spec.topology.hops), MAX_TOPOLOGY_HOPS), sessions, out, add, unmatched, walked, signal, scopeId)
    }
    if (signal?.aborted) throw new Error('stopped')
    const devices = [...out.values()]
    // Names are the only handle a model has on a device: they must be unique in the scope.
    const names = new Map<string, FleetScopeDevice>()
    for (const d of devices) {
      const k = d.name.trim().toLowerCase()
      if (d.excluded) continue
      if (names.has(k)) d.excluded = `another device in the scope is also named "${d.name}": rename one`
      else names.set(k, d)
    }
    if (devices.length > MAX_SCOPE_CANDIDATES) throw new Error(`Narrow the scope: it lists ${devices.length} devices; pick at most ${MAX_SCOPE_CANDIDATES} to choose from (a run reaches ${MAX_FLEET_DEVICES})`)
    return { devices, unmatched: unmatched.slice(0, MAX_UNMATCHED), walked }
  }

  private async walk(
    seed: Session,
    hops: number,
    sessions: Session[],
    out: Map<string, FleetScopeDevice>,
    add: (s: Session, via: FleetScopeDevice['via'], extra?: Partial<FleetScopeDevice>) => void,
    unmatched: FleetUnmatched[],
    walked: ResolvedScope['walked'],
    signal: AbortSignal | undefined,
    scopeId: string
  ): Promise<void> {
    const { pool, term, settings, audit } = this.d
    if (!pool || !term || !settings || !audit) throw new Error('The topology walk is not available')
    // Past the first hop, walk only through the seed's own neighbourhood: its folder subtree or its tags.
    const home = seed.folderId ? subtree(seed.folderId, this.d.repo.listFolders()) : null
    const seedTags = new Set(seed.tags.map((t) => t.toLowerCase()))
    const near = (s: Session) => (home !== null && !!s.folderId && home.has(s.folderId)) || s.tags.some((t) => seedTags.has(t.toLowerCase()))
    const done = new Set<string>()
    let connections = 0
    let frontier: Session[] = [seed]
    for (let hop = 0; hop < hops && frontier.length; hop++) {
      const next: Session[] = []
      for (const s of frontier) {
        if (signal?.aborted) return
        if (done.has(s.id)) continue
        done.add(s.id)
        if (exclusion(s, this.d.repo)) continue
        if (hop > 0 && !near(s)) {
          walked.push({ device: s.name, command: '', status: 'not walked: outside the starting device\'s folder and tags' })
          continue
        }
        if (!this.d.repo.hostKeys(s.host, s.port).length) {
          walked.push({ device: s.name, command: '', status: 'not walked: no stored host key (connect to it once first)' })
          continue
        }
        if (connections >= MAX_FLEET_DEVICES) {
          walked.push({ device: s.name, command: '', status: `not walked: the walk stops after ${MAX_FLEET_DEVICES} devices` })
          continue
        }
        connections++
        const neighbors = await this.neighbors(s, walked, signal, scopeId)
        for (const n of neighbors) {
          const m = matchSession(n, sessions)
          if (!m) {
            if (!unmatched.some((u) => u.name === n.shown)) unmatched.push({ name: n.shown, ...(n.ip ? { ip: n.ip } : {}), seenFrom: s.name })
            continue
          }
          if (out.size >= MAX_SCOPE_CANDIDATES) break
          add(m.session, 'topology', { optIn: true, match: { by: m.by, neighbor: n.shown, seenFrom: s.name } })
          if (!done.has(m.session.id) && next.length < MAX_FLEET_DEVICES) next.push(m.session)
        }
      }
      frontier = next
    }
  }

  /** Run the platform's neighbour commands on one device (background tab, guarded, audited) and parse them. */
  private async neighbors(s: Session, walked: ResolvedScope['walked'], signal: AbortSignal | undefined, scopeId: string): Promise<Neighbor[]> {
    const { pool, term, settings, audit } = this.d as Required<ScopeDeps>
    const commands = TOPOLOGY_COMMANDS[s.platform]
    if (!commands) {
      walked.push({ device: s.name, command: '', status: `the topology walk does not support ${s.platform} yet` })
      return []
    }
    const a = fleetAudit(audit, scopeId, s.name)
    let lease: Awaited<ReturnType<LanePool['acquire']>>
    try {
      lease = await pool.acquire(s, signal)
    } catch (e) {
      const why = signal?.aborted ? 'stopped' : `could not connect: ${e instanceof Error ? e.message : String(e)}`
      walked.push({ device: s.name, command: '', status: why })
      a.append({ sessionId: s.id, sessionName: s.name, host: s.host, command: '(connect)', kind: 'read', decision: signal?.aborted ? 'cancelled' : 'error', reason: `fleet scope walk: ${why}`.slice(0, 500), approver: null, durationMs: null, bytes: null, redactions: null, source: 'fleet' })
      return []
    }
    try {
      const outputs = new Map<string, string>()
      const recording: TabControl = {
        get policyRules() {
          return term.policyRules
        },
        get: (id) => term.get(id),
        mode: (t) => term.mode(t),
        prompt: (t) => term.prompt(t),
        exec: async (t, command, kind, opts) => {
          const r = await term.exec(t, command, kind, opts)
          if (kind === 'read' && r.status === 'ok') outputs.set(command, redact(r.output).text)
          return r
        }
      }
      const tools = new DeviceTools(lease.tab, { term: recording, settings, audit: a, emit: () => {} }, new Refusals(a, () => {}))
      const found: Neighbor[] = []
      for (const command of commands) {
        if (signal?.aborted) break
        const r = await tools.call('run_show_command', { command, reason: 'fleet scope: topology walk' }, { runId: scopeId, signal: signal ?? new AbortController().signal })
        walked.push({ device: s.name, command, status: r.isError ? r.text.split(':')[0]!.toLowerCase() : 'ok' })
        const text = outputs.get(command)
        if (text !== undefined) for (const n of parseNeighbors(s.platform, command, text)) if (!found.some((f) => f.name === n.name)) found.push(n)
      }
      return found
    } finally {
      lease.release()
    }
  }
}
