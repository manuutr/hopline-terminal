/**
 * Fortinet FortiOS personality (docs/research/cli-fortinet-fortios.md): `host # ` prompt, a
 * `config <table>` / `edit <key>` context stack shown as `host (<innermost>) # `, set / unset /
 * append / next / end / abort with immediate apply on next/end (no candidate), `get` / `show` /
 * `diagnose` / `execute` verbs with unique-prefix abbreviation, `command parse error before` and
 * `Command fail. Return code N` errors without a caret, `| grep` pipes, the `--More--` pager that
 * only `config system console` / `set output standard` turns off, Tab cycling, and Ctrl-C that
 * aborts a config block or, at the top level, closes the session.
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { now } from '../../core/runtime.ts'
import { inSubnet, safeRegex, splitPipes } from '../../core/text.ts'
import { add, completions, help as treeHelp, isIpv4, kw, match, maskToDotted, prm, tokenize, type Handler, type Node, type Param } from '../../core/tree.ts'
import { tokenizeConf, unq } from '../junos/conf.ts'
import { isUp, logEvent, tickBgp, type Device, type Iface } from '../../state.ts'
import type { FRecord } from '../../devices/fortios.ts'
import * as R from './render.ts'

export const FORTIOS_PAGER: PagerSpec = {
  text: () => '--More--',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'ignore'
}

const parseErr = (tok: string): string => `command parse error before '${tok}'\nCommand fail. Return code -61`
const valueErr = (tok: string): string => `value parse error before '${tok}'\nCommand fail. Return code -651`
const notFound = (tok: string): string => `entry not found in datasource\n\nvalue parse error before '${tok}'\nCommand fail. Return code -3`

type FKind = 'str' | 'var' | 'enum' | 'opts' | 'ipmask' | 'int' | 'uuid'
type Ref = 'iface' | 'addr' | 'service' | 'schedule'

interface FField {
  name: string
  help: string
  kind: FKind
  multi?: boolean
  enums?: [string, string][]
  ref?: Ref
  def?: string
  required?: boolean
  min?: number
  max?: number
}

interface FTable {
  path: string
  label: string
  help: string
  single?: boolean
  numeric?: boolean
  fields: FField[]
  rows: () => { key: string; rec: FRecord }[]
  /** Save an entry; returns an error text. */
  save: (key: string, rec: FRecord, isNew: boolean) => string | undefined
  remove?: (key: string) => string | undefined
  /** Fields set on a new entry. */
  init?: (key: string) => FRecord
}

type Frame = { kind: 'table'; t: FTable } | { kind: 'entry'; t: FTable; key: string; rec: FRecord; isNew: boolean }

const SERVICES = ['ALL', 'ALL_TCP', 'ALL_UDP', 'ALL_ICMP', 'DNS', 'HTTP', 'HTTPS', 'NTP', 'PING', 'SSH', 'SNMP', 'SMTP', 'BGP']
const ACCESS: [string, string][] = [['ping', 'PING access.'], ['https', 'HTTPS access.'], ['ssh', 'SSH access.'], ['snmp', 'SNMP access.'], ['http', 'HTTP access.'], ['telnet', 'TELNET access.'], ['fgfm', 'FortiManager access.'], ['radius-acct', 'RADIUS accounting access.'], ['probe-response', 'Probe access.'], ['fabric', 'Security Fabric access.'], ['ftm', 'FTM access.']]
const ED: [string, string][] = [['enable', 'Enable setting.'], ['disable', 'Disable setting.']]

export class FortiosPersonality implements Personality {
  pager = FORTIOS_PAGER
  abortKeys = ['\x03']
  private readonly s: Session
  private readonly d: Device
  private stack: Frame[] = []
  private top: Node[]
  private tables: FTable[]
  private filter: R.SessFilter = {}
  private consoleApplied: string | undefined
  private cycle: { shown: string; base: string; cands: string[]; idx: number } | undefined

  constructor(s: Session) {
    this.s = s
    this.d = s.d
    this.tables = this.buildTables()
    this.top = this.buildTop()
    this.applyConsole()
  }

  private applyConsole(): void {
    const out = R.fdata(this.d).console.output
    if (out === this.consoleApplied) return
    this.consoleApplied = out
    this.s.pageLength = out === 'standard' ? 0 : this.s.rows - 1
  }

  banner(): string {
    return this.d.motd ? `${this.d.motd}\n` : ''
  }

  prompt(_reason: PromptReason): string {
    const f = this.stack.at(-1)
    if (!f) return `${this.d.hostname} # `
    const label = f.kind === 'entry' && !f.t.single ? f.key : f.t.label
    return `${this.d.hostname} (${label}) # `
  }

  // ------------------------------------------------------------------ tables

  private buildTables(): FTable[] {
    const d = this.d
    const fd = (): ReturnType<typeof R.fdata> => R.fdata(d)
    const uuid = (): string => {
      const n = fd().uuidSeq++
      const h = (n * 2654435761 >>> 0).toString(16).padStart(8, '0')
      return `${h}-7b3c-51ef-${(n + 0x1000).toString(16).slice(-4)}-${h}${h.slice(0, 4)}`
    }
    const ifFields: FField[] = [
      { name: 'vrf', help: 'Virtual routing and forwarding instance.', kind: 'int', min: 0, max: 251, def: '0' },
      { name: 'vdom', help: 'Interface is in this virtual domain (VDOM).', kind: 'str' },
      { name: 'mode', help: 'Addressing mode (static, DHCP, PPPoE).', kind: 'enum', enums: [['static', 'Static setting.'], ['dhcp', 'External DHCP client mode.'], ['pppoe', 'External PPPoE mode.']], def: 'static' },
      { name: 'ip', help: 'Interface IPv4 address and subnet mask, syntax: X.X.X.X/24.', kind: 'ipmask' },
      { name: 'allowaccess', help: 'Permitted types of management access to this interface.', kind: 'opts', enums: ACCESS },
      { name: 'status', help: 'Bring the interface up or shut the interface down.', kind: 'enum', enums: [['up', 'Interface up.'], ['down', 'Interface down.']], def: 'up' },
      { name: 'type', help: 'Interface type.', kind: 'enum', enums: [['physical', 'Physical interface.'], ['vlan', 'VLAN interface.'], ['aggregate', 'Aggregate interface.'], ['redundant', 'Redundant interface.'], ['tunnel', 'Tunnel interface.'], ['loopback', 'Loopback interface.']] },
      { name: 'alias', help: 'Alias will be displayed with the interface name to make it easier to distinguish.', kind: 'str' },
      { name: 'description', help: 'Description.', kind: 'var' },
      { name: 'role', help: 'Interface role.', kind: 'enum', enums: [['lan', 'Connected to local network of endpoints.'], ['wan', 'Connected to Internet.'], ['dmz', 'Connected to server zone.'], ['undefined', 'Interface has no specific role.']], def: 'undefined' },
      { name: 'lldp-reception', help: 'Enable/disable Link Layer Discovery Protocol (LLDP) reception.', kind: 'enum', enums: [['enable', 'Enable reception of LLDP messages.'], ['disable', 'Disable reception of LLDP messages.'], ['vdom', 'Use VDOM LLDP reception configuration setting.']], def: 'vdom' },
      { name: 'snmp-index', help: 'Permanent SNMP Index of the interface.', kind: 'int', min: 0, max: 2147483647 },
      { name: 'interface', help: 'Interface name.', kind: 'str', ref: 'iface' },
      { name: 'vlanid', help: 'VLAN ID (1 - 4094).', kind: 'int', min: 1, max: 4094 },
      { name: 'mtu-override', help: 'Enable to set a custom MTU for this interface.', kind: 'enum', enums: ED, def: 'disable' },
      { name: 'mtu', help: 'MTU value for this interface.', kind: 'int', min: 68, max: 9216 }
    ]
    const MODEL = new Set(['ip', 'allowaccess', 'status', 'alias', 'description', 'vrf'])
    const ifRec = (i: Iface): FRecord => {
      const ex = fd().ifExtra[i.name] ?? []
      const m = new Map<string, string>(ex)
      if (!m.has('vdom')) m.set('vdom', '"root"')
      if (i.vrf) m.set('vrf', i.vrf)
      if (i.ip) m.set('ip', `${i.ip} ${maskToDotted(i.mask ?? 32)}`)
      if (i.allowaccess?.length) m.set('allowaccess', i.allowaccess.join(' '))
      if (!i.adminUp) m.set('status', 'down')
      if (i.alias !== undefined) m.set('alias', `"${i.alias}"`)
      if (i.description !== undefined) m.set('description', `"${i.description}"`)
      if (!m.has('type')) m.set('type', i.speed ? 'physical' : 'vlan')
      return ifFields.filter((f) => m.has(f.name)).map((f) => [f.name, m.get(f.name)!] as [string, string])
    }
    const iface: FTable = {
      path: 'system interface',
      label: 'interface',
      help: 'Configure interfaces.',
      fields: ifFields,
      rows: () => d.interfaces.map((i) => ({ key: i.name, rec: ifRec(i) })),
      init: () => [['vdom', '"root"']],
      save: (key, rec, isNew) => {
        const get = (k: string): string | undefined => rec.find(([f]) => f === k)?.[1]
        const type = get('type')
        if (isNew) {
          if (key === 'default') return `The input 'default' can't be interface name.\nnode_check_object fail! for name default\nCommand fail. Return code -651`
          if (!type) return "Attribute 'type' MUST be set.\nCommand fail. Return code 1"
          if (type === 'vlan' && !get('interface')) return "Attribute 'interface' MUST be set.\nCommand fail. Return code 1"
          if (type === 'vlan' && !get('vlanid')) return "Attribute 'vlanid' MUST be set.\nCommand fail. Return code 1"
          if (type === 'physical') return `node_check_object fail! for name ${key}\nCommand fail. Return code -651`
        }
        let i = d.interfaces.find((x) => x.name === key)
        if (!i) {
          const parent = d.interfaces.find((x) => x.name === unq(get('interface') ?? ''))
          i = { name: key, short: key, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: parent?.mac ?? '00:0c:29:4f:2e:ff', lastChange: now(d) }
          if (type === 'vlan') i.vlan = Number(get('vlanid'))
          d.interfaces.push(i)
        }
        const ip = get('ip')
        if (ip) {
          const [a, m] = ip.split(' ')
          i.ip = a === '0.0.0.0' ? undefined : a
          i.mask = a === '0.0.0.0' ? undefined : maskLen(m!)
        } else {
          i.ip = undefined
          i.mask = undefined
        }
        i.vrf = get('vrf')
        i.allowaccess = get('allowaccess')?.split(' ') ?? []
        const was = i.adminUp
        i.adminUp = get('status') !== 'down'
        if (was !== i.adminUp) {
          i.lastChange = now(d)
          logEvent(d, `Interface ${key} ${i.adminUp ? 'up' : 'down'} by admin`)
        }
        const al = get('alias')
        i.alias = al === undefined ? undefined : unq(al)
        const de = get('description')
        i.description = de === undefined ? undefined : unq(de)
        fd().ifExtra[key] = rec.filter(([f]) => !MODEL.has(f))
        tickBgp(d)
        return undefined
      },
      remove: (key) => {
        const i = d.interfaces.find((x) => x.name === key)
        if (!i) return `entry not found in datasource\nCommand fail. Return code -3`
        if (R.ifType(d, i) === 'physical') return 'Command fail. Return code -23'
        if (fd().policies.some((p) => p.rec.some(([f, v]) => (f === 'srcintf' || f === 'dstintf') && v.includes(`"${key}"`)))) return 'Command fail. Return code -23'
        d.interfaces = d.interfaces.filter((x) => x !== i)
        delete fd().ifExtra[key]
        return undefined
      }
    }
    const polFields: FField[] = [
      { name: 'name', help: 'Policy name.', kind: 'str' },
      { name: 'uuid', help: 'Universally Unique Identifier (UUID; automatically assigned but can be manually reset).', kind: 'uuid' },
      { name: 'srcintf', help: 'Incoming (ingress) interface.', kind: 'str', multi: true, ref: 'iface', required: true },
      { name: 'dstintf', help: 'Outgoing (egress) interface.', kind: 'str', multi: true, ref: 'iface', required: true },
      { name: 'action', help: 'Policy action (accept/deny/ipsec).', kind: 'enum', enums: [['accept', 'Allows session that matches the firewall policy.'], ['deny', 'Blocks sessions that match the firewall policy.'], ['ipsec', 'Firewall policy becomes a policy-based IPsec VPN policy.']], def: 'deny' },
      { name: 'srcaddr', help: 'Source IPv4 address and address group names.', kind: 'str', multi: true, ref: 'addr', required: true },
      { name: 'dstaddr', help: 'Destination IPv4 address and address group names.', kind: 'str', multi: true, ref: 'addr', required: true },
      { name: 'schedule', help: 'Schedule name.', kind: 'str', ref: 'schedule', required: true },
      { name: 'service', help: 'Service and service group names.', kind: 'str', multi: true, ref: 'service', required: true },
      { name: 'logtraffic', help: 'Enable or disable logging. Log all sessions or security profile sessions.', kind: 'enum', enums: [['all', 'Log all sessions accepted or denied by this policy.'], ['utm', 'Log traffic that has a security profile applied to it.'], ['disable', 'Disable all logging for this policy.']], def: 'utm' },
      { name: 'nat', help: 'Enable/disable source NAT.', kind: 'enum', enums: ED, def: 'disable' },
      { name: 'status', help: 'Enable or disable this policy.', kind: 'enum', enums: ED, def: 'enable' },
      { name: 'comments', help: 'Comment.', kind: 'var' }
    ]
    const policy: FTable = {
      path: 'firewall policy',
      label: 'policy',
      help: 'Configure IPv4/IPv6 policies.',
      numeric: true,
      fields: polFields,
      rows: () => fd().policies.map((p) => ({ key: String(p.id), rec: p.rec })),
      init: () => [['uuid', uuid()]],
      save: (key, rec) => {
        for (const f of polFields) if (f.required && !rec.some(([n]) => n === f.name)) return `Attribute '${f.name}' MUST be set.\nCommand fail. Return code 1`
        const id = Number(key)
        const p = fd().policies.find((x) => x.id === id)
        if (p) p.rec = rec
        else fd().policies.push({ id, rec })
        return undefined
      },
      remove: (key) => {
        const before = fd().policies.length
        fd().policies = fd().policies.filter((p) => String(p.id) !== key)
        return fd().policies.length === before ? 'entry not found in datasource\nCommand fail. Return code -3' : undefined
      }
    }
    const addrFields: FField[] = [
      { name: 'uuid', help: 'Universally Unique Identifier (UUID; automatically assigned but can be manually reset).', kind: 'uuid' },
      { name: 'type', help: 'Type of address.', kind: 'enum', enums: [['ipmask', 'Standard IPv4 address with subnet mask.'], ['iprange', 'Range of IPv4 addresses between two specified addresses (inclusive).'], ['fqdn', 'Fully Qualified Domain Name address.']], def: 'ipmask' },
      { name: 'subnet', help: 'IP address and subnet mask of address.', kind: 'ipmask' },
      { name: 'fqdn', help: 'Fully Qualified Domain Name address.', kind: 'str' },
      { name: 'associated-interface', help: 'Network interface associated with address.', kind: 'str', ref: 'iface' },
      { name: 'comment', help: 'Comment.', kind: 'var' }
    ]
    const address: FTable = {
      path: 'firewall address',
      label: 'address',
      help: 'Configure IPv4 addresses.',
      fields: addrFields,
      rows: () => fd().addresses.map((a) => ({ key: a.name, rec: a.rec })),
      init: () => [['uuid', uuid()]],
      save: (key, rec) => {
        const a = fd().addresses.find((x) => x.name === key)
        if (a) a.rec = rec
        else fd().addresses.push({ name: key, rec })
        return undefined
      },
      remove: (key) => {
        if (fd().policies.some((p) => p.rec.some(([f, v]) => (f === 'srcaddr' || f === 'dstaddr') && v.split(' ').includes(`"${key}"`)))) return 'Command fail. Return code -23'
        const before = fd().addresses.length
        fd().addresses = fd().addresses.filter((a) => a.name !== key)
        return fd().addresses.length === before ? 'entry not found in datasource\nCommand fail. Return code -3' : undefined
      }
    }
    const consoleT: FTable = {
      path: 'system console',
      label: 'console',
      help: 'Configure console.',
      single: true,
      fields: [
        { name: 'output', help: 'Console output mode.', kind: 'enum', enums: [['standard', 'Standard output.'], ['more', 'More page output.']], def: 'more' },
        { name: 'login', help: 'Enable/disable serial console and FortiExplorer.', kind: 'enum', enums: ED, def: 'enable' }
      ],
      rows: () => [{ key: '', rec: fd().console.output === 'standard' ? [['output', 'standard']] : [] }],
      save: (_k, rec) => {
        fd().console.output = rec.find(([f]) => f === 'output')?.[1] === 'standard' ? 'standard' : 'more'
        this.applyConsole()
        return undefined
      }
    }
    const globalT: FTable = {
      path: 'system global',
      label: 'global',
      help: 'Configure global attributes.',
      single: true,
      fields: [
        { name: 'hostname', help: 'FortiGate unit\'s hostname.', kind: 'str' },
        { name: 'admintimeout', help: 'Number of minutes before an idle administrator session times out (1 - 480 minutes (8 hours), default = 5).', kind: 'int', min: 1, max: 480, def: '5' },
        { name: 'timezone', help: 'Timezone database name.', kind: 'str' },
        { name: 'alias', help: 'Alias for your FortiGate unit.', kind: 'str' }
      ],
      rows: () => [{ key: '', rec: [['hostname', `"${d.hostname}"`], ...((d.vendor['fortiGlobal'] as FRecord | undefined) ?? [])] }],
      save: (_k, rec) => {
        const h = rec.find(([f]) => f === 'hostname')?.[1]
        if (h) d.hostname = unq(h)
        d.vendor['fortiGlobal'] = rec.filter(([f]) => f !== 'hostname')
        return undefined
      }
    }
    const snmpT: FTable = {
      path: 'system snmp sysinfo',
      label: 'sysinfo',
      help: 'SNMP system info configuration.',
      single: true,
      fields: [
        { name: 'status', help: 'Enable/disable SNMP.', kind: 'enum', enums: ED, def: 'disable' },
        { name: 'description', help: 'System description.', kind: 'var' },
        { name: 'contact-info', help: 'Contact information.', kind: 'var' },
        { name: 'location', help: 'System location.', kind: 'var' }
      ],
      rows: () => [{ key: '', rec: [...(d.services['snmp'] ? [['status', 'enable'] as [string, string]] : []), ...((d.vendor['fortiSnmp'] as FRecord | undefined) ?? [])] }],
      save: (_k, rec) => {
        d.services['snmp'] = rec.find(([f]) => f === 'status')?.[1] === 'enable'
        d.vendor['fortiSnmp'] = rec.filter(([f]) => f !== 'status')
        return undefined
      }
    }
    return [iface, policy, address, consoleT, globalT, snmpT]
  }

  // ------------------------------------------------------------------ top-level tree

  private buildTop(): Node[] {
    const d = this.d
    const t: Node[] = []
    const helps: Record<string, string> = {
      config: 'Configure object.',
      get: 'Get dynamic and system information.',
      show: 'Show configuration.',
      diagnose: 'Diagnose facility.',
      execute: 'Execute static commands.',
      'get system': 'Get system information.',
      'get router': 'Get router information.',
      'get router info': 'Show routing information.',
      'get router info bgp': 'Show BGP information.',
      'get router info ospf': 'Show OSPF information.',
      'get router info routing-table': 'Show routing table information.',
      'show system': 'Configure system.',
      'show firewall': 'Configure firewall.',
      'config system': 'Configure system.',
      'config firewall': 'Configure firewall.',
      'diagnose sys': 'System diagnostics.',
      'config system snmp': 'Configure SNMP.',
      'show system snmp': 'Configure SNMP.',
      'diagnose sys session': 'Session table.',
      'diagnose ip': 'IP diagnostics.',
      'diagnose ip arp': 'ARP table.',
      'diagnose lldprx': 'LLDP reception.',
      'diagnose lldprx neighbor': 'LLDP neighbors.'
    }
    const A = (path: string, help: string, run?: Handler, extra: Partial<Node> = {}, more: Record<string, string> = {}): Node => add(t, path, help, run, extra, { ...helps, ...more })
    for (const tb of this.tables) {
      A(`config ${tb.path}`, tb.help, () => this.enter(tb))
      const keyP: Param = { kind: 'word', label: '<name>', values: () => tb.rows().map((r) => r.key) }
      A(`show ${tb.path}`, tb.help, () => this.render(tb), tb.single ? {} : { children: [prm(keyP, 'Entry name.', { name: 'key', run: (c) => this.render(tb, c.args['key']) })] })
    }
    add(t, 'show', 'Show configuration.', () => this.tables.map((tb) => this.render(tb)).join('\n'))
    A('get system status', 'System status.', () => R.systemStatus(d))
    A('get system performance status', 'Performance status.', () => R.performance(d), {}, { 'get system performance': 'Performance information.' })
    A('get system interface', 'Configure interfaces.', () => R.interfaceLines(d), { children: [kw('physical', 'Physical interfaces.', { run: () => R.interfacePhysical(d) }), prm({ kind: 'word', label: '<name>', values: () => d.interfaces.map((i) => i.name), test: (x) => d.interfaces.some((i) => i.name === x) }, 'Interface name.', { name: 'if', run: (c) => R.interfaceLines(d, c.args['if']) })] })
    A('get vpn ipsec tunnel summary', 'Show IPsec selector and packet counts.', () => R.ipsecSummary(d))
    A('get system arp', 'ARP table.', () => R.systemArp(d))
    A('get system ha status', 'HA status.', () => R.haStatus(d), {}, { 'get system ha': 'HA information.' })
    A('get system session status', 'Session status.', () => `The total number of IPv4 sessions for the current VDOM: ${R.fdata(d).sessions.length}`, {}, { 'get system session': 'Session information.' })
    const rt = (f?: string): string => R.routingTable(d, f)
    A('get router info routing-table all', 'Show all routing table entries.', () => rt())
    A('get router info routing-table database', 'Show routing table database.', () => rt())
    for (const k of ['bgp', 'connected', 'ospf', 'static']) A(`get router info routing-table ${k}`, `Show ${k} routing table entries.`, () => rt(k))
    A('get router info bgp summary', 'Show summary of BGP neighbor status.', () => R.bgpSummary(d))
    A('get router info bgp neighbors', 'Show BGP neighbors.', () => R.bgpNeighbors(d), { children: [prm({ kind: 'ipv4', label: '<neighbor_ip>', values: () => d.bgp.map((n) => n.ip) }, 'Neighbor IP address.', { name: 'ip', run: (c) => R.bgpNeighbors(d, c.args['ip']) })] })
    A('get router info ospf neighbor', 'Show OSPF neighbor information.', () => R.ospfNeighbor(d), { children: [kw('all', 'Show all neighbors.', { run: () => R.ospfNeighbor(d) })] })
    A('get router info ospf status', 'Show OSPF status.', () => ` Routing Process "ospf 0" with ID ${d.ospf?.routerId ?? d.routerId}\n Process uptime is ${R.age(now(d) - d.bootedAt)}`)
    A('get router info kernel', 'Show kernel routing table.', () => rt())
    for (const [k, h] of [['bfd', 'Show BFD information.'], ['isis', 'Show IS-IS information.'], ['multicast', 'Show multicast information.'], ['rip', 'Show RIP information.'], ['vrrp', 'Show VRRP information.']] as const) A(`get router info ${k}`, h, () => '')
    const fparam = (name: keyof R.SessFilter, label: string, kind: Param['kind'] = 'word'): Node =>
      kw(name, `Filter by ${name}.`, { children: [prm({ kind, label }, label, { run: (c) => ((this.filter[name] = c.params[0]!), '') })] })
    A('diagnose sys session filter', 'Set session filter.', () => this.showFilter(), {
      children: [fparam('src', '<IP address>', 'ipv4'), fparam('dst', '<IP address>', 'ipv4'), fparam('sport', '<port>', 'int'), fparam('dport', '<port>', 'int'), fparam('proto', '<protocol>', 'int'), fparam('policy', '<policy id>', 'int'), kw('clear', 'Clear session filter.', { run: () => ((this.filter = {}), '') })]
    })
    A('diagnose sys top', 'Show top processes.', () => R.sysTop(d))
    A('diagnose sys session list', 'List sessions.', () => R.sessionList(d, this.filter))
    A('diagnose sys session stat', 'Show session statistics.', () => R.sessionStat(d))
    A('diagnose sys session clear', 'Clear sessions.', () => this.clearSessions())
    A('diagnose ip arp list', 'List ARP table.', () => R.arpList(d))
    A('diagnose lldprx neighbor summary', 'Show LLDP neighbor summary.', () => R.lldpSummary(d))
    A('execute ping', 'Send ICMP ECHO_REQUEST packets to network hosts.', undefined, { children: [prm({ kind: 'word', label: '<host>' }, 'Hostname or IP address.', { name: 'host', run: (c) => this.ping(c.args['host']!) })] })
    A('execute traceroute', 'Print the route packets take to network host.', undefined, { children: [prm({ kind: 'word', label: '<host>' }, 'Hostname or IP address.', { name: 'host', run: (c) => this.trace(c.args['host']!) })] })
    const confirm = async (lead: string, done: string): Promise<string> => {
      const a = await this.s.ask(`${lead}\nDo you want to continue? (y/n)`, { mode: 'key' })
      return a.toLowerCase() === 'y' ? done : ''
    }
    A('execute reboot', 'Reboot the FortiGate.', () => confirm('This operation will reboot the system !', '[simulator] reboot acknowledged; the simulator never reboots.'))
    A('execute shutdown', 'Shut down the FortiGate.', () => confirm('This operation will shutdown the system !', '[simulator] shutdown acknowledged; the simulator keeps running.'))
    A('execute factoryreset', 'Reset to factory default.', () => confirm('This operation will reset the system to factory default!', '[simulator] factory reset refused; the lab configuration is kept.'))
    A('execute formatlogdisk', 'Format log disk.', () => confirm('Log disk is /dev/sda1.\nFormatting this storage will erase all data on it, including\nlogs, quarantine files;\ncertificate revocation lists (CRLs);\nand require the unit to reboot.', '[simulator] format acknowledged; nothing erased.'))
    A('execute log display', 'Display filtered log entries.', () => this.logDisplay())
    A('exit', 'Exit the CLI.', () => (this.s.close(), ''))
    return t
  }

  private showFilter(): string {
    const f = this.filter
    return [`vd: any`, `sintf: any`, `dintf: any`, `proto: ${f.proto ?? 'any'}`, `source ip: ${f.src ?? 'any'}`, `dest ip: ${f.dst ?? 'any'}`, `source port: ${f.sport ?? 'any'}`, `dest port: ${f.dport ?? 'any'}`, `policy id: ${f.policy ?? 'any'}`].join('\n')
  }

  private clearSessions(): string {
    const f = this.filter
    const fd = R.fdata(this.d)
    const match = (s: (typeof fd.sessions)[number]): boolean => (!f.src || s.src === f.src) && (!f.dst || s.dst === f.dst) && (!f.sport || String(s.sport) === f.sport) && (!f.dport || String(s.dport) === f.dport) && (!f.proto || String(s.proto) === f.proto) && (!f.policy || String(s.policy) === f.policy)
    fd.sessions = fd.sessions.filter((s) => !match(s))
    return ''
  }

  private logDisplay(): string {
    const rows = [...this.d.log].sort((a, b) => b.t - a.t).slice(0, 10)
    if (!rows.length) return '0 logs found.\n0 logs returned.'
    const iso = (ms: number): string => new Date(ms).toISOString()
    return [`${this.d.log.length} logs found.`, `${rows.length} logs returned.`, '', ...rows.flatMap((l, k) => [`${k + 1}: date=${iso(l.t).slice(0, 10)} time=${iso(l.t).slice(11, 19)} logid="0100032001" type="event" subtype="system" level="information" vd="root" logdesc="${l.msg.replace(/"/g, "'")}"`, ''])].join('\n')
  }

  // ------------------------------------------------------------------ rendering

  private fieldsOf(t: FTable): FField[] {
    return t.fields
  }

  private entryLines(t: FTable, key: string, rec: FRecord, ind: string): string[] {
    const order = this.fieldsOf(t).map((f) => f.name)
    const sorted = [...rec].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    const keyText = t.numeric ? key : `"${key}"`
    if (t.single) return sorted.map(([f, v]) => `${ind}set ${f} ${v}`)
    return [`${ind}edit ${keyText}`, ...sorted.map(([f, v]) => `${ind}    set ${f} ${v}`), `${ind}next`]
  }

  private render(t: FTable, key?: string, rows = t.rows()): string {
    const sel = key === undefined ? rows : rows.filter((r) => r.key === key)
    if (key !== undefined && !sel.length) return parseErr(key)
    return [`config ${t.path}`, ...sel.flatMap((r) => this.entryLines(t, r.key, r.rec, '    ')), 'end'].join('\n')
  }

  private getEntry(t: FTable, rec: FRecord, key: string): string {
    const m = new Map(rec)
    const rows: [string, string][] = t.single ? [] : [[t.numeric ? 'policyid' : 'name', key]]
    for (const f of t.fields) rows.push([f.name, unqAll(m.get(f.name) ?? f.def ?? (f.kind === 'int' ? '0' : f.kind === 'ipmask' ? '0.0.0.0 0.0.0.0' : ''))])
    return rows.map(([k, v]) => `${k.padEnd(20)}: ${v}`).join('\n')
  }

  // ------------------------------------------------------------------ execute

  async execute(raw: string): Promise<void> {
    this.applyConsole()
    this.cycle = undefined
    const [base, pipes] = splitPipes(raw)
    let out = this.stack.length ? await this.execCtx(base) : await this.execTop(base)
    if (pipes.length) {
      const r = this.grep(out, pipes)
      out = r
    }
    if (out) await this.s.print(out)
  }

  private async execTop(line: string): Promise<string> {
    const m = match(line, this.top)
    if (!m.ok) {
      const toks = tokenize(line)
      if (m.kind === 'invalid' && m.index === 0) return 'Unknown action 0'
      if (m.kind === 'incomplete') return parseErr(toks.at(-1) ?? '')
      return parseErr(m.token)
    }
    return (await m.node.run!(m.ctx)) ?? ''
  }

  private grep(out: string, pipes: string[]): string {
    let lines = out.split('\n')
    for (const p of pipes) {
      const toks = tokenizeConf(p)
      if (!toks.length || !'grep'.startsWith(toks[0]!)) return parseErr(toks[0] ?? '|')
      const flags = new Set<string>()
      let after = 0
      let before = 0
      let k = 1
      while (k < toks.length && /^-/.test(toks[k]!)) {
        const f = toks[k]!
        if (f === '-A' || f === '-B') {
          const n = Number(toks[k + 1] ?? 0)
          if (f === '-A') after = n
          else before = n
          k += 2
          continue
        }
        for (const c of f.slice(1)) flags.add(c)
        k++
      }
      const pat = toks.slice(k).map(unq).join(' ')
      const re = safeRegex(pat, flags.has('i') ? 'i' : '')
      if (!re) return parseErr(pat)
      const hit = (l: string): boolean => re.test(l) !== flags.has('v')
      if (flags.has('c')) {
        lines = [String(lines.filter(hit).length)]
        continue
      }
      if (flags.has('f')) {
        const keep = new Set<number>()
        lines.forEach((l, i) => {
          if (!hit(l)) return
          let s = i
          while (s > 0 && !/^\s*edit /.test(lines[s]!) && !/^config /.test(lines[s]!)) s--
          let e = i
          while (e < lines.length - 1 && !/^\s*next$/.test(lines[e]!) && lines[e] !== 'end') e++
          let c = s
          while (c > 0 && !/^config /.test(lines[c]!)) c--
          keep.add(c)
          for (let x = s; x <= e; x++) keep.add(x)
          if (/^config /.test(lines[c]!)) keep.add(lines.indexOf('end', e))
        })
        lines = lines.filter((_l, i) => keep.has(i))
        continue
      }
      const keep = new Set<number>()
      lines.forEach((l, i) => {
        if (!hit(l)) return
        for (let x = Math.max(0, i - before); x <= Math.min(lines.length - 1, i + after); x++) keep.add(x)
      })
      lines = lines.filter((_l, i) => keep.has(i))
    }
    return lines.join('\n')
  }

  private enter(t: FTable): string {
    if (t.single) this.stack.push({ kind: 'entry', t, key: '', rec: structuredClone(t.rows()[0]!.rec), isNew: false })
    else this.stack.push({ kind: 'table', t })
    return ''
  }

  private verb(word: string, verbs: string[]): string | undefined {
    if (verbs.includes(word)) return word
    const hits = verbs.filter((v) => v.startsWith(word))
    return hits.length === 1 ? hits[0] : undefined
  }

  private static TABLE_VERBS = ['abort', 'clone', 'delete', 'edit', 'end', 'get', 'move', 'purge', 'rename', 'show']
  private static ENTRY_VERBS = ['abort', 'append', 'end', 'get', 'next', 'select', 'set', 'show', 'unselect', 'unset']

  private async execCtx(line: string): Promise<string> {
    const f = this.stack.at(-1)!
    const toks = tokenizeConf(line)
    const w0 = toks[0] ?? ''
    if (f.kind === 'table') {
      const v = this.verb(w0, FortiosPersonality.TABLE_VERBS)
      if (!v) return parseErr(w0)
      const key = toks[1] ? unq(toks[1]) : undefined
      switch (v) {
        case 'edit': {
          if (!key || toks.length > 2) return parseErr(toks[2] ?? w0)
          const rows = f.t.rows()
          let k = key
          if (f.t.numeric) {
            if (!/^\d+$/.test(k)) return valueErr(k)
            if (k === '0') k = String(Math.max(0, ...rows.map((r) => Number(r.key))) + 1)
          }
          const hit = rows.find((r) => r.key === k)
          if (hit) {
            this.stack.push({ kind: 'entry', t: f.t, key: k, rec: structuredClone(hit.rec), isNew: false })
            return ''
          }
          this.stack.push({ kind: 'entry', t: f.t, key: k, rec: f.t.init?.(k) ?? [], isNew: true })
          return `new entry '${k}' added`
        }
        case 'delete': {
          if (!key) return parseErr(w0)
          return f.t.remove?.(key) ?? ''
        }
        case 'purge': {
          const a = await this.s.ask('This operation will clear all table!\nDo you want to continue? (y/n)', { mode: 'key' })
          if (a.toLowerCase() !== 'y') return ''
          const errs = f.t.rows().map((r) => f.t.remove?.(r.key)).filter((x): x is string => !!x)
          return errs.length ? errs[0]! : ''
        }
        case 'show':
          return this.render(f.t, key)
        case 'get':
          return key ? this.getEntry(f.t, f.t.rows().find((r) => r.key === key)?.rec ?? [], key) : f.t.rows().map((r) => `== [ ${r.key} ]\n${f.t.numeric ? 'policyid' : 'name'}: ${r.key}`).join('\n')
        case 'end':
        case 'abort':
          this.stack.pop()
          return ''
        default:
          return `Command fail. Return code -1`
      }
    }
    const v = this.verb(w0, FortiosPersonality.ENTRY_VERBS)
    if (!v) return parseErr(w0)
    switch (v) {
      case 'set':
      case 'append':
      case 'select':
        return this.set(f, toks.slice(1), v !== 'set')
      case 'unset':
      case 'unselect': {
        const fld = this.field(f.t, toks[1])
        if (!fld) return parseErr(toks[1] ?? w0)
        if (v === 'unselect' && toks.length > 2) {
          const drop = toks.slice(2).map((x) => `"${unq(x)}"`)
          const cur = f.rec.find(([n]) => n === fld.name)
          if (cur) cur[1] = cur[1].split(' ').filter((x) => !drop.includes(x)).join(' ')
          if (cur && !cur[1]) f.rec = f.rec.filter(([n]) => n !== fld.name)
          return ''
        }
        if (fld.required && !f.isNew) return "The attribute can't be empty!\nCommand fail. Return code -56"
        f.rec = f.rec.filter(([n]) => n !== fld.name)
        return ''
      }
      case 'show':
        return this.render(f.t, f.t.single ? undefined : f.key, [{ key: f.key, rec: f.rec }])
      case 'get':
        return this.getEntry(f.t, f.rec, f.key)
      case 'next': {
        if (f.t.single) return parseErr(w0)
        const err = f.t.save(f.key, f.rec, f.isNew)
        if (err) return err
        this.stack.pop()
        return ''
      }
      case 'end': {
        const err = f.t.save(f.key, f.rec, f.isNew)
        if (err) return err
        this.stack.pop()
        if (this.stack.at(-1)?.kind === 'table') this.stack.pop()
        return ''
      }
      case 'abort':
        this.stack.pop()
        return ''
    }
    return parseErr(w0)
  }

  private field(t: FTable, word: string | undefined): FField | undefined {
    if (!word) return undefined
    const exact = t.fields.find((f) => f.name === word)
    if (exact) return exact
    const hits = t.fields.filter((f) => f.name.startsWith(word))
    return hits.length === 1 ? hits[0] : undefined
  }

  private refOk(ref: Ref, v: string): boolean {
    const d = this.d
    switch (ref) {
      case 'iface':
        return v === 'any' || d.interfaces.some((i) => i.name === v)
      case 'addr':
        return R.fdata(d).addresses.some((a) => a.name === v)
      case 'service':
        return SERVICES.includes(v)
      case 'schedule':
        return v === 'always' || v === 'none' || v === 'default-darrp-optimize'
    }
  }

  private set(f: Extract<Frame, { kind: 'entry' }>, toks: string[], append: boolean): string {
    const fld = this.field(f.t, toks[0])
    if (!fld) return parseErr(toks[0] ?? 'set')
    const vals = toks.slice(1)
    if (!vals.length) return parseErr(toks[0]!)
    let value: string
    switch (fld.kind) {
      case 'str': {
        if (!fld.multi && vals.length > 1) return parseErr(vals[1]!)
        for (const v of vals) if (fld.ref && !this.refOk(fld.ref, unq(v))) return notFound(unq(v))
        value = vals.map((v) => `"${unq(v)}"`).join(' ')
        break
      }
      case 'var':
        value = `"${vals.map(unq).join(' ')}"`
        break
      case 'enum': {
        if (vals.length > 1) return parseErr(vals[1]!)
        const e = (fld.enums ?? []).find(([x]) => x === vals[0])
        if (!e) return valueErr(vals[0]!)
        value = e[0]
        break
      }
      case 'opts': {
        for (const v of vals) if (!(fld.enums ?? []).some(([x]) => x === v)) return valueErr(v)
        value = vals.join(' ')
        break
      }
      case 'ipmask': {
        const r = parseIpMask(vals)
        if (!r) return valueErr(vals[0]!)
        value = r
        break
      }
      case 'int': {
        if (vals.length > 1) return parseErr(vals[1]!)
        const n = Number(vals[0])
        if (!/^\d+$/.test(vals[0]!) || (fld.min !== undefined && n < fld.min) || (fld.max !== undefined && n > fld.max)) return valueErr(vals[0]!)
        value = String(n)
        break
      }
      case 'uuid':
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(vals[0]!)) return valueErr(vals[0]!)
        value = vals[0]!
        break
    }
    const cur = f.rec.find(([n]) => n === fld.name)
    if (append && cur && (fld.multi || fld.kind === 'opts')) {
      const merged = [...new Set([...cur[1].split(' '), ...value.split(' ')])].join(' ')
      cur[1] = merged
    } else if (cur) cur[1] = value
    else f.rec.push([fld.name, value])
    return ''
  }

  private reachable(ip: string): boolean {
    const d = this.d
    if (d.interfaces.some((i) => i.ip === ip && isUp(i))) return true
    return R.routes(d).some((r) => inSubnet(ip, r.prefix, r.mask) && (r.mask > 0 || !/^192\.0\.2\./.test(ip)))
  }

  private async ping(host: string): Promise<string> {
    if (!isIpv4(host)) return `Unable to resolve hostname.`
    const ok = this.reachable(host)
    await this.s.print(`PING ${host} (${host}): 56 data bytes`)
    let sent = 0
    let got = 0
    while (sent < 5) {
      if (!(await this.s.sleep(sent ? 150 : 20))) break
      if (ok) {
        await this.s.print(`64 bytes from ${host}: icmp_seq=${sent} ttl=${255 - (sent % 2)} time=${(0.3 + ((sent * 37) % 23) / 100).toFixed(1)} ms`)
        got++
      }
      sent++
    }
    const out = ['', `--- ${host} ping statistics ---`, `${sent} packets transmitted, ${got} packets received, ${sent ? Math.round(((sent - got) / sent) * 100) : 0}% packet loss`]
    if (got) out.push('round-trip min/avg/max = 0.3/0.4/0.5 ms')
    return out.join('\n')
  }

  private async trace(host: string): Promise<string> {
    if (!isIpv4(host)) return 'Unable to resolve hostname.'
    await this.s.print(`traceroute to ${host} (${host}), 32 hops max, 3 probe packets per hop, 84 byte packets`)
    const best = R.routes(this.d).filter((r) => inSubnet(host, r.prefix, r.mask)).sort((a, b) => b.mask - a.mask)[0]
    const via = best ? /via ([\d.]+)/.exec(best.text)?.[1] : undefined
    const hops = best ? (via && via !== host ? [via, host] : [host]) : ['*']
    for (let k = 0; k < hops.length; k++) {
      if (!(await this.s.sleep(30))) break
      await this.s.print(hops[k] === '*' ? ` ${k + 1}  *  *  *` : ` ${k + 1}  ${hops[k]}  ${(0.5 + k).toFixed(3)} ms  ${(0.4 + k).toFixed(3)} ms  ${(0.6 + k).toFixed(3)} ms`)
    }
    return ''
  }

  // ------------------------------------------------------------------ help & completion

  private rows(list: [string, string][]): string {
    if (!list.length) return ''
    const w = Math.max(8, Math.max(...list.map(([n]) => n.length)) + 1)
    return list.map(([n, h]) => `${n.padEnd(w)}${h}`.trimEnd()).join('\n')
  }

  private valueHelp(f: FField): [string, string][] {
    if (f.enums) return f.enums
    if (f.ref === 'iface') return [...this.d.interfaces.map((i): [string, string] => [i.name, i.alias ?? '']), ['any', 'Any interface.'] as [string, string]]
    if (f.ref === 'addr') return R.fdata(this.d).addresses.map((a): [string, string] => [a.name, R.fdata(this.d).addresses.find((x) => x.name === a.name)?.rec.find(([k]) => k === 'subnet')?.[1] ?? ''])
    if (f.ref === 'service') return SERVICES.map((s): [string, string] => [s, ''])
    if (f.ref === 'schedule') return [['always', ''], ['none', '']]
    if (f.kind === 'int') return [['<integer>', 'please input integer value']]
    if (f.kind === 'ipmask') return [['<class_ip&net_netmask>', 'please input ip address and netmask']]
    return [['<string>', 'please input string value']]
  }

  private ctxOptions(line: string): { partial: string; list: [string, string][] } {
    const f = this.stack.at(-1)!
    const endsSpace = line === '' || /\s$/.test(line)
    const toks = tokenizeConf(line)
    const partial = endsSpace ? '' : (toks.pop() ?? '')
    const filt = (l: [string, string][]): [string, string][] => l.filter(([n]) => n.startsWith(partial) || n.startsWith('<'))
    const VH: Record<string, string> = { abort: 'End and discard last config.', append: 'Append values to an option.', clone: 'Clone table entry.', delete: 'Delete table entry.', edit: 'Add/edit table value.', end: 'End and save last config.', get: 'Get dynamic and system information.', move: 'Move table entry.', next: 'Configure next table entry.', purge: 'Clear all table entries.', rename: 'Rename table entry.', select: 'Clear all options except for those specified.', set: 'Modify value.', show: 'Show configuration.', unselect: 'Remove options.', unset: 'Restore default value.' }
    const verbs = f.kind === 'table' ? FortiosPersonality.TABLE_VERBS : FortiosPersonality.ENTRY_VERBS
    if (!toks.length) return { partial, list: verbs.filter((v) => v.startsWith(partial)).map((v) => [v, VH[v] ?? '']) }
    const v = this.verb(toks[0]!, verbs)
    if (!v) return { partial, list: [] }
    if (f.kind === 'table') {
      if (toks.length === 1 && ['edit', 'delete', 'show', 'get'].includes(v)) return { partial, list: filt([...f.t.rows().map((r): [string, string] => [r.key, '']), ...(f.t.numeric ? [['<id>', 'please input integer value'] as [string, string]] : [['<name>', 'please input string value'] as [string, string]])]) }
      return { partial, list: [] }
    }
    if (!['set', 'unset', 'append', 'select', 'unselect'].includes(v)) return { partial, list: [] }
    if (toks.length === 1) return { partial, list: f.t.fields.filter((x) => x.name.startsWith(partial)).map((x) => [(x.required ? '*' : '') + x.name, x.help]) }
    const fld = this.field(f.t, toks[1])
    if (!fld || v === 'unset') return { partial, list: [] }
    return { partial, list: filt(this.valueHelp(fld)) }
  }

  help(line: string): string {
    if (this.stack.length) return this.rows(this.ctxOptions(line).list)
    const h = treeHelp(line, this.top)
    if (!h.ok) return parseErr(h.token)
    return this.rows(h.entries.map((e) => [e.label, e.help]))
  }

  private candidates(line: string): { partial: string; cands: string[] } {
    if (this.stack.length) {
      const o = this.ctxOptions(line)
      return { partial: o.partial, cands: o.list.map(([n]) => n.replace(/^\*/, '')).filter((n) => !n.startsWith('<')) }
    }
    const c = completions(line, this.top)
    if (c.options.length === 1 || !c.partial) return { partial: c.partial, cands: c.options }
    const h = treeHelp(line, this.top)
    const kws = h.ok ? h.entries.filter((e) => e.keyword).map((e) => e.label) : []
    return { partial: c.partial, cands: [...new Set([...kws, ...c.options])] }
  }

  tab(line: string): TabResult {
    if (this.cycle && line === this.cycle.shown) {
      const c = this.cycle
      c.idx = (c.idx + 1) % c.cands.length
      c.shown = c.base + c.cands[c.idx]!
      return { line: c.shown }
    }
    const { partial, cands } = this.candidates(line)
    this.cycle = undefined
    if (!partial || !cands.length) return { bell: true }
    const base = line.slice(0, line.length - partial.length)
    if (cands.length === 1) return { line: base + cands[0]! + ' ' }
    this.cycle = { base, cands, idx: 0, shown: base + cands[0]! }
    return { line: this.cycle.shown }
  }

  control(key: 'c' | 'z', _line: string): ControlResult {
    if (key === 'z') return { keepLine: true }
    if (!this.stack.length) return { echo: '\n', disconnect: true }
    return { echo: '\n', then: () => (this.stack = []) }
  }
}

function unqAll(v: string): string {
  return tokenizeConf(v).map(unq).join(' ')
}

function maskLen(m: string): number {
  return m.split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0)
}

/** `10.0.2.1 255.255.255.252` or `10.0.2.1/30` -> dotted form. */
function parseIpMask(vals: string[]): string | undefined {
  const [a, b] = vals
  if (!a) return undefined
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(a)
  if (m && isIpv4(m[1]!) && Number(m[2]) <= 32 && !b) return `${m[1]} ${maskToDotted(Number(m[2]))}`
  if (isIpv4(a) && b && isIpv4(b) && maskToDotted(maskLen(b)) === b) return `${a} ${b}`
  if (isIpv4(a) && !b) return `${a} 255.255.255.255`
  return undefined
}

export const fortiosFactory = (s: Session): FortiosPersonality => new FortiosPersonality(s)
