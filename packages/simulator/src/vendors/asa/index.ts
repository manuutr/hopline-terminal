/**
 * Cisco ASA 9.x personality. Immediate-apply config like IOS, but with the ASA prompt (trailing
 * space), `ERROR: %` error prefix, the `<--- More --->` pager (`terminal pager 0`), nameif /
 * security-level interfaces, ACLs with hit counts, and packet-tracer evaluated live against the
 * modelled interfaces, routes and ACLs.
 *
 * No research doc exists for the ASA: strings are `[unverified, from memory]` unless obvious.
 */
import type { PagerSpec, Session } from '../../core/personality.ts'
import { now } from '../../core/runtime.ts'
import { findIface, parseIfName, type IfType } from '../../core/ifname.ts'
import { add, dottedToLen, isIpv4, kw, prm, type Ctx, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { CiscoBase, ciscoHelpList, type CMode, type Failure, type PipeOutcome } from '../cisco/base.ts'
import { reachable } from '../ios/index.ts'
import { logEvent, tickBgp, type Iface } from '../../state.ts'
import { applyPipes } from '../iosxr/pipes.ts'
import * as R from './render.ts'

export const ASA_TYPES: IfType[] = [
  { full: 'GigabitEthernet', short: 'Gi' },
  { full: 'TenGigabitEthernet', short: 'Te' },
  { full: 'Management', short: 'Ma' },
  { full: 'Port-channel', short: 'Po' },
  { full: 'Redundant', short: 'Re' }
]

/** `<--- More --->`: Space next page, Enter next line, q quits; other keys are ignored. [unverified, from memory] */
export const ASA_PAGER: PagerSpec = {
  text: () => '<--- More --->',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'ignore'
}

const HELP: Record<string, string> = {
  show: 'Show running system information',
  interface: 'Show interface status and configuration',
  conn: 'Show connection information',
  xlate: 'Show current translation information',
  terminal: 'Set terminal line parameters',
  'terminal pager': 'Control page length for pagination',
  processes: 'Show processes',
  cpu: 'Show CPU utilization',
  write: 'Write config to memory, network, or terminal',
  clear: 'Reset functions'
}

export class AsaPersonality extends CiscoBase {
  pager = ASA_PAGER
  protected override execFromConfig: 'do' | 'inherit' = 'inherit'
  private trees: Record<string, Node[]> | undefined

  constructor(s: Session) {
    super(s)
    if (this.d.vendor['loginPrivilege'] === 1) this.privileged = false
  }

  override banner(): string {
    return this.d.motd !== undefined ? `${this.d.motd}\n` : ''
  }

  override promptText(): string {
    return `${super.promptText()} `
  }

  protected suffix(m: CMode): string {
    return m.id === 'exec' ? '' : `(${m.id})`
  }

  protected errInvalid(_line: string, f: Failure): string {
    return `${this.caret(f.offset)}\nERROR: % Invalid input detected at '^' marker.`
  }
  protected errAmbiguous(line: string): string {
    return `ERROR: % Ambiguous command:  "${line.trim()}"`
  }
  protected errIncomplete(): string {
    return 'ERROR: % Incomplete command'
  }
  protected helpPartial(words: string[]): string {
    return words.length ? `${words.join(' ')}\n` : 'ERROR: % Unrecognized command\n'
  }
  protected helpList(h: Extract<HelpResult, { ok: true }>): string {
    if (!h.entries.length && !h.cr) return 'ERROR: % Unrecognized command\n'
    return ciscoHelpList(h, { cr: '' }) + '\n'
  }
  protected override pipeHelp(): string {
    return ['  append    Append redirected output to URL (URLs supporting append operation', '            only)', '  begin     Begin with the line that matches', '  exclude   Exclude lines that match', '  grep      Include/exclude lines that match', '  include   Include lines that match', '  redirect  Redirect output to URL', ''].join('\n')
  }
  protected pipes(out: string, pipes: string[], raw: string): PipeOutcome | { error: string } {
    return applyPipes(out, pipes, raw, ['append', 'begin', 'exclude', 'grep', 'include', 'redirect'], {
      invalid: (at) => `${this.caret(at)}\nERROR: % Invalid input detected at '^' marker.`,
      ambiguous: () => `ERROR: % Ambiguous command:  "${raw.trim()}"`,
      incomplete: () => 'ERROR: % Incomplete command'
    })
  }

  // ------------------------------------------------------------------ trees

  protected tree(modeId: string): Node[] {
    this.trees ??= this.build()
    return this.trees[modeId] ?? this.trees['config']!
  }

  private changed(): string {
    R.asaData(this.d).lastChange = { t: now(this.d), by: this.s.user }
    tickBgp(this.d)
    return ''
  }

  private ifParam(exists = true): Param {
    const d = this.d
    return {
      kind: 'iface',
      label: 'WORD',
      values: () => d.interfaces.map((i) => i.name),
      test: (t) => (exists ? !!findIface(d, t, ASA_TYPES) : (() => { const r = parseIfName(t, ASA_TYPES); return !!r && r !== 'ambiguous' })())
    }
  }

  private build(): Record<string, Node[]> {
    const d = this.d
    const exec: Node[] = []
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const nameifP: Param = { kind: 'word', label: 'WORD', values: () => d.interfaces.filter((i) => i.zone).map((i) => i.zone!), test: (t) => !!R.byNameif(d, t) }
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(exec, `show ${path}`, help, run, extra, HELP)
    const ifOf = (c: Ctx): Iface | undefined => findIface(d, c.args['if'] ?? '', ASA_TYPES)

    add(exec, 'show', 'Show running system information', undefined, { priority: true })
    S('version', 'Display the system software version', () => R.showVersion(d))
    const runSec = (c: Ctx): string => this.runSection(c.args['sec'])
    S('running-config', 'Show the current operating configuration', runSec, { children: [prm(line, 'Configuration section', { name: 'sec', run: runSec })] })
    S('startup-config', 'Show the startup configuration', () => {
      const st = R.asaData(d).startup
      return st === undefined ? R.runningConfig(d) : R.runningConfig(d, st.split('\n'))
    })
    S('interface', 'Show interface status and configuration', () => d.interfaces.map((i) => R.showInterface(d, i)).join('\n'), { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.showInterface(d, ifOf(c)!) })] })
    S('interface ip brief', 'Show interface IP address, method and status', () => R.showIntIpBrief(d))
    S('nameif', 'Show interface name and security level', () => R.showNameif(d))
    S('conn count', 'Display the number of connections', () => `${R.asaData(d).conn.inUse} in use, ${R.asaData(d).conn.most} most used`)
    S('conn', 'Show connection information', () => `${R.asaData(d).conn.inUse} in use, ${R.asaData(d).conn.most} most used`)
    S('xlate count', 'Display the number of translations', () => `${R.asaData(d).xlate.inUse} in use, ${R.asaData(d).xlate.most} most used`)
    S('route', 'Show the routing table', () => R.showRoute(d))
    S('access-list', 'Show hit counters for access policies', () => R.showAccessList(d), { children: [prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name), test: (t) => d.acls.some((a) => a.name === t) }, 'Access-list name', { name: 'acl', run: (c) => R.showAccessList(d, c.args['acl']) })] })
    S('arp', 'Show the ARP table', () => R.showArp(d))
    S('cpu usage', 'Show CPU usage', () => R.showCpuUsage(d))
    S('cpu', 'Show CPU utilization', () => R.showCpuUsage(d))
    const procRun = (c: Ctx): string => R.showProcessesCpu(d, c.words.includes('non-zero'))
    S('processes cpu-usage', 'Show CPU usage by process', procRun, { children: [kw('sorted', 'Sort by CPU usage', { run: procRun, children: [kw('non-zero', 'Show only non-zero entries', { run: procRun })] }), kw('non-zero', 'Show only non-zero entries', { run: procRun })] })
    S('clock', 'Show the system clock', () => R.asaClock(now(d)))
    S('logging', 'Show logging configuration and buffer', () => R.showLogging(d))
    S('failover', 'Show failover status', () => 'Failover Off\nFailover unit Primary\nFailover LAN Interface: not Configured\nReconnect timeout 0:00:00\nPoll frequency 1 seconds, holdtime 15 seconds\nInterface Poll frequency 5 seconds, holdtime 25 seconds\nInterface Policy 1\nMonitored Interfaces 0 of 1291 maximum')
    S('terminal', 'Show terminal settings', () => `Width = 80, ${this.s.pageLength ? `${this.s.pageLength} lines` : 'no pager'}, History buffer = 20`)
    S('curpriv', 'Display current privilege level', () => `Username : ${this.s.user}\nCurrent privilege level : ${this.privileged ? 15 : 1}\nCurrent Mode/s : ${this.privileged ? 'P_PRIV' : 'P_UNPR'}`)

    // ---- packet-tracer
    const trace = (c: Ctx): string => {
      const proto = c.args['proto'] as 'tcp' | 'udp' | 'icmp'
      const f = proto === 'icmp' ? { proto, src: c.args['src']!, sport: Number(c.args['type']), dst: c.args['dst']!, dport: Number(c.args['code']) } : { proto, src: c.args['src']!, sport: Number(c.args['sport']), dst: c.args['dst']!, dport: portOf(c.args['dport']!) }
      return R.packetTracer(d, c.args['in']!, f).text
    }
    const ipP = (name: string, help: string, children: Node[]): Node => prm({ kind: 'ipv4', label: 'A.B.C.D' }, help, { name, children })
    const portP = (name: string, help: string, children: Node[] = [], run?: Node['run']): Node => prm({ kind: 'word', label: '<0-65535>', test: (t) => portOf(t) >= 0 }, help, { name, children, ...(run ? { run } : {}) })
    const opts = (): Node[] => [kw('detailed', 'Dump more detailed information', { run: trace }), kw('xml', 'Output in xml format', { run: trace })]
    const l4 = ['tcp', 'udp'].map((p) => kw(p, `Enter ${p.toUpperCase()} parameters`, { name: 'proto', children: [ipP('src', 'Source IP address', [portP('sport', 'Source port', [ipP('dst', 'Destination IP address', [portP('dport', 'Destination port', opts(), trace)])])])] }))
    const icmp = kw('icmp', 'Enter ICMP parameters', { name: 'proto', children: [ipP('src', 'Source IP address', [prm(int(0, 255), 'ICMP type', { name: 'type', children: [prm(int(0, 255), 'ICMP code', { name: 'code', children: [prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'Destination IP address', { name: 'dst', run: trace, children: opts() })] })] })])] })
    add(exec, 'packet-tracer', 'Trace packets in the security appliance', undefined, { children: [kw('input', 'Input interface', { children: [prm(nameifP, "Input interface's name", { name: 'in', children: [...l4, icmp] })] })] })

    // ---- actions
    const save = (): string => {
      const st = R.asaData(d)
      const body = R.configLines(d)
      st.startup = body.join('\n')
      const sum = R.runningConfig(d, body).split('\n').find((l) => l.startsWith('Cryptochecksum:'))!.slice(15)
      logEvent(d, `%ASA-5-111008: User '${this.s.user}' executed the 'write memory' command.`)
      return `Building configuration...\nCryptochecksum: ${sum.match(/.{8}/g)!.join(' ')} \n\n${st.startup.length + 300} bytes copied in 0.450 secs\n[OK]`
    }
    add(exec, 'write', 'Write config to memory, network, or terminal', () => save(), { priority: true })
    add(exec, 'write memory', 'Write configuration to the memory', () => save())
    add(exec, 'write terminal', 'Write configuration to the terminal', () => R.runningConfig(d))
    const copyRun = async (): Promise<string> => {
      await this.s.ask('\nSource filename [running-config]? ', { mode: 'line' })
      await this.s.ask('Destination filename [startup-config]? ', { mode: 'line' })
      return save().replace(/^Building configuration...\n/, '').replace(/\n\[OK\]$/, '')
    }
    add(exec, 'copy', 'Copy from one file to another', undefined, {
      children: [prm({ kind: 'word', label: 'WORD', values: () => ['running-config', 'startup-config'] }, 'Source', { name: 'src', children: [prm({ kind: 'word', label: 'WORD', values: () => ['running-config', 'startup-config'] }, 'Destination', { name: 'dst', run: (c) => (/^run/.test(c.args['src']!) && /^start/.test(c.args['dst']!) ? copyRun() : `%Error opening ${c.args['dst']} (No such file or directory)`) })] })]
    })
    add(exec, 'configure terminal', 'Configure using terminal/console', () => (this.setMode('config'), ''), {}, { configure: 'Configure from the terminal' })
    exec.find((n) => n.word === 'configure')!.priority = true
    const pagerRun = (c: Ctx): string => ((this.s.pageLength = Number(c.args['n'])), '')
    add(exec, 'terminal pager', 'Control page length for pagination', undefined, { children: [prm(int(0, 2147483647), 'Number of lines (0 means no pagination)', { name: 'n', run: pagerRun }), kw('lines', 'Number of lines', { children: [prm(int(0, 2147483647), 'Number of lines (0 means no pagination)', { name: 'n', run: pagerRun })] })] }, HELP)
    add(exec, 'terminal width', 'Set terminal width', undefined, { children: [prm(int(0, 511), 'Width', { run: () => '' })] }, HELP)
    add(exec, 'terminal monitor', 'Syslog monitoring', () => '', {}, HELP)
    add(exec, 'clear access-list', 'Clear access list', undefined, {
      children: [
        kw('counters', 'Clear access list counters', { run: () => { for (const a of d.acls) for (const e of a.entries) e.hits = 0; return '' } }),
        prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access-list name', { name: 'acl', children: [kw('counters', 'Clear access list counters', { run: (c) => { for (const e of d.acls.find((a) => a.name === c.args['acl'])?.entries ?? []) e.hits = 0; return '' } })] })
      ]
    }, HELP)
    add(exec, 'ping', 'Send echo messages', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD' }, 'Destination address or hostname', { name: 'target', run: (c) => this.ping(c.args['target']!) }),
        prm(nameifP, "Source interface's name", { name: 'src', children: [prm({ kind: 'word', label: 'WORD' }, 'Destination address', { name: 'target', run: (c) => this.ping(c.args['target']!) })] })
      ]
    })
    add(exec, 'disable', 'Exit from privileged mode', () => ((this.privileged = false), ''))
    for (const w of ['exit', 'logout', 'quit']) add(exec, w, 'Exit from the EXEC', () => (this.s.close(), ''))
    exec.sort((a, b) => a.word!.localeCompare(b.word!))

    const user: Node[] = exec.filter((n) => ['exit', 'logout', 'quit', 'ping', 'terminal'].includes(n.word!))
    user.push(
      kw('enable', 'Turn on privileged commands', {
        run: async () => {
          const pw = await this.s.ask('Password: ', { mode: 'line', echo: false })
          if (pw === this.s.password) this.privileged = true
          else return 'Invalid password'
          return ''
        }
      }),
      kw('show', 'Show running system information', { priority: true, children: exec.find((n) => n.word === 'show')!.children!.filter((c) => ['version', 'clock', 'curpriv', 'terminal'].includes(c.word!)) })
    )
    user.sort((a, b) => a.word!.localeCompare(b.word!))
    return { exec, user, ...this.configTrees() }
  }

  /** `show running-config [keyword...]`: lines starting with the words, plus their sub-lines. */
  private runSection(sec?: string): string {
    const d = this.d
    const body = R.configLines(d)
    if (!sec) return R.runningConfig(d, body)
    let want = sec.trim().replace(/\s+/g, ' ')
    const im = /^int\S*\s+(.+)$/i.exec(want)
    if (im) {
      const i = findIface(d, im[1]!, ASA_TYPES)
      if (!i) return ''
      want = `interface ${i.name}`
    } else if (/^int\S*$/i.test(want)) want = 'interface'
    const out: string[] = []
    for (let k = 0; k < body.length; k++) {
      if (!body[k]!.startsWith(want) || /^\s/.test(body[k]!)) continue
      out.push(body[k]!)
      while (k + 1 < body.length && /^\s/.test(body[k + 1]!)) out.push(body[++k]!)
      if (want.startsWith('interface')) out.push('!')
    }
    return out.join('\n')
  }

  private async ping(target: string): Promise<string> {
    if (!isIpv4(target)) return `ERROR: % Invalid Hostname`
    const ok = reachable(this.d, target)
    await this.s.print(`Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`)
    let marks = ''
    for (let k = 0; k < 5; k++) {
      if (!(await this.s.sleep(ok ? 40 : 300))) break
      marks += ok ? '!' : '?'
      this.s.write(ok ? '!' : '?')
    }
    this.s.write('\r\n')
    const got = [...marks].filter((m) => m === '!').length
    return `Success rate is ${marks.length ? Math.floor((got / marks.length) * 100) : 0} percent (${got}/${marks.length})${got ? ', round-trip min/avg/max = 1/1/1 ms' : ''}`
  }

  // ------------------------------------------------------------------ config

  private configTrees(): Record<string, Node[]> {
    const d = this.d
    const line: Param = { kind: 'line', label: 'LINE' }
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const ipP: Param = { kind: 'ipv4', label: 'A.B.C.D' }
    const maskP: Param = { kind: 'mask', label: 'A.B.C.D' }
    const nameifP: Param = { kind: 'word', label: 'WORD', values: () => d.interfaces.filter((i) => i.zone).map((i) => i.zone!) }
    const ch = (): string => this.changed()
    const st = R.asaData(d)
    const end = (): Node[] => [kw('end', 'Exit from configure mode', { run: () => (this.endConfig(), '') }), kw('exit', 'Exit from config mode', { run: () => (this.exitMode(), '') })]

    const aclAdd = (c: Ctx): string => {
      const name = c.args['acl']!
      const rest = c.args['rest'] ?? ''
      const act = c.args['act'] as 'permit' | 'deny' | 'remark'
      if (act !== 'remark' && !/^(ip|tcp|udp|icmp|object|object-group|\d+)\b/.test(rest)) return `${this.caret(c.line.indexOf(rest))}\nERROR: % Invalid input detected at '^' marker.`
      let a = d.acls.find((x) => x.name === name)
      if (!a) d.acls.push((a = { name, type: 'extended', entries: [] }))
      if (act !== 'remark' && a.entries.some((e) => e.action === act && e.text === rest)) return `WARNING: <${name}> found duplicate element`
      const e = { seq: 0, action: act, text: rest }
      const at = c.args['line'] ? Math.min(a.entries.length, Number(c.args['line']) - 1) : a.entries.length
      a.entries.splice(at, 0, e)
      a.entries.forEach((x, k) => (x.seq = k + 1))
      return ch()
    }
    const aclBody = (): Node[] => [
      kw('extended', 'Configure access policy for IP traffic through the system', { children: ['permit', 'deny'].map((w) => kw(w, `Specify ${w === 'permit' ? 'packets to forward' : 'packets to reject'}`, { name: 'act', children: [prm(line, 'Protocol, source, destination', { name: 'rest', run: aclAdd })] })) }),
      kw('remark', 'Specify a comment (remark) for the access-list', { name: 'act', children: [prm(line, 'Comment', { name: 'rest', run: aclAdd })] })
    ]
    const g: Node[] = [
      kw('hostname', "Change host name of the system", { children: [prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z][\w-]{0,62}$/.test(t) }, 'New host name', { name: 'h', run: (c) => ((d.hostname = c.args['h']!), ch()) })] }),
      kw('interface', 'Select an interface to configure', { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => (this.setMode('config-if', findIface(d, c.args['if']!, ASA_TYPES)!.name), '') })] }),
      kw('access-list', 'Configure an access control element', { children: [prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access list identifier', { name: 'acl', children: [...aclBody(), kw('line', 'Use this to specify line number at which ACE should be entered', { children: [prm(int(1, 4294967295), 'Enter line number', { name: 'line', children: aclBody() })] })] })] }),
      kw('access-group', 'Configure an access group', {
        children: [
          prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access list name', {
            name: 'acl',
            children: ['in', 'out'].map((dir) =>
              kw(dir, `Filter ${dir === 'in' ? 'incoming' : 'outgoing'} traffic`, {
                children: [
                  kw('interface', 'Interface', {
                    children: [
                      prm(nameifP, "Name of interface", {
                        name: 'ifn',
                        run: (c) => {
                          if (!d.acls.some((a) => a.name === c.args['acl'])) return `ERROR: access-list <${c.args['acl']}> does not exist`
                          if (!R.byNameif(d, c.args['ifn']!)) return `ERROR: '${c.args['ifn']}' not a valid interface name`
                          st.groups = st.groups.filter((x) => !(x.iface === c.args['ifn'] && x.dir === dir))
                          st.groups.push({ acl: c.args['acl']!, dir: dir as 'in', iface: c.args['ifn']! })
                          return ch()
                        }
                      })
                    ]
                  })
                ]
              })
            )
          })
        ]
      }),
      kw('route', 'Configure a static route for an interface', {
        children: [
          prm(nameifP, "Name of interface", {
            name: 'ifn',
            children: [
              prm(ipP, 'IP destination address', {
                name: 'net',
                children: [
                  prm(maskP, 'Network mask', {
                    name: 'mask',
                    children: [
                      prm(ipP, 'Gateway', {
                        name: 'gw',
                        run: (c) => this.addRoute(c),
                        children: [prm(int(1, 255), 'Distance metric for this route', { name: 'ad', run: (c) => this.addRoute(c) })]
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('mtu', 'Specify MTU for an interface', { children: [prm(nameifP, 'Interface name', { name: 'ifn', children: [prm(int(64, 9198), 'MTU size in bytes', { name: 'mtu', run: (c) => { const i = R.byNameif(d, c.args['ifn']!); if (!i) return `ERROR: Unknown interface ${c.args['ifn']}`; i.mtu = Number(c.args['mtu']) === 1500 ? undefined : Number(c.args['mtu']); return ch() } })] })] }),
      kw('pager', 'Control page length for pagination', { children: [kw('lines', 'Number of lines', { children: [prm(int(0, 2147483647), 'Number of lines', { name: 'n', run: (c) => ((this.s.pageLength = Number(c.args['n'])), '') })] })] }),
      kw('banner', 'Configure login/session banners', { children: [kw('motd', 'Display a message of the day', { children: [prm(line, 'Message of the day text', { name: 't', run: (c) => ((d.motd = d.motd === undefined ? c.args['t']! : `${d.motd}\n${c.args['t']}`), ch()) })] })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('access-list', 'Configure an access control element', {
            children: [
              prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access list identifier', {
                name: 'acl',
                run: (c) => {
                  if (st.groups.some((x) => x.acl === c.args['acl'])) st.groups = st.groups.filter((x) => x.acl !== c.args['acl'])
                  d.acls = d.acls.filter((a) => a.name !== c.args['acl'])
                  return ch()
                },
                children: [
                  kw('extended', 'Configure access policy for IP traffic through the system', {
                    children: ['permit', 'deny'].map((w) =>
                      kw(w, 'action', {
                        children: [
                          prm(line, 'ACE', {
                            name: 'rest',
                            run: (c) => {
                              const a = d.acls.find((x) => x.name === c.args['acl'])
                              const before = a?.entries.length ?? 0
                              if (a) a.entries = a.entries.filter((e) => !(e.action === w && e.text === c.args['rest']))
                              if (!a || a.entries.length === before) return `ERROR: <${c.args['acl']}> specified ACE does not exist` // [unverified, from memory]
                              a.entries.forEach((x, k) => (x.seq = k + 1))
                              return ch()
                            }
                          })
                        ]
                      })
                    )
                  })
                ]
              })
            ]
          }),
          kw('access-group', 'Configure an access group', { children: [prm({ kind: 'word', label: 'WORD' }, 'Access list name', { name: 'acl', children: ['in', 'out'].map((dir) => kw(dir, 'direction', { children: [kw('interface', 'Interface', { children: [prm(nameifP, 'Name of interface', { name: 'ifn', run: (c) => ((st.groups = st.groups.filter((x) => !(x.acl === c.args['acl'] && x.iface === c.args['ifn'] && x.dir === dir))), ch()) })] })] })) })] }),
          kw('route', 'Configure a static route for an interface', { children: [prm(nameifP, 'Name of interface', { name: 'ifn', children: [prm(ipP, 'IP destination address', { name: 'net', children: [prm(maskP, 'Network mask', { name: 'mask', children: [prm(ipP, 'Gateway', { name: 'gw', run: (c) => { const len = dottedToLen(c.args['mask']!)!; d.staticRoutes = d.staticRoutes.filter((r) => !(r.prefix === c.args['net'] && r.mask === len && r.nextHop === c.args['gw'])); return ch() } })] })] })] })] }),
          kw('banner', 'Configure login/session banners', { children: [kw('motd', 'Display a message of the day', { run: () => ((d.motd = undefined), ch()) })] })
        ]
      }),
      ...['logging', 'ntp', 'ssh', 'http', 'object', 'object-group', 'nat', 'dns', 'timeout', 'snmp-server', 'crypto', 'aaa', 'username', 'telnet', 'icmp', 'same-security-traffic', 'domain-name', 'clock', 'names'].map((w) =>
        kw(w, `Configure ${w}`, { children: [prm(line, 'Parameters', { name: 'rest', run: (c) => { const l = `${w} ${c.args['rest']}`; if (!d.extraConfig.includes(l)) d.extraConfig.push(l); return ch() } })] })
      ),
      ...end()
    ]

    // ---- interface
    const IF = (): Iface | undefined => d.interfaces.find((i) => i.name === this.mode.ctx)
    const onIf = (f: (i: Iface, c: Ctx) => string | void) => (c: Ctx): string => {
      const i = IF()
      if (!i) return ''
      const r = f(i, c)
      ch()
      return r ?? ''
    }
    const ifm: Node[] = [
      kw('nameif', 'Assign name to interface', {
        children: [
          prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z][\w.-]{0,47}$/.test(t) }, 'Name of interface', {
            name: 'n',
            run: onIf((i, c) => {
              const n = c.args['n']!
              const other = d.interfaces.find((x) => x !== i && x.zone === n)
              if (other) return `ERROR: Name is already used by ${other.name}` // [unverified, from memory]
              if (i.zone && i.zone !== n) {
                st.levels[n] = st.levels[i.zone] ?? 0
                delete st.levels[i.zone]
                for (const gr of st.groups) if (gr.iface === i.zone) gr.iface = n
                i.zone = n
                return ''
              }
              i.zone = n
              const lvl = n === 'inside' ? 100 : 0
              st.levels[n] = lvl
              return `INFO: Security level for "${n}" set to ${lvl} by default.`
            })
          })
        ]
      }),
      kw('security-level', 'Specify the security level of this interface', { children: [prm(int(0, 100), 'Security level', { name: 'lvl', run: onIf((i, c) => { if (i.zone) st.levels[i.zone] = Number(c.args['lvl']) }) })] }),
      kw('ip', 'Configure the IP address', {
        children: [
          kw('address', 'Configure the IP address', {
            children: [
              prm(ipP, 'IP address', {
                name: 'ip',
                children: [
                  prm(maskP, 'Network mask', {
                    name: 'mask',
                    run: onIf((i, c) => {
                      const len = dottedToLen(c.args['mask']!)!
                      const clash = d.interfaces.find((x) => x !== i && x.ip && x.mask !== undefined && (inSub(c.args['ip']!, x.ip, Math.min(x.mask, len))))
                      if (clash) return `ERROR: This address conflicts with another address on the ${clash.zone ?? clash.name} interface` // [unverified, from memory]
                      i.ip = c.args['ip']
                      i.mask = len
                    }),
                    children: [kw('standby', 'Standby address', { children: [prm(ipP, 'Standby IP address', { run: () => '' })] })]
                  })
                ]
              }),
              kw('dhcp', 'Use DHCP to obtain an IP address', { run: onIf(() => undefined) })
            ]
          })
        ]
      }),
      kw('shutdown', 'Shutdown the selected interface', { run: onIf((i) => this.shut(i, true)) }),
      kw('description', 'Interface specific description', { children: [prm(line, 'Up to 240 characters describing this interface', { name: 'desc', run: onIf((i, c) => void (i.description = c.args['desc'])) })] }),
      kw('speed', 'Configure speed operation', { children: [prm({ kind: 'enum', label: '10', values: () => ['10', '100', '1000', 'auto'] }, 'Speed', { name: 's', run: onIf((i, c) => void (i.speedSet = c.args['s'])) })] }),
      kw('duplex', 'Configure duplex operation', { children: [prm({ kind: 'enum', label: 'auto', values: () => ['auto', 'full', 'half'] }, 'Duplex', { name: 'x', run: onIf((i, c) => void (i.duplex = c.args['x'] as 'full')) })] }),
      kw('management-only', 'Dedicate an interface to management traffic', { run: onIf(() => undefined) }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('shutdown', 'Shutdown the selected interface', { run: onIf((i) => this.shut(i, false)) }),
          kw('nameif', 'Assign name to interface', {
            run: onIf((i) => {
              if (i.zone) {
                st.groups = st.groups.filter((x) => x.iface !== i.zone)
                delete st.levels[i.zone]
              }
              i.zone = undefined
            })
          }),
          kw('ip', 'Configure the IP address', { children: [kw('address', 'Configure the IP address', { run: onIf((i) => void ((i.ip = undefined), (i.mask = undefined))) })] }),
          kw('description', 'Interface specific description', { run: onIf((i) => void (i.description = undefined)) }),
          kw('security-level', 'Specify the security level of this interface', { run: onIf((i) => { if (i.zone) st.levels[i.zone] = 0 }) }),
          kw('speed', 'Configure speed operation', { run: onIf((i) => void (i.speedSet = undefined)) }),
          kw('duplex', 'Configure duplex operation', { run: onIf((i) => void (i.duplex = undefined)) })
        ]
      }),
      ...end()
    ]
    void word
    for (const t of [g, ifm]) t.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return { config: g, 'config-if': ifm }
  }

  private addRoute(c: Ctx): string {
    const d = this.d
    const i = R.byNameif(d, c.args['ifn']!)
    if (!i) return `ERROR: Unknown interface ${c.args['ifn']}` // [unverified, from memory]
    const len = dottedToLen(c.args['mask']!)!
    if (!d.staticRoutes.some((r) => r.prefix === c.args['net'] && r.mask === len && r.nextHop === c.args['gw'])) d.staticRoutes.push({ prefix: c.args['net']!, mask: len, nextHop: c.args['gw']!, ...(c.args['ad'] ? { ad: Number(c.args['ad']) } : {}) })
    return this.changed()
  }

  private shut(i: Iface, down: boolean): string {
    if (i.adminUp === !down) return ''
    i.adminUp = !down
    i.lastChange = now(this.d)
    logEvent(this.d, `%ASA-4-411002: Line protocol on Interface ${i.name}, changed state to ${down || !i.linkUp ? 'down' : 'up'}`)
    if (down) logEvent(this.d, `%ASA-4-411004: Interface ${i.name}, changed state to administratively down`)
    return ''
  }
}

function inSub(ip: string, net: string, len: number): boolean {
  const n = (s: string): number => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
  const m = len === 0 ? 0 : (~0 << (32 - len)) >>> 0
  return ((n(ip) & m) >>> 0) === ((n(net) & m) >>> 0)
}

const SERVICES: Record<string, number> = { ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, www: 80, http: 80, ntp: 123, bgp: 179, https: 443, syslog: 514 }
function portOf(t: string): number {
  if (/^\d+$/.test(t)) return Number(t) <= 65535 ? Number(t) : -1
  return SERVICES[t] ?? -1
}

export const asaFactory = (s: Session): AsaPersonality => new AsaPersonality(s)
