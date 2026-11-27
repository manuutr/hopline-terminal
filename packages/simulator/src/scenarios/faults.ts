/**
 * Phase 5 fault scenarios (docs/EVALS.md): the rest of the eval catalogue. Like the others they
 * change physical truth or configuration in the device model; the show commands (vendor renderers
 * and scenarios/extra.ts) derive every symptom from it.
 *
 * Each may also have a `peer` side: what the device at the other end of the same link sees, so a
 * multi-device lab (topology.ts) is consistent at both ends for a fleet investigation.
 */
import { now } from '../core/runtime.ts'
import { isUp, logEvent, tickBgp, type BgpNeighbor, type Device, type FhrpGroup, type Iface, type OspfNeighbor, type SimPlatform } from '../state.ts'
import type { Scenario, ScenarioOptions } from './index.ts'

type Family = 'ios' | 'nxos' | 'eos' | 'junos' | 'other'
const family = (p: SimPlatform): Family => (p === 'ios' || p === 'c9800' ? 'ios' : p === 'nxos' ? 'nxos' : p === 'eos' ? 'eos' : p === 'junos' ? 'junos' : 'other')

function fail(d: Device, id: string, why: string): never {
  throw new Error(`scenario ${id}: ${d.hostname} (${d.platform}) ${why}`)
}

function mark(d: Device, id: string): boolean {
  if (d.scenarios.includes(id)) return false
  d.scenarios.push(id)
  return true
}

const invalidate = (d: Device): void => {
  delete d.vendor['junos']
}

/** One log line per family (missing families log nothing), at time `t`. */
function log(d: Device, lines: Partial<Record<Family, string>>, t = now(d)): void {
  const l = lines[family(d.platform)]
  if (l) logEvent(d, l, t)
}

const physical = (i: Iface): boolean => i.speed !== '' && !/^(vlan|loopback|lo\d|tunnel|port-channel|mgmt|fxp|management|me\d|em\d)/i.test(i.name) && !i.vrf
const findIface = (d: Device, name: string): Iface | undefined => d.interfaces.find((i) => i.name.toLowerCase() === name.toLowerCase() || i.short.toLowerCase() === name.toLowerCase())
const pickBgp = (d: Device, o: ScenarioOptions): BgpNeighbor | undefined => (o.neighbor ? d.bgp.find((b) => b.ip === o.neighbor) : (d.bgp.find((b) => b.upSince !== undefined) ?? d.bgp[0]))
const pickOspf = (d: Device, o: ScenarioOptions): OspfNeighbor | undefined => (o.neighbor ? d.ospf?.neighbors.find((x) => x.ip === o.neighbor || x.routerId === o.neighbor) : d.ospf?.neighbors[0])
const localIp = (d: Device, n: BgpNeighbor): string => d.interfaces.find((i) => i.name === n.via)?.ip ?? d.routerId
const ago = (d: Device, ms: number): number => now(d) - ms

function bgpDown(d: Device, n: BgpNeighbor): void {
  const t = now(d)
  if (n.upSince !== undefined) log(d, { ios: `%BGP-5-ADJCHANGE: neighbor ${n.ip} Down Peer closed the session`, nxos: `%BGP-5-ADJCHANGE:  bgp-${d.localAs} [5123]  neighbor ${n.ip} Down - holdtimer expired error`, eos: `%BGP-5-ADJCHANGE: peer ${n.ip} (AS ${n.remoteAs}) old state Established event HoldTimerExpired new state Idle`, junos: `rpd[1734]: BGP_IO_ERROR_CLOSE_SESSION: BGP peer ${n.ip} (External AS ${n.remoteAs}): Error event Hold Timer Expired for I/O session - closing it` }, t)
  invalidate(d)
  tickBgp(d, t)
}

// ------------------------------------------------------------------ BGP authentication

function authLogs(d: Device, n: BgpNeighbor, how: 'invalid' | 'missing'): void {
  const me = localIp(d, n)
  for (const [k, port] of [[300_000, 11024], [120_000, 30388], [15_000, 52214]] as const)
    log(
      d,
      {
        ios: `%TCP-6-BADAUTH: ${how === 'invalid' ? 'Invalid' : 'No'} MD5 digest from ${n.ip}(179) to ${me}(${port}) tableid - 0`,
        nxos: `%TCP-6-BADAUTH: ${how === 'invalid' ? 'Invalid' : 'No'} MD5 digest from ${n.ip}:179 to ${me}:${port} (VRF default)`,
        eos: `%TCP-6-BADAUTH: ${how === 'invalid' ? 'Invalid' : 'No'} MD5 digest from ${n.ip}(179) to ${me}(${port}) vrf default`,
        junos: `/kernel: tcp_auth_ok: Packet from ${n.ip}:179 ${how === 'invalid' ? 'wrong' : 'missing'} MD5 digest`
      },
      ago(d, k)
    )
}

const bgpAuth: Scenario = {
  id: 'bgp-auth-mismatch',
  title: 'BGP session down: MD5 password mismatch',
  symptoms: ['BGP session stays Active/Idle', 'TCP BADAUTH / "wrong MD5 digest" messages for port 179 in the log'],
  fix: 'Set the same neighbor password on both ends (or remove it on both), then let the session re-establish.',
  apply(d, o = {}) {
    const n = pickBgp(d, o)
    if (!n) fail(d, this.id, 'has no BGP neighbor')
    if (!mark(d, this.id)) return
    n.password ??= '0822455D0A16544541'
    n.peerPassword = `${n.password}x`
    authLogs(d, n, 'invalid')
    bgpDown(d, n)
  },
  peer(d, o = {}) {
    const n = pickBgp(d, o)
    if (!n || !mark(d, `${this.id}:peer`)) return
    n.password ??= '13061E010803557878'
    n.peerPassword = `${n.password}y`
    authLogs(d, n, 'invalid')
    bgpDown(d, n)
  }
}

// ------------------------------------------------------------------ BGP blocked by an ACL / filter

function aclName(d: Device): string {
  return family(d.platform) === 'ios' && d.acls.some((a) => a.name === 'EDGE-IN') ? 'EDGE-IN' : 'BGP-PEERS-IN'
}

const bgpAcl: Scenario = {
  id: 'bgp-acl-blocked',
  title: 'BGP session down: an inbound ACL / firewall filter drops TCP 179 from the peer',
  symptoms: ['BGP session stays Active', 'a deny entry for tcp/179 from the peer address has matches that keep climbing'],
  fix: 'Remove (or reorder) the deny entry so TCP 179 from the peer is permitted, then the session comes up.',
  apply(d, o = {}) {
    const n = pickBgp(d, o)
    if (!n) fail(d, this.id, 'has no BGP neighbor')
    if (!mark(d, this.id)) return
    const name = aclName(d)
    const f = family(d.platform)
    const text =
      f === 'junos'
        ? `term deny-bgp from source-address ${n.ip}/32 protocol tcp port bgp then discard`
        : f === 'nxos'
          ? `tcp ${n.ip}/32 any eq bgp log`
          : `tcp host ${n.ip} any eq bgp log`
    let acl = d.acls.find((a) => a.name === name)
    if (!acl) {
      acl = { name, type: 'extended', entries: [] }
      d.acls.push(acl)
      acl.entries.push(f === 'junos' ? { seq: 20, action: 'permit', text: 'term accept-rest then accept', hits: 918_224 } : { seq: 20, action: 'permit', text: f === 'nxos' ? 'ip any any' : 'ip any any', hits: 918_224 })
    }
    acl.entries.unshift({ seq: 5, action: 'deny', text, hits: 1412 })
    acl.entries.sort((a, b) => a.seq - b.seq)
    n.filteredBy = name
    const me = localIp(d, n)
    const via = d.interfaces.find((i) => i.name === n.via)
    for (const [k, c] of [[240_000, 5], [60_000, 6], [10_000, 4]] as const)
      log(
        d,
        {
          ios: `%SEC-6-IPACCESSLOGP: list ${name} denied tcp ${n.ip}(179) -> ${me}(${30000 + c}), ${c} packets`,
          nxos: `%ACLLOG-6-ACLLOG_FLOW_INTERVAL: Src IP: ${n.ip}, Dst IP: ${me}, Src Port: 179, Dst Port: ${30000 + c}, Src Intf: ${via?.name ?? n.via}, Protocol: "TCP"(6), ACL Name: ${name}, ACE Action: Deny, Hit-count = ${c}`,
          eos: `%ACL-6-IPACCESS: list ${name} ${via?.name ?? n.via} denied tcp ${n.ip}(179) -> ${me}(${30000 + c})`
        },
        ago(d, k)
      )
    bgpDown(d, n)
  },
  peer(d, o = {}) {
    const n = pickBgp(d, o)
    if (!n || !mark(d, `${this.id}:peer`)) return
    n.peerRefuses = true
    bgpDown(d, n)
  }
}

// ------------------------------------------------------------------ OSPF hello / area mismatch

function ospfDownLog(d: Device, n: OspfNeighbor, t: number): void {
  log(d, { ios: `%OSPF-5-ADJCHG: Process ${d.ospf!.process}, Nbr ${n.routerId} on ${n.iface} from FULL to DOWN, Neighbor Down: Dead timer expired`, eos: `%OSPF-4-OSPF_ADJACENCY_TEARDOWN: NGB ${n.routerId}, interface ${n.ip} adjacency dropped: inactivity timer expired, state was: FULL`, nxos: `%OSPF-5-NBRSTATE: ospf-${d.ospf!.process} [5300]  Process ${d.ospf!.process}, Nbr ${n.ip} on ${n.iface} from FULL to DOWN, DEADTIME expired`, junos: `rpd[1734]: RPD_OSPF_NBRDOWN: OSPF neighbor ${n.ip} (realm ospf-v2 ${n.iface}.0 area ${n.area}) state changed from Full to Down due to InActiveTimer (event reason: neighbor was inactive and declared dead)` }, t)
}

const ospfCfg = (d: Device, n: OspfNeighbor) => d.ospf!.ifaces.find((x) => x.iface === n.iface)

function helloLogs(d: Device, n: OspfNeighbor, theirs: number, ours: number): void {
  for (const k of [180_000, 60_000, 5_000])
    log(
      d,
      {
        ios: `%OSPF-4-ERRRCV: Received invalid packet: mismatched hello parameters from ${n.ip}, ${n.iface}: Dead R ${theirs * 4} C ${ours * 4}, Hello R ${theirs} C ${ours}`,
        eos: `%OSPF-4-ERRRCV: Received invalid hello from ${n.ip} on ${n.iface}: hello interval mismatch (received ${theirs}, configured ${ours})`,
        nxos: `%OSPF-4-ERRRCV: ospf-${d.ospf!.process} [5300]  Received invalid hello from ${n.ip} on ${n.iface}: hello interval ${theirs}, ours ${ours}`,
        junos: `rpd[1734]: OSPF packet ignored: hello interval mismatch (${theirs}) from ${n.ip} on intf ${n.iface}.0 area ${n.area}`
      },
      ago(d, k)
    )
}

const ospfHello: Scenario = {
  id: 'ospf-hello-mismatch',
  title: 'OSPF adjacency down: hello/dead interval mismatch',
  symptoms: ['the OSPF neighbor is missing from the neighbor table', 'hello-parameter mismatch messages in the log'],
  fix: 'Use the same hello and dead intervals on both ends of the link (ip ospf hello-interval / dead-interval).',
  apply(d, o = {}) {
    const n = pickOspf(d, o)
    if (!n) fail(d, this.id, 'has no OSPF neighbor')
    if (!mark(d, this.id)) return
    const ours = ospfCfg(d, n)?.hello ?? 10
    n.peerHello = ours === 5 ? 10 : 5
    if (n.upSince !== undefined) ospfDownLog(d, n, ago(d, 200_000))
    n.upSince = undefined
    helloLogs(d, n, n.peerHello, ours)
  },
  peer(d, o = {}) {
    const n = pickOspf(d, o)
    if (!n || !mark(d, `${this.id}:peer`)) return
    const c = ospfCfg(d, n)
    if (c) c.hello = 5
    n.peerHello = 10
    if (n.upSince !== undefined) ospfDownLog(d, n, ago(d, 200_000))
    n.upSince = undefined
    helloLogs(d, n, 10, 5)
    invalidate(d)
  }
}

function areaLogs(d: Device, n: OspfNeighbor, theirs: string): void {
  for (const k of [180_000, 60_000, 5_000])
    log(
      d,
      {
        ios: `%OSPF-4-ERRRCV: Received invalid packet: mismatched area ID from backbone area must be virtual-link but not found from ${n.ip}, ${n.iface}`,
        eos: `%OSPF-4-ERRRCV: Received packet with mismatched area ${theirs} from ${n.ip} on ${n.iface}`,
        nxos: `%OSPF-4-ERRRCV: ospf-${d.ospf!.process} [5300]  Received packet with mismatched area id ${theirs} from ${n.ip} on ${n.iface}`,
        junos: `rpd[1734]: OSPF packet ignored: area mismatch (${theirs}) from ${n.ip} on intf ${n.iface}.0 area ${n.area}`
      },
      ago(d, k)
    )
}

const ospfArea: Scenario = {
  id: 'ospf-area-mismatch',
  title: 'OSPF adjacency down: the two ends put the link in different areas',
  symptoms: ['the OSPF neighbor is missing from the neighbor table', 'mismatched area ID messages in the log'],
  fix: 'Put the link in the same area on both routers.',
  apply(d, o = {}) {
    const n = pickOspf(d, o)
    if (!n) fail(d, this.id, 'has no OSPF neighbor')
    if (!mark(d, this.id)) return
    const ours = ospfCfg(d, n)?.area ?? n.area
    n.peerArea = /^(0|0\.0\.0\.0)$/.test(ours) ? '0.0.0.1' : '0.0.0.0'
    if (n.upSince !== undefined) ospfDownLog(d, n, ago(d, 200_000))
    n.upSince = undefined
    areaLogs(d, n, n.peerArea)
  },
  peer(d, o = {}) {
    const n = pickOspf(d, o)
    if (!n || !mark(d, `${this.id}:peer`)) return
    const c = ospfCfg(d, n)
    const ours = c?.area ?? n.area
    if (c) c.area = /^(0|0\.0\.0\.0)$/.test(ours) ? '0.0.0.1' : '0.0.0.0'
    n.peerArea = ours
    n.upSince = undefined
    areaLogs(d, n, ours)
    invalidate(d)
  }
}

// ------------------------------------------------------------------ port security

const ROGUE_MAC = '3c52.82aa.1f07'

const portSecurity: Scenario = {
  id: 'port-security-violation',
  title: 'Access port err-disabled by a port-security violation',
  symptoms: ['port shows err-disabled (psecure-violation)', 'the host on that port is offline', 'a security violation from an unknown MAC in the log'],
  fix: 'Find the device with the new MAC (a hub, a dock or a swapped PC), clear the sticky MAC or raise the maximum, then shut/no shut the port.',
  apply(d, o = {}) {
    if (family(d.platform) === 'junos' || family(d.platform) === 'other') fail(d, this.id, 'has no port-security model')
    const i = o.iface ? findIface(d, o.iface) : [...d.interfaces].reverse().find((x) => x.mode === 'access' && x.adminUp && x.linkUp && !x.errDisabled && physical(x))
    if (!i) fail(d, this.id, 'has no up access port')
    if (!mark(d, this.id)) return
    const t = now(d)
    i.portSecurity = { max: 1, violation: 'shutdown', violations: 1, lastMac: ROGUE_MAC, lastVlan: i.vlan ?? 1 }
    i.errDisabled = 'psecure-violation'
    i.lastChange = t
    log(d, { ios: `%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${ROGUE_MAC} on port ${i.name}.`, eos: `%ETH-4-PORT_SECURITY_VIOLATION: Port security violation on ${i.name}: MAC address ${ROGUE_MAC} on VLAN ${i.vlan ?? 1}`, nxos: `%ETH_PORT_SEC-2-ETH_PORT_SEC_SECURITY_VIOLATION_MAX_MAC_VLAN: Port ${i.name} moved to SHUTDOWN state as host ${ROGUE_MAC} is trying to access the port in vlan ${i.vlan ?? 1}` }, t)
    log(d, { ios: `%PM-4-ERR_DISABLE: psecure-violation error detected on ${i.short}, putting ${i.short} in err-disable state`, eos: `%ETH-4-ERRDISABLE: psecure-violation error detected on ${i.name}.`, nxos: `%ETHPORT-5-IF_DOWN_ERROR_DISABLED: Interface ${i.name} is down (Error disabled. Reason:psecure-violation)` }, t)
    log(d, { ios: `%LINK-3-UPDOWN: Interface ${i.name}, changed state to down` }, t)
    invalidate(d)
    tickBgp(d, t)
  }
}

// ------------------------------------------------------------------ spanning tree root moved

const ROGUE_BRIDGE = 'aabb.cc00.0999'

const stpRoot: Scenario = {
  id: 'stp-root-moved',
  title: 'Spanning-tree root moved to a rogue switch on an access port',
  symptoms: ['the root bridge for a VLAN is an unknown MAC with priority 4096', 'the root port is an access port', 'root-change and topology-change messages in the log'],
  fix: 'Remove the rogue switch (or enable BPDU guard / root guard on edge ports) and set the intended root bridge priority lower.',
  apply(d, o = {}) {
    const f = family(d.platform)
    if (f === 'junos' || f === 'other') fail(d, this.id, 'has no spanning-tree model')
    const i = o.iface ? findIface(d, o.iface) : d.interfaces.find((x) => x.mode === 'access' && isUp(x) && !x.bpduGuard && physical(x) && (x.vlan ?? 1) !== 1)
    if (!i) fail(d, this.id, 'has no up access port without BPDU guard')
    if (!mark(d, this.id)) return
    const v = o.vlan ?? i.vlan ?? 1
    const t = now(d)
    d.stp = { vlans: [v], rootPriority: 4096, rootMac: ROGUE_BRIDGE, rootPort: i.name, rootCost: 4, changedAt: ago(d, 420_000), changes: 3 }
    const vl = `VLAN${String(v).padStart(4, '0')}`
    log(d, { ios: `%SPANTREE-5-ROOTCHANGE: Root Changed for vlan ${v}: New Root Port is ${i.name}. New Root Mac Address is ${ROGUE_BRIDGE}`, nxos: `%STP-6-ROOT: Root bridge for ${vl} changed to ${4096 + v} ${ROGUE_BRIDGE} (root port ${i.name})`, eos: `%SPANTREE-6-ROOTCHANGE: Root changed for instance VL${v}: new root interface is ${i.name}, new root bridge id is ${4096 + v}.${ROGUE_BRIDGE} (old root interface was None)` }, ago(d, 420_000))
    log(d, { ios: `%SPANTREE-5-TOPOTRAP: Topology Change Trap for vlan ${v}`, nxos: `%STP-6-TOPOLOGY_CHANGE: Topology change detected for ${vl} on port ${i.name}`, eos: `%SPANTREE-6-TOPOLOGY_CHANGE: Topology change detected on VL${v} port ${i.name}` }, ago(d, 419_000))
    void t
  }
}

// ------------------------------------------------------------------ HSRP / VRRP flapping

interface FhrpPlan {
  iface: string
  group: number
  vip: string
  peer: string
  track: string
  /** Address to give the interface when it has none (Junos lab). */
  ip?: [string, number]
}

const FHRP: Partial<Record<Family, FhrpPlan>> = {
  ios: { iface: 'Vlan10', group: 10, vip: '10.10.10.254', peer: '10.10.10.2', track: 'GigabitEthernet1/0/48' },
  nxos: { iface: 'Vlan100', group: 100, vip: '10.20.100.254', peer: '10.20.100.3', track: 'Ethernet1/47' },
  eos: { iface: 'Vlan100', group: 10, vip: '10.100.0.254', peer: '10.100.0.3', track: 'Ethernet48' },
  junos: { iface: 'ge-0/0/2', group: 10, vip: '10.0.9.254', peer: '10.0.9.3', track: 'ge-0/0/0', ip: ['10.0.9.2', 24] }
}

const fhrpFlap: Scenario = {
  id: 'fhrp-flap',
  title: 'HSRP/VRRP flapping: a tracked uplink keeps bouncing, so priority drops below the peer and preemption swaps the active router',
  symptoms: ['gateway state changes every minute or two (Active/Standby, Master/Backup)', 'the tracked uplink goes down and up in the log at the same times', 'many interface resets'],
  fix: 'Fix the flapping uplink (cable/optic, far end). Meanwhile, add a preempt delay or stop tracking that link.',
  apply(d) {
    const f = family(d.platform)
    const plan = FHRP[f]
    const i = plan && d.interfaces.find((x) => x.name === plan.iface)
    const tr = plan && d.interfaces.find((x) => x.name === plan.track)
    if (!plan || !i || !tr) fail(d, this.id, 'has no gateway interface and uplink to track')
    if (!mark(d, this.id)) return
    if (!i.ip && plan.ip) [i.ip, i.mask] = plan.ip
    const proto = f === 'ios' || f === 'nxos' ? 'hsrp' : 'vrrp'
    const [up, down] = proto === 'hsrp' ? (['Active', 'Standby'] as const) : (['Master', 'Backup'] as const)
    const g: FhrpGroup = { proto, iface: i.name, group: plan.group, vip: plan.vip, priority: 110, preempt: true, state: up, peer: plan.peer, peerPriority: 100, track: { iface: tr.name, decrement: 20 }, transitions: 0, lastChange: now(d) }
    d.fhrp = [...(d.fhrp ?? []), g]
    tr.errors = { ...tr.errors, resets: (tr.errors?.resets ?? 0) + 14 }
    for (let k = 6; k >= 1; k--) {
      const t0 = ago(d, k * 95_000)
      const t1 = t0 + 22_000
      log(d, { ios: `%LINK-3-UPDOWN: Interface ${tr.name}, changed state to down`, nxos: `%ETHPORT-5-IF_DOWN_LINK_FAILURE: Interface ${tr.name} is down (Link failure)`, eos: `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${tr.name}, changed state to down`, junos: `mib2d[1690]: SNMP_TRAP_LINK_DOWN: ifIndex 526, ifAdminStatus up(1), ifOperStatus down(2), ifName ${tr.name}` }, t0)
      log(d, { ios: `%TRACK-6-STATE: 1 interface ${tr.short} line-protocol Up -> Down`, nxos: `%HSRP_ENGINE-5-TRACKDOWN: Tracked object 1 (interface ${tr.name} line-protocol) went DOWN`, eos: `%VRRP-6-TRACKCHANGE: ${i.name} group ${g.group} tracked interface ${tr.name} down, priority ${g.priority} -> ${g.priority - 20}` }, t0 + 50)
      log(d, { ios: `%HSRP-5-STATECHANGE: ${i.name} Grp ${g.group} state ${up} -> Speak`, nxos: `%HSRP_ENGINE-5-STATECHANGE: Interface ${i.name} Grp ${g.group} state change from ${up} to Speak`, eos: `%VRRP-6-STATECHANGE: ${i.name} Grp ${g.group} state ${up} -> ${down}`, junos: `vrrpd[1544]: VRRPD_NEW_BACKUP: Interface ${i.name}.0 (local address ${i.ip}) became VRRP backup for group ${g.group}` }, t0 + 3_200)
      if (proto === 'hsrp') log(d, { ios: `%HSRP-5-STATECHANGE: ${i.name} Grp ${g.group} state Speak -> ${down}`, nxos: `%HSRP_ENGINE-5-STATECHANGE: Interface ${i.name} Grp ${g.group} state change from Speak to ${down}` }, t0 + 13_000)
      log(d, { ios: `%LINK-3-UPDOWN: Interface ${tr.name}, changed state to up`, nxos: `%ETHPORT-5-IF_UP: Interface ${tr.name} is up in mode routed`, eos: `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${tr.name}, changed state to up`, junos: `mib2d[1690]: SNMP_TRAP_LINK_UP: ifIndex 526, ifAdminStatus up(1), ifOperStatus up(1), ifName ${tr.name}` }, t1)
      log(d, { ios: `%TRACK-6-STATE: 1 interface ${tr.short} line-protocol Down -> Up`, nxos: `%HSRP_ENGINE-5-TRACKUP: Tracked object 1 (interface ${tr.name} line-protocol) went UP`, eos: `%VRRP-6-TRACKCHANGE: ${i.name} group ${g.group} tracked interface ${tr.name} up, priority ${g.priority - 20} -> ${g.priority}` }, t1 + 50)
      log(d, { ios: `%HSRP-5-STATECHANGE: ${i.name} Grp ${g.group} state ${down} -> ${up}`, nxos: `%HSRP_ENGINE-5-STATECHANGE: Interface ${i.name} Grp ${g.group} state change from ${down} to ${up}`, eos: `%VRRP-6-STATECHANGE: ${i.name} Grp ${g.group} state ${down} -> ${up}`, junos: `vrrpd[1544]: VRRPD_NEW_MASTER: Interface ${i.name}.0 (local address ${i.ip}) became VRRP master for group ${g.group} with master reason preempt` }, t1 + 1_000)
      g.transitions += proto === 'hsrp' ? 3 : 2
      g.lastChange = t1 + 1_000
      tr.lastChange = t1
    }
    // Whatever the tracked link is doing now decides the current state (priority 90 < peer 100 while it is down).
    if (!isUp(tr)) {
      g.state = down
      g.transitions += 1
      g.lastChange = ago(d, 30_000)
    }
    invalidate(d)
  }
}

// ------------------------------------------------------------------ CRC errors (physical layer)

const crcErrors: Scenario = {
  id: 'crc-errors',
  title: 'Input/CRC errors climbing on a link with matched duplex (bad cable or optic)',
  symptoms: ['CRC and input errors keep increasing on one interface', 'duplex and speed match (full), no collisions', 'retransmissions and slow transfers across the link'],
  fix: 'Replace the cable / optic (or clean the fibre) on that link, then clear counters and confirm they stay at zero.',
  apply(d, o = {}) {
    const withNeighbor = (x: Iface) => d.lldp.some((n) => n.local === x.name || n.local === x.short)
    const i = o.iface ? findIface(d, o.iface) : (d.interfaces.find((x) => physical(x) && isUp(x) && withNeighbor(x) && x.mode !== 'access') ?? d.interfaces.find((x) => physical(x) && isUp(x)))
    if (!i) fail(d, this.id, 'has no up physical interface')
    if (!mark(d, this.id)) return
    i.crcRate = 140
    i.faultSince = ago(d, 30 * 60_000)
    i.duplex = undefined
    i.peer = { ...i.peer, duplex: undefined, speed: undefined }
  }
}

// ------------------------------------------------------------------ peers for the existing link faults

/** Far-end sides of scenarios defined in index.ts (same link, the other device). */
export const PEERS: Record<string, (d: Device, o: ScenarioOptions) => void> = {
  'bgp-wrong-as'(d, o) {
    const n = pickBgp(d, o)
    if (!n || !mark(d, 'bgp-wrong-as:peer')) return
    n.peerRefuses = true
    log(d, { ios: `%BGP-3-NOTIFICATION: received from neighbor ${n.ip} active 2/2 (peer in wrong AS) 2 bytes ${d.localAs.toString(16).toUpperCase().padStart(4, '0')}`, nxos: `%BGP-3-NOTIFICATION: bgp-${d.localAs} [5123] received from neighbor ${n.ip} 2/2 (bad peer AS)`, eos: `%BGP-3-NOTIFICATION: received from neighbor ${n.ip} (VRF default AS ${n.remoteAs}) 2/2 (Open Message Error/bad peer AS)`, junos: `rpd[1734]: bgp_read_v4_message:12018: NOTIFICATION received from ${n.ip} (External AS ${n.remoteAs}): code 2 (Open Message Error) subcode 2 (bad peer AS number)` })
    bgpDown(d, n)
  },
  'ospf-mtu-mismatch'(d, o) {
    const n = pickOspf(d, o)
    if (!n || !mark(d, 'ospf-mtu-mismatch:peer')) return
    const i = d.interfaces.find((x) => x.name === n.iface)
    if (i) i.mtu = 9100
    n.peerMtu = 1500
    n.upSince = undefined
    invalidate(d)
  },
  'duplex-mismatch'(d, o) {
    const i = o.iface ? findIface(d, o.iface) : undefined
    if (!i || !mark(d, 'duplex-mismatch:peer')) return
    i.duplex = 'full'
    i.speedSet = '100'
    i.peer = { ...i.peer, duplex: 'auto' }
    i.faultSince = now(d)
    invalidate(d)
  }
}

export const FAULTS: Scenario[] = [bgpAuth, bgpAcl, ospfHello, ospfArea, portSecurity, stpRoot, fhrpFlap, crcErrors]
