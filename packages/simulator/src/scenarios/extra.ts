/**
 * Show commands for state that only fault scenarios set, on vendors whose own CLI tree does not
 * model it: spanning-tree root (when another bridge is root), HSRP/VRRP groups, port security,
 * per-interface OSPF timers, Junos firewall counters, SNMP location.
 *
 * Still state-driven: every line is rendered from the device model (`Device.stp`, `Device.fhrp`,
 * `Iface.portSecurity`, the OSPF config, `Device.acls`), never from canned text. A command is
 * answered here only when the state it renders exists (or the vendor has no rendering for it at
 * all, like per-interface OSPF timers); otherwise it falls through to the vendor, so a clean device
 * is unchanged.
 *
 * Wired in vendors/index.ts in front of every personality's `execute`, in exec mode only.
 */
import { lpad, pad, safeRegex, section, splitPipes } from '../core/text.ts'
import { now } from '../core/runtime.ts'
import { isUp, ospfState, uptime, type Device, type FhrpGroup, type Iface, type SimPlatform } from '../state.ts'

type Render = (d: Device, args: string[]) => string | undefined

interface Cmd {
  /** Canonical words; `<n>` a number, `<if>` an interface, `<ip>` an address, `[x]` optional trailing words. */
  words: string[]
  render: Render
}

const cisco = (m: string): string => {
  const h = m.replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(12, '0')
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`
}

function ifaceOf(d: Device, text: string): Iface | undefined {
  const t = text.toLowerCase().replace(/\s+/g, '')
  return d.interfaces.find((i) => i.name.toLowerCase() === t || i.short.toLowerCase() === t) ?? d.interfaces.find((i) => {
    const m = /^([a-z-]+)([\d/.:]+)$/.exec(t)
    const n = /^([a-z-]+)([\d/.:]+)$/i.exec(i.name)
    return !!m && !!n && n[1]!.toLowerCase().startsWith(m[1]!) && n[2] === m[2]
  })
}

const switchport = (i: Iface): boolean => i.mode === 'access' || i.mode === 'trunk'
const vlanPorts = (d: Device, v: number): Iface[] =>
  d.interfaces.filter((i) => isUp(i) && switchport(i) && ((i.mode === 'access' && (i.vlan ?? 1) === v) || (i.mode === 'trunk' && (i.trunkAllowed ?? d.vlans.map((x) => x.id)).includes(v))))

// ------------------------------------------------------------------ spanning tree

function bridgeMac(d: Device): string {
  return cisco(d.interfaces.find((i) => i.mac)?.mac ?? '00a3.d14f.0100')
}

function stpVlan(d: Device, v: number, style: 'cisco' | 'eos'): string {
  const own = 24576 + v
  const s = d.stp && d.stp.vlans.includes(v) ? d.stp : undefined
  const name = style === 'eos' ? `VL${v}` : `VLAN${String(v).padStart(4, '0')}`
  const rootPort = s && d.interfaces.find((i) => i.name === s.rootPort || i.short === s.rootPort)
  const ports = vlanPorts(d, v)
  return [
    name,
    `  Spanning tree enabled protocol ${style === 'eos' ? 'rapid-pvst' : 'rstp'}`,
    `  Root ID    Priority    ${s ? s.rootPriority + v : own}`,
    `             Address     ${s ? s.rootMac : bridgeMac(d)}`,
    ...(s ? [`             Cost        ${s.rootCost}`, `             Port        ${rootPort ? rootPort.name.split('/').at(-1) : '1'} (${rootPort?.name ?? s.rootPort})`] : ['             This bridge is the root']),
    '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    '',
    `  Bridge ID  Priority    ${own}  (priority 24576 sys-id-ext ${v})`,
    `             Address     ${bridgeMac(d)}`,
    '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    '',
    'Interface           Role Sts Cost      Prio.Nbr Type',
    '------------------- ---- --- --------- -------- --------------------------------',
    ...ports.map((i) => {
      const root = !!rootPort && i === rootPort
      return `${pad(i.short, 20)}${root ? 'Root' : 'Desg'} FWD ${pad(i.speed === '100' ? 19 : 4, 10)}128.${pad(i.name.split('/').at(-1)!, 5)}P2p${i.mode === 'access' ? ' Edge' : ''}`
    }),
    ''
  ].join('\n')
}

function stpAll(d: Device, style: 'cisco' | 'eos', vlan?: string): string | undefined {
  if (vlan !== undefined) {
    const v = Number(vlan)
    if (!d.vlans.some((x) => x.id === v)) return `Spanning tree instance(s) for vlan ${v} does not exist.`
    return stpVlan(d, v, style)
  }
  return d.vlans.map((v) => stpVlan(d, v.id, style)).join('\n')
}

function stpRoot(d: Device, style: 'cisco' | 'eos'): string {
  const rows = d.vlans.map((v) => {
    const s = d.stp && d.stp.vlans.includes(v.id) ? d.stp : undefined
    const port = s ? (d.interfaces.find((i) => i.name === s.rootPort || i.short === s.rootPort)?.short ?? s.rootPort) : ''
    const name = style === 'eos' ? `VL${v.id}` : `VLAN${String(v.id).padStart(4, '0')}`
    return `${pad(name, 17)}${lpad(s ? s.rootPriority + v.id : 24576 + v.id, 6)} ${pad(s ? s.rootMac : bridgeMac(d), 15)}${lpad(s ? s.rootCost : 0, 9)}${lpad(2, 6)}${lpad(20, 4)}${lpad(15, 4)}  ${port}`
  })
  return [
    '                                        Root    Hello Max Fwd',
    'Vlan                   Root ID          Cost    Time  Age Dly  Root Port',
    '---------------- -------------------- --------- ----- --- ---  ------------',
    ...rows,
    ''
  ].join('\n')
}

// ------------------------------------------------------------------ HSRP / VRRP

const ago = (d: Device, t: number): string => uptime(t, now(d))
const shortOf = (d: Device, name: string): string => d.interfaces.find((i) => i.name === name)?.short ?? name
const localIp = (d: Device, g: FhrpGroup): string => d.interfaces.find((i) => i.name === g.iface)?.ip ?? 'unknown'
const trackDown = (d: Device, g: FhrpGroup): boolean => !!g.track && !isUp(d.interfaces.find((i) => i.name === g.track!.iface) ?? ({ adminUp: false } as Iface))
const effPri = (d: Device, g: FhrpGroup): number => g.priority - (trackDown(d, g) ? g.track!.decrement : 0)
const active = (g: FhrpGroup): boolean => g.state === 'Active' || g.state === 'Master'

function hsrpBrief(d: Device, nxos: boolean): string | undefined {
  const gs = d.fhrp?.filter((g) => g.proto === 'hsrp')
  if (!gs?.length) return undefined
  return [
    ...(nxos ? ['*:IPv6 group   #:group belongs to a bundle'] : []),
    '                     P indicates configured to preempt.',
    '                     |',
    nxos ? ' Interface   Grp  Prio P State    Active addr      Standby addr     Group addr' : 'Interface   Grp  Pri P State   Active          Standby         Virtual IP',
    ...gs.map((g) => {
      const act = active(g) ? 'local' : g.peer
      const stb = active(g) ? g.peer : 'local'
      return nxos
        ? `  ${pad(shortOf(d, g.iface), 11)}${pad(g.group, 5)}${pad(effPri(d, g), 5)}${g.preempt ? 'P' : ' '} ${pad(g.state, 9)}${pad(act, 17)}${pad(stb, 17)}${g.vip}   (conf)`
        : `${pad(shortOf(d, g.iface), 12)}${pad(g.group, 5)}${pad(effPri(d, g), 4)}${g.preempt ? 'P' : ' '} ${pad(g.state, 8)}${pad(act, 16)}${pad(stb, 16)}${g.vip}`
    }),
    ''
  ].join('\n')
}

function hsrpDetail(d: Device, nxos: boolean): string | undefined {
  const gs = d.fhrp?.filter((g) => g.proto === 'hsrp')
  if (!gs?.length) return undefined
  return gs
    .map((g) =>
      [
        `${g.iface} - Group ${g.group}${nxos ? ' (HSRP-V1) (IPv4)' : ''}`,
        `  State is ${g.state}`,
        `    ${g.transitions} state changes, last state change ${ago(d, g.lastChange)}`,
        `  Virtual IP address is ${g.vip}`,
        `  Active virtual MAC address is 0000.0c07.ac${g.group.toString(16).padStart(2, '0')}`,
        '  Hello time 3 sec, hold time 10 sec',
        `  ${g.preempt ? 'Preemption enabled' : 'Preemption disabled'}`,
        `  Active router is ${active(g) ? 'local' : `${g.peer}, priority ${g.peerPriority} (expires in 9.120 sec)`}`,
        `  Standby router is ${active(g) ? `${g.peer}, priority ${g.peerPriority} (expires in 8.704 sec)` : 'local'}`,
        `  Priority ${effPri(d, g)} (configured ${g.priority})`,
        ...(g.track ? [`    Track object 1 state ${trackDown(d, g) ? 'Down' : 'Up'} decrement ${g.track.decrement}`, `      interface ${g.track.iface} line-protocol`] : []),
        `  Group name is "hsrp-${shortOf(d, g.iface)}-${g.group}" (default)`,
        ''
      ].join('\n')
    )
    .join('\n')
}

function vrrpEosBrief(d: Device): string | undefined {
  const gs = d.fhrp?.filter((g) => g.proto === 'vrrp')
  if (!gs?.length) return undefined
  return ['Interface    Id   Ver  Pri  Time  State    VR IP Addresses', '------------ ---- ---- ---- ----- -------- ---------------', ...gs.map((g) => `${pad(shortOf(d, g.iface), 13)}${pad(g.group, 5)}${pad(2, 5)}${pad(effPri(d, g), 5)}${pad(3550, 6)}${pad(g.state, 9)}${g.vip}`), ''].join('\n')
}

function vrrpEosDetail(d: Device): string | undefined {
  const gs = d.fhrp?.filter((g) => g.proto === 'vrrp')
  if (!gs?.length) return undefined
  return gs
    .map((g) =>
      [
        `${g.iface} - Group ${g.group}`,
        '  VRF is default',
        '  VRRP Version 2',
        `  State is ${g.state}`,
        `  ${g.transitions} state transitions, last ${ago(d, g.lastChange)} ago`,
        `  Virtual IPv4 address is ${g.vip}`,
        `  Virtual MAC address is 0000.5e00.01${g.group.toString(16).padStart(2, '0')}`,
        '  Advertisement interval is 1.000s',
        `  Preemption is ${g.preempt ? 'enabled' : 'disabled'}`,
        `  Priority is ${effPri(d, g)}`,
        ...(g.track ? [`  Tracked object: ${g.track.iface} is ${trackDown(d, g) ? 'down' : 'up'}, Shutdown -> decrement ${g.track.decrement}`] : []),
        `  Master Router is ${active(g) ? `${localIp(d, g)} (local)` : `${g.peer}, priority is ${g.peerPriority}`}`,
        ''
      ].join('\n')
    )
    .join('\n')
}

function vrrpJunos(d: Device, detail: boolean): string | undefined {
  const gs = d.fhrp?.filter((g) => g.proto === 'vrrp')
  if (!gs?.length) return undefined
  if (!detail)
    return [
      'Interface     State       Group   VR state VR Mode   Type   Address',
      ...gs.flatMap((g) => [`${pad(g.iface + '.0', 14)}${pad('up', 12)}${lpad(g.group, 5)}   ${pad(g.state.toLowerCase(), 9)}${pad('Active', 10)}${pad('lcl', 7)}${localIp(d, g)}`, `${' '.repeat(53)}${pad('vip', 7)}${g.vip}`]),
      ''
    ].join('\n')
  return gs
    .map((g) =>
      [
        `Physical interface: ${g.iface}, Unit: 0, Address: ${localIp(d, g)}/24`,
        `  Index: 332, SNMP ifIndex: 527, VRRP-Traps: disabled, VRRP-Version: 2`,
        `  Interface state: up, Group: ${g.group}, State: ${g.state.toLowerCase()}, VRRP Mode: Active`,
        `  Priority: ${effPri(d, g)}, Advertisement interval: 1, Authentication type: none`,
        `  Advertisement threshold: 3, Computed send rate: 0`,
        `  Preempt: ${g.preempt ? 'yes' : 'no'}, Accept-data mode: no, VIP count: 1, VIP: ${g.vip}`,
        `  Dead timer: 3.312s, Master priority: ${active(g) ? effPri(d, g) : g.peerPriority}, Master router: ${active(g) ? localIp(d, g) : g.peer}`,
        `  Virtual router uptime: ${ago(d, g.lastChange)}`,
        ...(g.track
          ? [`  Tracking: enabled`, `    Current priority: ${effPri(d, g)}, Configured priority: ${g.priority}`, `    Priority hold time: disabled`, `    Interface tracking: enabled, Interface count: 1`, `      Interface        Int state  Int speed  Incurred priority cost`, `      ${pad(g.track.iface + '.0', 17)}${pad(trackDown(d, g) ? 'down' : 'up', 11)}${pad('1g', 11)}${trackDown(d, g) ? g.track.decrement : 0}`]
          : []),
        `  Group VRRP-Traps: disabled`,
        `  State transitions: ${g.transitions}`,
        ''
      ].join('\n')
    )
    .join('\n')
}

// ------------------------------------------------------------------ port security

function psecIfaces(d: Device): Iface[] {
  return d.interfaces.filter((i) => i.portSecurity)
}

function psecTable(d: Device): string | undefined {
  const ps = psecIfaces(d)
  if (!ps.length) return undefined
  return [
    'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
    '                (Count)       (Count)          (Count)',
    '---------------------------------------------------------------------------',
    ...ps.map((i) => `${lpad(i.short, 12)}${lpad(i.portSecurity!.max, 15)}${lpad(i.errDisabled ? 1 : 0, 13)}${lpad(i.portSecurity!.violations, 19)}${lpad(i.portSecurity!.violation[0]!.toUpperCase() + i.portSecurity!.violation.slice(1), 17)}`),
    '---------------------------------------------------------------------------',
    `Total Addresses in System (excluding one mac per port)     : 0`,
    `Max Addresses limit in System (excluding one mac per port) : 4096`,
    ''
  ].join('\n')
}

function psecIface(i: Iface | undefined): string | undefined {
  if (!i?.portSecurity) return undefined
  const p = i.portSecurity
  return [
    `Port Security              : Enabled`,
    `Port Status                : ${i.errDisabled ? 'Secure-shutdown' : 'Secure-up'}`,
    `Violation Mode             : ${p.violation[0]!.toUpperCase() + p.violation.slice(1)}`,
    `Aging Time                 : 0 mins`,
    `Aging Type                 : Absolute`,
    `SecureStatic Address Aging : Disabled`,
    `Maximum MAC Addresses      : ${p.max}`,
    `Total MAC Addresses        : ${i.errDisabled ? 0 : 1}`,
    `Configured MAC Addresses   : 0`,
    `Sticky MAC Addresses       : 1`,
    `Last Source Address:Vlan   : ${p.lastMac ?? '0000.0000.0000'}:${p.lastVlan ?? i.vlan ?? 1}`,
    `Security Violation Count   : ${p.violations}`,
    ''
  ].join('\n')
}

// ------------------------------------------------------------------ OSPF interface timers

function ospfIfCisco(d: Device, nxos: boolean, which?: string): string | undefined {
  if (!d.ospf) return undefined
  const target = which ? ifaceOf(d, which) : undefined
  if (which && !target) return undefined
  const rows = d.ospf.ifaces.filter((o) => !target || o.iface === target.name)
  return rows
    .map((o) => {
      const i = d.interfaces.find((x) => x.name === o.iface || x.short === o.iface)
      const nb = d.ospf!.neighbors.filter((n) => n.iface === o.iface)
      const adj = nb.filter((n) => ospfState(d, n) !== undefined).length
      const p2p = o.networkType === 'point-to-point'
      const up = i ? isUp(i) : true
      return nxos
        ? [
            ` ${o.iface} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'}`,
            `    IP address ${i?.ip ?? '0.0.0.0'}/${i?.mask ?? 32}`,
            `    Process ID ${d.ospf!.process} VRF default, area ${o.area}`,
            `    Enabled by interface configuration`,
            `    State ${p2p ? 'P2P' : 'DR'}, Network type ${p2p ? 'P2P' : 'BROADCAST'}, cost ${o.cost ?? 1}`,
            `    Timer intervals: Hello ${o.hello ?? 10}, Dead ${(o.hello ?? 10) * 4}, Wait ${(o.hello ?? 10) * 4}, Retransmit 5`,
            `    Number of opaque link LSAs: 0, checksum sum 0`,
            `    Neighbors: ${adj}, flooding to ${adj}, adjacent with ${adj}`,
            ''
          ].join('\n')
        : [
            `${o.iface} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'} `,
            `  Internet Address ${i?.ip ?? '0.0.0.0'}/${i?.mask ?? 32}, Area ${o.area}, Attached via Interface Enable`,
            `  Process ID ${d.ospf!.process}, Router ID ${d.ospf!.routerId ?? d.routerId}, Network Type ${p2p ? 'POINT_TO_POINT' : 'BROADCAST'}, Cost: ${o.cost ?? 1}`,
            `  Transmit Delay is 1 sec, State ${p2p ? 'POINT_TO_POINT' : 'DR'}`,
            `  Timer intervals configured, Hello ${o.hello ?? 10}, Dead ${(o.hello ?? 10) * 4}, Wait ${(o.hello ?? 10) * 4}, Retransmit 5`,
            `  Neighbor Count is ${adj}, Adjacent neighbor count is ${adj}`,
            ''
          ].join('\n')
    })
    .join('\n')
}

function ospfIfJunos(d: Device): string | undefined {
  if (!d.ospf) return undefined
  return [
    'Interface           State   Area            DR ID           BDR ID          Nbrs',
    ...d.ospf.ifaces.flatMap((o) => {
      const i = d.interfaces.find((x) => x.name === o.iface)
      const adj = d.ospf!.neighbors.filter((n) => n.iface === o.iface && ospfState(d, n) !== undefined).length
      return [
        `${pad(o.iface + '.0', 20)}${pad(o.passive ? 'DR' : 'PtToPt', 8)}${pad(o.area, 16)}${pad('0.0.0.0', 16)}${pad('0.0.0.0', 16)}${lpad(adj, 4)}`,
        `  Type: ${o.networkType === 'point-to-point' ? 'P2P' : 'LAN'}, Address: ${i?.ip ?? '0.0.0.0'}, Mask: ${dotted(i?.mask ?? 32)}, MTU: ${i?.mtu ?? 1500}, Cost: ${o.cost ?? 1}`,
        `  Adj count: ${adj}`,
        `  Hello: ${o.hello ?? 10}, Dead: ${(o.hello ?? 10) * 4}, ReXmit: 5, Not Stub`,
        `  Auth type: None`,
        `  Protection type: None`,
        `  Topology default (ID 0) -> Cost: ${o.cost ?? 1}`
      ]
    }),
    ''
  ].join('\n')
}

const dotted = (len: number): string => [24, 16, 8, 0].map((sh) => ((len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0) >>> sh) & 255).join('.')

// ------------------------------------------------------------------ Junos firewall counters, SNMP

function junosFirewall(d: Device): string | undefined {
  if (!d.acls.length) return undefined
  return d.acls
    .map((a) =>
      [
        `Filter: ${a.name}`,
        'Counters:',
        'Name                                                Bytes              Packets',
        ...a.entries.filter((e) => e.action !== 'remark').map((e) => {
          const name = /^term\s+(\S+)/.exec(e.text)?.[1] ?? `${a.name}-${e.seq}`
          return `${pad(name, 40)}${lpad((e.hits ?? 0) * 64, 18)}${lpad(e.hits ?? 0, 21)}`
        }),
        ''
      ].join('\n')
    )
    .join('\n')
}

// ------------------------------------------------------------------ registry

const T: Partial<Record<SimPlatform, Cmd[]>> = {
  ios: [
    { words: ['show', 'spanning-tree', 'vlan', '<n>'], render: (d, a) => (d.stp ? stpAll(d, 'cisco', a[0]) : undefined) },
    { words: ['show', 'spanning-tree'], render: (d) => (d.stp ? stpAll(d, 'cisco') : undefined) },
    { words: ['show', 'spanning-tree', 'root'], render: (d) => (d.stp ? stpRoot(d, 'cisco') : undefined) },
    { words: ['show', 'standby', 'brief'], render: (d) => hsrpBrief(d, false) },
    { words: ['show', 'standby'], render: (d) => hsrpDetail(d, false) },
    { words: ['show', 'port-security'], render: (d) => psecTable(d) },
    { words: ['show', 'port-security', 'interface', '<if>'], render: (d, a) => psecIface(ifaceOf(d, a[0]!)) },
    { words: ['show', 'ip', 'ospf', 'interface'], render: (d) => ospfIfCisco(d, false) },
    { words: ['show', 'ip', 'ospf', 'interface', '<if>'], render: (d, a) => ospfIfCisco(d, false, a[0]) },
    { words: ['show', 'snmp', 'location'], render: (d) => (d.snmpLocation !== undefined ? d.snmpLocation : undefined) }
  ],
  nxos: [
    { words: ['show', 'spanning-tree', 'vlan', '<n>'], render: (d, a) => (d.stp ? stpAll(d, 'cisco', a[0]) : undefined) },
    { words: ['show', 'spanning-tree'], render: (d) => (d.stp ? stpAll(d, 'cisco') : undefined) },
    { words: ['show', 'spanning-tree', 'root'], render: (d) => (d.stp ? stpRoot(d, 'cisco') : undefined) },
    { words: ['show', 'hsrp', 'brief'], render: (d) => hsrpBrief(d, true) },
    { words: ['show', 'hsrp'], render: (d) => hsrpDetail(d, true) },
    { words: ['show', 'port-security'], render: (d) => psecTable(d) },
    { words: ['show', 'port-security', 'interface', '<if>'], render: (d, a) => psecIface(ifaceOf(d, a[0]!)) },
    { words: ['show', 'ip', 'ospf', 'interface'], render: (d) => ospfIfCisco(d, true) },
    { words: ['show', 'ip', 'ospf', 'interface', '<if>'], render: (d, a) => ospfIfCisco(d, true, a[0]) },
    { words: ['show', 'snmp', 'location'], render: (d) => (d.snmpLocation !== undefined ? d.snmpLocation : undefined) }
  ],
  eos: [
    { words: ['show', 'spanning-tree', 'vlan', '<n>'], render: (d, a) => (d.stp ? stpAll(d, 'eos', a[0]) : undefined) },
    { words: ['show', 'spanning-tree'], render: (d) => (d.stp ? stpAll(d, 'eos') : undefined) },
    { words: ['show', 'spanning-tree', 'root'], render: (d) => (d.stp ? stpRoot(d, 'eos') : undefined) },
    { words: ['show', 'vrrp', 'brief'], render: (d) => vrrpEosBrief(d) },
    { words: ['show', 'vrrp'], render: (d) => vrrpEosDetail(d) },
    { words: ['show', 'port-security'], render: (d) => psecTable(d) },
    { words: ['show', 'port-security', 'interface', '<if>'], render: (d, a) => psecIface(ifaceOf(d, a[0]!)) },
    { words: ['show', 'ip', 'ospf', 'interface'], render: (d) => ospfIfCisco(d, false) },
    { words: ['show', 'snmp', 'location'], render: (d) => (d.snmpLocation !== undefined ? `Location: ${d.snmpLocation}` : undefined) }
  ],
  junos: [
    { words: ['show', 'vrrp', 'summary'], render: (d) => vrrpJunos(d, false) },
    { words: ['show', 'vrrp'], render: (d) => vrrpJunos(d, true) },
    { words: ['show', 'vrrp', 'detail'], render: (d) => vrrpJunos(d, true) },
    { words: ['show', 'ospf', 'interface', 'detail'], render: (d) => ospfIfJunos(d) },
    { words: ['show', 'firewall'], render: (d) => junosFirewall(d) }
  ]
}

/** Typed words against a pattern: each typed word abbreviates the pattern word (any unique-enough prefix). */
function matchWords(typed: string[], words: string[]): string[] | null {
  if (typed.length !== words.length) return null
  const args: string[] = []
  for (const [k, w] of words.entries()) {
    const t = typed[k]!
    if (w === '<n>') {
      if (!/^\d+$/.test(t)) return null
      args.push(t)
    } else if (w === '<if>') args.push(t)
    else if (!w.startsWith(t.toLowerCase()) || (t.length < 2 && k > 0)) return null
  }
  return args
}

/** Pipes the extra commands understand: Cisco include/exclude/begin/section/count, Junos match/except/count/no-more. */
function applyPipes(out: string, pipes: string[], platform: SimPlatform): string | undefined {
  let lines = out.replace(/\n$/, '').split('\n')
  for (const p of pipes) {
    const [w = '', ...rest] = p.trim().split(/\s+/)
    const re = safeRegex(rest.join(' ').replace(/^"(.*)"$/, '$1'), platform === 'junos' ? 'i' : '')
    const word = w.toLowerCase()
    const is = (full: string) => word.length > 0 && full.startsWith(word)
    if (platform === 'junos' ? is('no-more') : false) continue
    if (!re) return undefined
    if (platform === 'junos' ? is('match') : is('include')) lines = lines.filter((l) => re.test(l))
    else if (platform === 'junos' ? is('except') : is('exclude')) lines = lines.filter((l) => !re.test(l))
    else if (platform !== 'junos' && is('begin')) {
      const i = lines.findIndex((l) => re.test(l))
      lines = i < 0 ? [] : lines.slice(i)
    } else if (platform !== 'junos' && is('section')) lines = section(lines, re)
    else return undefined
  }
  return lines.join('\n')
}

/**
 * The output for `line` from the extra renderers, or undefined to let the vendor answer.
 * Only exec-mode show commands; config mode always falls through.
 */
export function extraShow(d: Device, line: string): string | undefined {
  const cmds = T[d.platform]
  if (!cmds) return undefined
  const [base, pipes] = splitPipes(line)
  const typed = base.trim().split(/\s+/).filter(Boolean)
  if (!typed.length || !'show'.startsWith(typed[0]!.toLowerCase()) || typed[0]!.length < 2) return undefined
  for (const c of cmds) {
    const args = matchWords(typed, c.words)
    if (!args) continue
    const out = c.render(d, args)
    if (out === undefined) return undefined
    if (!pipes.length) return out
    return applyPipes(out, pipes, d.platform)
  }
  return undefined
}
