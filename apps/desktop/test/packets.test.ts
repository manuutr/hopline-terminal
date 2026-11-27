import { dirname, join } from 'node:path'
import type { WiregasmLoader } from '@goodtools/wiregasm'
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/main/productivity/runner'

describe('device capture guard', () => {
  it.each(['monitor capture H1234567 interface Gi1/0/1 in', 'monitor capture H1234567 match ipv6 host 2001:db8::1 any',
    'monitor capture H1234567 limit duration 2 packets 1000', 'monitor capture H1234567 file location flash:H1234567.pcap',
    'monitor capture H1234567 start', 'monitor capture H1234567 stop', 'no monitor capture H1234567'])('requires disruptive approval for %s', (line) => {
    expect(analyze('iosxe', [line])).toMatchObject({ shape: 'exec', kind: 'disruptive' })
    expect(analyze('iosxe', [line], { readOnlyMode: true }).kind).toBe('refused')
  })
})

it('loads the security-reviewed Wireshark version from the actual WASM binary', async () => {
  const loader = require.resolve('@goodtools/wiregasm/dist/wiregasm.js')
  const load: WiregasmLoader = require(loader)
  const lib = await load({ locateFile: name => join(dirname(loader), name) })
  expect(lib.wiresharkVersion()).toBe('4.6.10')
})
