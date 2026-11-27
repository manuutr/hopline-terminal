/**
 * MikroTik RouterOS 7 personality: path-based menus (`/interface`, `/ip address`, `/ip/address`,
 * `..`), the prompt `[admin@mt-br1] /interface> `, `print`/`set`/`add`/`remove`/`enable`/`disable`
 * by item number or name, `key=value` arguments (with `.as` dotted shorthand), `?` help, Tab
 * completion, `/export`, RouterOS errors (`bad command name x (line 1 column 1)`, `expected end of
 * command`, `syntax error`, `no such item`) and the `-- [Q quit|D dump|down]` pager.
 * Changes apply immediately (no commit/save).
 *
 * The command-tree engine (core/tree.ts) has no key=value support, so this module has its own
 * small lexer and menu walker. Strings are from memory of RouterOS 7.x [unverified, from memory].
 */
import type { ControlResult, PagerSpec, Personality, PromptReason, Session, TabResult } from '../../core/personality.ts'
import { now } from '../../core/runtime.ts'
import { inSubnet, network } from '../../core/text.ts'
import { isIpv4 } from '../../core/tree.ts'
import { isUp, logEvent, tickBgp, type Device, type Iface } from '../../state.ts'
import * as R from './render.ts'
import type { RosVendor } from '../../devices/routeros.ts'

interface Tok {
  text: string
  /** 1-based column. */
  col: number
}

interface Args {
  pos: string[]
  kv: Record<string, string>
  flags: Set<string>
  /** Column of the verb. */
  col: number
}

type Out = string | void | Promise<string | void>

interface Cmd {
  name: string
  help: string
  keys?: string[]
  flags?: string[]
  /** Label of positional arguments (item numbers, address). */
  pos?: string
  run: (a: Args) => Out
}

interface Menu {
  name: string
  help: string
  sub?: Menu[]
  cmds?: Cmd[]
}

export const ROS_PAGER: PagerSpec = {
  text: () => '-- [Q quit|D dump|down]',
  erase: (t) => '\r' + ' '.repeat(t.length) + '\r',
  // Down arrow arrives as ESC [ B; ESC and '[' are swallowed, 'B' scrolls one line.
  keys: { q: 'quit', Q: 'quit', d: 'all', D: 'all', ' ': 'page', '\r': 'line', '\n': 'line', B: 'line', '\x1b': 'ignore', '[': 'ignore', '\x03': 'quit' },
  other: 'ignore'
}

class RosError extends Error {}

/** Split a line into tokens; quotes and [ ... ] stay inside one token. */
export function lex(line: string): Tok[] | { syntax: number } {
  const out: Tok[] = []
  let k = 0
  while (k < line.length) {
    while (k < line.length && /\s/.test(line[k]!)) k++
    if (k >= line.length) break
    const start = k
    let text = ''
    let depth = 0
    let quote = false
    while (k < line.length && (quote || depth > 0 || !/\s/.test(line[k]!))) {
      const ch = line[k]!
      if (quote) {
        if (ch === '\\' && k + 1 < line.length) {
          text += ch + line[k + 1]
          k += 2
          continue
        }
        if (ch === '"') quote = false
      } else if (ch === '"') quote = true
      else if (ch === '[') depth++
      else if (ch === ']') depth--
      text += ch
      k++
    }
    if (quote || depth !== 0) return { syntax: start + 1 }
    out.push({ text, col: start + 1 })
  }
  return out
}

const unq = (v: string): string => (/^".*"$/s.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v)

function pick<T extends { name: string }>(list: T[], word: string): T | 'ambiguous' | undefined {
  const w = word.toLowerCase()
  const exact = list.find((x) => x.name.toLowerCase() === w)
  if (exact) return exact
  const pre = list.filter((x) => x.name.toLowerCase().startsWith(w))
  if (pre.length === 1) return pre[0]
  return pre.length ? 'ambiguous' : undefined
}

export class RouterosPersonality implements Personality {
  readonly s: Session
  readonly d: Device
  path: string[] = []
  abortKeys = ['\x03']
  pager = ROS_PAGER
  private root: Menu

  constructor(s: Session) {
    this.s = s
    this.d = s.d
    this.root = this.build()
  }

  banner(): string {
    return [
      '',
      '',
      '',
      '',
      '  MMM      MMM       KKK                          TTTTTTTTTTT      KKK',
      '  MMMM    MMMM       KKK                          TTTTTTTTTTT      KKK',
      '  MMM MMMM MMM  III  KKK  KKK  RRRRRR     OOOOOO      TTT     III  KKK  KKK',
      '  MMM  MM  MMM  III  KKKKK     RRR  RRR  OOO  OOO     TTT     III  KKKKK',
      '  MMM      MMM  III  KKK KKK   RRRRRR    OOO  OOO     TTT     III  KKK KKK',
      '  MMM      MMM  III  KKK  KKK  RRR  RRR   OOOOOO      TTT     III  KKK  KKK',
      '',
      `  MikroTik RouterOS ${this.d.version} (c) 1999-2024       https://www.mikrotik.com/`,
      '',
      'Press F1 for help',
      ...(this.d.motd !== undefined ? ['', this.d.motd] : []),
      '',
      ''
    ].join('\n')
  }

  promptText(): string {
    return `[${this.s.user}@${this.d.hostname}] ${this.path.length ? '/' + this.path.join('/') : ''}> `
  }

  prompt(_reason: PromptReason): string {
    return this.promptText()
  }

  control(_key: 'c' | 'z', _line: string): ControlResult {
    return { echo: '\n' }
  }

  // ------------------------------------------------------------------ walking

  private menuAt(path: string[]): Menu {
    let m = this.root
    for (const p of path) m = m.sub!.find((x) => x.name === p)!
    return m
  }

  /**
   * Walk path tokens from the current (or root) menu. Returns the menu path, the verb (if any)
   * and the index of the first argument token.
   */
  private walk(toks: Tok[], partial = false): { path: string[]; cmd?: Cmd; next: number; bad?: Tok; ambiguous?: boolean } {
    let path = [...this.path]
    let k = 0
    const segs: (Tok & { ti: number })[] = []
    // Expand path-like tokens ("/ip/address", "ip/address", "/") into segments.
    for (; k < toks.length; k++) {
      const t = toks[k]!
      if (t.text.includes('=') || t.text.startsWith('[') || t.text.startsWith('"')) break
      if (!t.text.includes('/')) {
        segs.push({ ...t, ti: k })
        continue
      }
      if (t.text.startsWith('/') && k === 0) segs.push({ text: '/', col: t.col, ti: k })
      let c = t.col
      for (const part of t.text.split('/')) {
        if (part) segs.push({ text: part, col: c, ti: k })
        c += part.length + 1
      }
    }
    const rest = k
    for (let j = 0; j < segs.length; j++) {
      const s = segs[j]!
      if (s.text === '/') {
        path = []
        continue
      }
      if (s.text === '..') {
        path.pop()
        continue
      }
      const m = this.menuAt(path)
      const sub = pick(m.sub ?? [], s.text)
      const cmd = pick(this.cmdsOf(path), s.text)
      const exactCmd = cmd && cmd !== 'ambiguous' && cmd.name === s.text.toLowerCase()
      if (sub && sub !== 'ambiguous' && !exactCmd && (!cmd || cmd === 'ambiguous' || sub.name === s.text.toLowerCase())) {
        path.push(sub.name)
        continue
      }
      if (cmd && cmd !== 'ambiguous' && (!sub || exactCmd)) return { path, cmd, next: s.ti + 1 }
      return { path, next: toks.length, bad: s, ambiguous: sub === 'ambiguous' || cmd === 'ambiguous' || (!!sub && !!cmd) }
    }
    void partial
    return { path, next: rest }
  }

  /** Commands available in a menu: its own plus global ones. */
  private cmdsOf(path: string[]): Cmd[] {
    const own = this.menuAt(path).cmds ?? []
    const glob = this.globals.filter((g) => !own.some((c) => c.name === g.name))
    return [...own, ...(path.length ? glob : [])]
  }

  private globals: Cmd[] = []

  private parseArgs(cmd: Cmd, toks: Tok[], from: number, col: number): Args {
    const a: Args = { pos: [], kv: {}, flags: new Set(), col }
    let lastKey = ''
    for (let k = from; k < toks.length; k++) {
      const t = toks[k]!
      const eq = t.text.indexOf('=')
      if (eq > 0 && !t.text.startsWith('[') && !t.text.startsWith('"')) {
        let key = t.text.slice(0, eq)
        if (key.startsWith('.') && lastKey.includes('.')) key = lastKey.slice(0, lastKey.indexOf('.')) + key
        const keys = cmd.keys ?? []
        const hit = keys.find((x) => x === key) ?? (keys.filter((x) => x.startsWith(key)).length === 1 ? keys.find((x) => x.startsWith(key)) : undefined)
        if (!hit) throw new RosError(`expected end of command (line 1 column ${t.col})`)
        a.kv[hit] = unq(t.text.slice(eq + 1))
        lastKey = hit
        continue
      }
      const fl = (cmd.flags ?? []).find((f) => f === t.text) ?? ((cmd.flags ?? []).filter((f) => f.startsWith(t.text)).length === 1 ? (cmd.flags ?? []).find((f) => f.startsWith(t.text)) : undefined)
      if (fl) {
        a.flags.add(fl)
        continue
      }
      if (cmd.pos) {
        a.pos.push(t.text)
        continue
      }
      throw new RosError(`expected end of command (line 1 column ${t.col})`)
    }
    return a
  }

  async execute(line: string): Promise<void> {
    const toks = lex(line)
    if ('syntax' in toks) {
      await this.s.print(`syntax error (line 1 column ${toks.syntax})`)
      return
    }
    if (!toks.length) return
    const w = this.walk(toks)
    if (w.bad) {
      await this.s.print(`${w.ambiguous ? 'ambiguous command name' : 'bad command name'} ${w.bad.text} (line 1 column ${w.bad.col})`)
      return
    }
    if (!w.cmd) {
      if (w.next < toks.length) {
        const t = toks[w.next]!
        await this.s.print(`expected command name (line 1 column ${t.col})`)
        return
      }
      this.path = w.path
      return
    }
    try {
      const a = this.parseArgs(w.cmd, toks, w.next, toks[0]!.col)
      const out = await this.withPath(w.path, () => w.cmd!.run(a))
      this.sync()
      tickBgp(this.d)
      if (out) await this.s.print(out, { noMore: a.flags.has('without-paging') })
    } catch (e) {
      if (e instanceof RosError) await this.s.print(e.message)
      else throw e
    }
  }

  private ctx: string[] = []
  private async withPath(p: string[], fn: () => Out): Promise<string | void> {
    const prev = this.ctx
    this.ctx = p
    try {
      return await fn()
    } finally {
      this.ctx = prev
    }
  }

  /** Derived link state: VLAN interfaces follow their parent, bridges their ports. */
  private sync(): void {
    const v = R.ros(this.d)
    for (const i of this.d.interfaces) {
      const vi = v.vlanIfs[i.name]
      if (vi) {
        const p = this.d.interfaces.find((x) => x.name === vi.parent)
        i.linkUp = !!p && isUp(p)
      }
    }
    for (const b of this.d.interfaces.filter((i) => R.ifType(this.d, i) === 'bridge')) {
      const ports = Object.entries(v.bridgePorts).filter(([, br]) => br === b.name).map(([n]) => this.d.interfaces.find((x) => x.name === n))
      b.linkUp = ports.some((p) => p && isUp(p))
    }
  }

  // ------------------------------------------------------------------ help & tab

  private context(line: string): { names: [string, string][]; partial: string; header?: string } | undefined {
    const toks = lex(line)
    if ('syntax' in toks) return undefined
    const partial = /\s$/.test(line) || !toks.length ? '' : toks.at(-1)!.text
    const fixed = partial ? toks.slice(0, -1) : toks
    // A partial path segment after a slash ("/ip/addr").
    let pre = ''
    let part = partial
    if (partial && !partial.includes('=') && partial.includes('/')) {
      const cut = partial.lastIndexOf('/')
      pre = partial.slice(0, cut + 1)
      part = partial.slice(cut + 1)
    }
    const w = this.walk(pre ? [...fixed, { text: pre, col: 1 }] : fixed)
    if (w.bad) return undefined
    if (!w.cmd) {
      const m = this.menuAt(w.path)
      const names: [string, string][] = []
      if (w.path.length) names.push(['..', 'go up to ' + (w.path.length > 1 ? w.path.slice(0, -1).join(' ') : 'root')])
      for (const s of m.sub ?? []) names.push([s.name + '/', s.help])
      for (const c of this.cmdsOf(w.path)) names.push([c.name, c.help])
      return { names: names.filter(([n]) => n.toLowerCase().startsWith(part.toLowerCase())), partial: part, header: part ? undefined : m.help }
    }
    const c = w.cmd
    const names: [string, string][] = []
    if (c.pos) names.push([`<${c.pos}>`, c.pos === 'numbers' ? 'List of item numbers' : c.pos])
    for (const k of c.keys ?? []) names.push([k + '=', ''])
    for (const f of c.flags ?? []) names.push([f, ''])
    return { names: names.filter(([n]) => !n.startsWith('<') || !part).filter(([n]) => n.toLowerCase().startsWith(part.toLowerCase())), partial: part, header: part ? undefined : c.help }
  }

  help(line: string): string {
    const c = this.context(line)
    if (!c) return ''
    const out: string[] = []
    if (c.header) out.push(c.header, '')
    for (const [n, h] of c.names) out.push(h ? `${n} -- ${h}` : n)
    return out.join('\n')
  }

  tab(line: string): TabResult {
    const c = this.context(line)
    if (!c) return { bell: true }
    const opts = c.names.map(([n]) => n.replace(/\/$/, '')).filter((n) => !n.startsWith('<') && n !== '..')
    if (!opts.length) return { bell: true }
    const head = line.slice(0, line.length - c.partial.length)
    if (opts.length === 1) {
      const o = opts[0]!
      return { line: head + o + (o.endsWith('=') ? '' : ' ') }
    }
    let common = opts[0]!
    for (const o of opts) while (!o.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1)
    if (common.length > c.partial.length) return { line: head + common }
    return { list: opts.join('  '), line }
  }

  // ------------------------------------------------------------------ items

  /** Resolve item references: "0", "0,2", a name, or `[ find name=x ]`. */
  private items<T>(list: T[], refs: string[], nameOf: (x: T) => string, prop: (x: T, k: string) => string | undefined = () => undefined): T[] {
    if (!refs.length) throw new RosError('failure: no items specified')
    const out: T[] = []
    for (const ref of refs) {
      const f = /^\[\s*find\s*(.*?)\s*\]$/.exec(ref)
      if (f) {
        const conds = [...f[1]!.matchAll(/([\w.-]+)=("[^"]*"|\S+)/g)]
        for (const x of list) if (conds.every((m) => (m[1] === 'name' || m[1] === 'default-name' ? nameOf(x) : prop(x, m[1]!)) === unq(m[2]!))) out.push(x)
        continue
      }
      for (const part of unq(ref).split(',')) {
        if (/^\d+$/.test(part)) {
          const x = list[Number(part)]
          if (x === undefined) throw new RosError('no such item')
          out.push(x)
        } else {
          const x = list.find((y) => nameOf(y) === part)
          if (!x) throw new RosError(`no such item`)
          out.push(x)
        }
      }
    }
    return [...new Set(out)]
  }

  private refs(a: Args): string[] {
    return a.kv['numbers'] !== undefined ? [a.kv['numbers']] : a.pos
  }

  private yes(v: string | undefined): boolean | undefined {
    if (v === undefined) return undefined
    if (v === 'yes' || v === 'true') return true
    if (v === 'no' || v === 'false') return false
    throw new RosError(`value of disabled must be yes or no`)
  }

  private ifaceOps(list: () => Iface[], print: (l: Iface[], a: Args) => string, extra: Cmd[] = []): Cmd[] {
    const d = this.d
    const name = (i: Iface): string => i.name
    const setDisabled = (i: Iface, dis: boolean): void => {
      if (i.adminUp === !dis) return
      i.adminUp = !dis
      i.lastChange = now(d)
      logEvent(d, `interface,info ${i.name} link ${dis ? 'down' : 'up'}`)
    }
    return [
      { name: 'print', help: 'Print values of item properties', flags: ['without-paging', 'detail', 'terse', 'brief', 'stats'], keys: ['where'], run: (a) => print(list(), a) },
      {
        name: 'set',
        help: 'Change item properties',
        pos: 'numbers',
        keys: ['numbers', 'disabled', 'comment', 'mtu', 'name'],
        run: (a) => {
          for (const i of this.items(list(), this.refs(a), name)) {
            const dis = this.yes(a.kv['disabled'])
            if (dis !== undefined) setDisabled(i, dis)
            if (a.kv['comment'] !== undefined) i.description = a.kv['comment'] === '' ? undefined : a.kv['comment']
            if (a.kv['mtu'] !== undefined) i.mtu = Number(a.kv['mtu'])
            if (a.kv['name'] !== undefined) this.rename(i, a.kv['name'])
          }
        }
      },
      { name: 'enable', help: 'Enable items', pos: 'numbers', keys: ['numbers'], run: (a) => void this.items(list(), this.refs(a), name).forEach((i) => setDisabled(i, false)) },
      { name: 'disable', help: 'Disable items', pos: 'numbers', keys: ['numbers'], run: (a) => void this.items(list(), this.refs(a), name).forEach((i) => setDisabled(i, true)) },
      {
        name: 'comment',
        help: 'Set comment for items',
        pos: 'numbers',
        keys: ['numbers', 'comment'],
        run: (a) => void this.items(list(), this.refs(a), name).forEach((i) => (i.description = a.kv['comment']))
      },
      this.exportCmd(),
      ...extra
    ]
  }

  private rename(i: Iface, to: string): void {
    const v = R.ros(this.d)
    const from = i.name
    if (v.vlanIfs[from]) {
      v.vlanIfs[to] = v.vlanIfs[from]!
      delete v.vlanIfs[from]
    }
    if (v.bridgePorts[from]) {
      v.bridgePorts[to] = v.bridgePorts[from]!
      delete v.bridgePorts[from]
    }
    for (const [p, b] of Object.entries(v.bridgePorts)) if (b === from) v.bridgePorts[p] = to
    for (const x of Object.values(v.vlanIfs)) if (x.parent === from) x.parent = to
    for (const n of this.d.bgp) if (n.via === from) n.via = to
    i.name = to
    i.short = to
  }

  private ifStats(list: Iface[]): string {
    const rows: R.Row[] = list.map((i, k) => {
      const s = statsOf(this.d, i)
      return { num: k, flags: R.ifFlags(this.d, i), values: [i.name, s.rxB, s.txB, s.rxP, s.txP, s.fcs, s.col] }
    })
    return R.table([[['X', 'DISABLED'], ['R', 'RUNNING'], ['S', 'SLAVE']]], [{ name: 'NAME' }, { name: 'RX-BYTE', right: true }, { name: 'TX-BYTE', right: true }, { name: 'RX-PACKET', right: true }, { name: 'TX-PACKET', right: true }, { name: 'RX-FCS-ERROR', right: true }, { name: 'TX-COLLISION', right: true }], rows)
  }

  private exportCmd(): Cmd {
    return {
      name: 'export',
      help: 'Print or save an export script that can be used to restore configuration',
      flags: ['compact', 'verbose', 'terse', 'show-sensitive', 'hide-sensitive'],
      keys: ['file'],
      run: (a) => {
        if (a.kv['file'] !== undefined) return ''
        const p = this.ctx.length ? '/' + this.ctx.join(' ') : ''
        return R.exportText(this.d, p, a.flags.has('verbose'))
      }
    }
  }

  private ping(a: Args): Promise<string> {
    return (async () => {
      const target = a.kv['address'] ?? a.pos[0]
      if (!target) throw new RosError('failure: address not specified')
      if (!isIpv4(target)) throw new RosError(`invalid value for argument address`)
      const count = a.kv['count'] !== undefined ? Number(a.kv['count']) : 4
      const rs = R.routes(this.d).filter((r) => r.active && inSubnet(target, r.dst, r.mask)).sort((x, y) => y.mask - x.mask)
      const r = rs[0]
      const known = this.d.interfaces.some((i) => isUp(i) && i.ip === target) || this.d.arp.some((x) => x.ip === target) || this.d.bgp.some((n) => n.ip === target) || (r !== undefined && r.kind !== 'c')
      const ok = !!r && known
      const lines = ['  SEQ HOST                                     SIZE TTL TIME       STATUS']
      await this.s.print(lines[0]!)
      let got = 0
      let sent = 0
      for (let k = 0; k < count; k++) {
        if (!(await this.s.sleep(ok ? 20 : 100))) break
        sent++
        if (ok) {
          got++
          await this.s.print(`  ${String(k).padStart(3)} ${target.padEnd(40)} ${'56'.padStart(4)} ${'64'.padStart(3)} ${`${380 + k * 17}us`.padEnd(10)}`)
        } else await this.s.print(`  ${String(k).padStart(3)} ${target.padEnd(40)} ${''.padStart(4)} ${''.padStart(3)} ${''.padEnd(10)} timeout`)
      }
      const loss = sent ? Math.round(((sent - got) / sent) * 100) : 0
      return `    sent=${sent} received=${got} packet-loss=${loss}%${got ? ' min-rtt=380us avg-rtt=405us max-rtt=431us' : ''}`
    })()
  }

  // ------------------------------------------------------------------ menus

  private build(): Menu {
    const d = this.d
    const v = (): RosVendor => R.ros(d)
    const ifPrint = (render: (dev: Device, l: Iface[]) => string) => (l: Iface[], a: Args): string => (a.flags.has('stats') ? this.ifStats(l) : render(d, l))
    const ethers = (): Iface[] => d.interfaces.filter((i) => R.ifType(d, i) === 'ether')
    const vlans = (): Iface[] => d.interfaces.filter((i) => v().vlanIfs[i.name])
    const bridges = (): Iface[] => d.interfaces.filter((i) => R.ifType(d, i) === 'bridge')
    const ro = (name: string, help: string, run: (a: Args) => Out, flags: string[] = ['without-paging', 'detail', 'terse']): Cmd => ({ name, help, flags, keys: ['where'], run })

    const vlanAdd: Cmd = {
      name: 'add',
      help: 'Create a new item',
      keys: ['name', 'vlan-id', 'interface', 'disabled', 'comment', 'mtu', 'arp'],
      run: (a) => {
        const vid = a.kv['vlan-id']
        if (vid === undefined) throw new RosError('failure: vlan-id not specified')
        if (!/^\d+$/.test(vid) || Number(vid) < 1 || Number(vid) > 4094) throw new RosError('value of vlan-id out of range (1..4094)')
        const parentName = a.kv['interface']
        if (parentName === undefined) throw new RosError('failure: interface not specified')
        const parent = d.interfaces.find((i) => i.name === parentName)
        if (!parent) throw new RosError('input does not match any value of interface')
        let name = a.kv['name']
        if (!name) {
          let n = 1
          while (d.interfaces.some((i) => i.name === `vlan${n}`)) n++
          name = `vlan${n}`
        }
        if (d.interfaces.some((i) => i.name === name)) throw new RosError('failure: already have interface with such name')
        if (Object.values(v().vlanIfs).some((x) => x.parent === parent.name && x.vid === Number(vid))) throw new RosError('failure: already have such vlan on this interface')
        const dis = this.yes(a.kv['disabled']) ?? false
        const i: Iface = { name, short: name, vlan: Number(vid), adminUp: !dis, linkUp: isUp(parent), mode: 'routed', speed: '', mac: parent.mac }
        if (a.kv['comment'] !== undefined) i.description = a.kv['comment']
        if (a.kv['mtu'] !== undefined) i.mtu = Number(a.kv['mtu'])
        d.interfaces.push(i)
        v().vlanIfs[name] = { vid: Number(vid), parent: parent.name }
        if (!d.vlans.some((x) => x.id === Number(vid))) d.vlans.push({ id: Number(vid), name })
        d.vlans.sort((x, y) => x.id - y.id)
      }
    }
    const vlanRemove: Cmd = {
      name: 'remove',
      help: 'Remove item',
      pos: 'numbers',
      keys: ['numbers'],
      run: (a) => {
        for (const i of this.items(vlans(), this.refs(a), (x) => x.name)) {
          const vid = v().vlanIfs[i.name]!.vid
          delete v().vlanIfs[i.name]
          d.interfaces = d.interfaces.filter((x) => x !== i)
          if (!Object.values(v().vlanIfs).some((x) => x.vid === vid)) d.vlans = d.vlans.filter((x) => x.id !== vid)
        }
      }
    }

    const addrList = (): Iface[] => R.addrIfaces(d)
    const ipAddress: Menu = {
      name: 'address',
      help: 'Address management',
      cmds: [
        ro('print', 'Print values of item properties', () => R.addresses(d)),
        {
          name: 'add',
          help: 'Create a new item',
          keys: ['address', 'interface', 'network', 'comment', 'disabled', 'netmask', 'broadcast'],
          run: (a) => {
            const addr = a.kv['address']
            if (!addr) throw new RosError('failure: address not specified')
            const [ip, len = '32'] = addr.split('/')
            if (!ip || !isIpv4(ip) || !/^\d+$/.test(len) || Number(len) > 32) throw new RosError('invalid value for argument address')
            const ifn = a.kv['interface']
            if (!ifn) throw new RosError('failure: interface not specified')
            const i = d.interfaces.find((x) => x.name === ifn)
            if (!i) throw new RosError('input does not match any value of interface')
            // [simulator] the shared model holds one address per interface.
            if (i.ip) throw new RosError('failure: already have address on this interface (simulator: one address per interface)')
            i.ip = ip
            i.mask = Number(len)
          }
        },
        {
          name: 'remove',
          help: 'Remove item',
          pos: 'numbers',
          keys: ['numbers'],
          run: (a) => {
            for (const i of this.items(addrList(), this.refs(a), (x) => `${x.ip}/${x.mask}`, (x, k) => (k === 'interface' ? x.name : k === 'address' ? `${x.ip}/${x.mask}` : undefined))) {
              i.ip = undefined
              i.mask = undefined
            }
          }
        },
        this.exportCmd()
      ]
    }
    const ipRoute: Menu = {
      name: 'route',
      help: 'Routes',
      cmds: [
        ro('print', 'Print values of item properties', () => R.routePrint(d)),
        {
          name: 'add',
          help: 'Create a new item',
          keys: ['dst-address', 'gateway', 'distance', 'comment', 'disabled', 'routing-table'],
          run: (a) => {
            const dst = a.kv['dst-address'] ?? '0.0.0.0/0'
            const [ip, len = '32'] = dst.split('/')
            if (!ip || !isIpv4(ip) || !/^\d+$/.test(len) || Number(len) > 32) throw new RosError('invalid value for argument dst-address')
            const gw = a.kv['gateway']
            if (!gw) throw new RosError('failure: gateway not specified')
            d.staticRoutes.push({ prefix: network(ip, Number(len)), mask: Number(len), nextHop: gw, ad: a.kv['distance'] !== undefined ? Number(a.kv['distance']) : 1 })
          }
        },
        {
          name: 'remove',
          help: 'Remove item',
          pos: 'numbers',
          keys: ['numbers'],
          run: (a) => {
            const del = this.items(d.staticRoutes, this.refs(a), (r) => `${r.prefix}/${r.mask}`)
            d.staticRoutes = d.staticRoutes.filter((r) => !del.includes(r))
          }
        },
        this.exportCmd()
      ]
    }

    const bgpConn: Menu = {
      name: 'connection',
      help: 'BGP connections',
      cmds: [
        ro('print', 'Print values of item properties', () => R.bgpConnections(d)),
        {
          name: 'add',
          help: 'Create a new item',
          keys: ['name', 'remote.address', 'remote.as', 'local.role', 'local.address', 'as', 'router-id', 'templates', 'disabled', 'routing-table', 'comment'],
          run: (a) => {
            const ip = a.kv['remote.address']?.replace(/\/32$/, '')
            if (!ip || !isIpv4(ip)) throw new RosError('failure: remote.address not specified')
            if (d.bgp.some((n) => n.ip === ip)) throw new RosError('failure: connection with such remote address already exists')
            const as = Number(a.kv['remote.as'] ?? NaN)
            if (!Number.isFinite(as)) throw new RosError('failure: remote.as not specified')
            const via = d.interfaces.find((i) => i.ip && i.mask !== undefined && i.mask < 32 && inSubnet(ip, i.ip, i.mask))?.name ?? ''
            d.bgp.push({ ip, remoteAs: as, via, prefixes: 0, shutdown: this.yes(a.kv['disabled']) ?? false, ...(a.kv['comment'] ? { description: a.kv['comment'] } : {}) })
            v().bgpNames[ip] = a.kv['name'] ?? `peer${d.bgp.length}`
            if (a.kv['as'] !== undefined) d.localAs = Number(a.kv['as'])
          }
        },
        {
          name: 'set',
          help: 'Change item properties',
          pos: 'numbers',
          keys: ['numbers', 'remote.as', 'disabled', 'name'],
          run: (a) => {
            for (const n of this.items(d.bgp, this.refs(a), (x) => v().bgpNames[x.ip] ?? x.ip)) {
              if (a.kv['remote.as'] !== undefined) n.remoteAs = Number(a.kv['remote.as'])
              const dis = this.yes(a.kv['disabled'])
              if (dis !== undefined) n.shutdown = dis
              if (a.kv['name'] !== undefined) v().bgpNames[n.ip] = a.kv['name']
            }
          }
        },
        { name: 'enable', help: 'Enable items', pos: 'numbers', keys: ['numbers'], run: (a) => void this.items(d.bgp, this.refs(a), (x) => v().bgpNames[x.ip] ?? x.ip).forEach((n) => (n.shutdown = false)) },
        { name: 'disable', help: 'Disable items', pos: 'numbers', keys: ['numbers'], run: (a) => void this.items(d.bgp, this.refs(a), (x) => v().bgpNames[x.ip] ?? x.ip).forEach((n) => (n.shutdown = true)) },
        {
          name: 'remove',
          help: 'Remove item',
          pos: 'numbers',
          keys: ['numbers'],
          run: (a) => {
            const del = this.items(d.bgp, this.refs(a), (x) => v().bgpNames[x.ip] ?? x.ip)
            d.bgp = d.bgp.filter((n) => !del.includes(n))
          }
        },
        this.exportCmd()
      ]
    }

    this.globals = [
      { name: 'quit', help: 'Quit console', run: () => void this.s.close() },
      { name: 'ping', help: 'Send ICMP Echo packets', pos: 'address', keys: ['address', 'count', 'interval', 'size', 'interface', 'src-address'], run: (a) => this.ping(a) }
    ]

    return {
      name: '',
      help: 'Root menu',
      cmds: [...this.globals, this.exportCmd()],
      sub: [
        {
          name: 'interface',
          help: 'Interface configuration',
          cmds: this.ifaceOps(() => d.interfaces, ifPrint(R.interfaces)),
          sub: [
            { name: 'ethernet', help: 'Ethernet interfaces', cmds: this.ifaceOps(ethers, ifPrint(R.ethernet)) },
            { name: 'vlan', help: 'Virtual LAN', cmds: this.ifaceOps(vlans, ifPrint(R.vlanIfs), [vlanAdd, vlanRemove]) },
            {
              name: 'bridge',
              help: 'Bridge interfaces',
              cmds: this.ifaceOps(bridges, ifPrint(R.bridges)),
              sub: [
                {
                  name: 'port',
                  help: 'Bridge ports',
                  cmds: [
                    ro('print', 'Print values of item properties', () => R.bridgePorts(d)),
                    {
                      name: 'add',
                      help: 'Create a new item',
                      keys: ['bridge', 'interface', 'pvid', 'comment', 'disabled'],
                      run: (a) => {
                        const br = a.kv['bridge']
                        const ifn = a.kv['interface']
                        if (!br || !bridges().some((b) => b.name === br)) throw new RosError('input does not match any value of bridge')
                        if (!ifn || !d.interfaces.some((i) => i.name === ifn)) throw new RosError('input does not match any value of interface')
                        if (v().bridgePorts[ifn]) throw new RosError('failure: device already added as bridge port')
                        v().bridgePorts[ifn] = br
                      }
                    },
                    {
                      name: 'remove',
                      help: 'Remove item',
                      pos: 'numbers',
                      keys: ['numbers'],
                      run: (a) => {
                        for (const [ifn] of this.items(Object.entries(v().bridgePorts), this.refs(a), ([n]) => n)) delete v().bridgePorts[ifn]
                      }
                    },
                    this.exportCmd()
                  ]
                }
              ]
            }
          ]
        },
        {
          name: 'ip',
          help: 'IP options',
          sub: [
            ipAddress,
            ipRoute,
            { name: 'arp', help: 'ARP entries', cmds: [ro('print', 'Print values of item properties', () => R.arp(d))] },
            { name: 'neighbor', help: 'Neighbor discovery', cmds: [ro('print', 'Print values of item properties', () => R.neighbors(d))] }
          ]
        },
        {
          name: 'routing',
          help: 'Routing protocols',
          sub: [
            {
              name: 'bgp',
              help: 'Border Gateway Protocol',
              sub: [bgpConn, { name: 'session', help: 'BGP sessions', cmds: [ro('print', 'Print values of item properties', () => R.bgpSessions(d))] }]
            },
            { name: 'ospf', help: 'Open Shortest Path First', sub: [{ name: 'neighbor', help: 'OSPF neighbors', cmds: [ro('print', 'Print values of item properties', () => R.ospfNeighbors(d))] }] }
          ]
        },
        {
          name: 'system',
          help: 'System information and utilities',
          cmds: [
            {
              name: 'reboot',
              help: 'Reboot the system',
              run: async () => {
                const a = await this.s.ask('Reboot, yes? [y/N]: ')
                return a === 'y' || a === 'Y' ? 'y\n[simulator] reboot acknowledged; the simulated device never reboots.' : ''
              }
            }
          ],
          sub: [
            { name: 'resource', help: 'System resources', cmds: [ro('print', 'Print values of item properties', () => R.resource(d))], sub: [{ name: 'cpu', help: 'CPU usage', cmds: [ro('print', 'Print values of item properties', () => R.resourceCpu(d))] }] },
            { name: 'routerboard', help: 'RouterBOARD information', cmds: [ro('print', 'Print values of item properties', () => R.routerboard(d))] },
            {
              name: 'identity',
              help: 'System identity',
              cmds: [
                ro('print', 'Print values of item properties', () => `  name: ${d.hostname}`),
                {
                  name: 'set',
                  help: 'Change item properties',
                  keys: ['name'],
                  run: (a) => {
                    if (a.kv['name'] !== undefined) d.hostname = a.kv['name']
                  }
                },
                this.exportCmd()
              ]
            },
            { name: 'clock', help: 'System clock', cmds: [ro('print', 'Print values of item properties', () => R.clock(d))] }
          ]
        },
        {
          name: 'tool',
          help: 'Diagnostic tools',
          cmds: [{ name: 'profile', help: 'CPU usage per process', keys: ['cpu', 'duration'], flags: ['without-paging'], run: () => R.profile(d) }]
        },
        { name: 'log', help: 'System logs', cmds: [ro('print', 'Print values of item properties', () => R.logPrint(d))] }
      ]
    }
  }
}

function statsOf(d: Device, i: Iface): { rxB: string; txB: string; rxP: string; txP: string; fcs: string; col: string } {
  const t = R.ifaceStats(d, i)
  const g = (k: string): string => new RegExp(`${k}: (\\d+)`).exec(t)?.[1] ?? '0'
  return { rxB: g('rx-byte'), txB: g('tx-byte'), rxP: g('rx-packet'), txP: g('tx-packet'), fcs: g('rx-fcs-error'), col: g('tx-collision') }
}

export const routerosFactory = (s: Session): RouterosPersonality => new RouterosPersonality(s)
