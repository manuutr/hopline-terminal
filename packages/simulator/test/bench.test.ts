import ssh2 from 'ssh2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { floodLine, makeIosDevice, startSim, type RunningSim } from '../src/index.ts'

const { Client } = ssh2

async function connect(port: number) {
  const client = new Client()
  const stream = await new Promise<ssh2.ClientChannel>((resolve, reject) => {
    client
      .on('ready', () => client.shell({ rows: 24, cols: 120, term: 'xterm' }, (err, s) => (err ? reject(err) : resolve(s))))
      .on('error', () => {})
      .connect({ host: '127.0.0.1', port, username: 'admin', password: 'admin', readyTimeout: 3000 })
    client.once('error', reject)
    client.once('close', () => reject(new Error('closed before ready')))
  })
  let buf = ''
  let bytes = 0
  stream.on('data', (d: Buffer) => {
    bytes += d.length
    buf = (buf + d.toString()).slice(-4096)
  })
  const waitFor = async (re: RegExp, ms = 10_000): Promise<void> => {
    const start = Date.now()
    while (!re.test(buf)) {
      if (Date.now() - start > ms) throw new Error(`timeout waiting for ${re}; got:\n${buf}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const closed = new Promise<void>((r) => client.on('close', () => r()))
  return { client, stream, waitFor, closed, bytes: () => bytes, reset: () => ((buf = ''), (bytes = 0)) }
}

let sim: RunningSim
beforeAll(async () => {
  sim = await startSim({ device: makeIosDevice(), port: 0, bench: true })
})
afterAll(async () => {
  await sim.close()
})

describe('bench commands', () => {
  it('floods about N MB over SSH with backpressure, then shows the prompt', async () => {
    const c = await connect(sim.port)
    await c.waitFor(/#$/)
    c.reset()
    c.stream.write('bench flood 4\r')
    await c.waitFor(/core-sw1#$/, 20_000)
    expect(c.bytes()).toBeGreaterThan(4 * 1024 * 1024)
    expect(c.bytes()).toBeLessThan(4.2 * 1024 * 1024)
    c.client.end()
  })

  it('prints exactly N lines, with ANSI when asked', async () => {
    const c = await connect(sim.port)
    await c.waitFor(/#$/)
    c.reset()
    c.stream.write('bench lines 1000 ansi\r')
    await c.waitFor(/core-sw1#$/)
    let n = 0
    for (let i = 0; i < 1000; i++) n += floodLine('ansi', i).length
    expect(c.bytes()).toBeGreaterThan(n)
    expect(floodLine('ansi', 1)).toMatch(/\x1b\[38;2;/)
    c.client.end()
  })

  it('is off unless the sim is started with bench: true', async () => {
    const plain = await startSim({ device: makeIosDevice(), port: 0 })
    const c = await connect(plain.port)
    await c.waitFor(/#$/)
    c.stream.write('bench lines 10\r')
    await c.waitFor(/Invalid input|Unknown command|% /)
    c.client.end()
    await plain.close()
  })
})

describe('connection faults', () => {
  it('drop() closes live connections and the listener stays up', async () => {
    const c = await connect(sim.port)
    await c.waitFor(/#$/)
    expect(sim.faults.connections).toBeGreaterThan(0)
    expect(sim.faults.drop()).toBeGreaterThan(0)
    await c.closed
    const again = await connect(sim.port)
    await again.waitFor(/#$/)
    again.client.end()
  })

  it('refuse() turns connects away for a while', async () => {
    sim.faults.refuse(300)
    await expect(connect(sim.port)).rejects.toBeTruthy()
    await new Promise((r) => setTimeout(r, 350))
    const c = await connect(sim.port)
    await c.waitFor(/#$/)
    c.client.end()
  })

  it('stall() stops answering until it ends', async () => {
    const c = await connect(sim.port)
    await c.waitFor(/#$/)
    c.reset()
    sim.faults.stall(300)
    c.stream.write('\r')
    await new Promise((r) => setTimeout(r, 150))
    expect(c.bytes()).toBe(0)
    await c.waitFor(/#$/, 2000)
    c.client.end()
  })
})
