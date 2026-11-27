/**
 * RouterOS 7 `print` tables and `/export`. Layouts from memory of RouterOS 7.x
 * [unverified, from memory]: a `Flags:` legend listing only the flags present, a `Columns:` line,
 * `#` numbers, flag letters, `;;; comment` lines and space-padded columns.
 */
import { now } from '../../core/runtime.ts'
import { cmpIp, lpad, network, pad } from '../../core/text.ts'
import { bgpUp, ifaceCounters, isUp, neighborState, ospfState, type Device, type Iface } from '../../state.ts'
import type { RosVendor } from '../../devices/routeros.ts'

export function ros(d: Device): RosVendor {
  const v = d.vendor as { routeros?: RosVendor }
  return (v.routeros ??= { vlanIfs: {}, bridgePorts: {}, bgpNames: {} })
}

/** 4w2d3h12m5s */
export function rosDur(ms: number): string {
  let s = Math.max(0, Math.floor(ms / 1000))
  const parts: [number, string][] = []
  for (const [n, u] of [
    [604800, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
    [1, 's']
  ] as const) {
    parts.push([Math.floor(s / n), u])
    s %= n
  }
  const out = parts.filter(([n]) => n > 0).map(([n, u]) => `${n}${u}`).join('')
  return out || '0s'
}

export const rosMac = (m: string): string => {
  const hex = m.replace(/[^0-9a-f]/gi, '').toUpperCase().padStart(12, '0')
  return hex.match(/../g)!.join(':')
}

const two = (n: number): string => String(n).padStart(2, '0')
export function rosDate(t: number): string {
  const x = new Date(t)
  return `${x.getUTCFullYear()}-${two(x.getUTCMonth() + 1)}-${two(x.getUTCDate())} ${two(x.getUTCHours())}:${two(x.getUTCMinutes())}:${two(x.getUTCSeconds())}`
}

// ------------------------------------------------------------------ generic table

export interface Row {
  /** Item number; undefined = not numbered (dynamic routes). */
  num?: number
  flags: string
  comment?: string
  values: string[]
}

export interface Col {
  name: string
  right?: boolean
}

/** Flag legend groups, e.g. [[['X','DISABLED']], [['R','RUNNING']]]. Only flags used are listed. */
export function table(legend: [string, string][][], cols: Col[], rows: Row[]): string {
  const used = new Set(rows.flatMap((r) => [...r.flags]))
  const groups = legend.map((g) => g.filter(([l]) => used.has(l)).map(([l, n]) => `${l} - ${n}`).join(', ')).filter(Boolean)
  const out: string[] = []
  if (groups.length) out.push(`Flags: ${groups.join('; ')}`)
  out.push(`Columns: ${cols.map((c) => c.name).join(', ')}`)
  const nw = Math.max(1, ...rows.map((r) => (r.num === undefined ? 0 : String(r.num).length)))
  const fw = Math.max(0, ...rows.map((r) => r.flags.length))
  const widths = cols.map((c, k) => Math.max(c.name.length, ...rows.map((r) => (r.values[k] ?? '').length)))
  const lead = (num: string, flags: string): string => `${lpad(num, nw)} ${pad(flags, fw)}${fw ? ' ' : ''}`
  out.push((pad('#', nw) + ' ' + ' '.repeat(fw) + (fw ? ' ' : '') + cols.map((c, k) => (c.right ? lpad(c.name, widths[k]!) : pad(c.name, widths[k]!))).join('  ')).trimEnd())
  for (const r of rows) {
    const num = r.num === undefined ? '' : String(r.num)
    const vals = cols.map((c, k) => (c.right ? lpad(r.values[k] ?? '', widths[k]!) : pad(r.values[k] ?? '', widths[k]!))).join('  ')
    if (r.comment !== undefined) {
      out.push(`${lead(num, r.flags)};;; ${r.comment}`)
      out.push(`${' '.repeat(nw + 1 + fw + (fw ? 1 : 0))}${vals}`.trimEnd())
    } else out.push(`${lead(num, r.flags)}${vals}`.trimEnd())
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ interfaces

export function ifType(d: Device, i: Iface): string {
  if (ros(d).vlanIfs[i.name]) return 'vlan'
  if (/^(ether|sfp)/.test(i.name)) return 'ether'
  if (i.name === 'lo') return 'loopback'
  if (/^bridge/.test(i.name)) return 'bridge'
  return 'ether'
}

export function ifFlags(d: Device, i: Iface): string {
  let f = ''
  if (!i.adminUp) f += 'X'
  if (isUp(i)) f += 'R'
  if (ros(d).bridgePorts[i.name]) f += 'S'
  return f
}

const IF_LEGEND: [string, string][][] = [[['D', 'DYNAMIC']], [['X', 'DISABLED'], ['R', 'RUNNING'], ['S', 'SLAVE']]]

export function interfaces(d: Device, list: Iface[]): string {
  const rows: Row[] = list.map((i, k) => {
    const mtu = String(i.mtu ?? 1500)
    const phys = ifType(d, i) === 'ether'
    return {
      num: k,
      flags: ifFlags(d, i),
      ...(i.description !== undefined ? { comment: i.description } : {}),
      values: [i.name, ifType(d, i), i.name === 'lo' ? '65536' : mtu, phys ? '1514' : i.name === 'lo' ? '' : '1500', phys ? '9796' : '', i.name === 'lo' ? '00:00:00:00:00:00' : rosMac(i.mac)]
    }
  })
  return table(IF_LEGEND, [{ name: 'NAME' }, { name: 'TYPE' }, { name: 'ACTUAL-MTU', right: true }, { name: 'L2MTU', right: true }, { name: 'MAX-L2MTU', right: true }, { name: 'MAC-ADDRESS' }], rows)
}

export function ethernet(d: Device, list: Iface[]): string {
  const rows: Row[] = list.map((i, k) => ({
    num: k,
    flags: ifFlags(d, i),
    ...(i.description !== undefined ? { comment: i.description } : {}),
    values: [i.name, String(i.mtu ?? 1500), rosMac(i.mac), 'enabled', i.speed === '10G' ? '10G-baseSR-LR' : '1G-baseT-full']
  }))
  return table(IF_LEGEND, [{ name: 'NAME' }, { name: 'MTU', right: true }, { name: 'MAC-ADDRESS' }, { name: 'ARP' }, { name: 'SPEED' }], rows)
}

export function vlanIfs(d: Device, list: Iface[]): string {
  const v = ros(d).vlanIfs
  const rows: Row[] = list.map((i, k) => ({
    num: k,
    flags: ifFlags(d, i),
    ...(i.description !== undefined ? { comment: i.description } : {}),
    values: [i.name, String(i.mtu ?? 1500), 'enabled', String(v[i.name]?.vid ?? ''), v[i.name]?.parent ?? '']
  }))
  return table(IF_LEGEND, [{ name: 'NAME' }, { name: 'MTU', right: true }, { name: 'ARP' }, { name: 'VLAN-ID', right: true }, { name: 'INTERFACE' }], rows)
}

export function bridges(d: Device, list: Iface[]): string {
  const rows: Row[] = list.map((i, k) => ({ num: k, flags: ifFlags(d, i), values: [i.name, String(i.mtu ?? 1500), String(i.mtu ?? 1500), 'enabled', rosMac(i.mac), 'rstp-bridge'] }))
  return table(IF_LEGEND, [{ name: 'NAME' }, { name: 'MTU', right: true }, { name: 'ACTUAL-MTU', right: true }, { name: 'ARP' }, { name: 'MAC-ADDRESS' }, { name: 'PROTOCOL-MODE' }], rows)
}

export function bridgePorts(d: Device): string {
  const bp = Object.entries(ros(d).bridgePorts)
  const rows: Row[] = bp.map(([ifn, br], k) => {
    const i = d.interfaces.find((x) => x.name === ifn)
    const up = i ? isUp(i) : false
    return { num: k, flags: up ? '' : 'I', values: [ifn, br, '0x80', '10', 'none'] }
  })
  return table([[['X', 'DISABLED'], ['I', 'INACTIVE']]], [{ name: 'INTERFACE' }, { name: 'BRIDGE' }, { name: 'PRIORITY' }, { name: 'PATH-COST', right: true }, { name: 'HORIZON' }], rows)
}

// ------------------------------------------------------------------ ip

export function addrIfaces(d: Device): Iface[] {
  return d.interfaces.filter((i) => i.ip && i.mask !== undefined)
}

export function addresses(d: Device): string {
  const rows: Row[] = addrIfaces(d).map((i, k) => ({
    num: k,
    flags: (i.adminUp ? '' : 'X') + (i.adminUp && !isUp(i) && ifType(d, i) !== 'ether' ? 'I' : ''),
    values: [`${i.ip}/${i.mask}`, network(i.ip!, i.mask!), i.name]
  }))
  return table([[['X', 'DISABLED'], ['I', 'INVALID']], [['D', 'DYNAMIC']]], [{ name: 'ADDRESS' }, { name: 'NETWORK' }, { name: 'INTERFACE' }], rows)
}

export interface RosRoute {
  dst: string
  mask: number
  gw: string
  dist: number
  kind: 'c' | 's' | 'b' | 'o'
  active: boolean
  /** Index into d.staticRoutes for static routes. */
  staticIdx?: number
}

export function routes(d: Device): RosRoute[] {
  const r: RosRoute[] = []
  for (const i of d.interfaces) if (isUp(i) && i.ip && i.mask !== undefined) r.push({ dst: network(i.ip, i.mask), mask: i.mask, gw: i.name, dist: 0, kind: 'c', active: true })
  const reach = (nh: string): Iface | undefined => d.interfaces.find((i) => isUp(i) && i.ip && i.mask !== undefined && network(i.ip, i.mask) === network(nh, i.mask))
  d.staticRoutes.forEach((s, k) => r.push({ dst: s.prefix, mask: s.mask, gw: s.nextHop, dist: s.ad ?? 1, kind: 's', active: !!reach(s.nextHop), staticIdx: k }))
  for (const n of d.ospf?.neighbors ?? []) if (ospfState(d, n) === 'FULL') r.push({ dst: n.routerId, mask: 32, gw: n.ip, dist: 110, kind: 'o', active: true })
  const t = now(d)
  for (const n of d.bgp) {
    if (neighborState(d, n, t) !== 'Established') continue
    for (const p of n.routes ?? []) r.push({ dst: p.prefix, mask: p.mask, gw: n.ip, dist: n.remoteAs === d.localAs ? 200 : 20, kind: 'b', active: true })
  }
  // One active route per destination: lowest distance wins.
  const best = new Map<string, RosRoute>()
  for (const x of r) {
    if (!x.active) continue
    const k = `${x.dst}/${x.mask}`
    const b = best.get(k)
    if (!b || x.dist < b.dist) best.set(k, x)
  }
  for (const x of r) x.active = best.get(`${x.dst}/${x.mask}`) === x
  return r.sort((a, b) => cmpIp(a.dst, b.dst) || a.mask - b.mask || a.dist - b.dist)
}

export function routePrint(d: Device): string {
  const rows: Row[] = routes(d).map((x) => ({
    ...(x.staticIdx !== undefined ? { num: x.staticIdx } : {}),
    flags: (x.kind === 's' ? '' : 'D') + (x.active ? 'A' : '') + x.kind,
    values: [`${x.dst}/${x.mask}`, x.gw, String(x.dist)]
  }))
  return table(
    [[['X', 'DISABLED'], ['I', 'INACTIVE']], [['D', 'DYNAMIC']], [['A', 'ACTIVE']], [['c', 'CONNECT'], ['s', 'STATIC'], ['b', 'BGP'], ['o', 'OSPF']]],
    [{ name: 'DST-ADDRESS' }, { name: 'GATEWAY' }, { name: 'DISTANCE', right: true }],
    rows
  )
}

export function arp(d: Device): string {
  const rows: Row[] = d.arp
    .filter((a) => {
      const i = d.interfaces.find((x) => x.name === a.iface)
      return !i || isUp(i)
    })
    .map((a, k) => ({ num: k, flags: 'DC', values: [a.ip, rosMac(a.mac), a.iface, 'reachable'] }))
  return table([[['D', 'DYNAMIC'], ['C', 'COMPLETE']]], [{ name: 'ADDRESS' }, { name: 'MAC-ADDRESS' }, { name: 'INTERFACE' }, { name: 'STATUS' }], rows)
}

export function neighbors(d: Device): string {
  const rows: Row[] = d.lldp
    .filter((n) => {
      const i = d.interfaces.find((x) => x.name === n.local)
      return !i || isUp(i)
    })
    .map((n, k) => ({ num: k, flags: '', values: [n.local, n.ip ?? '', n.device, n.platform ?? '', n.port] }))
  return table([], [{ name: 'INTERFACE' }, { name: 'ADDRESS' }, { name: 'IDENTITY' }, { name: 'PLATFORM' }, { name: 'INTERFACE-NAME' }], rows)
}

// ------------------------------------------------------------------ routing

export function bgpName(d: Device, ip: string, k: number): string {
  return ros(d).bgpNames[ip] ?? `peer${k + 1}`
}

export function bgpConnections(d: Device): string {
  const out: string[] = []
  const flags = d.bgp.some((n) => n.shutdown) ? 'Flags: D - dynamic, X - disabled, I - inactive' : 'Flags: D - dynamic, X - disabled, I - inactive'
  out.push(flags)
  d.bgp.forEach((n, k) => {
    const iface = d.interfaces.find((i) => i.name === n.via)
    out.push(` ${k} ${n.shutdown ? 'X' : ' '} name="${bgpName(d, n.ip, k)}"`)
    out.push(`     remote.address=${n.ip} .as=${n.remoteAs}`)
    out.push(`     local.address=${iface?.ip ?? ''} .role=${n.remoteAs === d.localAs ? 'ibgp' : 'ebgp'} .as=${d.localAs}`)
    out.push(`     routing-table=main router-id=${d.routerId} templates=default as=${d.localAs}`)
    out.push('')
  })
  return out.join('\n').replace(/\n$/, '')
}

export function bgpSessions(d: Device): string {
  const t = now(d)
  const out = ['Flags: E - established']
  let k = 0
  d.bgp.forEach((n, j) => {
    if (n.shutdown) return
    const st = neighborState(d, n, t)
    const up = st === 'Established' && bgpUp(n, t)
    const iface = d.interfaces.find((i) => i.name === n.via)
    out.push(` ${k++} ${up ? 'E' : ' '} name="${bgpName(d, n.ip, j)}-1"`)
    out.push(`     remote.address=${n.ip} .as=${n.remoteAs}${up ? ` .id=${n.routerId ?? n.ip} .capabilities=mp,rr,gr,as4 .afi=ip .messages=${n.msgRcvd ?? 0} .bytes=${(n.msgRcvd ?? 0) * 23} .eor=""` : ''}`)
    out.push(`     local.role=${n.remoteAs === d.localAs ? 'ibgp' : 'ebgp'} .address=${iface?.ip ?? ''} .as=${d.localAs} .id=${d.routerId} .capabilities=mp,rr,gr,as4${up ? ` .messages=${n.msgSent ?? 0} .bytes=${(n.msgSent ?? 0) * 21} .eor=""` : ''}`)
    out.push(`     output.procid=${20 + j}`)
    out.push(`     input.procid=${20 + j} ${n.remoteAs === d.localAs ? 'ibgp' : 'ebgp'}`)
    if (up) out.push(`     hold-time=3m keepalive-time=1m uptime=${rosDur(t - n.upSince!)} last-started=${rosDate(n.upSince!)} prefix-count=${n.prefixes}`)
    else out.push(`     hold-time=3m keepalive-time=1m last-stopped=${rosDate(n.downSince ?? d.bootedAt)} state=${st === 'Idle' ? 'idle' : 'active'}`)
    out.push('')
  })
  return out.join('\n').replace(/\n$/, '')
}

const OSPF_ST: Record<string, string> = { FULL: 'Full', EXSTART: 'ExStart', '2WAY': '2-Way' }

export function ospfNeighbors(d: Device): string {
  const out = ['Flags: V - virtual; D - dynamic']
  let k = 0
  const t = now(d)
  for (const n of d.ospf?.neighbors ?? []) {
    const st = ospfState(d, n)
    if (!st) continue
    out.push(` ${k++}  D instance=${d.ospf!.process} area=${n.area === '0' ? 'backbone' : n.area} address=${n.ip} router-id=${n.routerId} state="${OSPF_ST[st]}" state-changes=${st === 'FULL' ? 6 : 1}${st === 'FULL' ? ` adjacency=${rosDur(t - (n.upSince ?? d.bootedAt))}` : ''} timeout=33s`)
  }
  return out.join('\n')
}

// ------------------------------------------------------------------ system

function activeHog(d: Device): Device['cpu']['hog'] {
  const h = d.cpu.hog
  return h && (!h.whileService || d.services[h.whileService]) ? h : undefined
}

export function cpuLoad(d: Device): number {
  return Math.min(100, d.cpu.load[0] + (activeHog(d)?.pct ?? 0))
}

export function resource(d: Device): string {
  const t = now(d)
  const kv: [string, string][] = [
    ['uptime', rosDur(t - d.bootedAt)],
    ['version', `${d.version} (stable)`],
    ['build-time', '2024-04-17 12:47:58'],
    ['factory-software', '7.0.4'],
    ['free-memory', '832.4MiB'],
    ['total-memory', '1024.0MiB'],
    ['cpu', 'ARM64'],
    ['cpu-count', '4'],
    ['cpu-frequency', '350MHz'],
    ['cpu-load', `${cpuLoad(d)}%`],
    ['free-hdd-space', '893.2MiB'],
    ['total-hdd-space', '1024.0MiB'],
    ['write-sect-since-reboot', '12345'],
    ['write-sect-total', '543210'],
    ['bad-blocks', '0%'],
    ['architecture-name', 'arm64'],
    ['board-name', d.model],
    ['platform', 'MikroTik']
  ]
  return kvList(kv)
}

export function kvList(kv: [string, string][]): string {
  const w = Math.max(...kv.map(([k]) => k.length))
  return kv.map(([k, v]) => `${lpad(k, w + 2)}: ${v}`).join('\n')
}

export function routerboard(d: Device): string {
  return kvList([
    ['routerboard', 'yes'],
    ['board-name', d.model],
    ['model', d.model],
    ['serial-number', d.serial],
    ['firmware-type', '70x0'],
    ['factory-firmware', '7.0.4'],
    ['current-firmware', d.version],
    ['upgrade-firmware', d.version]
  ])
}

export function resourceCpu(d: Device): string {
  const l = cpuLoad(d)
  const rows: Row[] = [0, 1, 2, 3].map((k) => ({ num: k, flags: '', values: [`cpu${k}`, `${k === 0 ? l : Math.max(0, Math.floor(l / 2) - k)}%`, '0%'] }))
  return table([], [{ name: 'CPU' }, { name: 'LOAD', right: true }, { name: 'IRQ', right: true }], rows)
}

export function profile(d: Device): string {
  const hog = activeHog(d)
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  procs = procs.sort((a, b) => b.pct - a.pct)
  const total = Math.min(100, procs.reduce((a, p) => a + p.pct, 0))
  const w = Math.max(15, ...procs.map((p) => p.name.length + 1))
  const out = [`Columns: NAME, CPU, USAGE`, `${pad('NAME', w)}CPU  USAGE`]
  for (const p of procs) out.push(`${pad(p.name, w)}     ${p.pct}%`)
  out.push(`${pad('total', w)}     ${total}%`)
  return out.join('\n')
}

export function clock(d: Device): string {
  const t = rosDate(now(d))
  return kvList([
    ['time', t.slice(11)],
    ['date', t.slice(0, 10)],
    ['time-zone-autodetect', 'yes'],
    ['time-zone-name', 'UTC'],
    ['gmt-offset', '+00:00'],
    ['dst-active', 'no']
  ])
}

export function logPrint(d: Device): string {
  return d.log.map((e) => `${rosDate(e.t)} system,info ${e.msg}`).join('\n')
}

export function ifaceStats(d: Device, i: Iface): string {
  const c = ifaceCounters(d, i)
  return kvList([
    ['name', i.name],
    ['rx-byte', String(c.inBytes)],
    ['tx-byte', String(c.outBytes)],
    ['rx-packet', String(c.inPkts)],
    ['tx-packet', String(c.outPkts)],
    ['rx-fcs-error', String(c.crc)],
    ['rx-too-short', String(c.runts)],
    ['tx-collision', String(c.collisions)],
    ['tx-late-collision', String(c.lateCollisions)],
    ['tx-deferred', String(c.deferred)]
  ])
}

// ------------------------------------------------------------------ export

const q = (s: string): string => (/^[\w.:/-]+$/.test(s) ? s : `"${s.replace(/(["\\$])/g, '\\$1')}"`)

/** `/export` sections: [path, lines]. */
export function exportSections(d: Device): [string, string[]][] {
  const v = ros(d)
  const s: [string, string[]][] = []
  const bridgesL = d.interfaces.filter((i) => ifType(d, i) === 'bridge')
  if (bridgesL.length) s.push(['/interface bridge', bridgesL.map((i) => `add name=${q(i.name)}${i.description !== undefined ? ` comment=${q(i.description)}` : ''}`)])
  const eth = d.interfaces.filter((i) => ifType(d, i) === 'ether' && (i.description !== undefined || !i.adminUp || i.mtu !== undefined))
  if (eth.length)
    s.push([
      '/interface ethernet',
      eth.map((i) => `set [ find default-name=${i.name} ]${i.description !== undefined ? ` comment=${q(i.description)}` : ''}${!i.adminUp ? ' disabled=yes' : ''}${i.mtu !== undefined ? ` mtu=${i.mtu}` : ''}`)
    ])
  const vl = d.interfaces.filter((i) => v.vlanIfs[i.name])
  if (vl.length) s.push(['/interface vlan', vl.map((i) => `add interface=${v.vlanIfs[i.name]!.parent} name=${q(i.name)} vlan-id=${v.vlanIfs[i.name]!.vid}${!i.adminUp ? ' disabled=yes' : ''}`)])
  const bp = Object.entries(v.bridgePorts)
  if (bp.length) s.push(['/interface bridge port', bp.map(([i, b]) => `add bridge=${b} interface=${i}`)])
  const ad = addrIfaces(d).filter((i) => i.name !== 'lo' || true)
  if (ad.length) s.push(['/ip address', ad.map((i) => `add address=${i.ip}/${i.mask} interface=${i.name} network=${network(i.ip!, i.mask!)}`)])
  if (d.staticRoutes.length) s.push(['/ip route', d.staticRoutes.map((r) => `add${r.prefix === '0.0.0.0' && r.mask === 0 ? '' : ` dst-address=${r.prefix}/${r.mask}`}${r.ad !== undefined && r.ad !== 1 ? ` distance=${r.ad}` : ''} gateway=${r.nextHop}`)])
  if (d.bgp.length)
    s.push([
      '/routing bgp connection',
      d.bgp.map((n, k) => `add as=${d.localAs}${n.shutdown ? ' disabled=yes' : ''} local.role=${n.remoteAs === d.localAs ? 'ibgp' : 'ebgp'} name=${q(bgpName(d, n.ip, k))} remote.address=${n.ip} .as=${n.remoteAs} router-id=${d.routerId}`)
    ])
  if (d.ospf) {
    s.push(['/routing ospf instance', [`add disabled=no name=${d.ospf.process} router-id=${d.ospf.routerId ?? d.routerId}`]])
    s.push(['/routing ospf area', [`add disabled=no instance=${d.ospf.process} name=backbone`]])
    s.push(['/routing ospf interface-template', d.ospf.ifaces.map((x) => `add area=backbone disabled=no interfaces=${x.iface}${x.networkType === 'point-to-point' ? ' type=ptp' : ''}`)])
  }
  s.push(['/system identity', [`set name=${q(d.hostname)}`]])
  if (d.motd !== undefined) s.push(['/system note', [`set note=${q(d.motd)} show-at-login=yes`]])
  for (const l of d.extraConfig) s.push(['', [l]])
  return s
}

export function exportText(d: Device, path: string, verbose = false): string {
  const t = now(d)
  const head = [`# ${rosDate(t)} by RouterOS ${d.version}`, '# software id = 7XKD-2WQH', '#', `# model = ${d.model}`, `# serial number = ${d.serial}`]
  const out = [...head]
  for (const [p, lines] of exportSections(d)) {
    if (path && !(p === path || p.startsWith(path + ' '))) continue
    if (p) out.push(p)
    out.push(...lines)
  }
  void verbose
  return out.join('\n')
}
