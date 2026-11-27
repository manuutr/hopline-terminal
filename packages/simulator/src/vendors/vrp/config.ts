/**
 * VRP `display current-configuration` rendering from the model (CE-style sections separated by
 * `#`). Layout from memory of CE6800 V200R0xx [unverified, from memory].
 */
import { maskToDotted } from '../../core/tree.ts'
import type { Device, Iface } from '../../state.ts'
import { isPhysical } from './names.ts'

/** Compress a VLAN id list into VRP `vlan batch` form ("10 20 30 to 35"). */
export function vlanBatch(ids: number[]): string {
  const s = [...new Set(ids)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < s.length; ) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++
    out.push(j - i >= 2 ? `${s[i]} to ${s[j]}` : s.slice(i, j + 1).join(' '))
    i = j + 1
  }
  return out.join(' ')
}

export function ifaceLines(d: Device, i: Iface): string[] {
  const out = [`interface ${i.name}`]
  if (isPhysical(i) && !i.name.startsWith('MEth') && i.mode === 'routed') out.push(' undo portswitch')
  if (i.description !== undefined) out.push(` description ${i.description}`)
  if (i.mode === 'trunk') {
    out.push(' port link-type trunk')
    if (i.nativeVlan !== undefined && i.nativeVlan !== 1) out.push(` port trunk pvid vlan ${i.nativeVlan}`)
    if (i.trunkAllowed?.length) out.push(` port trunk allow-pass vlan ${vlanBatch(i.trunkAllowed)}`)
  } else if (i.mode === 'access' && i.vlan !== undefined && i.vlan !== 1) out.push(` port default vlan ${i.vlan}`)
  if (i.mtu !== undefined && i.mtu !== 1500) out.push(` mtu ${i.mtu}`)
  if (i.ip && i.mask !== undefined) out.push(` ip address ${i.ip} ${maskToDotted(i.mask)}`)
  const o = d.ospf?.ifaces.find((x) => x.iface === i.name)
  if (o?.networkType === 'point-to-point') out.push(' ospf network-type p2p')
  if (o?.cost !== undefined) out.push(` ospf cost ${o.cost}`)
  if (o?.mtuIgnore === false) out.push(' ospf mtu-enable')
  if (!i.adminUp) out.push(' shutdown')
  return out
}

function ospfArea(a: string): string {
  return /^\d+$/.test(a) ? [24, 16, 8, 0].map((s) => (Number(a) >>> s) & 255).join('.') : a
}

export { ospfArea }

function wildcard(len: number): string {
  return maskToDotted(len)
    .split('.')
    .map((o) => 255 - Number(o))
    .join('.')
}

export function configLines(d: Device, opts: { header?: { updated: string; saved?: string } } = {}): string[] {
  const out: string[] = []
  if (opts.header) {
    out.push(`!Software Version ${d.version}`)
    out.push(`!Last configuration was updated at ${opts.header.updated}`)
    if (opts.header.saved) out.push(`!Last configuration was saved at ${opts.header.saved}`)
  }
  out.push('#', `sysname ${d.hostname}`, '#')
  const vids = d.vlans.filter((v) => v.id !== 1).map((v) => v.id)
  if (vids.length) out.push(`vlan batch ${vlanBatch(vids)}`, '#')
  for (const v of d.vlans) if (v.id !== 1 && v.name) out.push(`vlan ${v.id}`, ` name ${v.name}`, '#')
  if (d.services['stelnet']) out.push('stelnet server enable', '#')
  if (d.services['lldp']) out.push('lldp enable', '#')
  for (const i of d.interfaces) out.push(...ifaceLines(d, i), '#')
  if (d.bgp.length) {
    out.push(`bgp ${d.localAs}`, ` router-id ${d.routerId}`)
    for (const n of d.bgp) {
      out.push(` peer ${n.ip} as-number ${n.remoteAs}`)
      if (n.description) out.push(` peer ${n.ip} description ${n.description}`)
      if (n.shutdown) out.push(` peer ${n.ip} ignore`)
    }
    out.push(' #', ' ipv4-family unicast')
    for (const n of d.bgp) out.push(`  peer ${n.ip} enable`)
    out.push('#')
  }
  if (d.ospf) {
    out.push(`ospf ${d.ospf.process} router-id ${d.ospf.routerId ?? d.routerId}`)
    const areas = [...new Set(d.ospf.ifaces.map((x) => x.area))]
    for (const a of areas) {
      out.push(` area ${ospfArea(a)}`)
      for (const x of d.ospf.ifaces.filter((y) => y.area === a)) {
        const i = d.interfaces.find((y) => y.name === x.iface)
        if (i?.ip && i.mask !== undefined) {
          const n = i.ip.split('.').map(Number)
          const m = maskToDotted(i.mask).split('.').map(Number)
          out.push(`  network ${n.map((o, k) => o & m[k]!).join('.')} ${wildcard(i.mask)}`)
        }
      }
    }
    out.push('#')
  }
  for (const r of d.staticRoutes) out.push(`ip route-static ${r.prefix} ${maskToDotted(r.mask)} ${r.nextHop}${r.ad !== undefined && r.ad !== 60 ? ` preference ${r.ad}` : ''}`)
  if (d.staticRoutes.length) out.push('#')
  for (const l of d.extraConfig) out.push(l)
  if (d.extraConfig.length) out.push('#')
  if (d.motd !== undefined) out.push(`header login information "${d.motd}"`, '#')
  out.push('return')
  return out
}
