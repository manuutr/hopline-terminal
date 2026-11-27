import { describe, expect, it } from 'vitest'
import { decodePuttyName, decodeText, importPutty, parseReg } from '../src'
import { byName, expectNoneLost, expectNoSecrets, fixture, warningsFor } from './helpers'

const text = fixture('putty-sessions.reg')
const result = importPutty(text)

describe('PuTTY .reg export', () => {
  it('loses no saved session', () => {
    // Independent count: registry keys directly below ...\PuTTY\Sessions\.
    const records = [...text.matchAll(/^\[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\\\]]+)\]$/gm)].map((m) => decodePuttyName(m[1]!))
    expect(records).toHaveLength(11)
    expectNoneLost(result, records)
  })

  it('URL-decodes names, UTF-8 first then Windows-1252', () => {
    expect(byName(result, 'Zürich sw')).toMatchObject({ protocol: 'telnet', host: '10.30.0.2', port: 23 })
    expect(byName(result, 'München-dmz').host).toBe('10.31.0.2')
  })

  it('reads HostName, PortNumber, UserName, agent and key', () => {
    const b = byName(result, 'bastion')
    expect(b).toMatchObject({ host: 'bastion.corp.example.net', port: 22, username: 'jump' })
    expect(b.options.ssh).toEqual({ agentForward: true })
    expect(b.notes).toBe('Private key: C:\\Users\\neteng\\.ssh\\jump.ppk')
  })

  it('splits user@host and maps an SSH proxy to a saved session', () => {
    const r = byName(result, 'core router (ios-xe)')
    expect(r).toMatchObject({ host: '10.20.0.1', username: 'netops', port: 2222, platform: 'iosxe', jumpRef: 'bastion' })
  })

  it('reads serial settings', () => {
    expect(byName(result, 'console COM3')).toMatchObject({
      protocol: 'serial',
      host: 'COM3',
      port: 0,
      options: { serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flow: 'none', breakMs: 300 } }
    })
    expect(byName(result, 'fast console').options.serial).toEqual({ baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even', flow: 'rtscts', breakMs: 300 })
  })

  it('maps raw, skips rlogin, the template and sessions without a host', () => {
    expect(byName(result, 'term server port 1')).toMatchObject({ protocol: 'raw', port: 2001 })
    expect(warningsFor(result, 'old sun').join()).toMatch(/rlogin/)
    expect(warningsFor(result, 'Default Settings').join()).toMatch(/template/)
    expect(warningsFor(result, 'empty').join()).toMatch(/no host/)
  })

  it('never copies proxy or KiTTY passwords and warns about them', () => {
    expectNoSecrets(result, ['Pr0xyPassw0rd!', '5D6C7B8A9F0E1D2C'])
    expect(warningsFor(result, 'München-dmz').join()).toMatch(/Proxy password/)
    expect(warningsFor(result, 'München-dmz').join()).toMatch(/SOCKS 5 proxy not imported/)
    expect(warningsFor(result, 'kitty saved').join()).toMatch(/password/)
  })

  it('reads a UTF-16LE file with a BOM and CRLF, as regedit writes it', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le')])
    const r = importPutty(decodeText(utf16))
    expect(r.sessions.map((s) => s.name)).toEqual(result.sessions.map((s) => s.name))
  })
})

describe('parseReg', () => {
  it('unescapes strings, reads dwords, honours deleted keys and hex continuations', () => {
    const r = parseReg(
      [
        'Windows Registry Editor Version 5.00',
        '[HKEY_CURRENT_USER\\a]',
        '"S"="C:\\\\x \\"q\\""',
        '"D"=dword:0000ffff',
        '"H"=hex:01,02,\\',
        '  03,04',
        '"After"="ok"',
        '[-HKEY_CURRENT_USER\\b]',
        '"Ignored"="x"'
      ].join('\r\n')
    )
    expect(Object.fromEntries(r.get('HKEY_CURRENT_USER\\a')!)).toEqual({ S: 'C:\\x "q"', D: 65535, After: 'ok' })
    expect(r.has('HKEY_CURRENT_USER\\b')).toBe(false)
  })
})
