import { describe, expect, it } from 'vitest'
import { parseQuickConnect, quickSessionInput, type QuickTarget } from '../src/renderer/src/lib/quickconnect'

const ok = (s: string): QuickTarget => {
  const r = parseQuickConnect(s)
  if (!r || !r.ok) throw new Error(`expected a target for ${s}: ${r && !r.ok ? r.error : 'null'}`)
  return r.target
}
const err = (s: string): string => {
  const r = parseQuickConnect(s)
  if (!r || r.ok) throw new Error(`expected an error for ${s}`)
  return r.error
}

describe('parseQuickConnect', () => {
  it('user@host:port is SSH', () => {
    expect(ok('admin@127.0.0.1:2201')).toMatchObject({ protocol: 'ssh', host: '127.0.0.1', port: 2201, username: 'admin', bare: false, label: 'admin@127.0.0.1:2201' })
    expect(ok('  admin@core-sw1  ')).toMatchObject({ host: 'core-sw1', port: 22, label: 'admin@core-sw1' })
  })

  it('ssh:// with and without user, port and trailing slash', () => {
    expect(ok('ssh://user@host:2222')).toMatchObject({ protocol: 'ssh', host: 'host', port: 2222, username: 'user' })
    expect(ok('SSH://r1.lab.example/')).toMatchObject({ host: 'r1.lab.example', port: 22, username: '' })
  })

  it('telnet:// and raw:// / tcp://', () => {
    expect(ok('telnet://host')).toMatchObject({ protocol: 'telnet', host: 'host', port: 23, label: 'telnet://host' })
    expect(ok('telnet://ts1:2003')).toMatchObject({ port: 2003, label: 'telnet://ts1:2003' })
    expect(ok('raw://10.0.0.5:4001')).toMatchObject({ protocol: 'raw', port: 4001 })
    expect(ok('tcp://10.0.0.5:4001').protocol).toBe('raw')
  })

  it('serial:///dev/ttyUSB0?baud=115200 and Windows COM ports', () => {
    const t = ok('serial:///dev/ttyUSB0?baud=115200')
    expect(t).toMatchObject({ protocol: 'serial', host: '/dev/ttyUSB0', port: 0, label: '/dev/ttyUSB0 @ 115200' })
    expect(t.serial).toMatchObject({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none' })
    expect(ok('serial://COM3').host).toBe('COM3')
    expect(ok('serial:COM3').serial!.baudRate).toBe(9600)
    expect(ok('serial:///dev/ttyS0?baud=9600&databits=7&parity=even&stopbits=2&flow=rtscts').serial).toMatchObject({ dataBits: 7, parity: 'even', stopBits: 2, flow: 'rtscts' })
  })

  it('serial errors', () => {
    expect(err('serial://')).toMatch(/needs a port/)
    expect(err('serial:///dev/ttyUSB0?baud=fast')).toMatch(/baud/)
    expect(err('serial:///dev/ttyUSB0?databits=9')).toMatch(/Data bits/)
    expect(err('serial:///dev/ttyUSB0?flow=magic')).toMatch(/flow/)
  })

  it('bare hosts, flagged when they could be a search', () => {
    expect(ok('core-sw1')).toMatchObject({ protocol: 'ssh', host: 'core-sw1', port: 22, username: '', bare: true })
    expect(ok('10.1.1.1').bare).toBe(false)
    expect(ok('r1.example.net').bare).toBe(false)
    expect(ok('core-sw1:2222').bare).toBe(false)
  })

  it('IPv6, bracketed with a port or bare', () => {
    expect(ok('[2001:db8::1]:2222')).toMatchObject({ host: '2001:db8::1', port: 2222, label: '[2001:db8::1]:2222' })
    expect(ok('admin@[fe80::1%eth0]')).toMatchObject({ host: 'fe80::1%eth0', port: 22, username: 'admin' })
    expect(ok('2001:db8::1')).toMatchObject({ host: '2001:db8::1', port: 22, bare: false })
    expect(err('[nope]:22')).toMatch(/IPv6/)
  })

  it('usernames with @ or a domain prefix', () => {
    expect(ok('john@corp.example@10.0.0.1')).toMatchObject({ username: 'john@corp.example', host: '10.0.0.1' })
  })

  it('refuses passwords in the URL', () => {
    expect(err('admin:secret@10.0.0.1')).toMatch(/Passwords are not accepted/)
    expect(err('ssh://admin:secret@10.0.0.1:22')).toMatch(/Passwords/)
  })

  it('validates ports', () => {
    expect(err('host:0')).toMatch(/out of range/)
    expect(err('host:70000')).toMatch(/out of range/)
    expect(err('host:ssh')).toMatch(/Invalid port/)
    expect(err('host:')).toMatch(/Missing port/)
  })

  it('platform from ?platform=, Auto-detect by default', () => {
    expect(ok('admin@10.0.0.1').platform).toBe('auto')
    expect(ok('ssh://admin@10.0.0.1?platform=eos').platform).toBe('eos')
    expect(err('ssh://10.0.0.1?platform=vyos')).toMatch(/Unknown platform/)
  })

  it('is not a target: empty, spaces, junk without a hint', () => {
    expect(parseQuickConnect('')).toBeNull()
    expect(parseQuickConnect('   ')).toBeNull()
    expect(parseQuickConnect('show ip int brief')).toBeNull()
    expect(parseQuickConnect('foo/bar')).toBeNull()
    expect(parseQuickConnect('a,b')).toBeNull()
  })

  it('errors on unknown schemes and broken hosts once it clearly is a target', () => {
    expect(err('http://10.0.0.1')).toMatch(/Unsupported scheme/)
    expect(err('admin@bad/host')).toMatch(/Invalid host/)
    expect(err('ssh://')).toMatch(/Missing host/)
  })

  it('reports a bad % escape instead of throwing (#11, reviewer inputs)', () => {
    for (const s of ['100%@host', 'host?platform=%', 'a%zz@h', 'h?%=1']) expect(err(s), s).toMatch(/Invalid "%" escape/)
    expect(ok('ssh://a%40corp@h').username).toBe('a@corp')
  })

  it('builds the unsaved session for main', () => {
    expect(quickSessionInput(ok('admin@127.0.0.1:2201'))).toMatchObject({
      name: 'admin@127.0.0.1:2201',
      host: '127.0.0.1',
      port: 2201,
      protocol: 'ssh',
      username: 'admin',
      options: {}
    })
    // Only what quick connect needs: main's schema refuses anything else (#15).
    expect(Object.keys(quickSessionInput(ok('admin@127.0.0.1:2201'))).sort()).toEqual(['host', 'name', 'options', 'platform', 'port', 'protocol', 'username'])
    expect(quickSessionInput(ok('serial:COM3?baud=115200')).options.serial!.baudRate).toBe(115200)
  })
})
