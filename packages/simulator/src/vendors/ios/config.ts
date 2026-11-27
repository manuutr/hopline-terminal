/** IOS-XE running-config rendered from the model (docs/research/cli-cisco-ios.md §6 running-config). */
import { maskToDotted } from '../../core/tree.ts'
import { cmpIp } from '../../core/text.ts'
import { deviceFrom, type Device, type Iface } from '../../state.ts'
import { ciscoDate } from './render.ts'

const TYPE_ORDER = ['Loopback', 'Port-channel', 'Tunnel', 'GigabitEthernet0/', 'GigabitEthernet', 'TenGigabitEthernet', 'TwentyFiveGigE', 'FortyGigabitEthernet', 'HundredGigE', 'Vlan']
const typeRank = (n: string): number => {
  const k = TYPE_ORDER.findIndex((t) => n.startsWith(t))
  return k < 0 ? 99 : k
}

function wildcard(len: number): string {
  return maskToDotted(len)
    .split('.')
    .map((o) => 255 - Number(o))
    .join('.')
}

export function ifaceBlock(d: Device, i: Iface): string[] {
  const l = [`interface ${i.name}`]
  if (i.description) l.push(` description ${i.description}`)
  const phys = /^(GigabitEthernet|TenGig|TwentyFive|FortyGig|HundredGig|Port-channel)/.test(i.name)
  if (i.vrf) l.push(` vrf forwarding ${i.vrf}`)
  if (phys && !i.vrf) {
    if (i.mode === 'access') {
      if (i.vlan && i.vlan !== 1) l.push(` switchport access vlan ${i.vlan}`)
      l.push(' switchport mode access')
    } else if (i.mode === 'trunk') {
      if (i.nativeVlan) l.push(` switchport trunk native vlan ${i.nativeVlan}`)
      if (i.trunkAllowed) l.push(` switchport trunk allowed vlan ${i.trunkAllowed.length ? compress(i.trunkAllowed) : 'none'}`)
      l.push(' switchport mode trunk')
    } else l.push(' no switchport')
  }
  if (i.ip) l.push(` ip address ${i.ip} ${maskToDotted(i.mask!)}`)
  else if (!phys || i.mode === 'routed') l.push(' no ip address')
  if (i.mtu && i.mtu !== 1500) l.push(` mtu ${i.mtu}`)
  const o = d.ospf?.ifaces.find((x) => x.iface === i.name)
  if (o?.networkType === 'point-to-point') l.push(' ip ospf network point-to-point')
  if (o?.mtuIgnore) l.push(' ip ospf mtu-ignore')
  if (o?.cost) l.push(` ip ospf cost ${o.cost}`)
  if (i.speedSet && i.speedSet !== 'auto') l.push(` speed ${i.speedSet}`)
  if (i.duplex && i.duplex !== 'auto') l.push(` duplex ${i.duplex}`)
  if (i.channelGroup !== undefined) l.push(` channel-group ${i.channelGroup} mode active`)
  if (i.bpduGuard) l.push(' spanning-tree bpduguard enable')
  if (i.mode === 'access' && phys && !i.vrf) l.push(' spanning-tree portfast')
  if (i.name === 'GigabitEthernet0/0') l.push(' negotiation auto')
  if (!i.adminUp) l.push(' shutdown')
  return l
}

function compress(v: number[]): string {
  const s = [...new Set(v)].sort((a, b) => a - b)
  const out: string[] = []
  for (let k = 0; k < s.length; ) {
    let e = k
    while (e + 1 < s.length && s[e + 1] === s[e]! + 1) e++
    out.push(e > k + 1 ? `${s[k]}-${s[e]}` : e === k + 1 ? `${s[k]},${s[e]}` : String(s[k]))
    k = e + 1
  }
  return out.join(',')
}

export { compress as vlanCompress }

function body(d: Device): string[] {
  const meta = (d.vendor['iosMeta'] as { lastChange?: number; by?: string } | undefined) ?? {}
  const lastChange = meta.lastChange ?? d.log.find((e) => e.msg.includes('CONFIG_I'))?.t ?? d.bootedAt
  const out: string[] = [
    '!',
    `! Last configuration change at ${ciscoDate(lastChange)} by ${meta.by ?? 'netops'}`,
    ...(d.startup ? [`! NVRAM config last updated at ${ciscoDate(d.startup.takenAt)} by netops`] : []),
    '!',
    `version ${d.version.split('.').slice(0, 2).join('.')}`,
    'service timestamps debug datetime msec',
    'service timestamps log datetime msec',
    'service password-encryption',
    'service call-home',
    'platform punt-keepalive disable-kernel-core',
    '!',
    `hostname ${d.hostname}`,
    '!',
    '!',
    'vrf definition Mgmt-vrf',
    ' !',
    ' address-family ipv4',
    ' exit-address-family',
    ' !',
    ' address-family ipv6',
    ' exit-address-family',
    '!',
    ...d.vrfs.filter((v) => v.name !== 'Mgmt-vrf').flatMap((v) => [`vrf definition ${v.name}`, ...(v.rd ? [` rd ${v.rd}`] : []), ' !', ' address-family ipv4', ' exit-address-family', '!']),
    'logging buffered 102400',
    'enable secret 9 $9$nhEmQVczB7dqsO$X.HsgL6x1il0RxkOSSvyQYwucySCt7qFm4v7pqCxkKM',
    '!',
    'aaa new-model',
    '!',
    'aaa authentication login default group tacacs+ local',
    'aaa authorization exec default group tacacs+ local',
    '!',
    'aaa session-id common',
    'switch 1 provision c9300-48p',
    '!',
    ...(d.services['domain-lookup'] ? [] : ['no ip domain lookup']),
    'ip domain name lab.example.net',
    '!',
    'login on-success log',
    '!',
    'license boot level network-advantage addon dna-advantage',
    '!',
    'diagnostic bootup level minimal',
    '!',
    `spanning-tree mode rapid-pvst`,
    'spanning-tree extend system-id',
    ...(((d.vendor['errdisableRecovery'] as string[] | undefined) ?? []).map((c) => `errdisable recovery cause ${c}`)),
    '!',
    'username netops privilege 15 secret 9 $9$4cBzWkqLrQb1sE$e7Hj5Rm2pZkT0vYc8NwL3fXa9uIq6sDgOyBhKnM1',
    '!',
    'redundancy',
    ' mode sso',
    '!',
    ...[...d.vlans]
      .filter((v) => v.id !== 1)
      .sort((a, b) => a.id - b.id)
      .flatMap((v) => [`vlan ${v.id}`, ` name ${v.name}`, ...(v.shutdown ? [' shutdown'] : []), '!']),
    '!',
    ...[...d.interfaces].sort((a, b) => typeRank(a.name) - typeRank(b.name)).flatMap((i) => [...ifaceBlock(d, i), '!'])
  ]
  if (d.ospf) {
    out.push(`router ospf ${d.ospf.process}`)
    if (d.ospf.routerId) out.push(` router-id ${d.ospf.routerId}`)
    for (const o of d.ospf.ifaces) if ((o as { passive?: boolean }).passive) out.push(` passive-interface ${o.iface}`)
    for (const o of d.ospf.ifaces) {
      const i = d.interfaces.find((x) => x.name === o.iface)
      if (i?.ip) out.push(` network ${i.ip} 0.0.0.0 area ${o.area}`)
    }
    out.push('!')
  }
  if (d.localAs) {
    const ns = [...d.bgp].sort((a, b) => cmpIp(a.ip, b.ip))
    out.push(`router bgp ${d.localAs}`, ` bgp router-id ${d.routerId}`, ' bgp log-neighbor-changes')
    for (const n of ns) {
      out.push(` neighbor ${n.ip} remote-as ${n.remoteAs}`)
      if (n.description) out.push(` neighbor ${n.ip} description ${n.description}`)
      if (n.password) out.push(` neighbor ${n.ip} password 7 ${n.password}`)
      if (n.updateSource) out.push(` neighbor ${n.ip} update-source ${n.updateSource}`)
      if (n.shutdown) out.push(` neighbor ${n.ip} shutdown`)
    }
    out.push(' !', ' address-family ipv4')
    for (const n of ns) {
      out.push(`  neighbor ${n.ip} activate`)
      if (n.routeMapIn) out.push(`  neighbor ${n.ip} route-map ${n.routeMapIn} in`)
      if (n.routeMapOut) out.push(`  neighbor ${n.ip} route-map ${n.routeMapOut} out`)
    }
    out.push(' exit-address-family', '!')
  }
  out.push('ip forward-protocol nd')
  out.push(d.services['http-server'] ? 'ip http server' : 'no ip http server')
  out.push('ip http authentication local')
  out.push(d.services['http-server'] ? 'ip http secure-server' : 'no ip http secure-server')
  for (const r of d.staticRoutes) out.push(`ip route ${r.vrf ? `vrf ${r.vrf} ` : ''}${r.prefix} ${maskToDotted(r.mask)} ${r.nextHop}${r.ad ? ` ${r.ad}` : ''}${r.name ? ` name ${r.name}` : ''}`)
  out.push('ip ssh version 2', '!')
  for (const a of d.acls.filter((x) => !/^\d+$/.test(x.name))) {
    out.push(`ip access-list ${a.type} ${a.name}`)
    for (const e of a.entries) out.push(` ${e.seq} ${e.action === 'remark' ? 'remark' : e.action.padEnd(6)} ${e.text}`)
  }
  out.push('!')
  for (const p of d.prefixLists) for (const e of p.entries) out.push(`ip prefix-list ${p.name} seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`)
  out.push('logging host 10.10.10.20', '!')
  for (const a of d.acls.filter((x) => /^\d+$/.test(x.name))) for (const e of a.entries) out.push(`access-list ${a.name} ${e.action} ${e.text}`)
  out.push('!')
  for (const r of d.routeMaps) {
    for (const e of r.entries) {
      out.push(`route-map ${r.name} ${e.action} ${e.seq}`)
      for (const m of e.match) out.push(` match ${m}`)
      for (const s of e.set) out.push(` set ${s}`)
    }
    out.push('!')
  }
  out.push(
    ...(d.services['snmp-ro'] === false ? [] : ['snmp-server community n3tw0rkRO RO']),
    ...(d.services['snmp-rw'] === false ? [] : ['snmp-server community pr1vRW RW 99']),
    'snmp-server location LAB-3F-IDF',
    '!',
    'tacacs server ISE-1',
    ' address ipv4 10.255.255.10',
    ' key 7 104D000A0618',
    '!',
    'control-plane',
    ' service-policy input system-cpp-policy',
    '!'
  )
  out.push(...d.extraConfig)
  if (d.motd !== undefined) out.push(`banner motd ^C${d.motd.replace(/\n/g, '\n')}^C`)
  out.push('!', 'line con 0', ' stopbits 1', 'line vty 0 15', ' transport input ssh', '!', 'end')
  return out
}

export function runningConfig(d: Device, onlyIface?: Iface): string {
  if (onlyIface) {
    const b = [...ifaceBlock(d, onlyIface), 'end']
    return ['Building configuration...', '', `Current configuration : ${b.join('\n').length + 1} bytes`, '!', ...b, ''].join('\n')
  }
  const lines = body(d)
  const text = lines.join('\n')
  return ['Building configuration...', '', `Current configuration : ${text.length + 1} bytes`, ...lines].join('\n')
}

export function startupConfig(d: Device): string {
  const s = d.startup ? deviceFrom(d, d.startup) : d
  const text = body(s).join('\n')
  return [`Using ${text.length + 1} out of 2097152 bytes`, text].join('\n')
}

/** Config text without the volatile header, for diffs and dirty checks. */
export function configLines(d: Device): string[] {
  return body(d).filter((l) => !/^! (Last configuration change|NVRAM config last updated)/.test(l))
}

export function isDirty(d: Device): boolean {
  if (!d.startup) return false
  return configLines(deviceFrom(d, d.startup)).join('\n') !== configLines(d).join('\n')
}

export { wildcard }
