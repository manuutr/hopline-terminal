/**
 * Catalyst 9800 wireless controller (IOS-XE 17.x). Reuses the IOS-XE personality wholesale
 * (prompts, errors, caret, pager, config model) and adds the wireless show commands, WLAN config
 * and a C9800 `show version` / running-config.
 *
 * No research doc exists for this platform: every wireless layout below is
 * `[unverified, from memory]` of 17.x controllers.
 */
import type { Session } from '../../core/personality.ts'
import { add, kw, prm, type Node } from '../../core/tree.ts'
import { now } from '../../core/runtime.ts'
import { pad } from '../../core/text.ts'
import { IosPersonality } from '../ios/index.ts'
import { runningConfig } from '../ios/config.ts'
import { ciscoDate } from '../ios/render.ts'
import type { CMode } from '../cisco/base.ts'
import { isUp, uptimeLong, type Device } from '../../state.ts'
import type { C9800Ap, C9800Client, C9800Data, C9800Wlan } from '../../devices/c9800.ts'

export function wireless(d: Device): C9800Data {
  const v = d.vendor as { c9800?: C9800Data }
  return (v.c9800 ??= { aps: [], clients: [], wlans: [], wmi: 'Vlan1', uplinks: [] })
}

/** APs stay joined while the wireless management interface and at least one uplink are up. */
export function joinedAps(d: Device): C9800Ap[] {
  const w = wireless(d)
  const wmi = d.interfaces.find((i) => i.name === w.wmi)
  if (!wmi || !isUp(wmi)) return []
  if (w.uplinks.length && !w.uplinks.some((u) => { const i = d.interfaces.find((x) => x.name === u); return !!i && isUp(i) })) return []
  return w.aps
}

/** Clients in RUN state: their AP is joined and their WLAN enabled. */
export function liveClients(d: Device): C9800Client[] {
  const aps = new Set(joinedAps(d).map((a) => a.name))
  const w = wireless(d)
  return w.clients.filter((c) => aps.has(c.ap) && w.wlans.some((x) => x.id === c.wlan && !x.shutdown))
}

// ---------------------------------------------------------------- renderers

export function showApSummary(d: Device): string {
  const aps = joinedAps(d)
  return [
    `Number of APs: ${aps.length}`,
    '',
    'CC = Country Code',
    'RD = Regulatory Domain',
    '',
    'AP Name                          Slots AP Model             Ethernet MAC   Radio MAC      CC   RD   IP Address                                State        Location',
    '-'.repeat(181),
    ...aps.map((a) => `${pad(a.name, 33)}${pad(a.slots, 6)}${pad(a.model, 21)}${pad(a.mac, 15)}${pad(a.radioMac, 15)}${pad(a.country, 5)}${pad('-B', 5)}${pad(a.ip, 42)}${pad('Registered', 13)}${a.location}`)
  ].join('\n')
}

export function showWirelessClientSummary(d: Device): string {
  const cl = liveClients(d)
  return [
    `Number of Clients: ${cl.length}`,
    '',
    'MAC Address    AP Name                                        Type ID   State             Protocol Method     Role',
    '-'.repeat(121),
    ...cl.map((c) => `${pad(c.mac, 15)}${pad(c.ap, 47)}${pad('WLAN', 5)}${pad(c.wlan, 5)}${pad('Run', 18)}${pad(c.protocol, 9)}${pad(c.method, 11)}Local`),
    '',
    'Number of Excluded Clients: 0'
  ].join('\n')
}

export function showWlanSummary(d: Device): string {
  const wl = [...wireless(d).wlans].sort((a, b) => a.id - b.id)
  return [
    `Number of WLANs: ${wl.length}`,
    '',
    'ID   Profile Name                     SSID                             Status 2.4GHz/5GHz Security',
    '-'.repeat(127),
    ...wl.map((w) => `${pad(w.id, 5)}${pad(w.profile, 33)}${pad(w.ssid, 33)}${pad(w.shutdown ? 'DOWN' : 'UP', 7)}${pad('Enabled', 12)}${w.security}`)
  ].join('\n')
}

export function showWirelessSummary(d: Device): string {
  const aps = joinedAps(d)
  const radios = aps.reduce((a, x) => a + x.slots, 0)
  return [
    'Max APs supported      : 2000',
    'Max clients supported  : 32000',
    '',
    `Number of APs          : ${aps.length}`,
    `Number of radios       : ${radios}`,
    `  2.4 GHz              : ${aps.length}`,
    `  5 GHz                : ${aps.length}`,
    `  6 GHz                : 0`,
    `  Dual-band            : ${radios - 2 * aps.length > 0 ? radios - 2 * aps.length : 0}`,
    '',
    `Number of Clients      : ${liveClients(d).length}`,
    `Number of WLANs        : ${wireless(d).wlans.length}`
  ].join('\n')
}

export function showIpIntBriefWide(d: Device): string {
  const rows = d.interfaces.map((i) => {
    const [st, pr] = !i.adminUp ? ['administratively down', 'down'] : isUp(i) ? ['up', 'up'] : ['down', 'down']
    const name = i.name.length >= 23 ? `${i.name} ` : pad(i.name, 23)
    return `${name}${pad(i.ip ?? 'unassigned', 16)}YES ${pad(i.ipMethod ?? (i.ip ? 'NVRAM' : 'unset'), 7)}${pad(st, 22)}${pr}`
  })
  return ['Interface              IP-Address      OK? Method Status                Protocol', ...rows].join('\n')
}

export function showC9800Version(d: Device): string {
  const t = now(d)
  const [maj, min, rest] = d.version.split('.')
  const padded = `${maj}.${String(min).padStart(2, '0')}.${String(rest).replace(/^(\d+)/, (n) => n.padStart(2, '0'))}`
  const ten = d.interfaces.filter((i) => i.name.startsWith('TenGig')).length
  return `Cisco IOS XE Software, Version ${padded}
Cisco IOS Software [Cupertino], C9800 Software (C9800_IOSXE-K9), Version ${d.version}, RELEASE SOFTWARE (fc5)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2023 by Cisco Systems, Inc.
Compiled Fri 20-Oct-23 10:44 by mcpre


Cisco IOS-XE software, Copyright (c) 2005-2023 by cisco Systems, Inc.
All rights reserved.  Certain components of Cisco IOS-XE software are
licensed under the GNU General Public License ("GPL") Version 2.0.  The
software code licensed under GPL Version 2.0 is free software that comes
with ABSOLUTELY NO WARRANTY.  You can redistribute and/or modify such
GPL code under the terms of GPL Version 2.0.  For more details, see the
documentation or "License Notice" file accompanying the IOS-XE software,
or the applicable URL provided on the flyer accompanying the IOS-XE
software.


ROM: 16.12(3r)

${d.hostname} uptime is ${uptimeLong(d.bootedAt, t)}
Uptime for this control processor is ${uptimeLong(d.bootedAt - 120_000, t)}
System returned to ROM by Reload Command at ${ciscoDate(d.bootedAt - 381_000)}
System image file is "bootflash:packages.conf"
Last reload reason: Reload Command



This product contains cryptographic features and is subject to United
States and local country laws governing import, export, transfer and
use. Delivery of Cisco cryptographic products does not imply
third-party authority to import, export, distribute or use encryption.
Importers, exporters, distributors and users are responsible for
compliance with U.S. and local country laws. By using this product you
agree to comply with applicable laws and regulations. If you are unable
to comply with U.S. and local laws, return this product immediately.

A summary of U.S. laws governing Cisco cryptographic products may be found at:
http://www.cisco.com/wwl/export/crypto/tool/stqrg.html

If you require further assistance please contact us by sending email to
export@cisco.com.


Technology Package License Information:

-----------------------------------------------------------------------------
Technology Package           Technology-package           Technology-package
                             Current       Type           Next reboot
-----------------------------------------------------------------------------
air-network-advantage        air-network-advantage   Smart License   air-network-advantage
air-dna-advantage            air-dna-advantage       Subscription Smart License  air-dna-advantage

Smart Licensing Status: Smart Licensing Using Policy

cisco ${d.model} (KATAR) processor (revision KATAR) with 15720478K/6147K bytes of memory.
Processor board ID ${d.serial}
Router operating mode: Autonomous
1 Virtual Ethernet interface
1 Gigabit Ethernet interface
${ten} Ten Gigabit Ethernet interfaces
32768K bytes of non-volatile configuration memory.
32864156K bytes of physical memory.
26975223K bytes of Bootflash at bootflash:.

Configuration register is 0x2102
`
}

/** IOS-XE running-config with the switch-only lines dropped and the wireless config added. */
export function c9800RunningConfig(d: Device): string {
  const lines = runningConfig(d).split('\n')
  const out: string[] = []
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!
    if (l === 'vrf definition Mgmt-vrf') {
      // The IOS renderer always emits the switch Mgmt-vrf block; the controller uses Mgmt-intf.
      while (k < lines.length && lines[k] !== '!') k++
      continue
    }
    if (/^(switch 1 provision|license boot level|spanning-tree )/.test(l)) continue
    out.push(l)
  }
  const w = wireless(d)
  const wl: string[] = [`wireless management interface ${w.wmi}`, 'wireless mobility group name LAB-MOBILITY', '!']
  for (const x of [...w.wlans].sort((a, b) => a.id - b.id)) {
    wl.push(`wlan ${x.profile} ${x.id} ${x.ssid}`)
    if (x.security.includes('PSK')) wl.push(' no security wpa akm dot1x', ' security wpa akm psk', ' security wpa psk set-key ascii 8 Q[XfVbM_ZEXOMbOJfAVBMgfM')
    else wl.push(' security dot1x authentication-list ISE-AUTH')
    wl.push(x.shutdown ? ' shutdown' : ' no shutdown')
  }
  wl.push('!', 'wireless tag policy default-policy-tag', ' description "default policy-tag"', ...w.wlans.map((x) => ` wlan ${x.profile} policy default-policy-profile`), '!')
  const at = out.lastIndexOf('line con 0')
  out.splice(at < 0 ? out.length - 1 : at - 1, 0, ...wl)
  const body = out.slice(out.findIndex((l) => l.startsWith('Current configuration')) + 1)
  const idx = out.findIndex((l) => l.startsWith('Current configuration'))
  if (idx >= 0) out[idx] = `Current configuration : ${body.join('\n').length + 1} bytes`
  return out.join('\n')
}

// ---------------------------------------------------------------- personality

export class C9800Personality extends IosPersonality {
  private wTrees: Record<string, Node[]> | undefined

  constructor(s: Session) {
    super(s)
  }

  protected override suffix(m: CMode): string {
    if (m.id === 'config-wlan') return '(config-wlan)'
    return super.suffix(m)
  }

  protected override tree(modeId: string): Node[] {
    if (!this.wTrees) this.wTrees = this.extend()
    if (this.wTrees[modeId]) return this.wTrees[modeId]!
    return super.tree(modeId)
  }

  /** Graft the wireless commands onto the IOS trees once. */
  private extend(): Record<string, Node[]> {
    const d = this.d
    const exec = super.tree('exec')
    const user = super.tree('user')
    const config = super.tree('config')
    const S = (path: string, help: string, run: Node['run']): Node => add(exec, `show ${path}`, help, run, {}, { ap: 'Show Cisco AP information', wireless: 'Show wireless information', wlan: 'WLAN information', 'wireless client': 'Show client information' })
    S('version', 'System hardware and software status', () => showC9800Version(d))
    S('running-config', 'Current operating configuration', () => c9800RunningConfig(d))
    // Local copy of the IOS brief table: the shared renderer glues 24-character names
    // (TenGigabitEthernet0/0/0) onto the address column; IOS keeps one space.
    S('ip interface brief', 'Brief summary of IP status and configuration', () => showIpIntBriefWide(d))
    S('ap summary', 'Summary of all connected Cisco APs', () => showApSummary(d))
    S('wireless client summary', 'Display client summary', () => showWirelessClientSummary(d))
    S('wireless summary', 'Display wireless summary', () => showWirelessSummary(d))
    S('wlan summary', 'Show summary of WLANs', () => showWlanSummary(d))
    S('wlan all', 'Show all WLANs', () => showWlanSummary(d))
    add(exec, 'write terminal', 'Write to terminal', () => c9800RunningConfig(d))
    // user EXEC shares the `show` children objects; make sure the wireless ones are visible there too.
    const ushow = user.find((n) => n.word === 'show')
    for (const w of ['ap', 'wireless', 'wlan']) {
      const n = exec.find((x) => x.word === 'show')!.children!.find((c) => c.word === w)
      if (ushow && n && !ushow.children!.includes(n)) ushow.children!.push(n)
    }

    // ---- WLAN config
    const wlanOf = (): C9800Wlan | undefined => wireless(d).wlans.find((w) => w.profile === this.mode.ctx)
    const changed = (): string => {
      this.touch()
      return ''
    }
    const enter = (profile: string, id?: number, ssid?: string): string => {
      const w = wireless(d)
      let x = w.wlans.find((v) => v.profile === profile)
      if (!x) {
        if (id === undefined) return `% WLAN ${profile} does not exist`
        if (w.wlans.some((v) => v.id === id)) return `% WLAN id ${id} is already in use`
        x = { id, profile, ssid: ssid ?? profile, security: '[WPA2][802.1x][AES]', shutdown: true }
        w.wlans.push(x)
      }
      this.setMode('config-wlan', x.profile)
      return changed()
    }
    add(config, 'wlan', 'Configure WLAN', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => wireless(d).wlans.map((w) => w.profile) }, 'Profile name up to 32 alphanumeric characters', {
          name: 'p',
          run: (c) => enter(c.args['p']!),
          children: [
            prm({ kind: 'int', label: '<1-4096>', min: 1, max: 4096 }, 'WLAN ID', {
              name: 'id',
              run: (c) => enter(c.args['p']!, Number(c.args['id'])),
              children: [prm({ kind: 'word', label: 'WORD' }, 'SSID name up to 32 alphanumeric characters', { name: 'ssid', run: (c) => enter(c.args['p']!, Number(c.args['id']), c.args['ssid']) })]
            })
          ]
        })
      ]
    })
    add(config, 'no wlan', 'Configure WLAN', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD', values: () => wireless(d).wlans.map((w) => w.profile) }, 'Profile name', {
          name: 'p',
          run: (c) => {
            const w = wireless(d)
            w.wlans = w.wlans.filter((x) => x.profile !== c.args['p'])
            return changed()
          }
        })
      ]
    })
    config.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    const setShut = (v: boolean): string => {
      const x = wlanOf()
      if (x) x.shutdown = v
      return changed()
    }
    const line = { kind: 'line' as const, label: 'LINE' }
    const wlanm: Node[] = [
      kw('shutdown', 'Shutdown the WLAN', { run: () => setShut(true) }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('shutdown', 'Shutdown the WLAN', { run: () => setShut(false) }), kw('security', 'Configure security', { children: [prm(line, 'security options', { run: () => changed() })] })] }),
      kw('security', 'Configure security', { children: [prm(line, 'security options', { run: () => changed() })] }),
      kw('radio', 'Configure radio policy', { children: [prm(line, 'radio policy', { run: () => changed() })] }),
      kw('exit', 'Exit from WLAN configuration mode', { run: () => (this.exitMode(), '') }),
      kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') }),
      kw('do', 'To run exec commands in config mode', { children: [prm(line, 'Exec Command', { run: () => '' })] })
    ]
    return { 'config-wlan': wlanm }
  }
}

export const c9800Factory = (s: Session): C9800Personality => new C9800Personality(s)
