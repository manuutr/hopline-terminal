import { describe, expect, it } from 'vitest'
import { selectionForModel, SELECTION_MAX_CHARS } from '../src/main/agent/agent'

// Phase 4 review M6: a long selection was cut before redaction, so a key whose BEGIN line fell
// outside the kept tail reached the model unredacted.
describe('selectionForModel: redact the whole selection, then cut', () => {
  const keyLines = Array.from({ length: 30 }, (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${String(i).padStart(4, '0')}SecretKeyBody`)
  it('a key whose BEGIN line is far before the kept tail is still redacted', () => {
    const sel = `fw1# show full-configuration\n${'x'.repeat(SELECTION_MAX_CHARS)}\n-----BEGIN PRIVATE KEY-----\n${'filler line\n'.repeat(2000)}${keyLines.join('\n')}\n-----END PRIVATE KEY-----\nfw1# `
    const out = selectionForModel(sel)
    expect(out.length).toBeLessThanOrEqual(SELECTION_MAX_CHARS + 200)
    expect(out).not.toContain('SecretKeyBody')
    expect(out.startsWith('fw1# show full-configuration\n[… ')).toBe(true)
  })
  it('short selections are only redacted', () => {
    expect(selectionForModel('-----BEGIN RSA PRIVATE KEY-----\nMIIabc')).toBe('-----BEGIN RSA PRIVATE KEY----- <redacted>')
  })
})
