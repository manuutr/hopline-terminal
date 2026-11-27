import { describe, expect, it } from 'vitest'
import { BlockTracker, blockOutput, logicalLine, QUIET_MS, type Block, type BufferLike, type MarkerLike, type TermLike } from '../src/renderer/src/lib/blocks'

/** A tiny stand-in for xterm's buffer: rows of text, a cursor on the last row, and markers. */
class FakeTerm implements TermLike {
  rows: { text: string; isWrapped: boolean }[] = [{ text: '', isWrapped: false }]
  markers: (MarkerLike & { line: number; isDisposed: boolean })[] = []
  readonly cols: number
  constructor(cols = 80) {
    this.cols = cols
  }
  get buffer(): { active: BufferLike } {
    const rows = this.rows
    return {
      active: {
        length: rows.length,
        baseY: 0,
        cursorY: rows.length - 1,
        getLine: (y: number) => {
          const r = rows[y]
          return r && { isWrapped: r.isWrapped, translateToString: (trim?: boolean) => (trim ? r.text.trimEnd() : r.text.padEnd(this.cols)) }
        }
      }
    }
  }
  registerMarker(offset = 0): MarkerLike {
    const m = { line: this.rows.length - 1 + offset, isDisposed: false, dispose: () => (m.isDisposed = true) }
    this.markers.push(m)
    return m
  }
  /** Device output: \n starts a row, long rows soft-wrap at `cols`. */
  write(s: string): void {
    for (const ch of s) {
      const last = this.rows.at(-1)!
      if (ch === '\n') this.rows.push({ text: '', isWrapped: false })
      else if (last.text.length >= this.cols) this.rows.push({ text: ch, isWrapped: true })
      else last.text += ch
    }
  }
}

function setup(platform: 'iosxe' | 'junos' | 'auto' = 'iosxe') {
  const term = new FakeTerm()
  const blocks: Block[] = []
  let t = 0
  const pending: (() => void)[] = []
  const tracker = new BlockTracker(term, {
    platform: () => platform,
    onBlock: (b) => blocks.push(b),
    now: () => t,
    schedule: (fn) => (pending.push(fn), 0 as unknown as ReturnType<typeof setTimeout>)
  })
  /** Write device output, then let it go quiet. */
  const out = (s: string) => {
    term.write(s)
    tracker.written()
    t += QUIET_MS + 1
    while (pending.length) pending.shift()!()
  }
  return { term, tracker, blocks, out, setPlatform: (p: typeof platform) => { platform = p } }
}

describe('command blocks', () => {
  it('keeps the detected platform with the observation when an unidentified session is recognised', () => {
    const { out, blocks, setPlatform } = setup('auto')
    out('core-sw1#')
    setPlatform('iosxe')
    out('show clock\n12:00:00 UTC\ncore-sw1#')
    setPlatform('junos')
    expect(blocks[0]).toMatchObject({ command: 'show clock', hostname: 'core-sw1', platform: 'iosxe' })
  })

  it('a command typed at a prompt, its output and the next prompt make one block', () => {
    const { term, tracker, blocks, out } = setup()
    out('core-sw1#')
    out('show ip int br\nInterface  IP-Address  OK? Method Status Protocol\nGi1/0/1    10.0.0.1    YES manual up     up\ncore-sw1#')
    expect(blocks).toHaveLength(1)
    const b = blocks[0]!
    expect(b).toMatchObject({ command: 'show ip int br', prompt: 'core-sw1#', mode: 'exec', hostname: 'core-sw1' })
    expect(blockOutput(term.buffer.active, b, 'iosxe')).toBe('Interface  IP-Address  OK? Method Status Protocol\nGi1/0/1    10.0.0.1    YES manual up     up')
    expect(tracker.blockAt(1)).toBe(b)
    expect(tracker.blockAt(0)).toBe(b)
    expect(tracker.blockAt(3)).toBeUndefined()
  })

  it('an empty Enter at the prompt makes no block; busy output that is not a prompt does not close one', () => {
    const { blocks, out } = setup()
    out('core-sw1#')
    out('\ncore-sw1#')
    expect(blocks).toHaveLength(0)
    out('show logging\nline 1\n')
    out('line 2')
    expect(blocks).toHaveLength(0)
    out('\ncore-sw1#')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.command).toBe('show logging')
  })

  it('a prompt redrawn with the typed text (? help, a syslog line breaking in) is not a block', () => {
    const { blocks, out } = setup()
    out('core-sw1#')
    out('show ip ?\n  interface  IP interface status\n  route      IP routing table\n\ncore-sw1#show ip ')
    expect(blocks).toHaveLength(0)
    out('\n*Nov 25 10:00:00: %LINK-3-UPDOWN: Interface Gi1/0/3, changed state to down\ncore-sw1#show ip ')
    expect(blocks).toHaveLength(0)
    out('route\nGateway of last resort is not set\ncore-sw1#')
    expect(blocks.map((b) => b.command)).toEqual(['show ip route'])
  })

  it('joins soft-wrapped rows and drops pager residue', () => {
    const { term, blocks, out } = setup()
    out('core-sw1#')
    const long = 'x'.repeat(100)
    out(`show run\n${long}\n --More-- interface Gi1\ncore-sw1#`)
    expect(blocks).toHaveLength(1)
    expect(blockOutput(term.buffer.active, blocks[0]!, 'iosxe').split('\n')).toEqual([long, 'interface Gi1'])
    expect(logicalLine(term.buffer.active, 1).text).toBe(long)
  })

  it('Junos: the [edit] and {master:0} lines above the next prompt are not output', () => {
    const { term, blocks, out } = setup('junos')
    out('netops@edge-r1> ')
    out('show route summary\nRouter ID: 10.0.0.1\n\n{master:0}\nnetops@edge-r1> ')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ command: 'show route summary', hostname: 'edge-r1' })
    expect(blockOutput(term.buffer.active, blocks[0]!, 'junos')).toBe('Router ID: 10.0.0.1')
  })

  it('config-mode commands are blocks too, with their mode', () => {
    const { blocks, out } = setup()
    out('core-sw1(config)#')
    out('interface Gi1/0/1\ncore-sw1(config-if)#')
    expect(blocks[0]).toMatchObject({ command: 'interface Gi1/0/1', mode: 'config' })
  })

  it('navigates prompts up and down', () => {
    const { tracker, blocks, out } = setup()
    out('r1#')
    out('show clock\n10:00\nr1#')
    out('show users\nnone\nr1#')
    expect(blocks).toHaveLength(2)
    expect(tracker.step(99, -1)).toBe(blocks[1])
    expect(tracker.step(blocks[1]!.start.line, -1)).toBe(blocks[0])
    expect(tracker.step(blocks[0]!.start.line, 1)).toBe(blocks[1])
    expect(tracker.step(blocks[1]!.start.line, 1)).toBeUndefined()
  })

  it('a flood does no prompt work until it goes quiet', () => {
    const { term, tracker } = setup()
    let checks = 0
    const orig = tracker.check.bind(tracker)
    tracker.check = () => (checks++, orig())
    let t = 0
    const pending: (() => void)[] = []
    const fast = new BlockTracker(term, { platform: () => 'iosxe', onBlock: () => {}, now: () => t, schedule: (fn) => (pending.push(fn), 0 as unknown as ReturnType<typeof setTimeout>) })
    let fastChecks = 0
    const fo = fast.check.bind(fast)
    fast.check = () => (fastChecks++, fo())
    for (let i = 0; i < 10_000; i++) {
      fast.written()
      t += 1
    }
    expect(pending.length).toBe(1)
    t += QUIET_MS
    while (pending.length) pending.shift()!()
    expect(fastChecks).toBe(1)
    expect(checks).toBe(0)
  })
})
