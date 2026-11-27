import { describe, expect, it } from 'vitest'
import { cleanTerminalText, promptState } from '@shared/cli'
import { idleAtPrompt } from '../src/session-host/detect'

const idle = (line: string) => idleAtPrompt({ banner: '', tail: 'x\n' + line, quietMs: 5000, idleMs: 5000 })

describe('auto-detect only probes at a device prompt (review M4)', () => {
  // Credential, menu and question prompts, whatever the terminator: the probe would be typed as a password or a choice.
  it.each(['Password>', 'Passcode>', 'Enter Password>', 'Selection>', 'Enter selection#', 'Choice>', 'Continue>', 'Press any key>', 'Verification code:', 'login>', 'Username>', '(y/n)>', 'PIN#'])(
    'not a prompt: %s',
    (line) => {
      expect(promptState(line, 'auto').mode).toBe('unknown')
      expect(idle(line)).toBe(false)
    }
  )

  // A Unix shell is not a device CLI.
  it.each(['bash-4.3#', 'sh-4.2$', 'bash#', '[admin@sw1 ~]$', 'root@sw1:~#'])('not a device prompt: %s', (line) => {
    expect(promptState(line, 'auto').mode).toBe('unknown')
    expect(idle(line)).toBe(false)
  })

  // Hostnames that merely contain one of the words are still prompts, on a known platform and on auto.
  it.each([
    ['spine1#', 'iosxe'],
    ['login-gw>', 'ios'],
    ['token-rtr#', 'iosxe'],
    ['pinecone(config)#', 'ios'],
    ['core-sw1#', 'iosxe']
  ] as const)('still a prompt: %s', (line, platform) => {
    expect(promptState(line, platform).mode).not.toBe('unknown')
    expect(idle(line)).toBe(true)
  })
})

describe('cleanTerminalText strips C1 controls (review R2-Low 5)', () => {
  it('removes 8-bit CSI/OSC sequences and lone C1 bytes', () => {
    expect(cleanTerminalText('a\x9b2Kb\x9d0;title\x9cc\x85d\x90e')).toBe('abcde')
  })
})
