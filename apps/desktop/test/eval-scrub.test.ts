import { describe, expect, it } from 'vitest'
import { scrubKeys } from './eval/scrub'

describe('live eval report scrubbing (review L6)', () => {
  it('scrubs every non-empty key, even one shorter than 8 characters, without breaking the report', () => {
    const report = { label: 'anthropic', results: [{ id: 'bgp-1', error: 'auth failed for key k3y!x with header x-api-key: k3y!x' }], nested: { 'k3y!x': 1 } as Record<string, number> }
    const out = scrubKeys(report, ['k3y!x', undefined, ''])
    expect(JSON.stringify(out)).not.toContain('k3y!x')
    expect(out.results[0]!.error).toBe('auth failed for key [REDACTED] with header x-api-key: [REDACTED]')
    expect(out.label).toBe('anthropic')
  })

  it('a one-character key, and key-shaped strings without a key', () => {
    expect(scrubKeys({ a: 'xyz' }, ['y'])).toEqual({ a: 'x[REDACTED]z' })
    expect(scrubKeys({ e: 'leaked sk-ant-api03-ABCDEFGHIJ here' }, [])).toEqual({ e: 'leaked [REDACTED] here' })
    expect(scrubKeys({ n: 5, b: true, z: null }, ['5'])).toEqual({ n: 5, b: true, z: null })
  })
})
