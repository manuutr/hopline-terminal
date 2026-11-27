import { describe, expect, it } from 'vitest'
import { clearOutputProblem, echoVerdict, LineEditor, type EchoOptions } from '../src/session-host/line-editor'
import { iosScrollEcho } from './line-editors'

/** Phase 4 fix-round review E1–E6: the line-editor emulator behind the echo check. */
const P = 'core-sw1#'
const ACL = 'ip route 10.20.30.0 255.255.255.0 192.168.100.1 name to-branch-office-17 track 100'
const LONG = 'show interfaces | include line protocol|Last input|CRC|input errors|output errors'
const st = (cmd: string, echo: string, o: EchoOptions = { prompt: P }) => echoVerdict(cmd, echo, o).state
const bytewise = (echo: string, o: EchoOptions = { prompt: P }) => {
  const ed = new LineEditor(o)
  for (const c of echo) ed.feed(c)
  return ed
}

describe('E1: no prefix shortcut, every index must be shown and match', () => {
  it('repro 1: a log line, a redraw, and wrong characters after 25 matching ones is a mismatch', () => {
    expect(st(ACL, ACL.slice(0, 25) + '\r\n*Nov 25: %SYS-5-CONFIG_I\r\ncore-sw1#' + ACL.slice(0, 25) + 'XXXXXXXX')).toBe('mismatch')
  })
  it('repro 2: IOS $ scrolling (backspace and CR forms) with any one character dropped is never ok', () => {
    for (const form of ['bs', 'cr'] as const) {
      for (const width of [70, 30, 15]) {
        expect(st(ACL, iosScrollEcho(ACL, { width, form, prompt: P })), `${form} ${width}`).toBe('ok')
        for (let drop = 0; drop < ACL.length; drop++) expect(st(ACL, iosScrollEcho(ACL, { width, form, prompt: P, drop })), `${form} ${width} drop ${drop}`).not.toBe('ok')
      }
    }
  })
  it('a long echo cut by cursor movement and never completed is not ok', () => {
    const cmd = 'show running-config | include ^interface GigabitEthernet1/0/1 description uplink-to-core'
    expect(st(cmd, `${cmd.slice(0, 70)}\b\b\b\b$${cmd.slice(10, 40)}`)).not.toBe('ok')
    expect(st(cmd, cmd.slice(0, 40))).toBe('pending')
  })
  it('1-byte chunks give the same result as whole echoes (escape sequences split across chunks)', () => {
    for (const form of ['bs', 'cr'] as const) {
      const echo = iosScrollEcho(ACL, { width: 30, form, prompt: P })
      const whole = new LineEditor({ prompt: P }).feed(echo)
      expect(bytewise(echo).framesForVerdict()).toEqual(whole.framesForVerdict())
    }
    expect(bytewise('\x1b[1mshow\x1b[0m version').text()).toBe('show version')
    expect(bytewise('show versionx\b\x1b[K').text()).toBe('show version')
  })
})

describe('E2: legitimate echoes pass', () => {
  it('readline/libedit wrap: a space and \\r at the wrap column', () => {
    // A 10-column prompt + 70 characters reaches column 80.
    const prompt = 'core-sw1# '
    expect(st(LONG, 'show interfaces | include line protocol|Last input|CRC|input errors|ou \rtput errors', { prompt, cols: 80 })).toBe('ok')
    // Not at the wrap column: the \r is not a wrap, and it does not redraw the prompt.
    expect(st(LONG, 'show interfaces | include line protocol|Last input|CRC|input errors|o \ruttput errors', { prompt, cols: 80 })).toBe('mismatch')
    // Width unknown: never guessed.
    expect(st(LONG, 'show interfaces | include line protocol|Last input|CRC|input errors|ou \rtput errors', { prompt })).toBe('mismatch')
  })
  it('fewer than 20 characters before the first redraw (narrow pane)', () => {
    expect(st(LONG, LONG.slice(0, 19) + '\b'.repeat(19) + '$' + LONG.slice(11, 30))).toBe('pending')
    expect(st(LONG, iosScrollEcho(LONG, { width: 19, form: 'bs', prompt: P }))).toBe('ok')
    expect(st(LONG, iosScrollEcho(LONG, { width: 12, form: 'cr', prompt: P }))).toBe('ok')
  })
  it('logging synchronous: a syslog line, then the prompt and the partial line redrawn', () => {
    expect(st('show version', 'show \r\n*Nov 25: %LINK-3-UPDOWN: x\r\ncore-sw1#show version')).toBe('ok')
    // No redraw: the rest lands after the log text and is never ok.
    expect(st('show version', 'show \r\n*Nov 25: %LINK-3-UPDOWN: x\r\nversion')).toBe('pending')
    expect(echoVerdict('show version', 'show \r\n*Nov 25: x\r\nversion', { prompt: P })).toEqual({ state: 'pending', why: 'interrupted' })
  })
  it('a late clear-key redraw (\\r + prompt) before the echo', () => {
    expect(st('show version', '\rcore-sw1#show version')).toBe('ok')
    expect(st('show version', '\r\x1b[Kcore-sw1#show version')).toBe('ok')
  })
  it('colour is ignored; an exact echo is ok; a partial one is pending; a wrong one is a mismatch', () => {
    expect(st('show version', '\x1b[1mshow\x1b[0m version')).toBe('ok')
    expect(st('show version', 'show version')).toBe('ok')
    expect(st('show version', 'show ver')).toBe('pending')
    expect(st('show version', 'how version')).toBe('mismatch')
    expect(st('show version', 'h')).toBe('mismatch')
    expect(st('show version', 'show version extra')).toBe('mismatch')
    expect(echoVerdict('show version', '', { prompt: P })).toEqual({ state: 'pending', why: 'empty' })
  })
  it('cursor movement Hopline Terminal cannot follow is a mismatch, never ok', () => {
    expect(echoVerdict('show version', 'show\x1b[5Hversion', { prompt: P })).toMatchObject({ state: 'mismatch', why: 'unsupported' })
    expect(st('show version', '\b \bshow version')).toBe('mismatch')
    expect(st('show version', 'show\x1bMversion')).toBe('mismatch')
    expect(st('show version', 'show\x0eversion')).toBe('mismatch')
    expect(st('show version', 'show\rversion')).toBe('mismatch')
  })
  it('in-line edits by the device (backspace and overwrite, erase to end) follow the screen', () => {
    expect(st('show version', 'show verx\bsion')).toBe('ok')
    expect(st('show version', 'show versionx\b\x1b[K')).toBe('ok')
    // The cursor is not at the end: the device holds more than the screen says is done.
    expect(st('show version', 'show versionx\b')).toBe('mismatch')
    expect(st('show version', 'show version\b\b')).toBe('pending')
  })
})

describe('E6: the token prefix allowance is only for complete-on-space platforms', () => {
  const J: EchoOptions = { prompt: 'admin@r1> ', completeOnSpace: true }
  it('IOS: "show" echoed as "shower" is a mismatch; Junos completes words', () => {
    expect(st('show', 'shower')).toBe('mismatch')
    expect(st('sh', 'show')).toBe('mismatch')
    expect(st('show', 'shower', J)).toBe('ok')
    expect(st('sh int terse', 'show interfaces terse', J)).toBe('ok')
    expect(st('sh int terse', 'show interfaces ter', J)).toBe('pending')
    expect(st('sh int terse', 'how interfaces terse', J)).toBe('mismatch')
    expect(st('sh int terse', 'sh int terse x', J)).toBe('mismatch')
  })
})

describe('E3/E4: a blank line after an abandon, and the clear phase', () => {
  it('blank only once everything shown is erased, at the prompt', () => {
    expect(new LineEditor({ prompt: P }).feed('show ver' + '\b \b'.repeat(8)).blank()).toBe(true)
    expect(new LineEditor({ prompt: P }).feed('show ver' + '\b \b'.repeat(4)).blank()).toBe(false)
    expect(new LineEditor({ prompt: P }).feed(`show ver\r${P}\x1b[K`).blank()).toBe(true)
    // A device that echoes nothing shows nothing: "blank", but nothing was ever shown (the executor does not trust that).
    const quiet = new LineEditor({ prompt: P })
    expect(quiet.blank() && quiet.everShown).toBe(false)
  })
  it('clear output: erasing is fine; ^U shown as text, or other output, is not', () => {
    expect(clearOutputProblem('', P)).toBeNull()
    expect(clearOutputProblem('\b \b\b \b\x1b[K\x07', P)).toBeNull()
    expect(clearOutputProblem(`\r${P}\x1b[K`, P)).toBeNull()
    expect(clearOutputProblem('^U', P)).toBe('^U')
    expect(clearOutputProblem('\x15', P)).toBe('^U')
    expect(clearOutputProblem('\r\n*Nov 25 log line\r\n' + P, P)).toMatch(/Nov/)
  })
})
