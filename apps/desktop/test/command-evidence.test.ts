import { describe, expect, it } from 'vitest'
import { formatTicketReport, outputExcerpt } from '../src/renderer/src/lib/command-evidence'

describe('local incident reports', () => {
  it('records the source, quotes terminal markup literally and scrubs secrets and control sequences', () => {
    const report = formatTicketReport('block', [{
      device: 'branch\nedge', session: 'Jump box', host: '192.0.2.1', platform: 'IOS', recordedAt: 0,
      command: 'snmp-server community TESTcommunity RO',
      output: '\x1b[31mVlan10 up\x1b[0m\r\n```\n# device heading\nusername admin secret 0 TESTpassword'
    }], 1000)
    expect(report).toContain('    Device: branch edge\n    Session: Jump box\n    Connection host: 192.0.2.1\n    Platform: IOS')
    expect(report).toContain('Recorded: 1970-01-01T00:00:00.000Z')
    expect(report).toContain('Exported 1970-01-01T00:00:01.000Z')
    expect(report).toContain('    Vlan10 up\n    ```\n    # device heading')
    expect(report).not.toMatch(/TESTcommunity|TESTpassword|\x1b|\r/)
  })

  it('keeps failed targets and reasons alongside successful observations', () => {
    const report = formatTicketReport('run', [
      { device: 'edge', platform: 'PAN-OS', command: 'show routing route', output: '10.0.0.0/8', status: 'ok' },
      { device: 'branch', platform: 'FortiOS', command: 'get router info routing-table all', status: 'error', reason: 'connect failed\nsnmp-server community TESTcommunity RO' }
    ], 0)
    expect(report).toContain('    Result: error\n    Detail: connect failed')
    expect(report).not.toContain('TESTcommunity')
    expect(report).toContain('**Requested command**\n\n    get router info routing-table all')
    expect(report).toContain('No output captured.')
    expect(report).toContain('10.0.0.0/8')
    expect(report).not.toContain('Recorded:')
  })

  it('redacts a multiline secret before taking the output excerpt', () => {
    const before = 'a'.repeat(9000)
    const after = 'z'.repeat(9000)
    const output = outputExcerpt(before + '\n-----BEGIN PRIVATE KEY-----\n' + 'SecretBody\n'.repeat(1100) + '-----END PRIVATE KEY-----\n' + after)
    expect(output).not.toContain('SecretBody')
    expect(output).toMatch(/^a+\n\[… middle of output omitted …\]\nz+$/)
  })
})
