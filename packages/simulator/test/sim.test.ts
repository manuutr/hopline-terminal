import ssh2 from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEosDevice, makeIosDevice, startSim, type RunningSim } from '../src/index.ts'

const { Client } = ssh2

/** Minimal expect-style driver over an ssh2 shell. */
async function connect(port: number) {
  const client = new Client()
  const stream = await new Promise<ssh2.ClientChannel>((resolve, reject) => {
    client
      .on('ready', () => client.shell({ rows: 24, cols: 120, term: 'xterm' }, (err, s) => (err ? reject(err) : resolve(s))))
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'admin', password: 'admin' })
  })
  let buf = ''
  stream.on('data', (d: Buffer) => (buf += d.toString()))
  const waitFor = async (re: RegExp, ms = 3000): Promise<string> => {
    const start = Date.now()
    while (!re.test(buf)) {
      if (Date.now() - start > ms) throw new Error(`timeout waiting for ${re}; got:\n${buf}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    const out = buf
    buf = ''
    return out
  }
  const run = async (cmd: string, until = /[\w-]+(\([\w-]+\))?#$/): Promise<string> => {
    stream.write(cmd + '\r')
    return waitFor(until)
  }
  return { client, stream, waitFor, run, send: (s: string) => stream.write(s) }
}

let ios: RunningSim
let eos: RunningSim
beforeAll(async () => {
  ios = await startSim({ device: makeIosDevice(), port: 0 })
  eos = await startSim({ device: makeEosDevice(), port: 0 })
})
afterAll(async () => {
  await ios.close()
  await eos.close()
})

describe('IOS personality', () => {
  it('logs in, shows a prompt, and answers show commands with abbreviations', async () => {
    const s = await connect(ios.port)
    await s.waitFor(/core-sw1#$/)
    await s.run('terminal length 0')
    const bgp = await s.run('sh ip bgp sum')
    expect(bgp).toMatch(/10\.0\.0\.2\s+4\s+65002.*Idle/)
    expect(bgp).toMatch(/10\.0\.0\.6\s+4\s+65000/)
    const br = await s.run('sh ip int br')
    expect(br).toMatch(/GigabitEthernet1\/0\/2\s+10\.0\.0\.1.*administratively down/)
    s.client.end()
  })

  it('finds a MAC address', async () => {
    const s = await connect(ios.port)
    await s.waitFor(/#$/)
    const out = await s.run('show mac address-table address aabb.cc00.0110')
    expect(out).toMatch(/10\s+aabb\.cc00\.0110\s+DYNAMIC\s+Gi1\/0\/5/)
    s.client.end()
  })

  it('pages long output with --More-- and continues on space', async () => {
    const s = await connect(ios.port)
    await s.waitFor(/#$/)
    s.send('show running-config\r')
    await s.waitFor(/--More--/)
    s.send(' ')
    await s.waitFor(/--More--/)
    s.send('q')
    await s.waitFor(/core-sw1#$/)
    s.client.end()
  })

  it('supports pipes, ? help and invalid-input markers', async () => {
    const s = await connect(ios.port)
    await s.waitFor(/#$/)
    await s.run('terminal length 0')
    expect(await s.run('show run | include snmp-server community')).toMatch(/snmp-server community n3tw0rkRO RO/)
    s.send('show ip ?')
    const help = await s.waitFor(/show ip $/)
    expect(help).toMatch(/bgp/)
    expect(help).toMatch(/interface/)
    s.send('\x15') // Ctrl-U clears the line
    expect(await s.run('show frobnicate')).toMatch(/% Invalid input detected at '\^' marker/)
    expect(await s.run('sh i')).toMatch(/% (Ambiguous|Incomplete)/)
    s.client.end()
  })

  it('accepts reload but never reboots', async () => {
    const s = await connect(ios.port)
    await s.waitFor(/#$/)
    s.send('reload\r')
    // Running differs from startup (Gi1/0/2 was shut after the last save), so IOS asks to save first.
    await s.waitFor(/Save\? \[yes\/no\]: $/)
    s.send('no\r')
    await s.waitFor(/\[confirm\]/)
    s.send('\r')
    expect(await s.waitFor(/core-sw1#$/)).toMatch(/simulator never reboots/)
    s.client.end()
  })

  it('config mode: no shutdown brings the interface and BGP back', async () => {
    const s = await connect(ios.port)
    await s.waitFor(/#$/)
    await s.run('configure terminal')
    await s.run('interface Gi1/0/2')
    expect(await s.run('no shutdown')).toMatch(/core-sw1\(config-if\)#$/)
    await s.run('end')
    await s.run('terminal length 0')
    expect(await s.run('show ip interface brief | include 1/0/2')).toMatch(/GigabitEthernet1\/0\/2\s+10\.0\.0\.1\s+YES manual up\s+up/)
    // restore for other tests
    await s.run('conf t')
    await s.run('int gi1/0/2')
    await s.run('shut')
    await s.run('end')
    s.client.end()
  })
})

describe('EOS personality', () => {
  it('renders Arista-style output', async () => {
    const s = await connect(eos.port)
    await s.waitFor(/dist-eos1#$/)
    await s.run('terminal length 0')
    expect(await s.run('show version')).toMatch(/Arista DCS-7050SX3/)
    expect(await s.run('show ip bgp summary')).toMatch(/10\.0\.1\.2\s+4 65100.*Active/)
    s.client.end()
  })
})
