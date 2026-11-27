/**
 * Cisco NX-OS personality (docs/research/cli-cisco-nxos.md). EXEC starts at `#`, config applies
 * line by line, features gate their command trees, `% Invalid command at '^' marker.` errors with a
 * caret under the failing token, `--More--` pager, `| json`, `;` chaining, routing-context,
 * checkpoint/rollback, ACL configuration sessions and `copy running-config startup-config`.
 */
import type { ControlResult, PagerSpec, Session, TabResult } from '../../core/personality.ts'
import { findIface, parseIfName } from '../../core/ifname.ts'
import { now, runtime, setClock } from '../../core/runtime.ts'
import { safeRegex, section, splitPipes, unifiedDiff, unquote } from '../../core/text.ts'
import { add, dottedToLen, isIpv4, kw, match, prm, tokenOffsets, type Ctx, type HelpResult, type MatchResult, type Node, type Param } from '../../core/tree.ts'
import { CiscoBase, type CMode, type Failure, type PipeOutcome } from '../cisco/base.ts'
import { deviceFrom, logEvent, restore, snapshot, tickBgp, uptime, type Acl, type BgpNeighbor, type Device, type Iface, type RouteMap } from '../../state.ts'
import { expandVlans, reachable, traceHops } from '../ios/index.ts'
import * as R from './render.ts'
import { configBody, isDirty, runningConfig, runningSection, startupConfig, store, type NxIface } from './config.ts'

const SUFFIX: Record<string, string> = {
  config: '(config)',
  'config-if': '(config-if)',
  'config-if-range': '(config-if-range)',
  'config-vlan': '(config-vlan)',
  'config-vrf': '(config-vrf)',
  'config-vrf-af': '(config-vrf-af-ipv4)',
  'config-router-bgp': '(config-router)',
  'config-router-af': '(config-router-af)',
  'config-router-neighbor': '(config-router-neighbor)',
  'config-router-neighbor-af': '(config-router-neighbor-af)',
  'config-router-vrf': '(config-router-vrf)',
  'config-router-ospf': '(config-router)',
  'config-acl': '(config-acl)',
  'config-route-map': '(config-route-map)'
}

/** `--More--` at column 0, erased with CR/spaces/CR; Space page, Enter line, q/Q/Ctrl-C quit. */
export const NXOS_PAGER: PagerSpec = {
  text: () => '--More--',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'ignore'
}

const PIPES = ['begin', 'count', 'egrep', 'end', 'exclude', 'grep', 'head', 'include', 'json', 'json-pretty', 'last', 'no-more', 'section', 'sort', 'uniq', 'wc']

interface ConfigSessionState {
  name: string
  owner: string
  created: number
  copy: Device
  lines: string[]
}

/** Config sessions hold a whole device copy; kept off the Device so snapshots stay plain data. */
const SESSIONS = new WeakMap<Device, Map<string, ConfigSessionState>>()
const sessionsOf = (d: Device): Map<string, ConfigSessionState> => {
  let m = SESSIONS.get(d)
  if (!m) SESSIONS.set(d, (m = new Map()))
  return m
}

type NbrCtx = { ip: string; vrf?: string }

export class NxosPersonality extends CiscoBase {
  pager = NXOS_PAGER
  private cache = new Map<string, Record<string, Node[]>>()
  /** routing-context vrf. */
  private rc: string | undefined
  /** Active configuration session. */
  private sess: ConfigSessionState | undefined

  constructor(s: Session) {
    super(s)
  }

  /** The device config commands edit: the session copy inside `configure session`. */
  private get c(): Device {
    return this.sess?.copy ?? this.d
  }

  override hostPart(): string {
    return this.rc ? `${this.d.hostname}%${this.rc}` : this.d.hostname
  }

  protected suffix(m: CMode): string {
    const s = SUFFIX[m.id] ?? ''
    return this.sess && s ? s.replace('(config', '(config-s') : s
  }

  // ------------------------------------------------------------------ errors and help

  /** NX-OS puts the caret under the start of the failing token. */
  private tokenStart(line: string, offset: number): number {
    const offs = tokenOffsets(line)
    let at = offset
    for (const o of offs) if (o <= offset) at = o
    return at
  }
  protected errInvalid(line: string, f: Failure): string {
    return `${this.caret(this.tokenStart(line, f.offset))}\n% Invalid command at '^' marker.`
  }
  // Best guess (doc §3): NX-OS uses one "at '^' marker" family for all three errors.
  protected errAmbiguous(line: string, f: Failure): string {
    return `${this.caret(this.tokenStart(line, f.offset))}\n% Ambiguous command at '^' marker.`
  }
  protected errIncomplete(_line: string, f: Failure): string {
    return `${this.caret(f.offset)}\n% Incomplete command at '^' marker.`
  }
  protected helpPartial(words: string[]): string {
    if (!words.length) return ''
    return words.map((w) => w.padEnd(Math.ceil((w.length + 1) / 8) * 8)).join('')
  }
  protected helpList(h: Extract<HelpResult, { ok: true }>): string {
    const width = Math.max(14, ...h.entries.map((e) => e.label.length)) + 2
    const lines = h.entries.map((e) => `  ${e.label.padEnd(width)}${e.help}`.trimEnd())
    if (h.cr) {
      lines.push('  <CR>')
      if (!this.inConfig()) lines.push(`  ${'>'.padEnd(width)}Redirect it to a file`, `  ${'|'.padEnd(width)}Pipe command output to filter`)
    }
    return lines.join('\n')
  }
  protected override pipeHelp(): string {
    const help: Record<string, string> = {
      begin: 'Begin with the line that matches',
      count: 'Count number of lines',
      egrep: 'Egrep - print lines matching a pattern',
      end: 'End with the line that matches',
      exclude: 'Exclude lines that match',
      grep: 'Grep - print lines matching a pattern',
      head: 'Display first lines',
      include: 'Include lines that match',
      json: 'Output in json format',
      'json-pretty': 'Output in json format (pretty print)',
      last: 'Display last lines',
      'no-more': 'Turn-off pagination for command output',
      section: 'Show lines that include the pattern as well as the subsequent lines that are more indented than matching line',
      sort: 'Stream Sorter',
      uniq: 'Discard all but one of successive identical lines',
      wc: 'Count words, lines, characters'
    }
    return PIPES.map((p) => `  ${p.padEnd(13)}${help[p]}`).join('\n')
  }

  protected override tabAmbiguous(line: string, options: string[]): TabResult {
    if (options.length < 2) return { bell: true }
    const w = Math.max(...options.map((o) => o.length)) + 2
    const per = Math.max(1, Math.floor(80 / w))
    const rows: string[] = []
    for (let k = 0; k < options.length; k += per) rows.push(options.slice(k, k + per).map((o) => o.padEnd(w)).join('').trimEnd())
    return { list: rows.join('\n'), line }
  }

  override control(key: 'c' | 'z', line: string): ControlResult {
    // Ctrl-C clears the line and stays in the mode (doc §4); Ctrl-Z runs the line, then leaves config.
    if (key === 'c') return { echo: '^C\n' }
    if (!this.inConfig()) return { echo: '\n' }
    if (line.trim()) return { echo: '\n', execute: line, then: () => this.endConfig() }
    return { echo: '\n', then: () => this.endConfig() }
  }

  // ------------------------------------------------------------------ execute

  /** Exec commands (show, ping ...) run from any config mode without `do`. */
  protected override resolve(base: string): { m: MatchResult; mode?: string; offset: number } {
    const r = super.resolve(base)
    if (r.m.ok || !this.inConfig() || r.m.kind === 'ambiguous') return r
    const e = match(base, this.execTree())
    return e.ok ? { m: e, offset: 0 } : r
  }

  override async execute(raw: string): Promise<void> {
    const parts = splitChain(raw)
    if (parts.length > 1) {
      for (const p of parts) if (p.trim()) await this.execute(p)
      return
    }
    if (this.sess && this.inConfig()) {
      const [base] = splitPipes(raw)
      const r = this.resolve(base)
      if (r.m.ok && this.isConfigNode(base)) this.sess.lines.push(raw.trim())
    }
    await super.execute(raw)
  }

  private isConfigNode(base: string): boolean {
    const first = base.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    return !['show', 'sh', 'commit', 'abort', 'verify', 'end', 'exit', 'do', 'where'].some((w) => w.startsWith(first) && first.length > 0 && (w === first || first.length >= 2))
  }

  /** Record a config change on the device being edited. */
  private touch(): void {
    store(this.c).lastChange = now(this.d)
    tickBgp(this.c, now(this.d))
  }
  private changed = (v = ''): string => {
    this.touch()
    return v
  }

  override endConfig(): void {
    if (this.inConfig() && !this.sess) logEvent(this.d, `%VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by ${this.s.user} on ${this.s.from}@pts/0`)
    this.sess = undefined
    super.endConfig()
  }

  override exitMode(): boolean {
    const wasSess = !!this.sess
    const left = super.exitMode()
    if (left) {
      if (!wasSess) logEvent(this.d, `%VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by ${this.s.user} on ${this.s.from}@pts/0`)
      this.sess = undefined
    }
    return left
  }

  // ------------------------------------------------------------------ pipes

  protected pipes(out: string, pipes: string[], raw: string): PipeOutcome | { error: string } {
    let lines = out.replace(/\n$/, '').split('\n')
    let noMore = false
    let pos = raw.indexOf('|')
    for (const p of pipes) {
      const at = raw.indexOf(p, pos)
      pos = at + p.length
      const [word = '', ...rest] = p.trim().split(/\s+/)
      const w = word.toLowerCase()
      const hits = PIPES.includes(w) ? [w] : PIPES.filter((n) => n.startsWith(w))
      const wordAt = raw.indexOf(word, at)
      if (!w || hits.length !== 1) return { error: `${this.caret(wordAt)}\n% ${hits.length > 1 ? 'Ambiguous' : 'Invalid'} command at '^' marker.` }
      const arg = unquote(rest.join(' '))
      const needs = ['begin', 'egrep', 'end', 'exclude', 'grep', 'include', 'section'].includes(hits[0]!)
      if (needs && !arg) return { error: `${this.caret(wordAt + word.length + 1)}\n% Incomplete command at '^' marker.` }
      const flags = hits[0] === 'grep' || hits[0] === 'egrep' ? rest.filter((x) => /^-[a-z]+$/.test(x)).join('') : ''
      const pat = hits[0] === 'grep' || hits[0] === 'egrep' ? unquote(rest.filter((x) => !/^-[a-z]+$/.test(x)).join(' ')) : arg
      const re = needs ? safeRegex(pat, flags.includes('i') ? 'i' : '') : null
      if (needs && !re) return { error: `${this.caret(wordAt + word.length + 1)}\n% Invalid command at '^' marker.` }
      const num = (def: number): number => {
        const m = /(\d+)/.exec(rest.join(' '))
        return m ? Number(m[1]) : def
      }
      switch (hits[0]) {
        case 'include':
          lines = lines.filter((l) => re!.test(l))
          break
        case 'exclude':
          lines = lines.filter((l) => !re!.test(l))
          break
        case 'grep':
        case 'egrep':
          lines = lines.filter((l) => re!.test(l) !== flags.includes('v'))
          if (flags.includes('c')) lines = [String(lines.length)]
          break
        case 'begin': {
          const i = lines.findIndex((l) => re!.test(l))
          lines = i < 0 ? [] : lines.slice(i)
          break
        }
        case 'end': {
          const i = lines.findIndex((l) => re!.test(l))
          lines = i < 0 ? lines : lines.slice(0, i + 1)
          break
        }
        case 'section':
          lines = section(lines, re!)
          break
        case 'count':
          lines = [String(lines.filter((l) => l !== '' || lines.length > 1).length)]
          break
        case 'last':
          lines = lines.slice(-num(10))
          break
        case 'head':
          lines = lines.slice(0, num(10))
          break
        case 'sort':
          lines = [...lines].sort()
          break
        case 'uniq':
          lines = lines.filter((l, k) => k === 0 || l !== lines[k - 1])
          break
        case 'wc': {
          const text = lines.join('\n') + '\n'
          lines = rest.includes('-l') || rest.includes('lines') ? [String(lines.length)] : [`${lpad(lines.length, 7)}${lpad(text.split(/\s+/).filter(Boolean).length, 8)}${lpad(text.length, 8)}`]
          break
        }
        case 'no-more':
          noMore = true
          break
        case 'json':
        case 'json-pretty': {
          const obj = this.json(raw)
          if (!obj) return { error: `${this.caret(wordAt)}\n% Invalid command at '^' marker.` }
          lines = (hits[0] === 'json' ? JSON.stringify(obj) : JSON.stringify(obj, null, 4)).split('\n')
          break
        }
      }
    }
    return { out: lines.join('\n'), noMore }
  }

  /** Minimal NX-API-shaped JSON (TABLE_x / ROW_x; a single row is an object). */
  private json(raw: string): Record<string, unknown> | undefined {
    const [base] = splitPipes(raw)
    const r = this.resolve(base)
    if (!r.m.ok) return undefined
    const words = r.m.ctx.words.join(' ').replace(/^sh /, 'show ')
    const d = this.d
    const t = now(d)
    const rows = <T>(a: T[]): T | T[] => (a.length === 1 ? a[0]! : a)
    if (words === 'show version') return R.versionJson(d)
    if (words === 'show interface brief')
      return { TABLE_interface: { ROW_interface: rows([...d.interfaces].sort(R.ifCompare).map((i) => ({ interface: i.name, state: R.operUp(d, i) ? 'up' : 'down', admin_state: i.adminUp ? 'up' : 'down', ...(i.mode !== 'routed' ? { vlan: String(i.vlan ?? i.nativeVlan ?? 1) } : {}), type: 'eth', portmode: i.mode, ...(i.ip ? { ip_addr: i.ip } : {}), speed: i.speed, ...(i.description ? { desc: i.description } : {}) }))) } }
    if (/^show ip interface brief/.test(words)) {
      const vrf = r.m.ctx.args['vrf'] ?? this.rc ?? 'default'
      const ifs = d.interfaces.filter((i) => i.ip && (vrf === 'all' || (i.vrf ?? 'default') === vrf)).sort(R.ifCompare)
      return { TABLE_intf: { ROW_intf: rows(ifs.map((i) => ({ 'vrf-name-out': i.vrf ?? 'default', 'intf-name': i.short, 'proto-state': R.operUp(d, i) ? 'up' : 'down', 'link-state': i.linkUp && i.adminUp ? 'up' : 'down', 'admin-state': i.adminUp ? 'up' : 'down', prefix: i.ip, 'ip-disabled': 'FALSE' }))) } }
    }
    if (/^show vlan/.test(words)) return { TABLE_vlanbriefxbrief: { ROW_vlanbriefxbrief: rows(d.vlans.map((v) => ({ 'vlanshowbr-vlanid': v.id, 'vlanshowbr-vlanid-utf': v.id, 'vlanshowbr-vlanname': v.name, 'vlanshowbr-vlanstate': v.shutdown ? 'suspend' : 'active', 'vlanshowbr-shutstate': v.shutdown ? 'shutdown' : 'noshutdown', 'vlanshowplist-ifidx': R.vlanPorts(d, v.id).join(',') }))) } }
    if (/^show (ip bgp|bgp ipv4 unicast|bgp all) summary/.test(words)) {
      const vrf = r.m.ctx.args['vrf'] ?? this.rc ?? 'default'
      const peers = d.bgp.filter((n) => (n.vrf ?? 'default') === vrf)
      return {
        TABLE_vrf: {
          ROW_vrf: {
            'vrf-name-out': vrf,
            'vrf-router-id': d.routerId,
            'vrf-local-as': d.localAs,
            TABLE_af: { ROW_af: { 'af-id': 1, TABLE_saf: { ROW_saf: { 'safi': 1, 'af-name': 'IPv4 Unicast', TABLE_neighbor: { ROW_neighbor: rows(peers.map((n) => ({ neighborid: n.ip, neighborversion: 4, msgrecvd: n.msgRcvd ?? 0, msgsent: n.msgSent ?? 0, inq: 0, outq: 0, neighboras: n.remoteAs, time: n.upSince !== undefined && n.upSince <= t ? uptime(n.upSince, t) : n.downSince !== undefined ? uptime(n.downSince, t) : 'never', state: n.upSince !== undefined && n.upSince <= t ? 'Established' : R.bgpSummaryLines(d, vrf).find((l) => l.startsWith(n.ip))?.trim().split(/\s+/).at(-1) ?? 'Idle', prefixreceived: n.upSince !== undefined && n.upSince <= t ? n.prefixes : 0 }))) } } } } }
          }
        }
      }
    }
    if (/^show ip route/.test(words)) {
      const vrf = r.m.ctx.args['vrf'] ?? this.rc ?? 'default'
      return { TABLE_vrf: { ROW_vrf: { 'vrf-name-out': vrf, TABLE_addrf: { ROW_addrf: { addrf: 'ipv4', TABLE_prefix: { ROW_prefix: rows(R.routes(d, vrf).map((x) => ({ ipprefix: `${x.prefix}/${x.mask}`, 'ucast-nhops': x.vias.length, 'mcast-nhops': 0, attached: x.attached ? 'true' : 'false', TABLE_path: { ROW_path: rows(x.vias.map((v) => ({ ipnexthop: /via ([\d.]+)/.exec(v)?.[1], ifname: /via [\d.]+, ([A-Za-z][\w/.-]*),/.exec(v)?.[1], uptime: /, (\d[\w:]*), /.exec(v)?.[1], clientname: v.split(', ').at(-1)?.split(',')[0], ubest: 'true' }))) } }))) } } } } } }
    }
    if (/^show ip ospf neighbors/.test(words) && d.ospf) {
      const nb = d.ospf.neighbors.filter((n) => R.operUp(d, d.interfaces.find((i) => i.name === n.iface)!) && d.ospf!.ifaces.some((o) => o.iface === n.iface))
      return { TABLE_ctx: { ROW_ctx: { ptag: d.ospf.process, cname: 'default', nbrcount: nb.length, TABLE_nbr: { ROW_nbr: rows(nb.map((n) => ({ rid: n.routerId, priority: n.pri, state: R.showOspfNeighbors(d).includes(`${n.ip} `) && /EXSTART/.test(R.showOspfNeighbors(d).split('\n').find((l) => l.includes(` ${n.ip} `)) ?? '') ? 'EXSTART' : 'FULL', drstate: n.role ?? '-', addr: n.ip, intf: d.interfaces.find((i) => i.name === n.iface)?.short ?? n.iface }))) } } } }
    }
    if (words === 'show cdp neighbors') return { TABLE_cdp_neighbor_brief_info: { ROW_cdp_neighbor_brief_info: rows(R.cdpNeighbors(d).map((n, k) => ({ ifindex: 83886080 + k, device_id: n.device, intf_id: d.interfaces.find((i) => i.short === n.local)?.name ?? n.local, ttl: n.holdtime, capability: n.caps.split(' ').map((c) => ({ R: 'router', S: 'switch', I: 'IGMP_cnd_filtering', s: 'Supports-STP-Dispute' })[c] ?? c), platform_id: n.platform, port_id: n.port }))) } }
    if (words === 'show lldp neighbors') return { TABLE_nbor: { ROW_nbor: rows(R.lldpNeighbors(d).map((n) => ({ chassis_id: n.device, l_port_id: n.local, hold_time: n.holdtime ?? 120, system_capability: n.caps ?? 'B', enabled_capability: n.caps ?? 'B', port_id: n.port }))) } }
    if (words === 'show feature') return { TABLE_cfcFeatureCtrlTable: { ROW_cfcFeatureCtrlTable: rows(R.KNOWN_FEATURES.map((f) => ({ cfcFeatureCtrlName2: f, cfcFeatureCtrlIndex2: 1, cfcFeatureCtrlOpStatus2: R.feature(d, f) || f === 'ssh' ? 'enabled' : 'disabled' }))) } }
    if (words === 'show vrf') return { TABLE_vrf: { ROW_vrf: rows(R.vrfNames(d).map((v, k) => ({ vrf_name: v, vrf_id: k + 1, vrf_state: 'Up', vrf_reason: '--' }))) } }
    if (words === 'show hostname') return { hostname: d.hostname }
    return undefined
  }

  // ------------------------------------------------------------------ trees

  protected tree(modeId: string): Node[] {
    const fs = (x: Device): string => R.KNOWN_FEATURES.filter((f) => R.feature(x, f)).join(',')
    const sig = `${fs(this.d)}|${fs(this.c)}|${this.sess ? 's' : ''}`
    let t = this.cache.get(sig)
    if (!t) this.cache.set(sig, (t = this.build()))
    return t[modeId] ?? t['config']!
  }

  private ifParam(exists = true): Param {
    return {
      kind: 'iface',
      label: '<interface>',
      values: () => this.c.interfaces.map((i) => i.name),
      test: (tok) => (exists ? !!findIface(this.c, tok, R.NXOS_TYPES) : (() => { const r = parseIfName(tok, R.NXOS_TYPES); return !!r && r !== 'ambiguous' })())
    }
  }
  private ifOf(c: Ctx, key = 'if', d = this.d): Iface | undefined {
    return findIface(d, c.args[key] ?? '', R.NXOS_TYPES)
  }

  private build(): Record<string, Node[]> {
    return { exec: this.execNodes(), ...this.configTrees() }
  }

  // ---------------------------------------------------------------- exec

  private execNodes(): Node[] {
    const d = this.d
    const exec: Node[] = []
    const has = (f: string): boolean => R.feature(d, f)
    const ip = (label = 'A.B.C.D'): Param => ({ kind: 'ipv4', label })
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const vrfP: Param = { kind: 'word', label: 'WORD', values: () => [...R.vrfNames(d), 'all'], test: (t) => t === 'all' || R.vrfNames(d).includes(t) }
    const HELP: Record<string, string> = {
      show: 'Show running system information',
      'show ip': 'Display IP information',
      'show ip bgp': 'Display BGP information',
      'show ip interface': 'Display IP interface status and configuration',
      'show ip ospf': 'Display OSPF information',
      'show bgp': 'Display BGP information',
      'show bgp ipv4': 'IPv4 address family',
      'show bgp ipv4 unicast': 'Unicast sub-address family',
      'show bgp all': 'All address families',
      'show interface': 'Display interface information',
      'show mac': 'MAC configuration commands',
      'show mac address-table': 'Display MAC Address Table',
      'show logging': 'Show logging configuration and contents of logfile',
      'show processes': 'Show process information',
      'show processes cpu': 'Show CPU utilization per process',
      'show system': 'Show system information',
      'show cdp': 'Display CDP information',
      'show lldp': 'Display LLDP information',
      'show port-channel': 'Port-channel information',
      'show checkpoint': 'Show checkpoint information',
      'show configuration': 'Show configuration',
      'show configuration session': 'Show configuration session',
      'show diff': 'Show diff information',
      'show diff rollback-patch': 'Show diff of rollback patch'
    }
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(exec, `show ${path}`, help, run, extra, HELP)
    add(exec, 'show', 'Show running system information')
    const vrfOf = (c: Ctx): string => c.args['vrf'] ?? this.rc ?? 'default'
    const vrfKw = (run: Node['run']): Node => kw('vrf', 'Display per-VRF information', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run })] })

    S('version', 'Show the software & hardware version', () => R.showVersion(d))
    S('clock', 'Display current date', () => R.showClock(d))
    S('hostname', 'Display hostname', () => d.hostname)
    S('feature', 'Show feature status', () => R.showFeature(d))
    S('users', 'Show the current users logged in the system', () => `NAME     LINE         TIME         IDLE          PID COMMENT\n${this.s.user.padEnd(9)}pts/0        ${new Date(now(d)).toISOString().slice(0, 16).replace('T', ' ')}   .         12345 (${this.s.from}) session=ssh *`)
    S('terminal', 'Display terminal configuration', () => `TTY: /dev/pts/0 Type: "xterm"\nLength: ${this.s.pageLength} lines, Width: 80 columns\nSession Timeout: 0 minutes\nEvent Manager CLI event bypass: no`)
    S('cli history', 'Display CLI history', () => '')
    S('module', 'Show module information', () => `Mod Ports             Module-Type                         Model           Status\n--- ----- ------------------------------------- --------------------- ---------\n1    54   48x10/25G + 6x40/100G Ethernet Module   ${d.model.padEnd(22)}active *`)
    S('inventory', 'Show physical inventory', () => `NAME: "Chassis",  DESCR: "Nexus9000 ${d.model.replace(/^N9K-/, '')} Chassis"\nPID: ${d.model.padEnd(17)},  VID: V02  ,  SN: ${d.serial}`)

    // interfaces
    const ifShow = prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.showInterface(d, this.ifOf(c)!) })
    S('interface', 'Display interface information', () => [...d.interfaces].sort(R.ifCompare).map((i) => R.showInterface(d, i)).join('\n\n'), { children: [ifShow] })
    S('interface brief', 'Show brief info of interface', () => R.showInterfaceBrief(d))
    S('interface status', 'Display interface line status', () => R.showInterfaceStatus(d))
    S('interface description', 'Show interface description', () => R.showInterfaceDescription(d))
    S('interface trunk', 'Show trunk information', () => R.showInterfaceTrunk(d))
    S('interface counters', 'Show interface counters', () => R.showInterfaceCountersErrors(d))
    S('interface counters errors', 'Show interface error counters', () => R.showInterfaceCountersErrors(d))
    S('ip interface brief', 'Display brief summary of IP interface status and configuration', (c) => R.showIpIntBrief(d, vrfOf(c)), { children: [vrfKw((c) => R.showIpIntBrief(d, vrfOf(c)))] })
    S('vrf', 'Display VRF information', () => R.showVrf(d))
    S('vlan', 'Vlan commands', () => R.showVlan(d, false))
    S('vlan brief', 'Show VLAN in brief', () => R.showVlan(d, true))
    S('vlan id', 'Show VLAN information by VLAN ID', undefined, { children: [prm(int(1, 4094), 'VLAN ID', { name: 'id', run: (c) => (d.vlans.some((v) => v.id === Number(c.args['id'])) ? R.showVlan({ ...d, vlans: d.vlans.filter((v) => v.id === Number(c.args['id'])) }, true) : `ERROR: Vlan ${c.args['id']} not found`) })] })
    S('port-channel summary', 'Show port-channel summary information', () => R.showPortChannelSummary(d))
    S('spanning-tree', 'Show spanning tree information', () => R.showSpanningTree(d), { children: [kw('vlan', 'VLAN information', { children: [prm(int(1, 4094), 'VLAN ID', { name: 'vlan', run: (c) => R.showSpanningTree(d, Number(c.args['vlan'])) })] })] })
    S('mac address-table', 'Display MAC Address Table', () => R.showMacTable(d), {
      children: [
        kw('address', 'Address', { children: [prm({ kind: 'mac', label: 'E.E.E' }, 'MAC address', { name: 'mac', run: (c) => R.showMacTable(d, { kind: 'address', value: c.args['mac'] }) })] }),
        kw('interface', 'Interface', { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.showMacTable(d, { kind: 'interface', value: this.ifOf(c)!.short }) })] }),
        kw('vlan', 'VLAN', { children: [prm(int(1, 4094), 'VLAN ID', { name: 'vlan', run: (c) => R.showMacTable(d, { kind: 'vlan', value: c.args['vlan'] }) })] }),
        kw('dynamic', 'Dynamic entries', { run: () => R.showMacTable(d, { kind: 'dynamic' }) })
      ]
    })
    S('ip arp', 'Display ARP information', (c) => R.showIpArp(d, vrfOf(c)), { children: [vrfKw((c) => R.showIpArp(d, vrfOf(c)))] })
    S('ip adjacency', 'Display adjacency information', () => R.showIpAdjacency(d))
    const routeTail = (): Node[] => [
      prm({ kind: 'word', label: 'A.B.C.D[/LEN]', test: (t) => isIpv4(t.split('/')[0]!) }, 'IP prefix', { name: 'target', run: (c) => R.showIpRoute(d, vrfOf(c), c.args['target']) }),
      kw('summary', 'Show route counts', { run: (c) => R.showIpRouteSummary(d, vrfOf(c)) })
    ]
    S('ip route', 'Show route table', (c) => R.showIpRoute(d, vrfOf(c)), { children: [kw('vrf', 'Display per-VRF information', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showIpRoute(d, vrfOf(c)), children: routeTail() })] }), ...routeTail()] })
    const aclP: Param = { kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }
    S('ip access-lists', 'List IP access lists', () => R.showAccessLists(d), { children: [prm(aclP, 'List name', { name: 'acl', run: (c) => R.showAccessLists(d, c.args['acl']) })] })
    S('access-lists', 'List access lists', () => R.showAccessLists(d), { children: [prm(aclP, 'List name', { name: 'acl', run: (c) => R.showAccessLists(d, c.args['acl']) })] })
    S('ip prefix-list', 'Display prefix-list information', () => R.showPrefixList(d), { children: [prm({ kind: 'word', label: 'WORD', values: () => d.prefixLists.map((p) => p.name) }, 'Prefix-list name', { name: 'pl', run: (c) => R.showPrefixList(d, c.args['pl']) })] })
    S('route-map', 'Show route-map', () => R.showRouteMap(d), { children: [prm({ kind: 'word', label: 'WORD', values: () => d.routeMaps.map((r) => r.name) }, 'Route-map name', { name: 'rm', run: (c) => R.showRouteMap(d, c.args['rm']) })] })
    if (has('bgp')) {
      const sum = (c: Ctx): string => R.showBgpSummary(d, vrfOf(c))
      const sumNode = (): Partial<Node> => ({ children: [vrfKw(sum)] })
      S('bgp ipv4 unicast summary', 'Summary of BGP neighbor status', sum, sumNode())
      S('bgp all summary', 'Summary of BGP neighbor status', sum, sumNode())
      S('ip bgp summary', 'Summary of BGP neighbor status', sum, sumNode())
      const nbrSub = (n: 'advertised-routes' | 'received-routes' | 'routes'): Node => kw(n, n === 'advertised-routes' ? 'Display routes advertised to neighbor' : n === 'received-routes' ? 'Display routes received from neighbor' : 'Display routes learned from neighbor', { run: (c) => R.showIpBgp(d, c.args['nb'], n) })
      const nbrs = (): Partial<Node> => ({ children: [prm({ ...ip(), values: () => d.bgp.map((n) => n.ip) }, 'Neighbor address', { name: 'nb', run: (c) => R.showBgpNeighbors(d, c.args['nb']), children: [nbrSub('advertised-routes'), nbrSub('received-routes'), nbrSub('routes')] })] })
      S('ip bgp neighbors', 'Show BGP neighbors', () => R.showBgpNeighbors(d), nbrs())
      S('bgp ipv4 unicast neighbors', 'Show BGP neighbors', () => R.showBgpNeighbors(d), nbrs())
      S('ip bgp', 'Display BGP information', () => R.showIpBgp(d))
      S('bgp ipv4 unicast', 'Unicast sub-address family', () => R.showIpBgp(d))
    }
    if (has('ospf')) {
      S('ip ospf', 'Display OSPF information', () => R.showOspf(d))
      S('ip ospf neighbors', 'Neighbor information', () => R.showOspfNeighbors(d), { children: [vrfKw(() => R.showOspfNeighbors(d))] })
      S('ip ospf interface brief', 'Brief summary of interfaces', () => R.showOspfIntBrief(d))
    }
    S('cdp neighbors', 'Show CDP neighbors', () => R.showCdp(d, false))
    S('cdp neighbors detail', 'Show detailed information', () => R.showCdp(d, true))
    if (has('lldp')) {
      S('lldp neighbors', 'Show LLDP neighbors', () => R.showLldp(d, false))
      S('lldp neighbors detail', 'Show detailed information', () => R.showLldp(d, true))
    }
    S('logging', 'Show logging configuration and contents of logfile', () => R.showLogging(d))
    S('logging logfile', 'Show contents of logfile', () => R.showLogging(d))
    S('logging last', 'Show last few lines of logfile', undefined, { children: [prm(int(1, 9999), 'Enter number of lines to display', { name: 'n', run: (c) => R.showLogging(d, Number(c.args['n'])) })] })
    S('processes cpu', 'Show CPU utilization per process', () => R.showProcessesCpu(d, false))
    S('processes cpu sort', 'Sort the output', () => R.showProcessesCpu(d, true))
    S('system resources', 'Display system-related resources', () => R.showSystemResources(d))
    const cfgSub = (): Node[] => [
      ...(has('bgp') ? [kw('bgp', 'Show running bgp configuration', { run: () => runningSection(d, 'bgp') })] : []),
      ...(has('ospf') ? [kw('ospf', 'Show running ospf configuration', { run: () => runningSection(d, 'ospf') })] : []),
      kw('interface', 'Show running interface configuration', { run: () => runningSection(d, 'interface'), children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => runningSection(d, 'interface', this.ifOf(c)!.name) })] }),
      kw('vrf', 'Show running vrf configuration', { children: [prm({ kind: 'word', label: 'WORD', values: () => d.vrfs.map((v) => v.name) }, 'VRF name', { name: 'v', run: (c) => runningSection(d, 'vrf', c.args['v']) })] }),
      kw('diff', 'Show the difference between running and startup configuration', { run: () => this.runDiff() }),
      kw('all', 'Show running config with defaults', { run: () => runningConfig(d) })
    ]
    S('running-config', 'Current operating configuration', () => runningConfig(d), { children: cfgSub() })
    S('startup-config', 'Contents of startup configuration', () => startupConfig(d))
    S('checkpoint summary', 'Show checkpoint summary', () => this.checkpointSummary())
    S('checkpoint', 'Show checkpoint information', undefined, { children: [prm({ kind: 'word', label: 'WORD', values: () => store(d).checkpoints.map((c) => c.name), test: (t) => store(d).checkpoints.some((c) => c.name === t) }, 'Checkpoint name', { name: 'cp', run: (c) => this.showCheckpoint(c.args['cp']!) })] })
    const cpP: Param = { kind: 'word', label: 'WORD', values: () => store(d).checkpoints.map((c) => c.name) }
    S('diff rollback-patch checkpoint', 'Checkpoint name', undefined, { children: [prm(cpP, 'Source checkpoint', { name: 'a', children: [kw('running-config', 'Running configuration', { run: (c) => this.patch(c.args['a']!, 'running-config') }), kw('checkpoint', 'Destination checkpoint', { children: [prm(cpP, 'Destination checkpoint', { name: 'b', run: (c) => this.patch(c.args['a']!, c.args['b']!) })] })] })] })
    S('diff rollback-patch running-config checkpoint', 'Checkpoint name', undefined, { children: [prm(cpP, 'Destination checkpoint', { name: 'b', run: (c) => this.patch('running-config', c.args['b']!) })] })
    S('configuration session', 'Show configuration session', () => this.sessionList(), {
      children: [kw('summary', 'Show summary of sessions', { run: () => this.sessionSummary() }), kw('status', 'Show status of sessions', { run: () => this.sessionList() }), prm({ kind: 'word', label: 'WORD', values: () => [...sessionsOf(d).keys()] }, 'Session name', { name: 'sn', run: (c) => this.sessionList(c.args['sn']) })]
    })
    // `sh` is a real NX-OS keyword alias (doc §3: `sh?` lists `sh` and `show`).
    exec.push(kw('sh', 'Show running system information', { children: exec.find((n) => n.word === 'show')!.children }))

    // ---- config entry
    const conf = kw('configure', 'Enter configuration mode', {
      run: () => this.enterConfig(),
      children: [
        kw('terminal', 'Configure the system from terminal input', { run: () => this.enterConfig() }),
        kw('session', 'Configure the system in a session', { children: [prm(word(), 'Name of session', { name: 'sn', run: (c) => this.enterSession(c.args['sn']!) })] })
      ]
    })
    exec.push(conf)
    add(exec, 'copy running-config startup-config', 'Copy from source to destination', () => this.save(), {}, { copy: 'Copy from source to destination', 'copy running-config': 'Copy running configuration to destination' })
    add(exec, 'copy running-config bootflash:', 'Select destination filesystem', undefined, { children: [prm(word(), 'File name', { run: () => 'Copy complete.' })] })
    add(exec, 'write erase', 'Erase a filesystem', () => this.writeErase(), { children: [kw('boot', 'Erase only boot variables', { run: () => this.writeErase() }), kw('debug', 'Erase debug configuration', { run: () => this.writeErase() })] }, { write: 'Write current configuration' })
    add(exec, 'reload', 'Reboot the entire box', () => this.reload())
    add(exec, 'checkpoint', 'Create configuration rollback checkpoint', (c) => this.checkpoint(undefined, c.args['desc']), {
      children: [
        kw('description', 'Checkpoint description', { children: [prm(line, 'Description', { name: 'desc', run: (c) => this.checkpoint(undefined, c.args['desc']) })] }),
        prm({ kind: 'word', label: 'WORD', test: (t) => t !== 'description' && t !== 'file' }, 'Checkpoint name', { name: 'cp', run: (c) => this.checkpoint(c.args['cp'], undefined), children: [kw('description', 'Checkpoint description', { children: [prm(line, 'Description', { name: 'desc', run: (c) => this.checkpoint(c.args['cp'], c.args['desc']) })] })] })
      ]
    })
    add(exec, 'no checkpoint', 'Delete a checkpoint', undefined, { children: [prm(cpP, 'Checkpoint name', { name: 'cp', run: (c) => this.deleteCheckpoint(c.args['cp']!) })] }, { no: 'Negate a command or set its defaults' })
    add(exec, 'clear checkpoint database', 'Clear checkpoint database', () => ((store(d).checkpoints = []), ''), {}, { clear: 'Reset functions', 'clear checkpoint': 'Clear checkpoint information' })
    const rbMode = (): Node[] => ['atomic', 'best-effort', 'stop-at-first-failure'].map((m) => kw(m, `Rollback ${m}`, { run: (c) => this.rollback(c.args['cp']!) }))
    add(exec, 'rollback running-config checkpoint', 'Rollback to a checkpoint', undefined, { children: [prm(cpP, 'Checkpoint name', { name: 'cp', run: (c) => this.rollback(c.args['cp']!), children: rbMode() })] }, { rollback: 'Rollback configuration', 'rollback running-config': 'Rollback running configuration' })
    add(exec, 'routing-context vrf', 'Set VRF routing context', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => R.vrfNames(d) }, 'VRF name', {
          name: 'vrf',
          run: (c) => {
            const v = c.args['vrf']!
            if (!R.vrfNames(d).includes(v)) return `% VRF ${v} not found`
            this.rc = v === 'default' ? undefined : v
            return ''
          }
        })
      ]
    }, { 'routing-context': 'Set routing context' })
    add(exec, 'terminal length', 'Set number of lines on a screen', undefined, { children: [prm(int(0, 511), 'Number of lines on screen (0 for no pausing)', { name: 'n', run: (c) => ((this.s.pageLength = Number(c.args['n'])), '') })] }, { terminal: 'Set terminal line parameters' })
    add(exec, 'terminal width', 'Set width of the display terminal', undefined, { children: [prm(int(24, 511), 'Number of columns on screen', { run: () => '' })] })
    add(exec, 'terminal session-timeout', 'Set session timeout', undefined, { children: [prm(int(0, 525600), 'Timeout in minutes', { run: () => '' })] })
    add(exec, 'clear counters', 'Clear interface counters', () => this.clearCounters(), { children: [kw('interface', 'Clear interface counters', { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => this.clearCounters(this.ifOf(c)) })] })] })
    add(exec, 'clear logging logfile', 'Clear logfile', () => ((d.log = []), ''), {}, { 'clear logging': 'Clear logging information' })
    if (has('bgp')) {
      const clr = (): string => {
        for (const n of d.bgp) if (n.upSince !== undefined && n.upSince <= now(d)) n.upSince = now(d) + 4000
        return ''
      }
      add(exec, 'clear ip bgp *', 'Clear all peers', clr, {}, { 'clear ip': 'Clear IP information', 'clear ip bgp': 'Clear BGP information' })
      add(exec, 'clear bgp all *', 'Clear all peers', clr, {}, { 'clear bgp': 'Clear BGP information' })
      add(exec, 'clear bgp ipv4 unicast *', 'Clear all peers', clr)
    }
    const pingNode = (trace: boolean): Node[] => [
      prm({ kind: 'word', label: 'A.B.C.D', test: (t) => !['vrf', 'count', 'source'].includes(t) }, trace ? 'Destination' : 'IP address or hostname', {
        name: 'dst',
        run: (c) => (trace ? this.trace(c.args['dst']!, c.args['vrf'] ?? this.rc) : this.ping(c.args['dst']!, Number(c.args['count'] ?? 5), c.args['vrf'] ?? this.rc)),
        children: [
          kw('vrf', 'Display per-VRF information', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => (trace ? this.trace(c.args['dst']!, c.args['vrf']) : this.ping(c.args['dst']!, Number(c.args['count'] ?? 5), c.args['vrf'])), children: trace ? [] : [kw('count', 'Number of pings to send', { children: [prm(int(1, 655350), 'Count', { name: 'count', run: (c) => this.ping(c.args['dst']!, Number(c.args['count']), c.args['vrf']) })] })] })] }),
          ...(trace ? [] : [kw('count', 'Number of pings to send', { children: [prm(int(1, 655350), 'Count', { name: 'count', run: (c) => this.ping(c.args['dst']!, Number(c.args['count']), c.args['vrf'] ?? this.rc) })] })]),
          kw('source', 'Source address', { children: [prm(word(), 'Source address or interface', { run: (c) => (trace ? this.trace(c.args['dst']!, this.rc) : this.ping(c.args['dst']!, 5, this.rc)) })] })
        ]
      })
    ]
    add(exec, 'ping', 'Test network reachability', undefined, { children: pingNode(false) })
    add(exec, 'traceroute', 'Traceroute to destination', undefined, { children: pingNode(true) })
    add(exec, 'dir', 'Display directory', () => this.dir(), { children: [kw('bootflash:', 'Directory or filename', { run: () => this.dir() })] })
    add(exec, 'sleep', 'Sleep for the specified number of seconds', undefined, { children: [prm(int(0, 2147483647), 'Number of seconds', { name: 'n', run: async (c) => (await this.s.sleep(Math.min(Number(c.args['n']), 30) * 1000), '') })] })
    add(exec, 'ssh', 'SSH to another system', undefined, { children: [prm(word(), 'Hostname or user@hostname', { run: (c) => `ssh: connect to host ${c.params[0]} port 22: Connection refused` })] })
    add(exec, 'send', 'Send message to open sessions', undefined, { children: [prm(line, 'Message', { run: () => '' })] })
    add(exec, 'setup', 'Run the basic SETUP command facility', () => '%% [simulator] setup is not available on the simulated device.')
    add(exec, 'system', 'System management commands', undefined, { children: [kw('switchover', 'Switchover to standby supervisor', { run: () => 'Failed to switchover: standby supervisor not present' })] })
    add(exec, 'run bash', 'Run bash shell', () => (has('bash-shell') ? '%% [simulator] bash is disabled on the simulated device.' : `${this.caret(5)}\n% Invalid command at '^' marker.`), {}, { run: 'Run a command' })
    add(exec, 'where', 'Shows the cli context you are in', () => `  ${this.whereText()}   ${this.s.user}@${d.hostname}%${this.rc ?? 'default'}`)
    add(exec, 'end', 'Go to exec mode', () => (this.endConfig(), ''))
    add(exec, 'exit', 'Exit from command interpreter', () => (this.s.close(), ''))
    exec.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    for (const n of exec) if (n.word === 'show') n.children?.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return exec
  }

  private whereText(): string {
    const names: Record<string, string> = { config: 'conf', 'config-if': 'interface', 'config-if-range': 'interface', 'config-vlan': 'vlan', 'config-vrf': 'vrf context', 'config-router-bgp': 'router bgp', 'config-router-ospf': 'router ospf', 'config-acl': 'ip access-list', 'config-route-map': 'route-map' }
    const path: string[] = []
    for (let m: CMode | undefined = this.mode; m && m.id !== 'exec'; m = m.up) path.unshift(names[m.id] ?? m.id)
    return path.length ? path.join('; ') : 'exec'
  }

  // ---------------------------------------------------------------- exec actions

  private enterConfig(): string {
    this.setMode('config')
    return 'Enter configuration commands, one per line. End with CNTL/Z.'
  }

  private enterSession(name: string): string {
    const all = sessionsOf(this.d)
    let s = all.get(name)
    if (!s) {
      if (all.size >= 32) return 'ERROR: Maximum number of configuration sessions reached'
      const copy = deviceFrom(this.d, snapshot(this.d))
      setClock(copy, runtime(this.d).clock)
      s = { name, owner: this.s.user, created: now(this.d), copy, lines: [] }
      all.set(name, s)
    }
    this.sess = s
    this.setMode('config')
    return 'Config Session started, Session ID is 1\nEnter configuration commands, one per line. End with CNTL/Z.'
  }

  private sessionSummary(): string {
    const all = [...sessionsOf(this.d).values()]
    const R2 = '-'.repeat(68)
    return ['Session Manager Database:', R2, 'Name                    Session Owner           Creation Time', R2, ...all.map((s) => `${s.name.padEnd(24)}${s.owner.padEnd(24)}${R.utcStamp(s.created)}`), '', `Number of active configuration sessions = ${all.length}`].join('\n')
  }

  private sessionList(name?: string): string {
    const all = [...sessionsOf(this.d).values()].filter((s) => !name || s.name === name)
    if (name && !all.length) return `ERROR: Session ${name} does not exist`
    return all.map((s) => [`config session ${s.name}`, ...s.lines.map((l, k) => `${String(k + 1).padStart(4, '0')}  ${l}`)].join('\n')).join('\n\n')
  }

  private commitSession(): string {
    const s = this.sess
    if (!s) return ''
    restore(this.d, snapshot(s.copy))
    store(this.d).lastChange = now(this.d)
    tickBgp(this.d, now(this.d))
    sessionsOf(this.d).delete(s.name)
    logEvent(this.d, `%VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by ${this.s.user} on ${this.s.from}@pts/0`)
    this.sess = undefined
    this.endConfig()
    return 'Commit Successful'
  }

  private abortSession(): string {
    const s = this.sess
    if (s) sessionsOf(this.d).delete(s.name)
    this.sess = undefined
    this.endConfig()
    return ''
  }

  private save(): string {
    this.d.startup = snapshot(this.d)
    store(this.d).startupErased = false
    return '[########################################] 100%\nCopy complete, now saving to disk (please wait)...\nCopy complete.'
  }

  private async yes(question: string): Promise<boolean> {
    const a = (await this.s.ask(question, { mode: 'line' })).trim().toLowerCase()
    return a === 'y' || a === 'yes'
  }

  private async writeErase(): Promise<string> {
    await this.s.print('Warning: This command will erase the startup-configuration.')
    if (!(await this.yes('Do you wish to proceed anyway? (y/n)  [n] '))) return ''
    store(this.d).startupErased = true
    return ''
  }

  private async reload(): Promise<string> {
    if (isDirty(this.d)) await this.s.print('!!!WARNING! there is unsaved configuration!!!')
    if (!(await this.yes('This command will reboot the system. (y/n)?  [n] '))) return ''
    return '%% [simulator] reload acknowledged. The simulator never reboots.'
  }

  private checkpoint(name: string | undefined, desc: string | undefined): string {
    const st = store(this.d)
    const user = st.checkpoints.filter((c) => !c.name.startsWith('system-'))
    if (user.length >= 10) return 'ERROR: Maximum number of user checkpoints (10) reached'
    let n = name
    if (!n) for (let k = 1; !n || st.checkpoints.some((c) => c.name === n); k++) n = `user-checkpoint-${k}`
    if (st.checkpoints.some((c) => c.name === n)) return `ERROR: Checkpoint name ${n} is in use`
    st.checkpoints.push({ name: n, desc: desc ?? '', user: this.s.user, at: now(this.d), snap: snapshot(this.d) })
    return '...........Done'
  }

  private deleteCheckpoint(name: string): string {
    const st = store(this.d)
    if (!st.checkpoints.some((c) => c.name === name)) return `ERROR: Checkpoint ${name} does not exist`
    st.checkpoints = st.checkpoints.filter((c) => c.name !== name)
    return ''
  }

  private checkpointSummary(): string {
    const st = store(this.d)
    const R2 = '-'.repeat(80)
    const fmt = (c: NxosCheckpoint, k: number): string => {
      const dt = new Date(c.at)
      const stamp = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()]}, ${dt.toISOString().slice(11, 19)} ${dt.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()]} ${dt.getUTCFullYear()}`
      const size = configBody(deviceFrom(this.d, c.snap)).join('\n').length
      return [`${k + 1}) ${c.name}:`, `Created by ${c.user}`, `Created at ${stamp}`, `Size is ${size.toLocaleString('en-US')} bytes`, `Description: ${c.desc || 'None'}`].join('\n')
    }
    const user = st.checkpoints.filter((c) => !c.name.startsWith('system-'))
    const sys = st.checkpoints.filter((c) => c.name.startsWith('system-'))
    return ['User Checkpoints:', R2, ...user.map(fmt), ...(sys.length ? ['', 'System Checkpoints:', R2, ...sys.map(fmt)] : [])].join('\n')
  }

  private showCheckpoint(name: string): string {
    const c = store(this.d).checkpoints.find((x) => x.name === name)!
    return [`Name: ${c.name}`, '', ...configBody(deviceFrom(this.d, c.snap))].join('\n')
  }

  private configOf(name: string): string[] | undefined {
    if (name === 'running-config') return configBody(this.d)
    const c = store(this.d).checkpoints.find((x) => x.name === name)
    return c ? configBody(deviceFrom(this.d, c.snap)) : undefined
  }

  private patch(from: string, to: string): string {
    const a = this.configOf(from)
    const b = this.configOf(to)
    if (!a) return `ERROR: Checkpoint ${from} does not exist`
    if (!b) return `ERROR: Checkpoint ${to} does not exist`
    const head = ['Collecting Running-Config', '#Generating Rollback Patch']
    const diff = unifiedDiff(a, b, from, to, 0).slice(2).filter((l) => !l.startsWith('@@'))
    return [...head, ...(diff.length ? ['!!', ...diff] : ['Rollback Patch is Empty'])].join('\n')
  }

  private async rollback(name: string): Promise<string> {
    const c = store(this.d).checkpoints.find((x) => x.name === name)
    if (!c) return `ERROR: Checkpoint ${name} does not exist`
    await this.s.print('Note: Applying config parallelly may fail Rollback verification\nCollecting Running-Config\n#Generating Rollback Patch\nExecuting Rollback Patch\nGenerating Running-config for verification\nGenerating Patch for verification\nVerification is Successful.')
    restore(this.d, c.snap)
    store(this.d).lastChange = now(this.d)
    tickBgp(this.d, now(this.d))
    return '\nRollback completed successfully.'
  }

  private runDiff(): string {
    const s = startupConfig(this.d)
    const a = s ? s.split('\n').slice(4) : []
    const b = configBody(this.d)
    const diff = unifiedDiff(a, b, 'Startup-config', 'Running-config', 3)
    return diff.join('\n')
  }

  private clearCounters(i?: Iface): string {
    const t = now(this.d)
    for (const x of i ? [i] : this.d.interfaces) {
      x.clearedAt = t
      x.errors = undefined
      if (x.faultSince !== undefined) x.faultSince = t
    }
    return ''
  }

  private dir(): string {
    const v = this.d.version.replace(/[()]/g, '.').replace(/\.$/, '')
    return [`       4096    ${R.nxDate(this.d.bootedAt).slice(4)}  .rpmstore/`, `  2147483648    ${R.nxDate(this.d.bootedAt).slice(4)}  nxos64-cs.${v}.M.bin`, '', 'Usage for bootflash://sup-local', ' 4325376000 bytes used', '114258247680 bytes free', '118583623680 bytes total'].join('\n')
  }

  private async ping(target: string, count: number, vrf?: string): Promise<string> {
    if (!isIpv4(target)) return `% Invalid host/interface ${target}`
    const ok = reachable(this.d, target, vrf)
    await this.s.print(`PING ${target} (${target}): 56 data bytes`)
    let got = 0
    let sent = 0
    for (let k = 0; k < count; k++) {
      if (!(await this.s.sleep(ok ? 20 : 60))) break
      sent++
      if (ok) {
        got++
        await this.s.print(`64 bytes from ${target}: icmp_seq=${k} ttl=254 time=${(0.7 + ((k * 37) % 50) / 100).toFixed(3)} ms`)
      } else await this.s.print(`Request ${k} timed out`)
    }
    const loss = sent ? (((sent - got) / sent) * 100).toFixed(2) : '0.00'
    return [``, `--- ${target} ping statistics ---`, `${sent} packets transmitted, ${got} packets received, ${loss}% packet loss`, ...(got ? ['round-trip min/avg/max = 0.700/0.912/1.190 ms'] : [])].join('\n')
  }

  private async trace(target: string, vrf?: string): Promise<string> {
    if (!isIpv4(target)) return `% Invalid host/interface ${target}`
    await this.s.print(`traceroute to ${target} (${target}), 30 hops max, 40 byte packets`)
    const hops = traceHops(this.d, target, vrf)
    for (let k = 0; k < hops.length; k++) {
      if (!(await this.s.sleep(hops[k] === '*' ? 80 : 20))) break
      const h = hops[k]!
      await this.s.print(h === '*' ? `${String(k + 1).padStart(2)}  * * *` : `${String(k + 1).padStart(2)}  ${h} (${h})  ${(0.8 + k).toFixed(3)} ms  ${(0.9 + k).toFixed(3)} ms  ${(1.1 + k).toFixed(3)} ms`)
    }
    return ''
  }

  // ---------------------------------------------------------------- config trees

  private configTrees(): Record<string, Node[]> {
    const self = this
    const cd = (): Device => self.c
    const has = (f: string): boolean => R.feature(cd(), f)
    const line: Param = { kind: 'line', label: 'LINE' }
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const ipP = (label = 'A.B.C.D'): Param => ({ kind: 'ipv4', label })
    const pfxP: Param = { kind: 'prefix', label: 'A.B.C.D/LEN' }
    const changed = this.changed
    const g: Node[] = []
    const GH: Record<string, string> = { no: 'Negate a command or set its defaults', ip: 'Configure IP features', 'ip access-list': 'Configure access lists', router: 'Enable a routing process' }
    const C = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(g, path, help, run, extra, GH)
    const invalidAt = (c: Ctx, tok: string): string => `${this.caret(c.line.indexOf(tok))}\n% Invalid command at '^' marker.`
    const generic = (more: Node[], exitHelp = 'Exit from command interpreter'): Node[] => [...more, kw('exit', exitHelp, { run: () => (this.exitMode(), '') }), kw('end', 'Go to exec mode', { run: () => (this.endConfig(), '') }), kw('where', 'Shows the cli context you are in', { run: () => `  ${this.whereText()}   ${this.s.user}@${this.d.hostname}` })]

    if (this.sess) {
      C('commit', 'Commit the current session', () => this.commitSession())
      C('abort', 'Abort the current session', () => this.abortSession())
      C('verify', 'Verify the current session', () => 'Verification Successful')
    }

    C('hostname', 'Configure system\'s host name', undefined, { children: [prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z][\w-]{0,62}$/.test(t) }, 'Host name of the switch', { name: 'h', run: (c) => ((cd().hostname = c.args['h']!), changed()) })] })
    C('switchname', 'Configure system\'s host name', undefined, { children: [prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z][\w-]{0,62}$/.test(t) }, 'Host name of the switch', { name: 'h', run: (c) => ((cd().hostname = c.args['h']!), changed()) })] })

    // ---- features
    const featP: Param = { kind: 'enum', label: 'WORD', values: () => R.KNOWN_FEATURES.filter((f) => !f.includes(' ')) }
    C('feature', 'Command to enable/disable features', undefined, {
      children: [
        prm(featP, 'Feature name', { name: 'f', run: (c) => ((cd().services[`feature-${c.args['f']!.toLowerCase()}`] = true), changed()) }),
        kw('nv', 'NV overlay', { children: [kw('overlay', 'Enable VxLAN', { run: () => ((cd().services['feature-nv overlay'] = true), changed()) })] })
      ]
    })
    C('no feature', 'Command to enable/disable features', undefined, { children: [prm(featP, 'Feature name', { name: 'f', run: (c) => this.noFeature(c.args['f']!.toLowerCase()) })] })

    // ---- interfaces
    const ifHelp: [string, string, string][] = [
      ['ethernet', 'Ethernet IEEE 802.3z', 'Ethernet'],
      ['loopback', 'Loopback interface', 'loopback'],
      ['mgmt', 'Management interface', 'mgmt'],
      ['port-channel', 'Port Channel interface', 'port-channel'],
      ...(has('interface-vlan') ? [['vlan', 'Vlan interface', 'Vlan'] as [string, string, string]] : []),
      ...(has('tunnel') ? [['tunnel', 'Tunnel interface', 'Tunnel'] as [string, string, string]] : []),
      ...(has('nv overlay') ? [['nve', 'NVE interface', 'nve'] as [string, string, string]] : [])
    ]
    const numP: Param = { kind: 'line', label: '<1-1024>' }
    const ifTypes = (run: (c: Ctx, text: string) => string): Node[] => [
      ...ifHelp.map(([w, h, full]) => kw(w, h, { children: [prm(numP, `${full} interface number`, { name: 'num', run: (c) => run(c, `${full}${c.args['num']}`) })] })),
      prm({ kind: 'line', label: 'LINE' }, 'Interface name', { name: 'raw', hidden: true, run: (c) => run(c, c.args['raw']!) })
    ]
    C('interface', 'Configure interfaces', undefined, { children: ifTypes((c, text) => this.ifEnter(c, text)) })
    C('no interface', 'Configure interfaces', undefined, { children: ifTypes((c, text) => this.noInterface(c, text)) })
    C('default interface', 'Set an interface to default config', undefined, { children: ifTypes((c, text) => this.defaultInterface(c, text)) }, )

    // ---- vlan
    const vlP: Param = { kind: 'vlanlist', label: '<1-4094>', test: (t) => expandVlans(t).every((v) => v >= 1 && v <= 4094) }
    C('vlan', 'Vlan commands', undefined, {
      children: [
        prm(vlP, 'VLAN ID 1-4094 or range(s): 1-5, 10 or 2-5,7-19', {
          name: 'vl',
          run: (c) => {
            const ids = expandVlans(c.args['vl']!)
            for (const id of ids) if (!cd().vlans.some((v) => v.id === id)) cd().vlans.push({ id, name: `VLAN${String(id).padStart(4, '0')}` })
            cd().vlans.sort((a, b) => a.id - b.id)
            this.setMode('config-vlan', ids)
            return changed()
          }
        })
      ]
    })
    C('no vlan', 'Vlan commands', undefined, {
      children: [
        prm(vlP, 'VLAN ID', {
          name: 'vl',
          run: (c) => {
            const ids = expandVlans(c.args['vl']!)
            if (ids.includes(1)) return 'ERROR: Default VLAN 1 cannot be deleted'
            cd().vlans = cd().vlans.filter((v) => !ids.includes(v.id))
            return changed()
          }
        })
      ]
    })
    const vlanCtx = (): Device['vlans'] => cd().vlans.filter((v) => (this.mode.ctx as number[]).includes(v.id))
    const vlm = generic([
      kw('name', 'Ascii name of the VLAN', { children: [prm({ kind: 'word', label: 'WORD', test: (t) => t.length <= 32 }, 'The ascii name for the VLAN (Max Size 32)', { name: 'n', run: (c) => { for (const v of vlanCtx()) v.name = c.args['n']!; return changed() } })] }),
      kw('shutdown', 'Shutdown VLAN switching', { run: () => { for (const v of vlanCtx()) v.shutdown = true; return changed() } }),
      kw('state', 'Operational state of the VLAN', { children: ['active', 'suspend'].map((s) => kw(s, `VLAN ${s} state`, { run: () => { for (const v of vlanCtx()) v.shutdown = s === 'suspend'; return changed() } })) }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('shutdown', 'Shutdown VLAN switching', { run: () => { for (const v of vlanCtx()) v.shutdown = false; return changed() } }), kw('name', 'Ascii name of the VLAN', { run: () => { for (const v of vlanCtx()) v.name = `VLAN${String(v.id).padStart(4, '0')}`; return changed() } })] })
    ])

    // ---- vrf context
    C('vrf context', 'Create VRF and enter VRF mode', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => cd().vrfs.map((v) => v.name) }, 'VRF name', {
          name: 'vrf',
          run: (c) => {
            const name = c.args['vrf']!
            if (name === 'default') return 'ERROR: VRF default cannot be configured'
            let v = cd().vrfs.find((x) => x.name === name)
            if (!v) cd().vrfs.push((v = { name, rd: '', interfaces: [] }))
            this.setMode('config-vrf', v)
            return changed()
          }
        })
      ]
    }, )
    C('no vrf context', 'Create VRF and enter VRF mode', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => cd().vrfs.map((v) => v.name) }, 'VRF name', {
          name: 'vrf',
          run: (c) => {
            const name = c.args['vrf']!
            if (name === 'management') return 'ERROR: VRF management cannot be deleted'
            if (!cd().vrfs.some((v) => v.name === name)) return `ERROR: VRF ${name} does not exist`
            cd().vrfs = cd().vrfs.filter((v) => v.name !== name)
            cd().staticRoutes = cd().staticRoutes.filter((r) => r.vrf !== name)
            for (const i of cd().interfaces) if (i.vrf === name) Object.assign(i, { vrf: undefined, ip: undefined, mask: undefined })
            return changed()
          }
        })
      ]
    })
    const routeNodes = (neg: boolean, vrfOf: () => string | undefined): Node[] => [
      prm(pfxP, 'IP prefix and prefix length', {
        name: 'pfx',
        children: [
          prm(ipP('A.B.C.D'), 'Next hop address', {
            name: 'nh',
            run: (c) => this.staticRoute(c, neg, vrfOf()),
            children: [prm(int(1, 255), 'Preference for this route', { name: 'ad', run: (c) => this.staticRoute(c, neg, vrfOf()) }), kw('name', 'Name of the route', { children: [prm(word(), 'Route name', { name: 'rn', run: (c) => this.staticRoute(c, neg, vrfOf()) })] })]
          })
        ]
      })
    ]
    C('ip route', 'Route information', undefined, { children: routeNodes(false, () => undefined) })
    C('no ip route', 'Route information', undefined, { children: routeNodes(true, () => undefined) })
    const vrfCtx = (): Device['vrfs'][number] => this.mode.ctx as Device['vrfs'][number]
    const vrfm = generic([
      kw('rd', 'Configure route distinguisher', { children: [prm({ kind: 'word', label: 'ASN:nn or IP-address:nn' }, 'Route distinguisher or auto', { name: 'rd', run: (c) => ((vrfCtx().rd = c.args['rd']!), changed()) })] }),
      kw('description', 'Enter description', { children: [prm(line, 'Description', { run: () => changed() })] }),
      kw('ip', 'Configure IP features', { children: [kw('route', 'Route information', { children: routeNodes(false, () => vrfCtx().name) })] }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('ip', 'Configure IP features', { children: [kw('route', 'Route information', { children: routeNodes(true, () => vrfCtx().name) })] }), kw('rd', 'Configure route distinguisher', { run: () => ((vrfCtx().rd = ''), changed()) })] }),
      kw('address-family', 'Configure an address-family', { children: [kw('ipv4', 'Configure IPv4 address-family', { children: [kw('unicast', 'Configure unicast address-family', { run: () => (this.setMode('config-vrf-af', this.mode.ctx, this.mode), '') })] })] })
    ])
    const vrfaf = generic([kw('route-target', 'Specify Target VPN Extended Communities', { children: [prm(line, 'import/export ASN:nn', { run: () => changed() })] })])

    // ---- ACLs
    C('ip access-list', 'Configure access lists', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => cd().acls.map((a) => a.name), test: (t) => t.length <= 64 }, 'List name (Max Size 64)', {
          name: 'acl',
          run: (c) => {
            let a = cd().acls.find((x) => x.name === c.args['acl'])
            if (!a) cd().acls.push((a = { name: c.args['acl']!, type: 'extended', entries: [] }))
            this.setMode('config-acl', a)
            return changed()
          }
        })
      ]
    })
    C('no ip access-list', 'Configure access lists', undefined, { children: [prm({ kind: 'word', label: 'WORD', values: () => cd().acls.map((a) => a.name) }, 'List name', { name: 'acl', run: (c) => ((cd().acls = cd().acls.filter((a) => a.name !== c.args['acl'])), changed()) })] })
    const aclEntry = (c: Ctx): string => {
      const a = this.mode.ctx as Acl
      const act = c.args['act'] as Acl['entries'][number]['action']
      const text = c.args['rest'] ?? ''
      if (act !== 'remark' && !/^(ip|tcp|udp|icmp|igmp|gre|esp|ahp|ospf|eigrp|pim|\d+)\b/.test(text)) return invalidAt(c, text.split(/\s+/)[0]!)
      const seq = c.args['seq'] ? Number(c.args['seq']) : (a.entries.at(-1)?.seq ?? 0) + 10
      if (a.entries.some((e) => e.seq === seq)) return `ERROR: Sequence number ${seq} already exists`
      a.entries.push({ seq, action: act, text })
      a.entries.sort((x, y) => x.seq - y.seq)
      return changed()
    }
    const acts = (): Node[] => ['permit', 'deny', 'remark'].map((w) => kw(w, w === 'remark' ? 'Access list entry comment' : `Specify packets to ${w === 'permit' ? 'forward' : 'reject'}`, { name: 'act', children: [prm(line, w === 'remark' ? 'Comment (Max Size 100)' : 'Protocol and match criteria', { name: 'rest', run: aclEntry })] }))
    const aclm = generic([
      ...acts(),
      prm(int(1, 4294967295), 'Sequence number', { name: 'seq', children: acts() }),
      kw('statistics', 'Enable per-entry statistics for the ACL', { children: [kw('per-entry', 'Enable per-entry statistics', { run: () => changed() })] }),
      kw('no', 'Negate a command or set its defaults', { children: [prm(int(1, 4294967295), 'Sequence number', { name: 'seq', run: (c) => { const a = this.mode.ctx as Acl; a.entries = a.entries.filter((e) => e.seq !== Number(c.args['seq'])); return changed() } })] })
    ])

    // ---- prefix-lists and route-maps
    const plRun = (c: Ctx): string => {
      const prefix = c.args['pfx']!
      let p = cd().prefixLists.find((x) => x.name === c.args['pl'])
      if (!p) cd().prefixLists.push((p = { name: c.args['pl']!, entries: [] }))
      const seq = c.args['seq'] ? Number(c.args['seq']) : (p.entries.at(-1)?.seq ?? 0) + 5
      p.entries = p.entries.filter((e) => e.seq !== seq)
      p.entries.push({ seq, action: c.args['act'] as 'permit', prefix, ...(c.args['ge'] ? { ge: Number(c.args['ge']) } : {}), ...(c.args['le'] ? { le: Number(c.args['le']) } : {}) })
      p.entries.sort((a, b) => a.seq - b.seq)
      return changed()
    }
    const plTail = (): Node[] => {
      const le = (): Node => kw('le', 'Maximum prefix length to be matched', { children: [prm(int(1, 32), 'Maximum prefix length', { name: 'le', run: plRun })] })
      return ['permit', 'deny'].map((a) => kw(a, `Specify packets to ${a === 'permit' ? 'forward' : 'reject'}`, { name: 'act', children: [prm(pfxP, 'IP prefix and prefix length', { name: 'pfx', run: plRun, children: [kw('ge', 'Minimum prefix length to be matched', { children: [prm(int(1, 32), 'Minimum prefix length', { name: 'ge', run: plRun, children: [le()] })] }), le()] })] }))
    }
    const plName: Param = { kind: 'word', label: 'WORD', values: () => cd().prefixLists.map((p) => p.name) }
    C('ip prefix-list', 'Build a prefix list', undefined, { children: [prm(plName, 'Name of prefix-list (Max Size 63)', { name: 'pl', children: [kw('seq', 'Sequence number of an entry', { children: [prm(int(1, 4294967294), 'Sequence number', { name: 'seq', children: plTail() })] }), ...plTail(), kw('description', 'Prefix-list specific description', { children: [prm(line, 'Description', { run: () => changed() })] })] })] })
    C('no ip prefix-list', 'Build a prefix list', undefined, {
      children: [
        prm(plName, 'Name of prefix-list', {
          name: 'pl',
          run: (c) => ((cd().prefixLists = cd().prefixLists.filter((p) => p.name !== c.args['pl'])), changed()),
          children: [kw('seq', 'Sequence number of an entry', { children: [prm(int(1, 4294967294), 'Sequence number', { name: 'seq', run: (c) => { const p = cd().prefixLists.find((x) => x.name === c.args['pl']); if (p) p.entries = p.entries.filter((e) => e.seq !== Number(c.args['seq'])); return changed() } })] })]
        })
      ]
    })
    const rmEnter = (c: Ctx): string => {
      let r = cd().routeMaps.find((x) => x.name === c.args['rm'])
      if (!r) cd().routeMaps.push((r = { name: c.args['rm']!, entries: [] }))
      const seq = c.args['seq'] ? Number(c.args['seq']) : r.entries[0]?.seq ?? 10
      let e = r.entries.find((x) => x.seq === seq)
      if (!e) {
        r.entries.push((e = { seq, action: (c.args['act'] as 'permit' | undefined) ?? 'permit', match: [], set: [] }))
        r.entries.sort((a, b) => a.seq - b.seq)
      } else if (c.args['act']) e.action = c.args['act'] as 'permit'
      this.setMode('config-route-map', { rm: r, e })
      return changed()
    }
    const rmName: Param = { kind: 'word', label: 'WORD', values: () => cd().routeMaps.map((r) => r.name) }
    const rmSeq = (): Node[] => [prm(int(0, 65535), 'Sequence to insert to/delete from existing route-map entry', { name: 'seq', run: rmEnter })]
    C('route-map', 'Create route-map or enter route-map command mode', undefined, { children: [prm(rmName, 'Route-map name (Max Size 63)', { name: 'rm', run: rmEnter, children: [kw('permit', 'Route-map permits set operations', { name: 'act', run: rmEnter, children: rmSeq() }), kw('deny', 'Route-map denies set operations', { name: 'act', run: rmEnter, children: rmSeq() }), ...rmSeq()] })] })
    C('no route-map', 'Create route-map or enter route-map command mode', undefined, {
      children: [
        prm(rmName, 'Route-map name', {
          name: 'rm',
          run: (c) => ((cd().routeMaps = cd().routeMaps.filter((r) => r.name !== c.args['rm'])), changed()),
          children: ['permit', 'deny'].map((a) => kw(a, 'Route-map action', { children: [prm(int(0, 65535), 'Sequence', { name: 'seq', run: (c) => { const r = cd().routeMaps.find((x) => x.name === c.args['rm']); if (r) r.entries = r.entries.filter((e) => e.seq !== Number(c.args['seq'])); return changed() } })] }))
        })
      ]
    })
    const rmCtx = (): { rm: RouteMap; e: RouteMap['entries'][number] } => this.mode.ctx as { rm: RouteMap; e: RouteMap['entries'][number] }
    const rmm = generic([
      kw('match', 'Match values from routing table', { children: [prm(line, 'Match clause', { name: 'm', run: (c) => (rmCtx().e.match.push(c.args['m']!), changed()) })] }),
      kw('set', 'Set values in destination routing protocol', { children: [prm(line, 'Set clause', { name: 's', run: (c) => (rmCtx().e.set.push(c.args['s']!), changed()) })] }),
      kw('description', 'Description of the route-map', { children: [prm(line, 'Description', { run: () => changed() })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('match', 'Match values from routing table', { children: [prm(line, 'Match clause', { name: 'm', run: (c) => { const e = rmCtx().e; e.match = e.match.filter((x) => x !== c.args['m']); return changed() } })] }),
          kw('set', 'Set values in destination routing protocol', { children: [prm(line, 'Set clause', { name: 's', run: (c) => { const e = rmCtx().e; e.set = e.set.filter((x) => x !== c.args['s']); return changed() } })] })
        ]
      })
    ])

    // ---- routing protocols (feature-gated)
    const trees: Record<string, Node[]> = {}
    if (has('bgp')) {
      const asP: Param = { kind: 'asn', label: '<1-4294967295>' }
      C('router bgp', 'Border Gateway Protocol (BGP)', undefined, {
        children: [
          prm(asP, 'Autonomous system number', {
            name: 'as',
            run: (c) => {
              const as = Number(c.args['as'])
              const d = cd()
              if (d.localAs && d.localAs !== as) return `BGP is already running; AS is ${d.localAs}`
              d.localAs = as
              this.setMode('config-router-bgp')
              return changed()
            }
          })
        ]
      })
      C('no router bgp', 'Border Gateway Protocol (BGP)', undefined, { children: [prm(asP, 'Autonomous system number', { name: 'as', run: (c) => (Number(c.args['as']) !== cd().localAs ? `% BGP instance ${c.args['as']} not found` : ((cd().bgp = []), changed())) })] })
      Object.assign(trees, this.bgpTrees(generic, changed))
    }
    if (has('ospf')) {
      const tagP: Param = { kind: 'word', label: 'WORD', test: (t) => t.length <= 20 }
      C('router ospf', 'Open Shortest Path First (OSPF)', undefined, {
        children: [
          prm(tagP, 'Instance tag (Max Size 20)', {
            name: 'tag',
            run: (c) => {
              const d = cd()
              if (!d.ospf) d.ospf = { process: c.args['tag']!, ifaces: [], neighbors: [] }
              else d.ospf.process = c.args['tag']!
              this.setMode('config-router-ospf')
              return changed()
            }
          })
        ]
      })
      C('no router ospf', 'Open Shortest Path First (OSPF)', undefined, { children: [prm(tagP, 'Instance tag', { name: 'tag', run: (c) => (cd().ospf?.process === c.args['tag'] ? ((cd().ospf = undefined), changed()) : `% OSPF instance ${c.args['tag']} not found`) })] })
      trees['config-router-ospf'] = generic([
        kw('router-id', 'Set OSPF process router-id', { children: [prm(ipP(), 'OSPF router-id in IP address format', { name: 'rid', run: (c) => ((cd().ospf!.routerId = c.args['rid']!), changed()) })] }),
        kw('log-adjacency-changes', 'Log changes in adjacency state', { run: () => changed(), children: [kw('detail', 'Log all state changes', { run: () => changed() })] }),
        kw('passive-interface', 'Suppress routing updates on the interface', { children: [kw('default', 'Interfaces passive by default', { run: () => { for (const o of cd().ospf!.ifaces) o.passive = true; return changed() } })] }),
        kw('auto-cost', 'Calculate OSPF cost according to bandwidth', { children: [kw('reference-bandwidth', 'Reference bandwidth used to assign OSPF cost', { children: [prm(int(1, 4000000), 'Reference bandwidth', { run: () => changed(), children: [kw('Gbps', 'Gbps', { run: () => changed() }), kw('Mbps', 'Mbps', { run: () => changed() })] })] })] })
      ])
    }

    C('cdp enable', 'Enable CDP', () => ((cd().services['cdp'] = true), changed()), {}, )
    C('no cdp enable', 'Enable CDP', () => ((cd().services['cdp'] = false), changed()))
    C('banner motd', 'Configure banner message of the day', undefined, { children: [prm(line, 'Delimiter followed by banner text and the same delimiter', { name: 'b', run: (c) => { const t = c.args['b']!; const ch = t[0]!; const end = t.indexOf(ch, 1); cd().motd = end > 0 ? t.slice(1, end) : t.slice(1); return changed() } })] }, )
    C('no banner motd', 'Configure banner message of the day', () => ((cd().motd = undefined), changed()))
    for (const [path, help] of [
      ['username', 'Configure user information.'],
      ['ntp server', 'NTP server'],
      ['logging server', 'Enable forwarding to Remote Server'],
      ['snmp-server', 'Configure snmp server'],
      ['spanning-tree', 'Spanning Tree Subsystem'],
      ['clock', 'Configure clock'],
      ['ip domain-name', 'Configure local domain name'],
      ['ip name-server', 'Configure name server'],
      ['system', 'System management commands'],
      ['line', 'Configure a terminal line']
    ] as const) C(path, help, undefined, { children: [prm(line, 'Arguments', { name: 'rest', run: (c) => { const l = `${path} ${c.args['rest']}`; if (!cd().extraConfig.includes(l)) cd().extraConfig.push(l); return changed() } })] })
    C('end', 'Go to exec mode', () => (this.endConfig(), ''))
    C('exit', 'Exit from command interpreter', () => (this.exitMode(), ''))
    C('where', 'Shows the cli context you are in', () => `  ${this.whereText()}   ${this.s.user}@${this.d.hostname}`)
    g.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))

    let config = g
    if (this.sess) {
      // Session manager supports ACL (and QoS) configuration only (doc §5).
      const allow = new Set(['ip', 'interface', 'no', 'commit', 'abort', 'verify', 'end', 'exit', 'where'])
      config = g.filter((n) => allow.has(n.word ?? ''))
    }
    const ifm = this.ifTree(generic, changed)
    return {
      config,
      'config-if': ifm,
      'config-if-range': ifm,
      'config-vlan': vlm,
      'config-vrf': vrfm,
      'config-vrf-af': vrfaf,
      'config-acl': aclm,
      'config-route-map': rmm,
      ...trees
    }
    void self
  }

  private noFeature(f: string): string {
    const d = this.c
    if (!R.feature(d, f)) return ''
    if (!this.sess) {
      const st = store(this.d)
      st.checkpoints = st.checkpoints.filter((c) => c.name !== `system-fm-${f}`)
      st.checkpoints.push({ name: `system-fm-${f}`, desc: `Created by Feature Manager.`, user: this.s.user, at: now(this.d), snap: snapshot(this.d) })
    }
    d.services[`feature-${f}`] = false
    if (f === 'bgp') {
      for (const n of d.bgp) if (n.upSince !== undefined) logEvent(d, `%BGP-5-ADJCHANGE:  bgp-${d.localAs} [11502] (default) neighbor ${n.ip} Down - sent:  administratively shutdown`)
      d.bgp = []
    }
    if (f === 'ospf' && d.ospf) d.ospf = undefined
    if (f === 'interface-vlan') d.interfaces = d.interfaces.filter((i) => !i.name.startsWith('Vlan'))
    if (f === 'lacp') for (const i of d.interfaces) i.channelGroup = undefined
    return this.changed()
  }

  private staticRoute(c: Ctx, neg: boolean, vrf: string | undefined): string {
    const d = this.c
    const [ip, len] = c.args['pfx']!.split('/')
    const prefix = ip!
    const mask = Number(len)
    const same = (r: Device['staticRoutes'][number]): boolean => r.prefix === prefix && r.mask === mask && r.nextHop === c.args['nh'] && (r.vrf ?? undefined) === vrf
    if (neg) {
      if (!d.staticRoutes.some(same)) return 'ERROR: Route not found'
      d.staticRoutes = d.staticRoutes.filter((r) => !same(r))
      return this.changed()
    }
    d.staticRoutes = d.staticRoutes.filter((r) => !same(r))
    d.staticRoutes.push({ prefix, mask, nextHop: c.args['nh']!, ...(vrf ? { vrf } : {}), ...(c.args['ad'] ? { ad: Number(c.args['ad']) } : {}), ...(c.args['rn'] ? { name: c.args['rn'] } : {}) })
    return this.changed()
  }

  // ---------------------------------------------------------------- interfaces

  /** "Ethernet1/1-3, e1/5, lo0" → canonical names (or an error marker). */
  private parseRange(text: string): { names: string[] } | { error: 'type' | 'range' } {
    const names: string[] = []
    let lastType: string | undefined
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([a-z][a-z-]*)?\s*(\d+(?:\/\d+)*(?:\.\d+)?)(?:\s*-\s*(\d+))?$/i.exec(part)
      if (!m) return { error: 'type' }
      let type = lastType
      if (m[1]) {
        const ref = parseIfName(`${m[1]}0`, R.NXOS_TYPES)
        if (!ref || ref === 'ambiguous') return { error: 'type' }
        type = ref.type.full
      }
      if (!type) return { error: 'type' }
      lastType = type
      const base = m[2]!
      if (m[3] !== undefined) {
        const parts = base.split('/')
        const from = Number(parts.at(-1))
        const to = Number(m[3])
        if (to < from) return { error: 'range' }
        for (let n = from; n <= to; n++) names.push(`${type}${[...parts.slice(0, -1), String(n)].join('/')}`)
      } else names.push(`${type}${base}`)
    }
    return names.length ? { names } : { error: 'type' }
  }

  private ifEnter(c: Ctx, text: string): string {
    const d = this.c
    const r = this.parseRange(text)
    const at = c.tokens.length > 1 ? c.line.indexOf(c.tokens[1]!) : c.line.length
    if ('error' in r) return r.error === 'range' ? `${this.caret(at)}\n% Invalid range at '^' marker.` : `${this.caret(at)}\n% Invalid command at '^' marker.`
    const list: Iface[] = []
    for (const name of r.names) {
      let i = d.interfaces.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!i) {
        const ref = parseIfName(name, R.NXOS_TYPES)
        if (!ref || ref === 'ambiguous') return `${this.caret(at)}\n% Invalid command at '^' marker.`
        const t = ref.type.full
        if (t === 'Vlan' && !R.feature(d, 'interface-vlan')) return `${this.caret(at)}\n% Invalid command at '^' marker.`
        if (t === 'Vlan' && !(Number(ref.num) >= 1 && Number(ref.num) <= 4094)) return `${this.caret(at)}\n% Invalid range at '^' marker.`
        if (t === 'Ethernet' || t === 'mgmt') {
          if (t === 'Ethernet' && /^\d+\/\d+\.\d+$/.test(ref.num)) {
            const parent = d.interfaces.find((x) => x.name === `Ethernet${ref.num.split('.')[0]}`)
            if (!parent) return `${this.caret(at)}\n% Invalid interface format at '^' marker.`
            i = { ...structuredClone(parent), name, short: `Eth${ref.num}`, mode: 'routed', ip: undefined, mask: undefined, description: undefined, channelGroup: undefined, vlan: undefined, trunkAllowed: undefined }
          } else return `${this.caret(at)}\n% Invalid interface format at '^' marker.`
        } else {
          const mgmtMac = d.interfaces.find((x) => x.mac)?.mac ?? '00de.fb20.0000'
          i = { name: t + ref.num, short: ref.type.short + ref.num, adminUp: t !== 'Vlan', linkUp: true, mode: t === 'port-channel' ? 'access' : 'routed', vlan: t === 'port-channel' ? 1 : undefined, speed: t === 'port-channel' ? '25G' : '', mac: t === 'Vlan' || t === 'port-channel' ? mgmtMac : '' }
        }
        d.interfaces.push(i)
        this.touch()
      }
      list.push(i)
    }
    this.setMode(list.length > 1 ? 'config-if-range' : 'config-if', list)
    return ''
  }

  private noInterface(c: Ctx, text: string): string {
    const d = this.c
    const r = this.parseRange(text)
    const at = c.tokens.length > 2 ? c.line.indexOf(c.tokens[2]!) : c.line.length
    if ('error' in r) return `${this.caret(at)}\n% Invalid command at '^' marker.`
    for (const name of r.names) {
      const i = d.interfaces.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!i) return `${this.caret(at)}\n% Invalid interface format at '^' marker.`
      if (/^(Ethernet\d+\/\d+$|mgmt)/.test(i.name)) return `ERROR: Cannot delete physical interface ${i.name}`
      d.interfaces = d.interfaces.filter((x) => x !== i)
      if (i.name.startsWith('port-channel')) for (const m of d.interfaces) if (`port-channel${m.channelGroup}` === i.name) m.channelGroup = undefined
      if (d.ospf) d.ospf.ifaces = d.ospf.ifaces.filter((o) => o.iface !== i.name)
    }
    return this.changed()
  }

  private defaultInterface(c: Ctx, text: string): string {
    const d = this.c
    const r = this.parseRange(text)
    if ('error' in r) return `${this.caret(c.line.length)}\n% Invalid command at '^' marker.`
    for (const name of r.names) {
      const i = d.interfaces.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!i) continue
      Object.assign(i, { description: undefined, ip: undefined, mask: undefined, vrf: undefined, mtu: undefined, speedSet: undefined, duplex: undefined, trunkAllowed: undefined, nativeVlan: undefined, channelGroup: undefined, bpduGuard: undefined })
      if (R.kind(i) === 'eth') Object.assign(i, { mode: 'access', vlan: 1, adminUp: true })
      ;(i as NxIface).nxAcl = undefined
      if (d.ospf) d.ospf.ifaces = d.ospf.ifaces.filter((o) => o.iface !== i.name)
    }
    return this.changed()
  }

  private eachIf(fn: (i: Iface) => string | void): string {
    const out: string[] = []
    for (const i of (this.mode.ctx as Iface[]) ?? []) {
      const r = fn(i)
      if (r) out.push(r)
    }
    return out.join('\n')
  }

  private shut(i: Iface, down: boolean): string {
    if (i.adminUp === !down) return ''
    const t = now(this.d)
    const live = this.c === this.d
    i.adminUp = !down
    i.lastChange = t
    const k = R.kind(i)
    if (live && (k === 'eth' || k === 'po' || k === 'mgmt')) {
      if (down) logEvent(this.d, `%ETHPORT-5-IF_DOWN_ADMIN_DOWN: Interface ${i.name} is down (Administratively down)`, t)
      else if (i.linkUp && !i.errDisabled) logEvent(this.d, `%ETHPORT-5-IF_UP: Interface ${i.name} is up in mode ${i.mode}`, t)
    }
    if (live && down)
      for (const n of this.d.bgp)
        if ((n.via === i.name || (n.updateSource === i.name && k === 'lo')) && n.upSince !== undefined && n.upSince <= t) logEvent(this.d, `%BGP-5-ADJCHANGE:  bgp-${this.d.localAs} [11502] (${n.vrf ?? 'default'}) neighbor ${n.ip} Down - holdtimer expired error`, t)
    // An err-disabled port stays down until the cause is cleared: no shutdown does not recover it.
    return this.changed()
  }

  private ifTree(generic: (more: Node[], exitHelp?: string) => Node[], changed: (v?: string) => string): Node[] {
    const cd = (): Device => this.c
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const ifm: Node[] = []
    const H: Record<string, string> = { no: 'Negate a command or set its defaults', ip: 'Configure IP features', 'ip ospf': 'OSPF interface commands', switchport: 'Configure switchport parameters', 'switchport trunk': 'Configure trunking parameters on an interface', 'switchport access': 'Set access mode characteristics of the interface', 'spanning-tree': 'Spanning Tree Subsystem', 'vrf': 'Configure VRF parameters', 'ip router': 'Configure routing on an interface' }
    const I = (path: string, help: string, run: ((i: Iface, c: Ctx) => string | void) | undefined, extra: Partial<Node> = {}): Node => add(ifm, path, help, run ? (c: Ctx) => this.eachIf((i) => run(i, c)) : undefined, extra, H)
    const leaf = (param: Param, help: string, name: string, run: (i: Iface, c: Ctx) => string | void, children?: Node[]): Node => prm(param, help, { name, run: (c) => this.eachIf((i) => run(i, c)), ...(children ? { children } : {}) })
    const l2 = (i: Iface): boolean => (R.kind(i) === 'eth' || R.kind(i) === 'po') && i.mode !== 'routed'
    const ipOnL2 = (c: Ctx): string => `${this.caret(c.line.indexOf(c.tokens[0]!))}\n% Invalid command at '^' marker.`

    I('description', 'Enter description of maximum 254 characters', undefined, { children: [leaf(line, 'Description', 'desc', (i, c) => ((i.description = c.args['desc']), changed()))] })
    I('no description', 'Enter description of maximum 254 characters', (i) => ((i.description = undefined), changed()))
    I('shutdown', 'Enable/disable an interface', (i) => this.shut(i, true))
    I('no shutdown', 'Enable/disable an interface', (i) => this.shut(i, false))
    I('switchport', 'Configure switchport parameters', (i) => {
      if (R.kind(i) !== 'eth' && R.kind(i) !== 'po') return `ERROR: ${i.name}: switchport not supported`
      if (i.mode === 'routed') Object.assign(i, { mode: 'access', vlan: 1, ip: undefined, mask: undefined, vrf: undefined })
      return changed()
    })
    I('no switchport', 'Configure switchport parameters', (i) => {
      if (R.kind(i) !== 'eth' && R.kind(i) !== 'po') return ''
      Object.assign(i, { mode: 'routed', vlan: undefined, trunkAllowed: undefined, nativeVlan: undefined })
      return changed()
    })
    I('switchport mode', 'Enter the port mode', undefined, { children: ['access', 'trunk'].map((m) => kw(m, m === 'access' ? 'Port mode access' : 'Port mode trunk', { run: (c) => this.eachIf((i) => { if (!l2(i)) return `ERROR: ${i.name}: requested config change not allowed`; i.mode = m as 'access'; if (m === 'trunk') i.nativeVlan ??= 1; else i.vlan ??= 1; void c; return changed() }) })) })
    I('switchport access vlan', 'Set VLAN when interface is in access mode', undefined, { children: [leaf(int(1, 4094), 'VLAN ID of the VLAN when this port is in access mode', 'vl', (i, c) => { if (!l2(i)) return `ERROR: ${i.name}: requested config change not allowed`; i.vlan = Number(c.args['vl']); return changed() })] })
    I('no switchport access vlan', 'Set VLAN when interface is in access mode', (i) => ((i.vlan = 1), changed()))
    const allowed = (op: 'set' | 'add' | 'remove' | 'except') => (i: Iface, c: Ctx): string => {
      const v = expandVlans(c.args['vl']!)
      const all = Array.from({ length: 4094 }, (_, n) => n + 1)
      const cur = i.trunkAllowed ?? all
      i.trunkAllowed = op === 'set' ? v : op === 'add' ? [...new Set([...cur, ...v])].sort((a, b) => a - b) : op === 'remove' ? cur.filter((x) => !v.includes(x)) : all.filter((x) => !v.includes(x))
      if (i.trunkAllowed.length === 4094) i.trunkAllowed = undefined
      // A port-channel's trunk config is inherited by its members.
      if (R.kind(i) === 'po') for (const m of R.members(cd(), i)) m.trunkAllowed = i.trunkAllowed ? [...i.trunkAllowed] : undefined
      return changed()
    }
    const vlP: Param = { kind: 'vlanlist', label: '<1-4094>' }
    I('switchport trunk allowed vlan', 'Set allowed VLAN characteristics when interface is in trunking mode', undefined, {
      children: [
        leaf(vlP, 'VLAN IDs of the allowed VLANs when this port in trunking mode', 'vl', allowed('set')),
        kw('add', 'Add VLANs to the current list', { children: [leaf(vlP, 'VLAN IDs', 'vl', allowed('add'))] }),
        kw('remove', 'Remove VLANs from the current list', { children: [leaf(vlP, 'VLAN IDs', 'vl', allowed('remove'))] }),
        kw('except', 'All VLANs except the following', { children: [leaf(vlP, 'VLAN IDs', 'vl', allowed('except'))] }),
        kw('all', 'All VLANs', { run: () => this.eachIf((i) => ((i.trunkAllowed = undefined), changed())) }),
        kw('none', 'No VLANs', { run: () => this.eachIf((i) => ((i.trunkAllowed = []), changed())) })
      ]
    }, )
    I('no switchport trunk allowed vlan', 'Set allowed VLAN characteristics', (i) => ((i.trunkAllowed = undefined), changed()))
    I('switchport trunk native vlan', 'Set native VLAN when interface is in trunking mode', undefined, { children: [leaf(int(1, 4094), 'VLAN ID of the native VLAN when this port is in trunking mode', 'vl', (i, c) => ((i.nativeVlan = Number(c.args['vl'])), changed()))] })
    I('ip address', 'Configure IP address on interface', undefined, {
      children: [
        prm({ kind: 'prefix', label: 'A.B.C.D/LEN' }, 'IP prefix and network mask length in format x.x.x.x/m', { name: 'pfx', run: (c) => this.setIp(c, c.args['pfx']!), children: [kw('secondary', 'Configure additional IP addresses on interface', { run: () => changed() })] }),
        prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'IP address', { name: 'ip', children: [prm({ kind: 'mask', label: 'A.B.C.D' }, 'IP network mask', { name: 'mask', run: (c) => this.setIp(c, `${c.args['ip']}/${dottedToLen(c.args['mask']!)}`) })] }),
        kw('dhcp', 'IP Address negotiated via DHCP', { run: () => changed() })
      ]
    })
    I('no ip address', 'Configure IP address on interface', (i) => ((i.ip = undefined), (i.mask = undefined), changed()))
    I('mtu', 'Configure mtu for the port', undefined, { children: [leaf(int(576, 9216), 'Enter MTU', 'mtu', (i, c) => this.setMtu(i, Number(c.args['mtu'])))] })
    I('no mtu', 'Configure mtu for the port', (i) => this.setMtu(i, 1500))
    I('vrf member', 'Assign the interface to a VRF', undefined, {
      children: [
        leaf({ kind: 'word', label: 'WORD', values: () => cd().vrfs.map((v) => v.name) }, 'VRF name', 'vrf', (i, c) => {
          const name = c.args['vrf']!
          if (name !== 'default' && !cd().vrfs.some((v) => v.name === name)) return `% VRF ${name} not found. Please create VRF first`
          const had = !!i.ip
          i.vrf = name === 'default' ? undefined : name
          i.ip = undefined
          i.mask = undefined
          if (cd().ospf) cd().ospf!.ifaces = cd().ospf!.ifaces.filter((o) => o.iface !== i.name)
          return changed(had ? `Warning: Deleted all L3 config on interface ${i.name}` : '')
        })
      ]
    })
    I('no vrf member', 'Assign the interface to a VRF', undefined, { children: [leaf({ kind: 'word', label: 'WORD' }, 'VRF name', 'vrf', (i) => { const had = !!i.ip; Object.assign(i, { vrf: undefined, ip: undefined, mask: undefined }); return changed(had ? `Warning: Deleted all L3 config on interface ${i.name}` : '') })] })
    if (R.feature(cd(), 'ospf')) {
      const ospfIf = (i: Iface): NonNullable<Device['ospf']>['ifaces'][number] => {
        const d = cd()
        d.ospf ??= { process: '1', ifaces: [], neighbors: [] }
        let o = d.ospf.ifaces.find((x) => x.iface === i.name)
        if (!o) d.ospf.ifaces.push((o = { iface: i.name, area: '0.0.0.0' }))
        return o
      }
      const area = (a: string): string => (/^\d+$/.test(a) ? [24, 16, 8, 0].map((s) => (Number(a) >>> s) & 255).join('.') : a)
      I('ip router ospf', 'OSPF', undefined, { children: [prm({ kind: 'word', label: 'WORD' }, 'Instance tag', { name: 'tag', children: [kw('area', 'Configure area', { children: [leaf({ kind: 'word', label: 'A.B.C.D or <0-4294967295>' }, 'Area ID', 'area', (i, c) => { const o = ospfIf(i); o.area = area(c.args['area']!); if (!cd().ospf!.process || cd().ospf!.ifaces.length === 1) cd().ospf!.process = c.args['tag']!; return changed() })] })] })] })
      I('no ip router ospf', 'OSPF', undefined, { children: [prm(line, 'Instance tag and area', { run: (c) => this.eachIf((i) => { if (cd().ospf) cd().ospf!.ifaces = cd().ospf!.ifaces.filter((o) => o.iface !== i.name); void c; return changed() }) })] })
      I('ip ospf network', 'Network type', undefined, { children: ['broadcast', 'point-to-point'].map((n) => kw(n, `Specify OSPF ${n} network`, { run: () => this.eachIf((i) => ((ospfIf(i).networkType = n as 'broadcast'), changed())) })) })
      I('ip ospf cost', 'Cost associated with interface', undefined, { children: [leaf(int(1, 65535), 'Cost', 'cost', (i, c) => ((ospfIf(i).cost = Number(c.args['cost'])), changed()))] })
      I('ip ospf mtu-ignore', 'Disable OSPF MTU mismatch detection', (i) => ((ospfIf(i).mtuIgnore = true), changed()))
      I('no ip ospf mtu-ignore', 'Disable OSPF MTU mismatch detection', (i) => ((ospfIf(i).mtuIgnore = false), changed()))
      I('ip ospf passive-interface', 'Suppress routing updates on the interface', (i) => ((ospfIf(i).passive = true), changed()))
      I('no ip ospf passive-interface', 'Suppress routing updates on the interface', (i) => ((ospfIf(i).passive = false), changed()))
    }
    I('ip access-group', 'Specify access control for packets', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => cd().acls.map((a) => a.name) }, 'List name', {
          name: 'acl',
          children: ['in', 'out'].map((dir) => kw(dir, `${dir === 'in' ? 'Inbound' : 'Outbound'} packets`, { run: (c) => this.eachIf((i) => { const x = i as NxIface; x.nxAcl = { ...x.nxAcl, [dir]: c.args['acl'] }; return changed() }) }))
        })
      ]
    })
    I('no ip access-group', 'Specify access control for packets', undefined, { children: [prm({ kind: 'word', label: 'WORD' }, 'List name', { children: ['in', 'out'].map((dir) => kw(dir, `${dir === 'in' ? 'Inbound' : 'Outbound'} packets`, { run: () => this.eachIf((i) => { const x = i as NxIface; if (x.nxAcl) delete x.nxAcl[dir as 'in']; return changed() }) })) })] })
    I('speed', 'Enter the port speed', undefined, { children: [leaf({ kind: 'enum', label: '<speed>', values: () => ['100', '1000', '10000', '25000', '40000', '100000', 'auto'] }, 'Speed in Mbps or auto', 's', (i, c) => { const s = c.args['s']!; i.speedSet = s === 'auto' ? undefined : Number(s) >= 1000 && Number(s) % 1000 === 0 && Number(s) >= 10000 ? `${Number(s) / 1000}G` : s; return changed() })] })
    I('no speed', 'Enter the port speed', (i) => ((i.speedSet = undefined), changed()))
    I('duplex', 'Enter the port duplex mode', undefined, { children: ['auto', 'full', 'half'].map((m) => kw(m, `${m} duplex`, { run: () => this.eachIf((i) => { i.duplex = m as 'full'; if (i.peer?.duplex) i.faultSince = now(this.d); return changed() }) })) })
    I('no duplex', 'Enter the port duplex mode', (i) => ((i.duplex = undefined), changed()))
    I('channel-group', 'Configure port channel parameters', undefined, {
      children: [
        prm(int(1, 4096), 'Channel group number', {
          name: 'cg',
          run: (c) => this.channelGroup(c),
          children: [kw('mode', 'Channel group mode', { children: ['active', 'passive', 'on'].map((m) => kw(m, `Set channeling mode to ${m.toUpperCase()}`, { run: (c) => (m !== 'on' && !R.feature(cd(), 'lacp') ? `${this.caret(c.line.indexOf(c.tokens.at(-1)!))}\n% Invalid command at '^' marker.` : this.channelGroup(c)) })) })]
        })
      ]
    })
    I('no channel-group', 'Configure port channel parameters', (i) => ((i.channelGroup = undefined), changed()))
    I('spanning-tree port type edge', 'Consider the interface as edge port', () => changed(), {}, )
    I('spanning-tree bpduguard', 'Don\'t accept BPDUs on this interface', undefined, { children: ['enable', 'disable'].map((m) => kw(m, `${m} BPDU guard`, { run: () => this.eachIf((i) => ((i.bpduGuard = m === 'enable'), changed())) })) })
    I('no spanning-tree bpduguard', 'Don\'t accept BPDUs on this interface', (i) => ((i.bpduGuard = false), changed()))
    void ipOnL2
    ifm.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return generic(ifm, 'Exit from command interpreter')
  }

  private setIp(c: Ctx, pfx: string): string {
    return this.eachIf((i) => {
      const k = R.kind(i)
      if ((k === 'eth' || k === 'po') && i.mode !== 'routed') return `${this.caret(c.line.indexOf(c.tokens[0]!))}\n% Invalid command at '^' marker.`
      const [ip, len] = pfx.split('/')
      const clash = this.c.interfaces.find((x) => x !== i && x.ip === ip && (x.vrf ?? '') === (i.vrf ?? ''))
      if (clash) return `% ${ip}/${len} overlaps with address configured on ${clash.short}`
      i.ip = ip
      i.mask = Number(len)
      return this.changed()
    })
  }

  private setMtu(i: Iface, mtu: number): string {
    const k = R.kind(i)
    if (k === 'eth' && i.mode !== 'routed' && mtu !== 1500 && mtu !== 9216) return `ERROR: ${i.name}: MTU on L2 interfaces can only be set to default or system-jumboMTU`
    i.mtu = mtu === 1500 ? undefined : mtu
    return this.changed()
  }

  private channelGroup(c: Ctx): string {
    const d = this.c
    const n = Number(c.args['cg'])
    let po = d.interfaces.find((x) => x.name === `port-channel${n}`)
    return this.eachIf((i) => {
      if (R.kind(i) !== 'eth') return `ERROR: ${i.name}: channel-group not supported`
      if (!po) {
        po = { name: `port-channel${n}`, short: `Po${n}`, adminUp: true, linkUp: true, mode: i.mode, vlan: i.vlan, nativeVlan: i.nativeVlan, trunkAllowed: i.trunkAllowed ? [...i.trunkAllowed] : undefined, speed: i.speed, mac: i.mac }
        d.interfaces.push(po)
      }
      i.channelGroup = n
      return this.changed()
    })
  }

  // ---------------------------------------------------------------- BGP

  private bgpTrees(generic: (more: Node[], exitHelp?: string) => Node[], changed: (v?: string) => string): Record<string, Node[]> {
    const cd = (): Device => this.c
    const line: Param = { kind: 'line', label: 'LINE' }
    const ipP: Param = { kind: 'ipv4', label: 'A.B.C.D', values: () => cd().bgp.map((n) => n.ip) }
    const asP: Param = { kind: 'asn', label: '<1-4294967295>' }
    const nctx = (): NbrCtx => this.mode.ctx as NbrCtx
    const nbr = (): BgpNeighbor | undefined => cd().bgp.find((n) => n.ip === nctx().ip && (n.vrf ?? undefined) === nctx().vrf)
    const need = (f: (n: BgpNeighbor) => string): string => {
      const n = nbr()
      return n ? f(n) : `% Remote AS not configured for neighbor ${nctx().ip}`
    }
    const log = (n: BgpNeighbor, why: string): void => {
      if (this.c === this.d && n.upSince !== undefined && n.upSince <= now(this.d)) logEvent(this.d, `%BGP-5-ADJCHANGE:  bgp-${this.d.localAs} [11502] (${n.vrf ?? 'default'}) neighbor ${n.ip} Down - ${why}`)
    }
    const enterNbr = (vrf: string | undefined, mode: string) => (c: Ctx): string => {
      const ip = c.args['nb']!
      if (c.args['as']) {
        const as = Number(c.args['as'])
        let n = cd().bgp.find((x) => x.ip === ip && (x.vrf ?? undefined) === vrf)
        if (!n) {
          const via = cd().interfaces.find((i) => i.ip && i.mask !== undefined && i.mask < 32 && (i.vrf ?? undefined) === vrf && ipIn(ip, i.ip, i.mask))
          n = { ip, remoteAs: as, via: via?.name ?? 'loopback0', prefixes: 0, ...(vrf ? { vrf } : {}) }
          cd().bgp.push(n)
        } else if (n.remoteAs !== as) {
          log(n, 'sent:  peer de-configured')
          n.remoteAs = as
          n.upSince = undefined
        }
      }
      this.setMode(mode, { ip, vrf } satisfies NbrCtx, this.mode)
      return changed()
    }
    const nbrNodes = (vrf: () => string | undefined, mode: string): Node[] => [
      kw('neighbor', 'Configure a BGP neighbor', { children: [prm(ipP, 'IP address of the neighbor', { name: 'nb', run: (c) => enterNbr(vrf(), mode)(c), children: [kw('remote-as', 'Specify Autonomous System Number of the neighbor', { children: [prm(asP, 'Autonomous System Number', { name: 'as', run: (c) => enterNbr(vrf(), mode)(c) })] })] })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('neighbor', 'Configure a BGP neighbor', {
            children: [
              prm(ipP, 'IP address of the neighbor', {
                name: 'nb',
                run: (c) => {
                  const n = cd().bgp.find((x) => x.ip === c.args['nb'] && (x.vrf ?? undefined) === vrf())
                  if (!n) return `% Neighbor ${c.args['nb']} not found`
                  log(n, 'sent:  peer de-configured')
                  cd().bgp = cd().bgp.filter((x) => x !== n)
                  return changed()
                }
              })
            ]
          })
        ]
      })
    ]
    const bgpm = generic([
      kw('router-id', 'Specify the IP address to use as router-id', { children: [prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'IP address', { name: 'rid', run: (c) => ((cd().routerId = c.args['rid']!), changed()) })] }),
      kw('log-neighbor-changes', 'Log a message for neighbor up/down event', { run: () => changed() }),
      kw('address-family', 'Configure an address-family', { children: [kw('ipv4', 'Configure an IPv4 address-family', { children: [kw('unicast', 'Configure unicast address-family', { run: () => (this.setMode('config-router-af', undefined, this.mode), '') })] })] }),
      kw('vrf', 'Virtual Router Context', { children: [prm({ kind: 'word', label: 'WORD', values: () => cd().vrfs.map((v) => v.name) }, 'VRF name', { name: 'vrf', run: (c) => (cd().vrfs.some((v) => v.name === c.args['vrf']) ? (this.setMode('config-router-vrf', c.args['vrf'], this.mode), '') : `% VRF ${c.args['vrf']} not found`) })] }),
      kw('timers', 'Configure bgp related timers', { children: [kw('bgp', 'Set different bgp keepalive and holdtimes', { children: [prm(line, 'Keepalive and holdtime', { run: () => changed() })] })] }),
      ...nbrNodes(() => undefined, 'config-router-neighbor')
    ])
    const vrfm = generic([
      kw('address-family', 'Configure an address-family', { children: [kw('ipv4', 'Configure an IPv4 address-family', { children: [kw('unicast', 'Configure unicast address-family', { run: () => (this.setMode('config-router-af', undefined, this.mode), '') })] })] }),
      ...nbrNodes(() => this.mode.ctx as string, 'config-router-neighbor')
    ])
    const afm = generic([
      kw('network', 'Configure an IP prefix to advertise', { children: [prm({ kind: 'prefix', label: 'A.B.C.D/LEN' }, 'IP prefix', { run: () => changed() })] }),
      kw('maximum-paths', 'Forward packets over multiple paths', { children: [prm({ kind: 'int', label: '<1-64>', min: 1, max: 64 }, 'Number of parallel paths', { run: () => changed() })] }),
      kw('redistribute', 'Configure redistribution', { children: [prm(line, 'Source protocol and route-map', { run: () => changed() })] })
    ])
    const nm = generic([
      kw('remote-as', 'Specify Autonomous System Number of the neighbor', {
        children: [
          prm(asP, 'Autonomous System Number', {
            name: 'as',
            run: (c) => {
              const as = Number(c.args['as'])
              const n = nbr()
              if (!n) {
                const { ip, vrf } = nctx()
                const via = cd().interfaces.find((i) => i.ip && i.mask !== undefined && i.mask < 32 && (i.vrf ?? undefined) === vrf && ipIn(ip, i.ip, i.mask))
                cd().bgp.push({ ip, remoteAs: as, via: via?.name ?? 'loopback0', prefixes: 0, ...(vrf ? { vrf } : {}) })
              } else if (n.remoteAs !== as) {
                log(n, 'sent:  peer de-configured')
                n.remoteAs = as
                n.upSince = undefined
              }
              return changed()
            }
          })
        ]
      }),
      kw('description', 'Neighbor specific descripion', { children: [prm(line, 'Description of the neighbor (Max Size 80)', { name: 'desc', run: (c) => need((n) => ((n.description = c.args['desc']), changed())) })] }),
      kw('shutdown', 'Administratively shutdown this neighbor', { run: () => need((n) => { if (!n.shutdown) log(n, 'sent:  administratively shutdown'); n.shutdown = true; return changed() }) }),
      kw('update-source', 'Specify source of BGP session and updates', { children: [prm(this.ifParam(), 'Interface', { name: 'us', run: (c) => need((n) => ((n.updateSource = this.ifOf(c, 'us', cd())?.name), changed())) })] }),
      kw('password', 'Configure a password for neighbor', { children: [prm(line, 'Authentication password', { name: 'pw', run: (c) => need((n) => ((n.password = c.args['pw']!.replace(/^[037]\s+/, '')), changed())) })] }),
      kw('ebgp-multihop', 'Specify multihop TTL for remote peer', { children: [prm({ kind: 'int', label: '<2-255>', min: 2, max: 255 }, 'TTL', { run: () => changed() })] }),
      kw('timers', 'Configure keepalive and hold timers', { children: [prm(line, 'Keepalive and hold time', { run: () => changed() })] }),
      kw('address-family', 'Configure an address-family', { children: [kw('ipv4', 'Configure an IPv4 address-family', { children: [kw('unicast', 'Configure unicast address-family', { run: () => (nbr() ? (this.setMode('config-router-neighbor-af', this.mode.ctx, this.mode), '') : `% Remote AS not configured for neighbor ${nctx().ip}`) })] })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('shutdown', 'Administratively shutdown this neighbor', { run: () => need((n) => ((n.shutdown = false), changed())) }),
          kw('description', 'Neighbor specific descripion', { run: () => need((n) => ((n.description = undefined), changed())) }),
          kw('password', 'Configure a password for neighbor', { run: () => need((n) => ((n.password = undefined), changed())) }),
          kw('update-source', 'Specify source of BGP session and updates', { run: () => need((n) => ((n.updateSource = undefined), changed())) })
        ]
      })
    ])
    const rmP: Param = { kind: 'word', label: 'WORD', values: () => cd().routeMaps.map((r) => r.name) }
    const nafm = generic([
      kw('route-map', 'Apply route-map to neighbor', { children: [prm(rmP, 'Name of route-map', { name: 'rm', children: ['in', 'out'].map((dir) => kw(dir, `Apply route-map to ${dir === 'in' ? 'incoming' : 'outgoing'} routes`, { run: (c) => need((n) => { if (dir === 'in') n.routeMapIn = c.args['rm']; else n.routeMapOut = c.args['rm']; return changed() }) })) })] }),
      kw('send-community', 'Send Community attribute to this neighbor', { run: () => changed(), children: [kw('extended', 'Send Extended Community attribute', { run: () => changed() })] }),
      kw('soft-reconfiguration', 'Configure soft reconfiguration', { children: [kw('inbound', 'Allow inbound soft reconfiguration', { run: () => changed() })] }),
      kw('next-hop-self', 'Set our address as nexthop', { run: () => changed() }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('route-map', 'Apply route-map to neighbor', { children: [prm(rmP, 'Name of route-map', { name: 'rm', children: ['in', 'out'].map((dir) => kw(dir, 'Direction', { run: () => need((n) => { if (dir === 'in') n.routeMapIn = undefined; else n.routeMapOut = undefined; return changed() }) })) })] })] })
    ])
    return { 'config-router-bgp': bgpm, 'config-router-vrf': vrfm, 'config-router-af': afm, 'config-router-neighbor': nm, 'config-router-neighbor-af': nafm }
  }
}

type NxosCheckpoint = ReturnType<typeof store>['checkpoints'][number]

function ipIn(ip: string, net: string, mask: number): boolean {
  const n = (s: string): number => s.split('.').reduce((a, o) => a * 256 + Number(o), 0)
  const size = 2 ** (32 - mask)
  return Math.floor(n(ip) / size) === Math.floor(n(net) / size)
}

const lpad = (s: string | number, n: number): string => String(s).padStart(n)

/** Split `cmd1 ; cmd2` outside quotes (doc §1: NX-OS chains commands with `;`). */
export function splitChain(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = ''
  for (const ch of raw) {
    if (q) {
      if (ch === q) q = ''
      cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

export const nxosFactory = (s: Session): NxosPersonality => new NxosPersonality(s)
