import { describe, expect, it } from 'vitest'
import { importSecureCrt, parseCrtIni, sessionRef } from '../src'
import { byName, expectNoneLost, expectNoSecrets, fixture, fixtureTree, warningsFor } from './helpers'

const tree = fixtureTree('securecrt')
const result = importSecureCrt(tree)

describe('SecureCRT .ini tree', () => {
  it('loses no session file', () => {
    // Independent count: every .ini under Sessions/ except __FolderData__.ini.
    const records = tree
      .filter((f) => f.path.includes('/Sessions/') && f.path.endsWith('.ini') && !f.path.endsWith('__FolderData__.ini'))
      .map((f) => f.path.split('/Sessions/')[1]!.replace(/\.ini$/, ''))
    expect(records).toHaveLength(12)
    expectNoneLost(result, records)
  })

  it('maps folders from subdirectories, keeping empty ones', () => {
    const paths = result.folders.map((f) => f.path.join('/'))
    expect(paths).toEqual(expect.arrayContaining(['Archive', 'jump', 'Lab', 'Prod', 'Prod/Core']))
    expect(byName(result, 'core-nxos-01').folderPath).toEqual(['Prod', 'Core'])
  })

  it('reads hex ports, username and agent forwarding', () => {
    const b = byName(result, 'bastion')
    expect(b).toMatchObject({ host: 'bastion.corp.example.net', port: 22, protocol: 'ssh', username: 'jumpuser', folderPath: ['jump'] })
    expect(b.options.ssh).toEqual({ agentForward: true })
    expect(b.notes).toContain('Identity file: ${VDS_SSH_DATA_PATH}/id_ed25519')
    expect(b.notes).not.toContain('::rawkey')
    const core = byName(result, 'core-nxos-01')
    expect(core.port).toBe(2222)
    // "Enable Agent Forwarding"=2 has unknown meaning: left unset.
    expect(core.options.ssh).toBeUndefined()
  })

  it('uses [SSH2] Port for SSH and Port for Telnet/Raw', () => {
    expect(byName(result, '路由器-東京')).toMatchObject({ protocol: 'telnet', port: 23, host: 'tokyo-rtr1.example.jp' })
    expect(byName(result, 'term-server')).toMatchObject({ protocol: 'raw', port: 2001 })
  })

  it('reads multi-line descriptions, credential titles and logging', () => {
    const core = byName(result, 'core-nxos-01')
    expect(core.notes).toContain('Nexus 9300 spine, row 4\nChange window: Tue 02:00 UTC')
    expect(core.notes).toContain('SecureCRT credential: core login')
    expect(core.logToFile).toBe(true)
    expect(core).toMatchObject({ platform: 'nxos', platformGuessed: true })
    expect(byName(result, 'bastion').platform).toBeUndefined()
  })

  it('resolves Firewall Name=Session:<path> to a jump reference', () => {
    expect(byName(result, 'core-nxos-01').jumpRef).toBe('jump/bastion')
  })

  it('reports unresolved jump sessions and global firewalls', () => {
    const edge = byName(result, 'edge-fw')
    expect(edge.jumpRef).toBeUndefined()
    expect(edge.notes).toContain('Prod/does-not-exist')
    expect(warningsFor(result, 'Prod/edge-fw').join()).toMatch(/not found/)
    expect(warningsFor(result, 'Prod/dmz-socks').join()).toMatch(/Corp SOCKS/)
  })

  it('never imports passwords and warns once per session that had one', () => {
    expectNoSecrets(result, ['02:4f1d2a9b', '03:a1b2c3d4'])
    expect(warningsFor(result, 'Prod/Core/core-nxos-01').filter((m) => /password/i.test(m))).toHaveLength(1)
    expect(warningsFor(result, 'Prod/edge-fw').filter((m) => /password/i.test(m))).toHaveLength(1)
    expect(warningsFor(result, 'jump/bastion')).toEqual([])
  })

  it('maps serial settings by exact key, ignoring localized and printer duplicates', () => {
    const s = byName(result, 'Serial-COM4')
    expect(s).toMatchObject({ protocol: 'serial', host: 'COM4', port: 0 })
    expect(s.options.serial).toEqual({ baudRate: 115200, dataBits: 8, parity: 'even', stopBits: 1, flow: 'rtscts', breakMs: 100 })
  })

  it('skips the root Default.ini template but keeps a subfolder Default', () => {
    expect(warningsFor(result, 'Default').join()).toMatch(/template/)
    expect(byName(result, 'Default').folderPath).toEqual(['Lab'])
  })

  it('reports unsupported protocols and incomplete sessions', () => {
    expect(warningsFor(result, 'Lab/win-jumpbox').join()).toMatch(/RDP/)
    expect(warningsFor(result, 'Lab/old-sun').join()).toMatch(/RLogin/)
    expect(warningsFor(result, 'Lab/half-done').join()).toMatch(/no hostname/)
  })

  it('ignores Config files outside Sessions/', () => {
    expect(result.sessions.some((s) => s.name === 'SSH2')).toBe(false)
  })

  it('accepts Windows paths, CRLF and a BOM', () => {
    const text = '\ufeff' + fixture('securecrt/Config/Sessions/jump/bastion.ini').replace(/\n/g, '\r\n')
    const r = importSecureCrt([{ path: 'C:\\Users\\me\\AppData\\Roaming\\VanDyke\\Config\\Sessions\\Sites\\HQ\\bastion.ini', text }])
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]).toMatchObject({ folderPath: ['Sites', 'HQ'], host: 'bastion.corp.example.net', username: 'jumpuser' })
  })

  it('takes paths without a Sessions segment as relative to it', () => {
    const r = importSecureCrt([{ path: 'Branch/r1.ini', text: 'S:"Protocol Name"=SSH2\nS:"Hostname"=r1\n' }])
    expect(sessionRef(r.sessions[0]!)).toBe('Branch/r1')
    expect(r.sessions[0]!.port).toBe(22)
  })
})

describe('parseCrtIni', () => {
  it('parses S, D, Z and skips B continuation lines', () => {
    const o = parseCrtIni('B:"Font"=00000002\n 00 ff\nZ:"Description"=00000002\n a\n b\nD:"Port"=00000017\nS:"Hostname"=x=y\n')
    expect(o.get('Port')).toEqual({ t: 'D', v: 23 })
    expect(o.get('Description')).toEqual({ t: 'Z', v: ['a', 'b'] })
    expect(o.get('Hostname')).toEqual({ t: 'S', v: 'x=y' })
  })
})

describe('SecureCRT XML export', () => {
  const xml = importSecureCrt([{ path: 'export.xml', text: fixture('securecrt-export.xml') }])

  it('loses no session', () => {
    // Independent count: <key> elements under Sessions with Is Session=1 or a Hostname, plus the Default template.
    const records = ['Default', 'Prod/web', 'Prod/db & cache', 'Prod/Spines/spine-eos-1', 'Console/ttyUSB0 console', 'Console/desk pc', 'telnet-sw']
    expect(fixture('securecrt-export.xml').match(/<dword name="Is Session">1<\/dword>/g)).toHaveLength(5)
    expectNoneLost(xml, records)
    expect(xml.sessions).toHaveLength(5)
  })

  it('reads decimal dwords, arrays and entity-escaped names', () => {
    const web = byName(xml, 'web')
    expect(web).toMatchObject({ host: '10.3.3.3', port: 2222, username: 'deploy', folderPath: ['Prod'] })
    expect(web.notes).toContain('Front-end web & cache\nOwner: <platform team>')
    expect(byName(xml, 'db & cache').jumpRef).toBe('Prod/web')
  })

  it('flattens nested option keys defensively', () => {
    const spine = byName(xml, 'spine-eos-1')
    expect(spine).toMatchObject({ port: 830, folderPath: ['Prod', 'Spines'], platform: 'eos' })
    expect(spine.options.ssh).toEqual({ agentForward: true })
  })

  it('reads OS-prefixed serial keys without suffix-matching the printer ones', () => {
    const s = byName(xml, 'ttyUSB0 console')
    expect(s).toMatchObject({ protocol: 'serial', host: '/dev/ttyUSB0' })
    expect(s.options.serial).toMatchObject({ baudRate: 9600, dataBits: 7, parity: 'odd', stopBits: 2, flow: 'xonxoff' })
  })

  it('keeps empty folders and never reads the Credentials section', () => {
    expect(xml.folders.map((f) => f.path.join('/'))).toEqual(expect.arrayContaining(['Prod/Empty Folder', 'Console']))
    expectNoSecrets(xml, ['SECRET-CREDENTIAL-BLOB', 'ANOTHER-SECRET-BLOB'])
    expect(warningsFor(xml, 'Prod/db & cache').join()).toMatch(/password/i)
    // A shared credential's password is not imported either.
    expect(warningsFor(xml, 'Prod/web').join()).toMatch(/credential "lab login".*password is not imported/)
  })

  it('treats a key without Is Session but with a Hostname as a session', () => {
    expect(byName(xml, 'telnet-sw')).toMatchObject({ protocol: 'telnet', port: 2323, folderPath: [] })
  })

  it('reports a broken export instead of throwing', () => {
    const r = importSecureCrt([{ path: 'bad.xml', text: '<VanDyke><key name="Sessions"><key name="x">' }])
    expect(r.sessions).toEqual([])
    expect(r.warnings[0]!.item).toBe('bad.xml')
  })
})

describe('SecureCRT folder paths', () => {
  const ini = 'S:"Protocol Name"=SSH2\nS:"Hostname"=10.0.0.2\n'

  it('drops ".", ".." and empty segments (reviewer repro)', () => {
    const r = importSecureCrt([
      { path: 'Sessions/../../x/b.ini', text: ini },
      { path: 'Sessions/./y//./c.ini', text: ini },
      { path: 'Sessions\\..\\..\\..\\d.ini', text: ini }
    ])
    expect(r.sessions.map((s) => s.folderPath)).toEqual([['x'], ['y'], []])
    expect(r.folders.flatMap((f) => f.path).filter((p) => p === '..' || p === '.' || !p.trim())).toEqual([])
    const xml = `<VanDyke><key name="Sessions"><key name=".."><key name="."><key name=""><key name="r1"><string name="Hostname">10.0.0.1</string></key></key></key></key></key></VanDyke>`
    const x = importSecureCrt([{ path: 'export.xml', text: xml }])
    expect(byName(x, 'r1').folderPath).toEqual([])
    expect(x.folders).toEqual([])
  })

  it('caps depth at 32, folding deeper levels into the last folder with one warning', () => {
    const deep = Array.from({ length: 300 }, (_, i) => `d${i}`)
    const r = importSecureCrt([
      { path: `Sessions/${deep.join('/')}/c.ini`, text: ini },
      { path: `Sessions/${deep.join('/')}/e.ini`, text: ini }
    ])
    const want = [...deep.slice(0, 31), deep.slice(31).join(' › ')]
    expect(byName(r, 'c').folderPath).toEqual(want)
    expect(byName(r, 'e').folderPath).toEqual(want)
    expect(Math.max(...r.folders.map((f) => f.path.length))).toBe(32)
    expect(r.warnings.filter((w) => /levels below 32/.test(w.message))).toHaveLength(1)

    // XML nests up to the parser's own limit (128).
    const xml = `<VanDyke><key name="Sessions">${deep.slice(0, 100).map((d) => `<key name="${d}">`).join('')}<key name="r1"><string name="Hostname">10.0.0.1</string></key>${'</key>'.repeat(100)}</key></VanDyke>`
    const x = importSecureCrt([{ path: 'export.xml', text: xml }])
    expect(byName(x, 'r1').folderPath).toEqual([...deep.slice(0, 31), deep.slice(31, 100).join(' › ')])
    expect(Math.max(...x.folders.map((f) => f.path.length))).toBe(32)
  })
})
