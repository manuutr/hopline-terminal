import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { hostEnv } from '../host/client'
import type { Trace } from './analysis'

export type DecodeRequest = { filter: string } | { frame: number }
export type DecodeResult = { result: Trace['data'] | string } | { error: string }

export function decode(bytes: Buffer, request: { filter: string }, signal: AbortSignal): Promise<Trace['data']>
export function decode(bytes: Buffer, request: { frame: number }, signal: AbortSignal): Promise<string>
export function decode(bytes: Buffer, request: DecodeRequest, signal: AbortSignal): Promise<Trace['data'] | string> {
  signal.throwIfAborted()
  const child = utilityProcess.fork(join(__dirname, 'packet-decoder.js'), [], { serviceName: 'Hopline Terminal Packet Decoder', stdio: 'ignore', env: hostEnv() })
  return new Promise<Trace['data'] | string>((resolve, reject) => {
    const abort = () => reject(new Error('Packet operation cancelled.'))
    const timeout = setTimeout(() => reject(new Error('Packet analysis timed out. Try a smaller capture.')), 120_000)
    signal.addEventListener('abort', abort, { once: true })
    child.once('exit', () => reject(new Error('The packet decoder exited before analysis completed.')))
    child.once('error', () => reject(new Error('The packet decoder could not start.')))
    child.once('message', (reply: DecodeResult) => {
      if ('error' in reply) reject(new Error(reply.error))
      else resolve(reply.result)
    })
    child.postMessage({ bytes, request })
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
    child.once('exit', cleanup)
  }).finally(() => child.kill())
}
