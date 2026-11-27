/**
 * EOS running-config rendered from the model (docs/research/cli-arista-eos.md §6.11): `!`
 * separators, three-space indentation, prefix-length addresses, `end` at the bottom.
 */
import { deviceFrom, type Device, type Iface } from '../../state.ts'
import { vlanCompress } from '../ios/config.ts'

const TYPE_ORDER = ['Ethernet', 'Loopback', 'Management', 'Port-Channel', 'Tunnel', 'Vlan', 'Vxlan']

/** EOS natural interface order: by type, then numerically. */
export function ifOrder(a: Iface, b: Iface): number {
  const ta = /^[A-Za-z-]+/.exec(a.name)?.[0] ?? ''
  const tb = /^[A-Za-z-]+/.exec(b.name)?.[0] ?? ''
  const ra = TYPE_ORDER.indexOf(ta)
  const rb = TYPE_ORDER.indexOf(tb)
  if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
  const na = a.name.slice(ta.length).split(/[/.]/).map(Number)
  const nb = b.name.slice(tb.length).split(/[/.]/).map(Number)
  for (let k = 0; k < Math.max(na.length, nb.length); k++) if ((na[k] ?? -1) !== (nb[k] ?? -1)) return (na[k] ?? -1) - (nb[k] ?? -1)
  return 0
}

export const sortedIfaces = (d: Device): Iface[] => [...d.interfaces].sort(ifOrder)

const defaultMtu = (i: Iface): number => (i.name.startsWith('Loopback') ? 65535 : 1500)

/** Config lines for one interface, without the `interface` line and trailing `!`. */
export function ifaceBody(d: Device, i: Iface): string[] {
  const l: string[] = []
  const eth = /^(Ethernet|Port-Channel)/.test(i.name)
  if (i.description !== undefined) l.push(`   description ${i.description}`)
  if (eth && i.mode === 'routed') l.push('   no switchport')
  if (!i.adminUp) l.push('   shutdown')
  if (i.mtu !== undefined && i.mtu !== defaultMtu(i)) l.push(`   mtu ${i.mtu}`)
  if (i.speedSet) l.push(`   speed forced ${i.speedSet}${i.duplex === 'half' ? 'half' : 'full'}`)
  if (i.channelGroup !== undefined) l.push(`   channel-group ${i.channelGroup} mode active`)
  if (eth && i.mode === 'access' && i.vlan !== undefined && i.vlan !== 1) l.push(`   switchport access vlan ${i.vlan}`)
  if (eth && i.mode === 'trunk') {
    if (i.nativeVlan !== undefined && i.nativeVlan !== 1) l.push(`   switchport trunk native vlan ${i.nativeVlan}`)
    if (i.trunkAllowed !== undefined) l.push(`   switchport trunk allowed vlan ${i.trunkAllowed.length ? vlanCompress(i.trunkAllowed) : 'none'}`)
    l.push('   switchport mode trunk')
  }
  if (i.bpduGuard) l.push('   spanning-tree bpduguard enable')
  if (i.vrf) l.push(`   vrf ${i.vrf}`)
  if (i.ip) l.push(`   ip address ${i.ip}/${i.mask}`)
  const o = d.ospf?.ifaces.find((x) => x.iface === i.name)
  if (o) {
    if (o.networkType === 'point-to-point') l.push('   ip ospf network point-to-point')
    if (o.cost !== undefined) l.push(`   ip ospf cost ${o.cost}`)
    l.push(`   ip ospf area ${o.area}`)
  }
  return l
}

export function configLines(d: Device): string[] {
  const l: string[] = [`! Command: show running-config`, `! device: ${d.hostname} (${d.model}, EOS-${d.version})`, '!', `! boot system flash:/EOS-${d.version}.swi`, '!']
  for (const x of d.extraConfig.filter((e) => /^terminal /.test(e))) l.push(x)
  if (d.extraConfig.some((e) => /^terminal /.test(e))) l.push('!')
  l.push(`hostname ${d.hostname}`, '!')
  for (const x of d.extraConfig.filter((e) => !/^terminal /.test(e))) l.push(x, '!')
  for (const v of d.vlans.filter((x) => x.id !== 1)) {
    l.push(`vlan ${v.id}`)
    if (v.name !== `VLAN${String(v.id).padStart(4, '0')}`) l.push(`   name ${v.name}`)
    if (v.shutdown) l.push('   state suspend')
    l.push('!')
  }
  for (const v of d.vrfs) {
    l.push(`vrf instance ${v.name}`)
    if (v.rd) l.push(`   rd ${v.rd}`)
    l.push('!')
  }
  for (const i of sortedIfaces(d)) {
    const body = ifaceBody(d, i)
    if (!body.length && i.name.startsWith('Ethernet')) continue
    l.push(`interface ${i.name}`, ...body, '!')
  }
  for (const a of d.acls) {
    l.push(`ip access-list ${a.type === 'standard' ? 'standard ' : ''}${a.name}`)
    for (const e of a.entries) l.push(`   ${e.seq} ${e.action} ${e.text}`)
    l.push('!')
  }
  if (d.services['ip-routing'] !== false) l.push('ip routing')
  else l.push('no ip routing')
  for (const v of d.vrfs) l.push(`no ip routing vrf ${v.name}`)
  l.push('!')
  if (d.prefixLists.length) {
    for (const p of d.prefixLists) {
      l.push(`ip prefix-list ${p.name}`)
      for (const e of p.entries) l.push(`   seq ${e.seq} ${e.action} ${e.prefix}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`)
    }
    l.push('!')
  }
  if (d.staticRoutes.length) {
    for (const r of d.staticRoutes) l.push(`ip route ${r.vrf ? `vrf ${r.vrf} ` : ''}${r.prefix}/${r.mask} ${r.nextHop}${r.ad !== undefined ? ` ${r.ad}` : ''}${r.name ? ` name ${r.name}` : ''}`)
    l.push('!')
  }
  for (const rm of d.routeMaps) {
    for (const e of rm.entries) {
      l.push(`route-map ${rm.name} ${e.action} ${e.seq}`)
      for (const m of e.match) l.push(`   match ${m}`)
      for (const s of e.set) l.push(`   set ${s}`)
      l.push('!')
    }
  }
  if (d.localAs) {
    l.push(`router bgp ${d.localAs}`, `   router-id ${d.routerId}`)
    for (const n of d.bgp.filter((x) => !x.vrf)) {
      l.push(`   neighbor ${n.ip} remote-as ${n.remoteAs}`)
      if (n.description !== undefined) l.push(`   neighbor ${n.ip} description ${n.description}`)
      if (n.updateSource) l.push(`   neighbor ${n.ip} update-source ${n.updateSource}`)
      if (n.shutdown) l.push(`   neighbor ${n.ip} shutdown`)
      if (n.password) l.push(`   neighbor ${n.ip} password 7 ${n.password}`)
      if (n.routeMapIn) l.push(`   neighbor ${n.ip} route-map ${n.routeMapIn} in`)
      if (n.routeMapOut) l.push(`   neighbor ${n.ip} route-map ${n.routeMapOut} out`)
    }
    l.push('!')
  }
  if (d.ospf) {
    l.push(`router ospf ${d.ospf.process}`)
    if (d.ospf.routerId) l.push(`   router-id ${d.ospf.routerId}`)
    for (const o of d.ospf.ifaces.filter((x) => x.passive)) l.push(`   passive-interface ${o.iface}`)
    l.push('!')
  }
  if (d.motd !== undefined) l.push('banner motd', ...d.motd.split('\n'), 'EOF', '!')
  l.push('end')
  return l
}

export const runningConfig = (d: Device): string => configLines(d).join('\n')

export function startupLines(d: Device): string[] {
  if (!d.startup) return configLines(d)
  return configLines(deviceFrom(d, d.startup))
}

export function isDirty(d: Device): boolean {
  return startupLines(d).join('\n') !== configLines(d).join('\n')
}
