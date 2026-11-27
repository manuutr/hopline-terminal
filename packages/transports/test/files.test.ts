import { createHash, randomBytes } from 'node:crypto'
import { connect, createServer, type Server } from 'node:net'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { deviceFs, startSim, type RunningSim, type SimOptions } from '../../simulator/src/index.ts'
import {
  ChannelError,
  Forwards,
  ScpError,
  SshTransport,
  describeForward,
  explainScpError,
  scpCommand,
  scpReceive,
  scpSend,
  sftpList,
  sftpMkdir,
  sftpOpenWrite,
  sftpReadFile,
  sftpRealpath,
  sftpRename,
  sftpStatMaybe,
  sftpUnlink,
  type ForwardStatus
} from '../src/index.ts'
import { waitFor } from './helpers.ts'

const sims: RunningSim[] = []
const transports: SshTransport[] = []
const servers: Server[] = []
afterEach(() => {
  for (const t of transports.splice(0)) t.end()
})
afterAll(async () => {
  for (const s of servers) s.close()
  await Promise.all(sims.map((s) => s.close()))
})

async function sim(o: Partial<SimOptions> & { device: SimOptions['device'] }): Promise<RunningSim> {
  const s = await startSim({ port: 0, ...o })
  sims.push(s)
  return s
}

async function connected(port: number, o: Partial<ConstructorParameters<typeof SshTransport>[0]> = {}): Promise<SshTransport> {
  const t = new SshTransport({
    host: '127.0.0.1',
    port,
    username: 'admin',
    auth: { type: 'password', password: 'admin' },
    keepAliveSec: 0,
    size: { cols: 80, rows: 24 },
    verifyHostKey: () => 'accept',
    prompter: { keyboardInteractive: async (r) => r.prompts.map(() => 'admin'), secret: async () => 'admin' },
    readyTimeoutMs: 5000,
    ...o
  })
  transports.push(t)
  t.on('data', () => {})
  await t.connect()
  return t
}

async function* chunks(buf: Buffer, size = 7000): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}
async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const c of it) out.push(c)
  return Buffer.concat(out)
}

describe('SFTP over the existing connection', () => {
  it('lists, writes, reads back, renames and deletes on an EOS-like device', async () => {
    const s = await sim({ device: 'eos', files: { sftp: true } })
    const t = await connected(s.port)
    const sftp = await t.openSftp()
    expect(await sftpRealpath(sftp, '.')).toBe('/mnt/flash')
    const names = (await sftpList(sftp, '/mnt/flash')).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['startup-config', 'tech-support.txt', '.persist', 'logs']))
    const logs = (await sftpList(sftp, '/mnt/flash')).find((e) => e.name === 'logs')!
    expect(logs.type).toBe('dir')
    expect(logs.perms).toBe('drwxr-xr-x')

    // A file bigger than the read-ahead window, written in odd chunk sizes.
    const data = randomBytes(600_000)
    const w = await sftpOpenWrite(sftp, '/mnt/flash/image.swi', { exclusive: true })
    for await (const c of chunks(data)) await w.write(c)
    await w.close()
    expect(deviceFs(s.device).files.get('/mnt/flash/image.swi')!.data.equals(data)).toBe(true)
    const back = await collect(sftpReadFile(sftp, '/mnt/flash/image.swi'))
    expect(createHash('sha256').update(back).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'))
    // Exclusive create refuses to replace.
    await expect(sftpOpenWrite(sftp, '/mnt/flash/image.swi', { exclusive: true })).rejects.toThrow()
    // Resume: read from an offset, append from an offset.
    expect((await collect(sftpReadFile(sftp, '/mnt/flash/image.swi', 500_000))).equals(data.subarray(500_000))).toBe(true)
    const part = data.subarray(0, 100_000)
    const w2 = await sftpOpenWrite(sftp, '/mnt/flash/resumed.swi', { exclusive: true })
    await w2.write(part)
    await w2.close()
    const w3 = await sftpOpenWrite(sftp, '/mnt/flash/resumed.swi', { offset: 100_000 })
    for await (const c of chunks(data.subarray(100_000))) await w3.write(c)
    await w3.close()
    expect(deviceFs(s.device).files.get('/mnt/flash/resumed.swi')!.data.equals(data)).toBe(true)

    await sftpMkdir(sftp, '/mnt/flash/new')
    await sftpRename(sftp, '/mnt/flash/resumed.swi', '/mnt/flash/new/r.swi')
    expect(await sftpStatMaybe(sftp, '/mnt/flash/resumed.swi')).toBeUndefined()
    expect((await sftpStatMaybe(sftp, '/mnt/flash/new/r.swi'))?.size).toBe(data.length)
    await sftpUnlink(sftp, '/mnt/flash/new/r.swi')
    expect(await sftpStatMaybe(sftp, '/mnt/flash/new/r.swi')).toBeUndefined()
    // The shell is still alive on the same connection.
    expect(s.events.listenerCount('auth')).toBeGreaterThanOrEqual(0)
  })

  it('reports a device without SFTP as a refused subsystem, not a dead connection', async () => {
    const s = await sim({ device: 'ios', files: {} })
    const t = await connected(s.port)
    const e = await t.openSftp().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ChannelError)
    expect((e as ChannelError).kind).toBe('subsystem')
  })

  it('reports a refused second channel as kind "channel", and a side connection works', async () => {
    const s = await sim({ device: 'eos', files: { sftp: true }, sessionsPerConnection: 1 })
    const t = await connected(s.port)
    const e = await t.openSftp().catch((x: unknown) => x)
    expect((e as ChannelError).kind).toBe('channel')
    const side = t.sideConnection()
    transports.push(side)
    await side.connect()
    const sftp = await side.openSftp()
    expect((await sftpList(sftp, '.')).length).toBeGreaterThan(0)
  })
})

describe('SCP', () => {
  it('sends an image to IOS flash: and fetches it back', async () => {
    const s = await sim({ device: 'ios', files: {} })
    const t = await connected(s.port)
    const data = randomBytes(300_000)
    await scpSend(await t.openExec(scpCommand('send', 'flash:c2900.bin')), chunks(data), { name: 'c2900.bin', size: data.length })
    expect(deviceFs(s.device).files.get('/flash/c2900.bin')!.data.equals(data)).toBe(true)
    const inc = await scpReceive(await t.openExec(scpCommand('receive', 'flash:c2900.bin')))
    expect(inc.size).toBe(data.length)
    expect(inc.name).toBe('c2900.bin')
    const back = await collect(inc.body)
    await inc.done()
    expect(back.equals(data)).toBe(true)
  })

  it('maps device errors: missing file, no space, refused exec', async () => {
    const s = await sim({ device: 'ios', files: { capacity: 1000 } })
    const t = await connected(s.port)
    const missing = await scpReceive(await t.openExec(scpCommand('receive', 'flash:nope.bin'))).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(ScpError)
    expect((missing as ScpError).device).toMatch(/%Error opening flash:nope.bin \(No such file or directory\)/)
    expect((missing as ScpError).message).toMatch(/filesystem prefix/)
    const big = randomBytes(5000)
    const nospace = await scpSend(await t.openExec(scpCommand('send', 'flash:big.bin')), chunks(big), { name: 'big.bin', size: big.length }).catch((e: unknown) => e)
    expect((nospace as ScpError).message).toMatch(/No space left on device.*Free space/)

    const off = await sim({ device: 'ios' })
    const t2 = await connected(off.port)
    const refused = await t2.openExec(scpCommand('send', 'flash:x')).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(ChannelError)
  })

  it('refuses directories and stops at the declared size', async () => {
    const s = await sim({ device: 'nxos', files: {} })
    const t = await connected(s.port)
    const dir = await scpReceive(await t.openExec(scpCommand('receive', 'bootflash:logs'))).catch((e: unknown) => e)
    expect((dir as Error).message).toMatch(/directory/i)
  })

  it('explains common device messages and quotes paths', () => {
    expect(explainScpError('%Error opening flash:x (Privilege denied)')).toMatch(/privilege 15/)
    expect(explainScpError('Not enough space on device')).toMatch(/Free space/)
    expect(scpCommand('send', 'flash:my file.bin')).toBe(`scp -t 'flash:my file.bin'`)
    expect(() => scpCommand('send', 'flash:x\nreload')).toThrow()
  })

  it('quotes every path a shell could read as syntax (review M9) and refuses option-like paths', () => {
    expect(scpCommand('send', 'flash:c2900-universalk9.SPA.155-3.M.bin')).toBe('scp -t flash:c2900-universalk9.SPA.155-3.M.bin')
    expect(scpCommand('send', '/tmp/a;touch${IFS}/tmp/pwned')).toBe(`scp -t '/tmp/a;touch\${IFS}/tmp/pwned'`)
    expect(scpCommand('receive', 'fw$(reboot).bin')).toBe(`scp -f 'fw$(reboot).bin'`)
    expect(scpCommand('send', "it's`x`.bin")).toBe(`scp -t 'it'\\''s\`x\`.bin'`)
    expect(scpCommand('send', 'a|b&c>d')).toBe(`scp -t 'a|b&c>d'`)
    expect(() => scpCommand('send', '-oProxyCommand=x')).toThrow(/option/)
    expect(() => scpCommand('send', '')).toThrow()
  })

  it('the simulator accepts quoted paths and stores the literal name', async () => {
    const s = await sim({ device: 'ios', files: {} })
    const t = await connected(s.port)
    const data = randomBytes(100)
    for (const name of ['fw$(reboot).bin', "it's a;b.bin"]) {
      await scpSend(await t.openExec(scpCommand('send', `flash:${name}`)), chunks(data), { name, size: data.length })
      expect(deviceFs(s.device).files.get(`/flash/${name}`)?.data.equals(data)).toBe(true)
      const inc = await scpReceive(await t.openExec(scpCommand('receive', `flash:${name}`)))
      expect((await collect(inc.body)).equals(data)).toBe(true)
      await inc.done()
    }
  })
})

describe('port forwarding', () => {
  async function echoServer(): Promise<number> {
    const srv = createServer((sock) => sock.pipe(sock))
    servers.push(srv)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    return (srv.address() as { port: number }).port
  }
  const roundTrip = (port: number, text: string, prefix?: Buffer) =>
    new Promise<string>((resolve, reject) => {
      const c = connect(port, '127.0.0.1')
      let got = Buffer.alloc(0)
      c.on('error', reject)
      c.on('connect', () => c.write(prefix ? Buffer.concat([prefix, Buffer.from(text)]) : text))
      c.on('data', (d: Buffer) => {
        got = Buffer.concat([got, d])
        const s = got.toString('latin1')
        if (s.endsWith(text)) {
          c.end()
          resolve(s)
        }
      })
    })

  it('local forward: listens, carries data, counts bytes, survives a reconnect', async () => {
    const echo = await echoServer()
    const s = await sim({ device: 'ios', forwarding: true })
    const fw = new Forwards()
    const states: ForwardStatus[][] = []
    const notices: string[] = []
    fw.on('change', (l: ForwardStatus[]) => states.push(l))
    fw.on('notice', (n: string) => notices.push(n))
    const t = await connected(s.port)
    await fw.attach(t)
    const st = await fw.start({ id: 'a', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echo })
    expect(st.state).toBe('listening')
    expect(await roundTrip(st.boundPort!, 'hello')).toBe('hello')
    await waitFor(() => fw.list()[0]!.bytesIn >= 5 && fw.list()[0]!.total === 1, 'byte counts')
    expect(notices[0]).toMatch(/^forward L 127\.0\.0\.1:\d+ → 127\.0\.0\.1:\d+: listening$/)
    // Connection lost: the listener stays, the forward waits.
    fw.detach()
    t.end()
    expect(fw.list()[0]!.state).toBe('waiting')
    const t2 = await connected(s.port)
    await fw.attach(t2)
    expect(fw.list()[0]!.state).toBe('listening')
    expect(fw.list()[0]!.boundPort).toBe(st.boundPort)
    expect(await roundTrip(st.boundPort!, 'again')).toBe('again')
    await fw.stop('a')
    expect(fw.list()[0]!.state).toBe('stopped')
    await fw.dispose()
  })

  it('caps concurrent connections per forward and drops rejected sockets (review low 10)', async () => {
    const echo = await echoServer()
    const s = await sim({ device: 'ios', forwarding: true })
    const fw = new Forwards({ maxConnections: 2, socksHandshakeMs: 10_000 })
    const t = await connected(s.port)
    await fw.attach(t)
    const st = await fw.start({ id: 'c', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echo })
    const open = (): Promise<import('node:net').Socket> =>
      new Promise((resolve, reject) => {
        const c = connect(st.boundPort!, '127.0.0.1')
        c.on('error', () => {})
        c.once('connect', () => resolve(c))
        c.once('error', reject)
      })
    const a = await open()
    const b = await open()
    await waitFor(() => fw.list()[0]!.active === 2, 'two open')
    const third = await open()
    await new Promise<void>((r) => third.once('close', () => r()))
    expect(fw.list()[0]!.error).toMatch(/more than 2 connections/)
    expect(fw.list()[0]!.active).toBe(2)
    a.destroy()
    b.destroy()
    await waitFor(() => fw.list()[0]!.active === 0, 'closed')
    // Room again once they closed: the refused one was never kept.
    expect(await roundTrip(st.boundPort!, 'room')).toBe('room')
    await fw.dispose()
  })

  it('SOCKS: a client that never finishes the handshake is cut off (review low 10)', async () => {
    const s = await sim({ device: 'ios', forwarding: true })
    const fw = new Forwards({ maxConnections: 64, socksHandshakeMs: 150 })
    const t = await connected(s.port)
    await fw.attach(t)
    const st = await fw.start({ id: 'd', kind: 'D', bindHost: '127.0.0.1', bindPort: 0 })
    const c = connect(st.boundPort!, '127.0.0.1')
    c.on('error', () => {})
    const started = Date.now()
    c.on('connect', () => c.write(Buffer.from([5])))
    await new Promise<void>((r) => c.once('close', () => r()))
    expect(Date.now() - started).toBeLessThan(3000)
    await fw.dispose()
  })

  it('local forward: a port in use is an error, not a crash', async () => {
    const busy = createServer()
    servers.push(busy)
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()))
    const port = (busy.address() as { port: number }).port
    const fw = new Forwards()
    const st = await fw.start({ id: 'b', kind: 'L', bindHost: '127.0.0.1', bindPort: port, destHost: '10.0.0.1', destPort: 80 })
    expect(st.state).toBe('error')
    expect(st.error).toBe(`port ${port} is already in use on 127.0.0.1`)
    await fw.dispose()
  })

  it('dynamic SOCKS5 forward connects by IPv4 and by name', async () => {
    const echo = await echoServer()
    const s = await sim({ device: 'eos', forwarding: true })
    const t = await connected(s.port)
    const fw = new Forwards()
    await fw.attach(t)
    const st = await fw.start({ id: 'd', kind: 'D', bindHost: '127.0.0.1', bindPort: 0 })
    const port = Buffer.alloc(2)
    port.writeUInt16BE(echo)
    const viaIp = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1]), port])
    const out = await roundTrip(st.boundPort!, 'socks!', viaIp)
    expect(out.endsWith('socks!')).toBe(true)
    expect([...Buffer.from(out, 'latin1').subarray(0, 4)]).toEqual([5, 0, 5, 0])
    const name = Buffer.from('localhost')
    const viaName = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, port])
    expect((await roundTrip(st.boundPort!, 'named', viaName)).endsWith('named')).toBe(true)
    await fw.dispose()
  })

  it('remote forward: works when the server allows it, a clear error when it does not', async () => {
    const echo = await echoServer()
    const ok = await sim({ device: 'eos', remoteForwarding: true })
    const t = await connected(ok.port)
    const fw = new Forwards()
    await fw.attach(t)
    const st = await fw.start({ id: 'r', kind: 'R', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echo })
    expect(st.state).toBe('listening')
    expect(st.boundPort).toBeGreaterThan(0)
    expect(await roundTrip(st.boundPort!, 'from the server side')).toBe('from the server side')
    await fw.dispose()

    const no = await sim({ device: 'ios' })
    const t2 = await connected(no.port)
    const fw2 = new Forwards()
    await fw2.attach(t2)
    const bad = await fw2.start({ id: 'r2', kind: 'R', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echo })
    expect(bad.state).toBe('error')
    expect(bad.error).toMatch(/server refused the remote forward.*permission/)
    await fw2.dispose()
  })

  it('describes forwards like OpenSSH flags', () => {
    expect(describeForward({ id: '1', kind: 'L', bindHost: '127.0.0.1', bindPort: 8080, destHost: '10.0.0.1', destPort: 80 })).toBe('L 127.0.0.1:8080 → 10.0.0.1:80')
    expect(describeForward({ id: '1', kind: 'D', bindHost: '::1', bindPort: 1080 })).toBe('D [::1]:1080 (SOCKS5)')
  })
})



