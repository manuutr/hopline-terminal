import { guessPlatform } from './platform'
import type { ImportedSession, ImportResult, ImportWarning } from './types'

/** "/"-joined folder path and name: how `jumpRef` names a session. Just the name at the root. */
export const sessionRef = (s: Pick<ImportedSession, 'folderPath' | 'name'>) => [...s.folderPath, s.name].join('/')

/** A jump hop as the source wrote it: a reference to another session, or a literal host. */
export interface HopSpec {
  /** Session path or name in the source (SecureCRT "Session:Prod/web", ssh_config alias, PuTTY saved session). */
  ref?: string
  host?: string
  port?: number
  user?: string
  /** How to show this hop in notes and warnings. */
  label: string
}

export const hopLabel = (h: { host: string; port?: number; user?: string }) =>
  `${h.user ? `${h.user}@` : ''}${h.host}${h.port && h.port !== 22 ? `:${h.port}` : ''}`

export function addNote(s: ImportedSession, line: string) {
  s.notes = s.notes ? `${s.notes}\n${line}` : line
}

/** Set a platform guessed from the session name, marked as a guess. */
export function guessFromName(s: ImportedSession) {
  const p = guessPlatform(s.name)
  if (p) {
    s.platform = p
    s.platformGuessed = true
  }
}

/**
 * Collects folders, sessions and warnings for one import, then resolves jump
 * hosts and flags duplicates in `finish()`.
 */
export class ResultBuilder {
  private folders: string[][] = []
  private folderKeys = new Set<string>()
  private sessions: ImportedSession[] = []
  private warnings: ImportWarning[] = []
  private hops = new Map<ImportedSession, HopSpec[]>()

  folder(path: string[]) {
    for (let i = 1; i <= path.length; i++) {
      const p = path.slice(0, i)
      const key = p.join('\u0000')
      if (this.folderKeys.has(key)) continue
      this.folderKeys.add(key)
      this.folders.push(p)
    }
  }

  add(s: ImportedSession, hops?: HopSpec[]) {
    this.folder(s.folderPath)
    this.sessions.push(s)
    if (hops?.length) this.hops.set(s, hops)
    return s
  }

  warn(item: string, message: string) {
    this.warnings.push({ item, message })
  }

  finish(): ImportResult {
    this.resolveJumps()
    const seen = new Map<string, number>()
    for (const s of this.sessions) {
      const key = sessionRef(s).toLowerCase()
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      if (n === 2) this.warn(sessionRef(s), 'Duplicate session name in the same folder; the import preview will ask which one to keep')
    }
    return { folders: this.folders.map((path) => ({ path })), sessions: this.sessions, warnings: this.warnings }
  }

  private resolveJumps() {
    const byRef = new Map<string, ImportedSession[]>()
    const byName = new Map<string, ImportedSession[]>()
    const push = (m: Map<string, ImportedSession[]>, k: string, s: ImportedSession) => m.set(k, [...(m.get(k) ?? []), s])
    for (const s of this.sessions) {
      push(byRef, sessionRef(s).toLowerCase(), s)
      push(byName, s.name.toLowerCase(), s)
    }
    const synthesized = new Map<string, ImportedSession>()

    const resolve = (owner: ImportedSession, h: HopSpec): ImportedSession | string => {
      if (h.ref !== undefined) {
        const key = h.ref.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
        const hit = byRef.get(key) ?? (key.includes('/') ? undefined : byName.get(key))
        if (hit?.length === 1) return hit[0]!
        if (hit && hit.length > 1) return `jump host "${h.label}" matches ${hit.length} sessions`
        if (h.host === undefined) return `jump session "${h.label}" was not found in the import`
      }
      const host = h.host!.toLowerCase()
      const sameHost = this.sessions.filter(
        (s) => s !== owner && s.protocol === 'ssh' && s.host.toLowerCase() === host && (h.port === undefined || s.port === h.port)
      )
      const exact = h.user ? sameHost.filter((s) => s.username === h.user) : sameHost
      const pick = exact.length === 1 ? exact : sameHost.length === 1 && !h.user ? sameHost : []
      if (pick.length === 1) return pick[0]!
      if (exact.length > 1) return `jump host "${h.label}" matches ${exact.length} sessions`
      const port = h.port ?? 22
      const synthKey = `${h.user ?? ''}@${host}:${port}`
      let j = synthesized.get(synthKey)
      if (!j) {
        let name = hopLabel({ host: h.host!, port, user: h.user })
        if (byName.has(name.toLowerCase())) name = `${name} (jump host)`
        j = {
          name,
          folderPath: [],
          host: h.host!,
          port,
          protocol: 'ssh',
          username: h.user ?? '',
          notes: '',
          options: {},
          tags: ['jump-host'],
          source: { format: 'synthesized', ref: `jump host of ${sessionRef(owner)}` }
        }
        synthesized.set(synthKey, j)
        this.sessions.push(j)
        push(byRef, name.toLowerCase(), j)
        push(byName, name.toLowerCase(), j)
        this.warn(name, `Created as a jump-host session for "${sessionRef(owner)}" (the source names it only as a gateway)`)
      }
      return j
    }

    for (const [s, hops] of this.hops) {
      const item = sessionRef(s)
      const chain = hops.map((h) => h.label).join(' → ')
      if (s.protocol !== 'ssh') {
        addNote(s, `Jump host in source: ${chain} (not supported for ${s.protocol})`)
        this.warn(item, `Jump host ${chain} ignored: Hopline Terminal only chains SSH sessions`)
        continue
      }
      const refs: string[] = []
      let failed: string | undefined
      for (const h of hops) {
        const r = resolve(s, h)
        if (typeof r === 'string') failed = r
        else if (r === s) failed = 'the session names itself as its jump host'
        else if (r.protocol !== 'ssh') failed = `jump session "${sessionRef(r)}" is ${r.protocol}, not SSH`
        else refs.push(sessionRef(r))
        if (failed) break
      }
      if (failed) {
        addNote(s, `Jump host in source: ${chain}`)
        this.warn(item, `Jump host not set: ${failed}`)
        continue
      }
      s.jumpRef = refs[0]
      if (refs.length > 1) s.jumpChain = refs
    }
  }
}
