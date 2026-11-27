import { describe, expect, it } from 'vitest'
import { AiPrefix, isBarePrompt, isSecretPrompt, type PrefixOutput } from '../src/renderer/src/lib/aiprefix'

/** Feed keys one at a time (typing) and merge what comes out. */
function type(p: AiPrefix, keys: string, mayHold = true): PrefixOutput {
  const all: PrefixOutput = { send: '', echo: '', ask: [] }
  for (const k of keys) {
    const o = p.input(k, mayHold)
    all.send += o.send
    all.echo += o.echo
    all.ask.push(...o.ask)
  }
  return all
}

const color = (s: string) => `<${s}>`

describe('AiPrefix (P1-16: @ai never reaches the device)', () => {
  it('typed "@ai <question>\\r" sends nothing to the device and asks the question', () => {
    const p = new AiPrefix(color)
    const o = type(p, '@ai why is bgp to 10.0.0.2 down?\r')
    expect(o.send).toBe('')
    expect(o.ask).toEqual(['why is bgp to 10.0.0.2 down?'])
    // Everything echoed locally is erased again, and no Ctrl-U goes to the device.
    expect(o.echo.split('\b \b').length - 1).toBe('@ai why is bgp to 10.0.0.2 down?'.length)
    expect(p.line).toBe('')
    expect(p.busy).toBe(false)
  })

  it('a pasted "@ai …\\r…" in one chunk asks, then sends the rest to the device', () => {
    const p = new AiPrefix(color)
    const o = p.input('@ai why\rshow ver\r')
    expect(o.ask).toEqual(['why'])
    expect(o.send).toBe('show ver\r')
    expect(p.line).toBe('')
  })

  it('holds "@", "@a", "@ai" locally and sends nothing while they still match', () => {
    const p = new AiPrefix(color)
    expect(type(p, '@ai')).toEqual({ send: '', echo: '<@><a><i>', ask: [] })
    expect(p.held).toBe('@ai')
  })

  it('a mismatch erases the local echo first, then flushes the held characters and the new one', () => {
    const p = new AiPrefix(color)
    const o = type(p, '@as')
    expect(o.send).toBe('@as')
    // Erase "@a" locally before the device echoes "@as", so it is not shown twice.
    expect(o.echo).toBe('<@><a>\b \b\b \b')
    expect(p.line).toBe('@as')
    expect(p.busy).toBe(false)
    // An email address or "@" mid-line is never held.
    expect(type(p, 'x@ai ').send).toBe('x@ai ')
  })

  it('backspace while holding removes a held character and sends nothing', () => {
    const p = new AiPrefix(color)
    const o = type(p, '@a\x7f\x7f')
    expect(o.send).toBe('')
    expect(o.echo).toBe('<@><a>\b \b\b \b')
    expect(p.busy).toBe(false)
    expect(p.line).toBe('')
    // The line is still known to be empty: "@ai " works right after.
    type(p, '@ai ')
    expect(p.capture).toBe('')
  })

  it('backspace over the space after "@ai" leaves capture and holds "@ai" again', () => {
    const p = new AiPrefix(color)
    type(p, '@ai x\x7f\x7f')
    expect(p.capture).toBeNull()
    expect(p.held).toBe('@ai')
    expect(type(p, 'd').send).toBe('@aid')
  })

  it('Enter or a control key while holding flushes, then sends it', () => {
    const p = new AiPrefix(color)
    expect(type(p, '@a\r')).toMatchObject({ send: '@a\r' })
    expect(p.line).toBe('')
    expect(type(p, '@\t')).toMatchObject({ send: '@\t' })
    expect(p.line).toBeNull() // Tab completion: line unknown
  })

  it('Ctrl-C or Esc cancels a capture without sending anything', () => {
    const p = new AiPrefix(color)
    expect(type(p, '@ai hello\x03').send).toBe('')
    expect(p.busy).toBe(false)
    expect(p.input('@ai hi\x1b[A').send).toBe('')
    expect(p.line).toBe('')
  })

  it('an empty question asks nothing', () => {
    const p = new AiPrefix(color)
    expect(type(p, '@ai   \r')).toMatchObject({ send: '', ask: [] })
  })

  it('never holds at a password prompt (no part of a secret is echoed)', () => {
    const p = new AiPrefix(color)
    const o = type(p, '@ai', false)
    expect(o).toEqual({ send: '@ai', echo: '', ask: [] })
  })

  it('after arrows or Tab the line is unknown until Enter or a fresh prompt', () => {
    const p = new AiPrefix(color)
    p.input('\x1b[A') // history recall
    expect(p.line).toBeNull()
    expect(type(p, '@ai x').send).toBe('@ai x')
    p.input('\r')
    expect(p.line).toBe('')
    p.input('\t')
    expect(p.line).toBeNull()
    p.promptSeen()
    expect(p.line).toBe('')
    expect(type(p, '@ai ').send).toBe('')
  })

  it('promptSeen never interrupts a hold or a capture', () => {
    const p = new AiPrefix(color)
    type(p, '@a')
    p.promptSeen()
    expect(p.held).toBe('@a')
  })
})

describe('AiPrefix: where a line starts (Windows report: "% Invalid input")', () => {
  it('ignores a delayed history echo after Ctrl+U, then resumes syncing normal input', () => {
    const prefix = new AiPrefix()
    prefix.input('\x1b[A')
    prefix.syncDeviceLine('show version')
    expect(prefix.line).toBe('show version')
    prefix.input('\x15')
    prefix.syncDeviceLine('show version')
    prefix.input(' ')
    prefix.syncDeviceLine('show version')
    const question = prefix.input('@ai check the route?\r')
    expect(question.send).toBe('')
    expect(question.ask).toEqual(['check the route?'])
    prefix.input('s')
    prefix.syncDeviceLine('show')
    expect(prefix.line).toBe('show')
  })
  it('after Ctrl+Z leaves config mode, the next "@ai" goes to the assistant', () => {
    const p = new AiPrefix(color)
    type(p, 'conf t\r')
    type(p, 'interface Gi1/0/1')
    expect(type(p, '\x1a').send).toBe('\x1a') // Ctrl+Z goes to the device…
    expect(p.line).toBe('') // …and the line starts over
    expect(type(p, '@ai why?\r')).toMatchObject({ send: '', ask: ['why?'] })
  })

  it('after Up-arrow history, Ctrl+U clears the line and "@ai" works', () => {
    const p = new AiPrefix(color)
    p.input('\x1b[A')
    expect(p.line).toBeNull()
    type(p, '\x15')
    expect(type(p, '@ai q\r')).toMatchObject({ send: '', ask: ['q'] })
  })

  it('after Tab completion the screen decides: a bare prompt is a line start, a command is not', () => {
    const p = new AiPrefix(color)
    type(p, 'sh\t')
    expect(p.line).toBeNull()
    // The device completed to "core-sw1#show ": not a line start, so "@" goes to the device.
    expect(p.input('@', { atLineStart: () => isBarePrompt('core-sw1#show ') }).send).toBe('@')
    const q = new AiPrefix(color)
    type(q, 'sh\t\x7f\x7f\x7f\x7f\x7f')
    // Backspaced to the bare prompt on screen: "@ai" is held again.
    expect(q.input('@', { atLineStart: () => isBarePrompt('core-sw1#') }).send).toBe('')
    expect(type(q, 'ai x\r')).toMatchObject({ send: '', ask: ['x'] })
  })

  it('allows leading spaces before "@ai", and leaves them on the device line', () => {
    const p = new AiPrefix(color)
    const o = type(p, '  @ai asdasd\r')
    expect(o).toMatchObject({ send: '  ', ask: ['asdasd'] })
    expect(p.line).toBe('  ')
  })

  it('"@ai" in the middle of a command stays with the device', () => {
    const p = new AiPrefix(color)
    expect(type(p, 'show run | i @ai \r')).toMatchObject({ send: 'show run | i @ai \r', ask: [] })
    // Even when a stale screen still shows the bare prompt (fast typing, echo not back yet).
    const q = new AiPrefix(color)
    q.input('\t')
    expect(q.input('x @ai ', { atLineStart: () => true }).send).toBe('x @ai ')
  })

  it('treats Junos and EOS prompts as line starts', () => {
    for (const prompt of ['admin@mx1> ', 'admin@mx1# ', 'dist-eos1>', 'dist-eos1(config-if-Et1)#', '{master:0}admin@mx1# ', 'RP/0/RSP0/CPU0:pe1#']) {
      expect(isBarePrompt(prompt)).toBe(true)
      const p = new AiPrefix(color)
      p.input('\x1b[A') // line unknown: the screen decides
      expect(p.input('@ai why\r', { atLineStart: () => isBarePrompt(prompt) })).toMatchObject({ send: '', ask: ['why'] })
    }
  })
})

describe('prompt shapes', () => {
  it('recognises secret prompts', () => {
    for (const l of ['Password:', 'Password: ', 'Enter passphrase for key:', 'Verification code: ', 'admin@10.0.0.1\'s password: ']) expect(isSecretPrompt(l)).toBe(true)
    for (const l of ['core-sw1#', 'Username: ', 'core-sw1(config)#']) expect(isSecretPrompt(l)).toBe(false)
  })
  it('recognises bare device prompts', () => {
    for (const l of ['core-sw1#', 'core-sw1(config-if)#', 'admin@r1> ', 'user@host:~$ ', 'RP/0/RSP0/CPU0:pe1#', '[admin@MikroTik] > ']) expect(isBarePrompt(l)).toBe(true)
    for (const l of ['core-sw1#show ver', 'core-sw1#show run | i x>', 'Password:', '', 'Building configuration...']) expect(isBarePrompt(l)).toBe(false)
  })
})
