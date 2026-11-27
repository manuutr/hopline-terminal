import { PLATFORM_IDS, PROFILES } from '@hopline/cli-model'
import { describe, expect, it } from 'vitest'
import { classify, isPlatform, PLATFORM_LABELS, PLATFORM_VENDORS, PLATFORMS, SESSION_PLATFORM_LABELS, SESSION_PLATFORMS, type GuardPlatform } from '../src'

describe('app platform list', () => {
  it('is every cli-model platform', () => {
    expect([...PLATFORMS]).toEqual([...PLATFORM_IDS])
    expect(SESSION_PLATFORMS).toEqual(['auto', ...PLATFORM_IDS])
  })

  it.each(PLATFORM_IDS.map((p) => [p]))('%s: static label and vendor match the profile', (p) => {
    expect(PLATFORM_LABELS[p]).toBe(PROFILES[p].label)
    expect(PLATFORM_VENDORS[p]).toBe(PROFILES[p].vendor)
    expect(SESSION_PLATFORM_LABELS[p]).toBe(PROFILES[p].label)
  })

  it('auto is not a platform, and the guard refuses everything on it', () => {
    expect(isPlatform('auto')).toBe(false)
    expect(isPlatform('iosxr')).toBe(true)
    expect(SESSION_PLATFORM_LABELS.auto).toBe('Auto-detect')
    expect(classify('show version', 'auto' as GuardPlatform).kind).toBe('blocked')
  })
})
