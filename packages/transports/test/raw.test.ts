import { Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RawTcpTransport } from '../src/raw'
import { TransportError } from '../src/types'
import { closedPort, testServer, waitFor, type TestServer } from './helpers'

describe('RawTcpTransport', () => {
  let echo: TestServer
  beforeAll(async () => {
    echo = await testServer((sock) => sock.on('data', (d: Buffer) => sock.write(d)))
  })
  afterAll(() => echo.close())

  async function open() {
    const t = new RawTcpTransport({ host: '127.0.0.1', port: echo.port })
    const chunks: Buffer[] = []
    const closes: unknown[][] = []
    t.on('data', (d: Buffer) => chunks.push(d))
    t.on('close', (...a: unknown[]) => closes.push(a))
    await t.connect()
    const peer = await echo.peer()
    return { t, peer, closes, data: () => Buffer.concat(chunks) }
  }

  it('has kind raw', () => {
    expect(new RawTcpTransport({ host: 'x', port: 1 }).kind).toBe('raw')
  })

  it('round-trips bytes untouched: no IAC escaping, no CR translation', async () => {
    const { t, data } = await open()
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    t.write(all)
    t.write('show ver\r')
    await waitFor(() => data().length >= 265, 'echo')
    expect(data()).toEqual(Buffer.concat([all, Buffer.from('show ver\r')]))
    t.end()
  })

  it('treats resize as a no-op and has no sendBreak', async () => {
    const { t, peer } = await open()
    t.resize({ cols: 200, rows: 60 })
    await new Promise((r) => setTimeout(r, 20))
    expect(peer.received().length).toBe(0)
    expect((t as { sendBreak?: unknown }).sendBreak).toBeUndefined()
    t.end()
  })

  it('pauses and resumes reading', async () => {
    const { t, peer, data } = await open()
    t.pause()
    peer.sock.write('held')
    await new Promise((r) => setTimeout(r, 30))
    expect(data().length).toBe(0)
    t.resume()
    await waitFor(() => data().toString() === 'held', 'data after resume')
    t.end()
  })

  it('emits close with no reason after end()', async () => {
    const { t, closes } = await open()
    t.end()
    await waitFor(() => closes.length, 'close')
    expect(closes).toEqual([[]])
  })

  it('emits close with a reason when the peer hangs up', async () => {
    const { peer, closes } = await open()
    peer.sock.destroy()
    await waitFor(() => closes.length, 'close')
    expect(typeof closes[0]![0]).toBe('string')
  })

  it('a clean FIN from the peer is tagged "remote-closed:"', async () => {
    const { peer, closes } = await open()
    peer.sock.end()
    await waitFor(() => closes.length, 'close')
    expect(closes).toEqual([['remote-closed: Connection closed by remote host']])
  })

  it('a connection reset keeps its reason, without the "remote-closed:" prefix', async () => {
    const { peer, closes } = await open()
    peer.sock.resetAndDestroy()
    await waitFor(() => closes.length, 'close')
    expect(closes[0]![0]).toMatch(/ECONNRESET/)
    expect(closes[0]![0]).not.toMatch(/^remote-closed:/)
  })

  it('rejects connect() a second time', async () => {
    const { t } = await open()
    await expect(t.connect()).rejects.toBeInstanceOf(TransportError)
    t.end()
  })

  it('maps a refused connection and a connect timeout', async () => {
    const refused = await new RawTcpTransport({ host: '127.0.0.1', port: await closedPort() }).connect().catch((e: TransportError) => e)
    expect(refused).toMatchObject({ code: 'refused' })
    const timedOut = await new RawTcpTransport({ host: '192.0.2.1', port: 9, connectTimeoutMs: 20, createSocket: () => new Socket() })
      .connect()
      .catch((e: TransportError) => e)
    expect(timedOut).toMatchObject({ code: 'timeout' })
  })
})
