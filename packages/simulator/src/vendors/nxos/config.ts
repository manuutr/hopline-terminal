/**
 * NX-OS running-config rendered from the Device model (docs/research/cli-cisco-nxos.md §6,
 * "show running-config (short excerpt)"): prefix-length addresses, two-space indentation, no `!`
 * separators, features first, then VLANs, VRF contexts, interfaces, router blocks.
 */
import { now } from '../../core/runtime.ts'
import { deviceFrom, snapshot, type Device, type Iface } from '../../state.ts'
import { KNOWN_FEATURES, feature, kind, nxDate, vlanList } from './render.ts'

export interface NxosStore {
  checkpoints: { name: string; desc: string; user: string; at: number; snap: ReturnType<typeof snapshot> }[]
  /** "Running configuration last done at". */
  lastChange?: number
  /** `write erase` was confirmed: startup is empty until the next copy run start. */
  startupErased?: boolean
}

export function store(d: Device): NxosStore {
  const v = d.vendor as { nxos?: NxosStore }
  return (v.nxos ??= { checkpoints: [] })
}

/** Interface ACL bindings ride on the interface object so snapshots, checkpoints and sessions carry them. */
export type NxIface = Iface & { nxAcl?: { in?: string; out?: string } }

const CONFIG_IF_ORDER = ['vlan', 'po', 'eth', 'mgmt', 'lo', 'other']
const ifNum = (i: Iface): number[] => (i.name.match(/\d+/g) ?? []).map(Number)
function cfgCompare(a: Iface, b: Iface): number {
  const k = CONFIG_IF_ORDER.indexOf(kind(a)) - CONFIG_IF_ORDER.indexOf(kind(b))
  if (k) return k
  const x = ifNum(a)
  const y = ifNum(b)
  for (let n = 0; n < Math.max(x.length, y.length); n++) if ((x[n] ?? -1) !== (y[n] ?? -1)) return (x[n] ?? -1) - (y[n] ?? -1)
  return 0
}

/** Interface stanza. */
export function ifaceLines(d: Device, i: Iface): string[] {
  const out = [`interface ${i.name}`]
  const k = kind(i)
  const routedPort = (k === 'eth' || k === 'po') && i.mode === 'routed'
  if (i.description !== undefined) out.push(`  description ${i.description}`)
  if (k === 'vlan') out.push(i.adminUp ? '  no shutdown' : '  shutdown')
  if (k === 'eth' || k === 'po') {
    if (routedPort) out.push('  no switchport')
    else {
      if (i.mode === 'trunk') out.push('  switchport mode trunk')
      if (i.mode === 'trunk' && i.nativeVlan !== undefined && i.nativeVlan !== 1) out.push(`  switchport trunk native vlan ${i.nativeVlan}`)
      if (i.mode === 'trunk' && i.trunkAllowed) out.push(`  switchport trunk allowed vlan ${i.trunkAllowed.length ? vlanList(i.trunkAllowed) : 'none'}`)
      if (i.mode === 'access' && (i.vlan ?? 1) !== 1) out.push(`  switchport access vlan ${i.vlan}`)
    }
    if (i.bpduGuard) out.push('  spanning-tree bpduguard enable')
    if (i.speedSet && i.speedSet !== 'auto') out.push(`  speed ${i.speedSet.replace(/G$/, '000')}`)
    if (i.duplex && i.duplex !== 'auto') out.push(`  duplex ${i.duplex}`)
  }
  if (i.mtu !== undefined && i.mtu !== 1500) out.push(`  mtu ${i.mtu}`)
  if (i.vrf) out.push(`  vrf member ${i.vrf}`)
  if (i.ip && i.mask !== undefined) out.push(`  ip address ${i.ip}/${i.mask}`)
  const o = d.ospf?.ifaces.find((x) => x.iface === i.name)
  if (o && d.ospf) {
    if (o.networkType === 'point-to-point') out.push('  ip ospf network point-to-point')
    if (o.cost !== undefined) out.push(`  ip ospf cost ${o.cost}`)
    if (o.mtuIgnore) out.push('  ip ospf mtu-ignore')
    if (o.passive) out.push('  ip ospf passive-interface')
    out.push(`  ip router ospf ${d.ospf.process} area ${o.area}`)
  }
  const acl = (i as NxIface).nxAcl
  if (acl?.in) out.push(`  ip access-group ${acl.in} in`)
  if (acl?.out) out.push(`  ip access-group ${acl.out} out`)
  if (i.channelGroup !== undefined) out.push(`  channel-group ${i.channelGroup} mode active`)
  if (routedPort || k === 'mgmt') out.push(i.adminUp ? '  no shutdown' : '  shutdown')
  else if ((k === 'eth' || k === 'po' || k === 'lo') && !i.adminUp) out.push('  shutdown')
  return out
}

export function bgpLines(d: Device): string[] {
  if (!feature(d, 'bgp') || !d.localAs) return []
  const out = [`router bgp ${d.localAs}`, `  router-id ${d.routerId}`, '  address-family ipv4 unicast']
  const byVrf = new Map<string, Device['bgp']>()
  for (const n of d.bgp) byVrf.set(n.vrf ?? 'default', [...(byVrf.get(n.vrf ?? 'default') ?? []), n])
  const nbr = (n: Device['bgp'][number], ind: string): string[] => [
    `${ind}neighbor ${n.ip}`,
    `${ind}  remote-as ${n.remoteAs}`,
    ...(n.description !== undefined ? [`${ind}  description ${n.description}`] : []),
    ...(n.password !== undefined ? [`${ind}  password 3 ${n.password}`] : []),
    ...(n.updateSource ? [`${ind}  update-source ${n.updateSource}`] : []),
    ...(n.shutdown ? [`${ind}  shutdown`] : []),
    `${ind}  address-family ipv4 unicast`,
    ...(n.routeMapIn ? [`${ind}    route-map ${n.routeMapIn} in`] : []),
    ...(n.routeMapOut ? [`${ind}    route-map ${n.routeMapOut} out`] : [])
  ]
  for (const n of byVrf.get('default') ?? []) out.push(...nbr(n, '  '))
  for (const [vrf, list] of byVrf) {
    if (vrf === 'default') continue
    out.push(`  vrf ${vrf}`, '    address-family ipv4 unicast')
    for (const n of list) out.push(...nbr(n, '    '))
  }
  return out
}

export function ospfLines(d: Device): string[] {
  if (!feature(d, 'ospf') || !d.ospf) return []
  return [`router ospf ${d.ospf.process}`, ...(d.ospf.routerId ? [`  router-id ${d.ospf.routerId}`] : [])]
}

/** Config body (no `!Command` header). */
export function configBody(d: Device): string[] {
  const out: string[] = []
  out.push(`version ${d.version} Bios:version 05.47`, `hostname ${d.hostname}`, `vdc ${d.hostname} id 1`, '  limit-resource vlan minimum 16 maximum 4094', '  limit-resource vrf minimum 2 maximum 4096', '')
  const order = ['bash-shell', 'nxapi', 'scp-server', 'tunnel', 'ospf', 'eigrp', 'bgp', 'pim', 'interface-vlan', 'hsrp', 'lacp', 'dhcp', 'vpc', 'lldp', 'bfd', 'nv overlay']
  for (const f of [...order, ...KNOWN_FEATURES.filter((x) => !order.includes(x))]) if (feature(d, f) && f !== 'ssh') out.push(`feature ${f}`)
  out.push('')
  out.push(`username ${d.user} password 5 $5$Hopline$sim  role network-admin`)
  if (d.services['cdp'] === false) out.push('no cdp enable')
  if (d.motd !== undefined) out.push(`banner motd #${d.motd}#`)
  for (const a of d.acls) {
    out.push(`ip access-list ${a.name}`)
    for (const e of a.entries) out.push(`  ${e.seq} ${e.action} ${e.text}`)
  }
  for (const p of d.prefixLists) for (const e of p.entries) out.push(`ip prefix-list ${p.name} seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`)
  for (const r of d.routeMaps)
    for (const e of r.entries) {
      out.push(`route-map ${r.name} ${e.action} ${e.seq}`)
      for (const m of e.match) out.push(`  match ${m}`)
      for (const s of e.set) out.push(`  set ${s}`)
    }
  for (const r of d.staticRoutes.filter((x) => !x.vrf || x.vrf === 'default')) out.push(`ip route ${r.prefix}/${r.mask} ${r.nextHop}${r.ad ? ` ${r.ad}` : ''}${r.name ? ` name ${r.name}` : ''}`)
  const vl = [...d.vlans].sort((a, b) => a.id - b.id)
  out.push(`vlan ${vlanList(vl.map((v) => v.id))}`)
  for (const v of vl) {
    const def = v.id === 1 ? 'default' : `VLAN${String(v.id).padStart(4, '0')}`
    if (v.name === def && !v.shutdown) continue
    out.push(`vlan ${v.id}`)
    if (v.name !== def) out.push(`  name ${v.name}`)
    if (v.shutdown) out.push('  shutdown')
  }
  out.push('')
  for (const v of [...d.vrfs].sort((a, b) => (a.name === 'management' ? 1 : b.name === 'management' ? -1 : a.name.localeCompare(b.name)))) {
    out.push(`vrf context ${v.name}`)
    if (v.rd) out.push(`  rd ${v.rd}`)
    for (const r of d.staticRoutes.filter((x) => x.vrf === v.name)) out.push(`  ip route ${r.prefix}/${r.mask} ${r.nextHop}${r.ad ? ` ${r.ad}` : ''}`)
  }
  for (const i of [...d.interfaces].sort(cfgCompare)) out.push('', ...ifaceLines(d, i))
  out.push(...(d.extraConfig.length ? ['', ...d.extraConfig] : []))
  out.push(...ospfLines(d), ...bgpLines(d))
  return out
}

export function runningConfig(d: Device, t = now(d)): string {
  const last = store(d).lastChange ?? d.bootedAt
  return ['', '!Command: show running-config', `!Running configuration last done at: ${nxDate(last)}`, `!Time: ${nxDate(t)}`, '', ...configBody(d)].join('\n')
}

/** Only the named section(s): `show running-config bgp|ospf|interface X|vrf X`. */
export function runningSection(d: Device, which: 'bgp' | 'ospf' | 'interface' | 'vrf', arg?: string, t = now(d)): string {
  const head = ['', `!Command: show running-config ${which}${arg ? ` ${arg}` : ''}`, `!Running configuration last done at: ${nxDate(store(d).lastChange ?? d.bootedAt)}`, `!Time: ${nxDate(t)}`, '', `version ${d.version} Bios:version 05.47`]
  let body: string[] = []
  if (which === 'bgp') body = feature(d, 'bgp') ? ['feature bgp', '', ...bgpLines(d)] : []
  else if (which === 'ospf') body = feature(d, 'ospf') ? ['feature ospf', '', ...ospfLines(d), ...d.interfaces.filter((i) => d.ospf?.ifaces.some((o) => o.iface === i.name)).sort(cfgCompare).flatMap((i) => ['', `interface ${i.name}`, ...ifaceLines(d, i).filter((l) => /ospf/.test(l))])] : []
  else if (which === 'interface') body = d.interfaces.filter((i) => !arg || i.name === arg).sort(cfgCompare).flatMap((i) => ['', ...ifaceLines(d, i)])
  else if (which === 'vrf') {
    const v = d.vrfs.find((x) => x.name === arg)
    body = v ? [`vrf context ${v.name}`, ...(v.rd ? [`  rd ${v.rd}`] : []), ...d.staticRoutes.filter((r) => r.vrf === v.name).map((r) => `  ip route ${r.prefix}/${r.mask} ${r.nextHop}`), ...d.interfaces.filter((i) => i.vrf === v.name).sort(cfgCompare).flatMap((i) => ['', `interface ${i.name}`, `  vrf member ${v.name}`])] : []
  }
  return [...head, ...body].join('\n')
}

export function startupDevice(d: Device): Device | undefined {
  if (store(d).startupErased || !d.startup) return undefined
  return deviceFrom(d, d.startup)
}

export function startupConfig(d: Device): string {
  const s = startupDevice(d)
  if (!s) return ''
  return ['', '!Command: show startup-config', `!Startup config saved at: ${nxDate(d.startup!.takenAt)}`, '', ...configBody(s)].join('\n')
}

export function isDirty(d: Device): boolean {
  const s = startupDevice(d)
  return !s || configBody(s).join('\n') !== configBody(d).join('\n')
}
