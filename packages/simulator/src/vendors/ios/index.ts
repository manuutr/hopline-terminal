/**
 * Cisco IOS / IOS-XE personality (docs/research/cli-cisco-ios.md). Immediate-apply config with
 * the real error strings and caret column, priority abbreviations, `?`/Tab, the ` --More-- `
 * pager, archive + `configure replace` + `configure terminal revert timer` rollback.
 */
import type { PagerSpec, Session, TabResult } from '../../core/personality.ts'
import { IOS_TYPES, findIface, parseIfName } from '../../core/ifname.ts'
import { now, runtime } from '../../core/runtime.ts'
import { safeRegex, section } from '../../core/text.ts'
import { add, dottedToLen, isIpv4, kw, maskToDotted, prm, tokenize, tokenOffsets, type Ctx, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { inSubnet } from '../../core/text.ts'
import { CiscoBase, ciscoHelpList, type CMode, type Failure, type PipeOutcome } from '../cisco/base.ts'
import { logEvent, restore, snapshot, tickBgp, isUp, type Acl, type ConfigSnapshot, type Device, type Iface, type RouteMap } from '../../state.ts'
import * as R from './render.ts'
import { configLines, isDirty, runningConfig, startupConfig } from './config.ts'

const SUFFIX: Record<string, string> = {
  config: '(config)',
  'config-if': '(config-if)',
  'config-if-range': '(config-if-range)',
  'config-subif': '(config-subif)',
  'config-vlan': '(config-vlan)',
  'config-router-bgp': '(config-router)',
  'config-router-ospf': '(config-router)',
  'config-router-af': '(config-router-af)',
  'config-line': '(config-line)',
  'config-ext-nacl': '(config-ext-nacl)',
  'config-std-nacl': '(config-std-nacl)',
  'config-route-map': '(config-route-map)',
  'config-vrf': '(config-vrf)',
  'config-vrf-af': '(config-vrf-af)',
  'config-archive': '(config-archive)'
}

const HELP: Record<string, string> = {
  show: 'Show running system information',
  ip: 'IP information',
  bgp: 'BGP information',
  interface: 'IP interface status and configuration',
  interfaces: 'Interface status and configuration',
  ospf: 'OSPF information',
  'mac': 'MAC configuration',
  'mac address-table': 'MAC forwarding table',
  cdp: 'CDP information',
  lldp: 'LLDP information',
  processes: 'Active process statistics',
  'processes cpu': 'Show CPU use per process',
  clear: 'Reset functions',
  'clear ip': 'IP',
  terminal: 'Set terminal line parameters',
  'show ip route': 'IP routing table',
  'show ip ospf': 'OSPF information',
  'show spanning-tree': 'Spanning tree topology',
  'show etherchannel': 'EtherChannel information',
  'show errdisable': 'Error disable',
  write: 'Write running configuration to memory, network, or terminal',
  archive: 'manage archive files',
  debug: 'Debugging functions (see also \'undebug\')',
  undebug: 'Disable debugging functions (see also \'debug\')'
}

type Store = { files: Record<string, ConfigSnapshot>; archive?: { path: string; maximum: number; n: number }; revert?: { backup: string; at: number } }

/** IOS ` --More-- `: Space page, Enter line, any other key quits; erased with BS/space/BS. */
export const IOS_PAGER: PagerSpec = {
  text: () => ' --More-- ',
  erase: (t) => '\b'.repeat(t.length) + ' '.repeat(t.length) + '\b'.repeat(t.length),
  keys: { ' ': 'page', '\r': 'line', '\n': 'line' },
  other: 'quit'
}

export class IosPersonality extends CiscoBase {
  pager = IOS_PAGER
  override abortKeys = ['\x1e']
  private trees: Record<string, Node[]> | undefined
  /** Multi-line `banner motd` collection. */
  private collecting: { delim: string; lines: string[] } | null = null

  constructor(s: Session) {
    super(s)
    const st = this.store()
    if (!st.archive) st.archive = { path: `flash:archive/${this.d.hostname}`, maximum: 14, n: 0 }
    // vty without `privilege level 15` lands in user EXEC.
    if (this.d.vendor['loginPrivilege'] === 1) this.privileged = false
  }

  private store(): Store {
    const v = this.d.vendor as { ios?: Store }
    return (v.ios ??= { files: {} })
  }

  override banner(): string {
    return this.d.motd !== undefined ? `\n${this.d.motd}\n\n` : ''
  }

  override prompt(): string {
    if (this.collecting) return ''
    return this.promptText()
  }

  protected suffix(m: CMode): string {
    return SUFFIX[m.id] ?? ''
  }

  // ------------------------------------------------------------------ errors and help

  protected errInvalid(_line: string, f: Failure): string {
    return `${this.caret(f.offset)}\n% Invalid input detected at '^' marker.\n\n`
  }
  protected errAmbiguous(line: string, _f: Failure): string {
    return `% Ambiguous command:  "${line.trim()}"`
  }
  protected errIncomplete(_line: string, _f: Failure): string {
    return '% Incomplete command.\n\n'
  }
  protected helpPartial(words: string[]): string {
    return words.length ? `${words.join('  ')}\n\n` : '% Unrecognized command\n'
  }
  protected helpList(h: Extract<HelpResult, { ok: true }>): string {
    if (!h.entries.length && !h.cr) return '% Unrecognized command\n'
    return ciscoHelpList(h, { cr: '<cr>' }) + '\n\n'
  }
  protected override pipeHelp(): string {
    return [
      '  append    Append redirected output to URL (URLs supporting append operation',
      '            only)',
      '  begin     Begin with the line that matches',
      '  count     Count number of lines which match regexp',
      '  exclude   Exclude lines that match',
      '  format    Format the output using the specified spec file',
      '  include   Include lines that match',
      '  redirect  Redirect output to URL',
      '  section   Filter a section of output',
      '  tee       Copy output to URL',
      ''
    ].join('\n')
  }

  protected override async unknown(line: string, f: Failure): Promise<string> {
    const toks = tokenize(line.split('|')[0]!)
    // An unknown single word at the exec prompt is a host name to telnet to.
    if (!this.inConfig() && f.kind === 'invalid' && f.index === 0 && toks.length === 1) {
      if (this.d.services['domain-lookup']) {
        await this.s.print(`Translating "${toks[0]}"...domain server (255.255.255.255)`)
        await this.s.sleep(1500)
        return `% Unknown command or computer name, or unable to find computer address`
      }
      return `Translating "${toks[0]}"\n% Unknown command or computer name, or unable to find computer address`
    }
    if (this.collecting) return ''
    return this.error(line, f)
  }

  protected pipes(out: string, pipes: string[], raw: string): PipeOutcome | { error: string } {
    let lines = out.replace(/\n$/, '').split('\n')
    const offs = tokenOffsets(raw)
    for (const p of pipes) {
      const [word = '', ...rest] = p.split(/\s+/)
      const names = ['append', 'begin', 'count', 'exclude', 'format', 'include', 'redirect', 'section', 'tee']
      const hits = names.filter((n) => n.startsWith(word.toLowerCase()))
      const pos = raw.indexOf(p, raw.indexOf('|'))
      if (hits.length !== 1 || !word) {
        const at = offs.find((o) => o >= pos) ?? pos
        return { error: hits.length > 1 ? `% Ambiguous command:  "${raw.trim()}"` : `${this.caret(at)}\n% Invalid input detected at '^' marker.\n` }
      }
      const pattern = rest.join(' ')
      if (!pattern && ['begin', 'count', 'exclude', 'include', 'section', 'redirect', 'tee', 'append', 'format'].includes(hits[0]!)) return { error: '% Incomplete command.\n' }
      const re = safeRegex(pattern)
      if (!re) return { error: `${this.caret(pos + word.length + 1)}\n% Invalid input detected at '^' marker.\n` }
      switch (hits[0]) {
        case 'include':
          lines = lines.filter((l) => re.test(l))
          break
        case 'exclude':
          lines = lines.filter((l) => !re.test(l))
          break
        case 'begin': {
          const i = lines.findIndex((l) => re.test(l))
          lines = i < 0 ? [] : lines.slice(i)
          break
        }
        case 'section':
          lines = section(lines, re)
          break
        case 'count':
          lines = [`Number of lines which match regexp = ${lines.filter((l) => re.test(l)).length}`]
          break
        case 'format':
          return { error: `%Error opening ${pattern} (No such file or directory)` }
        default:
          return { error: `%Error opening ${pattern} (Permission denied)` }
      }
    }
    return { out: lines.join('\n') }
  }

  override tab(line: string): TabResult {
    // Interface type completion: "int gi" + Tab → "int GigabitEthernet".
    const m = /(^|\s)([a-z][a-z-]*)$/i.exec(line)
    const r = super.tab(line)
    if (r.line || !m) return r
    const base = line.slice(0, line.length - m[2]!.length).trim()
    if (!/(^|\s)(int|inte|inter|interf|interfa|interfac|interface|interfaces)$/i.test(base)) return r
    const types = IOS_TYPES.filter((t) => t.full.toLowerCase().startsWith(m[2]!.toLowerCase()))
    if (types.length === 1) return { line: line.slice(0, line.length - m[2]!.length) + types[0]!.full }
    return r
  }

  // ------------------------------------------------------------------ execute

  override async execute(raw: string): Promise<void> {
    if (this.collecting) {
      const c = this.collecting
      const end = raw.indexOf(c.delim)
      if (end < 0) {
        c.lines.push(raw)
        return
      }
      c.lines.push(raw.slice(0, end))
      this.d.motd = c.lines.join('\n')
      this.collecting = null
      this.touch()
      return
    }
    await super.execute(raw)
  }

  /** Record a config change (for "Last configuration change" and BGP/link recomputation). */
  touch(): void {
    ;(this.d.vendor as { iosMeta?: { lastChange: number; by: string } }).iosMeta = { lastChange: now(this.d), by: this.s.user }
    tickBgp(this.d)
  }

  private configured(): void {
    logEvent(this.d, `%SYS-5-CONFIG_I: Configured from console by ${this.s.user} on vty0 (${this.s.from})`)
  }

  override endConfig(): void {
    if (this.inConfig()) this.configured()
    super.endConfig()
  }

  override exitMode(): boolean {
    const left = super.exitMode()
    if (left) this.configured()
    return left
  }

  // ------------------------------------------------------------------ trees

  protected tree(modeId: string): Node[] {
    this.trees ??= this.build()
    return this.trees[modeId] ?? this.trees['config']!
  }

  private iface(name = 'if', exists = true): Param {
    const d = this.d
    return {
      kind: 'iface',
      label: exists ? 'WORD' : 'WORD',
      values: () => d.interfaces.map((i) => i.short),
      test: (tok) => (exists ? !!findIface(d, tok, IOS_TYPES) : (() => { const r = parseIfName(tok, IOS_TYPES); return !!r && r !== 'ambiguous' })())
    }
    void name
  }

  private ifOf(c: Ctx, key = 'if'): Iface | undefined {
    return findIface(this.d, c.args[key] ?? '', IOS_TYPES)
  }

  private build(): Record<string, Node[]> {
    const d = this.d
    const user: Node[] = []
    const exec: Node[] = []
    const ip = (help = 'A.B.C.D'): Param => ({ kind: 'ipv4', label: help })
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const vrfP: Param = { kind: 'word', label: 'WORD', values: () => d.vrfs.map((v) => v.name), test: (t) => d.vrfs.some((v) => v.name === t) }
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(exec, `show ${path}`, help, run, extra, HELP)

    // ---- show
    add(exec, 'show', 'Show running system information', undefined, { priority: true })
    S('version', 'System hardware and software status', () => R.showVersion(d))
    S('running-config', 'Current operating configuration', () => runningConfig(d), {
      children: [kw('interface', 'Show interface configuration', { children: [prm(this.iface(), 'Interface name', { name: 'if', run: (c) => runningConfig(d, this.ifOf(c)) })] }), kw('all', 'Configuration with defaults', { run: () => runningConfig(d) })]
    })
    S('startup-config', 'Contents of startup configuration', () => startupConfig(d))
    S('ip interface brief', 'Brief summary of IP status and configuration', () => R.showIpIntBrief(d))
    add(exec, 'show ip interface', 'IP interface status and configuration', () => d.interfaces.map((i) => ipIntDetail(i)).join('\n'), { children: [] }, HELP).children!.push(prm(this.iface(), 'Interface name', { name: 'if', run: (c) => ipIntDetail(this.ifOf(c)!) }))
    S('ip bgp', 'BGP information', () => R.showIpBgp(d))
    S('ip bgp summary', 'Summary of BGP neighbor status', () => R.showBgpSummary(d))
    const nbrSub = (n: string): Node => kw(n, n === 'advertised-routes' ? 'Display the routes advertised to a BGP neighbor' : n === 'routes' ? 'Display routes learned from neighbor' : 'Display the received routes from neighbor', { name: 'sub', run: (c) => R.showBgpNeighbors(d, c.args['nb'], n === 'received-routes' ? 'routes' : n) })
    S('ip bgp neighbors', 'Detailed information on TCP and BGP neighbor connections', () => R.showBgpNeighbors(d), {
      children: [prm({ ...ip(), values: () => d.bgp.map((n) => n.ip) }, 'Neighbor to display information about', { name: 'nb', run: (c) => R.showBgpNeighbors(d, c.args['nb']), children: [nbrSub('advertised-routes'), nbrSub('received-routes'), nbrSub('routes')] })]
    })
    S('bgp summary', 'Summary of BGP neighbor status', () => R.showBgpSummary(d))
    S('bgp ipv4 unicast summary', 'Summary of BGP neighbor status', () => R.showBgpSummary(d))
    S('bgp all summary', 'Summary of BGP neighbor status', () => `For address family: IPv4 Unicast\n${R.showBgpSummary(d)}`)
    const routeTail = (vrfKey?: string): Node[] => [
      prm(ip('Hostname or A.B.C.D'), 'Network to display information about or hostname', { name: 'target', run: (c) => R.showIpRoute(d, vrfKey ? c.args[vrfKey] : undefined, c.args['target']) }),
      kw('static', 'Static routes', { run: (c) => R.showIpRoute(d, vrfKey ? c.args[vrfKey] : undefined).split('\n').filter((l) => !/^[CLBO] /.test(l)).join('\n') }),
      kw('connected', 'Connected', { run: (c) => R.showIpRoute(d, vrfKey ? c.args[vrfKey] : undefined).split('\n').filter((l) => !/^\s*[SBO]\*? /.test(l)).join('\n') }),
      kw('bgp', 'Border Gateway Protocol (BGP)', { run: (c) => R.showIpRoute(d, vrfKey ? c.args[vrfKey] : undefined).split('\n').filter((l) => !/^\s*[SCLO]\*? /.test(l)).join('\n') }),
      kw('summary', 'Summary of all routes', { run: (c) => routeSummary(d, vrfKey ? c.args[vrfKey] : undefined) })
    ]
    S('ip route', 'IP routing table', (c) => R.showIpRoute(d, c.args['vrf']), {
      children: [kw('vrf', 'Display routes from a VPN Routing/Forwarding instance', { children: [prm(vrfP, 'VPN Routing/Forwarding instance name', { name: 'vrf', run: (c) => R.showIpRoute(d, c.args['vrf']), children: routeTail('vrf') })] }), ...routeTail()]
    })
    S('ip arp', 'IP ARP table', () => R.showArp(d), { children: [kw('vrf', 'Specify VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showArp(d, c.args['vrf']) })] })] })
    S('arp', 'ARP table', () => R.showArp(d))
    S('ip ospf neighbor', 'Neighbor list', () => R.showOspfNeighbor(d))
    S('ip ospf interface brief', 'Brief summary of OSPF interface information', () => R.showOspfIntBrief(d))
    S('ip ospf', 'OSPF information', () => ` Routing Process "ospf ${d.ospf?.process ?? 1}" with ID ${d.ospf?.routerId ?? d.routerId}\n Start time: 00:00:41.112, Time elapsed: ${R.ciscoDate(d.bootedAt)}\n Supports only single TOS(TOS0) routes\n Supports opaque LSA\n Router is not originating router-LSAs with maximum metric\n Number of areas in this router is 1. 1 normal 0 stub 0 nssa`)
    const aclP: Param = { kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }
    S('ip access-lists', 'List IP access lists', (c) => R.showAccessLists(d, c.args['acl']), { children: [prm(aclP, 'Access list name', { name: 'acl', run: (c) => R.showAccessLists(d, c.args['acl']) })] })
    S('access-lists', 'List access lists', (c) => R.showAccessLists(d, c.args['acl']), { children: [prm(aclP, 'ACL name', { name: 'acl', run: (c) => R.showAccessLists(d, c.args['acl']) })] })
    const plP: Param = { kind: 'word', label: 'WORD', values: () => d.prefixLists.map((p) => p.name) }
    S('ip prefix-list', 'List IP prefix lists', () => R.showPrefixList(d), { children: [prm(plP, 'Name of a prefix list', { name: 'pl', run: (c) => R.showPrefixList(d, c.args['pl']) })] })
    S('ip protocols', 'IP routing protocol process parameters and statistics', () => ipProtocols(d))
    S('ip vrf', 'VPN Routing/Forwarding instance information', () => R.showVrf(d))
    const ifShow: Node = prm(this.iface(), 'Interface name', { name: 'if', run: (c) => R.showInterface(d, this.ifOf(c)!) })
    S('interfaces', 'Interface status and configuration', () => d.interfaces.map((i) => R.showInterface(d, i)).join('\n'), { children: [ifShow] })
    S('interfaces status', 'Show interface line status', () => R.showIntStatus(d))
    S('interfaces status err-disabled', 'Show interfaces in error-disabled state', () => R.showIntStatus(d, 'err-disabled'))
    S('interfaces description', 'Show interface description', () => R.showIntDescription(d))
    S('interfaces trunk', 'Show interface trunk information', () => R.showIntTrunk(d))
    S('interfaces counters', 'Show interface counters', () => R.showIntCountersErrors(d))
    S('interfaces counters errors', 'Show interface error counters', () => R.showIntCountersErrors(d))
    S('vlan', 'VTP VLAN status', () => R.showVlan(d, false))
    S('vlan brief', 'VTP all VLAN status in brief', () => R.showVlan(d, true))
    S('vlan id', 'VTP VLAN status by VLAN id', undefined, { children: [prm(int(1, 4094), 'ID number of the VLAN shown', { name: 'id', run: (c) => vlanById(d, Number(c.args['id'])) })] })
    S('vrf', 'VPN Routing/Forwarding instance information', () => R.showVrf(d))
    S('vrf brief', 'Brief VPN Routing/Forwarding instance information', () => R.showVrf(d))
    S('mac address-table', 'MAC forwarding table', () => R.showMacTable(d), {
      children: [
        kw('address', 'address keyword', { children: [prm({ kind: 'mac', label: 'H.H.H' }, '48 bit mac address', { name: 'mac', run: (c) => R.showMacTable(d, { kind: 'address', value: c.args['mac'] }) })] }),
        kw('interface', 'interface keyword', { children: [prm(this.iface(), 'Interface name', { name: 'if', run: (c) => R.showMacTable(d, { kind: 'interface', value: this.ifOf(c)!.short }) })] }),
        kw('vlan', 'VLAN keyword', { children: [prm(int(1, 4094), 'Vlan interface number', { name: 'vlan', run: (c) => R.showMacTable(d, { kind: 'vlan', value: c.args['vlan'] }) })] }),
        kw('dynamic', 'dynamic entry type', { run: () => R.showMacTable(d, { kind: 'dynamic' }) })
      ]
    })
    S('cdp neighbors', 'CDP neighbor entries', () => R.showCdp(d, false))
    S('cdp neighbors detail', 'Show detailed information', () => R.showCdp(d, true))
    S('lldp neighbors', 'LLDP neighbor entries', () => R.showLldp(d, false))
    S('lldp neighbors detail', 'Show detailed information', () => R.showLldp(d, true))
    S('logging', 'Show the contents of logging buffers', () => R.showLogging(d))
    S('clock', 'Display the system clock', () => R.showClock(d))
    S('users', 'Display information about terminal lines', () => `    Line       User       Host(s)              Idle       Location\n*  2 vty 0     ${this.s.user.padEnd(10)} idle                 00:00:00 ${this.s.from}\n\n  Interface    User               Mode         Idle     Peer Address`)
    S('tech-support', 'Show system information for Tech-Support', () => {
      // Heavy output for throughput / flow-control tests: about 4 MB, like a real show tech.
      const block = [R.showVersion(d), runningConfig(d), ...d.interfaces.map((i) => R.showInterface(d, i)), R.showLogging(d)].join('\n')
      const parts: string[] = []
      for (let n = 0, i = 1; n < 4_000_000; i++) {
        const sec = `\n------------------ show tech section ${i} ------------------\n\n${block}`
        parts.push(sec)
        n += sec.length
      }
      return parts.join('')
    })
    S('processes', 'Active process statistics', () => R.showProcessesCpu(d, false))
    S('processes cpu', 'Show CPU use per process', () => R.showProcessesCpu(d, false))
    S('processes cpu sorted', 'Sort output based on percentage of utilization', () => R.showProcessesCpu(d, true))
    S('processes cpu history', 'Show CPU usage history of the system', () => cpuHistory(d))
    S('spanning-tree', 'Spanning tree topology', () => R.showSpanningTree(d), { children: [kw('vlan', 'VLAN Switch Spanning Trees', { children: [prm(int(1, 4094), 'Spanning tree VLAN Id', { name: 'vlan', run: (c) => R.showSpanningTree(d, Number(c.args['vlan'])) })] })] })
    S('etherchannel summary', 'One-line summary per channel-group', () => R.showEtherchannel(d))
    const rmP: Param = { kind: 'word', label: 'WORD', values: () => d.routeMaps.map((r) => r.name) }
    S('route-map', 'route-map information', () => R.showRouteMap(d), { children: [prm(rmP, 'route-map name', { name: 'rm', run: (c) => R.showRouteMap(d, c.args['rm']) })] })
    S('archive', 'Archive functions', () => this.showArchive())
    S('errdisable recovery', 'Error disable recovery', () => R.showErrdisableRecovery(d))
    S('inventory', 'Show the physical inventory', () => R.showInventory(d))
    S('history', 'Display the session command history', () => '')
    S('terminal', 'Display terminal configuration parameters', () => `Line 2, Location: "", Type: "XTERM"\nLength: ${this.s.pageLength} lines, Width: 80 columns\nBaud rate (TX/RX) is 9600/9600`)
    S('flash:', 'display information about flash: file system', () => this.dir())

    // ---- exec actions
    add(exec, 'configure', 'Enter configuration mode', async () => {
      const a = (await this.s.ask('Configuring from terminal, memory, or network [terminal]? ', { mode: 'line' })).trim()
      if (a && !'terminal'.startsWith(a.toLowerCase())) return '?Must be "terminal", "memory" or "network"'
      return this.enterConfig()
    }, { priority: true })
    add(exec, 'configure terminal', 'Configure from the terminal', () => this.enterConfig(), {
      children: [kw('revert', 'Parameters for reverting the configuration', { children: [kw('timer', 'Set the revert timer', { children: [prm(int(1, 120), 'Number of minutes', { name: 'min', run: (c) => this.revertTimer(Number(c.args['min'])) })] })] })]
    })
    add(exec, 'configure confirm', 'Confirm replacement of running-config with a new config file', () => this.confirmRevert())
    add(exec, 'configure memory', 'Configure from NV memory', () => {
      if (d.startup) restore(d, d.startup)
      return '[OK]'
    })
    add(exec, 'configure network', 'Configure from a TFTP network host', () => '%Error opening tftp://255.255.255.255/network-confg (Timed out)')
    add(exec, 'configure overwrite-network', 'Overwrite NV memory from TFTP network host', () => '%Error opening tftp://255.255.255.255/network-confg (Timed out)')
    const fileP: Param = { kind: 'word', label: 'WORD', values: () => Object.keys(this.store().files) }
    const replOpts = (): Node[] => {
      const leaf = (w: string, help: string): Node => ({ word: w, help, name: w, run: (c) => this.configureReplace(c), children: [] })
      const opts = [leaf('list', 'List the command lines applied'), leaf('force', 'Do not prompt for confirmation'), kw('time', 'Time to wait for confirmation', { children: [prm(int(1, 120), 'Number of minutes', { name: 'time', run: (c) => this.configureReplace(c) })] })]
      for (const o of opts) if (o.children && o.word !== 'time') o.children.push(...opts.filter((x) => x !== o))
      return opts
    }
    add(exec, 'configure replace', 'Replace the running-config with a new config file', undefined, { children: [prm(fileP, 'URL of file to replace running-config with', { name: 'file', run: (c) => this.configureReplace(c), children: replOpts() })] })
    add(exec, 'configure revert', 'Parameters for reverting the configuration', undefined, {
      children: [kw('now', 'Revert now', { run: () => this.revertNow() }), kw('timer', 'Reset the revert timer', { children: [prm(int(1, 120), 'Number of minutes', { name: 'min', run: (c) => this.resetRevert(Number(c.args['min'])) })] })]
    })
    exec.find((n) => n.word === 'configure')!.children!.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    const copyRun = async (): Promise<string> => {
      const a = await this.s.ask('Destination filename [startup-config]? ', { mode: 'line' })
      if (a.trim() && a.trim() !== 'startup-config') return this.copyToFile(a.trim())
      return this.save()
    }
    const copySrc = prm({ kind: 'word', label: 'WORD', values: () => ['running-config', 'startup-config', ...Object.keys(this.store().files)] }, 'Source URL', {
      name: 'src',
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => ['running-config', 'startup-config', 'flash:'] }, 'Destination URL', {
          name: 'dst',
          run: async (c) => {
            const src = expand(c.args['src']!)
            const dst = expand(c.args['dst']!)
            if (src === 'running-config' && dst === 'startup-config') return copyRun()
            if (src === 'startup-config' && dst === 'running-config') {
              if (d.startup) restore(d, d.startup)
              this.touch()
              return `Destination filename [running-config]? \n${configLines(d).length * 31} bytes copied in 0.214 secs`
            }
            if (src === 'running-config' && /^(flash|bootflash|nvram):/.test(dst)) return this.copyToFile(dst)
            if (/^(tftp|ftp|scp|http|https):/.test(dst) || /^(tftp|ftp|scp|http|https):/.test(src)) return `%Error opening ${/^(tftp|ftp|scp|http|https):/.test(dst) ? dst : src} (Timed out)`
            return `%Error opening ${src} (No such file or directory)`
          }
        })
      ]
    })
    add(exec, 'copy', 'Copy from one file to another', undefined, { children: [copySrc] })
    add(exec, 'write', 'Write running configuration to memory, network, or terminal', () => this.save(), { priority: true })
    add(exec, 'write memory', 'Write to NV memory', () => this.save())
    add(exec, 'write terminal', 'Write to terminal', () => runningConfig(d))
    add(exec, 'write erase', 'Erase NV memory', () => this.eraseStartup())
    add(exec, 'erase', 'Erase a filesystem', undefined, { children: [kw('startup-config', 'Erase contents of configuration memory', { run: () => this.eraseStartup() }), kw('nvram:', 'nvram: Filesystem to be erased', { run: () => this.eraseStartup() }), kw('flash:', 'flash: Filesystem to be erased', { run: async () => ((await this.s.ask('Erasing device will remove all files! Continue? [confirm]')) === '' ? '%Error erasing flash: (simulated device, nothing erased)' : '') })] })
    add(exec, 'reload', 'Halt and perform a cold restart', () => this.reload(), {
      children: [
        kw('in', 'Reload after a time interval', { children: [prm({ kind: 'word', label: 'Delay', test: (t) => /^\d+(:\d+)?$/.test(t) }, 'Delay before reload (mmm or hhh:mm)', { name: 'in', run: (c) => this.reloadIn(c.args['in']!) })] }),
        kw('at', 'Reload at a specific time/date', { children: [prm({ kind: 'time', label: 'hh:mm' }, 'Time to reload (hh:mm)', { name: 'at', run: (c) => this.reloadIn(c.args['at']!, true) })] }),
        kw('cancel', 'Cancel pending reload', { run: () => this.reloadCancel() }),
        prm(line, 'Reason for reload', { name: 'reason', run: () => this.reload() })
      ]
    })
    const clearIf = prm(this.iface(), 'Interface name', { name: 'if', run: async (c) => this.clearCounters(this.ifOf(c)) })
    add(exec, 'clear counters', 'Clear counters on one or all interfaces', () => this.clearCounters(), { children: [clearIf] }, HELP)
    const bgpClear = (target: string, soft?: string): string => {
      const list = target === '*' ? d.bgp : d.bgp.filter((n) => n.ip === target)
      if (!list.length) return '% No such neighbor or address family'
      if (soft) return ''
      for (const n of list) {
        if (n.upSince !== undefined) logEvent(d, `%BGP-5-ADJCHANGE: neighbor ${n.ip} Down User reset`)
        n.upSince = undefined
        n.downSince = now(d)
      }
      tickBgp(d)
      return ''
    }
    const softKids = (): Node[] => [kw('soft', 'Soft reconfig', { name: 'soft', run: (c) => bgpClear(c.args['tgt']!, 'soft'), children: [kw('in', 'Soft reconfig inbound update', { run: (c) => bgpClear(c.args['tgt']!, 'in') }), kw('out', 'Soft reconfig outbound update', { run: (c) => bgpClear(c.args['tgt']!, 'out') })] })]
    add(exec, 'clear ip bgp', 'Clear BGP connections', undefined, {
      children: [prm({ kind: 'word', label: '*', test: (t) => t === '*' }, 'Clear all peers', { name: 'tgt', run: (c) => bgpClear(c.args['tgt']!), children: softKids() }), prm({ ...ip(), values: () => d.bgp.map((n) => n.ip) }, 'BGP neighbor address to clear', { name: 'tgt', run: (c) => bgpClear(c.args['tgt']!), children: softKids() })]
    }, HELP)
    add(exec, 'clear ip ospf process', 'Reset OSPF process', async () => ((await this.s.ask('Reset ALL OSPF processes? [no]: ', { mode: 'line' })).toLowerCase().startsWith('y') ? '' : ''), {}, HELP)
    add(exec, 'clear logging', 'Clear logging buffer', async () => {
      if ((await this.s.ask('Clear logging buffer [confirm]')) === '') d.log = []
      return ''
    })
    add(exec, 'clear arp-cache', 'Clear the entire ARP cache', () => '')
    add(exec, 'clear mac address-table dynamic', 'dynamic entry type', () => '')
    add(exec, 'archive config', 'Archive the running configuration', () => {
      this.archiveConfig()
      return ''
    }, {}, HELP)
    add(exec, 'clock set', 'Set the time and date', undefined, {
      children: [prm({ kind: 'time', label: 'hh:mm:ss' }, 'Current Time', { children: [prm(int(1, 31), 'Day of the month', { children: [prm({ kind: 'word', label: 'MONTH' }, 'Month of the year', { children: [prm(int(1993, 2035), 'Year', { run: () => '' })] })] })] })]
    }, { clock: 'Manage the system clock' })
    const pingTail = (vrfKey: boolean): Node[] => {
      const run = (c: Ctx): Promise<string> => this.ping(c.args['target'] ?? '', Number(c.args['repeat'] ?? 5), vrfKey ? c.args['vrf'] : undefined, c.args['src'])
      const opts: Node[] = [kw('repeat', 'specify repeat count', { children: [prm(int(1, 2147483647), 'Repeat count', { name: 'repeat', run })] }), kw('source', 'specify source address or name', { children: [prm({ kind: 'word', label: 'A.B.C.D' }, 'Source address or interface', { name: 'src', run })] }), kw('size', 'specify datagram size', { children: [prm(int(36, 18024), 'Datagram size', { run })] })]
      for (const o of opts) for (const leaf of o.children!) leaf.children = opts
      return [prm({ kind: 'word', label: 'WORD' }, 'Ping destination address or hostname', { name: 'target', run, children: opts })]
    }
    add(exec, 'ping', 'Send echo messages', undefined, { children: [...pingTail(false), kw('ip', 'IP echo', { children: pingTail(false) }), kw('vrf', 'VRF name', { children: [prm(vrfP, 'VRF name', { name: 'vrf', children: pingTail(true) })] })] })
    const traceTail = (vrf: boolean): Node[] => [prm({ kind: 'word', label: 'WORD' }, 'Trace route to destination address or hostname', { name: 'target', run: (c) => this.trace(c.args['target']!, vrf ? c.args['vrf'] : undefined) })]
    add(exec, 'traceroute', 'Trace route to destination', undefined, { children: [...traceTail(false), kw('ip', 'IP Trace', { children: traceTail(false) }), kw('vrf', 'VRF name', { children: [prm(vrfP, 'VRF name', { name: 'vrf', children: traceTail(true) })] })] })
    add(exec, 'terminal length', 'Set number of lines on a screen', undefined, {
      children: [prm(int(0, 512), 'Number of lines on screen (0 for no pausing)', { name: 'n', run: (c) => ((this.s.pageLength = Number(c.args['n'])), '') })]
    }, HELP)
    add(exec, 'terminal width', 'Set width of the display terminal', undefined, { children: [prm(int(0, 512), 'Number of characters on a screen line', { run: () => '' })] }, HELP)
    add(exec, 'terminal monitor', 'Copy debug output to the current terminal line', () => '', {}, HELP)
    add(exec, 'terminal no monitor', 'Disable monitor', () => '', {}, HELP)
    add(exec, 'terminal history size', 'Set history buffer size', undefined, { children: [prm(int(0, 256), 'Size of history buffer', { run: () => '' })] }, HELP)
    add(exec, 'debug', 'Debugging functions (see also \'undebug\')', undefined, { children: [prm(line, 'Debug target', { name: 'what', run: (c) => `${c.args['what']!.replace(/\b\w/g, (x) => x.toUpperCase())} debugging is on` })] })
    add(exec, 'undebug all', 'Enable all debugging', () => 'All possible debugging has been turned off', { priority: true }, HELP)
    exec.find((n) => n.word === 'undebug')!.priority = true
    add(exec, 'no debug all', 'Enable all debugging', () => 'All possible debugging has been turned off', {}, { no: 'Disable debugging functions' })
    add(exec, 'enable', 'Turn on privileged commands', () => '', { priority: true })
    add(exec, 'disable', 'Turn off privileged commands', () => ((this.privileged = false), ''))
    for (const w of ['exit', 'logout', 'quit']) add(exec, w, 'Exit from the EXEC', () => (this.s.close(), ''), w === 'exit' ? { priority: true } : {})
    add(exec, 'connect', 'Open a terminal connection', undefined, { children: [prm(word(), 'IP address or hostname of a remote system', { name: 'h', run: (c) => this.connect(c.args['h']!) })] })
    add(exec, 'telnet', 'Open a telnet connection', undefined, { children: [prm(word(), 'IP address or hostname of a remote system', { name: 'h', run: (c) => this.connect(c.args['h']!) })] })
    add(exec, 'ssh', 'Open a secure shell client connection', undefined, { children: [prm(line, '-l login name, or host', { name: 'h', run: (c) => this.connect(c.args['h']!.split(/\s+/).at(-1)!) })] })
    add(exec, 'delete', 'Delete a file', undefined, { children: [prm(word('WORD'), 'File to be deleted', { name: 'f', run: async (c) => this.deleteFile(c.args['f']!) })] })
    add(exec, 'undelete', 'Undelete a file', undefined, { children: [prm(int(1, 1024), 'File index', { run: () => '' })] })
    add(exec, 'dir', 'List files on a filesystem', () => this.dir(), { children: [prm(word('WORD'), 'Directory or file name', { run: () => this.dir() })] })
    add(exec, 'more', 'Display the contents of a file', undefined, { children: [prm(word('WORD'), 'File to display', { name: 'f', run: (c) => this.more(c.args['f']!) })] })
    add(exec, 'format', 'Format a filesystem', undefined, { children: [prm(word(), 'Filesystem', { run: () => '%Error format not permitted on the simulated device' })] })
    add(exec, 'verify', 'Verify a file', undefined, { children: [prm(word(), 'File to verify', { run: (c) => `Verifying file integrity of ${c.params[0]}......Done!` })] })
    add(exec, 'send', 'Send a message to other tty lines', undefined, { children: [prm(word(), 'Line', { run: () => '' })] })
    add(exec, 'setup', 'Run the SETUP command facility', () => '% Setup is not available on a simulated device.')
    add(exec, 'systat', 'Display information about terminal lines', () => `    Line       User       Host(s)              Idle       Location\n*  2 vty 0     ${this.s.user.padEnd(10)} idle                 00:00:00 ${this.s.from}`)
    add(exec, 'where', 'List active connections', () => '% No connections open')
    add(exec, 'tclsh', 'Tool Command Language shell', () => '%% [simulator] tclsh is disabled on the simulator.')
    add(exec, 'guestshell', 'guestshell managment', () => '%% [simulator] guestshell is disabled on the simulator.', { children: [prm(line, 'Guestshell command', { run: () => '%% [simulator] guestshell is disabled on the simulator.' })] })
    add(exec, 'install', 'install commands', undefined, { children: [prm(line, 'install operation', { run: () => '%% [simulator] install ignored (simulated device).' })] })
    add(exec, 'request', 'Request commands', undefined, { children: [prm(line, 'request', { run: () => '%% [simulator] request ignored (simulated device).' })] })
    add(exec, 'factory-reset', 'Factory reset the device', undefined, { children: [prm(line, 'scope', { run: async () => ((await this.s.ask('The factory reset operation is irreversible for the selected option. Are you sure? [confirm]')) === '' ? '%% [simulator] factory-reset acknowledged. Nothing was erased (simulated device).' : '') })] })

    // ---- user EXEC (`>`): a small subset; everything else is an invalid-input caret.
    for (const n of exec) if (['ping', 'traceroute', 'exit', 'logout', 'quit', 'connect', 'telnet', 'ssh', 'terminal', 'systat', 'where', 'send', 'disable'].includes(n.word!)) user.push(n)
    user.push(
      kw('enable', 'Turn on privileged commands', {
        priority: true,
        run: async () => {
          const pw = await this.s.ask('Password: ', { mode: 'line', echo: false })
          if (pw === this.s.password) this.privileged = true
          else return '% Access denied'
          return ''
        }
      }),
      kw('show', 'Show running system information', {
        priority: true,
        children: exec.find((n) => n.word === 'show')!.children!.filter((c) => ['version', 'clock', 'users', 'interfaces', 'ip', 'cdp', 'lldp', 'vlan', 'history', 'terminal', 'inventory'].includes(c.word!))
      })
    )
    user.sort((a, b) => a.word!.localeCompare(b.word!))
    for (const t of [exec]) t.sort((a, b) => a.word!.localeCompare(b.word!))
    for (const n of exec.find((x) => x.word === 'show')!.children!) void n

    return { user, exec, ...this.configTrees() }
  }

  // ------------------------------------------------------------------ config trees

  private configTrees(): Record<string, Node[]> {
    const d = this.d
    const line: Param = { kind: 'line', label: 'LINE' }
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const ipP = (label = 'A.B.C.D'): Param => ({ kind: 'ipv4', label })
    const maskP: Param = { kind: 'mask', label: 'A.B.C.D' }
    const g: Node[] = []
    const C = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}, helps: Record<string, string> = {}): Node => add(g, path, help, run, extra, { no: 'Negate a command or set its defaults', ip: 'Global IP configuration subcommands', ...helps })
    const changed = <T>(v: T): T => {
      this.touch()
      return v
    }

    // ---- global
    C('hostname', "Set system's network name", undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(t) }, "This system's network name", {
          name: 'h',
          run: (c) => {
            d.hostname = c.args['h']!
            return changed('')
          }
        })
      ]
    })
    const ifEnter = (c: Ctx): string => {
      const typed = c.args['if']!
      let i = findIface(d, typed, IOS_TYPES)
      if (!i) {
        const ref = parseIfName(typed, IOS_TYPES)
        if (!ref || ref === 'ambiguous') return `${this.caret(c.line.indexOf(typed))}\n% Invalid input detected at '^' marker.\n`
        if (!/^(Loopback|Vlan|Port-channel|Tunnel)$/.test(ref.type.full) || (ref.type.full === 'Vlan' && !(Number(ref.num) >= 1 && Number(ref.num) <= 4094))) return `${this.caret(c.line.indexOf(typed))}\n% Invalid input detected at '^' marker.\n`
        i = { name: ref.name, short: ref.type.short + ref.num, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: ref.type.full === 'Vlan' ? `00a3.d14f.0a${Number(ref.num).toString(16).padStart(2, '0').slice(-2)}` : '', ipMethod: 'unset' }
        if (ref.type.full === 'Port-channel') Object.assign(i, { mode: 'trunk', speed: '1000', linkUp: false })
        d.interfaces.push(i)
        this.touch()
      }
      this.setMode('config-if', i)
      return ''
    }
    C('interface', 'Select an interface to configure', undefined, {
      children: [
        prm(this.iface('if', false), 'Interface name', { name: 'if', run: ifEnter }),
        kw('range', 'interface range command', { children: [prm(line, 'Interface range', { name: 'range', run: (c) => this.enterRange(c) })] })
      ]
    })
    C('no interface', 'Select an interface to configure', undefined, {
      children: [
        prm(this.iface(), 'Interface name', {
          name: 'if',
          run: (c) => {
            const i = this.ifOf(c)!
            if (!/^(Loopback|Vlan|Port-channel|Tunnel)/.test(i.name)) return '% Removal of physical interfaces is not permitted'
            d.interfaces = d.interfaces.filter((x) => x !== i)
            return changed('')
          }
        })
      ]
    })
    const vlanEnter = (c: Ctx): string => {
      const ids = expandVlans(c.args['vlan']!)
      for (const id of ids) if (!d.vlans.some((v) => v.id === id)) d.vlans.push({ id, name: `VLAN${String(id).padStart(4, '0')}` })
      d.vlans.sort((a, b) => a.id - b.id)
      this.setMode('config-vlan', ids)
      return changed('')
    }
    C('vlan', 'Vlan commands', undefined, { children: [prm({ kind: 'vlanlist', label: 'WORD', test: (t) => expandVlans(t).every((v) => v >= 1 && v <= 4094) }, 'ISL VLAN IDs 1-1005, IEEE 802.1Q VLAN IDs 1-4094', { name: 'vlan', run: vlanEnter })] })
    C('no vlan', 'Vlan commands', undefined, {
      children: [
        prm({ kind: 'vlanlist', label: 'WORD' }, 'VLAN IDs', {
          name: 'vlan',
          run: (c) => {
            const ids = expandVlans(c.args['vlan']!)
            if (ids.includes(1)) return '%Default VLAN 1 may not be deleted.'
            d.vlans = d.vlans.filter((v) => !ids.includes(v.id))
            return changed('')
          }
        })
      ]
    })
    C('router bgp', 'Border Gateway Protocol (BGP)', undefined, {
      children: [
        prm({ kind: 'asn', label: '<1-4294967295>' }, 'Autonomous system number', {
          name: 'as',
          run: (c) => {
            const as = Number(c.args['as'])
            if (d.localAs && as !== d.localAs) return `BGP is already running; AS is ${d.localAs}`
            d.localAs = as
            this.setMode('config-router-bgp')
            return ''
          }
        })
      ]
    }, { router: 'Enable a routing process' })
    C('no router bgp', 'Border Gateway Protocol (BGP)', undefined, {
      children: [
        prm({ kind: 'asn', label: '<1-4294967295>' }, 'Autonomous system number', {
          name: 'as',
          run: (c) => {
            if (Number(c.args['as']) !== d.localAs) return '% BGP is not running'
            d.bgp = []
            d.localAs = 0
            return changed('')
          }
        })
      ]
    })
    C('router ospf', 'Open Shortest Path First (OSPF)', undefined, {
      children: [
        prm(int(1, 65535), 'Process ID', {
          name: 'pid',
          run: (c) => {
            d.ospf ??= { process: c.args['pid']!, ifaces: [], neighbors: [] }
            this.setMode('config-router-ospf')
            return ''
          }
        })
      ]
    })
    C('ip route', 'Establish static routes', undefined, { children: this.staticRouteNodes(false) })
    C('no ip route', 'Establish static routes', undefined, { children: this.staticRouteNodes(true) })
    const aclEnter = (type: 'extended' | 'standard') => (c: Ctx): string => {
      let a = d.acls.find((x) => x.name === c.args['name'])
      if (!a) {
        a = { name: c.args['name']!, type, entries: [] }
        d.acls.push(a)
      }
      this.setMode(type === 'extended' ? 'config-ext-nacl' : 'config-std-nacl', a)
      return changed('')
    }
    C('ip access-list extended', 'Extended Access List', undefined, { children: [prm(word(), 'Access-list name', { name: 'name', run: aclEnter('extended') })] }, { 'ip access-list': 'Named access-list' })
    C('ip access-list standard', 'Standard Access List', undefined, { children: [prm(word(), 'Access-list name', { name: 'name', run: aclEnter('standard') })] }, { 'ip access-list': 'Named access-list' })
    C('no ip access-list', 'Named access-list', undefined, {
      children: ['extended', 'standard'].map((t) =>
        kw(t, `${t === 'extended' ? 'Extended' : 'Standard'} Access List`, { children: [prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access-list name', { name: 'name', run: (c) => ((d.acls = d.acls.filter((a) => a.name !== c.args['name'])), changed('')) })] })
      )
    })
    C('access-list', 'Add an access list entry', undefined, {
      children: [
        prm(int(1, 199), 'IP standard access list', {
          name: 'n',
          children: [
            prm({ kind: 'enum', label: 'permit', values: () => ['permit', 'deny', 'remark'] }, 'Specify packets to forward/reject', {
              name: 'act',
              children: [
                prm(line, 'Address to match', {
                  name: 'rest',
                  run: (c) => {
                    let a = d.acls.find((x) => x.name === c.args['n'])
                    if (!a) d.acls.push((a = { name: c.args['n']!, type: Number(c.args['n']) < 100 ? 'standard' : 'extended', entries: [] }))
                    a.entries.push({ seq: (a.entries.at(-1)?.seq ?? 0) + 10, action: c.args['act']!.toLowerCase() as 'permit', text: c.args['rest']! })
                    return changed('')
                  }
                })
              ]
            })
          ]
        })
      ]
    })
    const plRun = (c: Ctx): string => {
      const prefix = c.args['prefix']!
      const [pip, plen] = prefix.split('/')
      if (!pip || !isIpv4(pip) || plen === undefined || Number(plen) > 32) return `${this.caret(c.line.indexOf(prefix))}\n% Invalid input detected at '^' marker.\n`
      let p = d.prefixLists.find((x) => x.name === c.args['name'])
      if (!p) d.prefixLists.push((p = { name: c.args['name']!, entries: [] }))
      const seq = c.args['seq'] ? Number(c.args['seq']) : (p.entries.at(-1)?.seq ?? 0) + 5
      p.entries = p.entries.filter((e) => e.seq !== seq)
      p.entries.push({ seq, action: c.args['act'] as 'permit', prefix, ...(c.args['ge'] ? { ge: Number(c.args['ge']) } : {}), ...(c.args['le'] ? { le: Number(c.args['le']) } : {}) })
      p.entries.sort((a, b) => a.seq - b.seq)
      return changed('')
    }
    const plTail = (): Node[] => {
      const geLe = (): Node[] => [kw('ge', 'Minimum prefix length to be matched', { children: [prm(int(1, 32), 'Minimum prefix length', { name: 'ge', run: plRun, children: [kw('le', 'Maximum prefix length to be matched', { children: [prm(int(1, 32), 'Maximum prefix length', { name: 'le', run: plRun })] })] })] }), kw('le', 'Maximum prefix length to be matched', { children: [prm(int(1, 32), 'Maximum prefix length', { name: 'le', run: plRun })] })]
      return ['permit', 'deny'].map((a) => kw(a, a === 'permit' ? 'Specify packets to forward' : 'Specify packets to reject', { name: 'act', children: [prm({ kind: 'prefix', label: 'A.B.C.D/nn' }, 'IP prefix <network>/<length>, e.g., 35.0.0.0/8', { name: 'prefix', run: plRun, children: geLe() })] }))
    }
    const plName: Param = { kind: 'word', label: 'WORD', values: () => d.prefixLists.map((p) => p.name) }
    C('ip prefix-list', 'Build a prefix list', undefined, { children: [prm(plName, 'Name of a prefix list', { name: 'name', children: [kw('seq', 'sequence number of an entry', { children: [prm(int(1, 4294967294), 'Sequence number', { name: 'seq', children: plTail() })] }), ...plTail(), kw('description', 'Prefix-list specific description', { children: [prm(line, 'Up to 80 characters describing this prefix-list', { run: () => changed('') })] })] })] })
    C('no ip prefix-list', 'Build a prefix list', undefined, {
      children: [
        prm(plName, 'Name of a prefix list', {
          name: 'name',
          run: (c) => ((d.prefixLists = d.prefixLists.filter((p) => p.name !== c.args['name'])), changed('')),
          children: [kw('seq', 'sequence number of an entry', { children: [prm(int(1, 4294967294), 'Sequence number', { name: 'seq', run: (c) => { const p = d.prefixLists.find((x) => x.name === c.args['name']); if (p) p.entries = p.entries.filter((e) => e.seq !== Number(c.args['seq'])); return changed('') } })] })]
        })
      ]
    })
    const rmEnter = (c: Ctx): string => {
      let r = d.routeMaps.find((x) => x.name === c.args['name'])
      if (!r) d.routeMaps.push((r = { name: c.args['name']!, entries: [] }))
      const seq = c.args['seq'] ? Number(c.args['seq']) : r.entries.length ? r.entries[0]!.seq : 10
      let e = r.entries.find((x) => x.seq === seq)
      if (!e) {
        e = { seq, action: (c.args['act'] as 'permit' | undefined) ?? 'permit', match: [], set: [] }
        r.entries.push(e)
        r.entries.sort((a, b) => a.seq - b.seq)
      } else if (c.args['act']) e.action = c.args['act'] as 'permit'
      this.setMode('config-route-map', { rm: r, e })
      return changed('')
    }
    const rmName: Param = { kind: 'word', label: 'WORD', values: () => d.routeMaps.map((r) => r.name) }
    const rmSeq = (): Node[] => [prm(int(0, 65535), 'Sequence to insert to/delete from existing route-map entry', { name: 'seq', run: rmEnter })]
    C('route-map', 'Create route-map or enter route-map command mode', undefined, { children: [prm(rmName, 'Route map tag', { name: 'name', run: rmEnter, children: [kw('permit', 'Route map permits set operations', { name: 'act', run: rmEnter, children: rmSeq() }), kw('deny', 'Route map denies set operations', { name: 'act', run: rmEnter, children: rmSeq() }), ...rmSeq()] })] })
    C('no route-map', 'Create route-map or enter route-map command mode', undefined, {
      children: [
        prm(rmName, 'Route map tag', {
          name: 'name',
          run: (c) => ((d.routeMaps = d.routeMaps.filter((r) => r.name !== c.args['name'])), changed('')),
          children: ['permit', 'deny'].map((a) => kw(a, 'Route map action', { children: [prm(int(0, 65535), 'Sequence', { name: 'seq', run: (c) => { const r = d.routeMaps.find((x) => x.name === c.args['name']); if (r) r.entries = r.entries.filter((e) => e.seq !== Number(c.args['seq'])); return changed('') } })] }))
        })
      ]
    })
    for (const [path, svc, help] of [
      ['ip http server', 'http-server', 'Enable HTTP server'],
      ['ip http secure-server', 'http-server', 'Enable HTTP secure server'],
      ['ip domain lookup', 'domain-lookup', 'Enable IP Domain Name System hostname translation'],
      ['cdp run', 'cdp', 'Enable CDP'],
      ['lldp run', 'lldp', 'Enable LLDP']
    ] as const) {
      C(path, help, () => ((d.services[svc] = true), changed('')))
      C(`no ${path}`, help, () => ((d.services[svc] = false), changed('')))
    }
    C('ip domain name', 'Define the default domain name', undefined, { children: [prm(word(), 'Default domain name', { run: () => changed('') })] })
    C('snmp-server community', 'Enable SNMP; set community string and access privs', undefined, { children: [prm(word(), 'SNMP community string', { name: 'comm', run: () => changed(''), children: [prm({ kind: 'enum', label: 'RO', values: () => ['RO', 'RW'] }, 'Access', { run: () => changed(''), children: [prm(word(), 'Std IP accesslist', { run: () => changed('') })] })] })] }, { 'snmp-server': 'Modify SNMP engine parameters' })
    C('no snmp-server community', 'Enable SNMP; set community string and access privs', undefined, { children: [prm(word(), 'SNMP community string', { name: 'comm', run: (c) => { if (c.args['comm'] === 'pr1vRW') d.services['snmp-rw'] = false; if (c.args['comm'] === 'n3tw0rkRO') d.services['snmp-ro'] = false; return changed('') } })] })
    C('banner motd', 'Set Message of the Day banner', undefined, {
      children: [
        prm(line, 'c  banner-text c, where \'c\' is a delimiting character', {
          name: 'text',
          run: (c) => {
            const text = c.args['text']!
            const delim = text.startsWith('^C') ? '^C' : text[0]!
            const restText = text.slice(delim.length)
            const end = restText.indexOf(delim)
            if (end >= 0) {
              d.motd = restText.slice(0, end)
              return changed('')
            }
            this.collecting = { delim, lines: restText ? [restText] : [] }
            return `Enter TEXT message.  End with the character '${delim === '^C' ? '^C' : delim}'.`
          }
        })
      ]
    }, { banner: 'Define a login banner' })
    C('no banner motd', 'Set Message of the Day banner', () => ((d.motd = undefined), changed('')))
    C('username', 'Establish User Name Authentication', undefined, { children: [prm(word(), 'User name', { children: [prm(line, 'privilege/secret', { run: () => changed('') })] })] })
    C('enable secret', 'Assign the privileged level secret', undefined, { children: [prm(line, 'The UNENCRYPTED (cleartext) \'enable\' secret', { run: () => changed('') })] }, { enable: 'Modify enable password parameters' })
    C('logging host', 'Set syslog server IP address and parameters', undefined, { children: [prm(ipP(), 'IP address of the syslog server', { run: () => changed('') })] }, { logging: 'Modify message logging facilities' })
    C('logging buffered', 'Set buffered logging parameters', () => changed(''), { children: [prm(int(4096, 2147483647), 'Logging buffer size', { run: () => changed('') })] })
    C('ntp server', 'Configure NTP server', undefined, { children: [prm(word('A.B.C.D'), 'IP address of peer', { run: () => changed('') })] }, { ntp: 'Configure NTP' })
    C('spanning-tree mode', 'Spanning tree operating mode', undefined, { children: [prm({ kind: 'enum', label: 'rapid-pvst', values: () => ['mst', 'pvst', 'rapid-pvst'] }, 'Spanning tree mode', { run: () => changed('') })] }, { 'spanning-tree': 'Spanning Tree Subsystem' })
    C('errdisable recovery cause', 'Enable error disable recovery for application', undefined, {
      children: [
        prm({ kind: 'enum', label: 'WORD', values: () => ['all', 'arp-inspection', 'bpduguard', 'link-flap', 'psecure-violation', 'udld'] }, 'Cause', {
          name: 'cause',
          run: (c) => {
            const list = ((d.vendor['errdisableRecovery'] as string[] | undefined) ??= [])
            if (!list.includes(c.args['cause']!)) list.push(c.args['cause']!)
            return changed('')
          }
        })
      ]
    }, { errdisable: 'Error disable', 'errdisable recovery': 'Error disable recovery' })
    C('line vty', 'Virtual terminal', undefined, { children: [prm(int(0, 1869), 'First Line number', { children: [prm(int(1, 1869), 'Last Line number', { run: () => ((this.setMode('config-line')), '') })] })] }, { line: 'Configure a terminal line' })
    C('line con', 'Primary terminal line', undefined, { children: [prm(int(0, 0), 'First Line number', { run: () => (this.setMode('config-line'), '') })] })
    C('vrf definition', 'VRF definition', undefined, {
      children: [
        prm(word(), 'VRF name', {
          name: 'vrf',
          run: (c) => {
            let v = d.vrfs.find((x) => x.name === c.args['vrf'])
            if (!v) d.vrfs.push((v = { name: c.args['vrf']!, rd: '', interfaces: [] }))
            this.setMode('config-vrf', v)
            return changed('')
          }
        })
      ]
    }, { vrf: 'VRF commands' })
    C('archive', 'Archive the configuration', () => (this.setMode('config-archive'), ''))
    C('service', 'Modify use of network based services', undefined, { children: [prm(line, 'Service', { run: () => changed('') })] })
    C('do', 'To run exec commands in config mode', undefined, { children: [prm(line, 'Exec Command', { run: () => '' })] })
    C('end', 'Exit from configure mode', () => (this.endConfig(), ''))
    C('exit', 'Exit from configure mode', () => (this.exitMode(), ''))

    // ---- interface
    const ifm: Node[] = []
    const I = (path: string, help: string, run: (i: Iface, c: Ctx) => string, extra: Partial<Node> = {}, helps: Record<string, string> = {}): Node =>
      add(
        ifm,
        path,
        help,
        run ? (c: Ctx) => this.eachIf((i) => run(i, c)) : undefined,
        extra,
        { no: 'Negate a command or set its defaults', ip: 'Interface Internet Protocol config commands', switchport: 'Set switching mode characteristics', 'switchport trunk': 'Set trunking characteristics of the interface', 'spanning-tree': 'Spanning Tree Subsystem', ...helps }
      )
    const leaf = (param: Param, help: string, name: string, run: (i: Iface, c: Ctx) => string, children?: Node[]): Node => prm(param, help, { name, run: (c) => this.eachIf((i) => run(i, c)), ...(children ? { children } : {}) })
    I('description', 'Interface specific description', undefined as never, { children: [leaf(line, 'Up to 200 characters describing this interface', 'desc', (i, c) => ((i.description = c.args['desc']), changed('')))] })
    I('no description', 'Interface specific description', (i) => ((i.description = undefined), changed('')))
    I('shutdown', 'Shutdown the selected interface', (i) => this.shut(i, true))
    I('no shutdown', 'Shutdown the selected interface', (i) => this.shut(i, false))
    I('ip address', 'Set the IP address of an interface', undefined as never, {
      children: [
        prm(ipP('A.B.C.D'), 'IP address', {
          name: 'ip',
          children: [
            leaf(maskP, 'IP subnet mask', 'mask', (i, c) => this.setIp(i, c.args['ip']!, c.args['mask']!), [kw('secondary', 'Make this IP address a secondary address', { run: () => changed('') })])
          ]
        }),
        kw('dhcp', 'IP Address negotiated via DHCP', { run: (c) => this.eachIf((i) => ((i.ipMethod = 'DHCP'), void c, changed(''))) })
      ]
    })
    I('no ip address', 'Set the IP address of an interface', (i) => ((i.ip = undefined), (i.mask = undefined), (i.ipMethod = 'unset'), changed('')))
    I('switchport', 'Set switching mode characteristics', (i) => (i.mode === 'routed' ? ((i.mode = 'access'), (i.ip = undefined), (i.mask = undefined), changed('')) : ''))
    I('no switchport', 'Set switching mode characteristics', (i) => ((i.mode = 'routed'), changed('')))
    I('switchport mode', 'Set trunking mode of the interface', undefined as never, { children: [leaf({ kind: 'enum', label: 'access', values: () => ['access', 'trunk', 'dynamic'] }, 'Set trunking mode', 'm', (i, c) => ((i.mode = c.args['m']!.toLowerCase().startsWith('t') ? 'trunk' : 'access'), changed('')))] })
    I('switchport access vlan', 'Set VLAN when interface is in access mode', undefined as never, {
      children: [
        leaf(int(1, 4094), 'VLAN ID of the VLAN when this port is in access mode', 'vlan', (i, c) => {
          const id = Number(c.args['vlan'])
          if (!d.vlans.some((v) => v.id === id)) {
            d.vlans.push({ id, name: `VLAN${String(id).padStart(4, '0')}` })
            d.vlans.sort((a, b) => a.id - b.id)
            this.s.write(`% Access VLAN does not exist. Creating vlan ${id}\r\n`)
          }
          i.vlan = id
          if (i.mode === 'routed') i.mode = 'access'
          return changed('')
        })
      ]
    }, { 'switchport access': 'Set access mode characteristics of the interface' })
    const allowed = (op: 'set' | 'add' | 'remove' | 'except') => (i: Iface, c: Ctx): string => {
      const v = expandVlans(c.args['vl']!)
      const cur = i.trunkAllowed ?? Array.from({ length: 4094 }, (_, n) => n + 1)
      i.trunkAllowed = op === 'set' ? v : op === 'add' ? [...new Set([...cur, ...v])].sort((a, b) => a - b) : op === 'remove' ? cur.filter((x) => !v.includes(x)) : Array.from({ length: 4094 }, (_, n) => n + 1).filter((x) => !v.includes(x))
      if (i.trunkAllowed.length === 4094) i.trunkAllowed = undefined
      return changed('')
    }
    const vlP: Param = { kind: 'vlanlist', label: 'WORD' }
    I('switchport trunk allowed vlan', 'Set allowed VLAN characteristics when interface is in trunking mode', undefined as never, {
      children: [
        leaf(vlP, 'VLAN IDs of the allowed VLANs when this port is in trunking mode', 'vl', allowed('set')),
        kw('add', 'add VLANs to the current list', { children: [leaf(vlP, 'VLAN IDs of disallowed VLANS when this port is in trunking mode', 'vl', allowed('add'))] }),
        kw('remove', 'remove VLANs from the current list', { children: [leaf(vlP, 'VLAN IDs', 'vl', allowed('remove'))] }),
        kw('except', 'all VLANs except the following', { children: [leaf(vlP, 'VLAN IDs', 'vl', allowed('except'))] }),
        kw('all', 'all VLANs', { run: (c) => this.eachIf((i) => ((i.trunkAllowed = undefined), void c, changed(''))) }),
        kw('none', 'no VLANs', { run: (c) => this.eachIf((i) => ((i.trunkAllowed = []), void c, changed(''))) })
      ]
    }, { 'switchport trunk allowed': 'Set allowed VLAN characteristics when interface is in trunking mode' })
    I('no switchport trunk allowed vlan', 'Set allowed VLAN characteristics', (i) => ((i.trunkAllowed = undefined), changed('')))
    I('switchport trunk native vlan', 'Set native VLAN when interface is in trunking mode', undefined as never, { children: [leaf(int(1, 4094), 'VLAN ID of the native VLAN', 'vl', (i, c) => ((i.nativeVlan = Number(c.args['vl'])), changed('')))] }, { 'switchport trunk native': 'Set trunking native characteristics' })
    I('speed', 'Configure speed operation.', undefined as never, { children: [leaf({ kind: 'enum', label: '10', values: () => ['10', '100', '1000', 'auto'] }, 'Force speed', 's', (i, c) => ((i.speedSet = c.args['s']), changed('')))] })
    I('no speed', 'Configure speed operation.', (i) => ((i.speedSet = undefined), changed('')))
    I('duplex', 'Configure duplex operation.', undefined as never, { children: [leaf({ kind: 'enum', label: 'auto', values: () => ['auto', 'full', 'half'] }, 'Duplex', 'dx', (i, c) => this.setDuplex(i, c.args['dx']!.toLowerCase() as 'full'))] })
    I('no duplex', 'Configure duplex operation.', (i) => this.setDuplex(i, 'auto'))
    I('mtu', 'Set the interface Maximum Transmission Unit (MTU)', undefined as never, { children: [leaf(int(1500, 9198), 'MTU size in bytes', 'mtu', (i, c) => this.setMtu(i, Number(c.args['mtu'])))] })
    I('no mtu', 'Set the interface Maximum Transmission Unit (MTU)', (i) => this.setMtu(i, 1500))
    I('ip mtu', 'Set IP Maximum Transmission Unit', undefined as never, { children: [leaf(int(68, 9198), 'MTU (bytes)', 'mtu', (i, c) => this.setMtu(i, Number(c.args['mtu'])))] })
    const ospfIf = (i: Iface): NonNullable<Device['ospf']>['ifaces'][number] => {
      d.ospf ??= { process: '1', ifaces: [], neighbors: [] }
      let o = d.ospf.ifaces.find((x) => x.iface === i.name)
      if (!o) d.ospf.ifaces.push((o = { iface: i.name, area: '0' }))
      return o
    }
    I('ip ospf mtu-ignore', 'Ignores the MTU in DBD packets', (i) => ((ospfIf(i).mtuIgnore = true), changed('')), {}, { 'ip ospf': 'OSPF interface commands' })
    I('no ip ospf mtu-ignore', 'Ignores the MTU in DBD packets', (i) => ((ospfIf(i).mtuIgnore = false), changed('')))
    I('ip ospf cost', 'Interface cost', undefined as never, { children: [leaf(int(1, 65535), 'Cost', 'cost', (i, c) => ((ospfIf(i).cost = Number(c.args['cost'])), changed('')))] })
    I('ip ospf network', 'Network type', undefined as never, { children: [leaf({ kind: 'enum', label: 'point-to-point', values: () => ['broadcast', 'point-to-point'] }, 'Specify OSPF network type', 'nt', (i, c) => ((ospfIf(i).networkType = c.args['nt'] as 'broadcast'), changed('')))] })
    I('ip ospf', 'OSPF interface commands', undefined as never, { children: [prm(int(1, 65535), 'Process ID', { children: [kw('area', 'Set the OSPF area ID', { children: [leaf({ kind: 'word', label: '<0-4294967295>' }, 'OSPF area ID as a decimal value', 'area', (i, c) => ((ospfIf(i).area = c.args['area']!), changed('')))] })] })] })
    I('vrf forwarding', 'Configure forwarding table', undefined as never, {
      children: [
        leaf({ kind: 'word', label: 'WORD', test: (t) => d.vrfs.some((v) => v.name === t) }, 'VRF name', 'vrf', (i, c) => {
          const had = i.ip
          i.vrf = c.args['vrf']
          i.ip = undefined
          i.mask = undefined
          return changed(had ? `% Interface ${i.name} IPv4 disabled and address(es) removed due to enabling VRF ${i.vrf}` : '')
        })
      ]
    }, { vrf: 'VPN Routing/Forwarding parameters on the interface' })
    I('spanning-tree portfast', 'Portfast options for the interface', () => changed(''))
    I('spanning-tree bpduguard', "Don't accept BPDUs on this interface", undefined as never, { children: [leaf({ kind: 'enum', label: 'enable', values: () => ['enable', 'disable'] }, 'BPDU guard', 'bg', (i, c) => ((i.bpduGuard = c.args['bg'] === 'enable'), changed('')))] })
    I('no spanning-tree bpduguard', "Don't accept BPDUs on this interface", (i) => ((i.bpduGuard = false), changed('')))
    I('channel-group', 'Etherchannel/port bundling configuration', undefined as never, { children: [prm(int(1, 128), 'Channel group number', { name: 'cg', children: [kw('mode', 'Etherchannel Mode of the interface', { children: [leaf({ kind: 'enum', label: 'active', values: () => ['active', 'passive', 'on'] }, 'Mode', 'm', (i, c) => ((i.channelGroup = Number(c.args['cg'])), changed('')))] })] })] })
    I('no channel-group', 'Etherchannel/port bundling configuration', (i) => ((i.channelGroup = undefined), changed('')))
    I('storm-control', 'storm configuration', undefined as never, { children: [prm(line, 'storm-control options', { run: () => changed('') })] })
    I('service-policy', 'Configure CPL Service Policy', undefined as never, { children: [prm(line, 'policy', { run: () => changed('') })] })
    I('negotiation auto', 'Select Autonegotiation mode', () => changed(''), {}, { negotiation: 'Select Autonegotiation mode' })
    I('ip access-group', 'Specify access control for packets', undefined as never, { children: [prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access-list name', { children: [kw('in', 'inbound packets', { run: () => changed('') }), kw('out', 'outbound packets', { run: () => changed('') })] })] })
    ifm.push(kw('exit', 'Exit from interface configuration mode', { run: () => (this.exitMode(), '') }), kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') }), kw('do', 'To run exec commands in config mode', { children: [prm(line, 'Exec Command', { run: () => '' })] }))

    // ---- vlan
    const vlm: Node[] = [
      kw('name', 'Ascii name of the VLAN', { children: [prm({ kind: 'word', label: 'WORD' }, 'The ascii name for the VLAN', { name: 'n', run: (c) => { for (const id of this.mode.ctx as number[]) { const v = d.vlans.find((x) => x.id === id); if (v) v.name = c.args['n']! } return changed('') } })] }),
      kw('shutdown', 'Shutdown VLAN switching', { run: () => { for (const id of this.mode.ctx as number[]) { const v = d.vlans.find((x) => x.id === id); if (v) v.shutdown = true } return changed('') } }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('shutdown', 'Shutdown VLAN switching', { run: () => { for (const id of this.mode.ctx as number[]) { const v = d.vlans.find((x) => x.id === id); if (v) v.shutdown = false } return changed('') } }), kw('name', 'Ascii name of the VLAN', { run: () => changed('') })] }),
      kw('exit', 'Apply changes, bump revision number, and exit mode', { run: () => (this.exitMode(), '') }),
      kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') })
    ]

    // ---- router bgp
    const nbrP: Param = { kind: 'ipv4', label: 'A.B.C.D', values: () => d.bgp.map((n) => n.ip) }
    const nb = (c: Ctx): Device['bgp'][number] | undefined => d.bgp.find((n) => n.ip === c.args['nb'])
    const needNb = (c: Ctx, f: (n: Device['bgp'][number]) => string): string => {
      const n = nb(c)
      if (!n) return `% Specify remote-as or peer-group commands first`
      return f(n)
    }
    const bgpNbr: Node[] = [
      kw('remote-as', 'Specify a BGP neighbor', {
        children: [
          prm({ kind: 'asn', label: '<1-4294967295>' }, 'AS of remote neighbor', {
            name: 'as',
            run: (c) => {
              const as = Number(c.args['as'])
              let n = nb(c)
              if (!n) {
                const via = d.interfaces.find((i) => i.ip && i.mask !== undefined && inSubnet(c.args['nb']!, i.ip, i.mask))
                n = { ip: c.args['nb']!, remoteAs: as, via: via?.name ?? 'Loopback0', prefixes: 0 }
                d.bgp.push(n)
              } else if (n.remoteAs !== as) {
                if (n.upSince !== undefined) logEvent(d, `%BGP-5-ADJCHANGE: neighbor ${n.ip} Down Remote AS changed`)
                n.remoteAs = as
                n.upSince = undefined
              }
              return changed('')
            }
          })
        ]
      }),
      kw('description', 'Neighbor specific description', { children: [prm(line, 'Up to 80 characters describing this neighbor', { name: 'desc', run: (c) => needNb(c, (n) => ((n.description = c.args['desc']), changed(''))) })] }),
      kw('shutdown', 'Administratively shut down this neighbor', { run: (c) => needNb(c, (n) => { if (!n.shutdown && n.upSince !== undefined) logEvent(d, `%BGP-5-ADJCHANGE: neighbor ${n.ip} Down Admin. shutdown`); n.shutdown = true; return changed('') }) }),
      kw('password', 'Set a password', { children: [prm(line, 'Password (encryption type and key)', { name: 'pw', run: (c) => needNb(c, (n) => ((n.password = c.args['pw']!.replace(/^[07]\s+/, '')), changed(''))) })] }),
      kw('route-map', 'Apply route map to neighbor', { children: [prm({ kind: 'word', label: 'WORD', values: () => d.routeMaps.map((r) => r.name) }, 'Name of route map', { name: 'rm', children: ['in', 'out'].map((dir) => kw(dir, `Apply map to ${dir === 'in' ? 'incoming' : 'outbound'} routes`, { run: (c) => needNb(c, (n) => { if (dir === 'in') n.routeMapIn = c.args['rm']; else n.routeMapOut = c.args['rm']; return changed('') }) })) })] }),
      kw('update-source', 'Source of routing updates', { children: [prm(this.iface(), 'Interface', { name: 'us', run: (c) => needNb(c, (n) => ((n.updateSource = findIface(d, c.args['us']!, IOS_TYPES)?.name), changed(''))) })] }),
      kw('activate', 'Enable the Address Family for this Neighbor', { run: () => '' }),
      kw('ebgp-multihop', 'Allow EBGP neighbors not on directly connected networks', { run: () => changed(''), children: [prm(int(1, 255), 'maximum hop count', { run: () => changed('') })] }),
      kw('timers', 'BGP per neighbor timers', { children: [prm(int(0, 65535), 'Keepalive interval', { children: [prm(int(0, 65535), 'Holdtime', { run: () => changed('') })] })] }),
      kw('soft-reconfiguration', 'Per neighbor soft reconfiguration', { children: [kw('inbound', 'Allow inbound soft reconfiguration for this neighbor', { run: () => changed('') })] })
    ]
    const noNbr: Node[] = [
      kw('shutdown', 'Administratively shut down this neighbor', { run: (c) => needNb(c, (n) => ((n.shutdown = false), changed(''))) }),
      kw('description', 'Neighbor specific description', { run: (c) => needNb(c, (n) => ((n.description = undefined), changed(''))) }),
      kw('route-map', 'Apply route map to neighbor', { children: [prm({ kind: 'word', label: 'WORD' }, 'Name of route map', { name: 'rm', children: ['in', 'out'].map((dir) => kw(dir, 'direction', { run: (c) => needNb(c, (n) => { if (dir === 'in') n.routeMapIn = undefined; else n.routeMapOut = undefined; return changed('') }) })) })] }),
      kw('password', 'Set a password', { run: (c) => needNb(c, (n) => ((n.password = undefined), changed(''))) })
    ]
    const bgpm: Node[] = [
      kw('neighbor', 'Specify a neighbor router', { children: [prm(nbrP, 'Neighbor address', { name: 'nb', children: bgpNbr })] }),
      kw('bgp', 'BGP specific commands', {
        children: [
          kw('router-id', 'Override configured router identifier (peers will reset)', { children: [prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'Manually configured router identifier', { name: 'rid', run: (c) => ((d.routerId = c.args['rid']!), changed('')) })] }),
          kw('log-neighbor-changes', 'Log neighbor up/down and reset reason', { run: () => '' })
        ]
      }),
      kw('network', 'Specify a network to announce via BGP', { children: [prm(ipP('A.B.C.D'), 'Network number', { run: () => changed(''), children: [kw('mask', 'Network mask', { children: [prm(maskP, 'Network mask', { run: () => changed('') })] })] })] }),
      kw('address-family', 'Enter Address Family command mode', { children: [kw('ipv4', 'Address family', { run: () => (this.setMode('config-router-af', undefined, this.mode), ''), children: [kw('unicast', 'Address Family modifier', { run: () => (this.setMode('config-router-af', undefined, this.mode), '') }), kw('vrf', 'Specify parameters for a VPN Routing/Forwarding instance', { children: [prm(word(), 'VPN Routing/Forwarding instance name', { run: () => (this.setMode('config-router-af', undefined, this.mode), '') })] })] })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('neighbor', 'Specify a neighbor router', {
            children: [
              prm(nbrP, 'Neighbor address', {
                name: 'nb',
                run: (c) => {
                  const n = nb(c)
                  if (!n) return ''
                  if (n.upSince !== undefined) logEvent(d, `%BGP-5-ADJCHANGE: neighbor ${n.ip} Down Neighbor deleted`)
                  d.bgp = d.bgp.filter((x) => x !== n)
                  return changed('')
                },
                children: noNbr
              })
            ]
          }),
          kw('bgp', 'BGP specific commands', { children: [kw('log-neighbor-changes', 'Log neighbor up/down and reset reason', { run: () => '' })] }),
          kw('network', 'Specify a network to announce via BGP', { children: [prm(line, 'network', { run: () => changed('') })] })
        ]
      }),
      kw('exit', 'Exit from routing protocol configuration mode', { run: () => (this.exitMode(), '') }),
      kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') }),
      kw('timers', 'Adjust routing timers', { children: [kw('bgp', 'BGP timers', { children: [prm(line, 'keepalive holdtime', { run: () => changed('') })] })] })
    ]
    const afm: Node[] = [
      kw('neighbor', 'Specify a neighbor router', { children: [prm(nbrP, 'Neighbor address', { name: 'nb', children: bgpNbr.filter((n) => ['activate', 'route-map', 'soft-reconfiguration'].includes(n.word!)) })] }),
      kw('network', 'Specify a network to announce via BGP', { children: [prm(line, 'Network number', { run: () => changed('') })] }),
      kw('exit-address-family', 'Exit from Address Family configuration mode', { run: () => ((this.mode = this.mode.up ?? this.configMode()), '') }),
      kw('exit', 'Exit from Address Family configuration mode', { run: () => ((this.mode = this.mode.up ?? this.configMode()), '') }),
      kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') })
    ]

    // ---- router ospf
    const ospfm: Node[] = [
      kw('router-id', 'router-id for this OSPF process', { children: [prm(ipP('A.B.C.D'), 'OSPF router-id in IP address format', { name: 'rid', run: (c) => ((d.ospf!.routerId = c.args['rid']!), changed('')) })] }),
      kw('network', 'Enable routing on an IP network', {
        children: [
          prm(ipP('A.B.C.D'), 'Network number', {
            name: 'net',
            children: [
              prm(ipP('A.B.C.D'), 'OSPF wild card bits', {
                name: 'wc',
                children: [
                  kw('area', 'Set the OSPF area ID', {
                    children: [
                      prm({ kind: 'word', label: '<0-4294967295>' }, 'OSPF area ID as a decimal value', {
                        name: 'area',
                        run: (c) => {
                          const wc = c.args['wc']!.split('.').map((o) => 255 - Number(o)).join('.')
                          const len = dottedToLen(wc) ?? 32
                          for (const i of d.interfaces) if (i.ip && inSubnet(i.ip, c.args['net']!, len) && !d.ospf!.ifaces.some((o) => o.iface === i.name)) d.ospf!.ifaces.push({ iface: i.name, area: c.args['area']! })
                          return changed('')
                        }
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('passive-interface', 'Suppress routing updates on an interface', { children: [prm(this.iface(), 'Interface name', { name: 'if', run: (c) => { const o = d.ospf!.ifaces.find((x) => x.iface === this.ifOf(c)?.name); if (o) o.passive = true; return changed('') } })] }),
      kw('log-adjacency-changes', 'Log changes in adjacency state', { run: () => '' }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('network', 'Enable routing on an IP network', { children: [prm(line, 'network', { run: () => changed('') })] }), kw('passive-interface', 'Suppress routing updates', { children: [prm(this.iface(), 'Interface', { name: 'if', run: (c) => { const o = d.ospf!.ifaces.find((x) => x.iface === this.ifOf(c)?.name); if (o) o.passive = false; return changed('') } })] })] }),
      kw('exit', 'Exit from routing protocol configuration mode', { run: () => (this.exitMode(), '') }),
      kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') })
    ]

    // ---- ACL entry modes
    const aclm = (std: boolean): Node[] => {
      const entry = (c: Ctx, seqTok?: string): string => {
        const a = this.mode.ctx as Acl
        const act = c.args['act']!.toLowerCase() as Acl['entries'][number]['action']
        const text = c.args['rest'] ?? ''
        if (act !== 'remark' && !text) return '% Incomplete command.\n'
        if (!std && act !== 'remark' && !/^(ip|tcp|udp|icmp|gre|esp|ahp|ospf|eigrp|pim|object-group|\d+)\b/.test(text)) return `${this.caret(c.line.indexOf(text))}\n% Invalid input detected at '^' marker.\n`
        const seq = seqTok ? Number(seqTok) : (a.entries.at(-1)?.seq ?? 0) + 10
        if (a.entries.some((e) => e.seq === seq)) return '% Duplicate sequence number'
        a.entries.push({ seq, action: act, text })
        a.entries.sort((x, y) => x.seq - y.seq)
        return changed('')
      }
      const acts = (): Node[] =>
        ['permit', 'deny', 'remark'].map((w) => kw(w, w === 'remark' ? 'Access list entry comment' : `Specify packets to ${w === 'permit' ? 'forward' : 'reject'}`, { name: 'act', children: [prm(line, w === 'remark' ? 'Comment up to 100 characters' : std ? 'Address to match' : 'An IP protocol number or name', { name: 'rest', run: (c) => entry(c, c.args['seq']) })] }))
      return [
        ...acts(),
        prm(int(1, 2147483647), 'Sequence Number', { name: 'seq', children: acts() }),
        kw('no', 'Negate a command or set its defaults', { children: [prm(int(1, 2147483647), 'Sequence Number', { name: 'seq', run: (c) => { const a = this.mode.ctx as Acl; a.entries = a.entries.filter((e) => e.seq !== Number(c.args['seq'])); return changed('') } })] }),
        kw('exit', 'Exit from access-list configuration mode', { run: () => (this.exitMode(), '') }),
        kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') })
      ]
    }

    // ---- route-map entry mode
    const rmCtx = (): { rm: RouteMap; e: RouteMap['entries'][number] } => this.mode.ctx as { rm: RouteMap; e: RouteMap['entries'][number] }
    const rmm: Node[] = [
      kw('match', 'Match values from routing table', { children: [prm(line, 'match clause', { name: 'm', run: (c) => { rmCtx().e.match.push(c.args['m']!); return changed('') } })] }),
      kw('set', 'Set values in destination routing protocol', { children: [prm(line, 'set clause', { name: 's', run: (c) => { rmCtx().e.set.push(c.args['s']!); return changed('') } })] }),
      kw('description', 'Route-map comment', { children: [prm(line, 'Comment up to 100 characters', { run: () => changed('') })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('match', 'Match values from routing table', { children: [prm(line, 'match clause', { name: 'm', run: (c) => { const e = rmCtx().e; e.match = e.match.filter((x) => x !== c.args['m']); return changed('') } })] }),
          kw('set', 'Set values in destination routing protocol', { children: [prm(line, 'set clause', { name: 's', run: (c) => { const e = rmCtx().e; e.set = e.set.filter((x) => x !== c.args['s']); return changed('') } })] })
        ]
      }),
      kw('exit', 'Exit from route-map configuration mode', { run: () => (this.exitMode(), '') }),
      kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') })
    ]

    // ---- line / vrf / archive
    const generic = (more: Node[]): Node[] => [...more, kw('exit', 'Exit from this submode', { run: () => (this.exitMode(), '') }), kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') })]
    const linem = generic([
      kw('transport', 'Define transport protocols for line', { children: [kw('input', 'Define which protocols to use when connecting to the terminal server', { children: [prm({ kind: 'enum', label: 'ssh', values: () => ['all', 'none', 'ssh', 'telnet'] }, 'Protocols', { run: () => changed(''), children: [prm(word(), 'protocol', { run: () => changed('') })] })] })] }),
      kw('exec-timeout', 'Set the EXEC timeout', { children: [prm(int(0, 35791), 'Timeout in minutes', { run: () => changed(''), children: [prm(int(0, 2147483), 'Timeout in seconds', { run: () => changed('') })] })] }),
      kw('length', 'Set number of lines on a screen', { children: [prm(int(0, 512), 'Number of lines on screen (0 for no pausing)', { name: 'n', run: (c) => ((this.s.pageLength = Number(c.args['n'])), changed('')) })] }),
      kw('login', 'Enable password checking', { run: () => changed(''), children: [kw('local', 'Local password checking', { run: () => changed('') })] }),
      kw('logging', 'Modify message logging facilities', { children: [kw('synchronous', 'Synchronized message output', { run: () => changed('') })] }),
      kw('access-class', 'Filter connections based on an IP access list', { children: [prm(word(), 'IP access list', { children: [kw('in', 'Filter incoming connections', { run: () => changed(''), children: [kw('vrf-also', 'Same access list is applied for all VRFs', { run: () => changed('') })] })] })] })
    ])
    const vrfm = generic([
      kw('rd', 'Specify Route Distinguisher', { children: [prm({ kind: 'word', label: 'ASN:nn or IP-address:nn' }, 'VPN Route Distinguisher', { name: 'rd', run: (c) => (((this.mode.ctx as Device['vrfs'][number]).rd = c.args['rd']!), changed('')) })] }),
      kw('address-family', 'Enter Address Family command mode', { children: [kw('ipv4', 'Address family', { run: () => (this.setMode('config-vrf-af', this.mode.ctx, this.mode), '') }), kw('ipv6', 'Address family', { run: () => (this.setMode('config-vrf-af', this.mode.ctx, this.mode), '') })] }),
      kw('description', 'VRF specific description', { children: [prm(line, 'Up to 244 characters describing this VRF', { run: () => changed('') })] })
    ])
    const vrfaf = generic([kw('exit-address-family', 'Exit from Address Family configuration mode', { run: () => ((this.mode = this.mode.up ?? this.configMode()), '') }), kw('route-target', 'Specify Target VPN Extended Communities', { children: [prm(line, 'import/export RT', { run: () => changed('') })] })])
    const arch = this.store().archive!
    const archm = generic([
      kw('path', 'path for backups', { children: [prm(word(), 'path', { name: 'p', run: (c) => ((arch.path = c.args['p']!), changed('')) })] }),
      kw('maximum', 'maximum number of backup copies', { children: [prm(int(1, 14), 'maximum number of backup copies', { name: 'n', run: (c) => ((arch.maximum = Number(c.args['n'])), changed('')) })] }),
      kw('write-memory', 'Enable automatic backup generation during write memory', { run: () => changed('') }),
      kw('time-period', 'Period of time in minutes to automatically archive the running-config', { children: [prm(int(1, 525600), 'Number of minutes to wait between archive creation', { run: () => changed('') })] })
    ])
    for (const t of [g, ifm]) t.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return {
      config: g,
      'config-if': ifm,
      'config-if-range': ifm,
      'config-vlan': vlm,
      'config-router-bgp': bgpm,
      'config-router-af': afm,
      'config-router-ospf': ospfm,
      'config-ext-nacl': aclm(false),
      'config-std-nacl': aclm(true),
      'config-route-map': rmm,
      'config-line': linem,
      'config-vrf': vrfm,
      'config-vrf-af': vrfaf,
      'config-archive': archm
    }
  }

  private staticRouteNodes(remove: boolean): Node[] {
    const d = this.d
    const run = (c: Ctx): string => {
      const len = dottedToLen(c.args['mask']!)!
      const vrf = c.args['vrf']
      const nh = c.args['nh']!
      if (remove) {
        const before = d.staticRoutes.length
        d.staticRoutes = d.staticRoutes.filter((r) => !(r.prefix === c.args['net'] && r.mask === len && (r.vrf ?? undefined) === vrf && (!nh || r.nextHop === nh)))
        if (d.staticRoutes.length === before) return '%No matching route to delete'
      } else {
        if (!d.staticRoutes.some((r) => r.prefix === c.args['net'] && r.mask === len && r.nextHop === nh && r.vrf === vrf)) d.staticRoutes.push({ prefix: c.args['net']!, mask: len, nextHop: nh, ...(vrf ? { vrf } : {}), ...(c.args['ad'] ? { ad: Number(c.args['ad']) } : {}) })
      }
      this.touch()
      return ''
    }
    const tail = (): Node[] => [
      prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'Destination prefix', {
        name: 'net',
        children: [
          prm({ kind: 'mask', label: 'A.B.C.D' }, 'Destination prefix mask', {
            name: 'mask',
            children: [
              prm({ kind: 'word', label: 'A.B.C.D', test: (t) => isIpv4(t) || /^null0$/i.test(t) || !!findIface(d, t, IOS_TYPES) }, 'Forwarding router\'s address', {
                name: 'nh',
                run,
                children: [prm({ kind: 'int', label: '<1-255>', min: 1, max: 255 }, 'Distance metric for this route', { name: 'ad', run }), kw('name', 'Specify name of the next hop', { children: [prm({ kind: 'word', label: 'WORD' }, 'Name of the next hop', { run })] })]
              })
            ]
          })
        ]
      })
    ]
    return [kw('vrf', 'Configure static route for a VPN Routing/Forwarding instance', { children: [prm({ kind: 'word', label: 'WORD', test: (t) => d.vrfs.some((v) => v.name === t) }, 'VPN Routing/Forwarding instance name', { name: 'vrf', children: tail() })] }), ...tail()]
  }

  // ------------------------------------------------------------------ config helpers

  private eachIf(f: (i: Iface) => string): string {
    const ctx = this.mode.ctx
    const list = Array.isArray(ctx) ? (ctx as Iface[]) : ctx ? [ctx as Iface] : []
    return list.map(f).filter(Boolean).join('\n')
  }

  private enterRange(c: Ctx): string {
    const spec = c.args['range']!
    const list: Iface[] = []
    for (const part of spec.split(',')) {
      const m = /^\s*([a-z-]+)\s*(\d+\/\d+\/|\d+\/)?(\d+)\s*(?:-\s*(\d+))?\s*$/i.exec(part)
      if (!m) return `${this.caret(c.line.indexOf(spec))}\n% Invalid input detected at '^' marker.\n`
      const [, type, prefix = '', from, to] = m
      for (let n = Number(from); n <= Number(to ?? from); n++) {
        const i = findIface(this.d, `${type}${prefix}${n}`, IOS_TYPES)
        if (!i) return `% Command rejected: range interface ${type}${prefix}${n} not present`
        list.push(i)
      }
    }
    this.setMode('config-if-range', list)
    return ''
  }

  private shut(i: Iface, down: boolean): string {
    const d = this.d
    if (down && i.adminUp) {
      i.adminUp = false
      i.lastChange = now(d)
      logEvent(d, `%LINK-5-CHANGED: Interface ${i.name}, changed state to administratively down`)
      logEvent(d, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to down`)
      for (const n of d.bgp.filter((b) => b.via === i.name && b.upSince !== undefined)) logEvent(d, `%BGP-5-ADJCHANGE: neighbor ${n.ip} Down Interface flap`)
      for (const n of d.ospf?.neighbors.filter((x) => x.iface === i.name) ?? []) logEvent(d, `%OSPF-5-ADJCHG: Process ${d.ospf!.process}, Nbr ${n.routerId} on ${i.name} from FULL to DOWN, Neighbor Down: Interface down or detached`)
    } else if (!down) {
      const wasErr = i.errDisabled
      if (!i.adminUp || wasErr) {
        i.adminUp = true
        if (wasErr && !i.bpduGuard && wasErr === 'bpduguard') i.errDisabled = undefined
        else if (wasErr) {
          // The cause is still there: the port goes err-disabled again a moment later.
          i.errDisabled = undefined
          const rt = runtime(d)
          rt.timer(`errdis-${i.name}`, 1500, () => {
            if (!i.adminUp) return
            i.errDisabled = wasErr
            if (wasErr === 'bpduguard') logEvent(d, `%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${i.name} with BPDU Guard enabled. Disabling port.`)
            const msg = `%PM-4-ERR_DISABLE: ${wasErr} error detected on ${i.short}, putting ${i.short} in err-disable state`
            logEvent(d, msg)
            rt.broadcast(`*${R.logStamp(now(d))}: ${msg}`)
          })
        }
        i.lastChange = now(d)
        logEvent(d, `%LINK-3-UPDOWN: Interface ${i.name}, changed state to ${i.linkUp ? 'up' : 'down'}`)
        if (i.linkUp) logEvent(d, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to up`)
        const peers = d.bgp.filter((b) => b.via === i.name)
        tickBgp(d)
        for (const n of peers) runtime(d).timer(`bgp-up-${n.ip}`, 4000, () => { if (n.upSince !== undefined && n.upSince <= now(d)) logEvent(d, `%BGP-5-ADJCHANGE: neighbor ${n.ip} Up `) })
      }
    }
    this.touch()
    return ''
  }

  private setIp(i: Iface, ip: string, mask: string): string {
    const len = dottedToLen(mask)!
    const clash = this.d.interfaces.find((x) => x !== i && x.ip && x.mask !== undefined && !x.vrf === !i.vrf && inSubnet(ip, x.ip, Math.min(x.mask, len)) && x.mask < 32 && len < 32)
    if (clash) return `% ${R.showIpIntBrief.name ? '' : ''}${ip} overlaps with ${clash.name}`.replace('% ', `% ${networkOf(ip, len)} overlaps with `).replace(/overlaps with .* overlaps with /, 'overlaps with ')
    if (i.mode !== 'routed' && /^(Gi|Te)/.test(i.short)) return '% IP addresses may not be configured on L2 links.'
    i.ip = ip
    i.mask = len
    i.ipMethod = 'manual'
    this.touch()
    return ''
  }

  private setDuplex(i: Iface, dx: 'auto' | 'full' | 'half'): string {
    i.duplex = dx
    if (dx !== 'auto' && (!i.speedSet || i.speedSet === 'auto') && i.speed === '1000') return '% Duplex cannot be set when speed is 1000 or auto.'.replace('cannot be set', 'will not be set until speed is set to non-auto value') && (this.touch(), '')
    this.touch()
    return ''
  }

  private setMtu(i: Iface, mtu: number): string {
    i.mtu = mtu === 1500 ? undefined : mtu
    this.touch()
    return ''
  }

  // ------------------------------------------------------------------ exec helpers

  private enterConfig(): string {
    this.setMode('config')
    return 'Enter configuration commands, one per line.  End with CNTL/Z.'
  }

  private save(): string {
    const d = this.d
    d.startup = snapshot(d)
    logEvent(d, `%SYS-5-CONFIG_NV_I: Nonvolatile storage configured from console by ${this.s.user} on vty0 (${this.s.from})`)
    if (this.store().archive) this.archiveConfig(true)
    return 'Building configuration...\n[OK]'
  }

  private copyToFile(dst: string): string {
    const name = dst.includes(':') ? dst : `flash:${dst}`
    this.store().files[name] = snapshot(this.d)
    return `${configLines(this.d).join('\n').length} bytes copied in 0.412 secs (${Math.floor(configLines(this.d).join('\n').length / 0.412)} bytes/sec)`
  }

  private async eraseStartup(): Promise<string> {
    const a = await this.s.ask('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]')
    if (a !== '' && a.toLowerCase() !== 'y') return ''
    return '[OK]\nErase of nvram: complete\n%% [simulator] Nothing was erased (simulated device).'
  }

  private async reload(): Promise<string> {
    if (isDirty(this.d)) {
      const a = (await this.s.ask('System configuration has been modified. Save? [yes/no]: ', { mode: 'line' })).trim().toLowerCase()
      if (a === '' && this.s.aborted) return ''
      if (a.startsWith('y')) await this.s.print(this.save())
      else if (!a.startsWith('n')) return '% Please answer \'yes\' or \'no\'.'
    }
    const ok = await this.s.ask('Proceed with reload? [confirm]')
    if (ok !== '' && ok.toLowerCase() !== 'y') return ''
    return '%% [simulator] reload acknowledged. The simulator never reboots.'
  }

  private async reloadIn(spec: string, at = false): Promise<string> {
    const t = now(this.d)
    let mins: number
    if (at) {
      const [h, m] = spec.split(':').map(Number)
      const target = new Date(t)
      target.setUTCHours(h!, m!, 0, 0)
      if (target.getTime() <= t) target.setUTCDate(target.getUTCDate() + 1)
      mins = Math.round((target.getTime() - t) / 60000)
    } else {
      const parts = spec.split(':').map(Number)
      mins = parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]!
    }
    const when = R.ciscoDate(t + mins * 60000).replace(/ UTC /, ' UTC ')
    await this.s.print(`Reload scheduled for ${when} (in ${mins} minute${mins === 1 ? '' : 's'}) by ${this.s.user} on vty0 (${this.s.from})`)
    const ok = await this.s.ask('Proceed with reload? [confirm]')
    if (ok !== '' && ok.toLowerCase() !== 'y') return ''
    ;(this.d.vendor as { reloadAt?: number }).reloadAt = t + mins * 60000
    runtime(this.d).timer('ios-reload', mins * 60000, () => {
      runtime(this.d).broadcast('\n\n***\n*** --- SHUTDOWN NOW ---\n***\n\n%% [simulator] scheduled reload reached. The simulator never reboots.')
      delete (this.d.vendor as { reloadAt?: number }).reloadAt
    })
    return ''
  }

  private reloadCancel(): string {
    const rt = runtime(this.d)
    if (!rt.pending('ios-reload')) return '%No reload is scheduled.'
    rt.cancel('ios-reload')
    delete (this.d.vendor as { reloadAt?: number }).reloadAt
    rt.broadcast('\n\n***\n*** --- SHUTDOWN ABORTED ---\n***\n')
    return '%Reload cancelled.'
  }

  private async clearCounters(i?: Iface): Promise<string> {
    const a = await this.s.ask(i ? `Clear "show interface" counters on this interface [confirm]` : 'Clear "show interface" counters on all interfaces [confirm]')
    if (a !== '' && a.toLowerCase() !== 'y') return ''
    const t = now(this.d)
    for (const x of i ? [i] : this.d.interfaces) {
      x.clearedAt = t
      x.errors = undefined
      if (x.faultSince !== undefined) x.faultSince = t
    }
    logEvent(this.d, `%CLEAR-5-COUNTERS: Clear counter on ${i ? `interface ${i.name}` : 'all interfaces'} by ${this.s.user} on vty0 (${this.s.from})`)
    return ''
  }

  private archiveConfig(quiet = false): string {
    const st = this.store()
    const a = st.archive!
    a.n++
    st.files[`${a.path}-${a.n}`] = snapshot(this.d)
    const keys = Object.keys(st.files).filter((k) => k.startsWith(`${a.path}-`))
    while (keys.length > a.maximum) delete st.files[keys.shift()!]
    void quiet
    return `${a.path}-${a.n}`
  }

  private showArchive(): string {
    const st = this.store()
    const a = st.archive
    if (!a) return ' Archive feature not enabled'
    const files = Object.keys(st.files).filter((k) => k.startsWith(`${a.path}-`))
    const rows: string[] = []
    for (let k = 0; k < a.maximum; k++) rows.push(`${String(k + 1).padStart(4)}        ${files[k] ?? ''}${k === files.length - 1 ? ' <- Most Recent' : ''}`.trimEnd())
    return [`The maximum archive configurations allowed is ${a.maximum}.`, `There are currently ${files.length} archive configurations saved.`, `The next archive file will be named ${a.path}-${a.n + 1}`, ' Archive #  Name', ...rows].join('\n')
  }

  private async configureReplace(c: Ctx): Promise<string> {
    const st = this.store()
    const file = c.args['file']!
    const snap = st.files[file] ?? (file === 'nvram:startup-config' || file === 'startup-config' ? this.d.startup : undefined)
    if (!snap) return `%Error opening ${file} (No such file or directory)`
    if (!c.args['force']) {
      const a = (await this.s.ask('This will apply all necessary additions and deletions\nto replace the current running configuration with the\ncontents of the specified configuration file, which is\nassumed to be a complete configuration, not a partial\nconfiguration. Enter Y if you are sure you want to proceed. ? [no]: ', { mode: 'line' })).trim()
      if (!/^y(es)?$/i.test(a)) return ''
    }
    const before = configLines(this.d)
    const backup = c.args['time'] ? this.archiveConfig(true) : undefined
    restore(this.d, snap)
    this.touch()
    const after = configLines(this.d)
    const out: string[] = []
    if (c.args['list']) {
      out.push('!Pass 1', '', '!List of Commands:')
      for (const l of after) if (!before.includes(l) && l.trim() !== '!') out.push(l)
      for (const l of before) if (!after.includes(l) && l.trim() !== '!' && !l.startsWith(' ')) out.push(`no ${l}`)
      out.push('end')
    }
    out.push('Total number of passes: 1', 'Rollback Done', '', '')
    logEvent(this.d, `%SYS-5-CONFIG_R: Config Replace is Done`)
    if (backup) {
      const mins = Number(c.args['time'])
      st.revert = { backup, at: now(this.d) + mins * 60000 }
      this.armRevert(mins)
    }
    return out.join('\n')
  }

  private armRevert(mins: number): void {
    const st = this.store()
    runtime(this.d).timer('ios-revert', mins * 60000, () => {
      const rv = st.revert
      if (!rv) return
      const snap = st.files[rv.backup]
      if (snap) restore(this.d, snap)
      st.revert = undefined
      tickBgp(this.d)
      const msg = `%ARCHIVE_DIFF-5-ROLLBK_CNFMD_CHG_ROLLBACK_START: Start rolling to: ${rv.backup}`
      logEvent(this.d, msg)
      logEvent(this.d, '%ARCHIVE_DIFF-5-ROLLBK_CNFMD_CHG_ROLLBACK_DONE: Rollback done')
      runtime(this.d).broadcast(`*${R.logStamp(now(this.d))}: ${msg}`)
    })
  }

  private revertTimer(mins: number): string {
    const st = this.store()
    const name = `${st.archive!.path}-${R.ciscoDate(now(this.d)).replace(/^(\d+):(\d+):(\d+) UTC \S+ (\S+) (\d+) \d+$/, '$4-$5-$1-$2-$3')}.123-${st.archive!.n}`
    st.files[name] = snapshot(this.d)
    st.revert = { backup: name, at: now(this.d) + mins * 60000 }
    this.armRevert(mins)
    this.setMode('config')
    return `Rollback Confirmed Change: Backing up current running config to ${name}\nEnter configuration commands, one per line.  End with CNTL/Z.`
  }

  private confirmRevert(): string {
    const st = this.store()
    if (!st.revert) return '%No Rollback Confirmed Change pending'
    runtime(this.d).cancel('ios-revert')
    st.revert = undefined
    logEvent(this.d, '%ARCHIVE_DIFF-5-ROLLBK_CNFMD_CHG_CONFIRM: User: ' + this.s.user + '(Priv: 15, View: 0): Confirm the configuration change')
    return ''
  }

  private revertNow(): string {
    const st = this.store()
    if (!st.revert) return '%No Rollback Confirmed Change pending'
    runtime(this.d).cancel('ios-revert')
    const snap = st.files[st.revert.backup]
    if (snap) restore(this.d, snap)
    st.revert = undefined
    this.touch()
    return ''
  }

  private resetRevert(mins: number): string {
    const st = this.store()
    if (!st.revert) return '%No Rollback Confirmed Change pending'
    st.revert.at = now(this.d) + mins * 60000
    this.armRevert(mins)
    return ''
  }

  private dir(): string {
    const files = Object.keys(this.store().files).filter((f) => f.startsWith('flash:'))
    return [
      'Directory of flash:/',
      '',
      '475137  drwx             4096  Nov 24 2026 11:02:11 +00:00  archive',
      '475138  -rw-             2097  Oct 13 2026 07:08:31 +00:00  packages.conf',
      '475139  -rw-        488321728  Oct 13 2026 07:02:10 +00:00  cat9k_iosxe.17.09.04a.SPA.bin',
      ...files.map((f, k) => `${475140 + k}  -rw-             ${configLines(this.d).join('\n').length}  ${R.ciscoDate(this.store().files[f]!.takenAt).replace(/^(\S+) UTC \S+ (\S+) (\d+) (\d+)$/, '$2 $3 $4 $1')} +00:00  ${f.replace(/^flash:/, '')}`),
      '',
      '11353194496 bytes total (8180502528 bytes free)'
    ].join('\n')
  }

  private more(f: string): string {
    const snap = this.store().files[f.includes(':') ? f : `flash:${f}`]
    if (!snap) return `%Error opening ${f} (No such file or directory)`
    return configLines(deviceOf(this.d, snap)).join('\n')
  }

  private async deleteFile(f: string): Promise<string> {
    const name = f.replace(/^\/force\s+/, '')
    const a = await this.s.ask(`Delete filename [${name.replace(/^flash:/, '')}]? `, { mode: 'line' })
    void a
    const c = await this.s.ask(`Delete ${name.includes(':') ? name : `flash:/${name}`}? [confirm]`)
    if (c !== '' && c.toLowerCase() !== 'y') return ''
    const key = name.includes(':') ? name : `flash:${name}`
    if (this.store().files[key]) {
      delete this.store().files[key]
      return ''
    }
    return `%Error deleting ${key} (No such file or directory)`
  }

  private connect(host: string): string {
    return `Trying ${host} ... \n% Connection timed out; remote host not responding`
  }

  async ping(target: string, count: number, vrf?: string, src?: string): Promise<string> {
    if (!isIpv4(target)) return `Translating "${target}"\n% Unrecognized host or address, or protocol not running.`
    void src
    const ok = reachable(this.d, target, vrf)
    await this.s.print(`Type escape sequence to abort.\nSending ${count}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`)
    let marks = ''
    for (let k = 0; k < count; k++) {
      if (!(await this.s.sleep(ok ? 60 : 400))) break
      marks += ok ? '!' : '.'
      this.s.write(ok ? '!' : '.')
      if ((k + 1) % 70 === 0) this.s.write('\r\n')
    }
    this.s.write('\r\n')
    const sent = marks.length
    const got = [...marks].filter((m) => m === '!').length
    const pct = sent ? Math.floor((got / sent) * 100) : 0
    return `Success rate is ${pct} percent (${got}/${sent})${got ? ', round-trip min/avg/max = 1/1/2 ms' : ''}`
  }

  private async trace(target: string, vrf?: string): Promise<string> {
    if (!isIpv4(target)) return `Translating "${target}"\n% Unrecognized host or address, or protocol not running.`
    await this.s.print('Type escape sequence to abort.\nTracing the route to ' + target + '\nVRF info: (vrf in name/id, vrf out name/id)')
    const d = this.d
    const hops = traceHops(d, target, vrf)
    for (let k = 0; k < hops.length; k++) {
      if (!(await this.s.sleep(hops[k] === '*' ? 600 : 120))) break
      const h = hops[k]!
      await this.s.print(h === '*' ? `${String(k + 1).padStart(3)}  *  *  * ` : `${String(k + 1).padStart(3)} ${h} ${1 + k} msec ${1 + k} msec ${2 + k} msec`)
    }
    return ''
  }
}

// ---------------------------------------------------------------- helpers

function expand(word: string): string {
  const w = word.toLowerCase()
  if ('running-config'.startsWith(w) && w.length >= 3) return 'running-config'
  if ('startup-config'.startsWith(w) && w.length >= 3) return 'startup-config'
  return word
}

export function expandVlans(spec: string): number[] {
  const out: number[] = []
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number)
    for (let v = a!; v <= (b ?? a!); v++) out.push(v)
  }
  return out
}

function networkOf(ip: string, len: number): string {
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
  const m = len === 0 ? 0 : (~0 << (32 - len)) >>> 0
  const net = (n & m) >>> 0
  return [24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')
}

function deviceOf(d: Device, snap: ConfigSnapshot): Device {
  const copy = structuredClone({ ...d, startup: undefined }) as Device
  restore(copy, snap)
  return copy
}

/** Can the device reach `ip` (connected, own address, or via a usable route)? */
export function reachable(d: Device, ip: string, vrf?: string): boolean {
  const ifs = d.interfaces.filter((i) => (vrf ? i.vrf === vrf : !i.vrf) && isUp(i) && i.ip)
  if (ifs.some((i) => i.ip === ip)) return true
  const conn = ifs.find((i) => i.mask! < 32 && inSubnet(ip, i.ip!, i.mask!))
  if (conn) return d.arp.some((a) => a.ip === ip) || d.bgp.some((n) => n.ip === ip) || (d.ospf?.neighbors.some((n) => n.ip === ip) ?? false) || /\.(1|2|254)$/.test(ip)
  if (loopFor(d, ip)) return false
  const routes = R.rib(d, vrf)
  const hit = routes.filter((r) => r.code !== 'C' && r.code !== 'L' && inSubnet(ip, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask)[0]
  return !!hit && !/^192\.0\.2\./.test(ip)
}

function loopFor(d: Device, ip: string): { via: string; back: string } | undefined {
  for (const r of d.remoteRoutes ?? []) {
    if (!inSubnet(ip, r.prefix, r.mask)) continue
    const mine = d.staticRoutes.find((s) => inSubnet(ip, s.prefix, s.mask) && s.mask > 0 && s.nextHop === r.at)
    if (mine) return { via: r.at, back: r.via }
  }
  return undefined
}

/** Hops for traceroute: loops between two routers when the routing-loop scenario applies. */
export function traceHops(d: Device, ip: string, vrf?: string): string[] {
  const loop = loopFor(d, ip)
  if (loop) return Array.from({ length: 12 }, (_, k) => (k % 2 === 0 ? loop.via : loop.back))
  if (reachable(d, ip, vrf)) {
    const ifs = d.interfaces.filter((i) => (vrf ? i.vrf === vrf : !i.vrf) && isUp(i) && i.ip && i.mask! < 32)
    if (ifs.some((i) => inSubnet(ip, i.ip!, i.mask!))) return [ip]
    const def = d.staticRoutes.find((r) => r.mask === 0)?.nextHop ?? d.bgp.find((n) => n.upSince)?.ip ?? ip
    return [def, ip]
  }
  const def = d.staticRoutes.find((r) => r.mask === 0)
  return def && ifsUpFor(d, def.nextHop) ? [def.nextHop, '*', '*', '*'] : ['*', '*', '*']
}

function ifsUpFor(d: Device, ip: string): boolean {
  return d.interfaces.some((i) => isUp(i) && i.ip && i.mask! < 32 && inSubnet(ip, i.ip, i.mask!))
}

function ipIntDetail(i: Iface): string {
  const [st, pr] = !i.adminUp ? ['administratively down', 'down'] : isUp(i) ? ['up', 'up'] : ['down', 'down']
  if (!i.ip) return `${i.name} is ${st}, line protocol is ${pr}\n  Internet protocol processing disabled`
  return [
    `${i.name} is ${st}, line protocol is ${pr}`,
    `  Internet address is ${i.ip}/${i.mask}`,
    `  Broadcast address is 255.255.255.255`,
    `  Address determined by ${i.ipMethod === 'manual' ? 'setup command' : 'non-volatile memory'}`,
    `  MTU is ${i.mtu ?? 1500} bytes`,
    `  Helper address is not set`,
    `  Directed broadcast forwarding is disabled`,
    `  Outgoing Common access list is not set `,
    `  Outgoing access list is not set`,
    `  Inbound Common access list is not set `,
    `  Inbound  access list is not set`,
    `  Proxy ARP is enabled`,
    `  Local Proxy ARP is disabled`,
    `  Security level is default`,
    `  Split horizon is enabled`,
    `  ICMP redirects are always sent`,
    `  ICMP unreachables are always sent`,
    `  ICMP mask replies are never sent`,
    `  IP fast switching is enabled`,
    `  IP CEF switching is enabled`,
    `  VPN Routing/Forwarding "${i.vrf ?? ''}"`.replace(' ""', '').replace('VPN Routing/Forwarding', i.vrf ? 'VPN Routing/Forwarding' : '').trimEnd()
  ]
    .filter(Boolean)
    .join('\n')
}

function routeSummary(d: Device, vrf?: string): string {
  const r = R.rib(d, vrf)
  const count = (c: string): number => r.filter((x) => x.code.startsWith(c)).length
  return [
    `IP routing table name is ${vrf ?? 'default'} (0x0)`,
    'IP routing table maximum-paths is 32',
    'Route Source    Networks    Subnets     Replicates  Overhead    Memory (bytes)',
    `connected       0           ${pad(count('C') + count('L'), 12)}0           ${pad((count('C') + count('L')) * 96, 12)}${(count('C') + count('L')) * 288}`,
    `static          ${pad(count('S'), 12)}0           0           ${pad(count('S') * 96, 12)}${count('S') * 288}`,
    `bgp ${d.localAs}       ${pad(0, 12)}${pad(count('B'), 12)}0           ${pad(count('B') * 96, 12)}${count('B') * 288}`,
    `ospf ${d.ospf?.process ?? 1}          0           ${pad(count('O'), 12)}0           ${pad(count('O') * 96, 12)}${count('O') * 288}`,
    `Total           ${pad(count('S'), 12)}${pad(r.length - count('S'), 12)}0           ${pad(r.length * 96, 12)}${r.length * 288}`
  ].join('\n')
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n)

function ipProtocols(d: Device): string {
  return [
    '*** IP Routing is NSF aware ***',
    '',
    'Routing Protocol is "application"',
    '  Sending updates every 0 seconds',
    '  Invalid after 0 seconds, hold down 0, flushed after 0',
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    '  Maximum path: 32',
    '  Routing for Networks:',
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    '  Distance: (default is 4)',
    '',
    ...(d.ospf
      ? [`Routing Protocol is "ospf ${d.ospf.process}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set', `  Router ID ${d.ospf.routerId ?? d.routerId}`, '  Number of areas in this router is 1. 1 normal 0 stub 0 nssa', '  Maximum path: 4', '  Routing for Networks:', ...d.ospf.ifaces.map((o) => `    ${d.interfaces.find((i) => i.name === o.iface)?.ip ?? '0.0.0.0'} 0.0.0.0 area ${o.area}`), '  Distance: (default is 110)', '']
      : []),
    `Routing Protocol is "bgp ${d.localAs}"`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    '  IGP synchronization is disabled',
    '  Automatic route summarization is disabled',
    '  Neighbor(s):',
    '    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap',
    ...d.bgp.map((n) => `    ${pad(n.ip, 17)}${' '.repeat(36)}${n.routeMapIn ?? ''}`.trimEnd()),
    '  Maximum path: 1',
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    '  Distance: external 20 internal 200 local 200'
  ].join('\n')
}

function vlanById(d: Device, id: number): string {
  const v = d.vlans.find((x) => x.id === id)
  if (!v) return `VLAN id ${id} not found in current VLAN database`
  return R.showVlan({ ...d, vlans: [v] }, true).split('\n').filter((l) => !/^100[2-5] /.test(l)).join('\n')
}

function cpuHistory(d: Device): string {
  const [five] = R.cpuLoad(d)
  const bar = (n: number): string => `${String(n).padStart(3)} ${'*'.repeat(Math.round(n / 10))}`
  return [`    ${d.hostname}   ${new Date(now(d)).toISOString().slice(0, 10)}`, '', '    CPU% per second (last 60 seconds)', bar(five), bar(Math.max(0, five - 2)), bar(Math.max(0, five - 1)), '', '    CPU% per minute (last 60 minutes)', bar(five), bar(Math.max(0, five - 5))].join('\n')
}

export { maskToDotted }
export const iosFactory = (s: Session): IosPersonality => new IosPersonality(s)
