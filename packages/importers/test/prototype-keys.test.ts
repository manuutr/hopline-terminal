/**
 * Input-derived keys must never reach inherited object members. A plain
 * `table[key]` with "constructor" returns the Object function, which then
 * lands in a session (protocol, platform) or a warning, and `structuredClone`
 * (the IPC copy) throws on it. Every importer gets these names as keys and as
 * values, and its result must clone cleanly and hold no function text.
 */
import { describe, expect, it } from 'vitest'
import {
  fetchNetBox,
  importCsv,
  importMobaXterm,
  importPutty,
  importSecureCrt,
  importSshConfig,
  parseXml,
  planImport,
  platformFromSlug,
  type FetchLike,
  type ImportResult,
  type Session
} from '../src'

const KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'prototype']

function expectClean(r: unknown) {
  expect(() => structuredClone(r)).not.toThrow()
  const json = JSON.stringify(r)
  expect(json).not.toMatch(/native code|function /)
  expect(structuredClone(r)).toEqual(JSON.parse(json))
}

function expectCleanResult(r: ImportResult) {
  expectClean(r)
  for (const s of r.sessions) {
    expect(['ssh', 'telnet', 'raw', 'serial']).toContain(s.protocol)
    if (s.platform !== undefined) expect(typeof s.platform).toBe('string')
  }
  // The diff planner indexes by name, folder and target: feed it the result, and existing sessions named after the keys.
  const existing: Session[] = KEYS.map((k, i) => ({
    id: `s${i}`,
    name: k,
    folderId: null,
    host: k,
    port: 22,
    protocol: 'ssh',
    platform: 'ios',
    username: k,
    credentialId: null,
    logToFile: false,
    notes: '',
    options: {}
  }))
  expectClean(planImport(existing, r))
  expectClean(planImport(existing, r, { folders: KEYS.map((k, i) => ({ id: `f${i}`, name: k, parentId: null, sort: 0 })) }))
}

describe.each(KEYS)('prototype key %j', (k) => {
  it('CSV: as headers, cells, and mapping keys', () => {
    // As values of every column, including protocol and platform (reviewer repro: protocol "constructor").
    const cells = `name,host,protocol,platform,folder,tags,username,port,baud\nr1,10.0.0.1,${k},ios,${k}/${k},${k},${k},${k},${k}\nr2,10.0.0.2,ssh,${k},a,b,c,22,9600\n${k},${k},serial,${k},${k},${k},${k},,${k}\n`
    expectCleanResult(importCsv(cells))
    // As headers.
    expectCleanResult(importCsv(`${k},host,${k}\nx,10.0.0.3,y\n`))
    // As mapping keys and mapped titles.
    expectCleanResult(importCsv(`${k},b\nsw1,10.0.0.1\n`, { host: 1, name: k, [k]: 0 } as never, { hasHeader: true }))
    expect(platformFromSlug(k)).toEqual({})
  })

  it('ssh_config: as aliases, keywords and values', () => {
    const text = `Host ${k} *\n  ${k} ${k}\n  User ${k}\n  ProxyJump ${k}\n  Port ${k}\nHost x\n  HostName ${k}\n  ProxyCommand ${k} -W %h:%p ${k}\nMatch ${k}\n  User y\n`
    expectCleanResult(importSshConfig(text))
  })

  it('PuTTY: as session names, value names and values', () => {
    const key = (name: string) => `[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\${name}]`
    const reg = [
      'Windows Registry Editor Version 5.00',
      '',
      key('r1'),
      `"HostName"="10.0.0.1"`,
      `"Protocol"="${k}"`,
      key(k),
      `"HostName"="${k}"`,
      `"${k}"="${k}"`,
      `"Protocol"="ssh"`,
      `"ProxyMethod"=dword:00000006`,
      `"ProxyHost"="${k}"`,
      key('ser'),
      `"Protocol"="serial"`,
      `"SerialLine"="${k}"`,
      ''
    ].join('\r\n')
    expectCleanResult(importPutty(reg))
  })

  it('SecureCRT: as file names, folders, option names and values (ini and XML)', () => {
    const ini = (proto: string) => `S:"Protocol Name"=${proto}\nS:"Hostname"=10.0.0.1\nS:"${k}"=${k}\nD:"${k}"=00000001\nS:"Firewall Name"=Session:${k}\n`
    expectCleanResult(
      importSecureCrt([
        { path: 'Sessions/a.ini', text: ini(k) },
        { path: `Sessions/${k}/${k}.ini`, text: ini('SSH2') },
        { path: `Sessions/${k}/__FolderData__.ini`, text: '' }
      ])
    )
    const xml = `<?xml version="1.0"?><VanDyke ${k}="${k}"><key name="Sessions"><key name="${k}" ${k}="x"><key name="${k}"><string name="Hostname">&${k};</string><string name="Protocol Name">${k}</string><string name="${k}">${k}</string></key><key name="ok"><string name="Hostname">10.0.0.9 &${k};</string></key></key></key></VanDyke>`
    expectCleanResult(importSecureCrt([{ path: 'export.xml', text: xml }]))
    const el = parseXml(`<a ${k}="v" name="n">&${k};</a>`)
    expect(el.text).toBe(`&${k};`)
    expect(Object.keys(el.attrs)).toEqual([k, 'name'])
    expectClean(el)
  })

  it('MobaXterm: as section values, session names and types', () => {
    const line = (type: string) => `#109#${type}%10.0.0.1%22%${k}%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1`
    const text = `[Bookmarks]\nSubRep=${k}\\${k}\nImgNum=42\nr1=${line(k)}\n${k}=${line('0')}\n[Bookmarks_1]\nSubRep=\n${k}=${k}\n`
    const r = importMobaXterm(text)
    expectCleanResult(r)
    expect(r.warnings.map((w) => w.message)).toContain(`Skipped: MobaXterm type ${k} sessions are not supported`)
  })

  it('NetBox: as JSON keys and values', async () => {
    // JSON.parse makes "__proto__" an own key, as a real response body would.
    const body = JSON.parse(
      JSON.stringify({ count: 2, next: null, results: [] }).replace(
        '"results":[]',
        `"results":[{"id":1,"name":"${k}","__proto__":{"x":1},"constructor":"${k}","primary_ip":{"address":"10.0.0.1/32","__proto__":"${k}"},"site":{"name":"${k}"},"platform":{"slug":"${k}","name":"${k}"},"role":{"name":"${k}"},"tags":[{"name":"${k}"},"${k}"]},{"id":2,"name":"r2","primary_ip4":{"address":"10.0.0.2"},"platform":{"network_driver":"${k}"},"${k}":{"name":"${k}"}}]`
      )
    )
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => body })
    expectCleanResult(await fetchNetBox({ url: 'https://nb.example.com', token: 't', filter: { [k]: k } }, fetchImpl))
  })
})
