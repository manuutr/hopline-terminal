/**
 * The block detector race (BACKLOG, P2): a key pressed inside the quiet window right after a prompt
 * made the prompt look like a redraw ("prompt + text"), and the command block that had just closed
 * was dropped. The detector now counts the line endings sent to the device (a redraw has none since
 * its prompt) and checks the screen before a key inside the quiet window.
 */
import { describe, expect, it } from 'vitest'
import { BlockTracker, QUIET_MS, type Block, type BufferLike, type MarkerLike, type TermLike } from '../src/renderer/src/lib/blocks'

class FakeTerm implements TermLike {
  rows: { text: string; isWrapped: boolean }[] = [{ text: '', isWrapped: false }]
  get buffer(): { active: BufferLike } {
    const rows = this.rows
    return {
      active: {
        length: rows.length,
        baseY: 0,
        cursorY: rows.length - 1,
        getLine: (y: number) => {
          const r = rows[y]
          return r && { isWrapped: r.isWrapped, translateToString: (trim?: boolean) => (trim ? r.text.trimEnd() : r.text) }
        }
      }
    }
  }
  registerMarker(offset = 0): MarkerLike {
    const m = { line: this.rows.length - 1 + offset, isDisposed: false, dispose: () => (m.isDisposed = true) }
    return m
  }
  write(s: string): void {
    for (const ch of s) {
      if (ch === '\n') this.rows.push({ text: '', isWrapped: false })
      else this.rows.at(-1)!.text += ch
    }
  }
}

function setup() {
  const term = new FakeTerm()
  const blocks: Block[] = []
  let t = 0
  let timers: { at: number; fn: () => void }[] = []
  const tracker = new BlockTracker(term, {
    platform: () => 'iosxe',
    onBlock: (b) => blocks.push(b),
    now: () => t,
    schedule: (fn, ms) => (timers.push({ at: t + ms, fn }), 0 as unknown as ReturnType<typeof setTimeout>),
    // The fake parses writes synchronously, so "after everything received so far" is now.
    afterParsed: (fn) => fn()
  })
  /** Advance the clock, running due timers (the quiet check). */
  const tick = (ms: number) => {
    t += ms
    for (;;) {
      const due = timers.filter((x) => x.at <= t)
      if (!due.length) break
      timers = timers.filter((x) => x.at > t)
      for (const d of due) d.fn()
    }
  }
  /** Device output arrives and is parsed (not yet quiet). */
  const recv = (s: string) => {
    term.write(s)
    tracker.written()
  }
  /** The user types: the tracker hears about it before it is sent. */
  const type = (keys: string) => tracker.sent(keys)
  const quiet = () => tick(QUIET_MS + 1)
  return { term, blocks, tracker, recv, type, tick, quiet }
}

/** The erase arrives as output: nothing new on screen, but the tracker hears a write. */
const tracker_written = (recv: (s: string) => void) => recv('')

const OUT = 'Cisco IOS XE Software, Version 17.9.4a\nuptime is 3 weeks\n'

describe('block detector: keys inside the quiet window', () => {
  it('a key 1 ms after the prompt keeps the block that just closed', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show version\r')
    recv('show version\n' + OUT + 'core-sw1#')
    tick(1)
    type('s')
    recv('s')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show version'])
    // …and the next command on that prompt becomes its own block.
    type('how clock\r')
    recv('how clock\n*10:00:00.000 UTC Wed Nov 25 2026\ncore-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show version', 'show clock'])
  })

  it('a key 1 ms after a prompt the renderer did not type for (a re-run, the assistant) still keeps the block', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    // Typed by main (no sent() here): only the pre-key check can see the fresh prompt.
    recv('show version\n' + OUT + 'core-sw1#')
    tick(1)
    type('s')
    recv('s')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show version'])
  })

  it('typeahead echoed in the same chunk as the prompt', () => {
    const { blocks, recv, type, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show version\r')
    type('sh') // typed before the device answered
    recv('show version\n' + OUT + 'core-sw1#sh')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show version'])
  })

  it('a fast-typed prefix of the previous command is a new command, not a redraw', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show version\r')
    recv('show version\n' + OUT + 'core-sw1#')
    tick(2)
    type('show v')
    recv('show v')
    quiet()
    type('ersion\r')
    recv('ersion\n' + OUT + 'core-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show version', 'show version'])
  })

  it('? help is still a redraw, even typed fast', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show ip ?')
    recv('show ip ?\n  interface  IP interface status\n  route      IP routing table\n\ncore-sw1#show ip ')
    tick(1)
    type('r')
    recv('r')
    quiet()
    expect(blocks).toHaveLength(0)
    type('oute\r')
    recv('oute\nGateway of last resort is not set\ncore-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show ip route'])
  })

  it('? help, then Ctrl+U inside the quiet window, is not a block (e2e: blocks.spec Ask AI)', () => {
    const { term, blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show ip ?')
    recv('show ip ?\n  interface  IP interface status\n  route      IP routing table\n\ncore-sw1#show ip ')
    tick(5)
    // Ctrl+U: the device erases the line in place, before the quiet check ever saw the redraw.
    type('\x15')
    ;(term as unknown as { rows: { text: string }[] }).rows.at(-1)!.text = 'core-sw1#'
    tracker_written(recv)
    quiet()
    expect(blocks).toHaveLength(0)
    type('show version\r')
    recv('show version\n' + OUT + 'core-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show version'])
  })

  it('a syslog line breaking in mid-line is still a redraw', () => {
    const { blocks, recv, type, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show ip')
    recv('show ip')
    quiet()
    recv('\n*Nov 25 10:00:00: %LINK-3-UPDOWN: Interface Gi1/0/3, changed state to down\ncore-sw1#show ip')
    quiet()
    expect(blocks).toHaveLength(0)
    type(' route\r')
    recv(' route\nGateway of last resort is not set\ncore-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show ip route'])
  })

  it('keys during a flood (pager, Ctrl-C) do no prompt work', () => {
    const { blocks, recv, type, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show running-config\r')
    recv('show running-config\nBuilding configuration...\n --More-- ')
    type(' ')
    recv('\nhostname core-sw1\n --More-- ')
    type('\x03')
    expect(blocks).toHaveLength(0)
    recv('\ncore-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show running-config'])
  })
})

describe('block detector: a prompt that is never quiet', () => {
  // Found by the e2e suite on a loaded machine (blocks.spec "a key typed right after a prompt"):
  // the renderer's timers ran late, every key of the next command landed before the quiet check,
  // and the prompt between the two commands was never registered, so one block swallowed both.
  it('typeahead on a new prompt, then the whole next command before any quiet check, still splits the blocks', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show clock\r')
    type('s') // typed before the device answered
    recv('show clock\n*10:00:00.000 UTC Wed Nov 25 2026\ncore-sw1#s')
    for (const k of 'how version') {
      tick(5)
      type(k)
      recv(k)
    }
    tick(5)
    type('\r')
    recv('\n' + OUT + 'core-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show clock', 'show version'])
  })

  it('Enter during a pager or mid-output does not invent a block', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show running-config\r')
    recv('show running-config\nBuilding configuration...\n --More-- ')
    tick(5)
    type('\r')
    recv('\nhostname core-sw1\ninterface Vlan10\n')
    tick(5)
    type('\r')
    recv(' ip address 10.10.10.1 255.255.255.0\nend\n\ncore-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show running-config'])
  })

  it('? help redraw, then Enter before the quiet check, is one block (the redraw is not a command)', () => {
    const { blocks, recv, type, tick, quiet } = setup()
    recv('core-sw1#')
    quiet()
    type('show ip ?')
    recv('show ip ?\n  interface  IP interface status\n  route      IP routing table\n\ncore-sw1#show ip ')
    for (const k of 'route') {
      tick(5)
      type(k)
      recv(k)
    }
    tick(5)
    type('\r')
    recv('\nGateway of last resort is not set\ncore-sw1#')
    quiet()
    expect(blocks.map((b) => b.command)).toEqual(['show ip route'])
  })
})
