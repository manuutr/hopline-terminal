/**
 * IPC for file transfers (`transfer:*`) and port forwards (`forward:*`). Every payload is
 * validated (strict zod, length caps), and every handler checks that the calling window owns the
 * tab. Local paths never come from the page: they come from main's dialogs, or from files the
 * user dropped, which the preload resolves itself (`transfer:uploadDropped` is only reachable
 * through the preload's function that takes `File` objects).
 */
import { BrowserWindow, dialog, ipcMain, nativeImage, shell, type WebContents } from 'electron'
import { isAbsolute, win32 } from 'node:path'
import { z } from 'zod'
import type { AuditLog } from '../db/audit'
import { ForwardService } from '../files/forwards'
import { TransferService, type FilesHost } from '../files/service'
import { handler as h, registerAll, type Handler } from '.'
import { trustedSender } from './sender'

const tabId = z.string().min(1).max(80)
/** Remote paths: no NUL or line breaks (SCP puts them on a command line). */
const remotePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/[\0\r\n]/.test(p), 'invalid path')
/**
 * A dropped local file, as the preload resolves it (webUtils.getPathForFile): always absolute.
 * Defense in depth (P8 I2): no NUL, no `..` segment, no relative path, whatever reaches main.
 */
export const droppedPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'invalid path')
  .refine((p) => isAbsolute(p) || win32.isAbsolute(p), 'must be an absolute path')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'invalid path')
const policy = z.enum(['ask', 'skip', 'overwrite', 'rename'])
const host = z
  .string()
  .trim()
  .max(255)
  .refine((v) => !/[\s/\\]/.test(v), 'invalid address')

export const FilesSchemas = {
  open: tabId,
  preview: z.strictObject({ tabId, path: remotePath }),
  op: z
    .object({
      tabId,
      op: z.discriminatedUnion('op', [
        z.object({ op: z.literal('list'), path: remotePath }).strict(),
        z.object({ op: z.literal('stat'), path: remotePath }).strict(),
        z.object({ op: z.literal('mkdir'), path: remotePath }).strict(),
        z.object({ op: z.literal('rename'), from: remotePath, to: remotePath }).strict(),
        z.object({ op: z.literal('remove'), path: remotePath, dir: z.boolean() }).strict()
      ])
    })
    .strict(),
  pickUpload: z.object({ tabId, remoteDir: remotePath.optional(), remotePath: remotePath.optional(), policy }).strict(),
  uploadDropped: z
    .object({ tabId, remoteDir: remotePath, policy, paths: z.array(droppedPath).min(1).max(200) })
    .strict(),
  download: z
    .object({ tabId, items: z.array(z.object({ path: remotePath, size: z.number().int().min(0).optional() }).strict()).min(1).max(500), policy })
    .strict(),
  resolve: z.object({ token: z.string().uuid(), choice: z.enum(['overwrite', 'rename', 'skip', 'resume']) }).strict(),
  id: z.string().uuid(),
  forwardList: tabId,
  forwardAdd: z
    .object({
      tabId,
      spec: z
        .object({
          kind: z.enum(['L', 'R', 'D']),
          bindHost: host,
          bindPort: z.number().int().min(0).max(65535),
          destHost: host.optional(),
          destPort: z.number().int().min(1).max(65535).optional(),
          label: z.string().max(80).optional(),
          autoStart: z.boolean().optional()
        })
        .strict()
        .refine((s) => s.kind === 'D' || (!!s.destHost && !!s.destPort), 'L and R forwards need a destination')
    })
    .strict(),
  forwardId: z.object({ tabId, id: z.string().min(1).max(80) }).strict()
}

/** A small document glyph for drag-out (macOS needs a non-empty drag image). */
const DRAG_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4nGNgoCaoaOr5TwzGa8Drd5/w4lEDRg0YKQZQlJnIAQAZwtqsvuCWxgAAAABJRU5ErkJggg=='

export interface FilesIpcDeps {
  host: FilesHost
  audit: Pick<AuditLog, 'append'>
  /** Global read-only mode (uploads refused while on). */
  readOnly?: () => boolean
}

/** Every transfer and forward handler, by channel (exported for the IPC contract test). */
export function filesHandlers(deps: FilesIpcDeps, services?: { transfers?: TransferService; forwards?: ForwardService }): { handlers: Record<string, Handler>; transfers: TransferService; forwards: ForwardService } {
  const winOf = (wc: WebContents) => BrowserWindow.fromWebContents(wc) ?? undefined
  const transfers =
    services?.transfers ??
    new TransferService({
      host: deps.host,
      audit: deps.audit,
      readOnly: deps.readOnly,
      pickDir: async (wc) => {
        const opts = { title: 'Choose a download folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
        const win = winOf(wc)
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return r.canceled ? null : (r.filePaths[0] ?? null)
      }
    })
  const forwards = services?.forwards ?? new ForwardService(deps.host, deps.audit)
  const S = FilesSchemas
  const handlers: Record<string, Handler> = {
    'transfer:scpDirectory': h(S.preview, ({ tabId, path }, e) => transfers.listScpDirectory(tabId, e.sender, path)),
    'transfer:preview': h(S.preview, ({ tabId, path }, e) => transfers.preview(tabId, e.sender, path)),
    'transfer:open': h(S.open, (id, e) => transfers.open(id, e.sender)),
    'transfer:op': h(S.op, ({ tabId, op }, e) => transfers.op(tabId, e.sender, op)),
    'transfer:pickUpload': h(S.pickUpload, async ({ tabId, remoteDir, remotePath, policy }, e) => {
      const opts = { title: remotePath ? `Choose the file to copy to ${remotePath}` : 'Choose files to upload', properties: (remotePath ? ['openFile'] : ['openFile', 'multiSelections']) as ('openFile' | 'multiSelections')[] }
      const win = winOf(e.sender)
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths.length) return null
      return transfers.upload(tabId, e.sender, r.filePaths, { remoteDir, remotePath }, policy)
    }),
    'transfer:uploadDropped': h(S.uploadDropped, ({ tabId, remoteDir, policy, paths }, e) => transfers.upload(tabId, e.sender, paths, { remoteDir }, policy)),
    'transfer:download': h(S.download, ({ tabId, items, policy }, e) => transfers.download(tabId, e.sender, items, policy)),
    'transfer:downloadDir': h({ parse: () => undefined }, (_x, e) => transfers.downloadDir(e.sender)),
    'transfer:chooseDownloadDir': h({ parse: () => undefined }, (_x, e) => transfers.chooseDownloadDir(e.sender)),
    'transfer:resolve': h(S.resolve, ({ token, choice }, e) => transfers.resolve(e.sender, token, choice)),
    'transfer:cancel': h(S.id, (id, e) => transfers.cancel(e.sender, id)),
    'transfer:retry': h(S.id, (id, e) => transfers.retry(e.sender, id)),
    'transfer:clear': h({ parse: () => undefined }, (_x, e) => transfers.clear(e.sender)),
    'transfer:list': h({ parse: () => undefined }, (_x, e) => transfers.list(e.sender)),
    'transfer:reveal': h(S.id, (id, e) => {
      const p = transfers.localPath(e.sender, id)
      if (p) shell.showItemInFolder(p)
    }),
    'forward:list': h(S.forwardList, (id, e) => forwards.list(id, e.sender)),
    'forward:add': h(S.forwardAdd, ({ tabId, spec }, e) => forwards.add(tabId, e.sender, spec)),
    'forward:start': h(S.forwardId, ({ tabId, id }, e) => forwards.start(tabId, e.sender, id)),
    'forward:stop': h(S.forwardId, ({ tabId, id }, e) => forwards.stop(tabId, e.sender, id)),
    'forward:remove': h(S.forwardId, ({ tabId, id }, e) => forwards.remove(tabId, e.sender, id))
  }
  return { handlers, transfers, forwards }
}

export function registerFilesIpc(deps: FilesIpcDeps): { transfers: TransferService; forwards: ForwardService } {
  const r = filesHandlers(deps)
  registerAll(r.handlers)
  // Drag-out is a send (dragstart can't wait for a reply): start the OS drag of a finished download.
  ipcMain.on('transfer:dragOut', (e, id: unknown) => {
    if (!trustedSender(e)) return
    const parsed = FilesSchemas.id.safeParse(id)
    if (!parsed.success) return
    const p = r.transfers.localPath(e.sender, parsed.data)
    if (p) e.sender.startDrag({ file: p, icon: nativeImage.createFromDataURL(DRAG_ICON) })
  })
  return r
}
