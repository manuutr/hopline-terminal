import { describe, expect, it } from 'vitest'
import { LAB_LINKS, LAB_NODES, buildLab, labPorts, portTable } from '../src/topology.ts'
import { liveValues } from '../src/live.ts'
import { bgpUp } from '../src/state.ts'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

describe('topology lab', () => {
  const lab = buildLab(T0)

  it('has the required mix of platforms', () => {
    const count = (p: string): number => lab.nodes.filter((n) => n.platform === p).length
    expect(count('ios')).toBe(2)
    expect(count('eos')).toBe(2)
    for (const p of ['nxos', 'junos', 'panos', 'fortios', 'asa', 'iosxr', 'c9800']) expect(count(p)).toBeGreaterThanOrEqual(1)
    expect(new Set(lab.nodes.map((n) => n.device.hostname)).size).toBe(lab.nodes.length)
  })

  it('assigns sequential ports and prints a table', () => {
    const ports = labPorts(lab, 2220)
    expect(ports.map((p) => p.ssh)).toEqual(LAB_NODES.map((_, k) => 2220 + k))
    expect(ports.map((p) => p.telnet)).toEqual(LAB_NODES.map((_, k) => 2320 + k))
    const t = portTable(ports)
    for (const n of LAB_NODES) expect(t).toContain(n.name)
  })

  it('every link is mirrored in LLDP at both ends', () => {
    for (const l of LAB_LINKS) {
      const a = lab.device(l.a[0])
      const b = lab.device(l.b[0])
      const ia = a.interfaces.find((i) => i.name === l.a[1])!
      const ib = b.interfaces.find((i) => i.name === l.b[1])!
      expect(ia, `${l.a.join(' ')}`).toBeDefined()
      expect(ib, `${l.b.join(' ')}`).toBeDefined()
      const na = a.lldp.find((n) => n.local === ia.name || n.local === ia.short)
      const nb = b.lldp.find((n) => n.local === ib.name || n.local === ib.short)
      expect(na?.device, `${a.hostname} ${ia.name}`).toBe(b.hostname)
      expect(nb?.device, `${b.hostname} ${ib.name}`).toBe(a.hostname)
      expect([ib.name, ib.short]).toContain(na!.port)
      expect([ia.name, ia.short]).toContain(nb!.port)
    }
  })

  it('BGP sessions agree on addresses and AS numbers and come up', () => {
    for (const l of LAB_LINKS.filter((x) => x.bgp)) {
      const a = lab.device(l.a[0])
      const b = lab.device(l.b[0])
      const ia = a.interfaces.find((i) => i.name === l.a[1])!
      const ib = b.interfaces.find((i) => i.name === l.b[1])!
      const na = a.bgp.find((n) => n.ip === ib.ip)
      const nb = b.bgp.find((n) => n.ip === ia.ip)
      expect(na?.remoteAs, `${a.hostname} -> ${ib.ip}`).toBe(b.localAs)
      expect(nb?.remoteAs, `${b.hostname} -> ${ia.ip}`).toBe(a.localAs)
      expect(bgpUp(na!, T0 + 10_000)).toBe(true)
      expect(bgpUp(nb!, T0 + 10_000)).toBe(true)
    }
  })

  it('AS numbers are unique except the iBGP core pair', () => {
    const as = lab.nodes.filter((n) => n.device.localAs).map((n) => [n.name, n.device.localAs] as const)
    const dup = as.filter(([name, x]) => as.some(([m, y]) => m !== name && y === x)).map(([n]) => n)
    expect(dup.sort()).toEqual(['core-sw1', 'core-sw2'])
  })

  it('routed links are addressed consistently and show in live values', () => {
    for (const l of LAB_LINKS.filter((x) => x.net)) {
      const a = lab.device(l.a[0])
      const ia = a.interfaces.find((i) => i.name === l.a[1])!
      expect(liveValues(a).interfaces.find((i) => i.name === ia.name)?.up).toBe(true)
      expect(ia.ip).toBeDefined()
    }
  })
})
