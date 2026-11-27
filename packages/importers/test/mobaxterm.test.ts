import { describe, expect, it } from 'vitest'
import { decodeMobaBaud, decodeText, importMobaXterm, unescapeMoba } from '../src'
import { byName, expectNoneLost, expectNoSecrets, fixture, warningsFor } from './helpers'

// Serial lines are real exports quoted in the research doc; their field meaning
// beyond port and speed is a hypothesis (see docs/research appendix C.5).
const text = fixture('sessions.mxtsessions')
const result = importMobaXterm(text)

/** Independent record list: every `name=` line inside a [Bookmarks*] section that is not SubRep/ImgNum. */
function bookmarkRecords(src: string): string[] {
  const out: string[] = []
  let folder: string[] = []
  let inside = false
  for (const line of src.split(/\r?\n/)) {
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      inside = sec[1]!.startsWith('Bookmarks')
      folder = []
      continue
    }
    if (!inside || !line.includes('=')) continue
    const [k, v] = [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]
    if (k === 'SubRep') folder = v.split('\\').filter(Boolean)
    else if (k !== 'ImgNum') out.push([...folder, k.trim()].join('/'))
  }
  return out
}

describe('MobaXterm .mxtsessions', () => {
  it('loses no bookmark', () => {
    const records = bookmarkRecords(text)
    expect(records).toHaveLength(11)
    expectNoneLost(result, records)
  })

  it('maps SubRep folders, including empty ones', () => {
    expect(result.folders.map((f) => f.path.join('/'))).toEqual(['Network', 'Network/Core', 'Network/Core/Empty', 'Lab'])
    expect(byName(result, 'core-nxos-01').folderPath).toEqual(['Network', 'Core'])
  })

  it('reads SSH fields: host, port, user, key, agent forwarding, logging, comment escapes', () => {
    const s = byName(result, 'core-nxos-01')
    expect(s).toMatchObject({ protocol: 'ssh', host: '10.20.0.11', port: 22, username: 'netops', platform: 'nxos', logToFile: true })
    expect(s.options.ssh).toEqual({ agentForward: true })
    expect(s.notes).toContain('Spine ; row 4 #1')
    expect(s.notes).toContain('Private key: C:\\Keys\\core.ppk')
  })

  it('treats <default> as no username and keys the type on field 0, not the icon', () => {
    const z = byName(result, 'Zürich edge')
    expect(z.username).toBe('')
    expect(z.port).toBe(2222)
    expect(warningsFor(result, 'desk rdp').join()).toMatch(/RDP/)
    expect(warningsFor(result, 'Lab/ubuntu wsl').join()).toMatch(/WSL/)
  })

  it('resolves a gateway to the matching imported session', () => {
    expect(byName(result, 'core-nxos-01').jumpRef).toBe('bastion')
  })

  it('creates jump sessions for gateway chains that name plain hosts', () => {
    const z = byName(result, 'Zürich edge')
    expect(z.jumpChain).toEqual(['alice@jump1.example.net', '10.30.255.1:2200'])
    expect(z.jumpRef).toBe('alice@jump1.example.net')
    const j = byName(result, '10.30.255.1:2200')
    expect(j).toMatchObject({ host: '10.30.255.1', port: 2200, tags: ['jump-host'], source: { format: 'synthesized' } })
    expect(warningsFor(result, 'alice@jump1.example.net').join()).toMatch(/jump-host session/)
  })

  it('reads Telnet host and port', () => {
    expect(byName(result, 'tokyo-telnet')).toMatchObject({ protocol: 'telnet', host: '10.40.0.1', port: 5000, folderPath: ['Network', 'Core'] })
  })

  it('decodes serial port and speed from real export lines and asks for confirmation', () => {
    const a = byName(result, 'COM10')
    expect(a).toMatchObject({ protocol: 'serial', host: 'COM10', port: 0 })
    expect(a.options.serial?.baudRate).toBe(115200)
    const b = byName(result, 'com (usb-serial)')
    expect(b.host).toBe('COM3')
    expect(b.options.serial?.baudRate).toBe(9600)
    expect(warningsFor(result, 'COM10').join()).toMatch(/partly known format/)
  })

  it('flags duplicate names in one folder and keeps both', () => {
    expect(result.sessions.filter((s) => s.name === 'lab-sw').map((s) => s.host)).toEqual(['10.50.0.1', '10.50.0.2'])
    expect(warningsFor(result, 'Lab/lab-sw').join()).toMatch(/Duplicate/)
  })

  it('ignores the [Passwords] section and reports sessions without a host', () => {
    expectNoSecrets(result, ['DEADBEEF'])
    expect(warningsFor(result, 'Lab/no-host').join()).toMatch(/no host/)
  })

  it('decodes a Windows-1252, CRLF file', () => {
    const bytes = Buffer.from(text.replace(/\n/g, '\r\n'), 'latin1')
    const r = importMobaXterm(decodeText(bytes))
    expect(r.sessions.map((s) => s.name)).toContain('Zürich edge')
    expect(r.sessions).toHaveLength(result.sessions.length)
  })

  it('works when SubRep follows the sessions', () => {
    const r = importMobaXterm('[Bookmarks_1]\nr1=#109#0%10.0.0.1%22%%\nSubRep=Late\\Folder\n')
    expect(r.sessions[0]!.folderPath).toEqual(['Late', 'Folder'])
  })
})

describe('MobaXterm helpers', () => {
  it('decodes speeds', () => {
    expect(decodeMobaBaud('1009600')).toBe(9600)
    expect(decodeMobaBaud('1115200')).toBe(115200)
    expect(decodeMobaBaud('19200')).toBe(19200)
    expect(decodeMobaBaud('1234567')).toBeUndefined()
  })
  it('unescapes fields', () => {
    expect(unescapeMoba('a__PTVIRG__b__DBLQUO__c__PIPE__d__DIEZE__e__PERCENT__f')).toBe('a;b"c|d#e%f')
  })
})
