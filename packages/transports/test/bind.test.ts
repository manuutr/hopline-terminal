import { describe, expect, it } from 'vitest'
import { isAnyAddressBind, isExposedBind, isLoopbackBind } from '../src/bind.ts'

// Review M10: the wildcard check missed spellings the OS resolver accepts.
describe('bind addresses', () => {
  const wildcards = ['0', '0.0', '0x0', '00', '0.0.0', '0.0.0.0', '0x0.0', '::', '::0', '0::', '0:0:0:0:0:0:0:0', '0000:0000::', '[::]', '*', '', '  ', '::ffff:0.0.0.0']
  const lan = ['192.168.1.10', '10.0.0.1', '172.16.0.5', 'fe80::1', '2001:db8::1', '::2', 'myhost', 'localhost.evil.com', '127.0.0.1.nip.io', '0177.0.0.1', '127.1', '2130706433', '0x7f.0.0.1']
  const loopback = ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', ' 127.0.0.1 ', '::1', '0:0:0:0:0:0:0:1', '0000::0001', '[::1]', '::ffff:127.0.0.1']

  it('only loopback literals and localhost count as loopback', () => {
    for (const h of loopback) expect(isLoopbackBind(h), h).toBe(true)
    for (const h of [...wildcards, ...lan]) expect(isLoopbackBind(h), h).toBe(false)
    for (const h of [...wildcards, ...lan]) expect(isExposedBind(h), h).toBe(true)
  })

  it('recognises every spelling of "every interface"', () => {
    for (const h of wildcards) expect(isAnyAddressBind(h), h).toBe(true)
    for (const h of [...loopback, '192.168.1.10', '::2', '0.0.0.1', '0x1']) expect(isAnyAddressBind(h), h).toBe(false)
  })
})
