import type { ScpDirectoryEntry } from './scp-directory'
/**
 * File transfer (SFTP/SCP) and port forwarding: types shared by main, the session host, the
 * preload and the renderer, plus small pure helpers (device filesystems, verify commands).
 *
 * The renderer only ever names *remote* paths. Local paths are chosen in main (native dialogs,
 * or files the user dropped, resolved by the preload) and never come back to the renderer
 * except as a display name.
 */

// ------------------------------------------------------------------ remote files

export interface RemoteEntry {
  name: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  /** Seconds since the epoch (0 when the server doesn't say). */
  mtime: number
  /** Permission bits, e.g. 0o755. */
  mode: number
  /** `drwxr-xr-x` */
  perms: string
  uid?: number
  gid?: number
}

/**
 * How files move for a tab:
 * - `sftp`: browsable (list, mkdir, rename, delete), resumable transfers.
 * - `scp`: the device has no SFTP: copy one file to or from a path you type (device filesystems
 *   such as `flash:` can't be listed over SCP).
 * - `none`: not an SSH session, or not connected.
 */
export type FilesMode = 'sftp' | 'scp' | 'none'

export interface FilesInfo {
  mode: FilesMode
  /** Where browsing starts (SFTP realpath('.')), or the platform's default filesystem (SCP). */
  home: string
  /** Why SFTP isn't available, in words. */
  reason?: string
  /** The device refused another channel on the terminal's connection, so files use a second login. */
  side?: boolean
  /** Filesystem prefixes worth offering for path entry on this platform (`flash:`, `bootflash:`). */
  roots: string[]
}

export const FILE_PREVIEW_LIMIT = 256 * 1024

export type FilePreview =
  | { kind: 'text'; bytes: number; text: string; redactions: number }
  | { kind: 'large' | 'binary'; bytes: number }

export type FilesOp =
  | { op: 'list'; path: string }
  | { op: 'stat'; path: string }
  | { op: 'mkdir'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'remove'; path: string; dir: boolean }

// ------------------------------------------------------------------ transfers

export type Direction = 'upload' | 'download'
export type OverwritePolicy = 'ask' | 'skip' | 'overwrite' | 'rename'
export type TransferState = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'skipped'

/** One transfer as the renderer sees it (no local path: only the file name). */
export interface TransferItem {
  id: string
  tabId: string
  sessionName: string
  direction: Direction
  protocol: 'sftp' | 'scp'
  remotePath: string
  /** The local file's name (never its folder). */
  localName: string
  /** Total bytes (0 until known for SCP downloads). */
  size: number
  done: number
  /** Bytes per second, smoothed. */
  speed: number
  state: TransferState
  error?: string
  startedAt?: number
  finishedAt?: number
  /** Bytes that were already there when this attempt resumed. */
  resumedFrom?: number
  md5?: string
  sha256?: string
  /** A device command that verifies the upload (shown, never run): `verify /md5 flash:x`. */
  verify?: string
  /** The completed download can be dragged out to the OS. */
  draggable?: boolean
}

/** A name that already exists where the file would go: the user picks what to do. */
export interface TransferConflict {
  token: string
  direction: Direction
  name: string
  /** What is already there (undefined when it can't be checked: SCP uploads). */
  existing?: { size: number; mtime: number }
  incoming: { size: number }
  /** The existing file is a shorter copy we could continue (SFTP only). */
  canResume: boolean
}

export type ConflictChoice = 'overwrite' | 'rename' | 'skip' | 'resume'

export interface QueueResult {
  queued: number
  conflicts: TransferConflict[]
  /** Things refused outright (a dropped folder, a symlink, a path that isn't a file). */
  skipped: { name: string; reason: string }[]
}

export type TransferEvent = { kind: 'item'; item: TransferItem } | { kind: 'removed'; id: string }

// ------------------------------------------------------------------ forwards

export type ForwardKind = 'L' | 'R' | 'D'

/** A forward as saved on a session (SessionDialog) or added live from the tab menu. */
export interface ForwardSpec {
  id: string
  kind: ForwardKind
  bindHost: string
  bindPort: number
  destHost?: string
  destPort?: number
  /** Saved forwards: start when the session connects (default true). */
  autoStart?: boolean
  /** Free text shown in the manager ("Grafana", "jump to mgmt"). */
  label?: string
}

export type ForwardState = 'starting' | 'listening' | 'waiting' | 'error' | 'stopped'

export interface ForwardStatus {
  spec: ForwardSpec
  state: ForwardState
  boundPort?: number
  active: number
  total: number
  bytesIn: number
  bytesOut: number
  error?: string
  /** Saved on the session (vs added live for this tab only). */
  saved?: boolean
}

export interface ForwardEvent {
  tabId: string
  forwards: ForwardStatus[]
}

/**
 * Bind-address checks (pure; shared with the session host's `Forwards`). `isLoopbackBind` is true
 * only for a loopback literal or `localhost`; anything else exposes the listener to the network
 * (`isExposedBind`). `isAnyAddressBind` is "every interface" in any spelling (`0`, `0x0`, `::0`…).
 */
import { isLoopbackBind as isLoopbackBindFn } from '@hopline/transports/src/bind'
export { isAnyAddressBind, isExposedBind, isLoopbackBind } from '@hopline/transports/src/bind'

/**
 * A saved forward the session host starts by itself on connect: auto-start on, and a loopback bind
 * (any other bind exposes a port to the network, so it is started by hand). The one predicate for
 * the session host (`HostTab.savedForwards`) and main (`ForwardService.restore`), so they never
 * disagree about which forwards come back on their own (Phase 4 fix-round review F3).
 */
export const startsOnConnect = (f: Pick<ForwardSpec, 'autoStart' | 'bindHost'>): boolean => f.autoStart !== false && isLoopbackBindFn(f.bindHost)

export function describeForward(s: Pick<ForwardSpec, 'kind' | 'bindHost' | 'bindPort' | 'destHost' | 'destPort'>, boundPort?: number): string {
  const bind = `${s.bindHost.includes(':') ? `[${s.bindHost}]` : s.bindHost}:${boundPort ?? s.bindPort}`
  if (s.kind === 'D') return `D ${bind} (SOCKS5)`
  return s.kind === 'L' ? `L ${bind} → ${s.destHost}:${s.destPort}` : `R ${bind} (server) → ${s.destHost}:${s.destPort}`
}

// ------------------------------------------------------------------ preload / renderer API

export interface TransferApi {
  /** Start (or reuse) the file channel for a tab: SFTP if the device has it, else SCP mode. */
  open(tabId: string): Promise<FilesInfo>
  listScpDirectory(tabId: string, path: string): Promise<ScpDirectoryEntry[]>
  preview(tabId: string, path: string): Promise<FilePreview>
  op(tabId: string, op: FilesOp): Promise<RemoteEntry[] | RemoteEntry | null>
  /** Pick local files with the OS dialog and upload them into `remoteDir` (or to `remotePath` for one SCP file). */
  pickUpload(req: { tabId: string; remoteDir?: string; remotePath?: string; policy: OverwritePolicy }): Promise<QueueResult | null>
  /** Upload files the user dropped (File objects; the preload resolves their paths, the page never sees them). */
  uploadDropped(req: { tabId: string; remoteDir: string; policy: OverwritePolicy }, files: File[]): Promise<QueueResult>
  /** Download remote files into the download folder (asked for the first time). */
  download(req: { tabId: string; items: { path: string; size?: number }[]; policy: OverwritePolicy }): Promise<QueueResult | null>
  /** The current download folder's display name, or null when none is chosen yet. */
  downloadDir(): Promise<string | null>
  /** Pick another download folder. */
  chooseDownloadDir(): Promise<string | null>
  resolve(token: string, choice: ConflictChoice): Promise<QueueResult>
  cancel(id: string): Promise<void>
  retry(id: string): Promise<void>
  /** Drop finished items from the queue. */
  clear(): Promise<void>
  list(): Promise<TransferItem[]>
  /** Start an OS drag of a completed download (the renderer calls this from dragstart). */
  dragOut(id: string): void
  /** Show a completed download in the OS file manager. */
  reveal(id: string): Promise<void>
  onEvent(cb: (e: TransferEvent) => void): () => void
}

export interface ForwardApi {
  list(tabId: string): Promise<ForwardStatus[]>
  /** Add a live forward to this tab (not saved on the session). */
  add(tabId: string, spec: Omit<ForwardSpec, 'id'>): Promise<ForwardStatus>
  start(tabId: string, id: string): Promise<ForwardStatus>
  stop(tabId: string, id: string): Promise<void>
  /** Remove a live forward (saved ones are removed in the session dialog). */
  remove(tabId: string, id: string): Promise<void>
  onEvent(cb: (e: ForwardEvent) => void): () => void
}

// ------------------------------------------------------------------ device filesystems

/** Filesystem prefixes per platform, most common first. Data only; unverified ones are marked in BACKLOG. */
export const DEVICE_ROOTS: Record<string, string[]> = {
  ios: ['flash:', 'nvram:', 'usbflash0:'],
  iosxe: ['bootflash:', 'flash:', 'usbflash0:'],
  c9800: ['bootflash:', 'flash:'],
  nxos: ['bootflash:', 'volatile:', 'usb1:'],
  iosxr: ['harddisk:', 'disk0:'],
  asa: ['disk0:', 'flash:'],
  ftd: ['disk0:'],
  eos: ['/mnt/flash/', 'flash:'],
  junos: ['/var/tmp/', '/var/home/'],
  aoscx: ['/'],
  ciscosb: ['flash://']
}

export const rootsFor = (platform: string): string[] => DEVICE_ROOTS[platform] ?? []

/**
 * The device command that checks an uploaded file's MD5, for the user to run (Hopline never runs
 * it). EOS maps `/mnt/flash/x` to `flash:x`. Unknown platforms get nothing.
 */
export function verifyCommand(platform: string, remotePath: string, md5: string): string | undefined {
  const p = remotePath
  switch (platform) {
    case 'ios':
    case 'iosxe':
    case 'c9800':
    case 'asa':
      return `verify /md5 ${p} ${md5}`
    case 'eos':
      return `verify /md5 ${p.replace(/^\/mnt\/flash\/?/, 'flash:')}`
    case 'nxos':
      return `show file ${p} md5sum`
    case 'iosxr':
      return `show md5 file ${p}`
    case 'junos':
      return `file checksum md5 ${p}`
    default:
      return undefined
  }
}

/** Join a remote directory and a name the way the device writes paths (`flash:` + `x` = `flash:x`). */
export function remoteJoin(dir: string, name: string): string {
  if (!dir) return name
  if (/[:/]$/.test(dir)) return dir + name
  return `${dir}/${name}`
}

/** The parent of a remote path (`/a/b` → `/a`, `flash:dir/x` → `flash:dir`, `flash:x` → `flash:`). */
export function remoteParent(path: string): string {
  const i = path.lastIndexOf('/')
  if (i > 0) return path.slice(0, i)
  if (i === 0) return '/'
  const c = path.indexOf(':')
  return c >= 0 ? path.slice(0, c + 1) : ''
}

/** The last component of a remote path. */
export const remoteBase = (path: string): string => path.replace(/\/+$/, '').split('/').pop()!.replace(/^[^:]*:/, '')
