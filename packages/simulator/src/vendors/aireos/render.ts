/**
 * AireOS `show` renderers. Dotted-leader layout ("Label........ value") and table columns are from
 * memory of AireOS 8.x output [unverified, from memory]; values come from the model.
 */
import { now } from '../../core/runtime.ts'
import { macColon, pad } from '../../core/text.ts'
import { maskToDotted } from '../../core/tree.ts'
import { ifaceCounters, isUp, resolvedDuplex, type Device, type Iface } from '../../state.ts'
import type { AireosVendor, WlcClient } from '../../devices/aireos.ts'

export function wlc(d: Device): AireosVendor {
  const v = d.vendor as { aireos?: AireosVendor }
  return (v.aireos ??= { prompt: 'Cisco Controller', aps: [], wlans: [], clients: [] })
}

/** "Label" padded with dots to 49 columns, then the value. */
export const dots = (label: string, value: string | number, width = 49): string => `${label}${'.'.repeat(Math.max(1, width - label.length))} ${value}`.trimEnd()

function upWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 86400)} days ${Math.floor((s % 86400) / 3600)} hrs ${Math.floor((s % 3600) / 60)} mins ${s % 60} secs`
}

/** Clients actually associated: AP joined and enabled, WLAN enabled. */
export function liveClients(d: Device): WlcClient[] {
  const v = wlc(d)
  return v.clients.filter((c) => {
    const ap = v.aps.find((a) => a.name === c.ap)
    const wl = v.wlans.find((w) => w.id === c.wlan)
    return !!ap && ap.adminUp && ap.joined && !!wl && wl.enabled
  })
}

export function sysinfo(d: Device): string {
  const v = wlc(d)
  const mgmt = d.interfaces.find((i) => i.name === 'management')
  return [
    dots("Manufacturer's Name", 'Cisco Systems Inc.'),
    dots('Product Name', 'Cisco Controller'),
    dots('Product Version', d.version),
    dots('RTOS Version', d.version),
    dots('Bootloader Version', '8.5.103.0'),
    dots('Emergency Image Version', '8.5.103.0'),
    dots('OUI File Last Update Time', 'Sun Sep 07 10:44:07 UTC 2014'),
    dots('Build Type', 'DATA + WPS'),
    '',
    dots('System Name', d.hostname),
    dots('System Location', ''),
    dots('System Contact', ''),
    dots('System ObjectID', '1.3.6.1.4.1.9.1.2170'),
    dots('Redundancy Mode', 'Disabled'),
    dots('IP Address', mgmt?.ip ?? ''),
    dots('IPv6 Address', '::'),
    dots('System Up Time', upWords(now(d) - d.bootedAt)),
    dots('System Timezone Location', ''),
    dots('System Stats Realtime Interval', 5),
    dots('System Stats Normal Interval', 180),
    '',
    dots('Configured Country', 'US  - United States'),
    '',
    dots('State of 802.11b Network', 'Enabled'),
    dots('State of 802.11a Network', 'Enabled'),
    dots('Number of WLANs', v.wlans.length),
    dots('Number of Active Clients', liveClients(d).length),
    '',
    dots('OUI Classification Failure Count', 0),
    '',
    dots('Burned-in MAC Address', macColon(d.interfaces.find((i) => i.name === 'management')?.mac ?? '').toUpperCase()),
    dots('Maximum number of APs supported', 1500),
    dots('System Nas-Id', ''),
    dots('WLC MIC Certificate Types', 'SHA1/SHA2'),
    dots('Licensing Type', 'RTU'),
    dots('Product ID', d.model),
    dots('Serial Number', d.serial)
  ].join('\n')
}

export function inventory(d: Device): string {
  return [
    dots('Burned-in MAC Address', macColon(d.interfaces.find((i) => i.name === 'management')?.mac ?? '').toUpperCase()),
    dots('Maximum number of APs supported', 1500),
    'NAME: "Chassis"    , DESCR: "Cisco 5520 Series Wireless LAN Controller"',
    `PID: ${d.model}, VID: V01, SN: ${d.serial}`
  ].join('\n')
}

export function apSummary(d: Device): string {
  const v = wlc(d)
  const live = liveClients(d)
  const joined = v.aps.filter((a) => a.joined)
  const out = [
    dots('Number of APs', joined.length),
    '',
    dots('Global AP User Name', 'Not Configured'),
    dots('Global AP Dot1x User Name', 'Not Configured'),
    dots('Global AP Dot1x EAP Method', 'EAP-FAST'),
    '',
    'AP Name             Slots  AP Model              Ethernet MAC       Location          Country     IP Address       Clients   DSE Location',
    '------------------  -----  --------------------  -----------------  ----------------  ----------  ---------------  --------  --------------'
  ]
  for (const a of joined) {
    const n = live.filter((c) => c.ap === a.name).length
    out.push(`${pad(a.name, 20)}${pad(` ${a.slots}`, 7)}${pad(a.model, 22)}${pad(macColon(a.mac), 19)}${pad(a.location, 18)}${pad('US', 12)}${pad(a.ip, 17)}${pad(` ${n}`, 10)}[0 ,0 ,0 ]`)
  }
  return out.join('\n')
}

export function apStatus(d: Device): string {
  const v = wlc(d)
  const out = ['AP Name            Status     Mode        Country    Clients', '------------------ ---------- ----------- ---------- -------']
  const live = liveClients(d)
  for (const a of v.aps.filter((x) => x.joined)) out.push(`${pad(a.name, 19)}${pad(a.adminUp ? 'Enabled' : 'Disabled', 11)}${pad('Local', 12)}${pad('US', 11)}${live.filter((c) => c.ap === a.name).length}`)
  return out.join('\n')
}

export function apConfigGeneral(d: Device, name: string): string {
  const a = wlc(d).aps.find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!a) return `Cisco AP ${name} is not found.`
  return [
    dots('Cisco AP Identifier', wlc(d).aps.indexOf(a) + 1),
    dots('Cisco AP Name', a.name),
    dots('Country code', 'US  - United States'),
    dots('MAC Address', macColon(a.mac)),
    dots('IP Address Configuration', 'DHCP'),
    dots('IP Address', a.ip),
    dots('Cisco AP Location', a.location),
    dots('Cisco AP Group Name', 'default-group'),
    dots('Primary Cisco Switch Name', d.hostname),
    dots('Primary Cisco Switch IP Address', d.interfaces.find((i) => i.name === 'management')?.ip ?? ''),
    dots('Administrative State', a.adminUp ? 'ADMIN_ENABLED' : 'ADMIN_DISABLED'),
    dots('Operation State', a.joined ? 'REGISTERED' : 'DOWNLOADING'),
    dots('Mode', 'Local'),
    dots('AP Model', a.model),
    dots('AP Serial Number', a.serial),
    dots('Software Version', d.version)
  ].join('\n')
}

export function wlanSummary(d: Device): string {
  const v = wlc(d)
  const out = [
    dots('Number of WLANs', v.wlans.length),
    '',
    'WLAN ID  WLAN Profile Name / SSID               Status    Interface Name        PMIPv6 Mobility',
    '-------  -------------------------------------  --------  --------------------  ---------------'
  ]
  for (const w of [...v.wlans].sort((a, b) => a.id - b.id)) out.push(`${pad(w.id, 9)}${pad(`${w.profile} / ${w.ssid}`, 39)}${pad(w.enabled ? 'Enabled' : 'Disabled', 10)}${pad(w.iface, 22)}none`)
  return out.join('\n')
}

export function wlanDetail(d: Device, id: number): string {
  const w = wlc(d).wlans.find((x) => x.id === id)
  if (!w) return `WLAN ${id} does not exist.`
  return [
    dots('WLAN Identifier', w.id),
    dots('Profile Name', w.profile),
    dots('Network Name (SSID)', w.ssid),
    dots('Status', w.enabled ? 'Enabled' : 'Disabled'),
    dots('Number of Active Clients', liveClients(d).filter((c) => c.wlan === w.id).length),
    dots('Interface', w.iface),
    dots('Security', w.security)
  ].join('\n')
}

export function clientSummary(d: Device): string {
  const live = liveClients(d)
  const out = [
    dots('Number of Clients', live.length),
    '',
    dots('Number of PMIPV6 Clients', 0),
    '',
    '                                                                         GLAN/',
    '                                                                         RLAN/',
    'MAC Address       AP Name                        Slot Status        WLAN  Auth Protocol         Port Wired Tunnel  Role',
    '----------------- ------------------------------ ---- ------------- ----- ---- ---------------- ---- ----- ------- ----------------'
  ]
  for (const c of live) out.push(`${macColon(c.mac)} ${pad(c.ap, 31)}${pad(` ${c.slot}`, 5)}${pad('Associated', 14)}${pad(` ${c.wlan}`, 6)}${pad('Yes', 5)}${pad(c.protocol, 17)}${pad('1', 5)}${pad('No', 6)}${pad('No', 8)}Local`)
  return out.join('\n')
}

export function clientDetail(d: Device, mac: string): string {
  const norm = (m: string): string => m.replace(/[^0-9a-f]/gi, '').toLowerCase()
  const c = liveClients(d).find((x) => norm(x.mac) === norm(mac))
  if (!c) return `No client with MAC address ${mac} found.`
  const w = wlc(d).wlans.find((x) => x.id === c.wlan)!
  return [
    dots('Client MAC Address', macColon(c.mac)),
    dots('Client Username', c.user ?? 'N/A'),
    dots('AP MAC Address', macColon(wlc(d).aps.find((a) => a.name === c.ap)?.mac ?? '')),
    dots('AP Name', c.ap),
    dots('Client State', 'Associated'),
    dots('Wireless LAN Id', c.wlan),
    dots('Wireless LAN Network Name (SSID)', w.ssid),
    dots('IP Address', c.ip),
    dots('Policy Manager State', 'RUN'),
    dots('Radio Signal Strength Indicator', `${c.rssi} dBm`),
    dots('Protocol', c.protocol)
  ].join('\n')
}

export function interfaceSummary(d: Device): string {
  const l = d.interfaces.filter((i) => !/^\d+$/.test(i.name))
  const out = [
    dots(' Number of Interfaces', l.length, 48),
    '',
    'Interface Name                   Port Vlan Id  IP Address      Type    Ap Mgr Guest',
    '-------------------------------- ---- -------- --------------- ------- ------ -----'
  ]
  for (const i of l) {
    const port = i.name === 'management' || i.vlan !== undefined ? 'LAG' : 'N/A'
    const vlan = i.vlan !== undefined ? String(i.vlan) : i.name === 'management' ? 'untagged' : 'N/A'
    const type = i.name === 'management' || i.name === 'service-port' || i.name === 'virtual' ? 'Static' : 'Dynamic'
    out.push(`${pad(i.name, 33)}${pad(port, 5)}${pad(vlan, 9)}${pad(i.ip ?? '', 16)}${pad(type, 8)}${pad(i.name === 'management' ? 'Yes' : 'No', 7)}No`)
  }
  return out.join('\n')
}

export function interfaceDetailed(i: Iface): string {
  return [
    dots('Interface Name', i.name),
    dots('MAC Address', macColon(i.mac)),
    dots('IP Address', i.ip ?? ''),
    dots('IP Netmask', i.mask !== undefined ? maskToDotted(i.mask) : ''),
    dots('VLAN', i.vlan ?? 'untagged'),
    dots('Active Physical Port', 'LAG (13)'),
    dots('Link Status', isUp(i) ? 'Up' : 'Down')
  ].join('\n')
}

export function portSummary(d: Device): string {
  const out = [
    '           STP   Admin   Physical   Physical   Link   Link',
    'Pr  Type   Stat  Mode    Mode       Status     Status Trap     POE    SFPType',
    '--  ------ ---- ------- ---------- ---------- ------ ------- ------- ----------'
  ]
  for (const i of d.interfaces.filter((x) => /^\d+$/.test(x.name))) {
    const mode = `${i.speedSet ?? '10000'} ${resolvedDuplex(i) === 'full' ? 'Full' : 'Half'}`
    out.push(`${pad(i.name, 4)}${pad('Normal', 7)}${pad(isUp(i) ? 'Forw' : 'Disa', 5)}${pad(i.adminUp ? 'Enable' : 'Disable', 8)}${pad('Auto', 11)}${pad(isUp(i) ? mode : 'Auto', 11)}${pad(isUp(i) ? 'Up' : 'Down', 7)}${pad('Enable', 8)}${pad('N/A', 8)}${i.media ?? ''}`)
  }
  return out.join('\n')
}

export function portDetail(d: Device, i: Iface): string {
  const c = ifaceCounters(d, i)
  return [
    `Port ${i.name}:`,
    dots('  Admin Mode', i.adminUp ? 'Enable' : 'Disable'),
    dots('  Link Status', isUp(i) ? 'Up' : 'Down'),
    dots('  Duplex', resolvedDuplex(i) === 'full' ? 'Full' : 'Half'),
    dots('  Total Packets Received', c.inPkts),
    dots('  Total Packets Transmitted', c.outPkts),
    dots('  CRC Errors', c.crc),
    dots('  Collisions', c.collisions),
    dots('  Late Collisions', c.lateCollisions)
  ].join('\n')
}

function activeHog(d: Device): Device['cpu']['hog'] {
  const h = d.cpu.hog
  return h && (!h.whileService || d.services[h.whileService]) ? h : undefined
}

export function cpu(d: Device): string {
  const l = Math.min(100, d.cpu.load[0] + (activeHog(d)?.pct ?? 0))
  return `Current CPU(s) load: ${l}%\n\nIndividual CPU load: ${l}%/0%, ${Math.floor(l / 2)}%/0%, 1%/0%, 1%/0%`
}

export function processCpu(d: Device): string {
  const hog = activeHog(d)
  let procs = d.cpu.processes.map((p) => ({ ...p, pct: hog && hog.pid === p.pid ? hog.pct : p.pct }))
  if (hog && !procs.some((p) => p.pid === hog.pid)) procs.push({ pid: hog.pid, name: hog.name, pct: hog.pct })
  procs = procs.sort((a, b) => b.pct - a.pct)
  const out = ['Name                   Priority      CPU Use    Reaper']
  for (const p of procs) out.push(`${pad(p.name, 23)}(${String(p.pid % 250).padStart(3)}/${String(124).padStart(3)})   ${String(p.pct).padStart(3)}  %   (  0/  0)%    I`)
  return out.join('\n')
}

export function msglog(d: Device): string {
  return [...d.log].reverse().map((e) => `${new Date(e.t).toUTCString().slice(4, 25)}: ${e.msg}`).join('\n')
}

export function runConfigCommands(d: Device): string {
  const v = wlc(d)
  const out = [`config sysname ${d.hostname}`, `config prompt "${v.prompt}"`]
  if (d.motd !== undefined) out.push(`config sys banner "${d.motd}"`)
  for (const i of d.interfaces.filter((x) => /^\d+$/.test(x.name))) if (!i.adminUp) out.push(`config port adminmode ${i.name} disable`)
  for (const i of d.interfaces.filter((x) => !/^\d+$/.test(x.name))) {
    if (i.ip && i.mask !== undefined) out.push(`config interface address ${i.name} ${i.ip} ${maskToDotted(i.mask)}`)
    if (i.vlan !== undefined) out.push(`config interface vlan ${i.name} ${i.vlan}`)
  }
  for (const w of v.wlans) {
    out.push(`config wlan create ${w.id} ${w.profile} ${w.ssid}`)
    out.push(`config wlan interface ${w.id} ${w.iface}`)
    out.push(`config wlan ${w.enabled ? 'enable' : 'disable'} ${w.id}`)
  }
  for (const a of v.aps) {
    out.push(`config ap location "${a.location}" ${a.name}`)
    if (!a.adminUp) out.push(`config ap disable ${a.name}`)
  }
  return out.join('\n')
}

export function timeText(d: Device): string {
  return `Time.................................... ${new Date(now(d)).toUTCString().replace(' GMT', '')}\n\nTimezone delta........................... 0:0`
}
