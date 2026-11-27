/**
 * Shared TCP plumbing for the Telnet and raw transports: connect with a timeout, error mapping,
 * flow control, and the close-exactly-once lifecycle from the Transport contract.
 */
import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { TransportError, type TermSize, type TransportErrorCode, type TransportKind } from './types'

export interface TcpOptions {
  host: string
  port: number
  /** Default 10 s. */
  connectTimeoutMs?: number
  /** Override socket creation (tests). Must start connecting to host:port. */
  createSocket?: (host: string, port: number) => Socket
}

const codes: Record<string, TransportErrorCode> = {
  ECONNREFUSED: 'refused',
  EADDRINUSE: 'refused',
  ETIMEDOUT: 'timeout',
  ENOTFOUND: 'unreachable',
  EAI_AGAIN: 'unreachable',
  EAI_FAIL: 'unreachable',
  EAI_NONAME: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  EHOSTDOWN: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENETDOWN: 'unreachable'
}

export function mapSocketError(err: unknown, where = ''): TransportError {
  if (err instanceof TransportError) return err
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  const message = err instanceof Error ? err.message : String(err)
  return new TransportError(codes[code ?? ''] ?? 'other', where ? `${where}: ${message}` : message, err)
}

/** Close reason for a clean FIN from the remote (see the convention in types.ts). */
export const REMOTE_CLOSED_REASON = 'remote-closed: Connection closed by remote host'

/** How long end() waits for the peer to close before destroying the socket. */
const END_GRACE_MS = 2000

export abstract class TcpTransport extends EventEmitter {
  abstract readonly kind: TransportKind
  protected socket: Socket | undefined
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  private userEnded = false
  private failure: string | undefined
  private cancelConnect: (() => void) | undefined

  constructor(protected readonly tcp: TcpOptions) {
    super()
  }

  connect(): Promise<void> {
    if (this.state !== 'idle') return Promise.reject(new TransportError('other', 'connect() may only be called once'))
    this.state = 'connecting'
    const { host, port, connectTimeoutMs = 10_000 } = this.tcp
    const where = `${host}:${port}`
    let socket: Socket
    try {
      socket = (this.tcp.createSocket ?? ((h, p) => createConnection({ host: h, port: p })))(host, port)
    } catch (e) {
      // e.g. ERR_SOCKET_BAD_PORT is thrown synchronously; the contract says connect() rejects.
      this.state = 'closed'
      return Promise.reject(mapSocketError(e, where))
    }
    this.socket = socket

    return new Promise<void>((resolve, reject) => {
      const fail = (e: TransportError): void => {
        cleanup()
        this.state = 'closed'
        // A destroyed socket can still report a late error; without a listener that would throw.
        socket.on('error', () => {})
        socket.destroy()
        reject(e)
      }
      const onError = (e: Error): void => fail(mapSocketError(e, where))
      const onConnect = (): void => {
        cleanup()
        this.state = 'open'
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 30_000)
        socket.on('data', (buf: Buffer) => this.onRemoteData(buf))
        socket.on('error', (e) => (this.failure ??= mapSocketError(e).message))
        socket.on('close', () => this.finish())
        this.emit('stage', 'TCP open')
        this.onConnected()
        resolve()
      }
      const timer = setTimeout(() => fail(new TransportError('timeout', `${where}: connection timed out after ${connectTimeoutMs} ms`)), connectTimeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.off('error', onError)
        socket.off('connect', onConnect)
        this.cancelConnect = undefined
      }
      this.cancelConnect = () => fail(new TransportError('cancelled', `${where}: connect cancelled`))
      socket.once('error', onError)
      socket.once('connect', onConnect)
    })
  }

  abstract write(data: Buffer | string): void
  abstract resize(size: TermSize): void

  pause(): void {
    if (this.state === 'open') this.socket?.pause()
  }

  resume(): void {
    if (this.state === 'open') this.socket?.resume()
  }

  end(): void {
    if (this.state === 'connecting') return this.cancelConnect?.()
    if (this.state !== 'open' || this.userEnded) return
    this.userEnded = true
    const socket = this.socket!
    socket.end()
    setTimeout(() => socket.destroy(), END_GRACE_MS).unref()
  }

  protected get isOpen(): boolean {
    return this.state === 'open' && !this.userEnded
  }

  protected send(buf: Buffer): void {
    if (this.isOpen && buf.length) this.socket!.write(buf)
  }

  protected notice(text: string): void {
    this.emit('notice', text)
  }

  /** Called once the socket is connected, before connect() resolves. */
  protected abstract onConnected(): void
  protected abstract onRemoteData(buf: Buffer): void

  private finish(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.userEnded) this.emit('close')
    // A clean FIN is ambiguous (logout or a device dropping us), so tag it for the host.
    else this.emit('close', this.failure ?? REMOTE_CLOSED_REASON)
  }
}
