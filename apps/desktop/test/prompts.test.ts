import { describe, expect, it } from 'vitest'
import type { HostPrompt } from '../src/shared/types'
import { retryMeta } from '../src/main/prompts'

const pwSecret: HostPrompt = { kind: 'secret', host: 'r1', secret: 'password', label: 'Password for admin@r1' }
const kbd = (prompt: string, echo = false): Extract<HostPrompt, { kind: 'keyboard-interactive' }> => ({ kind: 'keyboard-interactive', host: 'r1', name: '', instructions: '', prompts: [{ prompt, echo }] })

describe('retryMeta (P0-2: wrong password feedback)', () => {
  it('a first ask has no error', () => {
    expect(retryMeta(undefined, pwSecret)).toEqual({})
  })

  it('a rejected typed password says so, with the attempt count', () => {
    expect(retryMeta({ attempt: 2, of: 3 }, pwSecret)).toEqual({ attempt: 2, error: 'Wrong password. Try again (attempt 2 of 3).' })
    expect(retryMeta({ attempt: 3, of: 3 }, kbd('Password: '))).toEqual({ attempt: 3, error: 'Wrong password. Try again (attempt 3 of 3).' })
  })

  it('does not call an OTP or other answer a password', () => {
    expect(retryMeta({ attempt: 2, of: 3 }, kbd('One-time password: ')).error).toMatch(/^The device rejected that answer/)
    expect(retryMeta({ attempt: 2, of: 3 }, kbd('Verification code: ', true)).error).toMatch(/^The device rejected that answer/)
  })

  it('a rejected saved password asks for the current one', () => {
    expect(retryMeta({ attempt: 1, of: 3, saved: true }, kbd('Password: ')).error).toBe('The saved password was rejected. Enter the current one (attempt 1 of 3).')
  })
})
