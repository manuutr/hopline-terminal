/**
 * Live values: the names a CLI completes and validates against, read from the current model, so a
 * test (or a future cli-model profile) can check that the device offers exactly what exists now.
 */
import { bgpUp, isUp, ospfState, type Device } from './state.ts'
import { now } from './core/runtime.ts'

export interface LiveValues {
  interfaces: { name: string; short: string; up: boolean; description?: string }[]
  vlans: { id: number; name: string }[]
  vrfs: string[]
  bgpNeighbors: { ip: string; remoteAs: number; established: boolean; vrf?: string }[]
  ospfNeighbors: { routerId: string; ip: string; iface: string; state?: string }[]
  routeMaps: string[]
  prefixLists: string[]
  acls: string[]
}

export function liveValues(d: Device): LiveValues {
  const t = now(d)
  return {
    interfaces: d.interfaces.map((i) => ({ name: i.name, short: i.short, up: isUp(i), ...(i.description !== undefined ? { description: i.description } : {}) })),
    vlans: d.vlans.map((v) => ({ id: v.id, name: v.name })),
    vrfs: d.vrfs.map((v) => v.name),
    bgpNeighbors: d.bgp.map((n) => ({ ip: n.ip, remoteAs: n.remoteAs, established: bgpUp(n, t), ...(n.vrf ? { vrf: n.vrf } : {}) })),
    ospfNeighbors: (d.ospf?.neighbors ?? []).map((n) => ({ routerId: n.routerId, ip: n.ip, iface: n.iface, state: ospfState(d, n) })),
    routeMaps: d.routeMaps.map((r) => r.name),
    prefixLists: d.prefixLists.map((p) => p.name),
    acls: d.acls.map((a) => a.name)
  }
}
