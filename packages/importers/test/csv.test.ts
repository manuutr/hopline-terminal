import { describe, expect, it } from 'vitest'
import { detectDelimiter, importCsv, parseCsv } from '../src'
import { expectNoneLost, expectNoSecrets, fixture, warningsFor } from './helpers'

const text = fixture('devices.csv')
const result = importCsv(text)
const rows = (name: string) => result.sessions.filter((s) => s.name === name)

describe('CSV', () => {
  it('loses no row', () => {
    // Independent count: data records in the fixture (one has a quoted newline).
    const records = ['core-sw1', 'core-sw2', 'leaf-ä1', 'fw-edge', 'tokyo-東京', 'no-ip-yet', 'console-1', 'old-box', 'weird-port']
    expect(parseCsv(text, ',')).toHaveLength(11)
    expectNoneLost(result, records)
    expect(result.sessions).toHaveLength(8)
  })

  it('auto-detects headers and strips the prefix length', () => {
    expect(rows('core-sw1')[0]).toMatchObject({ host: '10.0.0.1', port: 22, protocol: 'ssh', username: 'netops', folderPath: ['DC1', 'Core'], platform: 'iosxe', tags: ['core', 'dc1'] })
  })

  it('reads quoted fields with delimiters, escaped quotes and newlines', () => {
    expect(rows('core-sw2')[0]).toMatchObject({ port: 2222, notes: 'Secondary core, "B" side', platform: 'iosxe' })
    expect(rows('leaf-ä1')[0]).toMatchObject({ notes: 'Multi-line\ndescription', folderPath: ['DC1', 'Leaf', 'Row 1'], platform: 'nxos', tags: ['leaf', 'dc1'] })
  })

  it('never imports the password column', () => {
    expectNoSecrets(result, ['hunter2'])
    expect(warningsFor(result, 'core-sw2').join()).toMatch(/Password/)
  })

  it('maps every modelled platform (PAN-OS here)', () => {
    expect(rows('fw-edge')[0]!.platform).toBe('panos')
  })

  it('leaves unsupported platforms undetermined with a warning', () => {
    const r = importCsv('name,host,platform\nmt1,10.0.0.9,mikrotik_routeros\n')
    expect(r.sessions[0]!.platform).toBeUndefined()
    expect(warningsFor(r, 'mt1').join()).toMatch(/not supported yet/)
  })

  it('handles telnet, serial, unicode names, bad ports and missing hosts', () => {
    expect(rows('tokyo-東京')[0]).toMatchObject({ protocol: 'telnet', port: 23 })
    expect(rows('console-1')[0]).toMatchObject({ protocol: 'serial', host: '/dev/ttyUSB0', port: 0, options: { serial: { baudRate: 9600 } } })
    expect(rows('weird-port')[0]!.port).toBe(22)
    expect(warningsFor(result, 'weird-port').join()).toMatch(/Invalid port/)
    expect(warningsFor(result, 'no-ip-yet').join()).toMatch(/no host/)
    expect(warningsFor(result, 'old-box').join()).toMatch(/rlogin/)
  })

  it('keeps duplicates and flags them', () => {
    expect(rows('core-sw1')).toHaveLength(2)
    expect(warningsFor(result, 'DC1/Core/core-sw1').join()).toMatch(/Duplicate/)
  })

  it('detects ; delimiters with a BOM and CRLF (European Excel)', () => {
    const semi = '﻿Hostname;IP;Group;OS\r\nr1;10.1.0.1;Branch/North;junos\r\nr2;"10.1.0.2";Branch/South;Arista EOS\r\n'
    expect(detectDelimiter(semi.slice(1))).toBe(';')
    const r = importCsv(semi)
    // With both Hostname and IP columns, the IP is the host and Hostname the name.
    expect(r.sessions.map((s) => [s.name, s.host])).toEqual([['r1', '10.1.0.1'], ['r2', '10.1.0.2']])
    expect(r.sessions.map((s) => s.platform)).toEqual(['junos', 'eos'])
    expect(r.sessions[0]!.folderPath).toEqual(['Branch', 'North'])
  })

  it('reads the same file saved with CRLF line endings, quoted newlines included', () => {
    const crlf = importCsv(text.replace(/\r?\n/g, '\r\n'))
    expect(crlf.sessions).toEqual(result.sessions)
    expect(crlf.sessions.find((s) => s.name === 'leaf-ä1')!.notes).toBe('Multi-line\ndescription')
    expect(parseCsv('a,"x\ry"\r\n', ',')).toEqual([['a', 'x\ny']])
  })

  it('keeps serial device paths intact and marks name-based platform guesses', () => {
    const r = importCsv('name,host,protocol\ncon,/dev/pts/3,serial\nspine-nxos-1,10.0.0.5,ssh\n')
    expect(r.sessions[0]!.host).toBe('/dev/pts/3')
    expect(r.sessions[1]).toMatchObject({ platform: 'nxos', platformGuessed: true })
    expect(rows('core-sw1')[0]!.platformGuessed).toBeUndefined()
  })

  it('connects to a lone Hostname column (SecureCRT Text Import Wizard layout)', () => {
    const r = importCsv('Session Name,Hostname,Protocol,Username,Folder\ncore,core.example.net,SSH2,ops,DC\n')
    expect(r.sessions[0]).toMatchObject({ name: 'core', host: 'core.example.net', protocol: 'ssh', username: 'ops', folderPath: ['DC'] })
  })

  it('accepts an explicit mapping by header name or index', () => {
    const r = importCsv('device,mgmt,where\nsw9,10.9.9.9,Lab\n', { name: 'device', host: 'mgmt', folder: 2 })
    expect(r.sessions[0]).toMatchObject({ name: 'sw9', host: '10.9.9.9', folderPath: ['Lab'] })
    const n = importCsv('sw8,10.8.8.8\n', { name: 0, host: 1 })
    expect(n.sessions[0]).toMatchObject({ name: 'sw8', host: '10.8.8.8' })
  })

  it('accounts for every row when no host column can be found', () => {
    const r = importCsv('foo,bar\n1,2\n3,4\n')
    expect(r.sessions).toEqual([])
    expect(r.warnings.map((w) => w.item)).toEqual(['header', 'row 2', 'row 3'])
  })

  it('never lets a password column feed a field, even when mapped explicitly (reviewer repro)', () => {
    const r = importCsv('host,name,password\n10.0.0.1,sw1,S3cr3t!\n', { name: 2 }, { hasHeader: true })
    expectNoSecrets(r, ['S3cr3t!'])
    // The mapping is dropped; "name" keeps its auto-detected column.
    expect(r.sessions[0]).toMatchObject({ name: 'sw1', host: '10.0.0.1' })
    expect(r.warnings.map((w) => w.message).join()).toMatch(/Not mapped to name: the column holds passwords/)
    expect(r.headerless).toBeUndefined()
  })

  it('rejects secret columns for every field, by index or title, and in auto-detection', () => {
    const csv = 'Name,Host,Enable Secret,SSH Password,pass\nsw1,10.0.0.1,en4ble,pw-1,pw-2\n'
    for (const m of [{ host: 2 }, { host: 'SSH Password' }, { notes: 4, username: 'pass', tags: 3, folder: 2 }] as const) {
      const r = importCsv(csv, m, { hasHeader: true })
      expectNoSecrets(r, ['en4ble', 'pw-1', 'pw-2'])
      expect(r.warnings.some((w) => /never imported/.test(w.message))).toBe(true)
    }
    const auto = importCsv('host,secret,passwd\n10.0.0.1,s-1,s-2\n')
    expectNoSecrets(auto, ['s-1', 's-2'])
    expect(warningsFor(auto, '10.0.0.1').join()).toMatch(/Password/)
  })

  it('ignores unknown fields in the mapping', () => {
    const r = importCsv('a,b\nsw1,10.0.0.1\n', { host: 1, name: 0, constructor: 0 } as never, { hasHeader: true })
    expect(r.sessions[0]).toMatchObject({ name: 'sw1', host: '10.0.0.1' })
    expect(r.warnings.map((w) => w.message).join()).toMatch(/Unknown field "constructor"/)
  })

  it('flags headerless files so the app can warn that a mapped column might hold secrets', () => {
    expect(importCsv('sw8,10.8.8.8\n', { name: 0, host: 1 }).headerless).toBe(true)
    expect(importCsv('sw8,10.8.8.8\n', { name: 0 }, { hasHeader: false }).headerless).toBe(true)
    expect(importCsv('', { host: 0 }).headerless).toBe(true)
    expect(importCsv('host\n10.0.0.1\n').headerless).toBeUndefined()
  })
})
