import { createServer, type Server, type Socket } from 'node:net'

/** Poll until `check` returns a truthy value; fail with `what` after `ms`. */
export async function waitFor<T>(check: () => T | undefined | false, what: string, ms = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

export interface TestPeer {
  sock: Socket
  /** Everything received from the client so far. */
  received: () => Buffer
  clear: () => void
}

export interface TestServer {
  port: number
  /** Resolves with the next (or already accepted) connection. */
  peer: () => Promise<TestPeer>
  close: () => Promise<void>
}

/** A TCP server whose connections the test drives by hand. */
export function testServer(onConnect?: (sock: Socket) => void): Promise<TestServer> {
  const peers: TestPeer[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    let buf = Buffer.alloc(0)
    sock.on('data', (d: Buffer) => (buf = Buffer.concat([buf, d])))
    peers.push({ sock, received: () => buf, clear: () => (buf = Buffer.alloc(0)) })
    onConnect?.(sock)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        peer: () => waitFor(() => peers.shift(), 'a client connection'),
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          })
      })
    })
  })
}

/** A port on 127.0.0.1 that was just free, so connecting to it is refused. */
export async function closedPort(): Promise<number> {
  const s = await testServer()
  await s.close()
  return s.port
}
