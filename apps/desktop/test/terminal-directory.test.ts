import { describe, expect, it } from 'vitest'
import { remoteDirectory } from '../src/renderer/src/features/files/terminal-directory'

describe('remote working directories', () => {
  it('accepts absolute paths for the session, including encoded names and IPv6 hosts', () => {
    expect(remoteDirectory('file:///var/tmp', 'switch')).toBe('/var/tmp')
    expect(remoteDirectory('file://SWITCH/etc/Branch%20A', 'switch')).toBe('/etc/Branch A')
    expect(remoteDirectory('file://[2001:db8::2]/tmp', '2001:db8::2')).toBe('/tmp')
  })

  it('ignores ambiguous paths and reports naming a different endpoint', () => {
    for (const uri of ['file://localhost/tmp', 'file://other/tmp', 'file://switch:22/tmp',
      'file://user@switch/tmp', 'file://switch', 'file:relative', 'file://switch/tmp%0A',
      'file://switch/%5Ctmp', 'file://switch//tmp', 'file://switch/tmp#note',
      'file://switch/%zz', 'file://switch/' + 'x'.repeat(4096)]) {
      expect(remoteDirectory(uri, 'switch')).toBeNull()
    }
  })
})
