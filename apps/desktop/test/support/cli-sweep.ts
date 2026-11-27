import { CONFIG_SESSIONS, getPlatform, matchParam, PLATFORM_IDS, PROFILES, type CommandNode, type ModeId, type ParamDef, type PlatformId } from '@hopline/cli-model'

/**
 * Lines for the routing sweep (Phase 4 fix-round review R1/X1): every runnable command of a mode's
 * tree, parameters filled with a value the parameter accepts, plus the same line with every keyword
 * cut to its shortest unique prefix among its siblings. Deterministic.
 */
export interface SweepLine {
  platform: PlatformId
  tree: 'exec' | 'config'
  line: string
  abbreviated: boolean
}

const CANDIDATES: Record<string, string[]> = {
  word: ['x1'],
  line: ['test text'],
  'range-list': ['10'],
  ipv4: ['10.0.0.1'],
  'ipv4-prefix': ['10.0.0.0/24'],
  ipv6: ['2001:db8::1'],
  'ipv6-prefix': ['2001:db8::/64'],
  ip: ['10.0.0.1'],
  prefix: ['10.0.0.0/24'],
  'ip-or-prefix': ['10.0.0.1'],
  host: ['10.0.0.1'],
  mac: ['0011.2233.4455', '00:11:22:33:44:55', '0011-2233-4455'],
  asn: ['65001'],
  path: ['flash:x.cfg', '/var/tmp/x', 'x.cfg'],
  interface: ['GigabitEthernet1/0/1', 'Ethernet1', 'ge-0/0/0', 'ethernet1/1', 'port1', '1/1/1', 'GigabitEthernet0/0/1', 'Gi1/0/1', 'mgmt0', 'x1']
}

/** Words typed after an open node. */
const OPEN_SUFFIXES = ['all', 'x1 x2', 'ip ospf adj', 'interface Ethernet1', 'session x source Ethernet1', 'running-config startup-config', 'vlan 10', 'ip bgp neighbor 10.0.0.1', 'flash:x.cfg']

function fill(p: ParamDef, platform: PlatformId): string | null {
  const ifs = PROFILES[platform].interfaces
  const list = p.kind === 'int' ? [String(p.min ?? 1)] : (CANDIDATES[p.kind] ?? ['x1'])
  for (const c of list) {
    if (matchParam(p, c.split(' '), 0, ifs) > 0) return c
  }
  return null
}

function shortest(word: string, siblings: readonly CommandNode[]): string {
  for (let n = 1; n < word.length; n++) {
    const pre = word.slice(0, n)
    if (siblings.filter((s) => s.word && s.word.startsWith(pre)).length === 1) return pre
  }
  return word
}

/** Every runnable line of one platform's exec tree or configuration tree (the one its session types lines in). */
export function sweepLines(platform: PlatformId, tree: 'exec' | 'config', maxDepth = 6, limit = 20000): SweepLine[] {
  const model = getPlatform(platform)
  const mode: ModeId = tree === 'exec' ? 'exec' : CONFIG_SESSIONS[platform].linesFrom
  const root = model.tree(mode)
  if (!root) return []
  const out: SweepLine[] = []
  const seen = new Set<string>()
  const add = (line: string, abbreviated: boolean) => {
    if (seen.has(line) || out.length >= limit) return
    seen.add(line)
    out.push({ platform, tree, line, abbreviated })
  }
  const walk = (node: CommandNode, full: string[], abbr: string[], depth: number) => {
    if (depth > 0 && node.runnable) {
      add(full.join(' '), false)
      add(abbr.join(' '), true)
    }
    // An open node takes any further words (deny-list heads, `debug …`, `monitor …`): the device
    // reads them, so the sweep types some, including words configuration mode knows.
    if (depth > 0 && node.open)
      for (const s of OPEN_SUFFIXES) {
        add(`${full.join(' ')} ${s}`, false)
        add(`${abbr.join(' ')} ${s}`, true)
      }
    if (depth >= maxDepth || out.length >= limit) return
    for (const k of node.keywords) walk(k, [...full, k.word!], [...abbr, shortest(k.word!, node.keywords)], depth + 1)
    for (const p of node.params) {
      const v = fill(p.param!, platform)
      if (v !== null) walk(p, [...full, v], [...abbr, v], depth + 1)
    }
  }
  walk(root, [], [], 0)
  return out
}

export function allSweepLines(maxDepth?: number): SweepLine[] {
  return PLATFORM_IDS.flatMap((p) => [...sweepLines(p, 'exec', maxDepth), ...sweepLines(p, 'config', maxDepth)])
}

/** A deterministic sample: every `step`-th line, plus every line of length ≤ 2 tokens (the heads). */
export function sampled(lines: readonly SweepLine[], step: number): SweepLine[] {
  return lines.filter((l, i) => i % step === 0 || l.line.split(' ').length <= 2)
}
