/**
 * Huawei VRP personality, CloudEngine CE6800 flavour (VRP 8.x, two-stage configuration):
 * `<host>` user view, `system-view` -> `[~host]` (`[*host]` while the candidate has uncommitted
 * changes), sub-views `[~host-10GE1/0/1]`, `[~host-vlan50]`, `[~host-bgp]`; `quit`/`return`,
 * `commit`, `display configuration candidate`, `save` with a [Y/N] confirm, `display ...` in every
 * view, `?` help, Tab, `| include/exclude/begin/count/no-more`, the `  ---- More ----` pager and
 * `screen-length 0 temporary`.
 *
 * Strings are from memory of CE6800/S-series VRP [unverified, from memory] unless the brief gave them.
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { now } from '../../core/runtime.ts'
import { cmpIp, inSubnet, safeRegex, splitPipes, unifiedDiff } from '../../core/text.ts'
import { add, completions, dottedToLen, help as treeHelp, isIpv4, kw, match, prm, tokenOffsets, type Ctx, type HelpResult, type MatchResult, type Node, type Param } from '../../core/tree.ts'
import { deviceFrom, logEvent, restore, snapshot, tickBgp, type Device, type Iface } from '../../state.ts'
import { configLines, ifaceLines } from './config.ts'
import { VIRTUAL_TYPES, VRP_TYPES, findVrpIf, joinIfTokens, parseVrpIf } from './names.ts'
import * as R from './render.ts'

type ViewId = 'user' | 'system' | 'interface' | 'vlan' | 'bgp' | 'ospf'

interface View {
  id: ViewId
  /** Interface name, VLAN id, OSPF process. */
  ctx?: string
}

type Failure = Extract<MatchResult, { ok: false }>

/** CE prompt markers: `~` committed, `*` uncommitted changes. Flip to '' for S-series style prompts. */
const MARK_CLEAN = '~'
const MARK_DIRTY = '*'

export const VRP_PAGER: PagerSpec = {
  text: () => '  ---- More ----',
  // VRP erases the pager prompt with backspaces/spaces [unverified, from memory]: CE uses ESC[16D ESC[K.
  erase: (t) => '\b'.repeat(t.length) + ' '.repeat(t.length) + '\b'.repeat(t.length),
  keys: { ' ': 'page', '\r': 'line', '\n': 'line', q: 'quit', Q: 'quit', '\x03': 'quit' },
  other: 'quit'
}

const UNRECOGNIZED = "Error: Unrecognized command found at '^' position."
const WRONG_PARAM = "Error: Wrong parameter found at '^' position."
const INCOMPLETE = "Error: Incomplete command found at '^' position."
const AMBIGUOUS = "Error: Ambiguous command found at '^' position."

const TYPE_HELP: Record<string, string> = {
  '10GE': '10GE interface',
  '25GE': '25GE interface',
  '40GE': '40GE interface',
  '100GE': '100GE interface',
  GE: 'GigabitEthernet interface',
  MEth: 'MEth interface',
  LoopBack: 'LoopBack interface',
  Vlanif: 'Vlan interface',
  NULL: 'NULL interface',
  'Eth-Trunk': 'Ethernet-Trunk interface',
  Tunnel: 'Tunnel interface',
  Nve: 'Network virtualization edge interface'
}

export class VrpPersonality implements Personality {
  readonly s: Session
  readonly d: Device
  view: View = { id: 'user' }
  /** Candidate configuration (system view). */
  cand: Device | undefined
  dirty = false
  /** Interfaces whose error-down state an `undo shutdown` clears on commit. */
  private clearErr = new Set<string>()
  abortKeys = ['\x03']
  pager = VRP_PAGER
  private trees: Record<ViewId, Node[]> | undefined

  constructor(s: Session) {
    this.s = s
    this.d = s.d
  }

  banner(): string {
    const t = now(this.d)
    const lines = [
      '',
      'Info: The max number of VTY users is 21, the number of current VTY users online is 1, and total number of terminal users online is 1.',
      `      The current login time is ${R.hwDate(t)}+00:00.`,
      `      The last login time is ${R.hwDate(t - 26 * 3600_000)}+00:00 from ${this.s.from} through SSH.`
    ]
    if (this.d.motd !== undefined) lines.unshift(this.d.motd)
    return lines.join('\n') + '\n'
  }

  /** The config being edited (candidate while in system view). */
  work(): Device {
    return this.cand ?? this.d
  }

  promptText(): string {
    const host = this.d.hostname
    if (this.view.id === 'user') return `<${host}>`
    const mark = this.dirty ? MARK_DIRTY : MARK_CLEAN
    const sfx: Record<ViewId, string> = {
      user: '',
      system: '',
      interface: `-${this.view.ctx}`,
      vlan: `-vlan${this.view.ctx}`,
      bgp: '-bgp',
      ospf: `-ospf-${this.view.ctx}`
    }
    return `[${mark}${host}${sfx[this.view.id]}]`
  }

  prompt(_reason: PromptReason): string {
    return this.promptText()
  }

  // ------------------------------------------------------------------ errors

  private caret(offset: number): string {
    return ' '.repeat(this.promptText().length + offset) + '^'
  }

  private error(base: string, f: Failure, roots: Node[]): string {
    if (f.kind === 'incomplete') return `${this.caret(base.trimEnd().length + 1)}\n${INCOMPLETE}`
    if (f.kind === 'ambiguous') return `${this.caret(f.offset)}\n${AMBIGUOUS}`
    // A level that takes a parameter reports "Wrong parameter".
    const offs = tokenOffsets(base)
    const before = base.slice(0, offs[f.index] ?? base.length)
    const h = treeHelp(before, roots)
    const wrong = f.index > 0 && h.ok && h.entries.some((e) => !e.keyword)
    return `${this.caret(f.offset)}\n${wrong ? WRONG_PARAM : UNRECOGNIZED}`
  }

  // ------------------------------------------------------------------ execute

  /** Interface-name tokens joined; free text after `description`/`name` left alone. */
  private normalise(base: string): string {
    const m = /\b(description|name|header)\b/i.exec(base)
    if (!m) return joinIfTokens(base)
    return joinIfTokens(base.slice(0, m.index)) + base.slice(m.index)
  }

  private roots(id: ViewId = this.view.id): Node[] {
    this.trees ??= this.build()
    return this.trees[id]
  }

  async execute(raw: string): Promise<void> {
    const [rawBase, pipes] = splitPipes(raw)
    const base = this.normalise(rawBase)
    let roots = this.roots()
    let m = match(base, roots)
    if (!m.ok && m.kind !== 'ambiguous' && this.view.id !== 'user' && this.view.id !== 'system') {
      // VRP runs system-view commands from a sub-view and moves to that view.
      const g = match(base, this.roots('system'))
      if (g.ok) {
        this.view = { id: 'system' }
        m = g
        roots = this.roots('system')
      }
    }
    if (!m.ok) {
      await this.s.print(this.error(base, m, roots))
      return
    }
    let out = (await m.node.run!(m.ctx)) ?? ''
    let noMore = false
    for (const p of pipes) {
      const r = this.pipe(out, p, raw)
      if ('error' in r) {
        out = r.error
        break
      }
      out = r.out
      if (r.noMore) noMore = true
    }
    if (out) await this.s.print(out, { noMore })
  }

  private pipe(out: string, p: string, raw: string): { out: string; noMore?: boolean } | { error: string } {
    const [word = '', ...rest] = p.split(/\s+/)
    const names = ['begin', 'count', 'exclude', 'include', 'no-more', 'section']
    const hits = names.filter((n) => n.startsWith(word.toLowerCase()))
    const pos = raw.indexOf(p, raw.indexOf('|'))
    if (hits.length !== 1 || !word) return { error: `${this.caret(pos)}\n${hits.length > 1 ? AMBIGUOUS : UNRECOGNIZED}` }
    const lines = out.replace(/\n$/, '').split('\n')
    if (hits[0] === 'no-more') return { out, noMore: true }
    const pattern = rest.join(' ')
    if (!pattern) return { error: `${this.caret(raw.length + 1)}\n${INCOMPLETE}` }
    const re = safeRegex(pattern)
    if (!re) return { error: `${this.caret(pos + word.length + 1)}\n${WRONG_PARAM}` }
    switch (hits[0]) {
      case 'include':
        return { out: lines.filter((l) => re.test(l)).join('\n') }
      case 'exclude':
        return { out: lines.filter((l) => !re.test(l)).join('\n') }
      case 'begin': {
        const i = lines.findIndex((l) => re.test(l))
        return { out: i < 0 ? '' : lines.slice(i).join('\n') }
      }
      case 'count':
        return { out: `Total lines: ${lines.filter((l) => re.test(l)).length}` }
      default: {
        // section: a matching line plus the indented lines under it.
        const o: string[] = []
        let on = false
        for (const l of lines) {
          if (!/^\s/.test(l)) on = re.test(l)
          if (on) o.push(l)
        }
        return { out: o.join('\n') }
      }
    }
  }

  // ------------------------------------------------------------------ help & completion

  help(line: string): string {
    const [rawBase, pipes] = splitPipes(line)
    if (pipes.length) {
      return [
        '  begin    Begin with the line that matches',
        '  count    Count output',
        '  exclude  Exclude lines that match',
        '  include  Include lines that match',
        '  no-more  Show all output without pausing',
        '  section  Filter a section of output'
      ].join('\n')
    }
    const base = this.normalise(rawBase)
    const roots = this.roots()
    let h = treeHelp(base, roots)
    if (h.ok && !h.entries.length && !h.cr && this.view.id !== 'user' && this.view.id !== 'system') h = treeHelp(base, this.roots('system'))
    if (!h.ok) return `${this.caret(h.offset)}\n${h.kind === 'ambiguous' ? AMBIGUOUS : UNRECOGNIZED}`
    if (!h.entries.length && !h.cr) return `${this.caret(base.length)}\n${UNRECOGNIZED}`
    return this.helpList(h)
  }

  private helpList(h: Extract<HelpResult, { ok: true }>): string {
    const rows: [string, string][] = []
    for (const e of h.entries) {
      if (e.label === 'INTERFACE') for (const t of VRP_TYPES.filter((x) => x.toLowerCase().startsWith(h.partial.toLowerCase()))) rows.push([t, TYPE_HELP[t] ?? ''])
      else rows.push([e.label, e.help])
    }
    const out = rows.map(([l, t]) => `  ${l.length >= 24 ? l + ' ' : l.padEnd(24)}${t}`.trimEnd())
    if (h.cr) out.push('  <cr>')
    return out.join('\n')
  }

  tab(line: string): TabResult {
    const [rawBase, pipes] = splitPipes(line)
    if (pipes.length) return { bell: true }
    const base = this.normalise(rawBase)
    let { partial, options } = completions(base, this.roots())
    if (!options.length && this.view.id !== 'user' && this.view.id !== 'system') ({ partial, options } = completions(base, this.roots('system')))
    if (options.length === 1) return { line: line.slice(0, line.length - partial.length) + options[0] + ' ' }
    if (options.length > 1) return { list: options.join('  '), line }
    return { bell: true }
  }

  control(key: 'c' | 'z', _line: string): ControlResult {
    // Ctrl-Z returns to user view; an uncommitted candidate is kept for the next system-view.
    if (key === 'z')
      return {
        echo: '\n',
        then: () => {
          if (!this.dirty) this.discard()
          this.view = { id: 'user' }
        }
      }
    return { echo: '\n' }
  }

  // ------------------------------------------------------------------ config helpers

  private enterSystem(): void {
    this.cand ??= deviceFrom(this.d, snapshot(this.d))
    this.view = { id: 'system' }
  }

  private changed(): void {
    this.dirty = true
  }

  commit(): string {
    if (!this.cand || !this.dirty) return ''
    restore(this.d, snapshot(this.cand))
    for (const n of this.clearErr) {
      const i = this.d.interfaces.find((x) => x.name === n)
      if (i && i.adminUp && i.errDisabled) {
        i.errDisabled = undefined
        i.lastChange = now(this.d)
      }
    }
    this.clearErr.clear()
    this.dirty = false
    this.cand = deviceFrom(this.d, snapshot(this.d))
    ;(this.d.vendor as { vrp?: { updated?: number; by?: string } }).vrp = { ...(this.d.vendor['vrp'] as object), updated: now(this.d), by: this.s.user }
    logEvent(this.d, `CFG/4/CFG_CHANGE: Configuration is changed. (User=${this.s.user}, IpAddress=${this.s.from})`)
    tickBgp(this.d)
    return ''
  }

  private discard(): void {
    this.cand = undefined
    this.dirty = false
    this.clearErr.clear()
  }

  /** Leaving system view with uncommitted changes: Y commits, N discards, C stays. Returns false to stay. */
  private async leaveSystem(): Promise<boolean> {
    if (!this.dirty) {
      this.discard()
      return true
    }
    for (;;) {
      const a = (await this.s.ask('Warning: Uncommitted configurations found. Are you sure to commit them before exiting? [Y(yes)/N(no)/C(cancel)]:', { mode: 'line' })).trim().toLowerCase()
      if (a === 'y' || a === 'yes') {
        this.commit()
        this.discard()
        return true
      }
      if (a === 'n' || a === 'no') {
        this.discard()
        return true
      }
      if (a === 'c' || a === 'cancel' || a === '') return false
    }
  }

  private async quit(): Promise<string> {
    switch (this.view.id) {
      case 'user':
        this.s.close()
        return ''
      case 'system':
        if (await this.leaveSystem()) this.view = { id: 'user' }
        return ''
      default:
        this.view = { id: 'system' }
        return ''
    }
  }

  private async returnUser(): Promise<string> {
    if (this.view.id === 'user') return ''
    if (await this.leaveSystem()) this.view = { id: 'user' }
    return ''
  }

  private async save(): Promise<string> {
    const a = (await this.s.ask('Warning: The current configuration will be written to the device. Continue? [Y/N]:', { mode: 'line' })).trim().toLowerCase()
    if (a !== 'y' && a !== 'yes') return ''
    await this.s.print('Now saving the current configuration to the slot 1.')
    await this.s.sleep(50)
    this.d.startup = snapshot(this.d)
    ;(this.d.vendor as { vrp?: { saved?: number } }).vrp = { ...(this.d.vendor['vrp'] as object), saved: now(this.d) }
    return 'Info: Save the configuration successfully.'
  }

  private header(d: Device): { updated: string; saved?: string } {
    const v = (this.d.vendor['vrp'] ?? {}) as { updated?: number; by?: string; saved?: number }
    const saved = v.saved ?? this.d.startup?.takenAt
    return {
      updated: `${R.hwDate(v.updated ?? d.bootedAt)}+00:00 by ${v.by ?? 'SYSTEM automatically'}`,
      ...(saved !== undefined ? { saved: `${R.hwDate(saved)}+00:00` } : {})
    }
  }

  private currentConfig(i?: Iface): string {
    if (i) return ['#', ...ifaceLines(this.d, i), '#', 'return'].join('\n')
    return configLines(this.d, { header: this.header(this.d) }).join('\n')
  }

  private savedConfig(): string {
    const s = this.d.startup
    if (!s) return 'Info: The system is now comparing the configuration, please wait.\nInfo: No saved configuration file.'
    return configLines(deviceFrom(this.d, s)).join('\n')
  }

  private candidate(changed: boolean): string {
    const c = this.cand
    if (!c || !this.dirty) return changed ? '' : configLines(this.d).join('\n')
    if (!changed) return configLines(c).join('\n')
    const diff = unifiedDiff(configLines(this.d), configLines(c), 'running', 'candidate', 0)
    return diff.filter((l) => /^[+-][^+-]/.test(l) || /^[+-]$/.test(l)).join('\n')
  }

  private displayThis(): string {
    const w = this.work()
    switch (this.view.id) {
      case 'interface': {
        const i = w.interfaces.find((x) => x.name === this.view.ctx)
        return i ? ['#', ...ifaceLines(w, i), '#', 'return'].join('\n') : '#\nreturn'
      }
      case 'vlan': {
        const v = w.vlans.find((x) => String(x.id) === this.view.ctx)
        return ['#', `vlan ${this.view.ctx}`, ...(v?.name ? [` name ${v.name}`] : []), '#', 'return'].join('\n')
      }
      case 'bgp': {
        const lines = configLines(w)
        const a = lines.findIndex((l) => l.startsWith('bgp '))
        if (a < 0) return '#\nreturn'
        const b = lines.findIndex((l, k) => k > a && l === '#')
        return ['#', ...lines.slice(a, b), '#', 'return'].join('\n')
      }
      case 'ospf': {
        const lines = configLines(w)
        const a = lines.findIndex((l) => l.startsWith('ospf '))
        if (a < 0) return '#\nreturn'
        const b = lines.findIndex((l, k) => k > a && l === '#')
        return ['#', ...lines.slice(a, b), '#', 'return'].join('\n')
      }
      default:
        return configLines(w).join('\n')
    }
  }

  private curIf(): Iface | undefined {
    return this.work().interfaces.find((x) => x.name === this.view.ctx)
  }

  /** `interface X` in system view: existing, or a creatable virtual type. */
  private enterInterface(text: string): string {
    const w = this.work()
    const ref = parseVrpIf(text)
    if (!ref) return `Error: Wrong parameter found at '^' position.`
    let i = w.interfaces.find((x) => x.name.toLowerCase() === ref.name.toLowerCase())
    if (!i) {
      if (!VIRTUAL_TYPES.has(ref.type)) return 'Error: The interface does not exist.'
      i = { name: ref.name, short: ref.name, adminUp: true, linkUp: true, mode: 'routed', speed: '', mac: ref.type === 'Vlanif' ? '0c4b.7d21.0aff' : '' }
      if (ref.type === 'Vlanif') i.linkUp = w.vlans.some((v) => String(v.id) === ref.num)
      w.interfaces.push(i)
      this.changed()
    }
    this.view = { id: 'interface', ctx: i.name }
    return ''
  }

  private parseVlans(text: string): number[] | string {
    const toks = text.trim().split(/\s+/)
    const out: number[] = []
    for (let k = 0; k < toks.length; k++) {
      const a = Number(toks[k])
      if (!/^\d+$/.test(toks[k]!) || a < 1 || a > 4094) return WRONG_PARAM
      if (toks[k + 1] === 'to') {
        const b = Number(toks[k + 2])
        if (!/^\d+$/.test(toks[k + 2] ?? '') || b < a || b > 4094) return WRONG_PARAM
        for (let v = a; v <= b; v++) out.push(v)
        k += 2
      } else out.push(a)
    }
    return out
  }

  private addVlans(ids: number[]): void {
    const w = this.work()
    for (const id of ids) if (!w.vlans.some((v) => v.id === id)) w.vlans.push({ id, name: '' })
    w.vlans.sort((a, b) => a.id - b.id)
    for (const i of w.interfaces) if (i.name.startsWith('Vlanif') && ids.includes(Number(i.name.slice(6)))) i.linkUp = true
    this.changed()
  }

  private removeVlans(ids: number[]): string {
    const w = this.work()
    if (ids.includes(1)) return 'Error: The default VLAN cannot be deleted.'
    w.vlans = w.vlans.filter((v) => !ids.includes(v.id))
    for (const i of w.interfaces) {
      if (i.mode === 'access' && i.vlan !== undefined && ids.includes(i.vlan)) i.vlan = 1
      if (i.trunkAllowed) i.trunkAllowed = i.trunkAllowed.filter((v) => !ids.includes(v))
      if (i.name.startsWith('Vlanif') && ids.includes(Number(i.name.slice(6)))) i.linkUp = false
    }
    this.changed()
    return ''
  }

  private ping(target: string): Promise<string> {
    return (async () => {
      const r = R.routes(this.d).filter((x) => inSubnet(target, x.dest, x.mask)).sort((a, b) => b.mask - a.mask)[0]
      const known = this.d.interfaces.some((i) => i.ip === target) || this.d.arp.some((a) => a.ip === target) || this.d.bgp.some((n) => n.ip === target) || (r !== undefined && r.proto !== 'Direct')
      const ok = !!r && known
      await this.s.print(`  PING ${target}: 56  data bytes, press CTRL_C to break`)
      let got = 0
      let sent = 0
      for (let k = 1; k <= 5; k++) {
        if (!(await this.s.sleep(ok ? 20 : 200))) break
        sent++
        if (ok) {
          got++
          await this.s.print(`    Reply from ${target}: bytes=56 Sequence=${k} ttl=${r!.proto === 'Direct' ? 255 : 254} time=${1 + (k % 2)} ms`)
        } else await this.s.print('    Request time out')
      }
      const loss = sent ? (((sent - got) / sent) * 100).toFixed(2) : '0.00'
      const lines = ['', `  --- ${target} ping statistics ---`, `    ${sent} packet(s) transmitted`, `    ${got} packet(s) received`, `    ${loss}% packet loss`]
      if (got) lines.push('    round-trip min/avg/max = 1/1/2 ms')
      return lines.join('\n')
    })()
  }

  // ------------------------------------------------------------------ trees

  private ifParam(existing = true): Param {
    return {
      kind: 'iface',
      label: 'INTERFACE',
      values: () => this.work().interfaces.map((i) => i.name),
      test: (tok) => {
        const r = parseVrpIf(tok)
        if (!r) return false
        return existing ? !!findVrpIf(this.work(), tok) : true
      }
    }
  }

  private build(): Record<ViewId, Node[]> {
    const live = (): Device => this.d
    const int = (min: number, max: number): Param => ({ kind: 'int', label: `INTEGER<${min}-${max}>`, min, max })
    const str = (max: number): Param => ({ kind: 'line', label: `STRING<1-${max}>` })
    const ipP: Param = { kind: 'ipv4', label: 'IP_ADDR<X.X.X.X>' }
    const maskP: Param = { kind: 'word', label: 'IP_MASK<X.X.X.X>', test: (t) => dottedToLen(t) !== undefined || (/^\d+$/.test(t) && Number(t) <= 32) }
    const vlanList: Param = { kind: 'line', label: 'INTEGER<1-4094>' }

    // ---- display (every view)
    const display: Node[] = []
    const helps: Record<string, string> = {
      'display bgp': 'BGP information',
      'display ip': 'IP information',
      'display ospf': 'OSPF information',
      'display lldp': 'Link Layer Discovery Protocol',
      'display lldp neighbor': 'Neighbor information',
      'display configuration': 'Configuration information'
    }
    const D = (path: string, help: string, run: Node['run'], extra: Partial<Node> = {}): Node => add(display, `display ${path}`, help, run, extra, helps)
    add(display, 'display', 'Display information', undefined)
    D('version', 'Display version information', () => R.displayVersion(live()))
    D('current-configuration', 'Current configuration', () => this.currentConfig(), {
      children: [kw('interface', 'Interface', { children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => this.currentConfig(findVrpIf(this.d, c.args['if']!)) })] })]
    })
    D('saved-configuration', 'The configuration to be loaded at next startup', () => this.savedConfig())
    D('configuration candidate', 'Candidate configuration', () => this.candidate(false), { children: [kw('changed', 'Changed configuration', { run: () => this.candidate(true) })] })
    D('this', 'Display the configuration of the current view', () => this.displayThis())
    D('interface', 'Interface status and configuration information', () => this.d.interfaces.map((i) => R.displayInterface(this.d, i)).join('\n\n'), {
      children: [prm(this.ifParam(), 'Interface name', { name: 'if', run: (c) => R.displayInterface(this.d, findVrpIf(this.d, c.args['if']!)!) })]
    })
    D('interface brief', 'Brief information of status and configuration for interface', () => R.interfaceBrief(live()))
    D('ip interface brief', 'Brief information of status and configuration for interface', () => R.ipInterfaceBrief(live()))
    D('ip routing-table', 'IP routing table', () => R.routingTable(live()))
    D('bgp peer', 'Peers information', () => R.bgpPeer(live()))
    D('ospf peer', 'Neighbor information', () => R.ospfPeerBrief(live()))
    D('ospf peer brief', 'Brief information of neighbors', () => R.ospfPeerBrief(live()))
    D('vlan', 'VLAN information', () => R.displayVlan(live()), {
      children: [prm(int(1, 4094), 'VLAN ID', { name: 'vid', run: (c) => (this.d.vlans.some((v) => String(v.id) === c.args['vid']) ? R.displayVlan(this.d, Number(c.args['vid'])) : 'Error: The VLAN does not exist.') })]
    })
    D('lldp neighbor brief', 'Brief information of neighbors', () => R.lldpBrief(live()))
    D('cpu-usage', 'CPU usage information', () => R.cpuUsage(live()))
    D('clock', 'Clock status and configuration information', () => R.displayClock(live()))
    D('logbuffer', 'Log buffer', () => R.logbuffer(live()))
    D('mac-address', 'MAC address table', () => R.macTable(live()))
    D('arp', 'ARP entry', () => R.arpAll(live()))
    D('arp all', 'All ARP entry', () => R.arpAll(live()))
    D('users', 'User information', () => `  User-Intf    Delay    Type   Network Address     AuthenStatus    AuthorcmdFlag\n+ 34  VTY 0   00:00:00  SSH    ${this.s.from.padEnd(20)}pass            no\n  Username : ${this.s.user}`)

    const common = (): Node[] => [
      ...display,
      kw('quit', 'Exit from current mode and enter prior mode', { run: () => this.quit() }),
      kw('return', 'Enter the privileged mode', { run: () => this.returnUser() }),
      kw('commit', 'Commit the candidate configuration', { run: () => this.commit() }),
      kw('save', 'Save the current configuration to a file', { run: () => this.save() })
    ]

    // ---- user view
    const user: Node[] = [
      ...display,
      kw('quit', 'Exit from current mode and enter prior mode', { run: () => this.quit() }),
      kw('system-view', 'Enter the system view', {
        run: () => {
          this.enterSystem()
          return 'Enter system view, return user view with return command.'
        },
        children: [kw('immediately', 'Enter the system view and use the one-phase validation mode', { run: () => (this.enterSystem(), 'Enter system view, return user view with return command.') })]
      }),
      kw('save', 'Save the current configuration to a file', { run: () => this.save() }),
      kw('ping', 'Ping function', { children: [prm(ipP, 'IP address', { name: 'ip', run: (c) => this.ping(c.args['ip']!) })] }),
      kw('screen-length', 'Set the number of lines displayed on a screen', {
        children: [
          prm(int(0, 512), 'Number of lines on a screen', {
            name: 'n',
            children: [
              kw('temporary', 'Set the number of lines on the current terminal', {
                run: (c) => {
                  this.s.pageLength = Number(c.args['n'])
                  return 'Info: The configuration takes effect on the current user terminal interface only.'
                }
              }),
              // The brief's spelling; not a real keyword as far as I remember [unverified, from memory].
              kw('temporary-disable', 'Disable paging on the current terminal', { hidden: true, run: () => ((this.s.pageLength = 0), 'Info: The configuration takes effect on the current user terminal interface only.') })
            ]
          })
        ]
      }),
      kw('reboot', 'Reboot the device', {
        run: async () => {
          const a = (await this.s.ask('Warning: The system will reboot. Continue? [Y/N]:', { mode: 'line' })).trim().toLowerCase()
          return a === 'y' ? 'Info: [simulator] reboot acknowledged; the simulated device never reboots.' : ''
        }
      })
    ]

    // ---- system view
    const sys: Node[] = [
      ...common(),
      kw('abort', 'Abort the candidate configuration and exit to the user view', {
        run: () => {
          this.discard()
          this.view = { id: 'user' }
          return ''
        }
      }),
      kw('sysname', 'Set the host name', {
        children: [
          prm({ kind: 'word', label: 'STRING<1-246>' }, 'Host name', {
            name: 'n',
            run: (c) => {
              this.work().hostname = c.args['n']!
              this.changed()
            }
          })
        ]
      }),
      kw('interface', 'Specify an interface', { children: [prm(this.ifParam(false), 'Interface name', { name: 'if', run: (c) => this.enterInterface(c.args['if']!) })] }),
      kw('vlan', 'Configure VLAN', {
        children: [
          prm(int(1, 4094), 'VLAN ID', {
            name: 'vid',
            run: (c) => {
              this.addVlans([Number(c.args['vid'])])
              this.view = { id: 'vlan', ctx: c.args['vid'] }
            }
          }),
          kw('batch', 'Batch configure VLANs', {
            children: [
              prm(vlanList, 'VLAN ID list, e.g. 10 20 to 30', {
                name: 'list',
                run: (c) => {
                  const ids = this.parseVlans(c.args['list']!)
                  if (typeof ids === 'string') return ids
                  this.addVlans(ids)
                }
              })
            ]
          })
        ]
      }),
      kw('bgp', 'Enable BGP', {
        children: [
          prm({ kind: 'asn', label: 'STRING<1-11>' }, 'AS number', {
            name: 'as',
            run: (c) => {
              const w = this.work()
              const as = Number(c.args['as'])
              if (w.bgp.length && w.localAs !== as) return `Error: The specified AS number is different from the existing one (${w.localAs}).`
              if (w.localAs !== as) {
                w.localAs = as
                this.changed()
              }
              this.view = { id: 'bgp' }
            }
          })
        ]
      }),
      kw('ospf', 'Enable OSPF', {
        run: () => {
          this.view = { id: 'ospf', ctx: this.work().ospf?.process ?? '1' }
        },
        children: [prm(int(1, 4294967295), 'Process ID', { name: 'p', run: (c) => void (this.view = { id: 'ospf', ctx: c.args['p'] }) })]
      }),
      kw('ip', 'IP information', {
        children: [
          kw('route-static', 'Static route', {
            children: [
              prm(ipP, 'Destination IP address', {
                name: 'dst',
                children: [
                  prm(maskP, 'Mask or mask length', {
                    name: 'mask',
                    children: [
                      prm(ipP, 'Next hop address', {
                        name: 'nh',
                        run: (c) => {
                          const w = this.work()
                          const len = /^\d+$/.test(c.args['mask']!) ? Number(c.args['mask']) : dottedToLen(c.args['mask']!)!
                          if (!w.staticRoutes.some((r) => r.prefix === c.args['dst'] && r.mask === len && r.nextHop === c.args['nh'])) w.staticRoutes.push({ prefix: c.args['dst']!, mask: len, nextHop: c.args['nh']! })
                          this.changed()
                        }
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('header', 'Define the login banner', {
        children: [
          kw('login', 'Login banner', {
            children: [
              kw('information', 'Banner text', {
                children: [
                  prm({ kind: 'line', label: 'STRING<1-2000>' }, 'Banner text in quotes', {
                    name: 'txt',
                    run: (c) => {
                      this.work().motd = c.args['txt']!.replace(/^"(.*)"$/, '$1')
                      this.changed()
                    }
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('undo', 'Negate a command or set its default', {
        children: [
          kw('vlan', 'Delete VLAN', {
            children: [
              prm(int(1, 4094), 'VLAN ID', { name: 'vid', run: (c) => this.removeVlans([Number(c.args['vid'])]) }),
              kw('batch', 'Batch delete VLANs', {
                children: [
                  prm(vlanList, 'VLAN ID list', {
                    name: 'list',
                    run: (c) => {
                      const ids = this.parseVlans(c.args['list']!)
                      return typeof ids === 'string' ? ids : this.removeVlans(ids)
                    }
                  })
                ]
              })
            ]
          }),
          kw('interface', 'Delete an interface', {
            children: [
              prm(this.ifParam(), 'Interface name', {
                name: 'if',
                run: (c) => {
                  const w = this.work()
                  const r = parseVrpIf(c.args['if']!)!
                  if (!VIRTUAL_TYPES.has(r.type)) return 'Error: The interface cannot be deleted.'
                  w.interfaces = w.interfaces.filter((i) => i.name.toLowerCase() !== r.name.toLowerCase())
                  this.changed()
                }
              })
            ]
          }),
          kw('header', 'Remove the login banner', { children: [kw('login', 'Login banner', { run: () => void ((this.work().motd = undefined), this.changed()) })] })
        ]
      })
    ]

    // ---- interface view
    const ifc = (fn: (i: Iface) => string | void): ((c: Ctx) => string | void) => () => {
      const i = this.curIf()
      if (!i) return 'Error: The interface does not exist.'
      const r = fn(i)
      if (r === undefined) this.changed()
      return r
    }
    const l2 = (i: Iface): string | undefined => (i.mode === 'routed' ? 'Error: The interface is a Layer 3 interface. Run the portswitch command first.' : undefined)
    const iface: Node[] = [
      ...common(),
      kw('shutdown', 'Shut down the interface', { run: ifc((i) => void (i.adminUp = false)) }),
      kw('description', 'Set the description of the interface', { children: [prm(str(242), 'Description text', { name: 'txt', run: (c) => ifc((i) => void (i.description = c.args['txt']))(c) })] }),
      kw('ip', 'IP information', {
        children: [
          kw('address', 'Set the IP address of an interface', {
            children: [
              prm(ipP, 'IP address', {
                name: 'ip',
                children: [
                  prm(maskP, 'Mask or mask length', {
                    name: 'mask',
                    run: (c) =>
                      ifc((i) => {
                        if (/^(\d+GE|GE)/.test(i.name) && i.mode !== 'routed') return 'Error: This configuration cannot be performed on a Layer 2 interface. Run the undo portswitch command first.'
                        const m = c.args['mask']!
                        i.ip = c.args['ip']
                        i.mask = /^\d+$/.test(m) ? Number(m) : dottedToLen(m)
                      })(c)
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('mtu', 'Set the maximum transmission unit', { children: [prm(int(46, 9600), 'MTU value', { name: 'mtu', run: (c) => ifc((i) => void (i.mtu = Number(c.args['mtu'])))(c) })] }),
      kw('portswitch', 'Switch the interface to Layer 2 mode', {
        run: ifc((i) => {
          i.mode = 'access'
          i.vlan = 1
          i.ip = undefined
          i.mask = undefined
        })
      }),
      kw('port', 'Port configuration', {
        children: [
          kw('link-type', 'Set the link type of the port', {
            children: [
              kw('access', 'Access port', { run: ifc((i) => l2(i) ?? void ((i.mode = 'access'), (i.vlan ??= 1), (i.trunkAllowed = undefined))) }),
              kw('trunk', 'Trunk port', { run: ifc((i) => l2(i) ?? void ((i.mode = 'trunk'), (i.vlan = undefined), (i.trunkAllowed ??= []))) })
            ]
          }),
          kw('default', 'Default VLAN of the port', {
            children: [
              kw('vlan', 'VLAN', {
                children: [
                  prm(int(1, 4094), 'VLAN ID', {
                    name: 'vid',
                    run: (c) =>
                      ifc((i) => {
                        const e = l2(i)
                        if (e) return e
                        if (i.mode !== 'access') return 'Error: The port is not an access port.'
                        const v = Number(c.args['vid'])
                        if (!this.work().vlans.some((x) => x.id === v)) return 'Error: The VLAN does not exist.'
                        i.vlan = v
                      })(c)
                  })
                ]
              })
            ]
          }),
          kw('trunk', 'Trunk port', {
            children: [
              kw('allow-pass', 'Allowed VLANs', {
                children: [
                  kw('vlan', 'VLAN', {
                    children: [
                      prm(vlanList, 'VLAN ID list', {
                        name: 'list',
                        run: (c) =>
                          ifc((i) => {
                            if (i.mode !== 'trunk') return 'Error: The port is not a trunk port.'
                            const ids = this.parseVlans(c.args['list']!)
                            if (typeof ids === 'string') return ids
                            i.trunkAllowed = [...new Set([...(i.trunkAllowed ?? []), ...ids])].sort((a, b) => a - b)
                          })(c)
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      }),
      kw('undo', 'Negate a command or set its default', {
        children: [
          kw('shutdown', 'Bring the interface up', {
            run: ifc((i) => {
              i.adminUp = true
              this.clearErr.add(i.name)
            })
          }),
          kw('description', 'Remove the description', { run: ifc((i) => void (i.description = undefined)) }),
          kw('mtu', 'Restore the default MTU', { run: ifc((i) => void (i.mtu = undefined)) }),
          kw('ip', 'IP information', { children: [kw('address', 'Remove the IP address', { run: ifc((i) => void ((i.ip = undefined), (i.mask = undefined))) })] }),
          kw('portswitch', 'Switch the interface to Layer 3 mode', {
            run: ifc((i) => {
              if (!/^(\d+GE|GE)/.test(i.name)) return 'Error: The interface does not support this command.'
              i.mode = 'routed'
              i.vlan = undefined
              i.trunkAllowed = undefined
            })
          }),
          kw('port', 'Port configuration', {
            children: [
              kw('default', 'Default VLAN', { children: [kw('vlan', 'VLAN', { run: ifc((i) => void (i.vlan = 1)) })] }),
              kw('trunk', 'Trunk port', {
                children: [
                  kw('allow-pass', 'Allowed VLANs', {
                    children: [
                      kw('vlan', 'VLAN', {
                        children: [
                          prm(vlanList, 'VLAN ID list', {
                            name: 'list',
                            run: (c) =>
                              ifc((i) => {
                                const ids = this.parseVlans(c.args['list']!)
                                if (typeof ids === 'string') return ids
                                i.trunkAllowed = (i.trunkAllowed ?? []).filter((v) => !ids.includes(v))
                              })(c)
                          })
                        ]
                      })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      })
    ]

    // ---- vlan view
    const vlanCur = (): Device['vlans'][number] | undefined => this.work().vlans.find((v) => String(v.id) === this.view.ctx)
    const vlan: Node[] = [
      ...common(),
      kw('name', 'Set the VLAN name', {
        children: [
          prm({ kind: 'line', label: 'STRING<1-31>' }, 'VLAN name', {
            name: 'n',
            run: (c) => {
              const v = vlanCur()
              if (v) v.name = c.args['n']!
              this.changed()
            }
          })
        ]
      }),
      kw('description', 'Set the VLAN description', {
        children: [
          prm({ kind: 'line', label: 'STRING<1-80>' }, 'Description', {
            name: 'n',
            run: (c) => {
              const v = vlanCur()
              if (v) v.name = c.args['n']!
              this.changed()
            }
          })
        ]
      })
    ]

    // ---- bgp view
    const peerP: Param = { kind: 'ipv4', label: 'IPV4_ADDR<X.X.X.X>', values: () => this.work().bgp.map((n) => n.ip) }
    const findPeer = (ip: string): Device['bgp'][number] | undefined => this.work().bgp.find((n) => n.ip === ip)
    const viaFor = (ip: string): string => {
      const w = this.work()
      return w.interfaces.find((i) => i.ip && i.mask !== undefined && i.mask < 32 && inSubnet(ip, i.ip, i.mask))?.name ?? ''
    }
    const bgp: Node[] = [
      ...common(),
      kw('router-id', 'Configure the router ID', {
        children: [
          prm(ipP, 'Router ID', {
            name: 'rid',
            run: (c) => {
              this.work().routerId = c.args['rid']!
              this.changed()
            }
          })
        ]
      }),
      kw('peer', 'Specify a BGP peer', {
        children: [
          prm(peerP, 'IPv4 address of a peer', {
            name: 'ip',
            children: [
              kw('as-number', 'Specify the AS number of a peer', {
                children: [
                  prm({ kind: 'asn', label: 'STRING<1-11>' }, 'AS number', {
                    name: 'as',
                    run: (c) => {
                      const ip = c.args['ip']!
                      const n = findPeer(ip)
                      if (n) n.remoteAs = Number(c.args['as'])
                      else this.work().bgp.push({ ip, remoteAs: Number(c.args['as']), via: viaFor(ip), prefixes: 0 })
                      this.work().bgp.sort((a, b) => cmpIp(a.ip, b.ip))
                      this.changed()
                    }
                  })
                ]
              }),
              kw('description', 'Configure the description of a peer', {
                children: [
                  prm({ kind: 'line', label: 'STRING<1-255>' }, 'Description', {
                    name: 'txt',
                    run: (c) => {
                      const n = findPeer(c.args['ip']!)
                      if (!n) return 'Error: The peer does not exist.'
                      n.description = c.args['txt']
                      this.changed()
                    }
                  })
                ]
              }),
              kw('ignore', 'Disable the session with a peer', {
                run: (c) => {
                  const n = findPeer(c.args['ip']!)
                  if (!n) return 'Error: The peer does not exist.'
                  n.shutdown = true
                  this.changed()
                }
              }),
              kw('enable', 'Enable the peer in the address family', { hidden: true, run: () => undefined })
            ]
          })
        ]
      }),
      kw('undo', 'Negate a command or set its default', {
        children: [
          kw('peer', 'Delete a peer or a peer setting', {
            children: [
              prm(peerP, 'IPv4 address of a peer', {
                name: 'ip',
                run: (c) => {
                  const w = this.work()
                  if (!findPeer(c.args['ip']!)) return 'Error: The peer does not exist.'
                  w.bgp = w.bgp.filter((n) => n.ip !== c.args['ip'])
                  this.changed()
                },
                children: [
                  kw('ignore', 'Enable the session with a peer', {
                    run: (c) => {
                      const n = findPeer(c.args['ip']!)
                      if (!n) return 'Error: The peer does not exist.'
                      n.shutdown = false
                      this.changed()
                    }
                  }),
                  kw('description', 'Remove the description', {
                    run: (c) => {
                      const n = findPeer(c.args['ip']!)
                      if (n) n.description = undefined
                      this.changed()
                    }
                  })
                ]
              })
            ]
          })
        ]
      })
    ]

    const ospf: Node[] = [...common()]
    void isIpv4
    return { user, system: sys, interface: iface, vlan, bgp, ospf }
  }
}

export const vrpFactory = (s: Session): VrpPersonality => new VrpPersonality(s)
