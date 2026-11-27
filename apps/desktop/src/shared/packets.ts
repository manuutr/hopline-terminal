export const CAPTURE_BYTES = 64 * 1024 * 1024
export const PAGE_SIZE = 100

export interface PacketRow {
  frame: number
  seconds: string
  source: string
  destination: string
  protocol: string
  length: number
  detail: string
  layers: string
  headers: { name: string; value: string }[]
  signals: string[]
}

export interface SignalCount {
  label: string
  filter: string
  count: number
  firstFrame: number
}

export interface PacketConversation {
  filter: string
  endpoints: string
  frames: number
  bytes: number
  firstFrame: number
}

export interface PacketView {
  id: string
  name: string
  bytes: number
  inspected: number
  matched: number
  filter: string
  page: number
  protocols: { name: string; count: number }[]
  signals: SignalCount[]
  conversations: PacketConversation[]
  conversationsLimited: boolean
  rows: PacketRow[]
}

export interface DeviceCaptureOptions {
  tabId: string
  device: string
  seconds: number
  direction: 'in' | 'out' | 'both'
  match?: { side: 'source' | 'destination'; address: string }
}

export const isCaptureName = (name: string) => /\.(?:pcapng|pcap|cap)$/i.test(name)

export interface DeviceCapturePlan {
  id: string
  hostname: string
  commands: string[]
  remotePath: string
  seconds: number
}

export type CaptureSource =
  | { kind: 'file' }
  | { kind: 'download'; transferId: string }
  | { kind: 'remote'; tabId: string; path: string }
  | { kind: 'iosxe'; planId: string; ack: string }

export interface PacketsApi {
  openDropped(file: File): Promise<PacketView | null>
  plan(req: DeviceCaptureOptions): Promise<DeviceCapturePlan>
  open(source: CaptureSource): Promise<PacketView | null>
  view(req: { id: string; filter: string; page: number }): Promise<PacketView>
  details(req: { id: string; frame: number }): Promise<string>
  ask(req: { id?: string; page?: number; frame?: number; question: string }): Promise<string>
  save(id: string): Promise<boolean>
  finish(): Promise<void>
  cancel(): Promise<void>
  close(): Promise<void>
  onStage(cb: (stage: string, canFinish: boolean) => void): () => void
}
