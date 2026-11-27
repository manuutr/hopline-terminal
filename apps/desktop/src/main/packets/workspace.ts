import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { CAPTURE_BYTES, type CaptureSource, type PacketsApi } from '@shared/packets'
import type { CaptureDownload } from '../files/service'
import type { Session } from '@shared/types'
import type { LlmProvider } from '../llm/types'
import { writePrivateFile } from '../private-file'
import type { GuardedRunner } from '../productivity/runner'
import { pageOf, type Trace } from './analysis'
import { askPackets } from './assistant'
import { collectDevice, prepareDevice, type Prepared } from './device'
import { decode } from './decode'

interface Deps {
  choose(): Promise<string | null>
  saveAs(name: string): Promise<string | null>
  download(id: string): CaptureDownload | undefined
  destination(tabId: string, path: string): Promise<boolean>
  receive(tabId: string, path: string, signal: AbortSignal, stage: (s: string) => void): Promise<CaptureDownload | null>
  runner: GuardedRunner
  owns(tabId: string): boolean
  stage(s: string, canFinish?: boolean): void
  provider(): Promise<LlmProvider>
  sessions(): Session[]
}

async function readTrace(path: string) {
  const f = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const st = await f.stat()
    if (!st.isFile() || st.size < 4 || st.size > CAPTURE_BYTES) throw new Error('Choose a regular PCAP or PCAPNG file up to 64 MiB.')
    const bytes = Buffer.alloc(st.size)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await f.read(bytes, offset, bytes.length - offset, offset)
      if (!chunk.bytesRead) throw new Error('The capture changed while it was being read.')
      offset += chunk.bytesRead
    }
    return bytes
  } finally { await f.close() }
}

function assertFormat(bytes: Buffer) {
  const magic = bytes.subarray(0, 4).toString('hex')
  if (!['0a0d0d0a', 'd4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic))
    throw new Error('The file is not an uncompressed PCAP or PCAPNG capture.')
}

/** One active operation and one immutable capture snapshot per window. Failed replacements keep the last good view. */
export class PacketWorkspace {
  private history: { question: string; answer: string }[] = []
  private trace?: Trace
  private plan?: Prepared
  private active?: AbortController
  private finishRecording?: AbortController
  constructor(private readonly d: Deps) {}

  private async task<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Another packet operation is in progress.')
    const ctrl = new AbortController()
    this.active = ctrl
    try { return await fn(ctrl.signal) } finally { this.active = undefined; this.finishRecording = undefined }
  }

  finish() { this.finishRecording?.abort() }
  cancel() { this.active?.abort(new Error('Packet operation cancelled.')) }
  close() { this.cancel(); this.history = []; this.trace = undefined; this.plan = undefined }

  prepare(req: Parameters<PacketsApi['plan']>[0]) {
    return this.task(async (signal) => {
      if (!this.d.owns(req.tabId)) throw new Error('This session is not open in this window.')
      const plan = await prepareDevice(this.d.runner, req)
      signal.throwIfAborted()
      this.plan = plan
      const { id, hostname, commands, remotePath, seconds } = plan
      return { id, hostname, commands, remotePath, seconds }
    })
  }

  open(source: CaptureSource | { kind: 'drop'; path: string }) {
    return this.task(async (signal) => {
      let download: CaptureDownload | undefined
      let path: string | null
      if (source.kind === 'drop') path = source.path
      else if (source.kind === 'file') path = await this.d.choose()
      else if (source.kind === 'download') {
        download = this.d.download(source.transferId)
        path = download?.path ?? null
        if (!path) throw new Error('Choose a completed download in this window.')
      } else {
        let tabId: string
        let remotePath: string
        if (source.kind === 'iosxe') {
          const plan = this.plan
          if (!plan || plan.id !== source.planId || plan.expires < Date.now()) throw new Error('Preview the device capture again.')
          this.plan = undefined
          if (!this.d.owns(plan.tabId)) throw new Error('This session is not open in this window.')
          if (!(await this.d.destination(plan.tabId, plan.remotePath))) return null
          signal.throwIfAborted()
          this.finishRecording = new AbortController()
          await collectDevice(this.d.runner, plan, source.ack, signal, this.finishRecording.signal, () => this.d.owns(plan.tabId), this.d.stage)
          this.finishRecording = undefined
          tabId = plan.tabId
          remotePath = plan.remotePath
        } else {
          tabId = source.tabId
          remotePath = source.path
        }
        if (!this.d.owns(tabId)) throw new Error('This session is not open in this window.')
        this.d.stage('Transferring ' + remotePath)
        try {
          download = await this.d.receive(tabId, remotePath, signal, this.d.stage) ?? undefined
        } catch (e) {
          throw new Error(`Transfer of ${remotePath} failed. ${e instanceof Error ? e.message : String(e)}`)
        }
        path = download?.path ?? null
      }
      if (!path) return null
      signal.throwIfAborted()
      const bytes = await readTrace(path)
      if (download && createHash('sha256').update(bytes).digest('hex') !== download.sha256)
        throw new Error('The downloaded file changed. Transfer the capture again.')
      const name = download?.name ?? basename(path)
      assertFormat(bytes)
      this.d.stage('Decoding frames…')
      const data = await decode(bytes, { filter: '' }, signal)
      signal.throwIfAborted()
      this.history = []
      this.trace = { id: randomUUID(), bytes, name, inspected: data.matched, filter: '', data }
      return pageOf(this.trace, 0)
    })
  }

  private current(id: string) {
    if (this.trace?.id !== id || !this.trace) throw new Error('Reopen this capture in the current window.')
    return this.trace
  }

  view({ id, page, filter }: Parameters<PacketsApi['view']>[0]) {
    return this.task(async (signal) => {
      const trace = this.current(id)
      if (filter !== trace.filter) {
        const data = await decode(trace.bytes, { filter }, signal)
        signal.throwIfAborted()
        trace.filter = filter
        trace.data = data
      }
      return pageOf(trace, page)
    })
  }

  ask({ id, question, page, frame }: Parameters<PacketsApi['ask']>[0]) {
    return this.task(async (signal) => {
      const trace = id ? this.current(id) : undefined
      const provider = await this.d.provider()
      signal.throwIfAborted()
      const answer = await askPackets(provider, this.d.sessions(), question, trace, page ?? 0, frame, signal, trace ? this.history : [])
      signal.throwIfAborted()
      if (trace) this.history = [...this.history, { question, answer: answer.slice(0, 4000) }].slice(-6)
      return answer
    })
  }

  details({ id, frame }: Parameters<PacketsApi['details']>[0]) {
    return this.task((signal) => decode(this.current(id).bytes, { frame }, signal))
  }

  save(id: string) {
    return this.task(async (signal) => {
      const trace = this.current(id)
      const path = await this.d.saveAs(trace.name)
      if (!path) return false
      signal.throwIfAborted()
      await writePrivateFile(path, trace.bytes)
      return true
    })
  }
}
