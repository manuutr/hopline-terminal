/**
 * OpenSSH client config importer (`~/.ssh/config`).
 *
 * Semantics follow ssh_config(5): for each concrete alias the blocks are applied
 * in file order and the first value obtained for a keyword wins, so `Host *`
 * at the end supplies defaults while one at the top overrides. Wildcard-only
 * blocks are defaults, never sessions.
 *
 * Nothing is executed or read: `Match` blocks (including `Match exec`) are
 * skipped with a warning, `Include` is not followed, `IdentityFile` paths are
 * recorded in notes only, and `ProxyCommand` is parsed as text.
 */
import { addNote, guessFromName, hopLabel, ResultBuilder, type HopSpec } from './result'
import { checkSize, splitLines } from './text'
import type { ImportedSession, ImportResult } from './types'

interface Block {
  kind: 'global' | 'host' | 'match'
  patterns: string[]
  opts: { key: string; args: string[]; line: number }[]
  line: number
}

/** Split arguments, honouring double quotes. */
function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  let has = false
  for (const c of s) {
    if (c === '"') {
      q = !q
      has = true
    } else if (!q && /\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

const isWildcard = (p: string) => /[*?]/.test(p)

/** Longer hosts or patterns never match: no real alias needs them, and it bounds the work. */
const MAX_GLOB_LEN = 1024

/**
 * ssh_config(5) glob: `*` is any run of characters, `?` exactly one, anything
 * else literal, case-insensitive. Iterative with a single backtrack point (the
 * last `*`), so the cost is at most O(pattern × host): no regex and no
 * exponential backtracking (OpenSSH's recursive match_pattern has that too).
 */
export function globMatch(pattern: string, host: string): boolean {
  if (pattern.length > MAX_GLOB_LEN || host.length > MAX_GLOB_LEN) return false
  const p = pattern.toLowerCase()
  const s = host.toLowerCase()
  let pi = 0
  let si = 0
  let star = -1
  let resume = 0
  while (si < s.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++
      resume = si
    } else if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      pi++
      si++
    } else if (star >= 0) {
      pi = star + 1
      si = ++resume
    } else return false
  }
  while (p[pi] === '*') pi++
  return pi === p.length
}

/** ssh_config(5) pattern lists: any positive match and no negated match. */
export function hostMatches(patterns: string[], host: string): boolean {
  let positive = false
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), host)) return false
    } else if (globMatch(p, host)) positive = true
  }
  return positive
}

/** `[user@]host[:port]`, `ssh://[user@]host[:port]`, `[v6]:port`. */
export function parseHop(spec: string): { host: string; port?: number; user?: string } | null {
  let s = spec.trim().replace(/^ssh:\/\//i, '')
  if (!s) return null
  let user: string | undefined
  const at = s.lastIndexOf('@')
  if (at >= 0) {
    user = s.slice(0, at)
    s = s.slice(at + 1)
  }
  let port: number | undefined
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (v6) {
    s = v6[1]!
    if (v6[2]) port = Number(v6[2])
  } else {
    const m = /^([^:]+):(\d+)$/.exec(s)
    if (m) {
      s = m[1]!
      port = Number(m[2])
    }
  }
  if (!s || (port !== undefined && !(port > 0 && port < 65536))) return null
  return { host: s, port, user: user || undefined }
}

/** `ssh [-q] [-x] -W %h:%p [user@]bastion` and the `-l user`/`-p port` variants. */
function proxyCommandHop(cmd: string): { host: string; port?: number; user?: string } | null {
  const t = splitArgs(cmd)
  if (t[0] !== 'ssh' && !t[0]?.endsWith('/ssh')) return null
  let w = false
  let user: string | undefined
  let port: number | undefined
  const rest: string[] = []
  for (let i = 1; i < t.length; i++) {
    const a = t[i]!
    if (a === '-W') {
      if (t[++i] !== '%h:%p') return null
      w = true
    } else if (a === '-l') user = t[++i]
    else if (a === '-p') port = Number(t[++i])
    else if (/^-[qxaTCnN46]+$/.test(a)) continue
    else if (a.startsWith('-')) return null
    else rest.push(a)
  }
  if (!w || rest.length !== 1) return null
  const hop = parseHop(rest[0]!)
  if (!hop) return null
  return { host: hop.host, port: port ?? hop.port, user: user ?? hop.user }
}

const ACCUMULATE = new Set(['identityfile', 'localforward', 'remoteforward', 'dynamicforward', 'certificatefile'])

export function importSshConfig(text: string): ImportResult {
  checkSize(text, 'ssh_config')
  const b = new ResultBuilder()
  const blocks: Block[] = [{ kind: 'global', patterns: [], opts: [], line: 0 }]
  let lineNo = 0
  for (const raw of splitLines(text)) {
    lineNo++
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line) ?? /^(\S+)$/.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const args = splitArgs(m[2] ?? '')
    if (key === 'host') {
      blocks.push({ kind: 'host', patterns: args, opts: [], line: lineNo })
    } else if (key === 'match') {
      blocks.push({ kind: 'match', patterns: args, opts: [], line: lineNo })
      b.warn(
        `Match ${args.join(' ')} (line ${lineNo})`,
        'Match blocks are not evaluated (Match exec is never run); the settings inside were not imported'
      )
    } else if (key === 'include') {
      b.warn(`Include ${args.join(' ')} (line ${lineNo})`, 'Include is not followed; import that file separately')
    } else blocks[blocks.length - 1]!.opts.push({ key, args, line: lineNo })
  }

  const aliases: { alias: string; line: number }[] = []
  const seen = new Set<string>()
  for (const bl of blocks) {
    if (bl.kind !== 'host') continue
    for (const p of bl.patterns) {
      if (p.startsWith('!') || isWildcard(p)) continue
      if (seen.has(p.toLowerCase())) continue
      seen.add(p.toLowerCase())
      if (p.length > MAX_GLOB_LEN) {
        // It would match no block, not even its own: say so instead of importing it bare.
        b.warn(`${p.slice(0, 40)}… (line ${bl.line})`, `Skipped: Host alias longer than ${MAX_GLOB_LEN} characters`)
        continue
      }
      aliases.push({ alias: p, line: bl.line })
    }
  }

  for (const { alias, line } of aliases) {
    const opt = new Map<string, string[]>()
    const acc = new Map<string, string[]>()
    for (const bl of blocks) {
      if (bl.kind === 'match') continue
      if (bl.kind === 'host' && !hostMatches(bl.patterns, alias)) continue
      for (const o of bl.opts) {
        if (ACCUMULATE.has(o.key)) acc.set(o.key, [...(acc.get(o.key) ?? []), o.args.join(' ')])
        else if (!opt.has(o.key)) opt.set(o.key, o.args)
      }
    }
    const one = (k: string) => opt.get(k)?.join(' ')
    const hostName = (one('hostname') ?? alias).replace(/%%|%h/g, (t) => (t === '%h' ? alias : '%'))
    const port = Number(one('port') ?? 22)
    const s: ImportedSession = {
      name: alias,
      folderPath: [],
      host: hostName,
      port: port > 0 && port < 65536 ? port : 22,
      protocol: 'ssh',
      username: one('user') ?? '',
      notes: '',
      options: {},
      tags: [],
      source: { format: 'ssh-config', ref: `line ${line}` }
    }
    guessFromName(s)
    if (/^yes$/i.test(one('forwardagent') ?? '')) s.options.ssh = { agentForward: true }
    for (const f of acc.get('identityfile') ?? []) addNote(s, `IdentityFile: ${f}`)
    let forwards = 0
    for (const [k, label] of [['localforward', 'LocalForward'], ['remoteforward', 'RemoteForward'], ['dynamicforward', 'DynamicForward']] as const) {
      for (const f of acc.get(k) ?? []) {
        addNote(s, `${label}: ${f}`)
        forwards++
      }
    }
    if (forwards) b.warn(alias, 'Port forwards recorded in notes only')

    let hops: HopSpec[] | undefined
    const jump = one('proxyjump')
    const proxyCmd = one('proxycommand')
    if (jump && jump.toLowerCase() !== 'none') {
      const parsed = jump.split(',').map(parseHop)
      if (parsed.some((h) => !h)) {
        addNote(s, `ProxyJump: ${jump}`)
        b.warn(alias, `Could not parse ProxyJump "${jump}"`)
      } else hops = parsed.map((h) => ({ ref: h!.host, ...h!, label: hopLabel(h!) }))
    } else if (proxyCmd && proxyCmd.toLowerCase() !== 'none') {
      const h = proxyCommandHop(proxyCmd)
      if (h) hops = [{ ref: h.host, ...h, label: hopLabel(h) }]
      else {
        addNote(s, `ProxyCommand: ${proxyCmd}`)
        b.warn(alias, 'ProxyCommand not imported (only "ssh -W %h:%p host" is understood); it was not run')
      }
    }
    b.add(s, hops)
  }
  return b.finish()
}
