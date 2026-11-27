import { BACKUP_COMMANDS, PLATFORM_IDS } from '@hopline/cli-model'
import { describe, expect, it } from 'vitest'
import { classify } from '../src/index'

describe('config backup commands', () => {
  it('every modelled platform has one, and the guard classifies it read-only', () => {
    for (const p of PLATFORM_IDS) {
      const cmd = BACKUP_COMMANDS[p]
      expect(cmd, p).toBeTruthy()
      expect(classify(cmd, p).kind, `${p}: ${cmd}`).toBe('read')
    }
  })
})
