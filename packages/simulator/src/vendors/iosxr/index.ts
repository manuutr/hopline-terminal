/**
 * Cisco IOS XR personality (7.x, ASR 9000). Two-stage configuration: config mode edits a
 * per-session target config (a clone of the device), `show configuration` shows the uncommitted
 * changes, `commit` applies them to the running config and records a commit point; `commit
 * confirmed` rolls back on a device timer unless confirmed by another `commit`; `rollback
 * configuration last N | to <id>` walks the commit database.
 *
 * No research doc exists for IOS XR. Strings are from memory and marked `[unverified, from
 * memory]` where I am not sure of them; the error/caret format is the IOS one.
 */
import type { ControlResult, Session } from '../../core/personality.ts'
import { now, runtime, setClock } from '../../core/runtime.ts'
import { add, dottedToLen, isIpv4, kw, prm, type Ctx, type HelpResult, type Node, type Param } from '../../core/tree.ts'
import { inSubnet, splitPipes } from '../../core/text.ts'
import { CiscoBase, ciscoHelpList, type CMode, type Failure, type PipeOutcome } from '../cisco/base.ts'
import { IOS_PAGER, reachable } from '../ios/index.ts'
import { deviceFrom, logEvent, restore, snapshot, tickBgp, type ConfigSnapshot, type Device, type Iface } from '../../state.ts'
import { applyPipes } from './pipes.ts'
import { configBody, configDiff, findXrIf, parseXrIf, runningConfig, xrLogPrefix, xrStamp, xrStore, type XrCommit } from './config.ts'
import * as R from './render.ts'

const SUFFIX: Record<string, string> = {
  config: '(config)',
  'config-if': '(config-if)',
  'config-bgp': '(config-bgp)',
  'config-bgp-af': '(config-bgp-af)',
  'config-bgp-nbr': '(config-bgp-nbr)',
  'config-bgp-nbr-af': '(config-bgp-nbr-af)',
  'config-bgp-vrf': '(config-bgp-vrf)',
  'config-ospf': '(config-ospf)',
  'config-ospf-ar': '(config-ospf-ar)',
  'config-ospf-ar-if': '(config-ospf-ar-if)',
  'config-static': '(config-static)',
  'config-static-afi': '(config-static-afi)',
  'config-static-vrf': '(config-static-vrf)',
  'config-static-vrf-afi': '(config-static-vrf-afi)',
  'config-vrf': '(config-vrf)',
  'config-vrf-af': '(config-vrf-af)',
  'config-ipv4-acl': '(config-ipv4-acl)',
  'config-rpl': '(config-rpl)',
  'config-pfx': '(config-pfx)'
}

const HELP: Record<string, string> = {
  show: 'Show commands',
  bgp: 'BGP show commands',
  ipv4: 'IPv4 show commands',
  ospf: 'OSPF information',
  route: 'Show IP routing table',
  configuration: 'Contents of a configuration',
  'configuration commit': 'Show commit information',
  interfaces: 'Interface status and configuration',
  terminal: 'Set terminal line parameters',
  'terminal exec': 'Configure exec',
  'terminal exec prompt': 'Configure exec prompt options',
  rollback: 'Roll back configuration changes',
  'rollback configuration': 'Rollback configuration changes',
  rpl: 'Routing Policy Language information',
  clear: 'Clear or reset functions',
  processes: 'Process information'
}

const CONFIRM_TIMER = 'iosxr-commit-confirmed'
const BLD = 'Building configuration...'

/** Arm the commit-confirmed rollback on the device (not the session: it must fire after logout). */
function armConfirm(d: Device, ms: number): void {
  runtime(d).timer(CONFIRM_TIMER, ms, () => {
    const st = xrStore(d)
    const tr = st.trial
    if (!tr) return
    const cur = snapshot(d)
    restore(d, tr.before)
    st.trial = undefined
    const t = now(d)
    const id = String(++st.seq)
    st.commits.unshift({ id, user: 'system', line: 'cfgmgr', client: 'Rollback', t, before: cur, after: snapshot(d) })
    st.lastChange = { t, by: 'system' }
    // [unverified, from memory] exact syslog text of the confirmed-commit rollback.
    const msg = `cfgmgr-rp[150]: %MGBL-CONFIG-6-DB_COMMIT : Configuration committed by user 'system'. Use 'show configuration commit changes ${id}' to view the changes.`
    const msg2 = `cfgmgr-rp[150]: %MGBL-CFGMGR-6-CONFIRMED_COMMIT_ROLLBACK : Rolled back trial commit ${tr.id}: commit confirmed timer expired without a confirming commit`
    logEvent(d, msg2, t)
    logEvent(d, msg, t)
    tickBgp(d)
    runtime(d).broadcast(`${xrLogPrefix(t)}${msg2}`)
  })
}

/** A throwaway editable copy of the device on the device's clock. */
function clone(d: Device): Device {
  const c = deviceFrom(d, snapshot(d))
  setClock(c, runtime(d).clock)
  return c
}

const text = (d: Device): string => configBody(d).join('\n')

export class IosxrPersonality extends CiscoBase {
  pager = IOS_PAGER
  private trees: Record<string, Node[]> | undefined
  /** The target configuration edited in config mode (null outside config mode). */
  private target: Device | null = null
  /** Config text the target was cloned from. */
  private baseText = ''
  /** Exec timestamp line before command output (`terminal exec prompt no-timestamp`). */
  private stamp = true
  /** Multi-line route-policy / prefix-set entry. */
  private collect: { kind: 'rpl' | 'pfx'; name: string; lines: string[] } | null = null

  constructor(s: Session) {
    super(s)
  }

  /** Where config commands write: the target in config mode. */
  private get cfg(): Device {
    return this.target ?? this.d
  }

  override hostPart(): string {
    return `RP/0/RSP0/CPU0:${this.d.hostname}`
  }

  override banner(): string {
    return this.d.motd !== undefined ? `\n${this.d.motd}\n\n` : '\n'
  }

  protected suffix(m: CMode): string {
    return SUFFIX[m.id] ?? ''
  }

  // ------------------------------------------------------------------ errors and help (IOS style)

  protected errInvalid(_line: string, f: Failure): string {
    return `${this.caret(f.offset)}\n% Invalid input detected at '^' marker.`
  }
  protected errAmbiguous(line: string): string {
    return `% Ambiguous command:  "${line.trim()}"`
  }
  protected errIncomplete(): string {
    return '% Incomplete command.'
  }
  protected helpPartial(words: string[]): string {
    return words.length ? `${words.join('  ')}  \n` : '% Unrecognized command\n'
  }
  protected helpList(h: Extract<HelpResult, { ok: true }>): string {
    if (!h.entries.length && !h.cr) return '% Unrecognized command\n'
    return ciscoHelpList(h, { cr: '' }) + '\n'
  }
  protected override pipeHelp(): string {
    // [unverified, from memory]
    return ['  begin    Begin with the line that matches', '  exclude  Exclude lines that match', '  file     Save the configuration', '  include  Include lines that match', '  utility  A set of common unix utilities', ''].join('\n')
  }
  protected pipes(out: string, pipes: string[], raw: string): PipeOutcome | { error: string } {
    return applyPipes(out, pipes, raw, ['begin', 'exclude', 'file', 'include', 'utility'], {
      invalid: (at) => `${this.caret(at)}\n% Invalid input detected at '^' marker.`,
      ambiguous: () => `% Ambiguous command:  "${raw.trim()}"`,
      incomplete: () => '% Incomplete command.'
    })
  }

  // ------------------------------------------------------------------ prompt

  override prompt(): string {
    if (this.collect) return `${this.hostPart()}${this.collect.kind === 'rpl' ? '(config-rpl)' : '(config-pfx)'}#`
    return this.promptText()
  }

  protected override promptLen(): number {
    return this.prompt().length
  }

  // ------------------------------------------------------------------ execute

  override async execute(raw: string): Promise<void> {
    if (this.collect) return this.collectLine(raw)
    const [base, pipes] = splitPipes(raw)
    const r = this.resolve(base)
    if (!r.m.ok) {
      const f = { ...r.m, offset: r.m.offset + r.offset }
      await this.s.print(this.error(raw, f))
      return
    }
    if (r.mode === 'config') this.mode = this.configMode()
    const execLike = !this.inConfig() || r.offset > 0 || r.m.ctx.words[0] === 'show'
    if (execLike && this.stamp) await this.s.print(xrStamp(now(this.d)))
    this.sync()
    let out = (await r.m.node.run!(r.m.ctx)) ?? ''
    let noMore = false
    if (pipes.length && out) {
      const p = this.pipes(out, pipes, raw)
      if ('error' in p) out = p.error
      else {
        out = p.out
        noMore = !!p.noMore
      }
    }
    if (out) await this.s.print(out, { noMore })
  }

  private async collectLine(raw: string): Promise<void> {
    const c = this.collect!
    const l = raw.trim()
    const end = c.kind === 'rpl' ? 'end-policy' : 'end-set'
    if (l === 'abort') {
      this.collect = null
      return
    }
    if (l !== end) {
      if (l) c.lines.push(l)
      return
    }
    this.collect = null
    const t = this.cfg
    if (c.kind === 'rpl') {
      const lines = reindent(c.lines)
      t.routeMaps = t.routeMaps.filter((x) => x.name !== c.name)
      t.routeMaps.push({ name: c.name, entries: [{ seq: 10, action: 'permit', match: [], set: lines }] })
    } else {
      const entries: Device['prefixLists'][number]['entries'] = []
      for (const item of c.lines.join(' ').split(',')) {
        const m = /^\s*(\d+\.\d+\.\d+\.\d+\/\d+)(?:\s+ge\s+(\d+))?(?:\s+le\s+(\d+))?\s*$/.exec(item)
        if (!m) {
          await this.s.print(`% Invalid prefix-set element: ${item.trim()}`)
          return
        }
        entries.push({ seq: (entries.length + 1) * 10, action: 'permit', prefix: m[1]!, ...(m[2] ? { ge: Number(m[2]) } : {}), ...(m[3] ? { le: Number(m[3]) } : {}) })
      }
      t.prefixLists = t.prefixLists.filter((x) => x.name !== c.name)
      t.prefixLists.push({ name: c.name, entries })
    }
  }

  // ------------------------------------------------------------------ target config

  private enterConfig(): string {
    this.target = clone(this.d)
    this.baseText = text(this.d)
    this.setMode('config')
    return ''
  }

  /** Re-base an unmodified target when the running config moved (another commit, a rollback). */
  private sync(): void {
    if (!this.target) return
    const run = text(this.d)
    if (run !== this.baseText && text(this.target) === this.baseText) {
      this.target = clone(this.d)
      this.baseText = run
    }
  }

  private dirty(): boolean {
    return !!this.target && text(this.target) !== this.baseText
  }

  private discard(): void {
    if (!this.inConfig()) return
    this.target = clone(this.d)
    this.baseText = text(this.d)
  }

  private leave(): void {
    this.target = null
    this.collect = null
    super.endConfig()
  }

  /** Apply the target to the running config and record a commit point. */
  private commit(opts: { confirmMs?: number; label?: string; comment?: string } = {}): string {
    const d = this.d
    const st = xrStore(d)
    this.sync()
    if (!this.dirty()) {
      if (st.trial && opts.confirmMs === undefined) {
        runtime(d).cancel(CONFIRM_TIMER)
        st.trial = undefined
        return '% Confirming commit for trial session.'
      }
      return '% No configuration changes to commit.'
    }
    const t = now(d)
    const before = snapshot(d)
    const was = new Map(d.interfaces.map((i) => [i.name, i.adminUp]))
    restore(d, snapshot(this.target!))
    const after = snapshot(d)
    const id = String(++st.seq)
    const c: XrCommit = { id, user: this.s.user, line: 'vty0:node0_RSP0_CPU0', client: 'CLI', t, before, after, ...(opts.label ? { label: opts.label } : {}), ...(opts.comment ? { comment: opts.comment } : {}) }
    st.commits.unshift(c)
    if (st.commits.length > 100) st.commits.length = 100
    st.lastChange = { t, by: this.s.user }
    this.logChanges(was)
    logEvent(d, `config[65790]: %MGBL-CONFIG-6-DB_COMMIT : Configuration committed by user '${this.s.user}'. Use 'show configuration commit changes ${id}' to view the changes.`, t)
    if (opts.confirmMs !== undefined) {
      if (!st.trial) st.trial = { id, before, until: t + opts.confirmMs }
      else st.trial.until = t + opts.confirmMs
      armConfirm(d, opts.confirmMs)
    } else if (st.trial) {
      runtime(d).cancel(CONFIRM_TIMER)
      st.trial = undefined
    }
    tickBgp(d)
    this.target = clone(d)
    this.baseText = text(d)
    return ''
  }

  private logChanges(was: Map<string, boolean>): void {
    const d = this.d
    for (const i of d.interfaces) {
      const before = was.get(i.name)
      if (before === undefined || before === i.adminUp) continue
      i.lastChange = now(d)
      logEvent(d, `ifmgr[263]: %PKT_INFRA-LINK-3-UPDOWN : Interface ${i.name}, changed state to ${i.adminUp ? (i.linkUp ? 'Up' : 'Down') : 'Administratively Down'}`)
      if (!i.adminUp) for (const n of d.bgp.filter((b) => b.via === i.name && b.upSince !== undefined)) logEvent(d, `bgp[1080]: %ROUTING-BGP-5-ADJCHANGE : neighbor ${n.ip} Down - Interface flap (VRF: ${n.vrf ?? 'default'}) (AS: ${n.remoteAs})`)
    }
  }

  private rollbackTo(snap: ConfigSnapshot, n: number): string {
    const d = this.d
    const st = xrStore(d)
    const before = snapshot(d)
    const lines = configDiff(text(d).split('\n'), configBody(deviceFrom(d, snap)))
    const was = new Map(d.interfaces.map((i) => [i.name, i.adminUp]))
    restore(d, snap)
    const t = now(d)
    const id = String(++st.seq)
    st.commits.unshift({ id, user: this.s.user, line: 'vty0:node0_RSP0_CPU0', client: 'Rollback', t, before, after: snapshot(d) })
    st.lastChange = { t, by: this.s.user }
    this.logChanges(was)
    tickBgp(d)
    // [unverified, from memory] progress lines printed by rollback.
    return ['', 'Loading Rollback Changes.', 'Loaded Rollback Changes in  1 sec ', 'Committing.', `${lines.filter((l) => !/^\s*!$/.test(l)).length} items committed in  1 sec (${lines.length})items/sec`, 'Updating.', 'Updated Commit database in  1 sec ', `Configuration successfully rolled back ${n} commits.`].join('\n')
  }

  private showConfiguration(): string {
    if (!this.target) return `${BLD}\n!! IOS XR Configuration ${this.d.version}\nend\n`
    const diff = configDiff(this.baseText.split('\n'), configBody(this.target))
    return [BLD, `!! IOS XR Configuration ${this.d.version}`, ...diff, 'end', ''].join('\n')
  }

  private showCommitChanges(c: XrCommit | undefined): string {
    if (!c) return '% No such configuration commit point'
    const d = this.d
    const diff = configDiff(configBody(deviceFrom(d, c.before)), configBody(deviceFrom(d, c.after)))
    return [BLD, `!! IOS XR Configuration ${d.version}`, ...diff, 'end', ''].join('\n')
  }

  // ------------------------------------------------------------------ leaving config

  private async leaveConfig(): Promise<string> {
    this.sync()
    if (!this.dirty()) {
      this.leave()
      return ''
    }
    const a = (await this.s.ask('Uncommitted changes found, commit them before exiting(yes/no/cancel)? [cancel]:', { mode: 'line' })).trim().toLowerCase()
    if (a && 'yes'.startsWith(a)) {
      const out = this.commit()
      this.leave()
      return out
    }
    if (a && 'no'.startsWith(a)) {
      this.leave()
      return ''
    }
    return ''
  }

  override control(key: 'c' | 'z', _line: string): ControlResult {
    if (key === 'z') return this.inConfig() ? { echo: '\n', execute: 'end' } : { echo: '' }
    // [unverified, from memory] Ctrl-C discards the typed line and stays in the current mode.
    return { echo: '^C\n' }
  }

  // ------------------------------------------------------------------ trees

  protected tree(modeId: string): Node[] {
    this.trees ??= this.build()
    return this.trees[modeId] ?? this.trees['config']!
  }

  private ifParam(exists = true): Param {
    return {
      kind: 'word',
      label: exists ? 'WORD' : 'WORD',
      values: () => this.cfg.interfaces.map((i) => i.name),
      test: (tok) => (exists ? !!findXrIf(this.cfg, tok) : !!parseXrIf(tok))
    }
  }

  /** Interface type and number as two tokens ("GigabitEthernet 0/0/0/1"): accepted as one name. */
  private ifNodes(name: string, run: Node['run'], exists = true, children?: Node[]): Node[] {
    const two: Node[] = ['GigabitEthernet', 'TenGigE', 'HundredGigE', 'Loopback', 'MgmtEth', 'Bundle-Ether'].map((ty) =>
      kw(ty, `${ty} interface(s)`, { hidden: true, children: [prm({ kind: 'word', label: 'WORD', test: (tok) => (exists ? !!findXrIf(this.cfg, ty + tok) : !!parseXrIf(ty + tok)) }, 'Interface number', { name: `${name}#`, run: run ? (c) => run({ ...c, args: { ...c.args, [name]: ty + c.args[`${name}#`] } }) : undefined, ...(children ? { children } : {}) })] })
    )
    return [prm(this.ifParam(exists), 'Interface name', { name, run, ...(children ? { children } : {}) }), ...two]
  }

  private build(): Record<string, Node[]> {
    const d = this.d
    const exec: Node[] = []
    const ip = (label = 'A.B.C.D'): Param => ({ kind: 'ipv4', label })
    const line: Param = { kind: 'line', label: 'LINE' }
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const vrfP: Param = { kind: 'word', label: 'WORD', values: () => d.vrfs.map((v) => v.name) }
    const S = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(exec, `show ${path}`, help, run, extra, HELP)
    const ifOf = (c: Ctx): Iface | undefined => findXrIf(d, c.args['if'] ?? '')

    // ---- show
    add(exec, 'show', 'Show commands', undefined, { priority: true })
    S('version', 'Software information', () => R.showVersion(d))
    S('platform', 'Show platform information', () => R.showPlatform(d))
    const runCfg = (c: Ctx): string => this.runSection(c.args['sec'])
    S('running-config', 'Current operating configuration', runCfg, { children: [prm(line, 'Configuration section', { name: 'sec', run: runCfg })] })
    S('ipv4 interface brief', 'Brief summary of IPv4 status and configuration', () => R.showIpv4IntBrief(d), { children: [kw('vrf', 'VRF name', { children: [prm({ ...vrfP, values: () => ['all', 'default', ...d.vrfs.map((v) => v.name)] }, 'VRF name', { name: 'vrf', run: (c) => R.showIpv4IntBrief(d, c.args['vrf']) })] })] })
    S('ip interface brief', 'Brief summary of IP status and configuration', () => R.showIpv4IntBrief(d))
    S('interfaces', 'Interface status and configuration', () => [...d.interfaces].sort((a, b) => a.name.localeCompare(b.name)).map((i) => R.showInterface(d, i)).join('\n\n'), { children: this.ifNodes('if', (c) => R.showInterface(d, ifOf(c)!)) })
    S('interfaces brief', 'Brief information of interfaces', () => R.showIntBrief(d))
    S('interfaces description', 'Show interface description', () => ['', 'Interface          Status      Protocol    Description', '-'.repeat(80), ...d.interfaces.map((i) => `${i.short.padEnd(19)}${(!i.adminUp ? 'admin-down' : i.linkUp && !i.errDisabled ? 'up' : 'down').padEnd(12)}${(i.adminUp && i.linkUp && !i.errDisabled ? 'up' : !i.adminUp ? 'admin-down' : 'down').padEnd(12)}${i.description ?? ''}`)].join('\n'))
    const bgpNbr = (): Node[] => [prm({ ...ip(), values: () => d.bgp.map((n) => n.ip) }, 'Neighbor address', { name: 'nb', run: (c) => R.showBgpNeighbors(d, c.args['nb']) })]
    S('bgp summary', 'Summary of BGP neighbor status', () => R.showBgpSummary(d))
    S('bgp ipv4 unicast summary', 'Summary of BGP neighbor status', () => R.showBgpSummary(d))
    S('bgp neighbors', 'Detailed information on BGP neighbors', () => R.showBgpNeighbors(d), { children: bgpNbr() })
    S('bgp ipv4 unicast neighbors', 'Detailed information on BGP neighbors', () => R.showBgpNeighbors(d), { children: bgpNbr() })
    S('bgp vrf', 'Specify a VRF', undefined, { children: [prm(vrfP, 'VRF name', { name: 'vrf', children: [kw('summary', 'Summary of BGP neighbor status', { run: (c) => R.showBgpSummary(d, c.args['vrf']) })] })] })
    const routeTail = (vrfKey?: string): Node[] => [
      ...['connected', 'static', 'bgp', 'ospf', 'local'].map((p) => kw(p, `${p[0]!.toUpperCase()}${p.slice(1)} routes`, { run: (c: Ctx) => R.showRoute(d, vrfKey ? c.args[vrfKey] : undefined, p) })),
      prm({ kind: 'word', label: 'A.B.C.D', test: (t) => isIpv4(t.split('/')[0]!) }, 'Network to display information about', { name: 'target', run: (c) => R.showRoute(d, vrfKey ? c.args[vrfKey] : undefined, undefined, c.args['target']) }),
      kw('summary', 'Summary of routing table', { run: (c) => this.routeSummary(vrfKey ? c.args[vrfKey] : undefined) })
    ]
    const routeNode = (): Partial<Node> => ({ children: [kw('vrf', 'Specify a VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showRoute(d, c.args['vrf']), children: [kw('ipv4', 'IPv4 commands', { run: (c) => R.showRoute(d, c.args['vrf']), children: routeTail('vrf') }), ...routeTail('vrf')] })] }), kw('ipv4', 'IPv4 commands', { run: () => R.showRoute(d), children: [kw('unicast', 'Unicast commands', { run: () => R.showRoute(d), children: routeTail() }), ...routeTail()] }), ...routeTail()] })
    S('route', 'Show IP routing table', () => R.showRoute(d), routeNode())
    S('ospf neighbor', 'Neighbor list', () => R.showOspfNeighbor(d))
    S('ospf interface brief', 'Brief summary of OSPF interface information', () => R.showOspfIntBrief(d))
    S('arp', 'ARP table', () => R.showArp(d), { children: [kw('vrf', 'Specify a VRF', { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showArp(d, c.args['vrf']) })] })] })
    S('lldp neighbors', 'LLDP neighbor entries', () => R.showLldp(d))
    S('cdp neighbors', 'CDP neighbor entries', () => R.showCdp(d))
    S('vrf all', 'All VRFs', () => R.showVrfAll(d))
    S('vrf', 'VRF information', undefined, { children: [prm(vrfP, 'VRF name', { name: 'vrf', run: (c) => R.showVrfAll({ ...d, vrfs: d.vrfs.filter((v) => v.name === c.args['vrf']) }) })] })
    const rplName = (kind: 'route-policy' | 'prefix-set'): Param => ({ kind: 'word', label: 'WORD', values: () => (kind === 'route-policy' ? d.routeMaps : d.prefixLists).map((x) => x.name) })
    S('rpl', 'Routing Policy Language information', () => [R.showRpl(d, 'prefix-set'), R.showRpl(d, 'route-policy')].join('\n'))
    S('rpl route-policy', 'Show route-policies', () => R.showRpl(d, 'route-policy'), { children: [prm(rplName('route-policy'), 'Policy name', { name: 'n', run: (c) => R.showRpl(d, 'route-policy', c.args['n']) })] })
    S('rpl prefix-set', 'Show prefix-sets', () => R.showRpl(d, 'prefix-set'), { children: [prm(rplName('prefix-set'), 'Prefix-set name', { name: 'n', run: (c) => R.showRpl(d, 'prefix-set', c.args['n']) })] })
    S('access-lists', 'IPv4 access lists', () => R.showAccessLists(d), { children: [prm({ kind: 'word', label: 'WORD', values: () => d.acls.map((a) => a.name) }, 'Access list name', { name: 'acl', run: (c) => R.showAccessLists(d, c.args['acl']) })] })
    S('processes cpu', 'Show CPU use per process', () => R.showProcessesCpu(d))
    S('logging', 'Show the contents of logging buffers', () => R.showLogging(d))
    S('clock', 'Display the system clock', () => xrStamp(now(d)))
    S('users', 'Display information about terminal lines', () => `   Line            User                 Service  Conns   Idle        Location\n*  vty0            ${this.s.user.padEnd(21)}ssh          0  00:00:00    ${this.s.from}`)
    S('configuration commit list', 'List of commit identifiers', () => R.showCommitList(d), { children: [prm(int(1, 100), 'Number of commits to list', { name: 'n', run: (c) => R.showCommitList(d, Number(c.args['n'])) })] })
    const commitIdP: Param = { kind: 'word', label: 'WORD', values: () => xrStore(d).commits.map((c) => c.id), test: (t) => /^\d+$/.test(t) }
    S('configuration commit changes', 'Display commit changes', undefined, {
      children: [
        prm(commitIdP, 'Commit ID', { name: 'id', run: (c) => this.showCommitChanges(xrStore(d).commits.find((x) => x.id === c.args['id'] || x.label === c.args['id'])) }),
        kw('last', 'Changes made in the most recent <n> commits', { children: [prm(int(1, 100), 'Number of commits', { name: 'n', run: (c) => this.showCommitChanges(xrStore(d).commits[Number(c.args['n']) - 1]) })] })
      ]
    })
    S('configuration', 'Contents of a configuration', () => this.showConfiguration())
    S('terminal', 'Display terminal configuration parameters', () => `Line "vty0", Location "0/RSP0/CPU0", Type "VT100"\nLength: ${this.s.pageLength} lines, Width: 80 columns`)

    // ---- exec actions
    add(exec, 'configure', 'Enter configuration mode', () => this.enterConfig(), { priority: true })
    add(exec, 'configure terminal', 'Configure from the terminal', () => this.enterConfig())
    add(exec, 'configure exclusive', 'Configure exclusively from this terminal', () => this.enterConfig())
    add(exec, 'rollback configuration last', 'Rollback the last <n> commits made', undefined, {
      children: [
        prm(int(1, 100), 'Number of commits to roll back', {
          name: 'n',
          run: (c) => {
            const n = Number(c.args['n'])
            const st = xrStore(d)
            if (n > st.commits.length) return `% Error: only ${st.commits.length} commits are available to roll back`
            return this.rollbackTo(st.commits[n - 1]!.before, n)
          }
        })
      ]
    }, HELP)
    add(exec, 'rollback configuration to', 'Rollback up to (and including) a specific commit', undefined, {
      children: [
        prm(commitIdP, 'Commit ID', {
          name: 'id',
          run: (c) => {
            const st = xrStore(d)
            const k = st.commits.findIndex((x) => x.id === c.args['id'] || x.label === c.args['id'])
            if (k < 0) return `% Error: Commit ID ${c.args['id']} is not a valid commit point`
            if (k === 0) return '% Error: no commits to roll back'
            return this.rollbackTo(st.commits[k]!.after, k)
          }
        })
      ]
    }, HELP)
    add(exec, 'terminal length', 'Set number of lines on a screen', undefined, { children: [prm(int(0, 512), 'Number of lines on screen (0 for no pausing)', { name: 'n', run: (c) => ((this.s.pageLength = Number(c.args['n'])), '') })] }, HELP)
    add(exec, 'terminal width', 'Set width of the display terminal', undefined, { children: [prm(int(0, 512), 'Number of characters on a screen line', { run: () => '' })] }, HELP)
    add(exec, 'terminal exec prompt no-timestamp', 'Disable the timestamp before exec output', () => ((this.stamp = false), ''), {}, HELP)
    add(exec, 'terminal exec prompt timestamp', 'Print the timestamp before exec output', () => ((this.stamp = true), ''), {}, HELP)
    add(exec, 'terminal monitor', 'Copy debug output to the current terminal line', () => '', {}, HELP)
    add(exec, 'clear counters', 'Clear counters on one or all interfaces', async () => {
      const a = await this.s.ask('Clear "show interface" counters on all interfaces [confirm]')
      if (a !== '' && a.toLowerCase() !== 'y') return ''
      for (const i of d.interfaces) {
        i.clearedAt = now(d)
        i.errors = undefined
        if (i.faultSince !== undefined) i.faultSince = now(d)
      }
      return ''
    }, {}, HELP)
    add(exec, 'clear bgp', 'Clear BGP connections', undefined, {
      children: [
        prm({ kind: 'word', label: 'A.B.C.D', test: (t) => t === '*' || isIpv4(t) }, 'BGP neighbor address to clear', {
          name: 'tgt',
          run: (c) => {
            const list = c.args['tgt'] === '*' ? d.bgp : d.bgp.filter((n) => n.ip === c.args['tgt'])
            if (!list.length) return '% No such neighbor'
            for (const n of list) {
              n.upSince = undefined
              n.downSince = now(d)
            }
            tickBgp(d)
            return ''
          }
        })
      ]
    }, HELP)
    add(exec, 'ping', 'Send echo messages', undefined, {
      children: [
        prm({ kind: 'word', label: 'WORD' }, 'Ping destination address or hostname', { name: 'target', run: (c) => this.ping(c.args['target']!) }),
        kw('vrf', 'VRF name', { children: [prm(vrfP, 'VRF name', { name: 'vrf', children: [prm({ kind: 'word', label: 'WORD' }, 'Ping destination', { name: 'target', run: (c) => this.ping(c.args['target']!, c.args['vrf']) })] })] })
      ]
    })
    for (const w of ['exit', 'logout']) add(exec, w, 'Exit from the EXEC', () => (this.s.close(), ''))
    exec.sort((a, b) => a.word!.localeCompare(b.word!))

    return { exec, user: exec, ...this.configTrees() }
  }

  /** `show running-config [section]`: the whole config, or the blocks whose header starts with the words. */
  private runSection(sec?: string): string {
    const d = this.d
    const body = configBody(d)
    if (!sec) return runningConfig(d, body)
    let want = sec.trim().replace(/\s+/g, ' ')
    const im = /^int\S*\s+(.+)$/i.exec(want)
    if (im) {
      const i = findXrIf(d, im[1]!)
      if (!i) return `% No such configuration item(s)`
      want = `interface ${i.name}`
    }
    const out: string[] = []
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!
      if (/^\s/.test(l) || l === '!' || !l.toLowerCase().startsWith(want.toLowerCase())) continue
      out.push(l)
      for (k++; k < body.length && (/^\s/.test(body[k]!) || (body[k] === '!' && /^\s/.test(body[k - 1] ?? ''))); k++) out.push(body[k]!)
      k--
      if (out.at(-1) !== '!') out.push('!')
    }
    if (!out.length) return '% No such configuration item(s)'
    return [...out, ''].join('\n')
  }

  private routeSummary(vrf?: string): string {
    const r = R.xrRib(this.d, vrf)
    const n = (p: RegExp): number => r.filter((x) => p.test(x.code)).length
    return [
      'Route Source                     Routes     Backup     Deleted     Memory(bytes)',
      `connected                        ${String(n(/^C$/)).padEnd(11)}0          0           ${n(/^C$/) * 240}`,
      `local                            ${String(n(/^L$/)).padEnd(11)}0          0           ${n(/^L$/) * 240}`,
      `static                           ${String(n(/^S/)).padEnd(11)}0          0           ${n(/^S/) * 240}`,
      `ospf ${(this.d.ospf?.process ?? '1').padEnd(28)}${String(n(/^O$/)).padEnd(11)}0          0           ${n(/^O$/) * 240}`,
      `bgp ${String(this.d.localAs).padEnd(29)}${String(n(/^B$/)).padEnd(11)}0          0           ${n(/^B$/) * 240}`,
      `Total                            ${String(r.length).padEnd(11)}0          0           ${r.length * 240}`
    ].join('\n')
  }

  private async ping(target: string, vrf?: string): Promise<string> {
    if (!isIpv4(target)) return `% Unrecognized host or address.`
    const ok = reachable(this.d, target, vrf)
    await this.s.print(`Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${target} timeout is 2 seconds:`)
    let marks = ''
    for (let k = 0; k < 5; k++) {
      if (!(await this.s.sleep(ok ? 40 : 300))) break
      marks += ok ? '!' : '.'
      this.s.write(ok ? '!' : '.')
    }
    this.s.write('\r\n')
    const got = [...marks].filter((m) => m === '!').length
    return `Success rate is ${marks.length ? Math.floor((got / marks.length) * 100) : 0} percent (${got}/${marks.length})${got ? ', round-trip min/avg/max = 1/1/2 ms' : ''}`
  }

  // ------------------------------------------------------------------ config trees

  private configTrees(): Record<string, Node[]> {
    const line: Param = { kind: 'line', label: 'LINE' }
    const word = (label = 'WORD'): Param => ({ kind: 'word', label })
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `<${min}-${max}>`, min, max })
    const ipP = (label = 'A.B.C.D'): Param => ({ kind: 'ipv4', label })
    const T = (): Device => this.cfg
    const ok = (): string => ''

    /** Commands every config mode has. */
    const common = (): Node[] => [
      kw('commit', 'Commit the target configuration to the active (running) configuration', {
        run: () => this.commit(),
        children: [
          kw('confirmed', 'Rollback this commit unless there is a confirming commit', {
            run: () => this.commit({ confirmMs: 60_000 }),
            children: [
              prm(int(30, 65535), 'Seconds until rollback unless there is a confirming commit', { name: 'sec', run: (c) => this.commit({ confirmMs: Number(c.args['sec']) * 1000 }) }),
              kw('minutes', 'Specify the rollback timer in the minutes', { children: [prm(int(1, 65535), 'Minutes until rollback unless there is a confirming commit', { name: 'min', run: (c) => this.commit({ confirmMs: Number(c.args['min']) * 60_000 }) })] })
            ]
          }),
          kw('label', 'Assign a label to this commit', { children: [prm(word(), 'Commit label', { name: 'label', run: (c) => this.commit({ label: c.args['label'] }) })] }),
          kw('comment', 'Assign a comment to this commit', { children: [prm(line, 'Comment', { name: 'comment', run: (c) => this.commit({ comment: c.args['comment'] }) })] })
        ]
      }),
      kw('abort', 'Discard the target configuration and exit from configuration mode', { run: () => (this.leave(), '') }),
      kw('end', 'Exit from configure mode', { run: () => this.leaveConfig() }),
      kw('exit', 'Exit from this submode', { run: () => (this.mode.up?.id === 'exec' || this.mode.id === 'config' ? this.leaveConfig() : (this.exitMode(), '')) }),
      kw('root', 'Exit to the global configuration mode', { run: () => ((this.mode = this.configMode()), '') }),
      kw('clear', 'Clear the uncommitted configuration', { run: () => (this.discard(), '') }),
      kw('do', 'Run an exec command', { children: [prm(line, 'Exec Command', { run: () => '' })] }),
      kw('show', 'Show contents of configuration', {
        children: [
          kw('configuration', 'Contents of the uncommitted configuration', { run: () => this.showConfiguration(), children: [kw('running', 'Running configuration', { run: () => runningConfig(this.d) }), kw('commit', 'Commit information', { children: [kw('list', 'List of commit identifiers', { run: () => R.showCommitList(this.d), children: [prm({ kind: 'int', label: '<1-100>', min: 1, max: 100 }, 'Number of commits to list', { name: 'n', run: (c) => R.showCommitList(this.d, Number(c.args['n'])) })] })] })] }),
          kw('running-config', 'Current operating configuration', { run: (c) => this.runSection(c.args['sec']), children: [prm(line, 'Configuration section', { name: 'sec', run: (c) => this.runSection(c.args['sec']) })] })
        ]
      })
    ]
    const tree = (nodes: Node[]): Node[] => [...nodes, ...common()].sort((a, b) => (a.word ?? '~').localeCompare(b.word ?? '~'))

    // ---- global
    const ifEnter = (c: Ctx): string => {
      const typed = c.args['if']!
      const t = T()
      let i = findXrIf(t, typed)
      if (!i) {
        const r = parseXrIf(typed)
        if (!r || !r.virtual) return `${this.caret(c.line.indexOf(typed.replace(/^\S+?(?=\d)/, '')) >= 0 ? c.line.indexOf(c.tokens[1] ?? typed) : 0)}\n% Invalid input detected at '^' marker.`
        i = { name: r.name, short: r.short, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: '' }
        t.interfaces.push(i)
      }
      this.setMode('config-if', i.name)
      return ''
    }
    const g: Node[] = [
      kw('hostname', 'Set system\'s network name', { children: [prm({ kind: 'word', label: 'WORD', test: (t) => /^[A-Za-z][\w-]{0,62}$/.test(t) }, 'This system\'s network name', { name: 'h', run: (c) => ((T().hostname = c.args['h']!), '') })] }),
      kw('interface', 'Select an interface to configure', { children: this.ifNodes('if', ifEnter, false) }),
      kw('router', 'Enable a routing process', {
        children: [
          kw('bgp', 'BGP configuration commands', {
            children: [
              prm({ kind: 'asn', label: '<1-4294967295>' }, 'bgp as-number', {
                name: 'as',
                run: (c) => {
                  const as = Number(c.args['as'])
                  if (T().localAs && T().localAs !== as) return `% BGP is already running; AS is ${T().localAs}` // [unverified, from memory]
                  T().localAs = as
                  this.setMode('config-bgp')
                  return ''
                }
              })
            ]
          }),
          kw('ospf', 'OSPF configuration subcommands', {
            children: [
              prm(word(), 'Name for this OSPF process', {
                name: 'pid',
                run: (c) => {
                  const t = T()
                  if (t.ospf && t.ospf.process !== c.args['pid']) return `% Only one OSPF process is supported on the simulator (running: ${t.ospf.process})`
                  t.ospf ??= { process: c.args['pid']!, ifaces: [], neighbors: [] }
                  this.setMode('config-ospf')
                  return ''
                }
              })
            ]
          }),
          kw('static', 'Static route configuration subcommands', { run: () => (this.setMode('config-static'), '') })
        ]
      }),
      kw('vrf', 'Specify a VRF', {
        children: [
          prm(word(), 'VRF name', {
            name: 'vrf',
            run: (c) => {
              const t = T()
              if (!t.vrfs.some((v) => v.name === c.args['vrf'])) t.vrfs.push({ name: c.args['vrf']!, rd: '', interfaces: [] })
              this.setMode('config-vrf', c.args['vrf'])
              return ''
            }
          })
        ]
      }),
      kw('route-policy', 'Define a route policy', { children: [prm(word(), 'Route Policy name', { name: 'n', run: (c) => ((this.collect = { kind: 'rpl', name: c.args['n']!, lines: [] }), '') })] }),
      kw('prefix-set', 'Define a prefix set', { children: [prm(word(), 'Prefix-set name', { name: 'n', run: (c) => ((this.collect = { kind: 'pfx', name: c.args['n']!, lines: [] }), '') })] }),
      kw('ipv4', 'IPv4 configuration commands', {
        children: [
          kw('access-list', 'Configure an IPv4 access list', {
            children: [
              prm(word(), 'IPv4 access list name', {
                name: 'acl',
                run: (c) => {
                  const t = T()
                  if (!t.acls.some((a) => a.name === c.args['acl'])) t.acls.push({ name: c.args['acl']!, type: 'extended', entries: [] })
                  this.setMode('config-ipv4-acl', c.args['acl'])
                  return ''
                }
              })
            ]
          })
        ]
      }),
      kw('banner', 'Define a login banner', {
        children: [
          kw('motd', 'Set Message of the Day banner', {
            children: [
              prm(line, "c banner-text c, where 'c' is a delimiting character", {
                name: 'text',
                run: (c) => {
                  const tx = c.args['text']!
                  const delim = tx[0]!
                  const end = tx.indexOf(delim, 1)
                  T().motd = end > 0 ? tx.slice(1, end) : tx.slice(1)
                  return ''
                }
              })
            ]
          })
        ]
      }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('interface', 'Select an interface to configure', {
            children: this.ifNodes('if', (c) => {
              const t = T()
              const i = findXrIf(t, c.args['if']!)!
              if (parseXrIf(i.name)?.virtual) t.interfaces = t.interfaces.filter((x) => x !== i)
              else Object.assign(i, { description: undefined, ip: undefined, mask: undefined, adminUp: false, mtu: undefined, vrf: undefined })
              return ''
            })
          }),
          kw('router', 'Enable a routing process', {
            children: [
              kw('bgp', 'BGP configuration commands', { children: [prm({ kind: 'asn', label: '<1-4294967295>' }, 'bgp as-number', { name: 'as', run: (c) => { const t = T(); if (t.localAs !== Number(c.args['as'])) return ''; t.localAs = 0; t.bgp = []; return '' } })] }),
              kw('ospf', 'OSPF configuration subcommands', { children: [prm(word(), 'Name for this OSPF process', { run: () => ((T().ospf = undefined), '') })] }),
              kw('static', 'Static route configuration subcommands', { run: () => ((T().staticRoutes = []), '') })
            ]
          }),
          kw('vrf', 'Specify a VRF', { children: [prm(word(), 'VRF name', { name: 'vrf', run: (c) => { const t = T(); t.vrfs = t.vrfs.filter((v) => v.name !== c.args['vrf']); return '' } })] }),
          kw('route-policy', 'Define a route policy', { children: [prm(word(), 'Route Policy name', { name: 'n', run: (c) => { const t = T(); t.routeMaps = t.routeMaps.filter((r) => r.name !== c.args['n']); return '' } })] }),
          kw('prefix-set', 'Define a prefix set', { children: [prm(word(), 'Prefix-set name', { name: 'n', run: (c) => { const t = T(); t.prefixLists = t.prefixLists.filter((r) => r.name !== c.args['n']); return '' } })] }),
          kw('banner', 'Define a login banner', { children: [kw('motd', 'Set Message of the Day banner', { run: () => ((T().motd = undefined), '') })] })
        ]
      }),
      ...['logging', 'ntp', 'domain', 'snmp-server', 'ssh', 'line', 'username', 'aaa', 'clock', 'telnet'].map((w) =>
        kw(w, `${w} configuration`, { children: [prm(line, 'Configuration', { name: 'rest', run: (c) => { const t = T(); const l = `${w} ${c.args['rest']}`; if (!t.extraConfig.includes(l)) t.extraConfig.push(l); return '' } })] })
      )
    ]

    // ---- interface
    const IF = (): Iface | undefined => T().interfaces.find((i) => i.name === this.mode.ctx)
    const onIf = (f: (i: Iface, c: Ctx) => string | void) => (c: Ctx): string => {
      const i = IF()
      return i ? (f(i, c) ?? '') : ''
    }
    const setAddr = (i: Iface, ip: string, len: number): string => {
      const clash = T().interfaces.find((x) => x !== i && x.ip && x.mask !== undefined && x.mask < 32 && len < 32 && (x.vrf ?? '') === (i.vrf ?? '') && inSubnet(ip, x.ip, Math.min(x.mask, len)))
      if (clash) return `!!% Address ${ip} overlaps with ${clash.name}` // [unverified, from memory] XR reports this at commit time
      i.ip = ip
      i.mask = len
      return ''
    }
    const ifm: Node[] = [
      kw('description', 'Set description for this interface', { children: [prm(line, 'Up to 1024 characters describing this interface', { name: 'desc', run: onIf((i, c) => void (i.description = c.args['desc'])) })] }),
      kw('shutdown', 'shutdown the given interface', { run: onIf((i) => void (i.adminUp = false)) }),
      kw('ipv4', 'Interface IPv4 configuration subcommands', {
        children: [
          kw('address', 'Set the IPv4 address of an interface', {
            children: [
              prm({ kind: 'word', label: 'A.B.C.D/prefix', test: (t) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(t) && isIpv4(t.split('/')[0]!) && Number(t.split('/')[1]) <= 32 }, 'IPv4 address and prefix length', { name: 'pfx', run: onIf((i, c) => setAddr(i, c.args['pfx']!.split('/')[0]!, Number(c.args['pfx']!.split('/')[1]))) }),
              prm(ipP(), 'IPv4 address', { name: 'ip', children: [prm({ kind: 'mask', label: 'A.B.C.D' }, 'IPv4 subnet mask', { name: 'mask', run: onIf((i, c) => setAddr(i, c.args['ip']!, dottedToLen(c.args['mask']!)!)) })] })
            ]
          })
        ]
      }),
      kw('mtu', 'Set the MTU on an interface', { children: [prm(int(64, 65535), 'MTU (bytes)', { name: 'mtu', run: onIf((i, c) => void (i.mtu = Number(c.args['mtu']) - 14 === 1500 ? undefined : Number(c.args['mtu']) - 14)) })] }),
      kw('vrf', 'Set VRF in which the interface operates', { children: [prm({ kind: 'word', label: 'WORD', values: () => T().vrfs.map((v) => v.name) }, 'VRF name', { name: 'vrf', run: onIf((i, c) => void (i.vrf = c.args['vrf'])) })] }),
      kw('speed', 'Set the speed of the interface', { children: [prm({ kind: 'enum', label: '<10,100,1000>', values: () => ['10', '100', '1000'] }, 'Speed (Mbps)', { name: 's', run: onIf((i, c) => void (i.speedSet = c.args['s'])) })] }),
      kw('duplex', 'Configure duplex operational mode', { children: ['full', 'half'].map((x) => kw(x, `${x === 'full' ? 'Full' : 'Half'} duplex`, { run: onIf((i) => void (i.duplex = x as 'full')) })) }),
      kw('load-interval', 'Specify interval for load calculation for an interface', { children: [prm(int(0, 600), 'Load interval in seconds', { run: ok })] }),
      kw('negotiation', 'Configure link autonegotiation', { children: [kw('auto', 'Enable link autonegotiation', { run: ok })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('description', 'Set description for this interface', { run: onIf((i) => void (i.description = undefined)) }),
          kw('shutdown', 'shutdown the given interface', { run: onIf((i) => void (i.adminUp = true)) }),
          kw('ipv4', 'Interface IPv4 configuration subcommands', { children: [kw('address', 'Set the IPv4 address of an interface', { run: onIf((i) => void ((i.ip = undefined), (i.mask = undefined))) })] }),
          kw('mtu', 'Set the MTU on an interface', { run: onIf((i) => void (i.mtu = undefined)) }),
          kw('vrf', 'Set VRF in which the interface operates', { run: onIf((i) => void (i.vrf = undefined)) }),
          kw('duplex', 'Configure duplex operational mode', { run: onIf((i) => void (i.duplex = undefined)) }),
          kw('speed', 'Set the speed of the interface', { run: onIf((i) => void (i.speedSet = undefined)) })
        ]
      })
    ]

    // ---- router bgp
    const NB = (): Device['bgp'][number] | undefined => T().bgp.find((n) => n.ip === this.mode.ctx)
    const onNb = (f: (n: Device['bgp'][number], c: Ctx) => string | void) => (c: Ctx): string => {
      const n = NB()
      return n ? (f(n, c) ?? '') : ''
    }
    const nbEnter = (vrf?: string) => (c: Ctx): string => {
      const t = T()
      const ipa = c.args['nb']!
      if (!t.bgp.some((n) => n.ip === ipa)) {
        const via = t.interfaces.find((i) => i.ip && i.mask !== undefined && i.mask < 32 && inSubnet(ipa, i.ip, i.mask))
        // No real router answers a neighbor added from the CLI: peerAs -1 keeps it Active.
        t.bgp.push({ ip: ipa, remoteAs: 0, peerAs: -1, via: via?.name ?? 'Loopback0', prefixes: 0, ...(vrf ? { vrf } : {}) })
      }
      this.setMode('config-bgp-nbr', ipa, this.mode)
      return ''
    }
    const bgpm: Node[] = [
      kw('bgp', 'BGP commands', { children: [kw('router-id', 'Configure Router-id', { children: [prm(ipP(), 'Manually configured router identifier', { name: 'rid', run: (c) => ((T().routerId = c.args['rid']!), '') })] })] }),
      kw('neighbor', 'Specify a neighbor router', { children: [prm({ ...ipP('IPv4 address'), values: () => T().bgp.map((n) => n.ip) }, 'IPv4 neighbor address', { name: 'nb', run: nbEnter() })] }),
      kw('address-family', 'Enter Address Family command mode', { children: [kw('ipv4', 'IPv4 Address Family', { children: [kw('unicast', 'Address Family modifier', { run: () => (this.setMode('config-bgp-af', undefined, this.mode), '') })] }), kw('vpnv4', 'VPNv4 Address Family', { children: [kw('unicast', 'Address Family modifier', { run: () => (this.setMode('config-bgp-af', undefined, this.mode), '') })] })] }),
      kw('vrf', 'Specify a vrf name', {
        children: [
          prm(word(), 'VRF name', {
            name: 'vrf',
            run: (c) => {
              const t = T()
              if (!t.vrfs.some((v) => v.name === c.args['vrf'])) t.vrfs.push({ name: c.args['vrf']!, rd: '', interfaces: [] })
              this.setMode('config-bgp-vrf', c.args['vrf'], this.mode)
              return ''
            }
          })
        ]
      }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('neighbor', 'Specify a neighbor router', { children: [prm({ ...ipP('IPv4 address'), values: () => T().bgp.map((n) => n.ip) }, 'IPv4 neighbor address', { name: 'nb', run: (c) => { const t = T(); t.bgp = t.bgp.filter((n) => n.ip !== c.args['nb']); return '' } })] })
        ]
      })
    ]
    const bgpVrf: Node[] = [
      kw('rd', 'Set the Route Distinguisher for a VRF', { children: [prm({ kind: 'word', label: 'WORD' }, 'ASN:nn or IP-address:nn', { name: 'rd', run: (c) => { const v = T().vrfs.find((x) => x.name === this.mode.ctx); if (v) v.rd = c.args['rd']!; return '' } })] }),
      kw('neighbor', 'Specify a neighbor router', { children: [prm(ipP('IPv4 address'), 'IPv4 neighbor address', { name: 'nb', run: (c) => nbEnter(this.mode.ctx as string)(c) })] }),
      kw('address-family', 'Enter Address Family command mode', { children: [kw('ipv4', 'IPv4 Address Family', { children: [kw('unicast', 'Address Family modifier', { run: () => (this.setMode('config-bgp-af', undefined, this.mode), '') })] })] })
    ]
    const bgpAf: Node[] = [kw('redistribute', 'Redistribute routes from other protocols', { children: [prm(line, 'Protocol', { run: ok })] }), kw('network', 'Specify a network to announce via BGP', { children: [prm(line, 'IPv4 prefix', { run: ok })] }), kw('maximum-paths', 'Forward packets over multiple paths', { children: [prm(line, 'paths', { run: ok })] })]
    const nbrm: Node[] = [
      kw('remote-as', 'Set remote AS', { children: [prm({ kind: 'asn', label: '<1-4294967295>' }, 'bgp as-number', { name: 'as', run: onNb((n, c) => { if (n.remoteAs !== Number(c.args['as'])) n.upSince = undefined; n.remoteAs = Number(c.args['as']) }) })] }),
      kw('description', 'Neighbor specific description', { children: [prm(line, 'Up to 80 characters describing this neighbor', { name: 'desc', run: onNb((n, c) => void (n.description = c.args['desc'])) })] }),
      kw('shutdown', 'Administratively shut down this neighbor', { run: onNb((n) => void (n.shutdown = true)) }),
      kw('update-source', 'Source of routing updates', { children: [prm(this.ifParam(), 'Interface', { name: 'us', run: onNb((n, c) => void (n.updateSource = findXrIf(T(), c.args['us']!)?.name)) })] }),
      kw('password', 'Set or disable a password', { children: ['clear', 'encrypted'].map((w) => kw(w, `Specifies an ${w === 'clear' ? 'UNENCRYPTED' : 'ENCRYPTED'} password will follow`, { children: [prm(line, 'The password', { name: 'pw', run: onNb((n, c) => void (n.password = w === 'clear' ? '094F471A1A0A' : c.args['pw'])) })] })) }),
      kw('address-family', 'Enter Address Family command mode', { children: [kw('ipv4', 'IPv4 Address Family', { children: [kw('unicast', 'Address Family modifier', { run: () => (this.setMode('config-bgp-nbr-af', this.mode.ctx, this.mode), '') })] })] }),
      kw('no', 'Negate a command or set its defaults', {
        children: [
          kw('shutdown', 'Administratively shut down this neighbor', { run: onNb((n) => void (n.shutdown = undefined)) }),
          kw('description', 'Neighbor specific description', { run: onNb((n) => void (n.description = undefined)) }),
          kw('password', 'Set or disable a password', { run: onNb((n) => void (n.password = undefined)) }),
          kw('update-source', 'Source of routing updates', { run: onNb((n) => void (n.updateSource = undefined)) })
        ]
      })
    ]
    const rpP: Param = { kind: 'word', label: 'WORD', values: () => T().routeMaps.map((r) => r.name) }
    const nbrAf: Node[] = [
      kw('route-policy', 'Apply route policy to neighbor', {
        children: [
          prm(rpP, 'Name of the policy', {
            name: 'rp',
            children: ['in', 'out'].map((dir) =>
              kw(dir, `Apply route policy to ${dir === 'in' ? 'inbound' : 'outbound'} routes`, {
                run: onNb((n, c) => {
                  if (!T().routeMaps.some((r) => r.name === c.args['rp'])) return `!!% Policy [${c.args['rp']}] uses the policy [${c.args['rp']}] which has not been defined` // [unverified, from memory]
                  if (dir === 'in') n.routeMapIn = c.args['rp']
                  else n.routeMapOut = c.args['rp']
                })
              })
            )
          })
        ]
      }),
      kw('next-hop-self', 'Disable the next hop calculation for this neighbor', { run: ok }),
      kw('soft-reconfiguration', 'Per neighbor soft reconfiguration', { children: [kw('inbound', 'Allow inbound soft reconfiguration for this neighbor', { run: ok, children: [kw('always', 'Always use soft reconfig', { run: ok })] })] }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('route-policy', 'Apply route policy to neighbor', { children: [prm(rpP, 'Name of the policy', { name: 'rp', children: ['in', 'out'].map((dir) => kw(dir, 'direction', { run: onNb((n) => { if (dir === 'in') n.routeMapIn = undefined; else n.routeMapOut = undefined }) })) })] })] })
    ]

    // ---- router ospf
    const OSPF = (): NonNullable<Device['ospf']> => (T().ospf ??= { process: '1', ifaces: [], neighbors: [] })
    const AREA_IF = (): NonNullable<Device['ospf']>['ifaces'][number] | undefined => OSPF().ifaces.find((o) => o.iface === (this.mode.ctx as { area: string; iface: string }).iface)
    const onAIf = (f: (o: NonNullable<Device['ospf']>['ifaces'][number], c: Ctx) => void) => (c: Ctx): string => {
      const o = AREA_IF()
      if (o) f(o, c)
      return ''
    }
    const ospfm: Node[] = [
      kw('router-id', 'configure this node', { children: [prm(ipP(), 'OSPF router-id in IPv4 address format', { name: 'rid', run: (c) => ((OSPF().routerId = c.args['rid']!), '') })] }),
      kw('area', 'Enter the OSPF area configuration submode', { children: [prm({ kind: 'word', label: '<0-4294967295>' }, 'OSPF area ID as a decimal value', { name: 'area', run: (c) => (this.setMode('config-ospf-ar', c.args['area'], this.mode), '') })] }),
      kw('log', 'Log ospf info', { children: [prm(line, 'adjacency changes', { run: ok })] })
    ]
    const aream: Node[] = [
      kw('interface', 'Enable routing on an interface', {
        children: this.ifNodes('if', (c) => {
          const i = findXrIf(T(), c.args['if']!)!
          const area = this.mode.ctx as string
          const o = OSPF()
          let x = o.ifaces.find((z) => z.iface === i.name)
          if (!x) o.ifaces.push((x = { iface: i.name, area }))
          else x.area = area
          this.setMode('config-ospf-ar-if', { area, iface: i.name }, this.mode)
          return ''
        })
      }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('interface', 'Enable routing on an interface', { children: this.ifNodes('if', (c) => { const i = findXrIf(T(), c.args['if']!)!; const o = OSPF(); o.ifaces = o.ifaces.filter((z) => z.iface !== i.name); return '' }) })] })
    ]
    const enDis = (help: string, set: (o: NonNullable<Device['ospf']>['ifaces'][number], v: boolean) => void): Node[] => [kw('enable', `Enable ${help}`, { run: onAIf((o) => set(o, true)) }), kw('disable', `Disable ${help}`, { run: onAIf((o) => set(o, false)) })]
    const aifm: Node[] = [
      kw('cost', 'Interface cost', { children: [prm(int(1, 65535), 'Cost', { name: 'cost', run: onAIf((o, c) => void (o.cost = Number(c.args['cost']))) })] }),
      kw('network', 'Network type', { children: [kw('point-to-point', 'Specify OSPF point-to-point network', { run: onAIf((o) => void (o.networkType = 'point-to-point')) }), kw('broadcast', 'Specify OSPF broadcast multi-access network', { run: onAIf((o) => void (o.networkType = 'broadcast')) })] }),
      kw('passive', 'Enable/Disable passive', { run: onAIf((o) => void (o.passive = true)), children: enDis('passive', (o, v) => void (o.passive = v || undefined)) }),
      kw('mtu-ignore', 'Enable/Disable ignoring of MTU in DBD packets', { run: onAIf((o) => void (o.mtuIgnore = true)), children: enDis('ignoring of MTU in DBD packets', (o, v) => void (o.mtuIgnore = v || undefined)) }),
      kw('no', 'Negate a command or set its defaults', { children: [kw('cost', 'Interface cost', { run: onAIf((o) => void (o.cost = undefined)) }), kw('network', 'Network type', { run: onAIf((o) => void (o.networkType = undefined)) }), kw('passive', 'passive', { run: onAIf((o) => void (o.passive = undefined)) }), kw('mtu-ignore', 'mtu-ignore', { run: onAIf((o) => void (o.mtuIgnore = undefined)) })] })
    ]

    // ---- router static
    const staticRoute = (remove: boolean) => (c: Ctx): string => {
      const t = T()
      const [prefix, len] = c.args['pfx']!.split('/')
      const vrf = this.mode.ctx as string | undefined
      const nh = c.args['nh']
      if (remove) {
        t.staticRoutes = t.staticRoutes.filter((r) => !(r.prefix === prefix && r.mask === Number(len) && (r.vrf ?? undefined) === vrf && (!nh || r.nextHop === nh)))
        return ''
      }
      if (!t.staticRoutes.some((r) => r.prefix === prefix && r.mask === Number(len) && r.nextHop === nh && (r.vrf ?? undefined) === vrf)) t.staticRoutes.push({ prefix: prefix!, mask: Number(len), nextHop: nh!, ...(vrf ? { vrf } : {}), ...(c.args['ad'] ? { ad: Number(c.args['ad']) } : {}) })
      return ''
    }
    const pfxP: Param = { kind: 'prefix', label: 'A.B.C.D/length' }
    const afi: Node[] = [
      prm(pfxP, 'Destination prefix', { name: 'pfx', children: [prm({ kind: 'word', label: 'A.B.C.D', test: (t) => isIpv4(t) || /^null0$/i.test(t) }, 'Forwarding router\'s address', { name: 'nh', run: staticRoute(false), children: [prm(int(1, 254), 'Distance metric for this path', { name: 'ad', run: staticRoute(false) })] })] }),
      kw('no', 'Negate a command or set its defaults', { children: [prm(pfxP, 'Destination prefix', { name: 'pfx', run: staticRoute(true), children: [prm({ kind: 'ipv4', label: 'A.B.C.D' }, 'Forwarding router\'s address', { name: 'nh', run: staticRoute(true) })] })] })
    ]
    const afiEnter = (mode: string): Node => kw('address-family', 'Enter Address Family command mode', { children: [kw('ipv4', 'IPv4 Address Family', { children: [kw('unicast', 'Address Family modifier', { run: () => (this.setMode(mode, this.mode.ctx, this.mode), '') })] })] })
    const staticm: Node[] = [afiEnter('config-static-afi'), kw('vrf', 'Enter a VRF', { children: [prm({ kind: 'word', label: 'WORD', values: () => T().vrfs.map((v) => v.name) }, 'VRF name', { name: 'vrf', run: (c) => (this.setMode('config-static-vrf', c.args['vrf'], this.mode), '') })] })]

    // ---- vrf, ACL
    const vrfm: Node[] = [kw('description', 'A description for the VRF', { children: [prm(line, 'Descriptive string', { run: ok })] }), afiEnter('config-vrf-af')]
    const vrfAf: Node[] = [...['import', 'export'].map((w) => kw(w, `VRF ${w} commands`, { children: [kw('route-target', `Specify ${w} route target extended communities`, { run: ok, children: [prm(line, 'Route target', { name: 'rt', run: (c) => { const v = T().vrfs.find((x) => x.name === this.mode.ctx); if (v && !v.rd) v.rd = c.args['rt']!.split(/\s+/)[0]!; return '' } })] })] }))]
    const ACL = (): Device['acls'][number] | undefined => T().acls.find((a) => a.name === this.mode.ctx)
    const aclEntry = (c: Ctx): string => {
      const a = ACL()
      if (!a) return ''
      const seq = c.args['seq'] ? Number(c.args['seq']) : (a.entries.at(-1)?.seq ?? 0) + 10
      a.entries = a.entries.filter((e) => e.seq !== seq)
      a.entries.push({ seq, action: c.args['act'] as 'permit', text: c.args['rest'] ?? '' })
      a.entries.sort((x, y) => x.seq - y.seq)
      return ''
    }
    const acts = (): Node[] => ['permit', 'deny', 'remark'].map((w) => kw(w, w === 'remark' ? 'Comment for access list' : `Specify packets to ${w === 'permit' ? 'forward' : 'reject'}`, { name: 'act', children: [prm(line, 'An IPv4 Protocol Number or name', { name: 'rest', run: aclEntry })] }))
    const aclm: Node[] = [...acts(), prm(int(1, 2147483646), 'Sequence number for this entry', { name: 'seq', children: acts() }), kw('no', 'Negate a command or set its defaults', { children: [prm(int(1, 2147483646), 'Sequence number for this entry', { name: 'seq', run: (c) => { const a = ACL(); if (a) a.entries = a.entries.filter((e) => e.seq !== Number(c.args['seq'])); return '' } })] })]

    return {
      config: tree(g),
      'config-if': tree(ifm),
      'config-bgp': tree(bgpm),
      'config-bgp-af': tree(bgpAf),
      'config-bgp-vrf': tree(bgpVrf),
      'config-bgp-nbr': tree(nbrm),
      'config-bgp-nbr-af': tree(nbrAf),
      'config-ospf': tree(ospfm),
      'config-ospf-ar': tree(aream),
      'config-ospf-ar-if': tree(aifm),
      'config-static': tree(staticm),
      'config-static-afi': tree(afi),
      'config-static-vrf': tree([afiEnter('config-static-vrf-afi')]),
      'config-static-vrf-afi': tree(afi),
      'config-vrf': tree(vrfm),
      'config-vrf-af': tree(vrfAf),
      'config-ipv4-acl': tree(aclm)
    }
  }
}

/** RPL bodies are stored two-space indented relative to `route-policy`. */
function reindent(lines: string[]): string[] {
  let depth = 0
  return lines.map((l) => {
    if (/^(endif|else|elseif\b)/.test(l)) depth = Math.max(0, depth - 1)
    const out = '  '.repeat(depth) + l
    if (/\bthen$/.test(l) || /^else$/.test(l)) depth++
    return out
  })
}

export const iosxrFactory = (s: Session): IosxrPersonality => new IosxrPersonality(s)
