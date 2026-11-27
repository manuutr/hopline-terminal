/**
 * Raw TCP: bytes in, bytes out, no Telnet processing. For terminal-server ports and other
 * services that aren't really Telnet, where IAC handling would corrupt 0xFF bytes.
 */
import { TcpTransport, type TcpOptions } from './tcp'
import type { TermSize, Transport } from './types'

export type RawTcpTransportOptions = TcpOptions

export class RawTcpTransport extends TcpTransport implements Transport {
  readonly kind = 'raw' as const

  write(data: Buffer | string): void {
    this.send(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
  }

  /** Plain TCP has no way to carry a window size. */
  resize(_size: TermSize): void {}

  protected onConnected(): void {}

  protected onRemoteData(buf: Buffer): void {
    this.emit('data', buf)
  }
}
