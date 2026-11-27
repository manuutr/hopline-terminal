import type { SessionPlatform } from '@shared/types'
import { applyPeerScenario, applyScenario, buildLab, makeDevice, type Device, type SimPlatform } from '../../../../packages/simulator/src/index.ts'

/**
 * The eval catalogue (docs/EVALS.md): fault scenarios on the simulator, each with a ground-truth
 * root cause, a keyword rubric for the answer, and the evidence a good investigation cites.
 *
 * Facts (which neighbor, which port) are read from the device after the scenario is applied, so a
 * change to a lab device moves the expected answer with it.
 */

export type Family = 'ios' | 'nxos' | 'eos' | 'junos'

export const SESSION_PLATFORM: Record<Family, SessionPlatform> = { ios: 'iosxe', nxos: 'nxos', eos: 'eos', junos: 'junos' }
export const LABEL: Record<Family, string> = { ios: 'IOS-XE', nxos: 'NX-OS', eos: 'EOS', junos: 'Junos' }

/** A command the scripted investigation runs, with the optional local filter. */
export interface Probe {
  command: string
  filter?: { grep?: string; ignoreCase?: boolean; tail?: number; head?: number }
}

/** Evidence the answer should rest on: a line of a probe's output that matches `re`. */
export interface Evidence {
  /** Index into `probes`. */
  probe: number
  re: RegExp
  /** What the line shows, for the report. */
  what: string
}

export interface Truth {
  /** One or two sentences: the root cause as an engineer would state it. */
  rootCause: string
  /** Every group must match the answer (each group is a list of alternatives). */
  rubric: RegExp[][]
  probes: Probe[]
  evidence: Evidence[]
}

export interface SingleCase {
  id: string
  scenario: string
  family: Family
  /** Device name (session name). */
  name: string
  question: string
  device: () => Device
  /** Ground truth for the device as built. */
  truth: (d: Device) => Truth
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const word = (s: string): RegExp => new RegExp(`(?<![\\w.])${esc(s)}(?![\\w])`, 'i')
/** An interface by full or short name (Gi1/0/3, GigabitEthernet1/0/3, Et10, Ethernet10). */
const ifRe = (d: Device, name: string): RegExp => {
  const i = d.interfaces.find((x) => x.name === name || x.short === name)
  const alts = [...new Set([name, i?.short ?? name, i?.name ?? name])].map(esc)
  return new RegExp(`(?<![\\w/])(?:${alts.join('|')})(?![\\w/])`, 'i')
}

const BGP_SUM: Record<Family, string> = { ios: 'show ip bgp summary', nxos: 'show ip bgp summary', eos: 'show ip bgp summary', junos: 'show bgp summary' }
const LOG: Record<Family, string> = { ios: 'show logging', nxos: 'show logging logfile', eos: 'show logging', junos: 'show log messages' }
const OSPF_NBR: Record<Family, string> = { ios: 'show ip ospf neighbor', nxos: 'show ip ospf neighbors', eos: 'show ip ospf neighbor', junos: 'show ospf neighbor' }
const OSPF_IF: Record<Family, string> = { ios: 'show ip ospf interface', nxos: 'show ip ospf interface', eos: 'show ip ospf interface', junos: 'show ospf interface detail' }
const TRUNK: Record<Family, string> = { ios: 'show interfaces trunk', nxos: 'show interface trunk', eos: 'show interfaces trunk', junos: 'show interfaces terse' }
const ERRDIS: Record<Family, string> = { ios: 'show interfaces status err-disabled', nxos: 'show interface brief', eos: 'show interfaces status errdisabled', junos: 'show interfaces terse' }
const STATUS: Record<Family, string> = { ios: 'show interfaces status', nxos: 'show interface status', eos: 'show interfaces status', junos: 'show interfaces terse' }
const ERRORS: Record<Family, string> = { ios: 'show interfaces counters errors', nxos: 'show interface counters errors', eos: 'show interfaces counters errors', junos: 'show interfaces extensive' }
const ACL: Record<Family, string> = { ios: 'show access-lists', nxos: 'show ip access-lists', eos: 'show ip access-lists', junos: 'show firewall' }
const IFACE = (f: Family, n: string): string => (f === 'junos' ? `show interfaces ${n} extensive` : f === 'nxos' ? `show interface ${n}` : `show interfaces ${n}`)
const logGrep = (f: Family, grep: string): Probe => ({ command: LOG[f], filter: { grep, ignoreCase: true, tail: 40 } })

const SIM: Record<Family, SimPlatform> = { ios: 'ios', nxos: 'nxos', eos: 'eos', junos: 'junos' }

interface Fault {
  scenario: string
  families: Family[]
  question: string
  truth: (d: Device, f: Family) => Truth
}

const DOWN = /Active|Idle|Connect/

const FAULTS: Fault[] = [
  {
    scenario: 'bgp-wrong-as',
    families: ['ios', 'nxos', 'eos', 'junos'],
    question: 'A BGP session on this router is down. Find out why.',
    truth: (d, f) => {
      const n = d.bgp.find((b) => b.peerAs !== undefined)!
      const detail: Probe = f === 'junos' ? { command: `show bgp neighbor ${n.ip}` } : f === 'ios' ? logGrep(f, 'BGP|ADJCHANGE|NOTIFICATION') : { command: `show ip bgp neighbors ${n.ip}` }
      return {
        rootCause: `Neighbor ${n.ip} is configured with remote AS ${n.remoteAs}, but the peer runs AS ${n.peerAs}: the OPEN is rejected (bad peer AS), so the session never establishes.`,
        rubric: [[word(n.ip)], [/\bAS\b|remote-as|peer-as|autonomous/i], [new RegExp(`${n.peerAs}|wrong|mismatch|incorrect|misconfigur|typo|bad peer`, 'i')]],
        probes: [{ command: BGP_SUM[f] }, detail],
        evidence: [
          { probe: 0, re: new RegExp(`${esc(n.ip)}.*${DOWN.source}`), what: 'the session is not established' },
          { probe: 1, re: /wrong AS|bad peer AS|Peer reported AS|does not match configured peer-as/i, what: 'the AS mismatch' }
        ]
      }
    }
  },
  {
    scenario: 'bgp-auth-mismatch',
    families: ['ios', 'nxos', 'eos', 'junos'],
    question: 'BGP to one of our peers will not come up. What is wrong?',
    truth: (d, f) => {
      const n = d.bgp.find((b) => b.peerPassword !== undefined)!
      return {
        rootCause: `The MD5 password for neighbor ${n.ip} does not match the peer's: TCP segments on port 179 fail authentication (BADAUTH / wrong MD5 digest), so the session stays down.`,
        rubric: [[word(n.ip)], [/md5|password|authenticat|BADAUTH|digest/i]],
        probes: [{ command: BGP_SUM[f] }, logGrep(f, 'MD5|BADAUTH|auth')],
        evidence: [
          { probe: 0, re: new RegExp(`${esc(n.ip)}.*${DOWN.source}`), what: 'the session is not established' },
          { probe: 1, re: new RegExp(`MD5 digest.*${esc(n.ip)}|${esc(n.ip)}.*MD5 digest`, 'i'), what: 'MD5 authentication failures from the peer' }
        ]
      }
    }
  },
  {
    scenario: 'bgp-acl-blocked',
    families: ['ios', 'nxos', 'eos', 'junos'],
    question: 'A BGP neighbor is stuck in Active. Investigate.',
    truth: (d, f) => {
      const n = d.bgp.find((b) => b.filteredBy)!
      return {
        rootCause: `An inbound ${f === 'junos' ? 'firewall filter' : 'access list'} ${n.filteredBy} denies TCP 179 (BGP) from ${n.ip}; the deny entry keeps matching, so the TCP session to the peer never forms.`,
        rubric: [[/acl|access[- ]list|access-group|filter|firewall/i], [/\b179\b|\bbgp\b/i], [new RegExp(`${esc(n.filteredBy!)}|deny|discard|drop|block`, 'i')]],
        probes: [{ command: BGP_SUM[f] }, { command: ACL[f] }],
        evidence: [
          { probe: 0, re: new RegExp(`${esc(n.ip)}.*${DOWN.source}`), what: 'the session is not established' },
          { probe: 1, re: f === 'junos' ? /deny-bgp\s+\d+\s+[1-9]/ : new RegExp(`deny\\s+tcp.*${esc(n.ip)}.*(?:bgp|179)`, 'i'), what: 'the deny entry for TCP 179 with matches' }
        ]
      }
    }
  },
  {
    scenario: 'ospf-mtu-mismatch',
    families: ['ios', 'nxos', 'junos'],
    question: 'OSPF routes from one neighbor are missing. Why?',
    truth: (d, f) => {
      const n = d.ospf!.neighbors.find((x) => x.peerMtu !== undefined)!
      const mine = d.interfaces.find((i) => i.name === n.iface)?.mtu ?? 1500
      return {
        rootCause: `The OSPF adjacency with ${n.routerId} (${n.ip}) on ${n.iface} is stuck in EXSTART: the neighbor's interface MTU (${n.peerMtu}) differs from ours (${mine}), so the database exchange never completes.`,
        rubric: [[/\bMTU\b/i], [/exstart|exchange|database|DBD/i]],
        probes: [{ command: OSPF_NBR[f] }, { command: IFACE(f, n.iface) }],
        evidence: [{ probe: 0, re: /EXSTART|ExStart/, what: 'the adjacency is stuck in EXSTART' }]
      }
    }
  },
  {
    scenario: 'ospf-hello-mismatch',
    families: ['ios', 'nxos', 'junos'],
    question: 'An OSPF neighbor disappeared. Find the cause.',
    truth: (d, f) => {
      const n = d.ospf!.neighbors.find((x) => x.peerHello !== undefined)!
      return {
        rootCause: `The neighbor ${n.ip} on ${n.iface} sends hellos every ${n.peerHello} s while this side uses 10 s (dead 40): hello/dead intervals must match, so the hellos are dropped and no adjacency forms.`,
        rubric: [[/hello|dead[- ]interval|timer/i], [/mismatch|differ|do(es)? not match|inconsistent|\b5\b/i]],
        probes: [{ command: OSPF_NBR[f] }, { command: OSPF_IF[f] }, logGrep(f, 'OSPF|hello')],
        evidence: [
          { probe: 1, re: /Hello:? 10/, what: 'this side uses hello 10' },
          { probe: 2, re: new RegExp(`hello.*${esc(n.ip)}|${esc(n.ip)}.*hello`, 'i'), what: 'hellos from the neighbor rejected for a parameter mismatch' }
        ]
      }
    }
  },
  {
    scenario: 'ospf-area-mismatch',
    families: ['ios', 'nxos', 'junos'],
    question: 'OSPF will not form an adjacency with one neighbor. Why?',
    truth: (d, f) => {
      const n = d.ospf!.neighbors.find((x) => x.peerArea !== undefined)!
      return {
        rootCause: `The link to ${n.ip} on ${n.iface} is in area ${n.area} here but in area ${n.peerArea} on the neighbor: OSPF drops hellos with a mismatched area ID, so no adjacency forms.`,
        rubric: [[/\barea\b/i], [/mismatch|differ|do(es)? not match|wrong|0\.0\.0\.1/i]],
        probes: [{ command: OSPF_NBR[f] }, logGrep(f, 'OSPF|area')],
        evidence: [{ probe: 1, re: new RegExp(`area.*${esc(n.ip)}|${esc(n.ip)}.*area|mismatched area`, 'i'), what: 'packets from the neighbor rejected for a mismatched area' }]
      }
    }
  },
  {
    scenario: 'err-disabled',
    families: ['ios', 'nxos', 'eos'],
    question: 'A user on this switch lost connectivity. Check the access ports.',
    truth: (d, f) => {
      const i = d.interfaces.find((x) => x.errDisabled === 'bpduguard')!
      return {
        rootCause: `${i.name} is err-disabled by BPDU guard: a switch (or something sending BPDUs) was connected to that edge port.`,
        rubric: [[ifRe(d, i.name)], [/bpdu/i], [/err-?disabl/i]],
        probes: [{ command: ERRDIS[f] }, logGrep(f, 'BPDU|err|SPANTREE')],
        evidence: [{ probe: 1, re: /BPDU/i, what: 'BPDU guard disabled the port' }]
      }
    }
  },
  {
    scenario: 'port-security-violation',
    families: ['ios', 'nxos', 'eos'],
    question: 'A desk port stopped working. What happened?',
    truth: (d, f) => {
      const i = d.interfaces.find((x) => x.portSecurity)!
      return {
        rootCause: `${i.name} is err-disabled by port security: a new MAC address (${i.portSecurity!.lastMac}) exceeded the maximum of ${i.portSecurity!.max}, and the violation mode is shutdown.`,
        rubric: [[ifRe(d, i.name)], [/port[- ]security|psecure|secure/i], [/violation|mac|err-?disabl/i]],
        probes: [{ command: ERRDIS[f] }, { command: 'show port-security' }, logGrep(f, 'SECUR|psecure|err')],
        evidence: [
          { probe: 1, re: /Shutdown/, what: 'port security in shutdown mode with violations' },
          { probe: 2, re: /3c52\.82aa\.1f07|psecure-violation/i, what: 'the violation and the MAC' }
        ]
      }
    }
  },
  {
    scenario: 'vlan-missing-trunk',
    families: ['ios', 'nxos', 'eos'],
    question: 'Hosts in one VLAN cannot reach their gateway across the trunk. Check the trunks.',
    truth: (d, f) => {
      const t = d.interfaces.find((x) => x.trunkAllowed)!
      const all = d.vlans.map((v) => v.id)
      const missing = all.find((v) => !t.trunkAllowed!.includes(v))!
      return {
        rootCause: `VLAN ${missing} is not in the allowed list of trunk ${t.name}, so its traffic does not cross the trunk.`,
        rubric: [[new RegExp(`(?:vlan|vl)\\s*${missing}\\b`, 'i')], [/trunk|allowed/i]],
        probes: [{ command: TRUNK[f] }],
        evidence: [{ probe: 0, re: new RegExp(`${esc(t.short)}\\s+[\\d,-]+`), what: 'the allowed VLAN list without the VLAN' }]
      }
    }
  },
  {
    scenario: 'acl-drop',
    families: ['ios', 'nxos', 'eos', 'junos'],
    question: 'Users in 10.10.20.0/24 say the app server 10.50.1.10 is unreachable through this device. Investigate.',
    truth: (d, f) => {
      const a = d.acls.find((x) => x.entries.some((e) => /10\.50\.1\.10/.test(e.text)))!
      return {
        rootCause: `${f === 'junos' ? 'Firewall filter' : 'Access list'} ${a.name} has a deny entry for traffic from 10.10.20.0/24 to 10.50.1.10 that keeps matching: the ACL is dropping the users' traffic.`,
        rubric: [[/acl|access[- ]list|filter|firewall/i], [/deny|discard|drop|block/i], [/10\.50\.1\.10|10\.10\.20/]],
        probes: [{ command: ACL[f] }, ...(f === 'junos' ? [] : [logGrep(f, 'ACCESS|ACLLOG|denied')])],
        evidence: [{ probe: 0, re: f === 'junos' ? /deny-app\s+\d+\s+[1-9]/ : /deny.*10\.50\.1\.10/i, what: 'the deny entry with matches' }]
      }
    }
  },
  {
    scenario: 'duplex-mismatch',
    families: ['ios', 'nxos', 'eos'],
    question: 'Transfers through one port are very slow. Find out why.',
    truth: (d, f) => {
      const i = d.interfaces.find((x) => x.peer?.duplex === 'full' && x.duplex === undefined)!
      return {
        rootCause: `${i.name} negotiated half duplex because the far end is hard-set to full: a duplex mismatch, with late collisions and CRC errors climbing.`,
        rubric: [[ifRe(d, i.name)], [/duplex/i]],
        probes: [{ command: STATUS[f] }, { command: ERRORS[f] }],
        evidence: [
          { probe: 0, re: new RegExp(`${esc(i.short)}\\b.*half`), what: 'the port runs half duplex' },
          { probe: 1, re: new RegExp(`^\\s*${esc(i.short)}\\s+(?:\\d+\\s+)*[1-9]`), what: 'errors on the port' }
        ]
      }
    }
  },
  {
    scenario: 'stp-root-moved',
    families: ['ios', 'nxos', 'eos'],
    question: 'Users in one VLAN see slow, odd paths since this morning. Check spanning tree.',
    truth: (d, f) => {
      const s = d.stp!
      const v = s.vlans[0]!
      return {
        rootCause: `The spanning-tree root for VLAN ${v} moved to an unknown bridge ${s.rootMac} (priority ${s.rootPriority}) reached through access port ${s.rootPort}: a rogue switch became root. Use BPDU guard / root guard on edge ports and a lower priority on the intended root.`,
        rubric: [[/root/i], [new RegExp(`${esc(s.rootMac)}|rogue|unknown|unauthori|4096|${s.rootPriority + v}`, 'i')], [ifRe(d, s.rootPort)]],
        probes: [{ command: 'show spanning-tree root' }, { command: `show spanning-tree vlan ${v}` }, logGrep(f, 'ROOT|SPANTREE|STP')],
        evidence: [
          { probe: 0, re: new RegExp(`${esc(s.rootMac)}`), what: 'the new root bridge' },
          { probe: 2, re: /root.*chang|ROOTCHANGE|Root bridge/i, what: 'the root change in the log' }
        ]
      }
    }
  },
  {
    scenario: 'fhrp-flap',
    families: ['ios', 'nxos', 'eos', 'junos'],
    question: 'The default gateway for a VLAN keeps flapping between the two routers. Why?',
    truth: (d, f) => {
      const g = d.fhrp![0]!
      const proto = g.proto === 'hsrp' ? 'HSRP' : 'VRRP'
      const brief: Record<Family, string> = { ios: 'show standby', nxos: 'show hsrp', eos: 'show vrrp', junos: 'show vrrp detail' }
      return {
        rootCause: `${proto} group ${g.group} on ${g.iface} tracks ${g.track!.iface}, which keeps going down and up: each drop lowers the priority by ${g.track!.decrement} (110 to 90, below the peer's 100), preemption swaps the active router, and it swaps back when the link returns. Fix the flapping link.`,
        rubric: [[/hsrp|vrrp|standby|first[- ]hop/i], [/track/i], [ifRe(d, g.track!.iface)], [/flap|bounc|down.*up|up.*down|unstable/i]],
        probes: [{ command: brief[f] }, logGrep(f, `${g.proto}|TRACK|${g.track!.iface.replace(/\//g, '.')}|UPDOWN|LINK`)],
        evidence: [
          { probe: 0, re: /Track|Tracked|tracking/i, what: 'the group tracks the uplink' },
          { probe: 1, re: new RegExp(`${esc(g.track!.iface)}.*down|${esc(d.interfaces.find((i) => i.name === g.track!.iface)!.short)}.*Down|LINK_DOWN.*${esc(g.track!.iface)}`, 'i'), what: 'the tracked uplink goes down' }
        ]
      }
    }
  },
  {
    scenario: 'crc-errors',
    families: ['ios', 'nxos', 'eos', 'junos'],
    question: 'Users report retransmissions and slowness across one link. Check the interfaces for errors.',
    truth: (d, f) => {
      const i = d.interfaces.find((x) => x.crcRate)!
      return {
        rootCause: `${i.name} shows CRC/input errors that keep increasing while duplex and speed match (full): a physical-layer fault such as a bad cable, optic or dirty fibre, not a configuration problem.`,
        rubric: [[ifRe(d, i.name)], [/crc|fcs|input error|framing/i], [/cable|optic|sfp|transceiver|fib(re|er)|physical|layer 1|L1/i]],
        probes: [...(f === 'junos' ? [] : [{ command: ERRORS[f] }]), { command: IFACE(f, i.name) }],
        evidence: [{ probe: f === 'junos' ? 0 : 1, re: /[1-9]\d* CRC|Framing errors: [1-9]/, what: 'CRC errors on the link' }]
      }
    }
  }
]

/** Scenarios defined only for the eval (not in the simulator registry): applied here. */
function applyFault(d: Device, scenario: string): void {
  if (scenario !== 'acl-drop') return void applyScenario(d, scenario)
  // ACL drop is configuration plus traffic counters, nothing else to derive: write it directly.
  const f = d.platform as Family
  const name = f === 'junos' ? 'SERVERS-IN' : 'USERS-IN'
  const text = f === 'junos' ? 'term deny-app from source-address 10.10.20.0/24 destination-address 10.50.1.10/32 then discard' : f === 'nxos' || f === 'eos' ? 'ip 10.10.20.0/24 10.50.1.10/32 log' : 'ip 10.10.20.0 0.0.0.255 host 10.50.1.10 log'
  d.acls.push({ name, type: 'extended', entries: [{ seq: 10, action: 'permit', text: f === 'junos' ? 'term allow-dns from protocol udp port domain then accept' : f === 'ios' ? 'udp any any eq domain' : 'udp any any eq domain', hits: 20_331 }, { seq: 20, action: 'deny', text, hits: 3_871 }, { seq: 30, action: 'permit', text: f === 'junos' ? 'term accept-rest then accept' : 'ip any any', hits: 1_204_877 }] })
  if (f !== 'junos') d.log.push({ t: Date.now() - 30_000, msg: f === 'ios' ? `%SEC-6-IPACCESSLOGP: list ${name} denied tcp 10.10.20.15(51514) -> 10.50.1.10(443), 12 packets` : f === 'nxos' ? `%ACLLOG-6-ACLLOG_FLOW_INTERVAL: Src IP: 10.10.20.15, Dst IP: 10.50.1.10, Src Port: 51514, Dst Port: 443, ACL Name: ${name}, ACE Action: Deny, Hit-count = 12` : `%ACL-6-IPACCESS: list ${name} Vlan20 denied tcp 10.10.20.15(51514) -> 10.50.1.10(443)` })
  d.scenarios.push('acl-drop')
  delete d.vendor['junos']
}

export function singleCases(): SingleCase[] {
  const out: SingleCase[] = []
  for (const f of FAULTS)
    for (const fam of f.families) {
      const name = { ios: 'core-sw1', nxos: 'leaf1', eos: 'dist-eos1', junos: 'edge-r1' }[fam]
      out.push({
        id: `${f.scenario}/${fam}`,
        scenario: f.scenario,
        family: fam,
        name,
        question: f.question,
        device: () => {
          const d = makeDevice(SIM[fam])
          applyFault(d, f.scenario)
          return d
        },
        truth: (d) => f.truth(d, fam)
      })
    }
  return out
}

// ------------------------------------------------------------------ fleet cases (topology lab)

export interface FleetCase {
  id: string
  scenario: string
  question: string
  /** Lab devices in scope (session names). */
  devices: string[]
  /** Where the fault is, and the far end (with the neighbor / interface on each). */
  at: { device: string; neighbor?: string; iface?: string }
  peer?: { device: string; neighbor?: string; iface?: string }
  truth: (lab: Map<string, Device>) => Truth & { perDevice: Record<string, Probe[]>; evidenceDevice: Record<number, string> }
}

/**
 * Link-level faults across two lab devices (FLEET-AGENT: verify both ends). Probes and evidence are
 * per device; `evidenceDevice` names the device for each evidence index.
 */
export function fleetCases(): FleetCase[] {
  const two = (pa: Probe[], pb: Probe[], ev: { dev: 0 | 1; probe: number; re: RegExp; what: string }[], names: [string, string]) => ({
    perDevice: { [names[0]]: pa, [names[1]]: pb },
    evidence: ev.map((e) => ({ probe: e.probe, re: e.re, what: e.what })),
    evidenceDevice: Object.fromEntries(ev.map((e, k) => [k, names[e.dev]])),
    probes: [...pa, ...pb]
  })
  return [
    {
      id: 'fleet/bgp-wrong-as',
      scenario: 'bgp-wrong-as',
      question: 'BGP between core-sw1 and edge-r1 is down. Find the root cause.',
      devices: ['core-sw1', 'edge-r1', 'dist-eos1'],
      at: { device: 'core-sw1', neighbor: '10.0.0.6' },
      peer: { device: 'edge-r1', neighbor: '10.0.0.5' },
      truth: (lab) => {
        const n = lab.get('core-sw1')!.bgp.find((b) => b.ip === '10.0.0.6')!
        return {
          rootCause: `core-sw1 has neighbor 10.0.0.6 (edge-r1) configured with remote-as ${n.remoteAs}, but edge-r1 runs AS ${n.peerAs}: core-sw1 rejects the OPEN (bad peer AS).`,
          rubric: [[/core-sw1/i], [/\bAS\b|remote-as|peer-as/i], [new RegExp(`${n.peerAs}|${n.remoteAs}|wrong|mismatch|bad peer`, 'i')]],
          ...two([{ command: 'show ip bgp summary' }, logGrep('ios', 'BGP|NOTIFICATION')], [{ command: 'show bgp summary' }], [
            { dev: 0, probe: 1, re: /wrong AS/, what: 'core-sw1 sends a bad-peer-AS notification' },
            { dev: 1, probe: 0, re: /10\.0\.0\.5\s.*Active/, what: 'edge-r1 sees the session down' }
          ], ['core-sw1', 'edge-r1'])
        }
      }
    },
    {
      id: 'fleet/bgp-auth-mismatch',
      scenario: 'bgp-auth-mismatch',
      question: 'The eBGP session core-sw1 <-> edge-r1 will not establish. Why?',
      devices: ['core-sw1', 'edge-r1'],
      at: { device: 'edge-r1', neighbor: '10.0.0.5' },
      peer: { device: 'core-sw1', neighbor: '10.0.0.6' },
      truth: () => ({
        rootCause: 'The MD5 passwords for the session differ between core-sw1 and edge-r1: both log authentication failures on TCP 179.',
        rubric: [[/md5|password|authenticat|BADAUTH|digest/i]],
        ...two([{ command: 'show bgp summary' }, logGrep('junos', 'MD5|auth')], [logGrep('ios', 'MD5|BADAUTH')], [
          { dev: 0, probe: 1, re: /wrong MD5 digest/, what: 'edge-r1 rejects the digest' },
          { dev: 1, probe: 0, re: /BADAUTH/, what: 'core-sw1 rejects the digest' }
        ], ['edge-r1', 'core-sw1'])
      })
    },
    {
      id: 'fleet/ospf-mtu-mismatch',
      scenario: 'ospf-mtu-mismatch',
      question: 'OSPF between core-sw1 and edge-r1 is not FULL. Check both ends.',
      devices: ['core-sw1', 'edge-r1'],
      at: { device: 'core-sw1', neighbor: '10.0.0.6' },
      peer: { device: 'edge-r1', neighbor: '10.0.0.5' },
      truth: () => ({
        rootCause: 'The link MTU differs: edge-r1 ge-0/0/1 is 9100, core-sw1 Gi1/0/1 is 1500, so the adjacency is stuck in EXSTART on both ends.',
        rubric: [[/\bMTU\b/i], [/exstart|exchange|database/i]],
        ...two([{ command: 'show ip ospf neighbor' }], [{ command: 'show ospf neighbor' }, { command: 'show interfaces ge-0/0/1 extensive' }], [
          { dev: 0, probe: 0, re: /EXSTART/, what: 'core-sw1 stuck in EXSTART' },
          { dev: 1, probe: 1, re: /MTU: 9\d{3}/, what: 'edge-r1 uses a jumbo MTU' }
        ], ['core-sw1', 'edge-r1'])
      })
    },
    {
      id: 'fleet/ospf-hello-mismatch',
      scenario: 'ospf-hello-mismatch',
      question: 'core-sw1 and edge-r1 lost their OSPF adjacency. What changed?',
      devices: ['core-sw1', 'edge-r1'],
      at: { device: 'core-sw1', neighbor: '10.0.0.6' },
      peer: { device: 'edge-r1', neighbor: '10.0.0.5' },
      truth: () => ({
        rootCause: 'edge-r1 ge-0/0/1 uses a 5 s hello interval while core-sw1 Gi1/0/1 uses 10 s: the hello/dead timers do not match, so neither side accepts the other\'s hellos.',
        rubric: [[/hello|dead|timer/i], [/mismatch|differ|do(es)? not match|\b5\b/i]],
        ...two([{ command: 'show ip ospf interface GigabitEthernet1/0/1' }, logGrep('ios', 'OSPF')], [{ command: 'show ospf interface detail' }], [
          { dev: 0, probe: 1, re: /mismatched hello parameters/, what: 'core-sw1 rejects the hellos' },
          { dev: 1, probe: 0, re: /Hello: 5/, what: 'edge-r1 sends hello 5' }
        ], ['core-sw1', 'edge-r1'])
      })
    },
    {
      id: 'fleet/vlan-missing-trunk',
      scenario: 'vlan-missing-trunk',
      question: 'Hosts in VLAN 10 behind dist-eos1 cannot reach their gateway on core-sw1. Check the trunk between them.',
      devices: ['core-sw1', 'dist-eos1'],
      at: { device: 'dist-eos1', iface: 'Ethernet48' },
      truth: () => ({
        rootCause: 'VLAN 10 is missing from the allowed list of the dist-eos1 Ethernet48 trunk towards core-sw1, so VLAN 10 does not cross it.',
        rubric: [[/(?:vlan|vl)\s*10\b/i], [/dist-eos1|Et(hernet)?48/i], [/trunk|allowed/i]],
        ...two([{ command: 'show interfaces trunk' }], [{ command: 'show interfaces trunk' }], [{ dev: 0, probe: 0, re: /Et48\s+1,100\b/, what: 'dist-eos1 allows only VLANs 1 and 100' }], ['dist-eos1', 'core-sw1'])
      })
    },
    {
      id: 'fleet/bgp-acl-blocked',
      scenario: 'bgp-acl-blocked',
      question: 'BGP between core-sw2 and leaf1 is stuck. Investigate both ends.',
      devices: ['core-sw2', 'leaf1'],
      at: { device: 'leaf1' },
      peer: { device: 'core-sw2' },
      truth: (lab) => {
        const n = lab.get('leaf1')!.bgp.find((b) => b.filteredBy)!
        return {
          rootCause: `leaf1 has an inbound ACL ${n.filteredBy} that denies TCP 179 from core-sw2 (${n.ip}); its deny entry keeps matching.`,
          rubric: [[/acl|access[- ]list|filter/i], [/leaf1/i], [/\b179\b|\bbgp\b/i]],
          ...two([{ command: 'show ip bgp summary' }, { command: 'show ip access-lists' }], [{ command: 'show ip bgp summary' }], [{ dev: 0, probe: 1, re: /deny\s+tcp.*eq bgp/, what: 'leaf1 denies tcp/179' }], ['leaf1', 'core-sw2'])
        }
      }
    }
  ]
}

/** Build the lab devices for a fleet case, with the fault applied at both ends. */
export function fleetLab(c: FleetCase): Map<string, Device> {
  const lab = buildLab()
  const m = new Map<string, Device>()
  for (const n of c.devices) m.set(n, lab.device(n))
  const at = m.get(c.at.device)!
  const neighbor = c.at.neighbor ?? (c.peer ? at.bgp.find((b) => b.description?.includes(c.peer!.device) || lab.device(c.peer!.device).interfaces.some((i) => i.ip === b.ip))?.ip : undefined)
  applyScenario(at, c.scenario, { neighbor, iface: c.at.iface })
  if (c.peer) {
    const p = m.get(c.peer.device)!
    const back = c.peer.neighbor ?? p.bgp.find((b) => at.interfaces.some((i) => i.ip === b.ip))?.ip
    applyPeerScenario(p, c.scenario, { neighbor: back, iface: c.peer.iface })
  }
  return m
}

/** Session platform for a lab device. */
export function labPlatform(d: Device): SessionPlatform {
  return d.platform === 'ios' ? 'iosxe' : (d.platform as SessionPlatform)
}
