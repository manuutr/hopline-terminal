/**
 * Juniper Junos personality (docs/research/cli-juniper-junos.md): `user@host>` operational mode,
 * `[edit ...]` banner lines in configuration mode, candidate/active config as set-lines with
 * set/delete/edit/up/top, `show | compare`, `commit check`, `commit confirmed N` with automatic
 * rollback, `rollback N`, complete-on-space, `Possible completions:` help, `---(more N%)---`.
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { now, runtime } from '../../core/runtime.ts'
import { safeRegex, splitPipes } from '../../core/text.ts'
import { add, completions, help as treeHelp, isIpv4, kw, match, prm, tokenOffsets, tokenize, type Ctx, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { isUp, logEvent, tickBgp, type Device } from '../../state.ts'
import { buildTree, checkLines, compareTrees, deleteLines, keysOf, linesFromDevice, renderTree, setLine, subtree, syncDevice, tokenizeConf } from './conf.ts'
import * as R from './render.ts'

export interface JCommit {
  lines: string[]
  at: number
  user: string
  how: string
  comment?: string
}

export interface JStore {
  active: string[]
  candidate: string[]
  /** history[0] is the active config; rollback N loads history[N]. */
  history: JCommit[]
  confirm?: { deadline: number; minutes: number }
}

/** The device's Junos config store, created from the model on first use. */
export function junosStore(d: Device): JStore {
  const v = d.vendor as { junos?: JStore }
  if (!v.junos) {
    const lines = linesFromDevice(d)
    v.junos = { active: [...lines], candidate: [...lines], history: [{ lines: [...lines], at: d.bootedAt + 120_000, user: 'root', how: 'cli' }] }
  }
  return v.junos
}

export const JUNOS_PAGER: PagerSpec = {
  text: (pct) => (pct > 0 && pct < 100 ? `---(more ${pct}%)---` : '---(more)---'),
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  keys: { ' ': 'page', '\x06': 'page', '\r': 'line', '\n': 'line', k: 'line', '\x0e': 'line', d: 'half', '\t': 'half', '\x04': 'half', '\x18': 'half', g: 'all', '\x05': 'all', n: 'all', N: 'all', q: 'quit', Q: 'quit', '\x03': 'quit', '\x0b': 'quit' },
  other: 'ignore'
}

// ------------------------------------------------------------------ config schema (help + completion)

interface SNode {
  help: string
  kids?: Record<string, SNode>
  /** Takes a value: the label shown in help, e.g. '<name>'. */
  value?: string
  /** After the value, these statements follow (named containers). */
  named?: Record<string, SNode>
  leaf?: boolean
}

const V = (help: string, value = '<value>'): SNode => ({ help, value, leaf: true })
const L = (help: string): SNode => ({ help, leaf: true })
const C = (help: string, kids: Record<string, SNode>): SNode => ({ help, kids })
const N = (help: string, value: string, named: Record<string, SNode>): SNode => ({ help, value, named })

const UNIT: Record<string, SNode> = { description: V('Text description of interface', '<description>'), family: N('Protocol family', '<family>', { address: V('Interface address/destination prefix', '<address>'), mtu: V('Protocol family maximum transmission unit', '<mtu>') }), 'vlan-id': V('Virtual LAN identifier value for 802.1q VLAN tags', '<vlan-id>'), disable: L('Disable this logical interface') }
const IFACE: Record<string, SNode> = { description: V('Text description of interface', '<description>'), disable: L('Disable this interface'), mtu: V('Maximum transmit packet size', '<mtu>'), unit: N('Logical interface', '<interface_unit_number>', UNIT), 'vlan-tagging': L('802.1q VLAN tagging support'), speed: V('Link speed', '<speed>'), 'gigether-options': C('Gigabit Ethernet interface-specific options', {}) }
const NBR: Record<string, SNode> = { 'peer-as': V('Autonomous system number', '<autonomous-system>'), description: V('Text description', '<description>'), shutdown: L('Shutdown BGP neighbor'), export: V('Export policy', '<export>'), import: V('Import policy', '<import>') }
const SCHEMA: Record<string, SNode> = {
  'apply-groups': V('Groups from which to inherit configuration data', '<apply-groups>'),
  chassis: C('Chassis configuration', {}),
  firewall: C('Define a firewall configuration', {}),
  interfaces: N('Interface configuration', '<interface_name>', IFACE),
  'policy-options': C('Policy option configuration', { 'prefix-list': N('Define a list of IP address prefixes', '<name>', {}), 'policy-statement': N('Routing policy', '<name>', { term: N('Policy term', '<term-name>', { from: C('Conditions to match the source of a route', { 'prefix-list': V('Prefix-lists of routes to match', '<name>'), protocol: V('Protocol from which route was learned', '<protocol>') }), then: C('Actions to take if from and to conditions match', { accept: L('Accept a route'), reject: L('Reject a route') }) }) }) }),
  protocols: C('Routing protocol configuration', {
    bgp: C('BGP options', { group: N('Define a peer group', '<group-name>', { type: V('Type of peer group', '<type>'), 'peer-as': V('Autonomous system number', '<autonomous-system>'), neighbor: N('Configure a neighbor', '<address>', NBR), export: V('Export policy', '<export>'), import: V('Import policy', '<import>'), 'local-address': V('Address of local end of BGP session', '<local-address>'), description: V('Text description', '<description>') }) }),
    ospf: C('OSPF configuration', { area: N('Configure an OSPF area', '<area_id>', { interface: N('Include an interface in this area', '<interface_name>', { passive: L('Do not run OSPF, but advertise it'), 'interface-type': V('Type of interface', '<interface-type>'), metric: V('Interface metric', '<metric>') }) }) }),
    lldp: C('Link Layer Discovery Protocol', { interface: N('Interface configuration', '<interface_name>', { disable: L('Disable LLDP on this interface') }) })
  }),
  'routing-instances': N('Routing instance configuration', '<instance_name>', {}),
  'routing-options': C('Protocol-independent routing option configuration', { 'router-id': V('Router identifier', '<router-id>'), 'autonomous-system': V('Autonomous system number', '<autonomous-system>'), static: C('Static routes', { route: N('Static route', '<destination>', { 'next-hop': V('Next hop to destination', '<next-hop>'), discard: L('Drop packets to destination; send no ICMP unreachables') }) }) }),
  security: C('Security configuration', {}),
  snmp: C('Simple Network Management Protocol configuration', {}),
  system: C('System parameters', { 'host-name': V('Hostname for this router', '<host-name>'), 'domain-name': V('Domain name for this router', '<domain-name>'), services: C('System services', { ssh: L('Allow ssh access'), netconf: L('Allow NETCONF connections') }), login: C('Names, login classes, and passwords for users', { user: N('Username', '<name>', { class: V('Login class', '<class>') }) }), 'name-server': V('DNS name servers', '<address>'), ntp: C('Network Time Protocol services', { server: V('Configure an NTP server', '<address>') }) }),
  vlans: N('VLAN configuration', '<vlan_name>', { 'vlan-id': V('802.1q VLAN identifier', '<vlan-id>'), description: V('Text description of VLANs', '<description>') })
}

/** Walk the schema along typed tokens; returns the options at the end. */
function schemaAt(tokens: string[]): { kids: Record<string, SNode>; value?: string; help?: string } | undefined {
  let kids: Record<string, SNode> = SCHEMA
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    const n = kids[t]
    if (!n) return undefined
    if (n.value) {
      if (i + 1 >= tokens.length) return { kids: {}, value: n.value, help: n.help }
      if (n.leaf) return { kids: {} }
      kids = n.named ?? {}
      i += 2
      continue
    }
    if (n.leaf) return { kids: {} }
    kids = n.kids ?? {}
    i++
  }
  return { kids }
}

// ------------------------------------------------------------------ personality

export class JunosPersonality implements Personality {
  pager = JUNOS_PAGER
  abortKeys = ['\x03']
  private readonly s: Session
  private readonly d: Device
  private conf = false
  /** Current [edit] path as config keys. */
  private edit: string[] = []
  private stack: string[][] = []
  private completeOnSpace = true
  private op: Node[]
  private ct: Node[]

  constructor(s: Session) {
    this.s = s
    this.d = s.d
    junosStore(this.d)
    this.op = this.buildOp()
    this.ct = this.buildConf()
  }

  /** `configure private`: this session's own candidate, started from the active configuration. */
  private priv: string[] | null = null

  private get st(): JStore {
    const shared = junosStore(this.d)
    if (!this.priv) return shared
    const self = this
    return {
      get active() { return shared.active },
      // A private commit merges into the shared database; a clean shared candidate follows it.
      set active(v) {
        if (shared.candidate.join('\n') === shared.active.join('\n')) shared.candidate = [...v]
        shared.active = v
      },
      get history() { return shared.history },
      set history(v) { shared.history = v },
      get confirm() { return shared.confirm },
      set confirm(v) { shared.confirm = v },
      get candidate() { return self.priv! },
      set candidate(v) { self.priv = v }
    }
  }

  banner(): string {
    return `Last login: ${new Date(now(this.d) - 3600_000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, '$1 $3 $2 $5 $4')} from 192.168.100.50\n\n--- JUNOS ${this.d.version} Kernel 64-bit  JNPR-12.1-20231115.f0321c3_builder_stable_12_224\n`
  }

  private user(): string {
    return this.s.user
  }

  promptText(): string {
    return this.conf ? `${this.user()}@${this.d.hostname}# ` : `${this.user()}@${this.d.hostname}> `
  }

  prompt(reason: PromptReason): string {
    if (!this.conf) return (reason === 'command' || reason === 'notify' ? '\n' : '') + this.promptText()
    const c = this.st.confirm
    const mins = c ? Math.max(1, Math.ceil((c.deadline - now(this.d)) / 60000)) : 0
    const banner = c ? `# commit confirmed will be rolled back in ${mins} minute${mins === 1 ? '' : 's'}\n` : ''
    return (reason === 'help' ? '' : '\n') + banner + `[edit${this.edit.length ? ' ' + this.edit.join(' ') : ''}]\n` + this.promptText()
  }

  private caretAt(col: number): string {
    return ' '.repeat(this.promptText().length + col) + '^'
  }

  // ------------------------------------------------------------------ operational tree

  private buildOp(): Node[] {
    const d = this.d
    const op: Node[] = []
    const ifP = (): Param => ({ kind: 'word', label: '<interface-name>', values: () => d.interfaces.map((i) => i.name), test: (t) => d.interfaces.some((i) => i.name === t.replace(/\.0$/, '')) || /\*/.test(t) })
    const ipP = (label = '<address>'): Param => ({ kind: 'ipv4', label, values: () => d.bgp.map((n) => n.ip) })
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node =>
      add(op, `show ${path}`, help, run, extra, {
        show: 'Show system information',
        'show interfaces': 'Show interface information',
        'show bgp': 'Show BGP information',
        'show ospf': 'Show information about OSPF',
        'show system': 'Show system information',
        'show chassis': 'Show chassis information',
        'show log': 'Show contents of log file',
        'show lldp': 'Show Link Layer Discovery Protocol information'
      })
    S('interfaces', 'Show interface information', () => d.interfaces.filter((i) => /^(ge|xe|et)-/.test(i.name)).map((i) => R.showInterface(d, i, false)).join('\n\n'), {
      children: [
        prm(ifP(), 'Name of physical or logical interface', {
          name: 'if',
          run: (c) => this.ifDetail(c, false),
          children: [kw('extensive', 'Display extensive output', { run: (c) => this.ifDetail(c, true) }), kw('detail', 'Display detailed output', { run: (c) => this.ifDetail(c, true) }), kw('terse', 'Display terse output', { run: (c) => R.showInterfacesTerse(d, c.args['if']) })]
        })
      ]
    })
    S('interfaces terse', 'Display terse output', () => R.showInterfacesTerse(d), { children: [prm(ifP(), 'Name of physical or logical interface', { name: 'if', run: (c) => R.showInterfacesTerse(d, c.args['if']) })] })
    S('interfaces descriptions', 'Show interface description string', () => R.showInterfacesDescriptions(d))
    S('bgp summary', 'Show overview of BGP information', () => R.showBgpSummary(d, this.groupCount()))
    S('bgp neighbor', 'Show BGP neighbors', () => R.showBgpNeighbor(d), { children: [prm(ipP('<address>'), 'IP address of neighbor', { name: 'nb', run: (c) => R.showBgpNeighbor(d, c.args['nb']) })] })
    S('bgp group', 'Show BGP group information', () => this.st.active.filter((l) => /^protocols bgp group \S+ type/.test(l)).map((l) => `Group: ${l.split(' ')[3]} Type: ${l.split(' ').at(-1) === 'external' ? 'External' : 'Internal'}`).join('\n\n'))
    S('ospf neighbor', 'Show OSPF neighbors', () => R.showOspfNeighbor(d))
    S('ospf interface', 'Show OSPF interface status', () => R.showOspfInterface(d))
    const routeOpts = (): Node[] => [
      kw('summary', 'Show route summary', { run: () => R.showRouteSummary(d) }),
      kw('terse', 'Display terse output', { run: () => R.showRoute(d, { terse: true }) }),
      kw('protocol', 'Name of protocol', { children: [prm({ kind: 'enum', label: '<protocol>', values: () => ['bgp', 'direct', 'local', 'ospf', 'static'] }, 'Protocol name', { name: 'proto', run: (c) => R.showRoute(d, { protocol: c.args['proto'] }) })] }),
      kw('receive-protocol', 'Show routes received from a protocol', { children: [kw('bgp', 'BGP', { children: [prm(ipP(), 'IP address of neighbor', { name: 'nb', run: (c) => this.rxRoutes(c.args['nb']!) })] })] }),
      kw('advertising-protocol', 'Show routes being sent by a protocol', { children: [kw('bgp', 'BGP', { children: [prm(ipP(), 'IP address of neighbor', { name: 'nb', run: (c) => this.txRoutes(c.args['nb']!) })] })] }),
      prm({ kind: 'word', label: '<destination>', test: (t) => /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(t) }, 'IP address and optional prefix length of destination', {
        name: 'dst',
        run: (c) => R.showRoute(d, { target: c.args['dst'] }),
        children: [kw('exact', 'Show exact route match', { run: (c) => R.showRoute(d, { target: c.args['dst'], exact: true }) }), kw('detail', 'Display detailed output', { run: (c) => R.showRoute(d, { target: c.args['dst'] }) })]
      })
    ]
    S('route', 'Show routing table information', () => R.showRoute(d), { children: routeOpts() })
    S('route forwarding-table', 'Show forwarding table information', () => R.showRoute(d, { terse: true }))
    S('arp', 'Show system Address Resolution Protocol table entries', () => R.showArp(d), { children: [kw('no-resolve', "Don't attempt to print addresses symbolically", { run: () => R.showArp(d) })] })
    S('lldp neighbors', 'Show LLDP neighbor information', () => R.showLldp(d))
    S('version', 'Show software process revision levels', () => R.showVersion(d))
    S('log', 'Show contents of log file', () => 'messages\ninteractive-commands\nchassisd\nlcdd\ndefault-log-messages')
    S('log messages', 'Main system log file', () => R.showLog(d))
    S('configuration', 'Show current configuration', () => this.showConfiguration([]), { children: [prm({ kind: 'line', label: '<statement>' }, 'Configuration statement path', { name: 'path', run: (c) => this.showConfiguration(tokenizeConf(c.args['path']!)) })] })
    S('system uptime', 'Show time since the system booted', () => R.showSystemUptime(d))
    S('system commit', 'Show pending commit and history', () => this.showCommits())
    S('system users', 'Show users who are currently logged in', () => `${R.isoTime(now(d)).slice(11, 16)}  up ${R.junosAge(d.bootedAt, now(d))}, 1 user, load averages: 0.32, 0.28, 0.25\nUSER     TTY      FROM                              LOGIN@  IDLE WHAT\n${this.user().padEnd(9)}pts/0    ${this.s.from.padEnd(34)}${R.isoTime(now(d) - 3600_000).slice(11, 16)}      - -cli (cli)`)
    S('system alarms', 'Show system alarm status', () => this.alarms())
    S('chassis alarms', 'Show alarm status', () => this.alarms())
    S('system processes', 'Show system process table', () => R.showProcesses(d), { children: [kw('extensive', 'Show exhaustive process information', { run: () => R.showProcesses(d) })] })
    S('system storage', 'Show local storage data', () => 'Filesystem              Size       Used      Avail  Capacity   Mounted on\n/dev/gpt/junos           20G       3.2G        15G       17%  /.mount')
    S('chassis hardware', 'Show installed hardware components', () => `Hardware inventory:\nItem             Version  Part number  Serial number     Description\nChassis                                ${d.serial}      VMX\nMidplane\nRouting Engine 0                                         RE-VMX\nFPC 0                                                    Virtual FPC\n  PIC 0                 BUILTIN      BUILTIN           Virtual`)
    S('chassis routing-engine', 'Show Routing Engine status', () => R.showRoutingEngine(d))
    S('cli', 'Show command-line interface settings', () => `CLI complete-on-space set to ${this.completeOnSpace ? 'on' : 'off'}\nCLI idle-timeout disabled\nCLI restart-on-upgrade set to on\nCLI screen-length set to ${this.s.pageLength}\nCLI screen-width set to 80\nCLI terminal is 'xterm'\nCLI is operating in enhanced mode`)
    add(op, 'configure', 'Manipulate software configuration information', () => this.enterConf(''), {
      children: [kw('exclusive', 'Obtain exclusive lock (other users cannot make changes)', { run: () => this.enterConf('exclusive') }), kw('private', 'Work in private database (other users cannot make changes)', { run: () => this.enterConf('private') })]
    })
    const cli = (path: string, help: string, param: Param, run: (v: string) => string): void => {
      add(op, `set cli ${path}`, help, undefined, { children: [prm(param, help, { name: 'v', run: (c) => run(c.args['v']!) })] }, { set: 'Set CLI properties, date/time, craft interface message', 'set cli': 'Set CLI properties' })
    }
    cli('screen-length', 'Set number of lines on screen', { kind: 'int', label: '<screen-length>', min: 0, max: 100000 }, (v) => ((this.s.pageLength = Number(v)), `Screen length set to ${v}`))
    cli('screen-width', 'Set number of characters on a line', { kind: 'int', label: '<screen-width>', min: 0, max: 1024 }, (v) => `Screen width set to ${v}`)
    cli('complete-on-space', 'Set whether typing space completes current word', { kind: 'enum', label: '<on|off>', values: () => ['on', 'off'] }, (v) => ((this.completeOnSpace = v === 'on'), `${v === 'on' ? 'Enabling' : 'Disabling'} complete-on-space`))
    cli('timestamp', 'Timestamp CLI output', { kind: 'line', label: '<format>' }, () => '')
    const pingRun = (c: Ctx): Promise<string> => this.ping(c)
    const pingOpts: Node[] = [
      kw('count', 'Number of ping requests to send', { children: [prm({ kind: 'int', label: '<count>', min: 1, max: 2000000000 }, 'Number of ping requests', { name: 'count', run: pingRun })] }),
      kw('rapid', 'Send requests rapidly (default count of 5)', { name: 'rapid', run: pingRun }),
      kw('source', 'Source address of echo request', { children: [prm({ kind: 'ipv4', label: '<source>' }, 'Source address', { name: 'src', run: pingRun })] }),
      kw('size', 'Size of request packets', { children: [prm({ kind: 'int', label: '<size>', min: 0, max: 65468 }, 'Size', { run: pingRun })] }),
      kw('routing-instance', 'Routing instance for ping attempt', { children: [prm({ kind: 'word', label: '<routing-instance>' }, 'Instance', { name: 'ri', run: pingRun })] })
    ]
    for (const o of pingOpts) for (const c of o.children ?? [o]) c.children = pingOpts
    for (const o of pingOpts) if (!o.children) o.children = pingOpts
    add(op, 'ping', 'Ping remote target', undefined, { children: [prm({ kind: 'word', label: '<host>' }, 'Hostname or IP address of remote host', { name: 'host', run: pingRun, children: pingOpts })] })
    add(op, 'traceroute', 'Trace route to remote host', undefined, { children: [prm({ kind: 'word', label: '<host>' }, 'Hostname or IP address of remote host', { name: 'host', run: (c) => this.trace(c.args['host']!), children: [kw('no-resolve', "Don't attempt to print addresses symbolically", { run: (c) => this.trace(c.args['host']!) })] })] })
    add(op, 'clear bgp neighbor', 'Clear BGP neighbor connections', () => this.clearBgp(), { children: [prm(ipP(), 'IP address of BGP peer', { name: 'nb', run: (c) => this.clearBgp(c.args['nb']) })] }, { clear: 'Clear information in the system', 'clear bgp': 'Clear BGP information' })
    add(op, 'clear interfaces statistics', 'Clear statistics on interfaces', undefined, {
      children: [kw('all', 'Clear statistics on all interfaces', { run: () => this.clearStats() }), prm(ifP(), 'Name of interface', { name: 'if', run: (c) => this.clearStats(c.args['if']) })]
    }, { 'clear interfaces': 'Clear interface information' })
    add(op, 'clear arp', 'Clear address-resolution information', () => '')
    add(op, 'request system reboot', 'Reboot the system', () => this.reboot('Reboot'), {}, { request: 'Make system-level requests', 'request system': 'System operations' })
    add(op, 'request system halt', 'Halt the system', () => this.reboot('Halt'))
    add(op, 'request system power-off', 'Power off the system', () => this.reboot('Power Off'))
    add(op, 'request system software add', 'Add extension or upgrade package', undefined, { children: [prm({ kind: 'line', label: '<package-name>' }, 'URL or pathname of package', { run: () => 'error: [simulator] software installation is not simulated' })] })
    add(op, 'file list', 'List file information', () => '/var/home/netops/:\n.ssh/', { children: [prm({ kind: 'word', label: '<path>' }, 'Path name', { run: (c) => `${c.params[0]}: No such file or directory` })] }, { file: 'Perform file operations' })
    add(op, 'file show', 'Show file contents', undefined, { children: [prm({ kind: 'word', label: '<filename>' }, 'Name of file', { run: (c) => `error: could not resolve file: ${c.params[0]}` })] })
    add(op, 'start shell', 'Start shell', () => 'error: [simulator] shell access is disabled on the simulator', { children: [kw('sh', 'Bourne shell', { run: () => 'error: [simulator] shell access is disabled on the simulator' }), kw('csh', 'C shell', { run: () => 'error: [simulator] shell access is disabled on the simulator' })] }, { start: 'Start shell' })
    add(op, 'monitor interface', 'Show interface traffic', undefined, { children: [prm(ifP(), 'Name of interface', { run: () => 'error: [simulator] monitor is not simulated; use show interfaces' })] }, { monitor: 'Show real-time debugging information' })
    add(op, 'help', 'Provide help information', () => 'Help is available with ? after any command.', { children: [prm({ kind: 'line', label: '<topic>' }, 'Help topic', { run: () => 'No help available for this topic.' })] })
    add(op, 'quit', 'Exit the management session', () => (this.s.close(), ''))
    add(op, 'exit', 'Exit the management session', () => (this.s.close(), ''))
    add(op, 'mtrace', 'Trace multicast path from source to receiver', undefined, { children: [prm({ kind: 'line', label: '<args>' }, 'mtrace arguments', { run: () => 'error: [simulator] mtrace is not simulated' })] })
    add(op, 'restart', 'Restart software process', undefined, { children: [prm({ kind: 'line', label: '<process>' }, 'Process name', { run: async () => ((await this.s.ask('Restart process? [yes,no] (no) ', { mode: 'line' })).trim().startsWith('y') ? 'error: [simulator] processes are not restarted on the simulator' : '') })] })
    add(op, 'ssh', 'Start secure shell on another host', undefined, { children: [prm({ kind: 'line', label: '<host>' }, 'Hostname or address of remote host', { run: (c) => `ssh: connect to host ${c.params[0]} port 22: Operation timed out` })] })
    add(op, 'telnet', 'Telnet to another host', undefined, { children: [prm({ kind: 'line', label: '<host>' }, 'Hostname or address of remote host', { run: (c) => `Trying ${c.params[0]}...\ntelnet: connect to address ${c.params[0]}: Operation timed out` })] })
    add(op, 'test', 'Perform diagnostic debugging', undefined, { children: [prm({ kind: 'line', label: '<args>' }, 'test arguments', { run: () => 'error: [simulator] test commands are not simulated' })] })
    op.sort((a, b) => (a.word ?? '').localeCompare(b.word ?? ''))
    return op
  }

  private buildConf(): Node[] {
    const line: Param = { kind: 'line', label: '<statement>' }
    const c: Node[] = []
    const k = (w: string, help: string, run: (rest: string) => string | Promise<string>, needsArgs = false): void => {
      c.push(kw(w, help, { ...(needsArgs ? {} : { run: (x) => run(x.args['rest'] ?? '') }), children: [prm(line, help, { name: 'rest', run: (x) => run(x.args['rest']!) })] }))
    }
    k('set', 'Set a parameter', (r) => this.cSet(r), true)
    k('delete', 'Delete a data element', (r) => this.cDelete(r), true)
    k('edit', 'Edit a sub-element', (r) => this.cEdit(r), true)
    k('up', 'Exit one level of configuration', (r) => this.cUp(r))
    k('top', 'Exit to top level of configuration', (r) => this.cTop(r))
    k('exit', 'Exit from this level', (r) => this.cExit(r))
    k('quit', 'Quit from this level', (r) => this.cExit(r))
    k('show', 'Show a parameter', (r) => this.cShow(r))
    k('commit', 'Commit current set of changes', (r) => this.cCommit(r))
    k('rollback', 'Roll back to previous committed configuration', (r) => this.cRollback(r))
    k('run', 'Run an operational-mode command', (r) => this.cRun(r), true)
    k('status', 'Show users currently editing configuration', () => `Users currently editing the configuration:\n  ${this.user()} terminal pts/0 (pid 7703) on since ${R.isoTime(now(this.d) - 600_000)}\n      [edit${this.edit.length ? ' ' + this.edit.join(' ') : ''}]`)
    k('load', 'Load configuration from ASCII file', () => 'error: [simulator] load is not simulated; use set/delete', true)
    k('deactivate', 'Remove the inactive tag from a statement', () => 'error: [simulator] deactivate is not simulated; use delete', true)
    k('activate', 'Remove the inactive tag from a statement', () => 'error: [simulator] activate is not simulated', true)
    k('annotate', 'Annotate the statement with a comment', () => '', true)
    k('help', 'Provide help information', () => 'Help is available with ? after any command.')
    c.sort((a, b) => a.word!.localeCompare(b.word!))
    return c
  }

  private groupCount(): number {
    return new Set(this.st.active.filter((l) => l.startsWith('protocols bgp group ')).map((l) => l.split(' ')[3])).size
  }

  // ------------------------------------------------------------------ execute

  async execute(raw: string): Promise<void> {
    if (this.conf) return this.execConf(raw)
    return this.execOp(raw)
  }

  private async execOp(raw: string, viaRun = false, shift = 0): Promise<void> {
    const [base, pipes] = splitPipes(raw)
    const m = match(base, this.op)
    if (!m.ok) {
      await this.s.print(this.opError(base, m, shift))
      return
    }
    let out = (await m.node.run!(m.ctx)) ?? ''
    let noMore = false
    if (pipes.length) {
      const r = this.applyPipes(out, pipes, { configShow: /^show\s+conf/.test(base.trim()) || m.ctx.words.slice(0, 2).join(' ') === 'show configuration', path: m.ctx.args['path'] })
      if ('error' in r) out = r.error
      else ({ out, noMore } = r)
    }
    void viaRun
    if (out) await this.s.print(out, { noMore })
  }

  private opError(base: string, m: Extract<ReturnType<typeof match>, { ok: false }>, shift = 0): string {
    const offs = tokenOffsets(base)
    const toks = tokenize(base)
    if (m.kind === 'ambiguous') {
      const tok = m.token
      const h = treeHelp(toks.slice(0, m.index).join(' ') + (m.index ? ' ' : '') + tok, this.op)
      const list = h.ok ? h.entries.map((e) => `  ${e.label.padEnd(21)}${e.help}`) : []
      return `${this.caretAt(shift + offs[m.index]! + tok.length)}\n'${tok}' is ambiguous.\nPossible completions:\n${list.join('\n')}`
    }
    if (m.kind === 'incomplete') {
      const h = treeHelp(base.trimEnd() + ' ', this.op)
      if (h.ok && h.entries.length) return `${this.caretAt(shift + base.trimEnd().length + 1)}\nsyntax error, expecting <command>.`.replace('<command>', h.entries[0]!.keyword ? '<command>' : h.entries[0]!.label)
      return `${this.caretAt(shift + base.trimEnd().length + 1)}\nsyntax error.`
    }
    const at = offs[m.index] ?? base.length
    if (m.index === 0) return `${this.caretAt(shift + at)}\nunknown command.`
    return `${this.caretAt(shift + at)}\nsyntax error, expecting <command>: ${m.token}`
  }

  private applyPipes(out: string, pipes: string[], ctx: { configShow: boolean; path?: string; conf?: boolean }): { out: string; noMore: boolean } | { error: string } {
    let lines = out.replace(/\n$/, '').split('\n')
    let noMore = false
    const names = ['compare', 'count', 'display', 'except', 'find', 'hold', 'last', 'match', 'no-more', 'request', 'resolve', 'save', 'trim']
    for (const p of pipes) {
      const [w = '', ...rest] = tokenizeConf(p)
      const hits = names.filter((n) => n.startsWith(w))
      const word = hits.length === 1 || names.includes(w) ? (names.includes(w) ? w : hits[0]!) : ''
      if (!word) return { error: `${this.caretAt(0)}\nsyntax error, expecting <command>: ${w}` }
      const arg = rest.map((r) => r.replace(/^"(.*)"$/, '$1')).join(' ')
      switch (word) {
        case 'match': {
          const re = safeRegex(arg.replace(/ /g, '|'), 'i')
          if (!re) return { error: 'error: invalid regular expression' }
          lines = lines.filter((l) => re.test(l))
          break
        }
        case 'except': {
          const re = safeRegex(arg.replace(/ /g, '|'), 'i')
          if (!re) return { error: 'error: invalid regular expression' }
          lines = lines.filter((l) => !re.test(l))
          break
        }
        case 'find': {
          const re = safeRegex(arg, 'i')
          const i = re ? lines.findIndex((l) => re.test(l)) : -1
          lines = i < 0 ? [] : lines.slice(i)
          break
        }
        case 'count':
          lines = [`Count: ${lines.filter((l) => l !== '').length} lines`]
          break
        case 'last': {
          const n = rest[0] ? Number(rest[0]) : this.s.pageLength || 24
          lines = lines.slice(-n)
          break
        }
        case 'trim': {
          const n = Number(rest[0] ?? 0)
          lines = lines.map((l) => l.slice(n))
          break
        }
        case 'no-more':
          noMore = true
          break
        case 'hold':
        case 'resolve':
          break
        case 'save':
          return { error: `Wrote ${lines.length} lines of output to '${arg}'` }
        case 'request':
          return { error: 'error: [simulator] request pipe is not simulated' }
        case 'display': {
          if (rest[0] && 'set'.startsWith(rest[0])) {
            if (!ctx.configShow) return { error: "error: 'display set' is only valid for configuration output" }
            lines = this.displaySet(ctx.conf ? this.st.candidate : this.st.active, ctx.conf ? [...this.edit, ...keysOf(tokenizeConf(ctx.path ?? ''))] : keysOf(tokenizeConf(ctx.path ?? '')))
          } else if (rest[0] && 'json'.startsWith(rest[0])) lines = ['{', `    "output" : ${JSON.stringify(lines.join('\n'))}`, '}']
          else if (rest[0] && 'xml'.startsWith(rest[0])) lines = [`<rpc-reply xmlns:junos="http://xml.juniper.net/junos/${this.d.version}/junos">`, '    <output>', ...lines.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')), '    </output>', '</rpc-reply>']
          else if (rest[0] && !'detail'.startsWith(rest[0])) return { error: `syntax error, expecting <command>: ${rest[0]}` }
          break
        }
        case 'compare': {
          if (!ctx.configShow) return { error: "error: 'compare' is only valid for configuration output" }
          const n = rest[0] && 'rollback'.startsWith(rest[0]) ? Number(rest[1] ?? 0) : 0
          const base = this.st.history[n]
          if (!base) return { error: `error: rollback ${n} does not exist` }
          const target = ctx.conf ? this.st.candidate : this.st.active
          lines = compareTrees(buildTree(base.lines), buildTree(target))
          if (!lines.length) return { out: '', noMore }
          break
        }
      }
    }
    return { out: lines.join('\n'), noMore }
  }

  private displaySet(src: string[], path: string[]): string[] {
    return src
      .filter((l) => {
        const k = keysOf(tokenizeConf(l))
        return path.every((p, i) => k[i] === p)
      })
      .map((l) => `set ${l}`)
  }

  private showConfiguration(path: string[]): string {
    const keys = keysOf(path)
    const tree = buildTree(this.st.active)
    if (!keys.length) {
      const last = this.st.history[0]!
      return [`## Last commit: ${R.isoTime(last.at)} by ${last.user}`, ...renderTree(tree)].join('\n')
    }
    const n = subtree(tree, keys)
    if (!n) return ''
    return renderTree(n).join('\n')
  }

  private ifDetail(c: Ctx, extensive: boolean): string {
    const name = c.args['if']!.replace(/\.0$/, '')
    const i = this.d.interfaces.find((x) => x.name === name)
    if (!i) return `error: device ${name} not found`
    return R.showInterface(this.d, i, extensive)
  }

  private rxRoutes(ip: string): string {
    const n = this.d.bgp.find((x) => x.ip === ip)
    if (!n || n.upSince === undefined || n.upSince > now(this.d)) return ''
    return ['', 'inet.0: 7 destinations, 7 routes (7 active, 0 holddown, 0 hidden)', '  Prefix                  Nexthop              MED     Lclpref    AS path', ...(n.routes ?? []).map((r) => `* ${`${r.prefix}/${r.mask}`.padEnd(24)}${n.ip.padEnd(21)}${''.padEnd(19)}${n.remoteAs} I`)].join('\n')
  }

  private txRoutes(ip: string): string {
    const n = this.d.bgp.find((x) => x.ip === ip)
    if (!n || n.upSince === undefined || n.upSince > now(this.d)) return ''
    const pl = this.d.prefixLists.flatMap((p) => p.entries.map((e) => e.prefix))
    return ['', 'inet.0: 7 destinations, 7 routes (7 active, 0 holddown, 0 hidden)', '  Prefix                  Nexthop              MED     Lclpref    AS path', ...pl.map((p) => `* ${p.padEnd(24)}${'Self'.padEnd(21)}${''.padEnd(19)}I`)].join('\n')
  }

  private showCommits(): string {
    const st = this.st
    const rows: string[] = []
    st.history.forEach((h, k) => {
      const pending = k === 0 && st.confirm ? `, rollback in ${Math.max(1, Math.ceil((st.confirm.deadline - now(this.d)) / 60000))}mins` : ''
      rows.push(`${String(k).padEnd(4)}${R.isoTime(h.at)} by ${h.user} via ${h.how}${pending}`)
      if (h.comment) rows.push(`    ${h.comment}`)
    })
    return rows.join('\n')
  }

  private alarms(): string {
    const down = this.d.interfaces.filter((i) => /^(ge|xe|et)-/.test(i.name) && i.adminUp && !isUp(i))
    if (!down.length) return 'No alarms currently active'
    return [`${down.length} alarms currently active`, 'Alarm time               Class  Description', ...down.map((i) => `${R.isoTime(i.lastChange ?? this.d.bootedAt)} Major  ${i.name}: Link down`)].join('\n')
  }

  private clearBgp(ip?: string): string {
    const d = this.d
    const list = ip ? d.bgp.filter((n) => n.ip === ip) : d.bgp
    if (ip && !list.length) return `error: peer ${ip} not found`
    for (const n of list) {
      if (n.upSince !== undefined) logEvent(d, `rpd[5123]: BGP_NEIGHBOR_STATE_CHANGED: BGP peer ${n.ip} (External AS ${n.remoteAs}) changed state from Established to Idle (event Stop) (instance master)`)
      n.upSince = undefined
      n.downSince = now(d)
    }
    tickBgp(d)
    return 'Cleared 1 connections'.replace('1', String(list.length))
  }

  private clearStats(name?: string): string {
    const t = now(this.d)
    for (const i of name ? this.d.interfaces.filter((x) => x.name === name.replace(/\.0$/, '')) : this.d.interfaces) {
      i.clearedAt = t
      i.errors = undefined
      if (i.faultSince !== undefined) i.faultSince = t
    }
    return ''
  }

  private async reboot(what: string): Promise<string> {
    const a = (await this.s.ask(`${what} the system ? [yes,no] (no) `, { mode: 'line' })).trim().toLowerCase()
    if (a !== 'yes' && a !== 'y') return ''
    return `\n*** FINAL System shutdown message from ${this.user()}@${this.d.hostname} ***\n\nSystem going down IMMEDIATELY\n\n%% [simulator] ${what.toLowerCase()} acknowledged. The simulator never reboots.`
  }

  private reachable(ip: string): boolean {
    const d = this.d
    if (d.interfaces.some((i) => i.ip === ip && isUp(i))) return true
    const rs = R.routes(d)
    return rs.some((r) => r.proto !== 'Local' && r.prefix !== '0.0.0.0' && ipIn(ip, r.prefix, r.mask)) || (rs.some((r) => r.mask === 0) && !/^192\.0\.2\./.test(ip))
  }

  private async ping(c: Ctx): Promise<string> {
    const host = c.args['host']!
    if (!isIpv4(host)) return `ping: cannot resolve ${host}: Unknown host`
    const rapid = c.args['rapid'] !== undefined
    const count = c.args['count'] ? Number(c.args['count']) : rapid ? 5 : Infinity
    const ok = this.reachable(host)
    await this.s.print(`PING ${host} (${host}): 56 data bytes`)
    let sent = 0
    let got = 0
    const times: number[] = []
    while (sent < count) {
      if (!(await this.s.sleep(rapid ? 40 : 1000))) {
        this.s.write('^C\r\n')
        break
      }
      const ms = 0.7 + ((sent * 37) % 23) / 100
      if (ok) {
        got++
        times.push(ms)
        if (rapid) this.s.write('!')
        else await this.s.print(`64 bytes from ${host}: icmp_seq=${sent} ttl=64 time=${ms.toFixed(3)} ms`)
      } else if (rapid) this.s.write('.')
      else await this.s.print(`Request timeout for icmp_seq ${sent}`)
      sent++
    }
    if (rapid) this.s.write('\r\n')
    const loss = sent ? Math.round(((sent - got) / sent) * 100) : 0
    const stats = [`--- ${host} ping statistics ---`, `${sent} packets transmitted, ${got} packets received, ${loss}% packet loss`]
    if (got) {
      const min = Math.min(...times)
      const max = Math.max(...times)
      const avg = times.reduce((a, b) => a + b, 0) / times.length
      stats.push(`round-trip min/avg/stddev/max = ${min.toFixed(3)}/${avg.toFixed(3)}/0.088/${max.toFixed(3)} ms`)
    }
    return stats.join('\n')
  }

  private async trace(host: string): Promise<string> {
    if (!isIpv4(host)) return `traceroute: unknown host ${host}`
    await this.s.print(`traceroute to ${host} (${host}), 30 hops max, 52 byte packets`)
    const d = this.d
    const loop = (d.remoteRoutes ?? []).find((r) => ipIn(host, r.prefix, r.mask))
    const hops: string[] = []
    if (loop) for (let k = 0; k < 12; k++) hops.push(k % 2 === 0 ? loop.at : loop.via)
    else if (this.reachable(host)) {
      const direct = d.interfaces.some((i) => i.ip && i.mask! < 32 && ipIn(host, i.ip, i.mask!) && isUp(i))
      if (!direct) hops.push(d.bgp.find((n) => n.upSince !== undefined)?.ip ?? host)
      hops.push(host)
    } else hops.push('*', '*', '*')
    for (let k = 0; k < hops.length; k++) {
      if (!(await this.s.sleep(hops[k] === '*' ? 500 : 80))) break
      await this.s.print(hops[k] === '*' ? `${String(k + 1).padStart(2)}  * * *` : `${String(k + 1).padStart(2)}  ${hops[k]} (${hops[k]})  ${(0.8 + k).toFixed(3)} ms  ${(0.7 + k).toFixed(3)} ms  ${(0.9 + k).toFixed(3)} ms`)
    }
    return ''
  }

  // ------------------------------------------------------------------ configuration mode

  private enterConf(kind: string): string {
    const shared = junosStore(this.d)
    // Junos refuses a private database while the shared candidate holds someone's uncommitted changes.
    if (kind === 'private' && shared.candidate.join('\n') !== shared.active.join('\n'))
      return `error: shared configuration database modified\nUsers currently editing the configuration:\n  ${this.user()} terminal pts/1 (pid 4811) on since ${R.isoTime(now(this.d) - 600_000).slice(0, 16)} UTC\n      [edit]`
    if (kind === 'private') this.priv = [...shared.active]
    this.conf = true
    this.edit = []
    this.stack = []
    logEvent(this.d, `mgd[7703]: UI_DBASE_LOGIN_EVENT: User '${this.user()}' entering configuration mode`)
    const st = this.st
    const dirty = st.candidate.join('\n') !== st.active.join('\n')
    const lines: string[] = []
    if (kind === 'exclusive' || kind === 'private') lines.push('warning: uncommitted changes will be discarded on exit')
    lines.push('Entering configuration mode')
    if (dirty) lines.push('The configuration has been changed but not committed')
    return lines.join('\n')
  }

  private leaveConf(): void {
    // A private database is discarded on exit; uncommitted changes there never reach the shared one.
    this.priv = null
    this.conf = false
    this.edit = []
    this.stack = []
    logEvent(this.d, `mgd[7703]: UI_DBASE_LOGOUT_EVENT: User '${this.user()}' exiting configuration mode`)
  }

  private async execConf(raw: string): Promise<void> {
    const [base] = splitPipes(raw)
    const m = match(base, this.ct)
    if (!m.ok) {
      const offs = tokenOffsets(base)
      if (m.kind === 'ambiguous') {
        await this.s.print(`${this.caretAt(offs[m.index]! + m.token.length)}\n'${m.token}' is ambiguous.`)
        return
      }
      if (m.kind === 'incomplete') {
        await this.s.print(`${this.caretAt(base.trimEnd().length + 1)}\nsyntax error, expecting <statement> or <identifier>.`)
        return
      }
      await this.s.print(`${this.caretAt(offs[m.index] ?? 0)}\nunknown command.`)
      return
    }
    // The tree swallows the rest of the line (including pipes) into `rest`; show/run re-split it.
    const word = m.ctx.words[0]!
    if (word === 'show' || word === 'run') m.ctx.args['rest'] = raw.slice(raw.search(/\S/) + (tokenize(raw)[0]?.length ?? 0)).trim()
    const out = (await m.node.run!(m.ctx)) ?? ''
    if (out) await this.s.print(out)
  }

  private abs(rest: string): string[] {
    return [...this.edit.flatMap((k) => tokenizeConf(k)), ...tokenizeConf(rest)]
  }

  private validate(rest: string): string | undefined {
    const toks = tokenizeConf(rest)
    const offs = tokenOffsets(rest)
    const cmdLen = 4 // "set " / the verb and a space
    const all = this.abs(rest)
    if (!this.edit.length && toks[0] && !SCHEMA[toks[0]]) return `${this.caretAt(cmdLen + (offs[0] ?? 0))}\nsyntax error.`
    // Junos checks that a value follows statements that need one.
    const sc = schemaAt(all)
    if (sc?.value) return `${this.caretAt(cmdLen + rest.trimEnd().length + 1)}\nsyntax error, expecting ${sc.value}.`
    // Light value checks.
    const addr = all.indexOf('address')
    if (addr >= 0 && all[addr - 1] !== 'prefix-list' && all.includes('inet') && all[addr + 1] && !/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(all[addr + 1]!)) {
      const at = toks.indexOf(all[addr + 1]!)
      return `${this.caretAt(cmdLen + (offs[at] ?? 0))}\nsyntax error, expecting <address>.`
    }
    return undefined
  }

  private cSet(rest: string): string {
    if (!rest.trim()) return `${this.caretAt(4)}\nsyntax error, expecting <statement> or <identifier>.`
    const err = this.validate(rest)
    if (err) return err
    const st = this.st
    st.candidate = setLine(st.candidate, this.abs(rest).join(' '))
    return ''
  }

  private cDelete(rest: string): string {
    const st = this.st
    const path = this.abs(rest).join(' ')
    if (!path) {
      st.candidate = []
      return ''
    }
    const r = deleteLines(st.candidate, path)
    if (r.notFound) return 'warning: statement not found'
    st.candidate = r.lines
    return ''
  }

  private cEdit(rest: string): string {
    const toks = tokenizeConf(rest)
    if (!this.edit.length && toks[0] && !SCHEMA[toks[0]]) return `${this.caretAt(5 + (tokenOffsets(rest)[0] ?? 0))}\nsyntax error.`
    this.stack.push(this.edit)
    this.edit = keysOf(this.abs(rest))
    return ''
  }

  private cUp(rest: string): string {
    const n = Number(tokenize(rest)[0] ?? 1) || 1
    if (!this.edit.length) return 'warning: Already at the top of the configuration.'
    this.stack.push(this.edit)
    this.edit = this.edit.slice(0, Math.max(0, this.edit.length - n))
    return ''
  }

  private async cTop(rest: string): Promise<string> {
    this.stack = []
    this.edit = []
    if (rest.trim()) await this.execConf(rest)
    return ''
  }

  private async cExit(rest: string): Promise<string> {
    const st = this.st
    const dirty = st.candidate.join('\n') !== st.active.join('\n')
    if (/^conf/.test(rest.trim())) {
      if (dirty) await this.s.print('The configuration has been changed but not committed')
      this.leaveConf()
      return 'Exiting configuration mode'
    }
    if (this.edit.length) {
      this.edit = this.stack.pop() ?? []
      return ''
    }
    if (dirty) {
      await this.s.print('The configuration has been changed but not committed')
      const a = (await this.s.ask('Exit with uncommitted changes? [yes,no] (yes) ', { mode: 'line' })).trim().toLowerCase()
      if (a && a !== 'yes' && a !== 'y') return ''
    }
    this.leaveConf()
    return 'Exiting configuration mode'
  }

  private cShow(rest: string): string {
    const [base, pipes] = splitPipes(rest)
    const keys = [...this.edit, ...keysOf(tokenizeConf(base))]
    let out: string
    const tree = buildTree(this.st.candidate)
    if (!keys.length) {
      const last = this.st.history[0]!
      out = [`## Last changed: ${R.isoTime(last.at)}`, ...renderTree(tree)].join('\n')
    } else {
      const n = subtree(tree, keys)
      out = n ? renderTree(n).join('\n') : ''
    }
    if (pipes.length) {
      const r = this.applyPipes(out, pipes, { configShow: true, conf: true, path: base })
      return 'error' in r ? r.error : r.out
    }
    return out
  }

  private issues(): string | undefined {
    const list = checkLines(this.st.candidate)
    if (!list.length) return undefined
    return [...list.flatMap((i) => [`[edit ${i.path}]`, ...(i.statement ? [`  '${i.statement}'`] : []), `    ${i.message}`]), 'error: configuration check-out failed'].join('\n')
  }

  private cCommit(rest: string): string {
    const toks = tokenizeConf(rest)
    const st = this.st
    const d = this.d
    const has = (w: string): boolean => toks.some((t) => w.startsWith(t) && t.length >= 2 && w.startsWith(t))
    if (toks[0] && 'check'.startsWith(toks[0])) return this.issues() ?? 'configuration check succeeds'
    const bad = this.issues()
    if (bad) return bad
    const ci = toks.findIndex((t) => 'comment'.startsWith(t) && t.length >= 3)
    const comment = ci >= 0 ? toks[ci + 1]?.replace(/^"(.*)"$/, '$1') : undefined
    const confirmed = toks.length > 0 && 'confirmed'.startsWith(toks[0]!) && toks[0]!.length >= 5
    const mins = confirmed && toks[1] && /^\d+$/.test(toks[1]) ? Number(toks[1]) : 10
    const andQuit = has('and-quit')
    const out: string[] = []
    const t = now(d)
    const changed = st.candidate.join('\n') !== st.active.join('\n')
    if (st.confirm && !confirmed) {
      runtime(d).cancel('junos-commit-confirm')
      st.confirm = undefined
    }
    void changed
    {
      st.history.unshift({ lines: [...st.candidate], at: t, user: this.user(), how: confirmed ? 'cli commit confirmed' : 'cli', ...(comment ? { comment } : {}) })
      if (st.history.length > 50) st.history.length = 50
    }
    st.active = [...st.candidate]
    syncDevice(d, st.active)
    ;(d.vendor as { junosLastCommit?: number }).junosLastCommit = t
    tickBgp(d)
    logEvent(d, `mgd[7703]: UI_COMMIT: User '${this.user()}' requested '${confirmed ? 'commit confirmed' : 'commit'}' operation${comment ? ` (comment: ${comment})` : ''}`)
    if (confirmed) {
      st.confirm = { deadline: t + mins * 60000, minutes: mins }
      runtime(d).timer('junos-commit-confirm', mins * 60000, () => this.autoRollback())
      out.push(`commit confirmed will be automatically rolled back in ${mins} minute${mins === 1 ? '' : 's'} unless confirmed`)
    }
    out.push('commit complete')
    if (andQuit) {
      this.leaveConf()
      out.push('Exiting configuration mode')
    }
    return out.join('\n')
  }

  /** Timer expiry of `commit confirmed`: restore the previous commit and tell everyone. */
  private autoRollback(): void {
    const d = this.d
    const st = this.st
    if (!st.confirm) return
    const prev = st.history[1]
    st.confirm = undefined
    if (!prev) return
    const t = now(d)
    st.history.unshift({ lines: [...prev.lines], at: t, user: 'root', how: 'other (rollback 1)' })
    st.active = [...prev.lines]
    st.candidate = [...prev.lines]
    syncDevice(d, st.active)
    tickBgp(d)
    logEvent(d, 'mgd[7703]: UI_COMMIT_NOT_CONFIRMED: Commit was not confirmed; automatic rollback complete')
    runtime(d).broadcast(`\nBroadcast Message from root@${d.hostname}\n        (no tty) at ${R.isoTime(t).slice(0, 16)} UTC...\n\nCommit was not confirmed; automatic rollback complete.\n`)
  }

  private cRollback(rest: string): string {
    const n = Number(tokenize(rest)[0] ?? 0)
    if (!Number.isInteger(n) || n < 0 || n > 49) return `${this.caretAt(9)}\nsyntax error, expecting <number>.`
    const h = this.st.history[n]
    if (!h) return `error: rollback ${n} does not exist`
    this.st.candidate = [...h.lines]
    return 'load complete'
  }

  private async cRun(rest: string): Promise<string> {
    const shift = this.promptText().length
    void shift
    await this.execOp(rest, true, 4)
    return ''
  }

  // ------------------------------------------------------------------ help & completion

  help(line: string): string {
    if (this.conf) return this.confHelp(line)
    const [base, pipes] = splitPipes(line)
    if (pipes.length || /\|\s*$/.test(line)) return this.pipeHelp()
    const h = treeHelp(base, this.op)
    return this.formatHelp(base, h)
  }

  private pipeHelp(): string {
    return [
      'Possible completions:',
      '  compare              Compare configuration changes with prior version',
      '  count                Count occurrences',
      '  display              Show additional kinds of information',
      '  except               Show only text that does not match a pattern',
      '  find                 Search for first occurrence of pattern',
      '  hold                 Hold text without exiting the --More-- prompt',
      '  last                 Display end of output only',
      '  match                Show only text that matches a pattern',
      '  no-more              Don\'t paginate output',
      '  request              Make system-level requests',
      '  resolve              Resolve IP addresses',
      '  save                 Save output text to file',
      '  trim                 Trim specified number of columns from start of line'
    ].join('\n')
  }

  private formatHelp(base: string, h: HelpResult): string {
    if (!h.ok) {
      const offs = tokenOffsets(base)
      return `${this.caretAt(offs[h.index] ?? 0)}\nsyntax error, expecting <command>: ${h.token}`
    }
    if (h.partial) {
      const kws = h.entries.filter((e) => e.keyword)
      if (!kws.length) return `No valid completions`
      const w = Math.max(...kws.map((e) => e.label.length)) + 2
      return ['Possible completions:', ...kws.map((e) => `${e.label.padEnd(w)}${e.help}`)].join('\n')
    }
    const rows: string[] = ['Possible completions:']
    if (h.cr) rows.push('  <[Enter]>            Execute this command')
    for (const e of h.entries) rows.push(`  ${e.label.padEnd(21)}${e.help}`)
    if (h.cr && /^\s*show\b/.test(base)) rows.push('  |                    Pipe through a command')
    return rows.join('\n')
  }

  private confPath(line: string): { verb?: string; toks: string[]; partial: string; verbHelp?: boolean } {
    const toks = tokenizeConf(line)
    const endsSpace = line === '' || /\s$/.test(line)
    const partial = endsSpace ? '' : (toks.pop() ?? '')
    if (!toks.length) return { toks: [], partial, verbHelp: true }
    const t0 = toks[0]!
    const hits = this.ct.filter((n) => n.word === t0 || n.word!.startsWith(t0))
    const verb = hits.find((n) => n.word === t0)?.word ?? (hits.length === 1 ? hits[0]!.word : undefined)
    return { verb, toks: toks.slice(1), partial }
  }

  private confOptions(verb: string, toks: string[]): { word: string; help: string; container: boolean }[] | { value: string; help?: string } | undefined {
    if (!['set', 'delete', 'edit', 'show'].includes(verb)) return undefined
    const abs = [...this.edit.flatMap((k) => tokenizeConf(k)), ...toks]
    const sc = schemaAt(abs)
    if (!sc) return undefined
    if (sc.value) return { value: sc.value, help: sc.help }
    const out = Object.entries(sc.kids).map(([word, n]) => ({ word, help: n.help, container: !n.leaf }))
    // Existing names under the current path (interfaces, groups, ...).
    const node = subtree(buildTree(this.st.candidate), keysOf(abs))
    for (const c of node?.children ?? []) {
      const w = c.key.split(' ')[0]!
      if (!out.some((o) => o.word === w)) out.push({ word: w, help: '', container: !c.leaf })
    }
    return out.sort((a, b) => a.word.localeCompare(b.word))
  }

  private confHelp(line: string): string {
    const p = this.confPath(line)
    const rows = ['Possible completions:']
    if (p.verbHelp) {
      for (const n of this.ct) if (n.word!.startsWith(p.partial)) rows.push(`  ${n.word!.padEnd(21)}${n.help}`)
      return rows.join('\n')
    }
    if (!p.verb) return `${this.caretAt(0)}\nunknown command.`
    const opts = this.confOptions(p.verb, p.toks)
    if (!opts) {
      if (p.verb === 'commit') rows.push('  <[Enter]>            Execute this command', '  and-quit             Quit configuration mode if commit succeeds', '  check                Check correctness of syntax; do not apply changes', '  comment              Message to write to commit log', '  confirmed            Automatically rollback if not confirmed', '  synchronize          Synchronize commit on both Routing Engines', '  |                    Pipe through a command')
      else rows.push('  <[Enter]>            Execute this command')
      return rows.join('\n')
    }
    if ('value' in opts) {
      rows.push(`  ${opts.value.padEnd(21)}${opts.help ?? ''}`.trimEnd())
      return rows.join('\n')
    }
    if (!p.partial && p.verb !== 'set') rows.push('  <[Enter]>            Execute this command')
    for (const o of opts) if (o.word.startsWith(p.partial)) rows.push(`${o.container ? '>' : '+'.replace('+', ' ')} ${o.word.padEnd(21)}${o.help}`)
    if (p.verb === 'show' && !p.partial) rows.push('  |                    Pipe through a command')
    return rows.join('\n')
  }

  private candidates(line: string, withValues: boolean): { partial: string; words: { word: string; help: string }[]; exact: boolean } {
    const toks = tokenize(line)
    const partial = /\s$/.test(line) || !line ? '' : (toks.at(-1) ?? '')
    if (!partial) return { partial, words: [], exact: false }
    if (this.conf) {
      const p = this.confPath(line)
      if (p.verbHelp) {
        const ws = this.ct.filter((n) => n.word!.startsWith(partial)).map((n) => ({ word: n.word!, help: n.help }))
        return { partial, words: ws, exact: ws.some((w) => w.word === partial) }
      }
      const opts = p.verb ? this.confOptions(p.verb, p.toks) : undefined
      if (!opts || 'value' in opts) return { partial, words: [], exact: false }
      const ws = opts.filter((o) => o.word.startsWith(partial) && (withValues || o.help !== '')).map((o) => ({ word: o.word, help: o.help }))
      return { partial, words: ws, exact: ws.some((w) => w.word === partial) }
    }
    const before = line.slice(0, line.length - partial.length)
    const h = treeHelp(line, this.op)
    const kws = h.ok ? h.entries.filter((e) => e.keyword).map((e) => ({ word: e.label, help: e.help })) : []
    const exact = kws.some((k) => k.word === partial)
    let words = kws
    if (withValues && !exact) {
      const c = completions(before + partial, this.op)
      for (const o of c.options) if (!words.some((w) => w.word === o)) words.push({ word: o, help: '' })
    }
    return { partial, words, exact }
  }

  private completeWith(line: string, withValues: boolean): TabResult | null {
    const c = this.candidates(line, withValues)
    if (!c.partial || c.exact) return null
    if (c.words.length === 1) return { line: line.slice(0, line.length - c.partial.length) + c.words[0]!.word + ' ' }
    if (!c.words.length) return null
    return { list: [`'${c.partial}' is ambiguous.`, 'Possible completions:', ...c.words.map((w) => `${w.word.padEnd(23)}${w.help}`), ''].join('\n') }
  }

  tab(line: string): TabResult {
    return this.completeWith(line, true) ?? { bell: true }
  }

  space(line: string): TabResult | null {
    if (!this.completeOnSpace) return null
    return this.completeWith(line, false)
  }

  control(key: 'c' | 'z', _line: string): ControlResult {
    if (key === 'z') return { keepLine: true }
    return { echo: '\n' }
  }
}

function ipIn(ip: string, net: string, mask: number): boolean {
  const n = (s: string): number => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
  const m = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0
  return ((n(ip) & m) >>> 0) === ((n(net) & m) >>> 0)
}

export const junosFactory = (s: Session): JunosPersonality => new JunosPersonality(s)
