/**
 * Aruba AOS-CX 10.x personality. Immediate-apply config; show commands work directly in config
 * modes (and with `do`); `no page` / `page` toggle the pager; checkpoints via
 * `copy running-config checkpoint NAME`, `show checkpoint`, `copy checkpoint NAME running-config`,
 * `checkpoint rollback NAME` and `checkpoint auto N` / `checkpoint auto confirm`.
 *
 * Reuses CiscoBase only as the generic mode-stack/line engine; every string is AOS-CX's own.
 * No research doc exists for AOS-CX: strings are `[unverified, from memory]` unless obvious.
 */
import type { PagerSpec, Session } from '../../core/personality.ts'
import { now, runtime } from '../../core/runtime.ts'
import { add, kw, match, prm, type Ctx, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { CiscoBase, ciscoHelpList, type CMode, type Failure, type PipeOutcome } from '../cisco/base.ts'
import { expandVlans, reachable } from '../ios/index.ts'
import { deviceFrom, logEvent, restore, snapshot, tickBgp, type Device, type Iface } from '../../state.ts'
import { cpName } from '../../devices/aoscx.ts'
import { applyPipes } from '../iosxr/pipes.ts'
import * as R from './render.ts'

/** `-- MORE --, next page: Space, next line: Enter, quit: q`. [unverified, from memory] */
export const AOSCX_PAGER: PagerSpec = {
  text: () => '-- MORE --, next page: Space, next line: Enter, quit: q',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'ignore'
}

const AUTO_TIMER = 'aoscx-checkpoint-auto'

/** Resolve an AOS-CX interface token: `1/1/1`, `vlan10`, `loopback0`, `lag1`, `mgmt`. */
export function findCxIf(d: Device, t: string): Iface | undefined {
  const s = t.toLowerCase().replace(/\s+/g, '')
  return d.interfaces.find((i) => i.name.toLowerCase() === s)
}

function armAuto(d: Device, ms: number): void {
  runtime(d).timer(AUTO_TIMER, ms, () => {
    const cx = R.cxData(d)
    if (!cx.auto) return
    restore(d, cx.auto.snap)
    cx.auto = undefined
    logEvent(d, 'hpe-config[1]: Event|1310|LOG_WARN|AMM|1/1|Auto checkpoint timer expired, configuration rolled back') // [unverified, from memory]
    runtime(d).broadcast('\nThe checkpoint auto timer expired. The running configuration has been rolled back.\n') // [unverified, from memory]
  })
}

export class AoscxPersonality extends CiscoBase {
  pager = AOSCX_PAGER
  protected override execFromConfig: 'do' | 'inherit' = 'inherit'
  private trees: Record<string, Node[]> | undefined

  constructor(s: Session) {
    super(s)
  }

  override banner(): string {
    return this.d.motd !== undefined ? `${this.d.motd}\n` : ''
  }

  protected suffix(m: CMode): string {
    return m.id === 'exec' ? '' : `(${m.id})`
  }

  protected errInvalid(_line: string, f: Failure): string {
    return `Invalid input: ${f.token ?? ''}`
  }
  protected errAmbiguous(): string {
    return 'Ambiguous command.' // [unverified, from memory]
  }
  protected errIncomplete(): string {
    return 'Command incomplete.'
  }
  protected helpPartial(words: string[]): string {
    return words.length ? words.map((w) => `  ${w}`).join('\n') + '\n' : 'Invalid input: \n' // [unverified, from memory]
  }
  protected helpList(h: Extract<HelpResult, { ok: true }>): string {
    if (!h.entries.length && !h.cr) return 'Command incomplete.\n'
    return ciscoHelpList(h, { cr: '', minWidth: 20 }) + '\n'
  }
  protected override pipeHelp(): string {
    return ['  begin                 Begin with the line that matches', '  count                 Count the number of lines', '  exclude               Exclude lines that match', '  include               Include lines that match', '  redirect              Redirect the output to a file', ''].join('\n')
  }
  protected pipes(out: string, pipes: string[], raw: string): PipeOutcome | { error: string } {
    return applyPipes(out, pipes, raw, ['begin', 'count', 'exclude', 'include', 'redirect'], {
      invalid: (at) => `Invalid input: ${raw.slice(at).split(/\s+/)[0] ?? ''}`,
      ambiguous: () => 'Ambiguous command.',
      incomplete: () => 'Command incomplete.'
    })
  }

  protected tree(modeId: string): Node[] {
    this.trees ??= this.build()
    if (/^config-vlan-\d+$/.test(modeId)) return this.trees['config-vlan']!
    if (/^config-ospf-\d+$/.test(modeId)) return this.trees['config-ospf']!
    return this.trees[modeId] ?? this.trees['config']!
  }

  override control(key: 'c' | 'z', line: string): ReturnType<CiscoBase['control']> {
    if (key === 'c') return { echo: '\n', then: () => undefined, keepLine: false } // AOS-CX just drops the line [unverified, from memory]
    return super.control(key, line)
  }

  private changed(): string {
    tickBgp(this.d)
    return ''
  }

  // ------------------------------------------------------------------ trees

  private build(): Record<string, Node[]> {
    const d = this.d
    const exec: Node[] = []
    const int = (min: number, max: number, label = `<${min}-${max}>`): Param => ({ kind: 'int', label, min, max })
    const ifP: Param = { kind: 'word', label: 'IFNAME', values: () => d.interfaces.map((i) => i.name), test: (t) => !!findCxIf(d, t) }
    const cpP: Param = { kind: 'word', label: 'CHECKPOINT-NAME', values: () => R.cxData(d).checkpoints.map((c) => c.name), test: (t) => R.cxData(d).checkpoints.some((c) => c.name === t) }
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(exec, `show ${path}`, help, run, extra)

    add(exec, 'show', 'Show running system information', undefined, { priority: true })
    S('version', 'Show the switch version information', () => R.showVersion(d))
    S('system', 'Show system information', () => R.showSystem(d))
    S('system resource-utilization', 'Show system resource utilization', () => R.showResourceUtil(d))
    const runRun = (c: Ctx): string => this.runSection(c.args['if'])
    S('running-config', 'Show the current running configuration', runRun, { children: [kw('interface', 'Show configuration for an interface', { children: [prm(ifP, 'Interface name', { name: 'if', run: runRun })] })] })
    S('startup-config', 'Show the startup configuration', () => (d.startup ? R.runningConfig(deviceFrom(d, d.startup)) : 'No saved configuration.'))
    S('interface', 'Show interface information', () => [...d.interfaces].sort(R.ifSort).map((i) => R.showInterface(d, i)).join('\n\n'), { children: [kw('brief', 'Show brief information', { run: () => R.showIntBrief(d) }), prm(ifP, 'Interface name', { name: 'if', run: (c) => R.showInterface(d, findCxIf(d, c.args['if']!)!), children: [kw('brief', 'Show brief information', { run: () => R.showIntBrief(d) })] })] })
    S('vlan', 'Show VLAN configuration', () => R.showVlan(d), { children: [prm(int(1, 4094, 'VLAN-ID'), 'VLAN identifier', { name: 'v', run: (c) => R.showVlan(d, Number(c.args['v'])) })] })
    S('lldp neighbor-info', 'Show LLDP neighbor information', () => R.showLldp(d), { children: [prm(ifP, 'Interface name', { name: 'if', run: (c) => R.showLldp(d, findCxIf(d, c.args['if']!)!.name) })] })
    S('ip route', 'Show the IPv4 routing table', () => R.showIpRoute(d), { children: [kw('vrf', 'VRF', { children: [prm({ kind: 'word', label: 'VRF-NAME', values: () => ['default', ...d.vrfs.map((v) => v.name)] }, 'VRF name', { name: 'vrf', run: (c) => R.showIpRoute(d, c.args['vrf']) })] })] })
    S('ip interface brief', 'Show IPv4 interface summary', () => R.showIpIntBrief(d))
    S('ip ospf neighbors', 'Show OSPF neighbor information', () => R.showOspfNeighbors(d))
    S('bgp all summary', 'Show BGP summary', () => R.showBgpSummary(d))
    S('mac-address-table', 'Show the MAC address table', () => R.showMacTable(d))
    S('arp', 'Show ARP table', () => R.showArp(d))
    S('clock', 'Show the system time', () => new Date(now(d)).toUTCString().replace('GMT', 'UTC'))
    S('events', 'Show event logs', () => d.log.map((e) => `${new Date(e.t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} ${e.msg}`).join('\n'))
    S('checkpoint', 'Show checkpoint information', () => this.showCheckpoints(), { children: [prm(cpP, 'Checkpoint name', { name: 'cp', run: (c) => R.runningConfig(deviceFrom(d, R.cxData(d).checkpoints.find((x) => x.name === c.args['cp'])!.snap)) })] })

    const save = (): string => {
      d.startup = snapshot(d)
      logEvent(d, `hpe-config[1]: Event|1306|LOG_INFO|AMM|1/1|Running configuration saved to startup by ${this.s.user}`) // [unverified, from memory]
      return 'Configuration changes will take time to process, please be patient.' // [unverified, from memory]
    }
    add(exec, 'write memory', 'Write running configuration to startup', save, {}, { write: 'Write running configuration' })
    const dst: Param = { kind: 'word', label: 'DESTINATION', values: () => ['startup-config', 'checkpoint'] }
    add(exec, 'copy', 'Copy configuration', undefined, {
      children: [
        kw('running-config', 'Copy the running configuration', {
          children: [
            kw('startup-config', 'Copy to the startup configuration', { run: () => (save(), 'Success') }),
            kw('checkpoint', 'Copy to a checkpoint', { children: [prm({ kind: 'word', label: 'CHECKPOINT-NAME', test: (t) => /^[A-Za-z][\w.-]{0,31}$/.test(t) }, 'Checkpoint name', { name: 'cp', run: (c) => this.makeCheckpoint(c.args['cp']!) })] })
          ]
        }),
        kw('startup-config', 'Copy the startup configuration', { children: [kw('running-config', 'Copy to the running configuration', { run: () => (d.startup ? (restore(d, d.startup), this.changed(), 'Success') : 'No saved configuration.') })] }),
        kw('checkpoint', 'Copy a checkpoint', { children: [prm(cpP, 'Checkpoint name', { name: 'cp', children: [kw('running-config', 'Copy to the running configuration', { run: (c) => this.applyCheckpoint(c.args['cp']!) }), kw('startup-config', 'Copy to the startup configuration', { run: (c) => ((d.startup = { ...R.cxData(d).checkpoints.find((x) => x.name === c.args['cp'])!.snap }), 'Success') })] })] })
      ]
    })
    void dst
    add(exec, 'checkpoint', 'Checkpoint commands', undefined, {
      children: [
        kw('rollback', 'Roll back the running configuration to a checkpoint', { children: [prm(cpP, 'Checkpoint name', { name: 'cp', run: (c) => this.applyCheckpoint(c.args['cp']!) })] }),
        kw('auto', 'Automatic rollback unless confirmed', {
          children: [
            prm(int(1, 60, '<1-60>'), 'Minutes before rollback', {
              name: 'min',
              run: (c) => {
                const cx = R.cxData(d)
                const ms = Number(c.args['min']) * 60_000
                cx.auto = { snap: snapshot(d), until: now(d) + ms }
                armAuto(d, ms)
                this.setMode('config')
                return ''
              }
            }),
            kw('confirm', 'Confirm the configuration changes', {
              run: () => {
                const cx = R.cxData(d)
                if (!cx.auto) return 'No auto checkpoint is in progress.' // [unverified, from memory]
                runtime(d).cancel(AUTO_TIMER)
                cx.auto = undefined
                this.makeCheckpoint(cpName(now(d)), 'System')
                return ''
              }
            })
          ]
        })
      ]
    })
    add(exec, 'configure terminal', 'Enter configuration mode', () => (this.setMode('config'), ''), {}, { configure: 'Enter configuration mode' })
    exec.find((n) => n.word === 'configure')!.priority = true
    add(exec, 'page', 'Enable paging', () => ((this.s.pageLength = Math.max(1, this.s.rows - 1)), ''))
    add(exec, 'no page', 'Disable paging', () => ((this.s.pageLength = 0), ''), {}, { no: 'Negate a command or set its defaults' })
    add(exec, 'clear interface statistics', 'Clear interface statistics', () => '', {}, { clear: 'Clear commands', interface: 'Interface' })
    add(exec, 'ping', 'Send IPv4 ping', undefined, { children: [prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'IPv4 address', { name: 'ip', run: (c) => this.ping(c.args['ip']!) })] })
    for (const w of ['exit', 'end']) add(exec, w, w === 'exit' ? 'Exit current mode' : 'End current mode', () => (w === 'exit' ? this.s.close() : undefined, ''))
    exec.sort((a, b) => a.word!.localeCompare(b.word!))
    return { exec, user: exec, ...this.configTrees() }
  }

  private makeCheckpoint(name: string, writer: 'User' | 'System' = 'User'): string {
    const cx = R.cxData(this.d)
    const snap = snapshot(this.d)
    cx.checkpoints = cx.checkpoints.filter((c) => c.name !== name)
    for (const c of cx.checkpoints) if (c.type === 'latest' && writer === 'System') c.type = 'checkpoint'
    cx.checkpoints.push({ name, type: writer === 'System' ? 'latest' : 'checkpoint', writer, t: now(this.d), snap })
    return writer === 'User' ? 'Success' : ''
  }

  private applyCheckpoint(name: string): string {
    const cp = R.cxData(this.d).checkpoints.find((c) => c.name === name)!
    restore(this.d, cp.snap)
    this.changed()
    return 'Success'
  }

  private showCheckpoints(): string {
    const cps = [...R.cxData(this.d).checkpoints].sort((a, b) => a.t - b.t)
    const iso = (t: number): string => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z')
    return ['NAME                              TYPE         WRITER  DATE(YYYY/MM/DD)       IMAGE VERSION', ...cps.map((c) => `${c.name.padEnd(34)}${c.type.padEnd(13)}${c.writer.padEnd(8)}${iso(c.t).padEnd(23)}${this.d.version}`)].join('\n')
  }

  private runSection(ifName?: string): string {
    const d = this.d
    if (!ifName) return R.runningConfig(d)
    const i = findCxIf(d, ifName)!
    const head = i.name.startsWith('vlan') ? `interface vlan ${i.name.slice(4)}` : i.name.startsWith('loopback') ? `interface loopback ${i.name.slice(8)}` : i.name.startsWith('lag') ? `interface lag ${i.name.slice(3)}` : `interface ${i.name}`
    const body = R.configBody(d)
    const k = body.indexOf(head)
    if (k < 0) return ''
    const out = [head]
    for (let j = k + 1; j < body.length && body[j]!.startsWith('    '); j++) out.push(body[j]!)
    return out.join('\n')
  }

  private async ping(ip: string): Promise<string> {
    const ok = reachable(this.d, ip)
    await this.s.print(`PING ${ip} (${ip}) 100(128) bytes of data.`)
    let got = 0
    for (let k = 1; k <= 5; k++) {
      if (!(await this.s.sleep(ok ? 30 : 1000))) break
      if (ok) {
        got++
        await this.s.print(`108 bytes from ${ip}: icmp_seq=${k} ttl=64 time=0.${400 + k * 17} ms`, { noMore: true })
      }
    }
    return `\n--- ${ip} ping statistics ---\n5 packets transmitted, ${got} received, ${(100 - got * 20).toFixed(0)}% packet loss, time 4005ms${got ? '\nrtt min/avg/max/mdev = 0.417/0.468/0.502/0.031 ms' : ''}`
  }

  // ------------------------------------------------------------------ config

  private configTrees(): Record<string, Node[]> {
    const d = this.d
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number, label = `<${min}-${max}>`): Param => ({ kind: 'int', label, min, max })
    const pfx: Param = { kind: 'word', label: 'A.B.C.D/M', test: (t) => /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(t) && Number(t.split('/')[1]) <= 32 }
    const ipP: Param = { kind: 'ipv4', label: 'A.B.C.D' }
    const ch = (): string => this.changed()
    const doNode = kw('do', 'Run an exec command from configuration mode', {
      children: [
        prm(line, 'Command', {
          name: 'cmd',
          run: async (c) => {
            const m = match(c.args['cmd']!, this.tree('exec'))
            if (!m.ok) return this.error(c.args['cmd']!, m)
            return (await m.node.run!(m.ctx)) ?? ''
          }
        })
      ]
    })
    const common = (): Node[] => [kw('end', 'End current mode and change to enable mode', { run: () => (this.endConfig(), '') }), kw('exit', 'Exit current mode and change to previous mode', { run: () => (this.exitMode(), '') }), doNode]

    const enterIf = (name: string, create?: () => Iface | undefined): string => {
      let i = findCxIf(d, name) ?? create?.()
      if (!i) return `Invalid input: ${name}`
      const id = i.name.startsWith('vlan') ? 'config-if-vlan' : i.name.startsWith('loopback') ? 'config-loopback-if' : i.name === 'mgmt' ? 'config-if-mgmt' : i.name.startsWith('lag') ? 'config-lag-if' : 'config-if'
      this.setMode(id, i.name)
      return ''
    }
    const newL3 = (name: string): Iface => {
      const i: Iface = { name, short: name, adminUp: !name.startsWith('vlan'), linkUp: true, mode: 'routed', speed: '', mac: '' }
      d.interfaces.push(i)
      ch()
      return i
    }
    const g: Node[] = [
      kw('hostname', 'Configure the system hostname', { children: [prm({ kind: 'word', label: 'HOSTNAME', test: (t) => /^[A-Za-z][\w-]{0,31}$/.test(t) }, 'Hostname', { name: 'h', run: (c) => ((d.hostname = c.args['h']!), ch()) })] }),
      kw('vlan', 'VLAN configuration', {
        children: [
          prm({ kind: 'vlanlist', label: 'VLAN-ID' }, 'VLAN identifier or range', {
            name: 'v',
            run: (c) => {
              const ids = expandVlans(c.args['v']!)
              if (!ids.length || ids.some((v) => v < 1 || v > 4094)) return `Invalid input: ${c.args['v']}`
              for (const id of ids) if (!d.vlans.some((v) => v.id === id)) d.vlans.push({ id, name: `VLAN${id}` })
              d.vlans.sort((a, b) => a.id - b.id)
              ch()
              if (ids.length === 1) this.setMode(`config-vlan-${ids[0]}`, ids[0])
              return ''
            }
          })
        ]
      }),
      kw('interface', 'Enter the interface configuration mode', {
        children: [
          prm({ kind: 'word', label: 'IFNAME', values: () => d.interfaces.filter((i) => /^\d/.test(i.name) || i.name === 'mgmt').map((i) => i.name), test: (t) => !!findCxIf(d, t) && !/^(vlan|loopback|lag)\d/.test(t) }, 'Port identifier', { name: 'if', run: (c) => enterIf(c.args['if']!) }),
          kw('vlan', 'VLAN interface', { children: [prm(int(1, 4094, 'VLAN-ID'), 'VLAN identifier', { name: 'n', run: (c) => enterIf(`vlan${c.args['n']}`, () => (d.vlans.some((v) => v.id === Number(c.args['n'])) ? newL3(`vlan${c.args['n']}`) : undefined)) })] }),
          kw('loopback', 'Loopback interface', { children: [prm(int(0, 255, 'INSTANCE'), 'Loopback instance', { name: 'n', run: (c) => enterIf(`loopback${c.args['n']}`, () => newL3(`loopback${c.args['n']}`)) })] }),
          kw('lag', 'Link aggregation group', { children: [prm(int(1, 256, 'LAG-ID'), 'LAG identifier', { name: 'n', run: (c) => enterIf(`lag${c.args['n']}`, () => ({ ...newL3(`lag${c.args['n']}`), mode: 'trunk' }) as Iface) })] })
        ]
      }),
      kw('ip', 'IP configuration', {
        children: [
          kw('route', 'Configure a static route', {
            children: [
              prm(pfx, 'Destination prefix', {
                name: 'p',
                children: [
                  prm(ipP, 'Next hop', {
                    name: 'nh',
                    run: (c) => {
                      const [net, len] = c.args['p']!.split('/')
                      if (!d.staticRoutes.some((r) => r.prefix === net && r.mask === Number(len) && r.nextHop === c.args['nh'] && !r.vrf)) d.staticRoutes.push({ prefix: net!, mask: Number(len), nextHop: c.args['nh']! })
                      return ch()
                    }
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('router', 'Routing protocol configuration', {
        children: [
          kw('ospf', 'OSPF configuration', {
            children: [
              prm(int(1, 63, 'PROCESS-ID'), 'OSPF process ID', {
                name: 'p',
                run: (c) => {
                  d.ospf ??= { process: c.args['p']!, ifaces: [], neighbors: [] }
                  this.setMode(`config-ospf-${d.ospf.process}`)
                  return ''
                }
              })
            ]
          })
        ]
      }),
      kw('banner', 'Configure banners', { children: [kw('motd', 'Message of the day', { children: [prm(line, 'Banner text', { name: 't', run: (c) => ((d.motd = c.args['t']), ch()) })] })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('vlan', 'VLAN configuration', {
            children: [
              prm({ kind: 'vlanlist', label: 'VLAN-ID' }, 'VLAN identifier or range', {
                name: 'v',
                run: (c) => {
                  const ids = expandVlans(c.args['v']!)
                  if (ids.includes(1)) return 'The default VLAN cannot be deleted.' // [unverified, from memory]
                  d.vlans = d.vlans.filter((v) => !ids.includes(v.id))
                  return ch()
                }
              })
            ]
          }),
          kw('ip', 'IP configuration', { children: [kw('route', 'Static route', { children: [prm(pfx, 'Destination prefix', { name: 'p', children: [prm(ipP, 'Next hop', { name: 'nh', run: (c) => { const [net, len] = c.args['p']!.split('/'); d.staticRoutes = d.staticRoutes.filter((r) => !(r.prefix === net && r.mask === Number(len) && r.nextHop === c.args['nh'] && !r.vrf)); return ch() } })] })] })] }),
          kw('banner', 'Configure banners', { children: [kw('motd', 'Message of the day', { run: () => ((d.motd = undefined), ch()) })] }),
          kw('page', 'Disable paging', { run: () => ((this.s.pageLength = 0), '') })
        ]
      }),
      ...['ntp', 'logging', 'snmp-server', 'ssh', 'user', 'aaa', 'radius-server', 'spanning-tree', 'lldp', 'https-server', 'clock'].map((w) => kw(w, `Configure ${w}`, { children: [prm(line, 'Parameters', { name: 'rest', run: (c) => { const l = `${w} ${c.args['rest']}`; if (!d.extraConfig.includes(l)) d.extraConfig.push(l); return ch() } })] })),
      ...common()
    ]

    // ---- vlan
    const VL = (): { id: number; name: string; shutdown?: boolean } | undefined => d.vlans.find((v) => `config-vlan-${v.id}` === this.mode.id)
    const vl: Node[] = [
      kw('name', 'VLAN name', { children: [prm({ kind: 'word', label: 'VLAN-NAME' }, 'VLAN name (up to 32 characters)', { name: 'n', run: (c) => { const v = VL(); if (v) v.name = c.args['n']!; return ch() } })] }),
      kw('description', 'VLAN description', { children: [prm(line, 'Description', { run: () => ch() })] }),
      kw('shutdown', 'Disable the VLAN', { run: () => { const v = VL(); if (v) v.shutdown = true; return ch() } }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('shutdown', 'Enable the VLAN', { run: () => { const v = VL(); if (v) v.shutdown = undefined; return ch() } }), kw('name', 'Reset the VLAN name', { run: () => { const v = VL(); if (v) v.name = `VLAN${v.id}`; return ch() } })] }),
      ...common()
    ]

    // ---- interfaces
    const IF = (): Iface | undefined => d.interfaces.find((i) => i.name === this.mode.ctx)
    const onIf = (f: (i: Iface, c: Ctx) => string | void) => (c: Ctx): string => {
      const i = IF()
      if (!i) return ''
      const r = f(i, c)
      ch()
      return r ?? ''
    }
    const shut = (down: boolean) =>
      onIf((i) => {
        if (i.adminUp === !down) return
        i.adminUp = !down
        i.lastChange = now(d)
        logEvent(d, `intfd[713]: Event|403|LOG_INFO|AMM|1/1|Link status for interface ${i.name} is ${down || !i.linkUp ? 'down' : 'up'}`) // [unverified, from memory]
      })
    const portOnly = (i: Iface): string | undefined => (/^\d/.test(i.name) || i.name.startsWith('lag') ? undefined : 'This command is not applicable to this interface.') // [unverified, from memory]
    const ospfIf = (i: Iface, c: Ctx): void => {
      if (!d.ospf) d.ospf = { process: c.args['p']!, ifaces: [], neighbors: [] }
      const o = d.ospf.ifaces.find((x) => x.iface === i.name)
      if (o) o.area = c.args['a']!
      else d.ospf.ifaces.push({ iface: i.name, area: c.args['a']! })
    }
    const l3: Node[] = [
      kw('shutdown', 'Disable the interface', { run: shut(true) }),
      kw('description', 'Interface description', { children: [prm(line, 'Description (up to 64 characters)', { name: 'desc', run: onIf((i, c) => void (i.description = c.args['desc'])) })] }),
      kw('mtu', 'Interface MTU', { children: [prm(int(46, 9198, 'MTU'), 'MTU in bytes', { name: 'mtu', run: onIf((i, c) => void (i.mtu = Number(c.args['mtu']) === 1500 ? undefined : Number(c.args['mtu']))) })] }),
      kw('ip', 'IP configuration', {
        children: [
          kw('address', 'Set the IPv4 address', {
            children: [
              prm(pfx, 'IPv4 address and prefix length', {
                name: 'p',
                run: onIf((i, c) => {
                  if (/^\d/.test(i.name) && i.mode !== 'routed') return 'Routing must be enabled on the interface first.' // [unverified, from memory]
                  const [ip, len] = c.args['p']!.split('/')
                  i.ip = ip
                  i.mask = Number(len)
                })
              })
            ]
          }),
          kw('ospf', 'OSPF configuration', { children: [prm(int(1, 63, 'PROCESS-ID'), 'OSPF process', { name: 'p', children: [kw('area', 'OSPF area', { children: [prm({ kind: 'word', label: 'AREA-ID' }, 'Area ID', { name: 'a', run: onIf((i, c) => ospfIf(i, c)) })] })] })] })
        ]
      }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('shutdown', 'Enable the interface', { run: shut(false) }),
          kw('description', 'Remove the description', { run: onIf((i) => void (i.description = undefined)) }),
          kw('mtu', 'Reset the MTU', { run: onIf((i) => void (i.mtu = undefined)) }),
          kw('ip', 'IP configuration', {
            children: [
              kw('address', 'Remove the IPv4 address', { run: onIf((i) => void ((i.ip = undefined), (i.mask = undefined))) }),
              kw('ospf', 'Disable OSPF on the interface', { run: onIf((i) => { if (d.ospf) d.ospf.ifaces = d.ospf.ifaces.filter((x) => x.iface !== i.name) }) })
            ]
          }),
          kw('routing', 'Disable routing (layer 2 port)', { run: onIf((i) => portOnly(i) ?? void ((i.mode = 'access'), (i.vlan = i.vlan ?? 1), (i.ip = undefined), (i.mask = undefined))) }),
          kw('vlan', 'VLAN configuration', {
            children: [
              kw('access', 'Reset the access VLAN', { run: onIf((i) => portOnly(i) ?? void (i.vlan = 1)) }),
              kw('trunk', 'Trunk configuration', { children: [kw('allowed', 'Remove allowed VLANs', { children: [prm({ kind: 'vlanlist', label: 'VLAN-LIST' }, 'VLANs to remove', { name: 'v', run: onIf((i, c) => portOnly(i) ?? void (i.trunkAllowed = (i.trunkAllowed ?? d.vlans.map((v) => v.id)).filter((v) => !expandVlans(c.args['v']!).includes(v)))) })], run: onIf((i) => portOnly(i) ?? void (i.trunkAllowed = undefined)) }), kw('native', 'Reset the native VLAN', { run: onIf((i) => void (i.nativeVlan = 1)) })] })
            ]
          })
        ]
      }),
      ...common()
    ]
    const port: Node[] = [
      ...l3,
      kw('routing', 'Enable routing (layer 3 port)', { run: onIf((i) => portOnly(i) ?? void ((i.mode = 'routed'), (i.vlan = undefined))) }),
      kw('vlan', 'VLAN configuration', {
        children: [
          kw('access', 'Access VLAN', {
            children: [
              prm(int(1, 4094, 'VLAN-ID'), 'VLAN identifier', {
                name: 'v',
                run: onIf((i, c) => {
                  const v = Number(c.args['v'])
                  if (!d.vlans.some((x) => x.id === v)) return `VLAN ${v} does not exist.` // [unverified, from memory]
                  if (i.mode === 'routed') return 'Interface is a routed port. Use "no routing" first.' // [unverified, from memory]
                  i.mode = 'access'
                  i.vlan = v
                })
              })
            ]
          }),
          kw('trunk', 'Trunk configuration', {
            children: [
              kw('native', 'Native VLAN', { children: [prm(int(1, 4094, 'VLAN-ID'), 'VLAN identifier', { name: 'v', run: onIf((i, c) => void ((i.mode = 'trunk'), (i.vlan = undefined), (i.nativeVlan = Number(c.args['v'])))) })] }),
              kw('allowed', 'Allowed VLANs', {
                children: [
                  kw('all', 'Allow all VLANs', { run: onIf((i) => void ((i.mode = 'trunk'), (i.vlan = undefined), (i.trunkAllowed = undefined))) }),
                  prm({ kind: 'vlanlist', label: 'VLAN-LIST' }, 'VLANs to add', {
                    name: 'v',
                    run: onIf((i, c) => {
                      const add = expandVlans(c.args['v']!)
                      const was = i.mode === 'trunk' ? (i.trunkAllowed ?? []) : []
                      i.mode = 'trunk'
                      i.vlan = undefined
                      i.trunkAllowed = [...new Set([...was, ...add])].sort((a, b) => a - b)
                    })
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('speed', 'Configure speed', { children: [prm({ kind: 'enum', label: 'auto', values: () => ['auto', '10-full', '100-full', '1000-full'] }, 'Speed', { name: 's', run: onIf((i, c) => void (i.speedSet = c.args['s'])) })] })
    ]
    const ospf: Node[] = [
      kw('router-id', 'OSPF router ID', { children: [prm(ipP, 'Router ID', { name: 'id', run: (c) => ((d.ospf!.routerId = c.args['id']), ch()) })] }),
      kw('area', 'OSPF area', { children: [prm({ kind: 'word', label: 'AREA-ID' }, 'Area ID', { run: () => ch() })] }),
      ...common()
    ]
    for (const t of [g, vl, l3, port, ospf]) t.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return { config: g, 'config-vlan': vl, 'config-ospf': ospf, 'config-if': port, 'config-lag-if': port, 'config-if-vlan': l3, 'config-loopback-if': l3, 'config-if-mgmt': l3 }
  }
}

export const aoscxFactory = (s: Session): AoscxPersonality => new AoscxPersonality(s)
