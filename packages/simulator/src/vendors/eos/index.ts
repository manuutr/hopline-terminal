/**
 * Arista EOS personality (docs/research/cli-arista-eos.md). `>`/`#` EXEC, config modes that
 * inherit EXEC commands, `(at token N: 'x')` errors without a caret, ` --More-- ` pager, Linux
 * shell pipes, and configuration sessions (`configure session`, diffs, commit, commit timer with
 * automatic rollback, abort).
 */
import type { PagerSpec, Session, TabResult } from '../../core/personality.ts'
import { findIface, type IfType } from '../../core/ifname.ts'
import { now, runtime, setClock } from '../../core/runtime.ts'
import { inSubnet, safeRegex, section, splitPipes, unifiedDiff, unquote } from '../../core/text.ts'
import { add, dottedToLen, isIpv4, kw, prm, tokenize, type Ctx, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { CiscoBase, ciscoHelpList, type CMode, type Failure, type PipeOutcome } from '../cisco/base.ts'
import { deviceFrom, isUp, logEvent, restore, snapshot, tickBgp, type Acl, type ConfigSnapshot, type Device, type Iface, type RouteMap } from '../../state.ts'
import { expandVlans, reachable, traceHops } from '../ios/index.ts'
import * as R from './render.ts'
import { configLines, ifaceBody, isDirty, runningConfig, sortedIfaces, startupLines } from './config.ts'

export const EOS_TYPES: IfType[] = [
  { full: 'Ethernet', short: 'Et' },
  { full: 'Loopback', short: 'Lo' },
  { full: 'Vlan', short: 'Vl' },
  { full: 'Port-Channel', short: 'Po' },
  { full: 'Management', short: 'Ma' },
  { full: 'Tunnel', short: 'Tu' },
  { full: 'Vxlan', short: 'Vx' }
]

/** ` --More-- `; erased with CR, spaces, CR. Space page, Enter line, q / Ctrl-C quit. */
export const EOS_PAGER: PagerSpec = {
  text: () => ' --More-- ',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'ignore'
}

interface EosSession {
  config: ConfigSnapshot
  state: 'pending' | 'pendingCommitTimer' | 'completed'
  user: string
  created: number
  backup?: ConfigSnapshot
  timerEnd?: number
  description?: string
}
interface Store {
  sessions: Record<string, EosSession>
  seq: number
}

export function eosStore(d: Device): Store {
  const v = d.vendor as { eos?: Store }
  return (v.eos ??= { sessions: {}, seq: 0 })
}

const commitKey = (name: string): string => `eos-commit-${name}`

/** Arm the commit-timer rollback. Closes over the device only: it outlives the CLI session. */
export function armCommitTimer(d: Device, name: string, ms: number): void {
  const rt = runtime(d)
  rt.timer(commitKey(name), ms, () => {
    const st = eosStore(d)
    const s = st.sessions[name]
    if (!s?.backup) return
    restore(d, s.backup)
    tickBgp(d)
    delete st.sessions[name]
    const msg = `ConfigAgent: %SYS-4-CONFIG_SESSION_TIMER_EXPIRED: Commit timer for configuration session ${name} expired; running-config rolled back`
    logEvent(d, msg)
    rt.broadcast(`${R.logStamp(now(d))} ${d.hostname} ${msg}`)
  })
}

interface IfCtx {
  list: Iface[]
  label: string
}

const SHORT_FOR = (word: string): string | undefined => {
  const w = word.toLowerCase()
  const t = EOS_TYPES.find((x) => x.short.toLowerCase() === w) ?? EOS_TYPES.find((x) => x.full.toLowerCase().startsWith(w))
  return t?.short
}

export class EosPersonality extends CiscoBase {
  pager = EOS_PAGER
  protected override execFromConfig: 'do' | 'inherit' = 'inherit'
  private trees: Record<string, Node[]> | undefined
  /** Open configuration session: its name and the throwaway device the edits go to. */
  private sess: { name: string; dev: Device } | undefined
  private lastTab = ''
  private history: string[] = []
  private collecting: string[] | null = null

  constructor(s: Session) {
    super(s)
    if (this.d.vendor['loginPrivilege'] === 1) this.privileged = false
  }

  /** The device config commands act on: the session copy while in a session. */
  get t(): Device {
    return this.sess ? this.sess.dev : this.d
  }

  private store(): Store {
    return eosStore(this.d)
  }

  override banner(): string {
    const t = new Date(now(this.d) - 3_725_000)
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const two = (n: number): string => String(n).padStart(2, '0')
    const last = `Last login: ${DOW[t.getUTCDay()]} ${MON[t.getUTCMonth()]} ${two(t.getUTCDate())} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())} ${t.getUTCFullYear()} from ${this.s.from}`
    return `${last}\n${this.d.motd !== undefined ? `${this.d.motd}\n` : ''}`
  }

  override prompt(): string {
    if (this.collecting) return ''
    return this.promptText()
  }

  protected suffix(m: CMode): string {
    if (m.id === 'exec') return ''
    let base = m.id
    if (m.id === 'config-if') base = `config-if-${(m.ctx as IfCtx).label}`
    else if (m.id === 'config-vlan') base = `config-vlan-${(m.ctx as { label: string }).label}`
    else if (m.id === 'config-acl') base = `config-acl-${(m.ctx as Acl).name}`
    else if (m.id === 'config-route-map') base = `config-route-map-${(m.ctx as { rm: RouteMap }).rm.name}`
    else if (m.id === 'config-vrf') base = `config-vrf-${(m.ctx as { name: string }).name}`
    if (this.sess) base = base.replace(/^config/, `config-s-${this.sess.name}`)
    return `(${base})`
  }

  // ------------------------------------------------------------------ errors and help

  protected errInvalid(_line: string, f: Failure): string {
    return `% Invalid input (at token ${f.index}: '${f.token}')`
  }
  protected errAmbiguous(): string {
    return '% Ambiguous command'
  }
  protected errIncomplete(): string {
    return '% Incomplete command'
  }
  protected helpPartial(words: string[]): string {
    return words.length ? words.join('  ') : '% Unrecognized command'
  }
  protected helpList(h: Extract<HelpResult, { ok: true }>): string {
    if (!h.entries.length && !h.cr) return '% Unrecognized command'
    // EOS lists argument placeholders before keywords (`ping ?`: WORD, ip, ipv6 ...).
    const entries = [...h.entries.filter((e) => !e.keyword), ...h.entries.filter((e) => e.keyword)]
    return ciscoHelpList({ ...h, entries }, { cr: '' })
  }
  protected override pipeHelp(): string {
    return [
      '  LINE      Any command in the Linux shell (grep, wc, head ...)',
      '  append    Append redirected output to URL',
      '  begin     Begin with the line that matches',
      '  exclude   Exclude lines that match',
      '  include   Include lines that match',
      '  json      Produce JSON output for this command',
      '  no-more   Disable pagination for this command',
      '  nz        Include only non-zero counters',
      '  redirect  Redirect output to URL',
      '  section   Include sections that match',
      '  tee       Copy output to URL'
    ].join('\n')
  }

  protected override unknown(line: string, f: Failure): string {
    if (!this.privileged && !this.inConfig()) {
      const [base] = splitPipes(line)
      const r = this.tree('exec')
      const m = matchIn(base, r)
      if (m) return '% Invalid input (privileged mode required)'
    }
    return this.error(line, f)
  }

  protected override tabAmbiguous(line: string, options: string[]): TabResult {
    if (!options.length) return { bell: true }
    if (this.lastTab === line) {
      this.lastTab = ''
      return { list: options.join('  ') }
    }
    this.lastTab = line
    return { bell: true }
  }

  override control(key: 'c' | 'z', _line: string): { echo?: string; then?: () => void; keepLine?: boolean } {
    if (key === 'c') return { echo: '^C\n' }
    if (!this.inConfig()) return { echo: '\n', keepLine: true }
    return { echo: '^Z\n', then: () => this.endConfig() }
  }

  // ------------------------------------------------------------------ pipes

  protected pipes(out: string, pipes: string[], raw: string): PipeOutcome | { error: string } {
    let lines = out.replace(/\n$/, '').split('\n')
    let noMore = false
    const builtins = ['append', 'begin', 'exclude', 'include', 'json', 'no-more', 'nz', 'redirect', 'section', 'tee']
    for (const p of pipes) {
      const [w0 = '', ...rest] = p.split(/\s+/)
      const w = w0.toLowerCase()
      const arg = unquote(rest.join(' '))
      if (!w) return { error: '% Incomplete command' }
      const hits = builtins.filter((b) => b.startsWith(w))
      const cmd = builtins.find((b) => b === w) ?? (hits.length === 1 ? hits[0] : undefined)
      if (!cmd && hits.length > 1) return { error: '% Ambiguous command' }
      if (!cmd) {
        const r = shellPipe(w0, rest, lines)
        if ('error' in r) return r
        lines = r.lines
        continue
      }
      if (['begin', 'exclude', 'include', 'section'].includes(cmd) && !arg) return { error: '% Incomplete command' }
      const re = arg ? safeRegex(arg) : null
      if (['begin', 'exclude', 'include', 'section'].includes(cmd) && !re) return { error: `% Invalid input (at token ${tokenize(raw).indexOf(rest[0]!)}: '${rest[0]}')` }
      switch (cmd) {
        case 'include':
          lines = lines.filter((l) => re!.test(l))
          break
        case 'exclude':
          lines = lines.filter((l) => !re!.test(l))
          break
        case 'begin': {
          const i = lines.findIndex((l) => re!.test(l))
          lines = i < 0 ? [] : lines.slice(i)
          break
        }
        case 'section':
          lines = section(lines, re!)
          break
        case 'json': {
          const j = this.jsonFor(raw)
          if (j.startsWith('%')) return { error: j }
          lines = j.split('\n')
          break
        }
        case 'no-more':
          noMore = true
          break
        case 'nz':
          lines = lines.filter((l) => {
            const nums = l.match(/\b\d+\b/g)
            return !nums || nums.some((n) => Number(n) !== 0)
          })
          break
        default:
          return { error: `% [simulator] '| ${cmd}' writes files and is disabled on the simulator` }
      }
    }
    return { out: lines.join('\n'), noMore }
  }

  private jsonFor(raw: string): string {
    const [base] = splitPipes(raw)
    const r = this.resolve(base)
    if (!r.m.ok) return '% This is an unconverted command'
    const d = this.d
    const words = r.m.ctx.words.join(' ')
    const map: Record<string, () => string> = {
      'show version': () => R.versionJson(d),
      'show ip bgp summary': () => R.bgpSummaryJson(d),
      'show interfaces status': () => R.intStatusJson(d),
      'show vlan': () => R.vlanJson(d),
      'show ip interface brief': () => R.ipIntBriefJson(d),
      'show lldp neighbors': () => R.lldpJson(d)
    }
    return map[words]?.() ?? '% This is an unconverted command'
  }

  // ------------------------------------------------------------------ execute

  override async execute(raw: string): Promise<void> {
    if (this.collecting) {
      if (raw.trim() === 'EOF') {
        this.t.motd = this.collecting.join('\n')
        this.collecting = null
        this.changed()
      } else this.collecting.push(raw)
      return
    }
    this.history.push(raw)
    if (this.history.length > 20) this.history.shift()
    await super.execute(raw)
    if (this.sess) this.persistSession()
  }

  private persistSession(): void {
    const s = this.sess
    if (!s) return
    const rec = this.store().sessions[s.name]
    if (rec) rec.config = snapshot(s.dev)
  }

  /** A config change was made (BGP and link state are recomputed on the live device). */
  private changed(): string {
    if (!this.sess) {
      ;(this.d.vendor as { eosLastChange?: { t: number; by: string } }).eosLastChange = { t: now(this.d), by: this.s.user }
      tickBgp(this.d)
    }
    return ''
  }

  override endConfig(): void {
    if (this.sess) this.leaveSession()
    else if (this.inConfig()) logEvent(this.d, `ConfigAgent: %SYS-5-CONFIG_I: Configured from console by ${this.s.user} on vty3 (${this.s.from})`)
    super.endConfig()
  }

  override exitMode(): boolean {
    const wasSess = this.sess
    const left = super.exitMode()
    if (left && wasSess) this.leaveSession()
    else if (left) logEvent(this.d, `ConfigAgent: %SYS-5-CONFIG_I: Configured from console by ${this.s.user} on vty3 (${this.s.from})`)
    return left
  }

  private leaveSession(): void {
    this.persistSession()
    this.sess = undefined
  }

  // ------------------------------------------------------------------ trees

  protected tree(modeId: string): Node[] {
    this.trees ??= this.build()
    return this.trees[modeId] ?? this.trees['config']!
  }

  private ifParam(): Param {
    return {
      kind: 'iface',
      label: 'INTERFACE',
      values: () => this.d.interfaces.map((i) => i.short),
      test: (tok) => !!findIface(this.d, tok, EOS_TYPES)
    }
  }

  private ifOf(c: Ctx, key = 'if'): Iface | undefined {
    return findIface(this.d, c.args[key] ?? '', EOS_TYPES)
  }

  private build(): Record<string, Node[]> {
    const d = this.d
    const exec: Node[] = []
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const vrfP: Param = { kind: 'word', label: 'VRF', values: () => ['all', 'default', ...d.vrfs.map((v) => v.name)], test: (t) => t === 'all' || t === 'default' || d.vrfs.some((v) => v.name === t) }
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(exec, `show ${path}`, help, run, extra, SHOW_HELP)

    // ---- show
    add(exec, 'show', 'Show running system information')
    S('version', 'Software and hardware versions', () => R.showVersion(d))
    S('running-config', 'Current operating configuration', () => runningConfig(d), {
      children: [
        kw('all', 'Configuration with defaults', { run: () => runningConfig(d) }),
        kw('diffs', 'Differences from startup-config', { run: () => this.runningDiffs() }),
        kw('interfaces', 'Filter config to include only the given interfaces', { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => { const i = this.ifOf(c)!; return [`interface ${i.name}`, ...ifaceBody(d, i)].join('\n') } })] }),
        kw('section', 'Filter config to include only the given section', { children: [prm(line, 'Regular expression', { name: 're', run: (c) => { const re = safeRegex(c.args['re']!); return re ? section(configLines(d), re).join('\n') : '% Invalid input' } })] })
      ]
    })
    S('startup-config', 'Contents of startup configuration', () => this.startupConfig())
    S('ip interface brief', 'IP interface status and configuration summary', () => R.showIpIntBrief(d), { children: [kw('vrf', 'VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showIpIntBrief(d, c.args['vrf']) })] })] })
    S('ip interface', 'IP interface status and configuration', () => sortedIfaces(d).filter((i) => i.ip).map((i) => R.showInterface(d, i).split('\n').slice(0, 5).join('\n')).join('\n'))
    exec.find((n) => n.word === 'show')!.children!.find((n) => n.word === 'ip')!.children!.find((n) => n.word === 'interface')!.children!.push(prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.showInterface(d, this.ifOf(c)!).split('\n').slice(0, 5).join('\n') }))
    const routeTail = (vk?: string): Node[] => [
      kw('summary', 'Route summary', { run: () => R.routeSummary(d) }),
      prm({ kind: 'word', label: 'A.B.C.D', test: (t) => isIpv4(t) || /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(t) }, 'Destination address or prefix', { name: 'target', run: (c) => R.showIpRoute(d, vk ? c.args[vk] : 'default', c.args['target']) })
    ]
    S('ip route', 'IP routing table', () => R.showIpRoute(d), { children: [kw('vrf', 'Display routes from a VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => (c.args['vrf'] === 'all' ? ['default', ...d.vrfs.map((v) => v.name)].map((v) => R.showIpRoute(d, v)).join('\n') : R.showIpRoute(d, c.args['vrf'])), children: routeTail('vrf') })] }), ...routeTail()] })
    S('ip bgp', 'BGP information', () => R.showIpBgp(d))
    S('ip bgp summary', 'Summarized BGP information', () => R.showBgpSummary(d), { children: [kw('vrf', 'VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showBgpSummary(d, c.args['vrf']) })] })] })
    const nbSub = (w: string, help: string): Node => kw(w, help, { run: (c) => R.showBgpNeighbors(d, c.args['nb'], w) })
    S('ip bgp neighbors', 'Detailed information on TCP and BGP neighbor connections', () => R.showBgpNeighbors(d), {
      children: [prm({ kind: 'ipv4', label: 'A.B.C.D', values: () => d.bgp.map((n) => n.ip) }, 'Neighbor address', { name: 'nb', run: (c) => R.showBgpNeighbors(d, c.args['nb']), children: [nbSub('advertised-routes', 'Routes advertised to the neighbor'), nbSub('received-routes', 'Routes received from the neighbor'), nbSub('routes', 'Routes learned from the neighbor')] })]
    })
    S('ip ospf', 'OSPF information', () => (d.ospf ? `OSPF instance ${d.ospf.process} with ID ${d.ospf.routerId ?? d.routerId}, VRF default\nSupports opaque LSA\nMaximum number of LSA allowed 12000\nNumber of areas in this instance is 1` : ''))
    S('ip ospf neighbor', 'Neighbor information', () => R.showOspfNeighbor(d))
    S('ip ospf interface brief', 'Summary of OSPF interfaces', () => R.showOspfIntBrief(d))
    const arpRun = (c: Ctx): string => R.showArp(d, c.args['vrf'])
    S('ip arp', 'ARP table', arpRun, { children: [kw('vrf', 'VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: arpRun })] })] })
    S('arp', 'ARP table', arpRun, { children: [kw('vrf', 'VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: arpRun })] })] })
    const aclP: Param = { kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }
    S('ip access-lists', 'IP access lists', () => R.showAccessLists(d), { children: [prm(aclP, 'Access list name', { name: 'acl', run: (c) => R.showAccessLists(d, c.args['acl']) })] })
    S('ip prefix-list', 'Prefix lists', () => R.showPrefixList(d), { children: [prm({ kind: 'word', label: 'WORD', values: () => d.prefixLists.map((p) => p.name) }, 'Prefix list name', { name: 'pl', run: (c) => R.showPrefixList(d, c.args['pl']) })] })
    S('route-map', 'Route map information', () => R.showRouteMap(d), { children: [prm({ kind: 'word', label: 'WORD', values: () => d.routeMaps.map((r) => r.name) }, 'Route map name', { name: 'rm', run: (c) => R.showRouteMap(d, c.args['rm']) })] })
    const ifSub = (): Node[] => [
      kw('status', 'Details on the state of interfaces', { run: (c) => R.showIntStatus(d, (i) => i === this.ifOf(c)) }),
      kw('description', 'Details on description, status and protocol of interfaces', { run: (c) => R.showIntDescription(d).split('\n').filter((l, k) => k === 0 || l.startsWith(this.ifOf(c)!.short + ' ')).join('\n') })
    ]
    S('interfaces', 'Details related to interfaces', () => sortedIfaces(d).map((i) => R.showInterface(d, i)).join('\n'), { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.showInterface(d, this.ifOf(c)!), children: ifSub() })] })
    S('interfaces status', 'Details on the state of interfaces', () => R.showIntStatus(d), { children: [kw('errdisabled', 'Show only errdisabled interfaces', { run: () => R.showIntStatus(d, (i) => !!i.errDisabled) })] })
    S('interfaces description', 'Details on description, status and protocol of interfaces', () => R.showIntDescription(d))
    S('interfaces counters', 'Interface counters', () => R.showIntCountersErrors(d))
    S('interfaces counters errors', 'Error counters', () => R.showIntCountersErrors(d))
    S('interfaces trunk', 'Trunk interfaces', () => R.showIntTrunk(d))
    S('vlan', 'VLAN configuration information', () => R.showVlan(d), { children: [kw('brief', 'VLAN summary', { run: () => R.showVlan(d) }), kw('id', 'VLAN id', { children: [prm(int(1, 4094), 'VLAN id', { name: 'id', run: (c) => R.showVlan(d, Number(c.args['id'])) })] })] })
    S('vrf', 'VRF information', () => R.showVrf(d))
    S('mac address-table', 'MAC address table', () => R.showMacTable(d), {
      children: [
        kw('address', 'Filter by MAC address', { children: [prm({ kind: 'mac', label: 'H.H.H' }, 'MAC address', { name: 'mac', run: (c) => R.showMacTable(d, { kind: 'address', value: c.args['mac'] }) })] }),
        kw('interface', 'Filter by interface', { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.showMacTable(d, { kind: 'interface', value: this.ifOf(c)!.short }) })] }),
        kw('vlan', 'Filter by VLAN', { children: [prm(int(1, 4094), 'VLAN id', { name: 'vlan', run: (c) => R.showMacTable(d, { kind: 'vlan', value: c.args['vlan'] }) })] }),
        kw('dynamic', 'Dynamic entries', { run: () => R.showMacTable(d, { kind: 'dynamic' }) }),
        kw('static', 'Static entries', { run: () => R.showMacTable(d, { kind: 'static' }) })
      ]
    })
    S('lldp neighbors', 'LLDP neighbor information', () => R.showLldp(d, false), { children: [kw('detail', 'Detailed neighbor information', { run: () => R.showLldp(d, true) })] })
    S('logging', 'Logging status and buffer', () => R.showLogging(d), {
      children: [kw('last', 'Show messages in the last <N> time units', { children: [prm(int(1, 9999), 'Number of messages', { name: 'n', run: (c) => R.showLogging(d, Number(c.args['n'])) })] }), prm(int(1, 9999), 'Number of most recent messages', { name: 'n', run: (c) => R.showLogging(d, Number(c.args['n'])) })]
    })
    S('processes', 'Process information', () => R.showProcessesTop(d))
    S('processes top', 'Top processes', () => R.showProcessesTop(d), { children: [kw('once', 'Run top once', { run: () => R.showProcessesTop(d) })] })
    S('clock', 'System clock', () => R.showClock(d))
    S('uptime', 'System uptime', () => R.showUptime(d))
    S('hostname', 'System hostname', () => `Hostname: ${d.hostname}\nFQDN:     ${d.hostname}`)
    S('users', 'Display information about terminal lines', () => this.who())
    S('history', 'Session command history', () => this.history.map((h) => `  ${h}`).join('\n'))
    S('inventory', 'Hardware inventory', () => R.showInventory(d))
    S('terminal', 'Terminal settings', () => `Width:       80 columns\nLength:      ${this.s.pageLength} rows`)
    S('session-config', 'Configuration of the current session', () => this.sessionConfig(false), {
      children: [kw('diffs', 'Differences from running-config', { run: () => this.sessionConfig(true) }), kw('named', 'A named session', { children: [prm({ kind: 'word', label: 'WORD', values: () => Object.keys(this.store().sessions) }, 'Session name', { name: 'sn', run: (c) => this.sessionConfig(false, c.args['sn']), children: [kw('diffs', 'Differences from running-config', { run: (c) => this.sessionConfig(true, c.args['sn']) })] })] })]
    })
    S('configuration sessions', 'Configuration sessions', () => this.showSessions(false), { children: [kw('detail', 'Detailed information', { run: () => this.showSessions(true) })] })
    S('active', 'Running configuration of the current mode', () => this.showActive())

    // ---- exec actions
    const cfgSess = (c: Ctx): string => this.enterSession(c.args['sn'])
    add(exec, 'configure', 'Enter configuration mode', () => this.enterConfig())
    add(exec, 'configure terminal', 'Configure from the terminal', () => this.enterConfig())
    add(exec, 'configure session', 'Enter configuration session', cfgSess, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => Object.keys(this.store().sessions) }, 'Name for session', {
          name: 'sn',
          run: cfgSess,
          children: [
            kw('commit', 'Commit the session', { run: (c) => this.commit(c.args['sn']!, c.args['tm']), children: [kw('timer', 'Commit with an automatic rollback', { children: [prm({ kind: 'time', label: 'hh:mm:ss' }, 'Time before rollback', { name: 'tm', run: (c) => this.commit(c.args['sn']!, c.args['tm']) })] })] }),
            kw('abort', 'Abort the session', { run: (c) => this.abort(c.args['sn']!) }),
            kw('description', 'Session description', { children: [prm(line, 'Description', { name: 'desc', run: (c) => { const r = this.enterSession(c.args['sn']); const s = this.store().sessions[c.args['sn']!]; if (s) s.description = c.args['desc']; return r } })] })
          ]
        })
      ]
    })
    add(exec, 'configure replace', 'Replace the running-config with a URL', undefined, { children: [prm({ kind: 'word', label: 'URL', values: () => ['startup-config', 'clean-config'] }, 'Source of the new configuration', { name: 'url', run: (c) => this.configureReplace(c.args['url']!), children: [kw('ignore-errors', 'Ignore errors in the source', { run: (c) => this.configureReplace(c.args['url']!) })] })] })
    const fileP: Param = { kind: 'word', label: 'URL', values: () => ['running-config', 'startup-config', 'flash:'] }
    add(exec, 'copy', 'Copy files', undefined, {
      children: [prm(fileP, 'Source', { name: 'src', children: [prm(fileP, 'Destination', { name: 'dst', run: (c) => this.copy(c.args['src']!, c.args['dst']!) })] })]
    })
    add(exec, 'write', 'Write running configuration to startup-config', () => this.save())
    add(exec, 'write memory', 'Write to startup-config', () => this.save())
    add(exec, 'write terminal', 'Write to terminal', () => runningConfig(d))
    add(exec, 'write erase', 'Erase startup-config', () => this.erase())
    add(exec, 'erase startup-config', 'Erase startup-config', () => this.erase(), {}, { erase: 'Erase a filesystem or file' })
    add(exec, 'reload', 'Reboot the switch', () => this.reload(), { children: [kw('now', 'Reload immediately', { run: () => this.reload(true) }), kw('force', 'Reload without prompting', { run: () => this.reload(true) })] })
    add(exec, 'bash', 'Enter the Linux shell', () => '% [simulator] bash is disabled on the simulator', { children: [prm(line, 'Command', { run: () => '% [simulator] bash is disabled on the simulator' })] })
    add(exec, 'diff', 'Compare two files', undefined, { children: [prm(fileP, 'First file', { name: 'a', children: [prm(fileP, 'Second file', { name: 'b', run: (c) => this.diffFiles(c.args['a']!, c.args['b']!) })] })] })
    add(exec, 'dir', 'List files on a filesystem', () => this.dir(), { children: [prm(word('URL'), 'Directory', { run: () => this.dir() })] })
    add(exec, 'more', 'Display a file', undefined, { children: [prm(fileP, 'File', { name: 'f', run: (c) => (/startup/.test(c.args['f']!) ? this.startupConfig() : /running/.test(c.args['f']!) ? runningConfig(d) : `% Error opening ${c.args['f']} (No such file or directory)`) })] })
    const clearIf = prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => this.clearCounters(this.ifOf(c)) })
    add(exec, 'clear', 'Reset functions')
    add(exec, 'clear counters', 'Clear interface counters', () => this.clearCounters(), { children: [clearIf] })
    const bgpTarget: Param = { kind: 'word', label: 'A.B.C.D', test: (t) => t === '*' || isIpv4(t), values: () => ['*', ...d.bgp.map((n) => n.ip)] }
    add(exec, 'clear ip bgp', 'Reset BGP sessions', () => this.clearBgp('*'), { children: [prm(bgpTarget, 'Neighbor address or * for all', { name: 'tgt', run: (c) => this.clearBgp(c.args['tgt']!), children: [kw('soft', 'Soft reset', { run: () => '', children: [kw('in', 'Inbound', { run: () => '' }), kw('out', 'Outbound', { run: () => '' })] })] })] }, { 'clear ip': 'IP' })
    add(exec, 'clear logging', 'Clear the logging buffer', () => ((d.log = []), ''))
    add(exec, 'clear arp-cache', 'Clear the ARP cache', () => '')
    add(exec, 'clear mac address-table dynamic', 'Clear dynamic MAC entries', () => '', {}, { 'clear mac': 'MAC', 'clear mac address-table': 'MAC address table' })
    const pingRun = (c: Ctx): Promise<string> => this.ping(c.args['target']!, Number(c.args['repeat'] ?? 5), c.args['vrf'])
    const pingOpts = (): Node[] => {
      const opts: Node[] = [kw('repeat', 'Number of pings', { children: [prm(int(1, 100000), 'Count', { name: 'repeat', run: pingRun })] }), kw('source', 'Source address or interface', { children: [prm(word(), 'Source', { run: pingRun })] }), kw('size', 'Packet size', { children: [prm(int(36, 18024), 'Size', { run: pingRun })] })]
      for (const o of opts) for (const leaf of o.children!) leaf.children = opts
      return opts
    }
    const pingTarget = (): Node => prm(word(), 'Ping destination address or hostname', { name: 'target', run: pingRun, children: pingOpts() })
    add(exec, 'ping', 'Send echo messages', undefined, {
      children: [
        pingTarget(),
        kw('ip', 'IPv4 echo', { children: [pingTarget()] }),
        kw('ipv6', 'IPv6 echo', { children: [prm(word(), 'Destination', { run: () => '% [simulator] IPv6 is not modelled' })] }),
        kw('mpls', 'Send echo messages for LSP', { children: [prm(line, 'LSP', { run: () => '% [simulator] MPLS is not modelled' })] }),
        kw('vrf', 'Ping in a VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', children: [pingTarget(), kw('ip', 'IPv4 echo', { children: [pingTarget()] })] })] })
      ]
    })
    const traceTarget = (): Node => prm(word(), 'Destination address or hostname', { name: 'target', run: (c) => this.trace(c.args['target']!, c.args['vrf']) })
    add(exec, 'traceroute', 'Trace route to destination', undefined, { children: [traceTarget(), kw('vrf', 'Traceroute in a VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', children: [traceTarget()] })] })] })
    add(exec, 'terminal', 'Configure the terminal')
    add(exec, 'terminal length', 'Set number of lines on a screen', undefined, { children: [prm(int(0, 32767), 'Number of lines on screen (0 for no pausing)', { name: 'n', run: (c) => this.setLength(Number(c.args['n'])) })] })
    add(exec, 'terminal width', 'Set width of the display terminal', undefined, { children: [prm(int(10, 32767), 'Number of characters on a screen line', { name: 'n', run: (c) => `Width set to ${c.args['n']} columns.` })] })
    add(exec, 'terminal dont-ask', 'Do not ask for confirmation', () => '')
    add(exec, 'terminal monitor', 'Enable logging to the terminal', () => '')
    const noTerm = (): Node[] => [kw('terminal', 'Configure the terminal', { children: [kw('length', 'Set number of lines on a screen', { run: () => ((this.s.pageLength = this.s.rows - 1), '') }), kw('monitor', 'Disable logging to the terminal', { run: () => '' })] })]
    add(exec, 'no', 'Negate a command or set its defaults', undefined, {
      children: [...noTerm(), kw('configure', 'Configuration commands', { children: [kw('session', 'Configuration session', { children: [prm({ kind: 'word', label: 'WORD', values: () => Object.keys(this.store().sessions) }, 'Session name', { name: 'sn', run: (c) => this.deleteSession(c.args['sn']!) })] })] })]
    })
    add(exec, 'default', 'Set a command to its defaults', undefined, { children: noTerm() })
    add(exec, 'enable', 'Turn on privileged commands', () => ((this.privileged = true), ''))
    add(exec, 'disable', 'Turn off privileged commands', () => ((this.privileged = false), ''))
    add(exec, 'exit', 'Exit from the EXEC', () => (this.s.close(), ''))
    add(exec, 'logout', 'Exit from the EXEC', () => (this.s.close(), ''))
    const remote = (what: string) => (c: Ctx): string => `% [simulator] ${what} to ${c.params[0]} is not available from the simulated device`
    add(exec, 'connect', 'Open a terminal connection', undefined, { children: [prm(word(), 'Host', { run: remote('connect') })] })
    add(exec, 'ssh', 'Open ssh connection', undefined, { children: [prm(line, 'Host and options', { run: remote('ssh') })] })
    add(exec, 'telnet', 'Open a telnet connection', undefined, { children: [prm(word(), 'Host', { run: remote('telnet') })] })
    add(exec, 'tcpdump', 'Monitor packets with tcpdump', () => '% [simulator] tcpdump is disabled on the simulator', { children: [prm(line, 'Options', { run: () => '% [simulator] tcpdump is disabled on the simulator' })] })
    add(exec, 'watch', 'Execute a command repeatedly', undefined, { children: [prm(line, 'Command', { run: () => '% [simulator] watch is disabled on the simulator (it never terminates)' })] })
    add(exec, 'who', 'Display information about terminal lines', () => this.who())
    add(exec, 'zerotouch', 'ZeroTouch configuration', undefined, { children: [kw('cancel', 'Cancel ZeroTouch', { run: () => '% [simulator] zerotouch would reload the switch; ignored' }), kw('disable', 'Disable ZeroTouch', { run: () => '% [simulator] zerotouch would reload the switch; ignored' })] })

    // ---- user EXEC (`>`)
    const USER = ['clear', 'connect', 'default', 'disable', 'enable', 'exit', 'logout', 'no', 'ping', 'ssh', 'tcpdump', 'telnet', 'terminal', 'traceroute', 'watch', 'who', 'zerotouch']
    const user: Node[] = exec.filter((n) => USER.includes(n.word!))
    const show = exec.find((n) => n.word === 'show')!
    const USER_SHOW = ['version', 'interfaces', 'ip', 'arp', 'vlan', 'vrf', 'lldp', 'mac', 'logging', 'clock', 'uptime', 'hostname', 'users', 'history', 'terminal', 'inventory', 'processes']
    user.push(kw('show', show.help, { children: show.children!.filter((c) => USER_SHOW.includes(c.word!)) }))
    user.sort((a, b) => a.word!.localeCompare(b.word!))
    exec.sort((a, b) => a.word!.localeCompare(b.word!))
    return { user, exec, ...this.configTrees() }
  }

  // ------------------------------------------------------------------ config trees

  private configTrees(): Record<string, Node[]> {
    const line: Param = { kind: 'line', label: 'LINE' }
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const ipP: Param = { kind: 'ipv4', label: 'A.B.C.D' }
    const prefixP: Param = { kind: 'prefix', label: 'A.B.C.D/M' }
    const H = { no: 'Negate a command or set its defaults', default: 'Set a command to its defaults', ip: 'Internet Protocol (IP)' }
    const g: Node[] = []
    const C = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}, helps: Record<string, string> = {}): Node => add(g, path, help, run, extra, { ...H, ...helps })
    const ch = (): string => this.changed()

    C('hostname', 'Configure the system hostname', undefined, { children: [prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(t) }, 'Hostname', { name: 'h', run: (c) => ((this.t.hostname = c.args['h']!), ch()) })] })
    C('interface', 'Interface Configuration', undefined, { children: [prm({ kind: 'line', label: 'INTERFACE' }, 'Interface name, range or list (Et1, Et10-11, Et2,3,4)', { name: 'spec', run: (c) => this.enterIf(c.args['spec']!) })] })
    C('no interface', 'Interface Configuration', undefined, {
      children: [prm({ kind: 'line', label: 'INTERFACE' }, 'Interface name', { name: 'spec', run: (c) => { const i = findIface(this.t, c.args['spec']!, EOS_TYPES); if (!i) return `% Invalid input (at token 2: '${c.args['spec']}')`; if (/^(Ethernet|Management)/.test(i.name)) return '% Removal of physical interfaces is not permitted'; this.t.interfaces = this.t.interfaces.filter((x) => x !== i); return ch() } })]
    })
    const vlanP: Param = { kind: 'vlanlist', label: '<1-4094>', test: (t) => expandVlans(t).every((v) => v >= 1 && v <= 4094) }
    C('vlan', 'VLAN configuration', undefined, {
      children: [prm(vlanP, 'VLAN id(s)', { name: 'vl', run: (c) => { const ids = expandVlans(c.args['vl']!); const t = this.t; for (const id of ids) if (!t.vlans.some((v) => v.id === id)) t.vlans.push({ id, name: `VLAN${String(id).padStart(4, '0')}` }); t.vlans.sort((a, b) => a.id - b.id); this.setMode('config-vlan', { ids, label: c.args['vl']! }); return ch() } })]
    })
    C('no vlan', 'VLAN configuration', undefined, { children: [prm(vlanP, 'VLAN id(s)', { name: 'vl', run: (c) => { const ids = expandVlans(c.args['vl']!); if (ids.includes(1)) return '% VLAN 1 cannot be removed'; this.t.vlans = this.t.vlans.filter((v) => !ids.includes(v.id)); return ch() } })] })
    C('vrf instance', 'Configure a VRF instance', undefined, { children: [prm(word(), 'VRF name', { name: 'v', run: (c) => { const t = this.t; let v = t.vrfs.find((x) => x.name === c.args['v']); if (!v) t.vrfs.push((v = { name: c.args['v']!, rd: '', interfaces: [] })); this.setMode('config-vrf', v); return ch() } })] }, { vrf: 'VRF configuration' })
    C('no vrf instance', 'Configure a VRF instance', undefined, { children: [prm(word(), 'VRF name', { name: 'v', run: (c) => { const t = this.t; t.vrfs = t.vrfs.filter((v) => v.name !== c.args['v']); for (const i of t.interfaces) if (i.vrf === c.args['v']) { i.vrf = undefined; i.ip = undefined; i.mask = undefined } return ch() } })] })
    C('router bgp', 'Border Gateway Protocol', undefined, {
      children: [prm({ kind: 'asn', label: '<1-4294967295>' }, 'AS number', { name: 'as', run: (c) => { const t = this.t; const as = Number(c.args['as']); if (t.localAs && t.localAs !== as) return `% BGP is already running with AS number ${t.localAs}`; t.localAs = as; this.setMode('config-router-bgp'); return ch() } })]
    }, { router: 'Routing protocol configuration' })
    C('no router bgp', 'Border Gateway Protocol', () => { const t = this.t; t.bgp = []; t.localAs = 0; return ch() }, { children: [prm({ kind: 'asn', label: '<1-4294967295>' }, 'AS number', { run: () => { const t = this.t; t.bgp = []; t.localAs = 0; return ch() } })] })
    C('router ospf', 'Open Shortest Path First (OSPF)', undefined, { children: [prm(int(1, 65535), 'Process ID', { name: 'pid', run: (c) => { const t = this.t; t.ospf ??= { process: c.args['pid']!, ifaces: [], neighbors: [] }; this.setMode('config-router-ospf'); return ch() } })] })
    C('no router ospf', 'Open Shortest Path First (OSPF)', undefined, { children: [prm(int(1, 65535), 'Process ID', { run: () => { this.t.ospf = undefined; return ch() } })] })
    const routeNodes = (remove: boolean): Node[] => {
      const run = (c: Ctx): string => {
        const t = this.t
        const [ip, len] = c.args['p']!.split('/')
        const net = ip!
        const mask = Number(len)
        const vrf = c.args['vrf']
        const nh = c.args['nh']
        if (remove) {
          const before = t.staticRoutes.length
          t.staticRoutes = t.staticRoutes.filter((r) => !(r.prefix === net && r.mask === mask && r.vrf === vrf && (!nh || r.nextHop === nh)))
          if (before === t.staticRoutes.length) return '% Route not found'
        } else if (!t.staticRoutes.some((r) => r.prefix === net && r.mask === mask && r.nextHop === nh && r.vrf === vrf)) t.staticRoutes.push({ prefix: net, mask, nextHop: nh!, ...(vrf ? { vrf } : {}), ...(c.args['ad'] ? { ad: Number(c.args['ad']) } : {}), ...(c.args['rn'] ? { name: c.args['rn'] } : {}) })
        return ch()
      }
      const nhNode = prm({ kind: 'word', label: 'A.B.C.D', test: (x) => isIpv4(x) || /^null0$/i.test(x) || !!findIface(this.t, x, EOS_TYPES) }, 'Next hop', { name: 'nh', run, children: [prm(int(1, 255), 'Administrative distance', { name: 'ad', run }), kw('name', 'Route name', { children: [prm(word(), 'Name', { name: 'rn', run })] })] })
      const tail = (): Node[] => [prm(prefixP, 'Destination prefix', { name: 'p', ...(remove ? { run } : {}), children: [nhNode] })]
      return [kw('vrf', 'VRF', { children: [prm({ kind: 'word', label: 'VRF', test: (x) => this.t.vrfs.some((v) => v.name === x) }, 'VRF name', { name: 'vrf', children: tail() })] }), ...tail()]
    }
    C('ip route', 'Static route', undefined, { children: routeNodes(false) })
    C('no ip route', 'Static route', undefined, { children: routeNodes(true) })
    C('ip routing', 'Enable IP routing', () => ((this.t.services['ip-routing'] = true), ch()))
    C('no ip routing', 'Enable IP routing', () => ((this.t.services['ip-routing'] = false), ch()))
    const aclEnter = (type: 'standard' | 'extended') => (c: Ctx): string => {
      const t = this.t
      let a = t.acls.find((x) => x.name === c.args['acl'])
      if (!a) t.acls.push((a = { name: c.args['acl']!, type, entries: [] }))
      this.setMode('config-acl', a)
      return ch()
    }
    C('ip access-list', 'IP access list', undefined, { children: [kw('standard', 'Standard access list', { children: [prm(word(), 'Access list name', { name: 'acl', run: aclEnter('standard') })] }), prm({ kind: 'word', label: 'WORD', test: (x) => x !== 'standard' }, 'Access list name', { name: 'acl', run: aclEnter('extended') })] })
    C('no ip access-list', 'IP access list', undefined, { children: [prm(line, 'Access list name', { name: 'acl', run: (c) => { const n = c.args['acl']!.replace(/^standard\s+/, ''); this.t.acls = this.t.acls.filter((a) => a.name !== n); return ch() } })] })
    const plRun = (c: Ctx): string => {
      const t = this.t
      let p = t.prefixLists.find((x) => x.name === c.args['pl'])
      if (!p) t.prefixLists.push((p = { name: c.args['pl']!, entries: [] }))
      const seq = c.args['seq'] ? Number(c.args['seq']) : (p.entries.at(-1)?.seq ?? 0) + 10
      p.entries = p.entries.filter((e) => e.seq !== seq)
      p.entries.push({ seq, action: c.args['act'] as 'permit', prefix: c.args['pfx']!, ...(c.args['ge'] ? { ge: Number(c.args['ge']) } : {}), ...(c.args['le'] ? { le: Number(c.args['le']) } : {}) })
      p.entries.sort((a, b) => a.seq - b.seq)
      return ch()
    }
    const plTail = (): Node[] =>
      ['permit', 'deny'].map((a) =>
        kw(a, a === 'permit' ? 'Specify prefixes to permit' : 'Specify prefixes to deny', {
          name: 'act',
          children: [prm(prefixP, 'Prefix', { name: 'pfx', run: plRun, children: [kw('ge', 'Minimum prefix length', { children: [prm(int(1, 32), 'Length', { name: 'ge', run: plRun, children: [kw('le', 'Maximum prefix length', { children: [prm(int(1, 32), 'Length', { name: 'le', run: plRun })] })] })] }), kw('le', 'Maximum prefix length', { children: [prm(int(1, 32), 'Length', { name: 'le', run: plRun })] })] })]
        })
      )
    const plName: Param = { kind: 'word', label: 'WORD', values: () => this.t.prefixLists.map((p) => p.name) }
    C('ip prefix-list', 'Prefix list', undefined, { children: [prm(plName, 'Prefix list name', { name: 'pl', children: [kw('seq', 'Sequence number', { children: [prm(int(0, 65535), 'Sequence number', { name: 'seq', children: plTail() })] }), ...plTail()] })] })
    C('no ip prefix-list', 'Prefix list', undefined, {
      children: [prm(plName, 'Prefix list name', { name: 'pl', run: (c) => ((this.t.prefixLists = this.t.prefixLists.filter((p) => p.name !== c.args['pl'])), ch()), children: [kw('seq', 'Sequence number', { children: [prm(int(0, 65535), 'Sequence number', { name: 'seq', run: (c) => { const p = this.t.prefixLists.find((x) => x.name === c.args['pl']); if (p) p.entries = p.entries.filter((e) => e.seq !== Number(c.args['seq'])); return ch() } })] })] })]
    })
    const rmEnter = (c: Ctx): string => {
      const t = this.t
      let r = t.routeMaps.find((x) => x.name === c.args['rm'])
      if (!r) t.routeMaps.push((r = { name: c.args['rm']!, entries: [] }))
      const seq = c.args['seq'] ? Number(c.args['seq']) : 10
      let e = r.entries.find((x) => x.seq === seq)
      if (!e) {
        r.entries.push((e = { seq, action: (c.args['act'] as 'permit' | undefined) ?? 'permit', match: [], set: [] }))
        r.entries.sort((a, b) => a.seq - b.seq)
      } else if (c.args['act']) e.action = c.args['act'] as 'permit'
      this.setMode('config-route-map', { rm: r, e })
      return ch()
    }
    const rmSeq = (): Node[] => [prm(int(0, 65535), 'Sequence number', { name: 'seq', run: rmEnter })]
    const rmName: Param = { kind: 'word', label: 'WORD', values: () => this.t.routeMaps.map((r) => r.name) }
    C('route-map', 'Route map configuration', undefined, { children: [prm(rmName, 'Route map name', { name: 'rm', run: rmEnter, children: [kw('permit', 'Permit', { name: 'act', run: rmEnter, children: rmSeq() }), kw('deny', 'Deny', { name: 'act', run: rmEnter, children: rmSeq() }), ...rmSeq()] })] })
    C('no route-map', 'Route map configuration', undefined, { children: [prm(rmName, 'Route map name', { name: 'rm', run: (c) => ((this.t.routeMaps = this.t.routeMaps.filter((r) => r.name !== c.args['rm'])), ch()), children: ['permit', 'deny'].map((a) => kw(a, a, { children: [prm(int(0, 65535), 'Sequence number', { name: 'seq', run: (c) => { const r = this.t.routeMaps.find((x) => x.name === c.args['rm']); if (r) r.entries = r.entries.filter((e) => e.seq !== Number(c.args['seq'])); return ch() } })] })) })] })
    C('banner motd', 'Message of the day banner', () => {
      this.collecting = []
      return "Enter TEXT message. Type 'EOF' on its own line to end."
    }, {}, { banner: 'Configure banners' })
    C('no banner motd', 'Message of the day banner', () => ((this.t.motd = undefined), ch()))
    C('terminal length', 'Set number of lines on a screen', undefined, { children: [prm(int(0, 32767), 'Number of lines on screen (0 for no pausing)', { name: 'n', run: (c) => { const t = this.t; t.extraConfig = [...t.extraConfig.filter((x) => !/^terminal length /.test(x)), `terminal length ${c.args['n']}`]; ch(); return this.setLength(Number(c.args['n'])) } })] }, { terminal: 'Configure the terminal' })
    for (const [w, help] of [
      ['username', 'Configure a user'],
      ['ntp', 'NTP configuration'],
      ['logging', 'Logging configuration'],
      ['spanning-tree', 'Spanning tree configuration'],
      ['snmp-server', 'SNMP configuration'],
      ['alias', 'Configure a command alias'],
      ['aaa', 'Authentication, authorization and accounting'],
      ['service', 'Service configuration'],
      ['clock', 'Clock configuration'],
      ['dns', 'DNS configuration']
    ] as const) {
      C(w, help, undefined, { children: [prm(line, 'Arguments', { name: 'rest', run: (c) => { const t = this.t; const l = `${w} ${c.args['rest']}`; if (!t.extraConfig.includes(l)) t.extraConfig.push(l); return ch() } })] })
      C(`no ${w}`, help, undefined, { children: [prm(line, 'Arguments', { name: 'rest', run: (c) => { const t = this.t; t.extraConfig = t.extraConfig.filter((x) => !x.startsWith(`${w} ${c.args['rest']}`)); return ch() } })] })
    }
    C('commit', 'Commit the configuration session', (c) => this.commitHere(c), { children: [kw('timer', 'Commit with an automatic rollback unless confirmed', { children: [prm({ kind: 'time', label: 'hh:mm:ss' }, 'Time before rollback', { name: 'tm', run: (c) => this.commitHere(c) })] })] })
    C('abort', 'Abort the configuration session', () => (this.sess ? this.abort(this.sess.name) : '% Not in a configuration session'))
    C('do', 'Run an EXEC command', undefined, { children: [prm(line, 'Command', { name: 'cmd', run: (c) => this.runExec(c.args['cmd']!) })] })
    C('end', 'Exit configuration mode', () => (this.endConfig(), ''))
    C('exit', 'Exit from the current mode', () => (this.exitMode(), ''))

    // ---- interface
    const ifm: Node[] = []
    const I = (path: string, help: string, run: ((i: Iface, c: Ctx) => string) | undefined, extra: Partial<Node> = {}, helps: Record<string, string> = {}): Node =>
      add(ifm, path, help, run ? (c: Ctx) => this.eachIf((i) => run(i, c)) : undefined, extra, { ...H, switchport: 'Set switching mode characteristics', 'switchport trunk': 'Trunking characteristics', 'switchport trunk allowed': 'Allowed VLANs', 'ip ospf': 'OSPF interface commands', ...helps })
    const leaf = (param: Param, help: string, name: string, run: (i: Iface, c: Ctx) => string, children?: Node[]): Node => prm(param, help, { name, run: (c) => this.eachIf((i) => run(i, c)), ...(children ? { children } : {}) })
    I('description', 'Description string', undefined, { children: [leaf(line, 'Up to 240 characters describing this interface', 'desc', (i, c) => ((i.description = c.args['desc']), ch()))] })
    I('no description', 'Description string', (i) => ((i.description = undefined), ch()))
    I('shutdown', 'Disable the interface', (i) => this.shut(i, true))
    I('no shutdown', 'Disable the interface', (i) => this.shut(i, false))
    I('ip address', 'Set IP address of an interface', undefined, {
      children: [leaf(prefixP, 'IP address with mask length', 'pfx', (i, c) => this.setIp(i, c.args['pfx']!)), prm(ipP, 'IP address', { name: 'ip', children: [leaf({ kind: 'mask', label: 'A.B.C.D' }, 'Subnet mask', 'mask', (i, c) => this.setIp(i, `${c.args['ip']}/${dottedToLen(c.args['mask']!)}`))] })]
    })
    I('no ip address', 'Set IP address of an interface', (i) => ((i.ip = undefined), (i.mask = undefined), ch()))
    I('mtu', 'Set IP MTU on interface', undefined, { children: [leaf(int(68, 9214), 'MTU in bytes', 'mtu', (i, c) => ((i.mtu = Number(c.args['mtu'])), ch()))] })
    I('no mtu', 'Set IP MTU on interface', (i) => ((i.mtu = undefined), ch()))
    I('switchport', 'Set switching mode characteristics', (i) => (i.mode === 'routed' ? ((i.mode = 'access'), (i.vlan ??= 1), (i.ip = undefined), (i.mask = undefined), ch()) : ''))
    I('no switchport', 'Set switching mode characteristics', (i) => ((i.mode = 'routed'), ch()))
    I('switchport mode', 'Set trunking mode of the interface', undefined, { children: [leaf({ kind: 'enum', label: 'access', values: () => ['access', 'trunk'] }, 'Port mode', 'm', (i, c) => ((i.mode = c.args['m']!.toLowerCase() === 'trunk' ? 'trunk' : 'access'), ch()))] })
    I('switchport access vlan', 'Set VLAN when interface is in access mode', undefined, {
      children: [leaf(int(1, 4094), 'VLAN id', 'vl', (i, c) => {
        const id = Number(c.args['vl'])
        i.vlan = id
        if (i.mode === 'routed') i.mode = 'access'
        ch()
        return this.t.vlans.some((v) => v.id === id) ? '' : `! Access VLAN does not exist. Creating vlan ${id}`.replace(/^.*$/, (m) => ((this.t.vlans.push({ id, name: `VLAN${String(id).padStart(4, '0')}` }), this.t.vlans.sort((a, b) => a.id - b.id)), m))
      })]
    }, { 'switchport access': 'Access mode characteristics' })
    const allowed = (op: 'set' | 'add' | 'remove' | 'except') => (i: Iface, c: Ctx): string => {
      const v = expandVlans(c.args['vl']!)
      const all = Array.from({ length: 4094 }, (_, n) => n + 1)
      const cur = i.trunkAllowed ?? all
      i.trunkAllowed = op === 'set' ? v : op === 'add' ? [...new Set([...cur, ...v])].sort((a, b) => a - b) : op === 'remove' ? cur.filter((x) => !v.includes(x)) : all.filter((x) => !v.includes(x))
      if (i.trunkAllowed.length === 4094) i.trunkAllowed = undefined
      return ch()
    }
    const vlP: Param = { kind: 'vlanlist', label: 'VLAN_SET' }
    I('switchport trunk allowed vlan', 'Allowed VLANs on the trunk', undefined, {
      children: [
        leaf(vlP, 'VLAN ids', 'vl', allowed('set')),
        kw('add', 'Add VLANs to the current list', { children: [leaf(vlP, 'VLAN ids', 'vl', allowed('add'))] }),
        kw('remove', 'Remove VLANs from the current list', { children: [leaf(vlP, 'VLAN ids', 'vl', allowed('remove'))] }),
        kw('except', 'All VLANs except the following', { children: [leaf(vlP, 'VLAN ids', 'vl', allowed('except'))] }),
        kw('all', 'All VLANs', { run: () => this.eachIf((i) => ((i.trunkAllowed = undefined), ch())) }),
        kw('none', 'No VLANs', { run: () => this.eachIf((i) => ((i.trunkAllowed = []), ch())) })
      ]
    })
    I('no switchport trunk allowed vlan', 'Allowed VLANs on the trunk', (i) => ((i.trunkAllowed = undefined), ch()))
    I('switchport trunk native vlan', 'Native VLAN', undefined, { children: [leaf(int(1, 4094), 'VLAN id', 'vl', (i, c) => ((i.nativeVlan = Number(c.args['vl'])), ch()))] }, { 'switchport trunk native': 'Native VLAN' })
    I('speed', 'Configure speed', undefined, { children: [kw('auto', 'Autonegotiate', { run: () => this.eachIf((i) => ((i.speedSet = undefined), ch())) }), kw('forced', 'Force speed and duplex', { children: [leaf({ kind: 'enum', label: '10gfull', values: () => ['1gfull', '10gfull', '25gfull', '100full', '100half', '10full', '10half'] }, 'Speed and duplex', 'sp', (i, c) => { const v = c.args['sp']!.toLowerCase(); i.speedSet = v.replace(/(full|half)$/, '').toUpperCase().replace(/^(\d+)$/, '$1M'); i.duplex = v.endsWith('half') ? 'half' : 'full'; return ch() })] })] })
    I('no speed', 'Configure speed', (i) => ((i.speedSet = undefined), (i.duplex = undefined), ch()))
    I('vrf', 'VRF membership', undefined, { children: [leaf({ kind: 'word', label: 'VRF', test: (x) => x === 'default' || this.t.vrfs.some((v) => v.name === x) }, 'VRF name', 'vrf', (i, c) => { const had = i.ip; i.vrf = c.args['vrf'] === 'default' ? undefined : c.args['vrf']; i.ip = undefined; i.mask = undefined; ch(); return had ? `! Interface ${i.name} IP address ${had} removed due to enabling VRF ${c.args['vrf']}` : '' })] })
    I('channel-group', 'Link aggregation', undefined, { children: [prm(int(1, 2000), 'Channel group', { name: 'cg', children: [kw('mode', 'LACP mode', { children: [leaf({ kind: 'enum', label: 'active', values: () => ['active', 'passive', 'on'] }, 'Mode', 'm', (i, c) => ((i.channelGroup = Number(c.args['cg'])), ch()))] })] })] })
    I('no channel-group', 'Link aggregation', (i) => ((i.channelGroup = undefined), ch()))
    I('spanning-tree bpduguard', 'BPDU guard', undefined, { children: [leaf({ kind: 'enum', label: 'enable', values: () => ['enable', 'disable'] }, 'BPDU guard', 'bg', (i, c) => ((i.bpduGuard = c.args['bg'] === 'enable'), ch()))] }, { 'spanning-tree': 'Spanning tree configuration' })
    I('no spanning-tree bpduguard', 'BPDU guard', (i) => ((i.bpduGuard = false), ch()))
    const ospfIf = (i: Iface): NonNullable<Device['ospf']>['ifaces'][number] => {
      const t = this.t
      t.ospf ??= { process: '1', ifaces: [], neighbors: [] }
      let o = t.ospf.ifaces.find((x) => x.iface === i.name)
      if (!o) t.ospf.ifaces.push((o = { iface: i.name, area: '0.0.0.0' }))
      return o
    }
    I('ip ospf area', 'OSPF area', undefined, { children: [leaf({ kind: 'word', label: 'AREA' }, 'Area id', 'area', (i, c) => ((ospfIf(i).area = c.args['area']!), ch()))] })
    I('no ip ospf area', 'OSPF area', (i) => { const t = this.t; if (t.ospf) t.ospf.ifaces = t.ospf.ifaces.filter((o) => o.iface !== i.name); return ch() })
    I('ip ospf network point-to-point', 'Point-to-point network', (i) => ((ospfIf(i).networkType = 'point-to-point'), ch()), {}, { 'ip ospf network': 'OSPF network type' })
    I('no ip ospf network', 'OSPF network type', (i) => ((ospfIf(i).networkType = undefined), ch()))
    I('ip ospf cost', 'Interface cost', undefined, { children: [leaf(int(1, 65535), 'Cost', 'cost', (i, c) => ((ospfIf(i).cost = Number(c.args['cost'])), ch()))] })
    I('show active', 'Running config of this mode', () => '')
    ifm.push(kw('exit', 'Exit from interface configuration mode', { run: () => (this.exitMode(), '') }))

    // ---- vlan
    const vctx = (): number[] => (this.mode.ctx as { ids: number[] }).ids
    const eachVlan = (f: (v: Device['vlans'][number]) => void): string => {
      for (const id of vctx()) {
        const v = this.t.vlans.find((x) => x.id === id)
        if (v) f(v)
      }
      return ch()
    }
    const vlm: Node[] = [
      kw('name', 'Name of the VLAN', { children: [prm(word(), 'VLAN name', { name: 'n', run: (c) => eachVlan((v) => (v.name = c.args['n']!)) })] }),
      kw('state', 'VLAN state', { children: [kw('active', 'Active', { run: () => eachVlan((v) => (v.shutdown = false)) }), kw('suspend', 'Suspended', { run: () => eachVlan((v) => (v.shutdown = true)) })] }),
      kw('shutdown', 'Disable the VLAN', { run: () => eachVlan((v) => (v.shutdown = true)) }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('name', 'Name of the VLAN', { run: () => eachVlan((v) => (v.name = `VLAN${String(v.id).padStart(4, '0')}`)) }), kw('shutdown', 'Disable the VLAN', { run: () => eachVlan((v) => (v.shutdown = false)) })] }),
      kw('exit', 'Exit from VLAN configuration mode', { run: () => (this.exitMode(), '') })
    ]

    // ---- router bgp
    const nbrP: Param = { kind: 'ipv4', label: 'A.B.C.D', values: () => this.t.bgp.map((n) => n.ip) }
    const nb = (c: Ctx): Device['bgp'][number] | undefined => this.t.bgp.find((n) => n.ip === c.args['nb'])
    const needNb = (c: Ctx, f: (n: Device['bgp'][number]) => void): string => {
      const n = nb(c)
      if (!n) return `% Neighbor ${c.args['nb']} not configured; specify remote-as first`
      f(n)
      return ch()
    }
    const live = (): boolean => !this.sess
    const adj = (n: Device['bgp'][number], why: string): void => {
      if (live() && n.upSince !== undefined && n.upSince <= now(this.d)) logEvent(this.d, `Bgp: %BGP-5-ADJCHANGE: peer ${n.ip} (VRF default AS ${n.remoteAs}) old state Established event ${why} new state Idle`)
    }
    const bgpNbr: Node[] = [
      kw('remote-as', 'Neighbor AS number', {
        children: [prm({ kind: 'asn', label: '<1-4294967295>' }, 'AS number', {
          name: 'as',
          run: (c) => {
            const t = this.t
            const as = Number(c.args['as'])
            let n = nb(c)
            if (!n) {
              const via = t.interfaces.find((i) => i.ip && i.mask !== undefined && inSubnet(c.args['nb']!, i.ip, i.mask))
              t.bgp.push((n = { ip: c.args['nb']!, remoteAs: as, via: via?.name ?? 'Loopback0', prefixes: 0 }))
            } else if (n.remoteAs !== as) {
              adj(n, 'Stop')
              n.remoteAs = as
              n.upSince = undefined
              n.downSince = now(this.d)
            }
            return ch()
          }
        })]
      }),
      kw('description', 'Neighbor description', { children: [prm(line, 'Description', { name: 'desc', run: (c) => needNb(c, (n) => (n.description = c.args['desc'])) })] }),
      kw('shutdown', 'Disable the neighbor', { run: (c) => needNb(c, (n) => { if (!n.shutdown) adj(n, 'Stop'); n.shutdown = true }) }),
      kw('password', 'Neighbor password', { children: [prm(line, 'Password', { name: 'pw', run: (c) => needNb(c, (n) => (n.password = c.args['pw']!.replace(/^[07]\s+/, ''))) })] }),
      kw('route-map', 'Route map', { children: [prm({ kind: 'word', label: 'WORD', values: () => this.t.routeMaps.map((r) => r.name) }, 'Route map name', { name: 'rm', children: ['in', 'out'].map((dir) => kw(dir, dir === 'in' ? 'Inbound' : 'Outbound', { run: (c) => needNb(c, (n) => { if (dir === 'in') n.routeMapIn = c.args['rm']; else n.routeMapOut = c.args['rm'] }) })) })] }),
      kw('update-source', 'Source interface', { children: [prm(this.ifParam(), 'Interface', { name: 'us', run: (c) => needNb(c, (n) => (n.updateSource = findIface(this.t, c.args['us']!, EOS_TYPES)?.name)) })] }),
      kw('ebgp-multihop', 'Allow multihop eBGP', { run: (c) => needNb(c, () => {}), children: [prm(int(1, 255), 'TTL', { run: (c) => needNb(c, () => {}) })] }),
      kw('send-community', 'Send communities', { run: (c) => needNb(c, () => {}) }),
      kw('maximum-routes', 'Maximum routes', { children: [prm(int(0, 4294967294), 'Number of routes', { run: (c) => needNb(c, () => {}) })] }),
      kw('activate', 'Activate the neighbor in the address family', { run: () => '' })
    ]
    const noNbr: Node[] = [
      kw('shutdown', 'Disable the neighbor', { run: (c) => needNb(c, (n) => (n.shutdown = false)) }),
      kw('description', 'Neighbor description', { run: (c) => needNb(c, (n) => (n.description = undefined)) }),
      kw('password', 'Neighbor password', { run: (c) => needNb(c, (n) => (n.password = undefined)) }),
      kw('route-map', 'Route map', { children: [prm(word(), 'Route map name', { children: ['in', 'out'].map((dir) => kw(dir, dir, { run: (c) => needNb(c, (n) => { if (dir === 'in') n.routeMapIn = undefined; else n.routeMapOut = undefined }) })) })] }),
      kw('remote-as', 'Neighbor AS number', { run: (c) => this.removeNeighbor(c.args['nb']!), children: [prm({ kind: 'asn', label: '<1-4294967295>' }, 'AS number', { run: (c) => this.removeNeighbor(c.args['nb']!) })] })
    ]
    const bgpm: Node[] = [
      kw('router-id', 'Router identifier', { children: [prm(ipP, 'Router ID', { name: 'rid', run: (c) => ((this.t.routerId = c.args['rid']!), ch()) })] }),
      kw('neighbor', 'Neighbor configuration', { children: [prm(nbrP, 'Neighbor address', { name: 'nb', children: bgpNbr })] }),
      kw('network', 'Network to advertise', { children: [prm(prefixP, 'Prefix', { run: () => ch(), children: [kw('route-map', 'Route map', { children: [prm(word(), 'Name', { run: () => ch() })] })] })] }),
      kw('maximum-paths', 'Maximum ECMP paths', { children: [prm(int(1, 600), 'Paths', { run: () => ch(), children: [kw('ecmp', 'ECMP group size', { children: [prm(int(1, 600), 'Size', { run: () => ch() })] })] })] }),
      kw('address-family', 'Address family configuration', { children: [kw('ipv4', 'IPv4', { run: () => (this.setMode('config-router-bgp-af', undefined, this.mode), ''), children: [kw('unicast', 'Unicast', { run: () => (this.setMode('config-router-bgp-af', undefined, this.mode), '') })] }), kw('evpn', 'EVPN', { run: () => (this.setMode('config-router-bgp-af', undefined, this.mode), '') })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('neighbor', 'Neighbor configuration', { children: [prm(nbrP, 'Neighbor address', { name: 'nb', run: (c) => this.removeNeighbor(c.args['nb']!), children: noNbr })] }),
          kw('router-id', 'Router identifier', { run: () => ch() }),
          kw('network', 'Network to advertise', { children: [prm(line, 'Prefix', { run: () => ch() })] })
        ]
      }),
      kw('exit', 'Exit from router configuration mode', { run: () => (this.exitMode(), '') })
    ]
    const afm: Node[] = [
      kw('neighbor', 'Neighbor configuration', { children: [prm(nbrP, 'Neighbor address', { name: 'nb', children: bgpNbr.filter((n) => ['activate', 'route-map'].includes(n.word!)) })] }),
      kw('network', 'Network to advertise', { children: [prm(prefixP, 'Prefix', { run: () => ch() })] }),
      kw('exit', 'Exit from address family mode', { run: () => ((this.mode = this.mode.up ?? this.configMode()), '') })
    ]

    // ---- router ospf
    const ospfm: Node[] = [
      kw('router-id', 'OSPF router ID', { children: [prm(ipP, 'Router ID', { name: 'rid', run: (c) => ((this.t.ospf!.routerId = c.args['rid']!), ch()) })] }),
      kw('network', 'Enable OSPF on a network', {
        children: [prm(prefixP, 'Prefix', { name: 'net', children: [kw('area', 'OSPF area', { children: [prm({ kind: 'word', label: 'AREA' }, 'Area id', { name: 'area', run: (c) => { const t = this.t; const [ip, len] = c.args['net']!.split('/'); for (const i of t.interfaces) if (i.ip && inSubnet(i.ip, ip!, Number(len)) && !t.ospf!.ifaces.some((o) => o.iface === i.name)) t.ospf!.ifaces.push({ iface: i.name, area: c.args['area']! }); return ch() } })] })] })]
      }),
      kw('passive-interface', 'Suppress OSPF on an interface', { children: [prm(this.ifParam(), 'Interface', { name: 'if', run: (c) => { const o = this.t.ospf!.ifaces.find((x) => x.iface === this.ifOf(c)?.name); if (o) o.passive = true; return ch() } })] }),
      kw('max-lsa', 'Maximum LSAs', { children: [prm(int(1, 100000), 'Number', { run: () => ch() })] }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('passive-interface', 'Suppress OSPF on an interface', { children: [prm(this.ifParam(), 'Interface', { name: 'if', run: (c) => { const o = this.t.ospf!.ifaces.find((x) => x.iface === this.ifOf(c)?.name); if (o) o.passive = false; return ch() } })] })] }),
      kw('exit', 'Exit from router configuration mode', { run: () => (this.exitMode(), '') })
    ]

    // ---- ACL
    const aclEntry = (c: Ctx): string => {
      const a = this.mode.ctx as Acl
      const act = c.args['act'] as Acl['entries'][number]['action']
      const seq = c.args['seq'] ? Number(c.args['seq']) : (a.entries.at(-1)?.seq ?? 0) + 10
      if (a.entries.some((e) => e.seq === seq)) return '% Duplicate sequence number'
      a.entries.push({ seq, action: act, text: c.args['rest'] ?? '' })
      a.entries.sort((x, y) => x.seq - y.seq)
      return ch()
    }
    const acts = (): Node[] => ['permit', 'deny', 'remark'].map((w) => kw(w, w === 'remark' ? 'Comment' : w === 'permit' ? 'Specify packets to forward' : 'Specify packets to drop', { name: 'act', children: [prm(line, 'Match criteria', { name: 'rest', run: aclEntry })] }))
    const aclm: Node[] = [
      ...acts(),
      prm(int(1, 4294967295), 'Sequence number', { name: 'seq', children: acts() }),
      kw('no', 'Negate a command or set its defaults', { children: [prm(int(1, 4294967295), 'Sequence number', { name: 'seq', run: (c) => { const a = this.mode.ctx as Acl; a.entries = a.entries.filter((e) => e.seq !== Number(c.args['seq'])); return ch() } })] }),
      kw('exit', 'Exit from ACL configuration mode', { run: () => (this.exitMode(), '') })
    ]

    // ---- route-map
    const rmc = (): { rm: RouteMap; e: RouteMap['entries'][number] } => this.mode.ctx as { rm: RouteMap; e: RouteMap['entries'][number] }
    const rmm: Node[] = [
      kw('match', 'Route map match rules', { children: [prm(line, 'Match clause', { name: 'm', run: (c) => { rmc().e.match.push(c.args['m']!); return ch() } })] }),
      kw('set', 'Route map set rules', { children: [prm(line, 'Set clause', { name: 's', run: (c) => { rmc().e.set.push(c.args['s']!); return ch() } })] }),
      kw('description', 'Description', { children: [prm(line, 'Text', { run: () => ch() })] }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('match', 'Route map match rules', { children: [prm(line, 'Match clause', { name: 'm', run: (c) => { const e = rmc().e; e.match = e.match.filter((x) => x !== c.args['m']); return ch() } })] }), kw('set', 'Route map set rules', { children: [prm(line, 'Set clause', { name: 's', run: (c) => { const e = rmc().e; e.set = e.set.filter((x) => x !== c.args['s']); return ch() } })] })] }),
      kw('exit', 'Exit from route-map configuration mode', { run: () => (this.exitMode(), '') })
    ]
    const vrfm: Node[] = [kw('description', 'Description', { children: [prm(line, 'Text', { run: () => ch() })] }), kw('rd', 'Route distinguisher', { children: [prm(word('ASN:nn'), 'Route distinguisher', { name: 'rd', run: (c) => (((this.mode.ctx as Device['vrfs'][number]).rd = c.args['rd']!), ch()) })] }), kw('exit', 'Exit from VRF configuration mode', { run: () => (this.exitMode(), '') })]
    for (const t of [g, ifm]) t.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return { config: g, 'config-if': ifm, 'config-vlan': vlm, 'config-router-bgp': bgpm, 'config-router-bgp-af': afm, 'config-router-ospf': ospfm, 'config-acl': aclm, 'config-route-map': rmm, 'config-vrf': vrfm }
  }

  // ------------------------------------------------------------------ config helpers

  private eachIf(f: (i: Iface) => string): string {
    const ctx = this.mode.ctx as IfCtx | undefined
    return (ctx?.list ?? []).map(f).filter(Boolean).join('\n')
  }

  private enterIf(spec: string): string {
    const t = this.t
    const compact = spec.replace(/\s+/g, '')
    const list: Iface[] = []
    const labels: string[] = []
    let type: IfType | undefined
    for (const part of compact.split(',')) {
      const m = /^([A-Za-z-]*)(\d+(?:\/\d+)*)(?:\.(\d+))?(?:-(\d+))?$/.exec(part)
      if (!m) return `% Invalid input (at token 1: '${spec.split(/\s+/)[0]}')`
      if (m[1]) {
        const w = m[1].toLowerCase()
        type = EOS_TYPES.find((x) => x.short.toLowerCase() === w) ?? EOS_TYPES.find((x) => x.full.toLowerCase().startsWith(w))
        if (!type) return `% Invalid input (at token 1: '${spec.split(/\s+/)[0]}')`
      }
      if (!type) return `% Invalid input (at token 1: '${spec.split(/\s+/)[0]}')`
      labels.push(m[1] ? part.replace(/^[A-Za-z-]+/, SHORT_FOR(m[1]) ?? m[1]) : part)
      const num = m[2]!
      const head = num.includes('/') ? num.slice(0, num.lastIndexOf('/') + 1) : ''
      const from = Number(num.slice(head.length))
      const to = m[4] !== undefined ? Number(m[4]) : from
      for (let n = from; n <= to; n++) {
        const name = `${type.full}${head}${n}${m[3] ? `.${m[3]}` : ''}`
        let i = t.interfaces.find((x) => x.name.toLowerCase() === name.toLowerCase())
        if (!i) {
          if (!/^(Loopback|Vlan|Port-Channel|Tunnel|Vxlan)$/.test(type.full) && !m[3]) return `% Invalid input (at token 1: '${spec.split(/\s+/)[0]}')`
          i = { name, short: `${type.short}${head}${n}${m[3] ? `.${m[3]}` : ''}`, adminUp: true, linkUp: true, mode: type.full === 'Port-Channel' ? 'trunk' : 'routed', speed: '', mac: type.full === 'Vlan' ? `2899.3a11.${(n & 0xffff).toString(16).padStart(4, '0')}` : '', ...(type.full === 'Loopback' ? { mtu: 65535 } : {}) }
          if (type.full === 'Port-Channel') i.linkUp = t.interfaces.some((x) => x.channelGroup === n && isUp(x))
          t.interfaces.push(i)
          this.changed()
        }
        list.push(i)
      }
    }
    this.setMode('config-if', { list, label: labels.join(',') })
    return ''
  }

  private shut(i: Iface, down: boolean): string {
    const d = this.t
    const live = !this.sess
    const tag = `${i.name}${i.description ? ` (${i.description})` : ''}`
    if (down && i.adminUp) {
      const wasUp = isUp(i)
      i.adminUp = false
      i.lastChange = now(this.d)
      if (live) {
        if (wasUp) logEvent(d, `Ebra: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${tag}, changed state to down`)
        for (const n of d.bgp.filter((b) => b.via === i.name && b.upSince !== undefined && b.upSince <= now(d))) logEvent(d, `Bgp: %BGP-5-ADJCHANGE: peer ${n.ip} (VRF ${n.vrf ?? 'default'} AS ${n.remoteAs}) old state Established event Stop new state Idle`)
        for (const n of d.ospf?.neighbors.filter((x) => x.iface === i.name) ?? []) logEvent(d, `Ospf: %OSPF-4-OSPF_ADJACENCY_TEARDOWN: NGB ${n.routerId}, interface ${n.ip} adjacency dropped: interface went down`)
      }
    } else if (!down && (!i.adminUp || i.errDisabled)) {
      const err = i.errDisabled
      i.adminUp = true
      i.lastChange = now(this.d)
      if (err) {
        i.errDisabled = undefined
        // The cause is still there (bpduguard still on): the port goes errdisabled again.
        if (live && !(err === 'bpduguard' && !i.bpduGuard)) {
          const rt = runtime(this.d)
          const dev = this.d
          rt.timer(`errdis-${i.name}`, 1500, () => {
            if (!i.adminUp) return
            i.errDisabled = err
            const msg = `Ebra: %ETH-4-ERRDISABLE: ${err} error detected on ${i.name}.`
            logEvent(dev, msg)
            rt.broadcast(`${R.logStamp(now(dev))} ${dev.hostname} ${msg}`)
          })
        }
      }
      if (live) {
        if (isUp(i)) logEvent(d, `Ebra: %LINEPROTO-5-UPDOWN: Line protocol on Interface ${tag}, changed state to up`)
        const peers = d.bgp.filter((b) => b.via === i.name)
        tickBgp(d)
        const dev = this.d
        for (const n of peers) runtime(dev).timer(`bgp-up-${n.ip}`, 4500, () => { if (n.upSince !== undefined && n.upSince <= now(dev)) logEvent(dev, `Bgp: %BGP-5-ADJCHANGE: peer ${n.ip} (VRF ${n.vrf ?? 'default'} AS ${n.remoteAs}) old state OpenConfirm event RecvKeepAlive new state Established`) })
      }
    }
    return this.changed()
  }

  private setIp(i: Iface, pfx: string): string {
    const [ip, len] = pfx.split('/')
    const mask = Number(len)
    if (i.mode !== 'routed' && /^(Ethernet|Port-Channel)/.test(i.name)) return '! IP address cannot be configured on a switched port; use "no switchport" first'
    const clash = this.t.interfaces.find((x) => x !== i && x.ip && x.mask !== undefined && x.vrf === i.vrf && mask < 32 && x.mask < 32 && inSubnet(ip!, x.ip, Math.min(x.mask, mask)))
    if (clash) return `% Address ${ip}/${mask} overlaps with existing subnet on interface ${clash.name}`
    i.ip = ip
    i.mask = mask
    return this.changed()
  }

  private removeNeighbor(ip: string): string {
    const t = this.t
    const n = t.bgp.find((x) => x.ip === ip)
    if (!n) return ''
    if (!this.sess && n.upSince !== undefined && n.upSince <= now(this.d)) logEvent(this.d, `Bgp: %BGP-5-ADJCHANGE: peer ${n.ip} (VRF default AS ${n.remoteAs}) old state Established event Stop new state Idle`)
    t.bgp = t.bgp.filter((x) => x !== n)
    return this.changed()
  }

  private async runExec(line: string): Promise<string> {
    const m = matchIn(line, this.execTree())
    if (!m) {
      const { match } = await import('../../core/tree.ts')
      const r = match(line, this.execTree())
      return r.ok ? '' : this.error(line, r)
    }
    return ((await m.node.run!(m.ctx)) ?? '') as string
  }

  // ------------------------------------------------------------------ sessions

  private enterConfig(): string {
    this.setMode('config')
    return ''
  }

  private enterSession(name?: string): string {
    const st = this.store()
    const d = this.d
    if (!name) {
      do name = `sess-${++st.seq}`
      while (st.sessions[name])
    }
    let s = st.sessions[name]
    if (!s || s.state === 'completed') {
      const pending = Object.values(st.sessions).filter((x) => x.state !== 'completed').length
      if (pending >= 5) return '% Maximum number of pending sessions has been reached'
      s = st.sessions[name] = { config: snapshot(d), state: 'pending', user: this.s.user, created: now(d) }
    }
    const dev = deviceFrom(d, s.config)
    setClock(dev, runtime(d).clock)
    this.sess = { name, dev }
    this.setMode('config')
    return ''
  }

  private commitHere(c: Ctx): string {
    if (!this.sess) return '% Not in a configuration session'
    this.persistSession()
    const name = this.sess.name
    const out = this.commit(name, c.args['tm'])
    this.sess = undefined
    this.mode = { id: 'exec' }
    return out
  }

  /** Commit a session into running-config, optionally with a rollback timer (hh:mm:ss). */
  private commit(name: string, timer?: string): string {
    const d = this.d
    const st = this.store()
    const s = st.sessions[name]
    if (!s) return `% Configuration session ${name} does not exist`
    const rt = runtime(d)
    const confirming = rt.pending(commitKey(name))
    if (confirming) rt.cancel(commitKey(name))
    if (s.state === 'completed' && !confirming) return `% Configuration session ${name} has already been committed`
    const backup = confirming && s.backup ? s.backup : snapshot(d)
    restore(d, s.config)
    this.changed()
    logEvent(d, `ConfigAgent: %SYS-5-CONFIG_SESSION_COMMIT_SUCCESS: User ${this.s.user} committed configuration session ${name} successfully from vty3 (${this.s.from})`)
    if (timer) {
      const [h = 0, m = 0, sec = 0] = timer.split(':').map(Number)
      const ms = ((h * 60 + m) * 60 + sec) * 1000
      s.backup = backup
      s.state = 'pendingCommitTimer'
      s.timerEnd = now(d) + ms
      armCommitTimer(d, name, ms)
    } else {
      s.state = 'completed'
      delete s.backup
      delete s.timerEnd
    }
    return ''
  }

  private abort(name: string): string {
    const st = this.store()
    const s = st.sessions[name]
    if (!s) return `% Configuration session ${name} does not exist`
    // A session waiting on its commit timer: aborting it rolls running-config back now (the same
    // thing the timer does when it expires).
    if (runtime(this.d).pending(commitKey(name)) && s.backup) {
      restore(this.d, s.backup)
      this.changed()
      logEvent(this.d, `ConfigAgent: %SYS-5-CONFIG_SESSION_ABORTED: User ${this.s.user} aborted configuration session ${name}; running-config rolled back`)
    }
    runtime(this.d).cancel(commitKey(name))
    delete st.sessions[name]
    if (this.sess?.name === name) {
      this.sess = undefined
      this.mode = { id: 'exec' }
    }
    return ''
  }

  private deleteSession(name: string): string {
    if (this.sess?.name === name) return '% Cannot delete the current session'
    return this.abort(name)
  }

  private sessionConfig(diffs: boolean, named?: string): string {
    let dev: Device | undefined
    let name: string
    if (named) {
      const s = this.store().sessions[named]
      if (!s) return `% Configuration session ${named} does not exist`
      dev = this.sess?.name === named ? this.sess.dev : deviceFrom(this.d, s.config)
      name = named
    } else {
      if (!this.sess) return '% Not in a configuration session'
      dev = this.sess.dev
      name = this.sess.name
    }
    if (!diffs) return configLines(dev).join('\n').replace('! Command: show running-config', '! Command: show session-config')
    return unifiedDiff(configLines(this.d), configLines(dev), 'system:/running-config', `session:/${name}-session-config`).join('\n')
  }

  private showSessions(detail: boolean): string {
    const st = this.store()
    const names = Object.keys(st.sessions)
    const rows = names.map((n) => {
      const s = st.sessions[n]!
      const cur = this.sess?.name === n ? '* ' : '  '
      return `${cur}${n.padEnd(14)}${s.state.padEnd(20)}${(s.state === 'completed' ? '' : s.user).padEnd(12)}${this.sess?.name === n ? 'vty3' : ''}${detail && s.description ? `  ${s.description}` : ''}`.trimEnd()
    })
    return ['Maximum number of completed sessions: 1', 'Maximum number of pending sessions: 5', '', '  Name          State               User        Terminal', '  ------------- ------------------- ----------- --------', ...rows].join('\n')
  }

  private runningDiffs(): string {
    return unifiedDiff(startupLines(this.d), configLines(this.d), 'flash:/startup-config', 'system:/running-config').join('\n')
  }

  private showActive(): string {
    const m = this.mode
    if (m.id === 'exec') return '% Invalid input (at token 1: \'active\')'
    const t = this.t
    if (m.id === 'config-if') return (m.ctx as IfCtx).list.map((i) => [`interface ${i.name}`, ...ifaceBody(t, i)].join('\n')).join('\n')
    const lines = configLines(t)
    const head = m.id.startsWith('config-router-bgp') ? /^router bgp/ : m.id === 'config-router-ospf' ? /^router ospf/ : m.id === 'config-vlan' ? /^vlan / : /^(?!)/
    return section(lines, head).join('\n')
  }

  // ------------------------------------------------------------------ exec helpers

  private setLength(n: number): string {
    this.s.pageLength = n
    return n === 0 ? 'Pagination disabled.' : `Pagination set to ${n} lines.`
  }

  private startupConfig(): string {
    const d = this.d
    const lines = startupLines(d)
    const by = (d.vendor['eosSavedBy'] as string | undefined) ?? 'admin'
    return [`! Command: show startup-config`, `! Startup-config last modified at  ${R.eosDate(d.startup?.takenAt ?? d.bootedAt)} by ${by}`, ...lines.slice(1)].join('\n')
  }

  private save(): string {
    this.d.startup = snapshot(this.d)
    this.d.vendor['eosSavedBy'] = this.s.user
    return 'Copy completed successfully.'
  }

  private copy(src: string, dst: string): string {
    const e = (w: string): string => (/^(run|running-config|system:\/?running-config)/i.test(w) ? 'running-config' : /^(start|startup-config|flash:\/?startup-config)/i.test(w) ? 'startup-config' : w)
    const a = e(src)
    const b = e(dst)
    if (a === 'running-config' && b === 'startup-config') return this.save()
    if (a === 'startup-config' && b === 'running-config') {
      if (this.d.startup) restore(this.d, this.d.startup)
      this.changed()
      return 'Copy completed successfully.'
    }
    if (/^(https?|scp|sftp|ftp|tftp):/.test(a) || /^(https?|scp|sftp|ftp|tftp):/.test(b)) return `% Error copying ${src} to ${dst} (Connection timed out)`
    return `% Error copying ${src} to ${dst} (No such file or directory)`
  }

  private async erase(): Promise<string> {
    const a = await this.s.ask('Proceed with erasing startup configuration? [confirm]')
    if (a !== '' && a.toLowerCase() !== 'y') return ''
    return '% [simulator] startup-config was not erased (simulated device)'
  }

  private async reload(force = false): Promise<string> {
    if (!force) {
      if (isDirty(this.d)) {
        const a = (await this.s.ask('System configuration has been modified. Save? [yes/no/cancel/diff]:', { mode: 'line' })).trim().toLowerCase()
        if (a.startsWith('y')) await this.s.print(this.save())
        else if (a.startsWith('d')) return this.runningDiffs()
        else if (!a.startsWith('n')) return ''
      }
      const ok = await this.s.ask('Proceed with reload? [confirm]')
      if (ok !== '' && ok.toLowerCase() !== 'y') return ''
    }
    return '% [simulator] reload acknowledged. The simulator never reboots.'
  }

  private configureReplace(url: string): string {
    const d = this.d
    const u = url.toLowerCase()
    let snap: ConfigSnapshot | undefined
    if (/^(start|startup-config|flash:\/?startup-config)/.test(u)) snap = d.startup ?? snapshot(d)
    else if (u === 'clean-config') return '% [simulator] configure replace clean-config would factory-reset the switch; refused'
    else return `% Error loading ${url} (No such file or directory)`
    restore(d, snap)
    this.changed()
    this.sess = undefined
    this.mode = { id: 'exec' }
    return "! Preserving static routes. Use 'no ip routing delete-static-routes' to clear them."
  }

  private diffFiles(a: string, b: string): string {
    const pick = (w: string): string[] | undefined => (/^run/.test(w) ? configLines(this.d) : /^start/.test(w) ? startupLines(this.d) : undefined)
    const A = pick(a)
    const B = pick(b)
    if (!A || !B) return `% Error opening ${!A ? a : b} (No such file or directory)`
    return unifiedDiff(A, B, a, b).join('\n')
  }

  private dir(): string {
    const size = configLines(this.d).join('\n').length
    return ['Directory of flash:/', '', `       -rwx  1032453120           ${R.eosDate(this.d.bootedAt).slice(4, 10)} 2026  EOS-${this.d.version}.swi`, `       -rwx        ${String(size).padStart(4)}           ${R.eosDate(this.d.startup?.takenAt ?? this.d.bootedAt).slice(4, 10)} 2026  startup-config`, '', '3519545344 bytes total (2112663552 bytes free)'].join('\n')
  }

  private who(): string {
    return ['    Session       Username       Roles               TTY      State       Duration       Auth          Remote Host', '------------- -------------- ------------------- -------- ----------- -------------- ------------- -----------', `*        3     ${this.s.user.padEnd(15)}network-admin       vty3     E           0:00:12        local         ${this.s.from}`].join('\n')
  }

  private async clearCounters(i?: Iface): Promise<string> {
    const t = now(this.d)
    for (const x of i ? [i] : this.d.interfaces) {
      x.clearedAt = t
      x.errors = undefined
      if (x.faultSince !== undefined) x.faultSince = t
    }
    return ''
  }

  private clearBgp(target: string): string {
    const d = this.d
    const list = target === '*' ? d.bgp : d.bgp.filter((n) => n.ip === target)
    if (!list.length) return `% Neighbor ${target} not found`
    for (const n of list) {
      if (n.upSince !== undefined && n.upSince <= now(d)) logEvent(d, `Bgp: %BGP-5-ADJCHANGE: peer ${n.ip} (VRF default AS ${n.remoteAs}) old state Established event Stop new state Idle`)
      n.upSince = undefined
      n.downSince = now(d)
    }
    tickBgp(d)
    return ''
  }

  private async ping(target: string, count: number, vrf?: string): Promise<string> {
    if (!isIpv4(target)) return `ping: ${target}: Name or service not known`
    const ok = reachable(this.d, target, vrf && vrf !== 'default' ? vrf : undefined)
    await this.s.print(`PING ${target} (${target}) 72(100) bytes of data.`)
    let got = 0
    let sent = 0
    for (let k = 0; k < count; k++) {
      if (!(await this.s.sleep(ok ? 40 : 300))) break
      sent++
      if (ok) {
        got++
        await this.s.print(`80 bytes from ${target}: icmp_seq=${k + 1} ttl=64 time=0.${100 + ((k * 37) % 90)} ms`)
      }
    }
    const loss = sent ? Math.round(((sent - got) / sent) * 100) : 0
    return ['', `--- ${target} ping statistics ---`, `${sent} packets transmitted, ${got} received, ${loss}% packet loss, time ${ok ? sent : sent * 1000}ms`, ...(got ? ['rtt min/avg/max/mdev = 0.100/0.131/0.172/0.024 ms, ipg/ewma 0.211/0.145 ms'] : [])].join('\n')
  }

  private async trace(target: string, vrf?: string): Promise<string> {
    if (!isIpv4(target)) return `traceroute: unknown host ${target}`
    await this.s.print(`traceroute to ${target} (${target}), 30 hops max, 60 byte packets`)
    const hops = traceHops(this.d, target, vrf && vrf !== 'default' ? vrf : undefined)
    for (let k = 0; k < hops.length; k++) {
      const h = hops[k]!
      if (!(await this.s.sleep(h === '*' ? 300 : 60))) break
      await this.s.print(h === '*' ? `${String(k + 1).padStart(2)}  * * *` : `${String(k + 1).padStart(2)}  ${h} (${h})  ${(0.3 + k * 0.2).toFixed(3)} ms  ${(0.28 + k * 0.2).toFixed(3)} ms  ${(0.27 + k * 0.2).toFixed(3)} ms`)
    }
    return ''
  }
}

const SHOW_HELP: Record<string, string> = {
  show: 'Show running system information',
  ip: 'Details related to IPv4',
  'show ip': 'Details related to IPv4',
  'show ip interface': 'IP interface status and configuration',
  'show ip bgp': 'BGP information',
  'show ip ospf': 'OSPF information',
  'show interfaces': 'Details related to interfaces',
  'show interfaces counters': 'Interface counters',
  'show mac': 'MAC address table',
  'show mac address-table': 'MAC address table',
  'show lldp': 'LLDP information',
  'show processes': 'Process information',
  'show configuration': 'Configuration information'
}

/** Match `line` against a tree; the match when it is runnable, else undefined. */
function matchIn(line: string, roots: Node[]): { node: Node; ctx: Ctx } | undefined {
  const r = matchSync(line, roots)
  return r.ok ? { node: r.node, ctx: r.ctx } : undefined
}

import { match as matchSync } from '../../core/tree.ts'

/** Emulated Linux pipe commands (EOS hands unknown pipe words to bash). */
function shellPipe(cmd: string, args: string[], lines: string[]): { lines: string[] } | { error: string } {
  const flags = args.filter((a) => /^-/.test(a))
  const rest = args.filter((a) => !/^-/.test(a))
  const has = (f: string): boolean => flags.some((x) => x.includes(f))
  const num = (): number => {
    const n = flags.find((f) => /^-\d+$/.test(f))
    if (n) return Number(n.slice(1))
    const i = args.indexOf('-n')
    return i >= 0 ? Number(args[i + 1]) : 10
  }
  switch (cmd) {
    case 'grep':
    case 'egrep': {
      const pat = unquote(rest.join(' '))
      if (!pat) return { error: 'Usage: grep [OPTION]... PATTERNS [FILE]...' }
      const re = safeRegex(has('w') ? `\\b(?:${pat})\\b` : pat, has('i') ? 'i' : '')
      if (!re) return { error: 'grep: Invalid regular expression' }
      const hit = lines.filter((l) => re.test(l) !== has('v'))
      return { lines: has('c') ? [String(hit.length)] : hit }
    }
    case 'wc':
      return { lines: [has('l') ? String(lines.length) : `${lpad(lines.length, 7)}${lpad(lines.join(' ').split(/\s+/).filter(Boolean).length, 8)}${lpad(lines.join('\n').length + 1, 8)}`] }
    case 'head':
      return { lines: lines.slice(0, num()) }
    case 'tail':
      return { lines: lines.slice(-num()) }
    case 'sort':
      return { lines: [...lines].sort() }
    case 'uniq':
      return { lines: lines.filter((l, k) => l !== lines[k - 1]) }
    default:
      return { error: `bash: ${cmd}: command not found` }
  }
}

const lpad = (s: string | number, n: number): string => String(s).padStart(n)

export const eosFactory = (s: Session): EosPersonality => new EosPersonality(s)
