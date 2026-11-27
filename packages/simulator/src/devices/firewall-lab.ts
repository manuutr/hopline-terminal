import { makeFortiosDevice } from './fortios.ts'
import { makePanosDevice } from './panos.ts'
import type { Device } from '../state.ts'
import { fdata } from '../vendors/fortios/render.ts'

/** Two ends of a route-based site VPN. The branch LAN uses VRF 10, but only VRF 20
 * has a specific route back to the DC. Keep the standalone vendor fixtures unchanged. */
export function makeFirewallLab(): { fortios: Device; panos: Device } {
  const fortios = makeFortiosDevice()
  const panos = makePanosDevice()
  for (const i of fortios.interfaces) {
    if (i.name === 'port1' || i.name === 'port3') i.vrf = '10'
    if (i.name === 'vlan100') i.vrf = '20'
  }
  fortios.interfaces.push({
    name: 'to-dc', short: 'to-dc', ip: '169.254.10.2', mask: 30, vrf: '10', mode: 'routed',
    adminUp: true, linkUp: true, speed: '', mac: '00:00:00:00:00:00'
  })
  fdata(fortios).ifExtra['to-dc'] = [['type', 'tunnel'], ['interface', '"port1"']]
  fortios.staticRoutes.push({ prefix: '10.100.0.0', mask: 24, nextHop: '10.20.100.254', vrf: '20' })
  panos.staticRoutes.push({ prefix: '10.20.0.0', mask: 24, nextHop: '169.254.10.2' })
  fortios.ipsec = [{ name: 'to-dc', iface: 'to-dc', underlay: 'port1', peer: '10.0.3.2', rx: 184, tx: 11 }]
  panos.ipsec = [{ name: 'to-branch', iface: 'tunnel.1', underlay: 'ethernet1/1', peer: '203.0.113.2', rx: 11, tx: 184 }]
  return { fortios, panos }
}
