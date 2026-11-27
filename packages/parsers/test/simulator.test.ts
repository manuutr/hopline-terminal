/**
 * Bundled templates against the simulator: for every simulated platform, each bundled template's
 * command is run in an in-process simulator shell (no network), and when the simulator models the
 * command (no device error), its output must parse into rows. The table at the end documents the
 * coverage; EXPECTED pins it so a regression (in the engine, a template or the simulator) fails.
 */
import { PROFILES, type PlatformId } from '@hopline/cli-model'
import { describe, expect, it } from 'vitest'
import { ManualClock, makeDevice, platforms, setClock, Shell, type SimPlatform } from '../../simulator/src/index.ts'
import { listTemplates, parseOutput, PLATFORM_MAP } from '../src'

const T0 = Date.UTC(2026, 10, 24, 11, 2, 11)

/** Run one command in a fresh shell and return the output between the echoed command and the next prompt. */
async function run(p: SimPlatform, command: string): Promise<string> {
  const d = makeDevice(p, T0)
  setClock(d, new ManualClock(T0))
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, 100_000, { user: 'admin', from: '10.0.0.50' })
  sh.start()
  await sh.idle()
  await new Promise((r) => setTimeout(r, 1))
  out = ''
  sh.input(command + '\r')
  await sh.idle()
  await new Promise((r) => setTimeout(r, 2))
  const lines = out.replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
  // Drop the echoed command line and the trailing prompt line.
  return lines.slice(1, -1).join('\n') + '\n'
}

/** The command a template parses, from its file name (`cisco_ios_show_ip_route.textfsm` → `show ip route`). */
const commandOf = (template: string, ntc: string) => template.replace(/\.textfsm$/, '').slice(ntc.length + 1).split('_').join(' ')

function isError(p: SimPlatform, out: string): boolean {
  const prof = (PROFILES as Record<string, (typeof PROFILES)[PlatformId] | undefined>)[p]
  const generic = /^\s*(% |\^|error:|Error:|syntax error|Unrecognized command|Incorrect usage|Invalid input|unknown command|bad command|expected end of command)/im
  if (generic.test(out)) return true
  if (!prof) return false
  const e = prof.errors
  return [e.invalid, e.ambiguous, e.incomplete, ...e.other].some((re) => re.test(out))
}

const EMPTY = 'nothing configured in the simulated device: the table has headers only'
/**
 * Commands the simulator models whose output does not parse, and why. Everything else the
 * simulator models must parse into rows. Keep in sync with packages/parsers/README.md (Gaps).
 */
const KNOWN_GAPS: Record<string, Record<string, string>> = {
  ios: { 'show interfaces status err-disabled': EMPTY, 'show etherchannel summary': EMPTY },
  c9800: {
    'show interfaces status err-disabled': EMPTY,
    'show etherchannel summary': EMPTY,
    'show ip ospf interface brief': EMPTY,
    'show ip ospf neighbor': EMPTY,
    'show ip bgp summary': 'simulator: no BGP on the WLC, prints a bare header the template rejects',
    'show cdp neighbors': 'simulator: capability column printed as "B,R" (devices print "R B")'
  },
  eos: {
    'show ip ospf interface brief': EMPTY,
    'show ip ospf neighbor': EMPTY,
    'show processes top once': 'simulator: top header differs from EOS (1 user, "free." swap line, VIRT with units)',
    'show ip access-lists': 'simulator: entry counters "[match N packets, …]" differ from the EOS format the template expects'
  },
  nxos: { 'show processes cpu': 'simulator: column layout differs from NX-OS (no "CPU util" summary line in the template format)' },
  junos: {
    'show chassis hardware': 'simulator: column layout from memory (unverified)',
    'show system uptime': 'simulator: line order and "Time Source" line from memory',
    'show bgp summary': 'simulator: Junos 21+ "Threading mode" header; the template expects the older layout',
    'show interfaces': 'simulator: interface blocks miss lines the template requires'
  },
  fortios: {
    'get router info bgp neighbors': 'simulator: neighbor block from memory (unverified)',
    'get router info ospf status': 'simulator: truncated OSPF status',
    'get system ha status': 'simulator: standalone HA status block differs from the template format'
  },
  iosxr: { 'show bgp neighbors': 'simulator: neighbor block from memory (unverified)' },
  asa: { 'show failover': 'simulator: "Failover Off" block differs from the template format', 'show name': 'simulator: prints nameif table instead of "name" entries' },
  aireos: {
    'show interface detailed id': 'needs an interface name argument',
    'show port summary': 'simulator: column layout differs (SFPType column)',
    'show time': 'simulator: misses the NTP lines the template requires'
  },
  aoscx: { 'show interface': 'simulator: interface blocks from memory (unverified)' },
  vrp: {
    'display mac-address': 'simulator: VRP 8 (CE) layout; the template expects the VRP 5 (S-series) layout',
    'display interface': 'simulator: CE-series counters layout',
    'display arp all': 'simulator: VRP 8 layout'
  },
  routeros: {
    'routing ospf neighbor print': 'RouterOS 7 output; ntc templates are RouterOS 6',
    'ip neighbor print detail': 'RouterOS 7 output (Columns: header); ntc templates are RouterOS 6',
    'interface print detail': 'RouterOS 7 output; ntc templates are RouterOS 6',
    'interface print brief': 'RouterOS 7 output; ntc templates are RouterOS 6',
    'ip route print detail': 'RouterOS 7 output; ntc templates are RouterOS 6',
    'system resource print': 'RouterOS 7 output; ntc templates are RouterOS 6',
    'system clock print': 'RouterOS 7 output; ntc templates are RouterOS 6',
    'ip arp print': 'RouterOS 7 output; ntc templates are RouterOS 6'
  }
}

/** Minimum commands per platform that must parse from simulator output (pinned coverage). */
const MIN_PARSED: Record<string, number> = { ios: 33, c9800: 25, eos: 18, nxos: 28, junos: 5, panos: 13, fortios: 6, iosxr: 10, asa: 7, aireos: 5, aoscx: 3, vrp: 2, routeros: 3 }

describe('bundled templates against simulator output', () => {
  for (const p of platforms()) {
    it(`${p}`, async () => {
      expect(PLATFORM_MAP[p], `PLATFORM_MAP has ${p}`).toBeDefined()
      const parsed: string[] = []
      const failed: string[] = []
      const seen = new Set<string>()
      for (const t of listTemplates(p)) {
        if (seen.has(t.template)) continue
        seen.add(t.template)
        const cmd = commandOf(t.template, t.ntcPlatform)
        const out = await run(p, cmd)
        if (!out.trim() || isError(p, out)) continue
        const r = parseOutput(p, cmd, out)
        if (r && r.rows.length) {
          parsed.push(cmd)
          expect(r.rows.every((row) => row.length === r.headers.length)).toBe(true)
        } else {
          failed.push(cmd)
          if (process.env['SIMDUMP']) console.log(`----- ${p}: ${cmd}\n${out}`)
        }
      }
      const unexpected = failed.filter((c) => !KNOWN_GAPS[p]?.[c])
      expect(unexpected, `${p}: simulator output that should parse but does not`).toEqual([])
      expect(parsed.length, `${p}: parsed commands: ${parsed.join('; ')}`).toBeGreaterThanOrEqual(MIN_PARSED[p] ?? 1)
    })
  }
})
