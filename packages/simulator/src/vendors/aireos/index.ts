/**
 * Cisco AireOS 8.10 WLC personality: `(Cisco Controller) >` and `(Cisco Controller) config>`,
 * `config ...` from the top level or inside config mode (one subtree mounted twice), `show sysinfo`,
 * APs/WLANs/clients from `d.vendor.aireos`, `config ap disable`, `config wlan disable`,
 * `save config` with `(y/n)`, `config paging disable`, the `--More-- or (q)uit` pager, `?` help,
 * Tab, and `Incorrect usage. Use the '?' or <TAB> key to list commands.`
 *
 * Strings are from memory of AireOS 8.x [unverified, from memory] unless the brief gave them.
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { completions, help as treeHelp, isIpv4, kw, match, prm, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { inSubnet } from '../../core/text.ts'
import { isUp, logEvent, snapshot, type Device } from '../../state.ts'
import * as R from './render.ts'

const INCORRECT = "Incorrect usage. Use the '?' or <TAB> key to list commands."

export const AIREOS_PAGER: PagerSpec = {
  text: () => '--More-- or (q)uit',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'page'
}

export class AireosPersonality implements Personality {
  readonly s: Session
  readonly d: Device
  mode: 'exec' | 'config' = 'exec'
  abortKeys = ['\x03']
  pager = AIREOS_PAGER
  private trees: { exec: Node[]; config: Node[] } | undefined

  constructor(s: Session) {
    this.s = s
    this.d = s.d
    const v = this.d.vendor as Record<string, unknown>
    if (typeof v['aireosSaved'] !== 'string') v['aireosSaved'] = R.runConfigCommands(this.d)
  }

  banner(): string {
    return this.d.motd !== undefined ? `${this.d.motd}\n` : ''
  }

  promptText(): string {
    return `(${R.wlc(this.d).prompt}) ${this.mode === 'config' ? 'config' : ''}>`
  }

  prompt(_reason: PromptReason): string {
    return this.promptText()
  }

  private roots(): Node[] {
    this.trees ??= this.build()
    return this.trees[this.mode]
  }

  private dirty(): boolean {
    return (this.d.vendor as Record<string, unknown>)['aireosSaved'] !== R.runConfigCommands(this.d)
  }

  async execute(line: string): Promise<void> {
    const m = match(line, this.roots())
    if (!m.ok) {
      await this.s.print(INCORRECT)
      return
    }
    const out = (await m.node.run!(m.ctx)) ?? ''
    if (out) await this.s.print(out)
  }

  help(line: string): string {
    const h = treeHelp(line, this.roots())
    if (!h.ok) return `\n${INCORRECT}`
    return this.helpList(h)
  }

  private helpList(h: Extract<HelpResult, { ok: true }>): string {
    const rows = h.entries.map((e) => `${e.label.padEnd(15)}${e.help}`.trimEnd())
    if (h.cr) rows.push('<cr>')
    if (!rows.length) return `\n${INCORRECT}`
    return '\n' + rows.join('\n') + '\n'
  }

  tab(line: string): TabResult {
    const { partial, options } = completions(line, this.roots())
    if (options.length === 1) return { line: line.slice(0, line.length - partial.length) + options[0] + ' ' }
    if (options.length > 1) return { list: options.join('  '), line }
    return { bell: true }
  }

  control(key: 'c' | 'z', _line: string): ControlResult {
    if (key === 'z') return { echo: '\n', then: () => (this.mode = 'exec') }
    return { echo: '\n' }
  }

  // ------------------------------------------------------------------ actions

  private async save(): Promise<string> {
    const a = (await this.s.ask('\n\nAre you sure you want to save? (y/n) ', { mode: 'line' })).trim().toLowerCase()
    if (a !== 'y' && a !== 'yes') return '\nConfiguration not saved!'
    ;(this.d.vendor as Record<string, unknown>)['aireosSaved'] = R.runConfigCommands(this.d)
    this.d.startup = snapshot(this.d)
    await this.s.sleep(50)
    return '\nConfiguration Saved!'
  }

  private async logout(): Promise<string> {
    if (this.dirty()) {
      const a = (await this.s.ask('\nThe system has unsaved changes.\nWould you like to save them now? (y/N) ', { mode: 'line' })).trim().toLowerCase()
      if (a === 'y' || a === 'yes') {
        ;(this.d.vendor as Record<string, unknown>)['aireosSaved'] = R.runConfigCommands(this.d)
        this.d.startup = snapshot(this.d)
        await this.s.print('\nConfiguration Saved!')
      }
    }
    this.s.close()
    return ''
  }

  private async ping(ip: string): Promise<string> {
    const ok = this.d.interfaces.some((i) => isUp(i) && i.ip && i.mask !== undefined && i.mask < 32 && inSubnet(ip, i.ip, i.mask)) && (this.d.arp.some((a) => a.ip === ip) || R.wlc(this.d).aps.some((a) => a.ip === ip && a.joined) || R.liveClients(this.d).some((c) => c.ip === ip))
    await this.s.sleep(ok ? 30 : 300)
    return `\nSend count=3, Receive count=${ok ? 3 : 0} from ${ip}\n`
  }

  private ap(name: string): ReturnType<typeof R.wlc>['aps'][number] | undefined {
    return R.wlc(this.d).aps.find((a) => a.name.toLowerCase() === name.toLowerCase())
  }

  private wlan(id: string): ReturnType<typeof R.wlc>['wlans'][number] | undefined {
    return R.wlc(this.d).wlans.find((w) => String(w.id) === id)
  }

  // ------------------------------------------------------------------ trees

  private build(): { exec: Node[]; config: Node[] } {
    const d = this.d
    const word = (label = '<name>', values?: () => string[]): Param => ({ kind: 'word', label, ...(values ? { values } : {}) })
    const apP = word('<Cisco AP>', () => R.wlc(d).aps.map((a) => a.name))
    const wlanP: Param = { kind: 'int', label: '<WLAN id>', min: 1, max: 512, values: () => R.wlc(d).wlans.map((w) => String(w.id)) }
    const portP: Param = { kind: 'int', label: '<port>', min: 1, max: 8, values: () => d.interfaces.filter((i) => /^\d+$/.test(i.name)).map((i) => i.name) }
    const ifP = word('<interface-name>', () => d.interfaces.filter((i) => !/^\d+$/.test(i.name)).map((i) => i.name))

    const apAdmin = (up: boolean) => (c: { args: Record<string, string> }): string | void => {
      const a = this.ap(c.args['ap']!)
      if (!a) return `\nCisco AP ${c.args['ap']} is not found.`
      if (a.adminUp === up) return
      a.adminUp = up
      logEvent(d, `*spamApTask0: %LWAPP-3-AP_ADMIN_${up ? 'ENABLE' : 'DISABLE'}: AP ${a.name} administratively ${up ? 'enabled' : 'disabled'}`)
    }
    const wlanAdmin = (up: boolean) => (c: { args: Record<string, string> }): string | void => {
      const w = this.wlan(c.args['id']!)
      if (!w) return `\nRequest failed. WLAN ${c.args['id']} does not exist.`
      w.enabled = up
    }

    const cfg: Node[] = [
      kw('paging', 'Enables or disables scrolling of the page.', {
        children: [
          kw('enable', 'Enables scrolling of the page.', { run: () => void (this.s.pageLength = this.s.rows - 1) }),
          kw('disable', 'Disables scrolling of the page.', { run: () => void (this.s.pageLength = 0) })
        ]
      }),
      kw('ap', 'Configures Cisco Access Points.', {
        children: [
          kw('disable', 'Disables a Cisco AP.', { children: [prm(apP, 'Enter the name of the Cisco AP.', { name: 'ap', run: apAdmin(false) })] }),
          kw('enable', 'Enables a Cisco AP.', { children: [prm(apP, 'Enter the name of the Cisco AP.', { name: 'ap', run: apAdmin(true) })] }),
          kw('location', 'Configures the location of a Cisco AP.', {
            children: [
              prm(word('<location>'), 'Enter the location in quotes.', {
                name: 'loc',
                children: [
                  prm(apP, 'Enter the name of the Cisco AP.', {
                    name: 'ap',
                    run: (c) => {
                      const a = this.ap(c.args['ap']!)
                      if (!a) return `\nCisco AP ${c.args['ap']} is not found.`
                      a.location = c.args['loc']!.replace(/^"(.*)"$/, '$1')
                    }
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('wlan', 'Configures WLANs.', {
        children: [
          kw('disable', 'Disables a WLAN.', { children: [prm(wlanP, 'Enter WLAN Identifier between 1 and 512.', { name: 'id', run: wlanAdmin(false) })] }),
          kw('enable', 'Enables a WLAN.', { children: [prm(wlanP, 'Enter WLAN Identifier between 1 and 512.', { name: 'id', run: wlanAdmin(true) })] }),
          kw('create', 'Creates a WLAN.', {
            children: [
              prm(wlanP, 'Enter WLAN Identifier between 1 and 512.', {
                name: 'id',
                children: [
                  prm(word('<profile name>'), 'Enter Profile Name up to 32 alphanumeric characters.', {
                    name: 'profile',
                    run: (c) => this.createWlan(c.args['id']!, c.args['profile']!, c.args['profile']!),
                    children: [prm(word('<ssid>'), 'Enter SSID (Network Name) up to 32 alphanumeric characters.', { name: 'ssid', run: (c) => this.createWlan(c.args['id']!, c.args['profile']!, c.args['ssid']!) })]
                  })
                ]
              })
            ]
          }),
          kw('delete', 'Deletes a WLAN.', {
            children: [
              prm(wlanP, 'Enter WLAN Identifier between 1 and 512.', {
                name: 'id',
                run: (c) => {
                  const w = this.wlan(c.args['id']!)
                  if (!w) return `\nRequest failed. WLAN ${c.args['id']} does not exist.`
                  if (w.enabled) return '\nRequest failed. WLAN must be disabled first.'
                  const v = R.wlc(d)
                  v.wlans = v.wlans.filter((x) => x !== w)
                  v.clients = v.clients.filter((x) => x.wlan !== w.id)
                }
              })
            ]
          })
        ]
      }),
      kw('port', 'Configures the physical ports.', {
        children: [
          kw('adminmode', 'Enables or disables the administrative mode of a port.', {
            children: [
              prm(portP, 'Enter the port number.', {
                name: 'p',
                children: ['enable', 'disable'].map((m) =>
                  kw(m, `${m === 'enable' ? 'Enables' : 'Disables'} the port.`, {
                    run: (c) => {
                      const i = d.interfaces.find((x) => x.name === c.args['p'])
                      if (!i) return `\nPort ${c.args['p']} does not exist.`
                      i.adminUp = m === 'enable'
                    }
                  })
                )
              })
            ]
          })
        ]
      }),
      kw('sysname', 'Configures the system name.', { children: [prm(word('<name>'), 'Enter the system name.', { name: 'n', run: (c) => void (d.hostname = c.args['n']!) })] }),
      kw('prompt', 'Changes the CLI system prompt.', { children: [prm({ kind: 'line', label: '<prompt>' }, 'Enter the new CLI system prompt in quotes.', { name: 'p', run: (c) => void (R.wlc(d).prompt = c.args['p']!.replace(/^"(.*)"$/, '$1')) })] })
    ]

    const show: Node[] = [
      kw('sysinfo', 'Display system information.', { run: () => R.sysinfo(d) }),
      kw('inventory', 'Displays Cisco system inventory.', { run: () => R.inventory(d) }),
      kw('ap', 'Display Cisco AP Information.', {
        children: [
          kw('summary', 'Display a summary of all Cisco APs.', { run: () => R.apSummary(d) }),
          kw('status', 'Display the status of all Cisco APs.', { run: () => R.apStatus(d) }),
          kw('config', 'Display Cisco AP configuration.', { children: [kw('general', 'Display general Cisco AP configuration.', { children: [prm(apP, 'Enter the name of the Cisco AP.', { name: 'ap', run: (c) => R.apConfigGeneral(d, c.args['ap']!) })] })] })
        ]
      }),
      kw('wlan', 'Display WLAN configuration information.', {
        children: [kw('summary', 'Display a summary of all WLANs.', { run: () => R.wlanSummary(d) }), prm(wlanP, 'Enter WLAN Identifier.', { name: 'id', run: (c) => R.wlanDetail(d, Number(c.args['id'])) })]
      }),
      kw('client', 'Display client information.', {
        children: [
          kw('summary', 'Display a summary of clients associated with each AP.', { run: () => R.clientSummary(d) }),
          kw('detail', 'Display detailed client information.', { children: [prm({ kind: 'mac', label: '<MAC addr>' }, 'Enter the MAC address of the client.', { name: 'mac', run: (c) => R.clientDetail(d, c.args['mac']!) })] })
        ]
      }),
      kw('interface', 'Display interface information.', {
        children: [
          kw('summary', 'Display a summary of all interfaces.', { run: () => R.interfaceSummary(d) }),
          kw('detailed', 'Display detailed interface information.', {
            children: [
              prm(ifP, 'Enter the interface name.', {
                name: 'if',
                run: (c) => {
                  const i = d.interfaces.find((x) => x.name === c.args['if'])
                  return i ? R.interfaceDetailed(i) : `\nInterface ${c.args['if']} does not exist.`
                }
              })
            ]
          })
        ]
      }),
      kw('port', 'Display port information.', {
        children: [
          kw('summary', 'Display a summary of all ports.', { run: () => R.portSummary(d) }),
          kw('detailed-info', 'Display detailed port information.', {
            children: [
              prm(portP, 'Enter the port number.', {
                name: 'p',
                run: (c) => {
                  const i = d.interfaces.find((x) => x.name === c.args['p'])
                  return i ? R.portDetail(d, i) : `\nPort ${c.args['p']} does not exist.`
                }
              })
            ]
          })
        ]
      }),
      kw('cpu', 'Display the CPU usage information.', { run: () => R.cpu(d) }),
      kw('process', 'Display process information.', { children: [kw('cpu', 'Display the CPU usage of each process.', { run: () => R.processCpu(d) })] }),
      kw('msglog', 'Display the message log.', { run: () => R.msglog(d) }),
      kw('time', 'Display the system time.', { run: () => R.timeText(d) }),
      kw('run-config', 'Display the running configuration.', { run: () => R.sysinfo(d) + '\n\n' + R.wlanSummary(d) + '\n\n' + R.apSummary(d), children: [kw('commands', 'Display the running configuration as CLI commands.', { run: () => R.runConfigCommands(d) })] })
    ]

    const exec: Node[] = [
      kw('show', 'Display switch options and settings.', { children: show }),
      kw('config', 'Configure switch options and settings.', { run: () => void (this.mode = 'config'), children: cfg }),
      kw('save', 'Save switch configurations.', { children: [kw('config', 'Save the configuration to NVRAM.', { run: () => this.save() })] }),
      kw('ping', 'Send ICMP echo packets to a specified IP address.', { children: [prm({ kind: 'ipv4', label: '<IP addr>' }, 'Enter the IP address.', { name: 'ip', run: (c) => this.ping(c.args['ip']!) })] }),
      kw('logout', 'Exit this session. Any unsaved changes are lost.', { run: () => this.logout() }),
      kw('exit', 'Exit this session.', { hidden: true, run: () => this.logout() }),
      kw('reset', 'Reset options.', {
        children: [
          kw('system', 'Reset the system.', {
            run: async () => {
              const a = (await this.s.ask('Are you sure you would like to reset the system? (y/N) ', { mode: 'line' })).trim().toLowerCase()
              return a === 'y' ? '[simulator] reset acknowledged; the simulated controller never reboots.' : ''
            }
          })
        ]
      })
    ]
    const config: Node[] = [...cfg, kw('exit', 'Exit config mode.', { run: () => void (this.mode = 'exec') }), kw('end', 'Exit config mode.', { hidden: true, run: () => void (this.mode = 'exec') })]
    void isIpv4
    return { exec, config }
  }

  private createWlan(id: string, profile: string, ssid: string): string | void {
    const v = R.wlc(this.d)
    if (v.wlans.some((w) => String(w.id) === id)) return `\nRequest failed. WLAN ${id} already exists.`
    if (v.wlans.some((w) => w.profile === profile)) return '\nRequest failed. Profile name already in use.'
    v.wlans.push({ id: Number(id), profile, ssid, enabled: false, iface: 'management', security: '[WPA2][Auth(802.1X)]' })
    v.wlans.sort((a, b) => a.id - b.id)
  }
}

export const aireosFactory = (s: Session): AireosPersonality => new AireosPersonality(s)
