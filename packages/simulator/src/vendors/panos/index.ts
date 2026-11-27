/**
 * Palo Alto PAN-OS personality (docs/research/cli-paloalto-panos.md): `user@host>` operational
 * mode, `configure` with an `[edit ...]` banner line above every `user@host#` prompt, a candidate
 * kept on top of the running config with set/delete/edit/up/top/show, asynchronous `commit` jobs,
 * `validate full`, `run`, marker-column `?` help (`>` / `+` / `*`), full keywords only (no
 * abbreviation), `Unknown command:` / `Invalid syntax.` / `Server error :` errors without a caret,
 * `| match` / `| except` pipes, `set cli pager off` and a `--more--` pager.
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { now } from '../../core/runtime.ts'
import { safeRegex, splitPipes, unifiedDiff, inSubnet } from '../../core/text.ts'
import { acceptParam, add, isIpv4, kw, prm, tokenize, type Ctx, type Handler, type Node, type Param, type ParamKind } from '../../core/tree.ts'
import { isUp, logEvent, type Device } from '../../state.ts'
import { applyDelete, candidateLines, pending, runningLines, setLineText, store, syncDevice, validate, walk, braceView, parseValue, tokenizeConf, unq, type PLine, type SNode, SCHEMA } from './conf.ts'
import * as R from './render.ts'

export const PANOS_PAGER: PagerSpec = {
  text: () => '--more--',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', j: 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'ignore'
}

const INVALID = 'Invalid syntax.'

interface Opt {
  name: string
  help: string
  label: string
  kind?: ParamKind
  values?: () => string[]
  required?: boolean
}

type Strict = { ok: true; node: Node; ctx: Ctx } | { ok: false; kind: 'unknown' | 'invalid' | 'incomplete'; index: number; token: string }

/** Full-keyword matching (PAN-OS does not accept unexpanded prefixes on Enter). */
function strictMatch(line: string, roots: Node[]): Strict {
  const tokens = tokenizeConf(line)
  const ctx: Ctx = { args: {}, params: [], words: [], tokens, line }
  let children = roots
  let node: Node | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const k = children.find((c) => c.word === t)
    let next: Node | undefined = k
    if (!next) next = children.find((c) => c.param && acceptParam(c.param, unq(t)))
    if (!next) return { ok: false, kind: i === 0 ? 'unknown' : 'invalid', index: i, token: t }
    node = next
    if (node.param?.kind === 'line') {
      const value = tokens.slice(i).join(' ')
      ctx.params.push(value)
      if (node.name) ctx.args[node.name] = value
      break
    }
    if (node.param) {
      ctx.params.push(unq(t))
      if (node.name) ctx.args[node.name] = unq(t)
    } else {
      ctx.words.push(node.word!)
      if (node.name) ctx.args[node.name] = node.word!
    }
    children = node.children ?? []
  }
  if (!node || !node.run) return { ok: false, kind: tokens.length ? 'invalid' : 'incomplete', index: tokens.length, token: '' }
  return { ok: true, node, ctx }
}

interface HelpRow {
  mark: string
  label: string
  help: string
}

/** Marker-column help: `> nested`, `+ option`, `* required`, blank for values and <Enter>. */
function formatHelp(rows: HelpRow[]): string {
  if (!rows.length) return ''
  if (rows.length === 1 && rows[0]!.mark === '' && rows[0]!.label.startsWith('<')) return `${rows[0]!.label}  ${rows[0]!.help}\n\n`
  const w = Math.max(...rows.map((r) => r.label.length)) + 3
  return rows.map((r) => `${r.mark || ' '} ${r.label.padEnd(w)}${r.help}`.trimEnd()).join('\n') + '\n\n'
}

export class PanosPersonality implements Personality {
  pager = PANOS_PAGER
  abortKeys = ['\x03']
  private readonly s: Session
  private readonly d: Device
  private conf = false
  private edit: string[] = []
  private format: 'default' | 'set' | 'xml' | 'json' = 'default'
  private confirmPrompt = true
  private marks = new Map<Node, string>()
  private op: Node[]

  constructor(s: Session) {
    this.s = s
    this.d = s.d
    this.op = this.buildOp()
  }

  banner(): string {
    const motd = this.d.motd ? `${this.d.motd}\n\n` : ''
    return `${motd}Last login: ${R.ctime(now(this.d) - 3600_000)} from ${this.s.from}\n\n`
  }

  private host(): string {
    return `${this.s.user}@${this.d.hostname}`
  }

  prompt(reason: PromptReason): string {
    if (!this.conf) return `${this.host()}> `
    return (reason === 'help' ? '' : `[edit${this.edit.length ? ' ' + this.edit.join(' ') : ''}]\n`) + `${this.host()}# `
  }

  // ------------------------------------------------------------------ operational tree

  /** Option-style arguments in any order (`ping count 2 host 1.2.3.4`). */
  private options(opts: Opt[], run: (a: Record<string, string>) => string | void | Promise<string | void>, enterOk = true): Node[] {
    const list: Node[] = []
    const handler: Handler = (c) => {
      if (opts.some((o) => o.required && c.args[o.name] === undefined)) return INVALID
      return run(c.args)
    }
    for (const o of opts) {
      const p: Param = { kind: o.kind ?? 'word', label: o.label, ...(o.values ? { values: o.values } : {}) }
      const n = kw(o.name, o.help, { children: [prm(p, o.help, { name: o.name, run: handler, children: list })] })
      this.marks.set(n, o.required ? '*' : '+')
      list.push(n)
    }
    void enterOk
    return list
  }

  private buildOp(): Node[] {
    const d = this.d
    const op: Node[] = []
    const helps: Record<string, string> = {
      show: 'Show operational information',
      'show system': 'Show system related information',
      'show interface': 'Show interface information',
      'show routing': 'Show routing information',
      'show routing protocol': 'Show routing protocol information',
      'show routing protocol bgp': 'Show BGP information',
      'show routing protocol ospf': 'Show OSPF information',
      'show session': 'Show session information',
      'show counter': 'Show system counter information',
      'show running': 'Show running operational parameters',
      'show jobs': 'Show job information',
      'show high-availability': 'Show high-availability information',
      'show config': 'Show configuration',
      'show log': 'Show logs',
      'show lldp': 'Show LLDP information',
      'show user': 'Show user-id information',
      'show user group': 'Show user groups',
      set: 'Set operational parameters',
      'set cli': 'Set CLI session parameters',
      'set cli terminal': 'Set terminal parameters',
      request: 'Make system-level requests',
      'request restart': 'Restart system or processes',
      'request shutdown': 'Shut down the system',
      'request system': 'System operations',
      'request system software': 'Software operations',
      'request license': 'License operations',
      test: 'Test the configuration',
      'test routing': 'Test routing',
      scp: 'Use ssh to copy file to another host',
      'scp import': 'Import files from another host',
      clear: 'Clear runtime parameters',
      'clear counter': 'Clear counters'
    }
    const S = (path: string, help: string, run?: Handler, extra: Partial<Node> = {}): Node => add(op, path, help, run, extra, helps)
    const ifName = (): Param => ({ kind: 'word', label: '<name>', values: () => d.interfaces.map((i) => i.name) })

    S('show system info', 'Show system information', () => R.systemInfo(d))
    S('show system resources', 'Show system resources', () => R.systemResources(d))
    S('show system disk-space', 'Show disk space', () => 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/root       6.9G  4.1G  2.5G  63% /\n/dev/sda5        16G  5.3G   10G  35% /opt/pancfg\n/dev/sda6       7.9G  2.6G  5.0G  35% /opt/panrepo\n/dev/sda8        49G   11G   36G  24% /opt/panlogs')
    S('show clock', 'Show the system time', () => R.ctime(now(d)).replace(/ (\d{4})$/, ' UTC $1'))
    S('show interface', 'Show interface information', undefined, {
      children: [
        kw('all', 'All interfaces', { run: () => R.interfaceAll(d, 'all') }),
        kw('hardware', 'Hardware interfaces', { run: () => R.interfaceAll(d, 'hardware') }),
        kw('logical', 'Logical interfaces', { run: () => R.interfaceAll(d, 'logical') }),
        kw('management', 'Management interface', { run: () => this.mgmtIf() }),
        prm(ifName(), 'Interface name', {
          name: 'if',
          run: (c) => {
            const i = d.interfaces.find((x) => x.name === c.args['if'])
            return i ? R.interfaceDetail(d, i) : `Server error : show -> interface ${c.args['if']} is invalid`
          }
        })
      ]
    })
    const routeRun = (a: Record<string, string>): string => R.routingRoute(d, { ...(a['type'] ? { type: a['type'] } : {}), ...(a['destination'] ? { destination: a['destination'] } : {}) })
    S('show routing route', 'Show routing table', () => R.routingRoute(d), {
      children: this.options(
        [
          { name: 'type', help: 'Route type', label: '<value>', kind: 'enum', values: () => ['bgp', 'connect', 'ospf', 'static'] },
          { name: 'destination', help: 'Destination IP address/prefix', label: '<ip/netmask>' },
          { name: 'virtual-router', help: 'Virtual router', label: '<value>', kind: 'enum', values: () => ['default'] }
        ],
        routeRun
      )
    })
    S('show vpn flow', 'Show IPsec tunnel status', () => R.vpnFlow(d))
    S('show routing fib', 'Show forwarding table', () => R.routingRoute(d))
    S('show routing protocol bgp summary', 'Show BGP summary', () => R.bgpSummary(d), { children: this.options([{ name: 'virtual-router', help: 'Virtual router', label: '<value>', kind: 'enum', values: () => ['default'] }], () => R.bgpSummary(d)) })
    S('show routing protocol bgp peer', 'Show BGP peer information', () => R.bgpPeer(d), {
      children: this.options(
        [
          { name: 'peer-name', help: 'Peer name', label: '<value>', values: () => d.bgp.map((n) => R.peerName(n)) },
          { name: 'virtual-router', help: 'Virtual router', label: '<value>', kind: 'enum', values: () => ['default'] }
        ],
        (a) => (a['peer-name'] && !d.bgp.some((n) => R.peerName(n) === a['peer-name']) ? `Server error : peer ${a['peer-name']} does not exist` : R.bgpPeer(d, a['peer-name']))
      )
    })
    S('show routing protocol ospf neighbor', 'Show OSPF neighbors', () => R.ospfNeighbor(d), { children: this.options([{ name: 'virtual-router', help: 'Virtual router', label: '<value>', kind: 'enum', values: () => ['default'] }], () => R.ospfNeighbor(d)) })
    S('show arp', 'Show ARP entries', undefined, { children: [kw('all', 'All interfaces', { run: () => R.arpAll(d) }), prm(ifName(), 'Interface name', { name: 'if', run: (c) => R.arpAll(d, c.args['if']) })] })
    S('show mac', 'Show MAC table', undefined, { children: [kw('all', 'All VLANs', { run: () => R.macAll(d) })] })
    S('show lldp neighbors', 'Show LLDP neighbors', undefined, { children: [kw('all', 'All interfaces', { run: () => R.lldpAll(d) }), prm(ifName(), 'Interface name', { name: 'if', run: (c) => R.lldpAll({ ...d, lldp: d.lldp.filter((n) => n.local === c.args['if']) } as Device) })] })
    const sessFilter = this.options(
      [
        { name: 'application', help: 'Application name', label: '<value>' },
        { name: 'destination', help: 'Destination IP address', label: '<ip>', kind: 'ipv4' },
        { name: 'destination-port', help: 'Destination port', label: '<1-65535>', kind: 'int' },
        { name: 'from', help: 'From zone', label: '<value>' },
        { name: 'protocol', help: 'IP protocol value', label: '<1-255>', kind: 'int' },
        { name: 'rule', help: 'Security rule name', label: '<value>' },
        { name: 'source', help: 'Source IP address', label: '<ip>', kind: 'ipv4' },
        { name: 'to', help: 'To zone', label: '<value>' }
      ],
      (a) => R.sessionAll(d, a)
    )
    S('show session all', 'Show all sessions', () => R.sessionAll(d), { children: [kw('filter', 'Filter sessions', { children: sessFilter })] })
    S('show session info', 'Show session statistics', () => R.sessionInfo(d))
    S('show session id', 'Show session detail', undefined, { children: [prm({ kind: 'int', label: '<value>', values: () => R.pdata(d).sessions.map((x) => String(x.id)) }, 'Session id', { name: 'id', run: (c) => R.sessionId(d, Number(c.args['id'])) })] })
    const counterRun = (a: Record<string, string>): string => R.counterGlobal(d, { delta: a['delta'] === 'yes', ...(a['severity'] ? { severity: a['severity'] } : {}) })
    S('show counter global', 'Show global counters', () => R.counterGlobal(d, {}), {
      children: [
        kw('filter', 'Filter counters', {
          children: this.options(
            [
              { name: 'aspect', help: 'Counter aspect', label: '<value>' },
              { name: 'category', help: 'Counter category', label: '<value>' },
              { name: 'delta', help: 'Show counter delta since last run', label: '', kind: 'enum', values: () => ['no', 'yes'] },
              { name: 'packet-filter', help: 'Counters for packet filter', label: '', kind: 'enum', values: () => ['no', 'yes'] },
              { name: 'severity', help: 'Counter severity', label: '', kind: 'enum', values: () => ['drop', 'error', 'info', 'warn'] }
            ],
            counterRun
          )
        })
      ]
    })
    S('show running security-policy', 'Show security policy', () => R.runningPolicy(d))
    S('show running nat-policy', 'Show NAT policy', () => '')
    S('show jobs all', 'Show all jobs', () => R.jobsAll(d))
    S('show jobs pending', 'Show pending jobs', () => '')
    S('show jobs processed', 'Show processed jobs', () => R.jobsAll(d))
    S('show jobs id', 'Show job detail', undefined, { children: [prm({ kind: 'int', label: '<value>' }, 'Job id', { name: 'id', run: (c) => R.jobId(d, Number(c.args['id'])) })] })
    S('show high-availability state', 'Show HA state', () => R.haState(d))
    S('show high-availability all', 'Show HA information', () => R.haState(d))
    S('show config diff', 'Show candidate vs running', () => this.configDiff())
    S('show config running', 'Show running configuration', () => this.renderLines(runningLines(d), []))
    S('show config candidate', 'Show candidate configuration', () => this.renderLines(candidateLines(d), []))
    S('show log system', 'Show system logs', () => R.logSystem(d), { children: [prm({ kind: 'line', label: '<filter>' }, 'Log filter', { run: () => R.logSystem(d) })] })
    S('show admins', 'Show logged-in administrators', () => `Admin            From            Client Session-start     Idle-for\n--------------------------------------------------------------------------\n${this.s.user.padEnd(17)}${this.s.from.padEnd(16)}CLI    ${R.ymdhms(now(d) - 3600_000)}   00:00:00s`)
    S('show user group list', 'Show user group list', () => 'cn=fw-admins,ou=groups,ou=acme,dc=acme,dc=local\ncn=vpn-users,ou=groups,ou=acme,dc=acme,dc=local')
    S('test security-policy-match', 'Test security policy match', undefined, {
      children: this.options(
        [
          { name: 'application', help: 'Application name', label: '<value>' },
          { name: 'destination', help: 'Destination IP address', label: '<ip>', kind: 'ipv4' },
          { name: 'destination-port', help: 'Destination port', label: '<1-65535>', kind: 'int' },
          { name: 'from', help: 'From zone', label: '<value>', values: () => [...new Set(d.interfaces.map((i) => i.zone).filter((z): z is string => !!z))] },
          { name: 'protocol', help: 'IP protocol value', label: '<1-255>', kind: 'int' },
          { name: 'source', help: 'Source IP address', label: '<ip>', kind: 'ipv4' },
          { name: 'source-user', help: 'Source user', label: '<value>' },
          { name: 'to', help: 'To zone', label: '<value>', values: () => [...new Set(d.interfaces.map((i) => i.zone).filter((z): z is string => !!z))] }
        ],
        (a) => R.policyMatch(d, a)
      )
    })
    S('test routing fib-lookup', 'Perform a FIB lookup', undefined, {
      children: this.options(
        [
          { name: 'ip', help: 'Destination IP address', label: '<ip>', kind: 'ipv4', required: true },
          { name: 'virtual-router', help: 'Virtual router', label: '<value>', kind: 'enum', values: () => ['default'], required: true }
        ],
        (a) => R.fibLookup(d, a['ip']!)
      )
    })
    const cli = (path: string, help: string, values: string[], apply: (v: string) => string): void => {
      S(`set cli ${path}`, help, undefined, { children: values.map((v) => kw(v, v, { run: () => apply(v) })) })
    }
    cli('pager', 'Enable/disable pager', ['off', 'on'], (v) => ((this.s.pageLength = v === 'on' ? this.s.rows - 1 : 0), ''))
    cli('scripting-mode', 'Enable/disable scripting mode', ['off', 'on'], () => '')
    cli('config-output-format', 'Set configuration output format', ['default', 'json', 'set', 'xml'], (v) => ((this.format = v as typeof this.format), ''))
    cli('confirmation-prompt', 'Enable/disable confirmation prompt', ['off', 'on'], (v) => ((this.confirmPrompt = v === 'on'), ''))
    cli('op-command-xml-output', 'Enable/disable XML output for op commands', ['off', 'on'], () => '')
    S('set cli terminal width', 'Set terminal width', undefined, { children: [prm({ kind: 'int', label: '<value>', min: 40, max: 512 }, 'Width', { run: () => '' })] })
    S('set cli terminal height', 'Set terminal height', undefined, { children: [prm({ kind: 'int', label: '<value>', min: 1, max: 500 }, 'Height', { run: (c) => ((this.s.pageLength = Number(c.params[0]) - 1), '') })] })
    S('set cli timeout idle', 'Set idle timeout', undefined, { children: [prm({ kind: 'word', label: '<value>' }, 'Minutes or never', { run: () => '' })] })
    S('configure', 'Manipulate software configuration information', () => this.enterConf())
    S('exit', 'Exit this session', () => (this.s.close(), ''))
    S('quit', 'Exit this session', () => (this.s.close(), ''))
    S('ping', 'Ping hosts and networks', undefined, {
      children: this.options(
        [
          { name: 'count', help: 'Number of requests to send', label: '<1-2000000000>', kind: 'int' },
          { name: 'interval', help: 'Delay between requests (seconds)', label: '<value>', kind: 'int' },
          { name: 'size', help: 'Size of request packets', label: '<0-65468>', kind: 'int' },
          { name: 'source', help: 'Source address of echo request', label: '<ip>', kind: 'ipv4' },
          { name: 'host', help: 'Hostname or IP address of remote host', label: '<value>', required: true }
        ],
        (a) => this.ping(a)
      )
    })
    S('traceroute', 'Print the route packets take to network host', undefined, {
      children: this.options(
        [
          { name: 'source', help: 'Source address', label: '<ip>', kind: 'ipv4' },
          { name: 'host', help: 'Hostname or IP address of remote host', label: '<value>', required: true }
        ],
        (a) => this.trace(a)
      )
    })
    const confirm = async (q: string, done: string): Promise<string> => {
      const a = this.confirmPrompt ? await this.s.ask(`${q} Do you want to continue? (y or n) `, { mode: 'key' }) : 'y'
      if (a.toLowerCase() !== 'y') {
        this.s.write('\r\n')
        return ''
      }
      return done
    }
    S('request restart system', 'Reboot the system', () => confirm('Executing this command will disconnect the current session.', '\nBroadcast message from root (pts/0):\n\nThe system is going down for reboot NOW!\n[simulator] restart acknowledged; the simulator never reboots.'))
    S('request restart dataplane', 'Restart the dataplane', () => confirm('Executing this command will restart the dataplane and disrupt traffic.', '[simulator] dataplane restart acknowledged; nothing restarted.'))
    S('request shutdown system', 'Shut down the system', () => confirm('Executing this command will shut down the system.', '[simulator] shutdown acknowledged; the simulator keeps running.'))
    S('request system software install version', 'Install a software version', undefined, {
      children: [prm({ kind: 'word', label: '<value>' }, 'Version', { run: () => confirm('Executing this command will install a new version of software. It will not take effect until system is restarted.', 'Server error : [simulator] software installation is not simulated') })]
    })
    S('request system software info', 'Show available software', () => `Version         Size              Released Downloaded\n-------------------------------------------------------------------------\n${d.version.padEnd(16)}${'612MB'.padEnd(18)}2026/09/12 00:00:00 yes`)
    S('request license info', 'Show installed licenses', () => `\nCurrent date: ${R.ymdhms(now(d)).slice(0, 10)}\n\nLicense entry:\nFeature: PA-VM\nDescription: Standard VM-300\nSerial: ${d.serial}\nIssued: November 01, 2026\nExpires: Never\nExpired?: no`)
    S('scp import configuration', 'Import a configuration file', undefined, {
      children: this.options(
        [
          { name: 'remote-port', help: 'SSH port number on remote host', label: '<1-65535>', kind: 'int' },
          { name: 'source-ip', help: 'Set source address to specified interface address', label: '<ip>', kind: 'ipv4' },
          { name: 'from', help: 'Source (username@host:path)', label: '<value>', required: true }
        ],
        () => 'Server error : [simulator] file transfer is not simulated'
      )
    })
    S('clear counter global', 'Clear global counters', () => ((R.pdata(d).lastCounterSample = now(d)), ''))
    const seen = new Set<Node[]>()
    const sortTree = (list: Node[]): void => {
      if (seen.has(list)) return
      seen.add(list)
      if (!list.some((n) => this.marks.has(n))) list.sort((a, b) => (a.word ?? '~').localeCompare(b.word ?? '~'))
      for (const n of list) if (n.children) sortTree(n.children)
    }
    sortTree(op)
    return op
  }

  private mgmtIf(): string {
    const m = R.pdata(this.d).mgmt
    return `-------------------------------------------------------------------------------\nName: Management Interface\nLink status:\n  Runtime link speed/duplex/state: 1000/full/up\n  Configured link speed/duplex/state: auto/auto/auto\nMAC address:\n  Port MAC address ${m.mac}\n\nIp address: ${m.ip}\nNetmask: ${m.mask}\nDefault gateway: ${m.gw}\n-------------------------------------------------------------------------------`
  }

  private configDiff(): string {
    const a = this.renderLines(runningLines(this.d), []).split('\n')
    const b = this.renderLines(candidateLines(this.d), []).split('\n')
    return unifiedDiff(a, b, 'running-config', 'candidate-config').slice(2).join('\n')
  }

  private renderLines(lines: PLine[], path: string[]): string {
    const sel = lines.filter((l) => path.every((p, k) => l.path[k] === p))
    if (!sel.length) return ''
    if (this.format === 'set') return sel.map(setLineText).join('\n')
    if (this.format === 'json') return JSON.stringify(sel.map((l) => ({ path: l.path.join(' '), value: l.value.length > 1 ? l.value : l.value[0] })), null, 2)
    if (this.format === 'xml') return sel.map((l) => `<entry path="${l.path.join('/')}">${l.value.join(' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</entry>`).join('\n')
    return braceView(sel, path.slice(0, Math.max(0, path.length - 1))).join('\n')
  }

  // ------------------------------------------------------------------ execute

  async execute(raw: string): Promise<void> {
    if (this.conf) return this.execConf(raw)
    return this.execOp(raw)
  }

  private async execOp(raw: string): Promise<void> {
    const [base, pipes] = splitPipes(raw)
    const m = strictMatch(base, this.op)
    if (!m.ok) {
      await this.s.print(m.kind === 'unknown' ? `Unknown command: ${m.token}` : INVALID)
      return
    }
    let out = (await m.node.run!(m.ctx)) ?? ''
    const r = this.pipes(out, pipes)
    if (r === undefined) out = INVALID
    else out = r
    if (out) await this.s.print(out)
  }

  private pipes(out: string, pipes: string[]): string | undefined {
    let lines = out.split('\n')
    for (const p of pipes) {
      const [w = '', ...rest] = tokenizeConf(p)
      const arg = rest.map(unq).join(' ')
      if ((w !== 'match' && w !== 'except') || !arg) return undefined
      const re = safeRegex(arg)
      if (!re) return undefined
      lines = lines.filter((l) => re.test(l) === (w === 'match'))
    }
    return lines.join('\n')
  }

  private ping(a: Record<string, string>): Promise<string> | string {
    const host = a['host']!
    if (!isIpv4(host)) return `ping: unknown host ${host}`
    return this.pingRun(host, a['count'] ? Number(a['count']) : Infinity, a['source'])
  }

  private reachable(ip: string, source?: string): boolean {
    const d = this.d
    if (!source) {
      const m = R.pdata(d).mgmt
      if (inSubnet(ip, m.ip, 24) || ip === m.gw) return true
    }
    if (d.interfaces.some((i) => i.ip === ip && isUp(i))) return true
    return R.routes(d).some((r) => r.flags !== 'A H' && inSubnet(ip, r.prefix, r.mask) && (r.mask > 0 || !/^192\.0\.2\./.test(ip)))
  }

  private async pingRun(host: string, count: number, source?: string): Promise<string> {
    const ok = this.reachable(host, source)
    await this.s.print(`PING ${host} (${host}) 56(84) bytes of data`)
    let sent = 0
    let got = 0
    while (sent < count) {
      if (!(await this.s.sleep(sent ? 200 : 20))) {
        this.s.write('^C\r\n')
        break
      }
      sent++
      if (ok) {
        got++
        await this.s.print(`64 bytes from ${host}: icmp_seq=${sent} ttl=63 time=${(0.4 + ((sent * 37) % 23) / 100).toFixed(2)} ms`)
      }
    }
    const loss = sent ? Math.round(((sent - got) / sent) * 100) : 0
    const out = ['', `--- ${host} ping statistics ---`, `${sent} packets transmitted, ${got} received, ${loss}% packet loss, time ${Math.max(0, sent - 1) * 1000}ms`]
    if (got) out.push('rtt min/avg/max/mdev = 0.410/0.520/0.630/0.081 ms')
    return out.join('\n')
  }

  private async trace(a: Record<string, string>): Promise<string> {
    const host = a['host']!
    if (!isIpv4(host)) return `traceroute: unknown host ${host}`
    await this.s.print(`traceroute to ${host} (${host}), 30 hops max, 60 byte packets`)
    const ok = this.reachable(host, a['source'])
    const nh = R.routes(this.d).filter((r) => r.flags !== 'A H' && inSubnet(host, r.prefix, r.mask)).sort((x, y) => y.mask - x.mask)[0]
    const hops = ok ? (nh && nh.nexthop !== host && !nh.flags.includes('C') ? [nh.nexthop, host] : [host]) : ['*', '*', '*']
    for (let k = 0; k < hops.length; k++) {
      if (!(await this.s.sleep(30))) break
      await this.s.print(hops[k] === '*' ? `${String(k + 1).padStart(2)}  * * *` : `${String(k + 1).padStart(2)}  ${hops[k]} (${hops[k]})  ${(0.6 + k).toFixed(3)} ms  ${(0.5 + k).toFixed(3)} ms  ${(0.7 + k).toFixed(3)} ms`)
    }
    return ''
  }

  // ------------------------------------------------------------------ configuration mode

  private enterConf(): string {
    this.conf = true
    this.edit = []
    logEvent(this.d, `general  User ${this.s.user} entered configuration mode`)
    return 'Entering configuration mode'
  }

  private leaveConf(): string {
    this.conf = false
    this.edit = []
    return 'Exiting configuration mode'
  }

  private static VERBS: [string, string][] = [
    ['check', 'Check status of the configuration'],
    ['commit', 'Commit the candidate configuration'],
    ['delete', 'Delete a configuration element'],
    ['edit', 'Edit a configuration sub-hierarchy'],
    ['exit', 'Exit from this level'],
    ['quit', 'Exit from configuration mode'],
    ['revert', 'Revert the candidate configuration'],
    ['run', 'Run an operational-mode command'],
    ['set', 'Set a configuration element'],
    ['show', 'Show the configuration'],
    ['top', 'Exit to the top level of configuration'],
    ['up', 'Exit one level of configuration'],
    ['validate', 'Validate the candidate configuration']
  ]

  private async execConf(raw: string): Promise<void> {
    const toks = tokenizeConf(raw)
    const verb = toks[0] ?? ''
    const rest = toks.slice(1)
    const out = await this.confVerb(verb, rest, raw)
    if (out) await this.s.print(out)
  }

  private async confVerb(verb: string, rest: string[], raw: string): Promise<string> {
    const d = this.d
    const st = store(d)
    switch (verb) {
      case 'set': {
        const ops = this.parseSet([...this.edit, ...rest])
        if (!ops || !rest.length) return INVALID
        st.ops.push(...ops.map((o) => ({ ...o, by: this.s.user })))
        return ''
      }
      case 'delete': {
        const w = walk([...this.edit, ...rest])
        if (!w.ok || (!rest.length && !this.edit.length)) return INVALID
        const r = applyDelete(candidateLines(d), w.path, w.value.filter((x) => x !== '[' && x !== ']'))
        if (r.hit) st.ops.push({ op: 'delete', path: w.path, value: w.value.filter((x) => x !== '[' && x !== ']'), by: this.s.user })
        return ''
      }
      case 'edit': {
        const w = walk([...this.edit, ...rest])
        if (!w.ok || !rest.length || w.node.leaf || w.atEntry || w.value.length) return INVALID
        this.edit = w.path
        return ''
      }
      case 'up':
        if (rest.length) return INVALID
        this.edit = this.edit.slice(0, -1)
        if (this.edit.length && walk(this.edit).ok && (walk(this.edit) as { atEntry?: boolean }).atEntry) this.edit = this.edit.slice(0, -1)
        return ''
      case 'top':
        if (rest.length) return INVALID
        this.edit = []
        return ''
      case 'show': {
        const [base, pipes] = splitPipes(raw.replace(/^\s*show\b/, ''))
        const t = tokenizeConf(base)
        const w = walk([...this.edit, ...t])
        if (!w.ok) return INVALID
        const out = this.renderLines(candidateLines(d), [...w.path, ...w.value])
        const r = this.pipes(out, pipes)
        return r === undefined ? INVALID : r
      }
      case 'commit':
        return this.commit(rest)
      case 'validate':
        if (rest[0] !== 'full' && rest[0] !== 'partial') return INVALID
        return this.validateJob()
      case 'check':
        if (rest[0] === 'pending-changes' && rest.length === 1) return pending(d) ? 'yes' : 'no'
        if (rest[0] === 'full-commit-required' && rest.length === 1) return 'no'
        return INVALID
      case 'revert':
        if (rest[0] !== 'config') return INVALID
        st.ops = []
        return ''
      case 'run': {
        const line = raw.replace(/^\s*run\b/, '').trim()
        if (!line) return INVALID
        await this.execOp(line)
        return ''
      }
      case 'exit':
        if (rest.length) return INVALID
        if (this.edit.length) return this.confVerb('up', [], 'up')
        return this.quit()
      case 'quit':
        if (rest.length) return INVALID
        return this.quit()
      case 'save':
      case 'load':
      case 'rename':
      case 'move':
      case 'copy':
      case 'clone':
        return 'Server error : [simulator] ' + verb + ' is not simulated; use set/delete'
      default:
        return `Unknown command: ${verb}`
    }
  }

  /** `set a b leaf v [leaf2 v2 ...]`: PAN-OS accepts several leaf/value pairs on one line. */
  private parseSet(tokens: string[]): { op: 'set'; path: string[]; value: string[] }[] | undefined {
    const w = walk(tokens)
    if (!w.ok || w.atEntry) return undefined
    if (!w.node.leaf) return w.value.length ? undefined : []
    const vt = w.value
    const n = vt[0] === '[' ? vt.indexOf(']') + 1 : 1
    if (n <= 0 || !vt.length) return undefined
    const v = parseValue(w.node, vt.slice(0, n))
    if (!v) return undefined
    const out = [{ op: 'set' as const, path: w.path, value: v }]
    if (vt.length > n) {
      const more = this.parseSet([...w.path.slice(0, -1), ...vt.slice(n)])
      if (!more) return undefined
      out.push(...more)
    }
    return out
  }

  private quit(): string {
    if (pending(this.d)) return 'There are uncommitted changes in the candidate configuration.\n' + this.leaveConf()
    return this.leaveConf()
  }

  private newJob(type: string, ok: boolean, details: string): number {
    const p = R.pdata(this.d)
    const t = now(this.d)
    const id = p.nextJob++
    p.jobs.push({ id, type, enq: t, deq: t, done: t, status: 'FIN', result: ok ? 'OK' : 'FAIL', details })
    if (p.jobs.length > 50) p.jobs.shift()
    return id
  }

  private issuesText(by?: string): string | undefined {
    const issues = validate(this.d, candidateLines(this.d, by))
    if (!issues.length) return undefined
    return ['Validation Error:', ...issues.map((i) => ` ${i.xpath} ${i.msg}`), ` ${issues[0]!.xpath.split(' -> ')[0]} is invalid`].join('\n')
  }

  private validateJob(): string {
    const bad = this.issuesText()
    const id = this.newJob('Validate', !bad, bad ?? 'Configuration is valid')
    return `Validate job enqueued with jobid ${id}\n\n`
  }

  private async commit(rest: string[]): Promise<string> {
    const d = this.d
    // `commit partial admin <name>`: only that admin's pending edits; the others stay in the candidate.
    const partial = rest[0] === 'partial' ? (rest[1] === 'admin' && rest[2] && rest.length === 3 ? rest[2] : null) : undefined
    if (partial === null) return INVALID
    if (partial === undefined && rest.length && rest[0] !== 'force' && rest[0] !== 'description') return INVALID
    const others = partial !== undefined ? store(d).ops.filter((o) => o.by !== partial) : []
    if (partial !== undefined && !store(d).ops.some((o) => o.by === partial)) return 'There are no changes to commit.'
    if (rest[0] !== 'force' && !pending(d)) {
      store(d).ops = []
      return 'There are no changes to commit.'
    }
    const bad = this.issuesText(partial)
    const id = R.pdata(d).nextJob
    if (bad) {
      this.newJob('Commit', false, bad)
      return `${bad}\ncommit failed`
    }
    this.newJob('Commit', true, 'Configuration committed successfully')
    const lines = candidateLines(d, partial)
    syncDevice(d, lines)
    store(d).ops = others
    logEvent(d, `general  Commit job ${id} succeeded by ${this.s.user}`)
    this.s.write(`Commit job ${id} is in progress. Use Ctrl+C to return to command prompt\r\n`)
    for (const step of ['.....', '55%', '....', '75%', '.....', '98%', '.....', '100%']) {
      if (!(await this.s.sleep(5))) {
        this.s.write('\r\n')
        return ''
      }
      this.s.write(step)
    }
    this.s.write('\r\n')
    return 'Configuration committed successfully\n'
  }

  // ------------------------------------------------------------------ help & completion

  help(line: string): string {
    if (/\|/.test(line)) return formatHelp([{ mark: '', label: 'except', help: 'Only show lines that do not match the regex' }, { mark: '', label: 'match', help: 'Only show lines that match the regex' }])
    if (this.conf) return this.confHelp(line)
    return this.opHelp(line, this.op)
  }

  private nodeRows(children: Node[], partial: string): HelpRow[] {
    const rows: HelpRow[] = []
    for (const c of children) {
      if (c.hidden) continue
      if (c.word !== undefined) {
        if (!c.word.startsWith(partial)) continue
        rows.push({ mark: this.marks.get(c) ?? (c.children?.length ? '>' : ''), label: c.word, help: c.help })
      } else if (c.param && !partial) {
        if (c.param.kind === 'enum') for (const v of c.param.values?.() ?? []) rows.push({ mark: '', label: v, help: v })
        else rows.push({ mark: '', label: c.param.label, help: c.param.label })
      }
    }
    return rows
  }

  private opHelp(line: string, roots: Node[]): string {
    const endsSpace = line === '' || /\s$/.test(line)
    const toks = tokenizeConf(line)
    const partial = endsSpace ? '' : (toks.pop() ?? '')
    let children = roots
    let node: Node | undefined
    for (const t of toks) {
      const next = children.find((c) => c.word === t) ?? children.find((c) => c.param && acceptParam(c.param, unq(t)))
      if (!next) return INVALID + '\n'
      node = next
      if (next.param?.kind === 'line') return ''
      children = next.children ?? []
    }
    const rows = this.nodeRows(children, partial)
    if (node?.run && !partial) rows.push({ mark: '', label: '<Enter>', help: 'Finish input' })
    return formatHelp(rows)
  }

  private schemaRows(n: SNode, partial: string, path: string[], showEnter: boolean): HelpRow[] {
    const rows: HelpRow[] = []
    if (n.leaf) {
      if (n.leaf.kind === 'enum') for (const [v, h] of n.leaf.enums ?? []) if (v.startsWith(partial)) rows.push({ mark: '', label: v, help: h })
      if (n.leaf.kind !== 'enum' && !partial) rows.push({ mark: '', label: n.leaf.label, help: n.leaf.label })
      return rows
    }
    if (n.entry) {
      for (const v of n.entry.values?.(this.d, candidateLines(this.d), path) ?? []) if (v.startsWith(partial)) rows.push({ mark: '>', label: v, help: v })
      if (!partial) rows.push({ mark: '', label: n.entry.label, help: n.entry.label })
      return rows
    }
    for (const [k, c] of Object.entries(n.kids ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (!k.startsWith(partial)) continue
      rows.push({ mark: c.mark ?? (c.leaf ? '+' : '>'), label: k, help: c.help })
    }
    if (showEnter && !partial) rows.push({ mark: '', label: '<Enter>', help: 'Finish input' })
    return rows
  }

  private confHelp(line: string): string {
    const endsSpace = line === '' || /\s$/.test(line)
    const toks = tokenizeConf(line)
    const partial = endsSpace ? '' : (toks.pop() ?? '')
    if (!toks.length) return formatHelp(PanosPersonality.VERBS.filter(([v]) => v.startsWith(partial)).map(([v, h]) => ({ mark: '>', label: v, help: h })))
    const verb = toks[0]!
    if (verb === 'run') return this.opHelp(line.replace(/^\s*run\s+/, ''), this.op)
    if (!['set', 'delete', 'edit', 'show'].includes(verb)) {
      if (!PanosPersonality.VERBS.some(([v]) => v === verb)) return `Unknown command: ${verb}\n`
      return formatHelp([{ mark: '', label: '<Enter>', help: 'Finish input' }])
    }
    const w = walk([...this.edit, ...toks.slice(1)])
    if (!w.ok || w.value.length) return INVALID + '\n'
    return formatHelp(this.schemaRows(w.node, partial, w.path, toks.length > 1 && (verb !== 'set' || !w.node.entry)))
  }

  private completeWords(line: string): { partial: string; words: string[] } {
    const toks = tokenizeConf(line)
    if (!line || /\s$/.test(line)) return { partial: '', words: [] }
    const partial = toks.pop()!
    if (this.conf) {
      if (!toks.length) return { partial, words: PanosPersonality.VERBS.map(([v]) => v).filter((v) => v.startsWith(partial)) }
      if (toks[0] === 'run') return this.opWords(toks.slice(1), partial)
      if (!['set', 'delete', 'edit', 'show'].includes(toks[0]!)) return { partial, words: [] }
      const w = walk([...this.edit, ...toks.slice(1)])
      if (!w.ok || w.value.length) return { partial, words: [] }
      return { partial, words: this.schemaRows(w.node, partial, w.path, false).map((r) => r.label).filter((l) => !l.startsWith('<')) }
    }
    return this.opWords(toks, partial)
  }

  private opWords(toks: string[], partial: string): { partial: string; words: string[] } {
    let children = this.op
    for (const t of toks) {
      const next = children.find((c) => c.word === t) ?? children.find((c) => c.param && acceptParam(c.param, unq(t)))
      if (!next) return { partial, words: [] }
      children = next.children ?? []
    }
    const words = children.filter((c) => c.word?.startsWith(partial)).map((c) => c.word!)
    for (const c of children) for (const v of c.param?.values?.() ?? []) if (v.startsWith(partial) && !words.includes(v)) words.push(v)
    return { partial, words }
  }

  tab(line: string): TabResult {
    const { partial, words } = this.completeWords(line)
    if (!partial) return { bell: true }
    if (words.length === 1) return { line: line.slice(0, line.length - partial.length) + words[0]! + ' ' }
    if (!words.length) return { bell: true }
    let common = words[0]!
    for (const w of words) while (!w.startsWith(common)) common = common.slice(0, -1)
    return { list: words.join('  '), line: line.slice(0, line.length - partial.length) + common }
  }

  control(key: 'c' | 'z', _line: string): ControlResult {
    if (key === 'z') return { keepLine: true }
    return { echo: '\n' }
  }
}

export const panosFactory = (s: Session): PanosPersonality => new PanosPersonality(s)
export { tokenize, SCHEMA }
