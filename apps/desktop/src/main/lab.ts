/**
 * The bundled lab serves two switches and a FortiGate/Palo Alto site VPN on loopback.
 * Each device has an SSH session, and the core switch also has a Telnet session.
 *
 * - Loopback only, ephemeral ports, started on demand (onboarding or the palette), stopped on quit.
 * - The SSH host key is generated once and kept in the profile (0600), and main trusts it for the
 *   ports it just bound: the lab never asks to trust a key, and TOFU for real hosts is unchanged.
 * - The lab's sessions are re-pointed at the live ports each time it starts (created again if the
 *   user deleted them).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { generateEd25519, makeFirewallLab, makeEosDevice, makeIosDevice, startSim, startTelnetSim, type RunningSim, type RunningTelnetSim } from '@hopline/simulator'
import { utils } from 'ssh2'
import type { Session, SessionInput } from '@shared/types'
import { LAB_NOTE } from './db'
import { isLocked } from './vault/datakey'
import type { Repo } from './db/repo'

/** Populate only a development profile. */
export async function seedDevelopmentSessions(repo: Repo): Promise<void> {
  if (repo.listSessions().length || repo.getSetting('seeded')) return
  const folder = repo.saveFolder({ name: 'Lab (simulator)', parentId: null })
  let credId: string | null = null
  try {
    credId = (await repo.saveCredential({ name: 'Simulator admin', username: 'admin', kind: 'password', secret: 'admin' })).id
  } catch {
    // Vault locked or unavailable: sessions will prompt for the password instead.
  }
  const base = { folderId: folder.id, host: '127.0.0.1', protocol: 'ssh' as const, username: 'admin', credentialId: credId, logToFile: false, notes: LAB_NOTE, options: {} }
  // Tests point the seeded lab at their own simulator ports.
  const [p1, p2, t1] = (process.env['HOPLINE_SEED_PORTS'] ?? '2201,2202,2301').split(',').map(Number)
  const a = repo.saveSession({ ...base, name: 'core-sw1', port: p1 || 2201, platform: 'iosxe' })
  const b = repo.saveSession({ ...base, name: 'dist-eos1', port: p2 || 2202, platform: 'eos' })
  const c = repo.saveSession({ ...base, name: 'core-sw1 (telnet)', protocol: 'telnet', credentialId: null, port: t1 || 2301, platform: 'iosxe' })
  // The lab's objects by id (lab.ts LAB_SETTING): a same-named folder of the user's is never taken for it.
  repo.setSetting('ux.lab', JSON.stringify({ folderId: folder.id, sessions: { [a.name]: a.id, [b.name]: b.id, [c.name]: c.id } }))
  repo.setSetting('seeded', '1')
}

export const LAB_FOLDER = 'Lab (simulator)'
/** Where the lab keeps the ids of its own folder and sessions (review L7). */
export const LAB_SETTING = 'ux.lab'
interface LabRecord {
  folderId: string | null
  /** Device name → session id. */
  sessions: Record<string, string>
}

type LabDevice = { name: string; protocol: 'ssh' | 'telnet'; platform: 'iosxe' | 'eos' | 'fortios' | 'panos'; device: 'ios' | 'eos' | 'fortios' | 'panos' }
const DEVICES: LabDevice[] = [
  { name: 'core-sw1', protocol: 'ssh', platform: 'iosxe', device: 'ios' },
  { name: 'dist-eos1', protocol: 'ssh', platform: 'eos', device: 'eos' },
  { name: 'core-sw1 (telnet)', protocol: 'telnet', platform: 'iosxe', device: 'ios' },
  { name: 'fgt-edge1', protocol: 'ssh', platform: 'fortios', device: 'fortios' },
  { name: 'fw1', protocol: 'ssh', platform: 'panos', device: 'panos' }
]

export interface LabInfo {
  running: boolean
  /** The lab's sessions, first one first (the one onboarding connects to). */
  sessionIds: string[]
}

/** OpenSSH SHA256 fingerprint of a PEM/OpenSSH private key's public half. */
export function hostKeyFingerprint(privateKey: string): string {
  const k = utils.parseKey(privateKey)
  if (k instanceof Error) throw k
  const key = Array.isArray(k) ? k[0]! : k
  return 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')
}

export class SimulatorLab {
  private running: { ssh: RunningSim[]; telnet: RunningTelnetSim[]; ids: string[] } | null = null
  private starting: Promise<LabInfo> | null = null

  constructor(
    private readonly repo: Repo,
    /** Where the lab's host key is kept (the profile directory). */
    private readonly keyPath: string
  ) {}

  info(): LabInfo {
    return { running: !!this.running, sessionIds: this.running?.ids ?? [] }
  }

  private hostKey(): string {
    if (existsSync(this.keyPath)) {
      const k = readFileSync(this.keyPath, 'utf8')
      if (!(utils.parseKey(k) instanceof Error)) return k
    }
    const { private: k } = generateEd25519({ comment: 'hopline-lab' })
    writeFileSync(this.keyPath, k, { mode: 0o600 })
    return k
  }

  /** Start the lab (once) and point its sessions at it. */
  start(): Promise<LabInfo> {
    if (this.running) return Promise.resolve(this.info())
    this.starting ??= this.boot().finally(() => (this.starting = null))
    return this.starting
  }

  private async boot(): Promise<LabInfo> {
    const hostKey = this.hostKey()
    const fp = hostKeyFingerprint(hostKey)
    // One device state per platform, shared by its SSH and Telnet listeners (like `npm run sim`).
    const devices = { ios: makeIosDevice(), eos: makeEosDevice(), ...makeFirewallLab() }
    const ssh: RunningSim[] = []
    const telnet: RunningTelnetSim[] = []
    try {
      const ports: number[] = []
      for (const d of DEVICES) {
        if (d.protocol === 'ssh') {
          // A loopback port the user already trusts another key for (their own local forward, say)
          // is left alone (review L7): bind another one instead of overwriting their key.
          let sim = await startSim({ device: devices[d.device], port: 0, host: '127.0.0.1', hostKey })
          for (let tries = 0; this.conflicts(sim.port, fp) && tries < 8; tries++) {
            const next = await startSim({ device: devices[d.device], port: 0, host: '127.0.0.1', hostKey })
            await sim.close()
            sim = next
          }
          ssh.push(sim)
          if (this.conflicts(sim.port, fp)) throw new Error('No free loopback port for the lab')
          ports.push(sim.port)
        } else {
          const sim = await startTelnetSim({ device: devices[d.device], port: 0, host: '127.0.0.1' })
          telnet.push(sim)
          ports.push(sim.port)
        }
      }
      await this.repairCredential()
      const ids = this.pointSessions(ports)
      // Main made this key: trust it for exactly the ports it bound, so the lab never asks. Added,
      // never replacing: those ports had no other key (checked above).
      DEVICES.forEach((d, i) => d.protocol === 'ssh' && this.repo.addHostKey('127.0.0.1', ports[i]!, fp, 'user'))
      this.running = { ssh, telnet, ids }
      return this.info()
    } catch (e) {
      await Promise.allSettled([...ssh.map((s) => s.close()), ...telnet.map((s) => s.close())])
      throw e
    }
  }

  /**
   * The lab's own login ("Simulator admin", admin/admin) must be readable, or connections that
   * cannot prompt (multi-device runs, fleet workers, backups) fail with "login prompt cancelled".
   * A session-only vault (no OS keychain) loses its key at every quit, so the credential seeded in
   * an earlier run can't be decrypted any more: write it again under this run's key. Only the lab's
   * well-known password is written; a locked vault is left alone (the session prompts instead).
   */
  private async repairCredential(): Promise<void> {
    // A credential the user deleted stays deleted: the lab's sessions then prompt.
    const cred = this.repo.listCredentials().find((c) => c.name === 'Simulator admin' && c.username === 'admin')
    if (!cred) return
    try {
      if ((await this.repo.resolveCredential(cred.id))?.secret !== undefined) return
    } catch (e) {
      if (isLocked(e)) return
      // Not decryptable under this run's key: written again below.
    }
    await this.repo.saveCredential({ id: cred.id, name: 'Simulator admin', username: 'admin', kind: 'password', secret: 'admin' }).catch(() => undefined)
  }

  /** Another key is already trusted for 127.0.0.1:port. */
  private conflicts(port: number, fp: string): boolean {
    const keys = this.repo.hostKeys('127.0.0.1', port)
    return keys.length > 0 && !keys.includes(fp)
  }

  /**
   * The lab's own folder and sessions, by id (review L7): a folder or session of the user's that
   * only shares a name is never repointed. Ids are kept under LAB_SETTING. A profile from before
   * the ids were kept adopts its seeded folder once, and only if every session in it is on
   * loopback (what the seeded lab is); anything else gets a new lab folder.
   */
  private record(): LabRecord {
    try {
      const r = JSON.parse(this.repo.getSetting(LAB_SETTING) ?? 'null') as LabRecord | null
      if (r && typeof r.folderId === 'string' && r.sessions && typeof r.sessions === 'object') return r
    } catch {
      // unreadable: start over
    }
    return { folderId: null, sessions: {} }
  }

  /** Find (or recreate) the lab folder's sessions and set their ports. Returns their ids in DEVICES order. */
  private pointSessions(ports: number[]): string[] {
    const rec = this.record()
    const folders = this.repo.listFolders()
    const all = this.repo.listSessions()
    const loopback = (s: Session) => /^(127\.0\.0\.1|localhost|::1)$/i.test(s.host)
    let folder = folders.find((f) => f.id === rec.folderId)
    let legacy = false
    if (!folder && rec.folderId === null) {
      folder = folders.find((f) => f.name === LAB_FOLDER && f.parentId === null && all.filter((s) => s.folderId === f.id).every(loopback))
      legacy = !!folder
    }
    folder ??= this.repo.saveFolder({ name: LAB_FOLDER, parentId: null })
    const sessions = all.filter((s) => s.folderId === folder.id)
    const cred = this.repo.listCredentials().find((c) => c.name === 'Simulator admin' && c.username === 'admin')
    const ids = DEVICES.map((d, i) => {
      const byId = rec.sessions[d.name] ? this.repo.getSession(rec.sessions[d.name]!) : undefined
      const firewall = d.platform === 'fortios' || d.platform === 'panos'
      const cur: Session | undefined = byId ?? (legacy && !firewall ? sessions.find((s) => s.name === d.name && loopback(s)) : undefined)
      const input: SessionInput = cur
        ? { ...cur, host: '127.0.0.1', port: ports[i]! }
        : {
            name: d.name,
            folderId: folder.id,
            host: '127.0.0.1',
            port: ports[i]!,
            protocol: d.protocol,
            platform: d.platform,
            username: 'admin',
            credentialId: d.protocol === 'ssh' ? (cred?.id ?? null) : null,
            logToFile: false,
            notes: firewall ? 'VPN lab. Investigate why 10.100.0.10 cannot reach 10.20.0.50 across the site tunnel. Password: admin.' : LAB_NOTE,
            tags: firewall ? ['vpn-lab'] : [],
            options: {}
          }
      if (cur && cur.host === '127.0.0.1' && cur.port === ports[i]) return cur.id
      return this.repo.saveSession(input).id
    })
    this.repo.setSetting(LAB_SETTING, JSON.stringify({ folderId: folder.id, sessions: Object.fromEntries(DEVICES.map((d, i) => [d.name, ids[i]!])) } satisfies LabRecord))
    return ids
  }

  async stop(): Promise<void> {
    const r = this.running
    this.running = null
    if (r) await Promise.allSettled([...r.ssh.map((s) => s.close()), ...r.telnet.map((s) => s.close())])
  }
}
