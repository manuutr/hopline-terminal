import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentEvent, FrameState, HoplineApi, PlatformEvent, PromptRequest, SerialLines, SyncStatus, SessionVitals, TabInfo, VaultInfo } from '@shared/types'
import type { MultiEvent } from '@shared/productivity'
import type { ForwardEvent, TransferEvent } from '@shared/files'
import type { FleetEvent } from '@shared/fleet'
import type { DeepLink } from '@shared/settings-registry'
import type { UpdateStatus } from '@shared/privacy'

const inv = <T>(ch: string, arg?: unknown): Promise<T> => ipcRenderer.invoke(ch, arg) as Promise<T>

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// ---------------------------------------------------------------- terminal ports
// Each tab has a MessagePort straight to the session host (keystrokes, output, flow-control acks).
type PortMsg = import('@shared/host-protocol').PortToRenderer
const ports = new Map<string, MessagePort>()
/** Input typed before the port arrived (rare: the first keystrokes after opening a tab). */
const early = new Map<string, unknown[]>()
const dataListeners = new Set<(tabId: string, data: string) => void>()
const vitalsListeners = new Set<(tabId: string, sample: SessionVitals) => void>()
const signalListeners = new Set<(tabId: string, lines: SerialLines) => void>()

ipcRenderer.on('term:port', (e, msg: { tabId?: unknown }) => {
  const port = e.ports[0]
  if (!port || typeof msg?.tabId !== 'string') return
  const tabId = msg.tabId
  ports.get(tabId)?.close()
  ports.set(tabId, port)
  port.onmessage = (ev: MessageEvent<PortMsg>) => {
    const m = ev.data
    if (m?.t === 'd' && typeof m.d === 'string') for (const cb of dataListeners) cb(tabId, m.d)
    else if (m?.t === 'vitals') {
      for (const cb of vitalsListeners) cb(tabId, m.sample)
    } else if (m?.t === 'sig') {
      const lines: SerialLines = { dtr: !!m.dtr, rts: !!m.rts, brk: !!m.brk, ...(typeof m.error === 'string' ? { error: m.error.slice(0, 300) } : {}) }
      for (const cb of signalListeners) cb(tabId, lines)
    }
  }
  port.start()
  for (const m of early.get(tabId) ?? []) port.postMessage(m)
  early.delete(tabId)
})

function toHost(tabId: string, m: unknown): void {
  const port = ports.get(tabId)
  if (port) return port.postMessage(m)
  const q = early.get(tabId) ?? []
  if (q.length < 256) q.push(m)
  early.set(tabId, q)
}

const api: HoplineApi = {
  testMode: process.argv.includes('--hopline-e2e'),
  scrollback: {
    save: (sessionId, data) => inv('scrollback:save', { sessionId, data }),
    load: (sessionId) => inv('scrollback:load', sessionId),
    clear: (sessionId) => inv('scrollback:clear', sessionId),
    // Main asks before a window closes or Hopline quits (review L8); the answer says the saves went out.
    onFlush: (cb) =>
      on<[string]>('scrollback:flush', (nonce) => {
        void Promise.resolve()
          .then(cb)
          .catch(() => undefined)
          .finally(() => ipcRenderer.send('scrollback:flushed', nonce))
      })
  },
  knownHosts: {
    list: () => inv('knownHosts:list'),
    remove: (host, port) => inv('knownHosts:remove', { host, port }),
    importOpenSsh: () => inv('knownHosts:import')
  },
  serial: { list: () => inv('serial:list') },
  prompts: {
    onAsk: (cb) => on<[PromptRequest]>('prompt:ask', cb),
    onDone: (cb) => on<[string]>('prompt:done', cb),
    answer: (id, value) => inv('prompt:answer', { id, value })
  },
  sessions: {
    list: () => inv('sessions:list'),
    save: (s) => inv('sessions:save', s),
    remove: (id) => inv('sessions:remove', id),
    removeMany: (items) => inv('sessions:removeMany', items),
    saveFolder: (f) => inv('sessions:saveFolder', f),
    removeFolder: (id) => inv('sessions:removeFolder', id),
    move: (sessionId, folderId) => inv('sessions:move', { sessionId, folderId }),
    moveMany: (items, folderId) => inv('sessions:moveMany', { items, folderId }),
    bulkUpdate: (ids, patch) => inv('sessions:bulkUpdate', { ids, patch }),
    createEphemeral: (s) => inv('sessions:createEphemeral', s),
    saveEphemeral: (id, patch) => inv('sessions:saveEphemeral', { id, patch }),
    setPlatform: (id, platform) => inv('sessions:setPlatform', { id, platform })
  },
  credentials: {
    list: () => inv('credentials:list'),
    replacePasswords: (ids, password) => inv('credentials:replacePasswords', { ids, password }),
    save: (c) => inv('credentials:save', c),
    remove: (id) => inv('credentials:remove', id),
    importKey: () => inv('credentials:importKey')
  },
  vault: {
    status: () => inv('vault:status'),
    unlock: (password) => inv('vault:unlock', password),
    lock: () => inv('vault:lock'),
    setMode: (req) => inv('vault:setMode', req),
    changePassword: (current, next) => inv('vault:changePassword', { current, next }),
    setAutoLock: (minutes, current) => inv('vault:setAutoLock', { minutes, current }),
    retryKeychain: () => inv('vault:retryKeychain'),
    resetToMaster: (password) => inv('vault:resetToMaster', password),
    touch: () => void inv('vault:touch').catch(() => {}),
    onChange: (cb) => on<[VaultInfo]>('vault:state', cb),
    onUnlockRequest: (cb) => on<[]>('vault:unlockRequest', cb),
    skipUnlock: () => inv('vault:skipUnlock')
  },
  data: {
    exportFile: (req) => inv('data:export', req),
    pickImport: () => inv('data:pickImport'),
    previewImport: (token, passphrase) => inv('data:previewImport', { token, passphrase }),
    applyImport: (token, mode) => inv('data:applyImport', { token, mode }),
    cancelImport: (token) => inv('data:cancelImport', token)
  },
  sync: {
    status: () => inv('sync:status'),
    pickDir: () => inv('sync:pickDir'),
    enable: (req) => inv('sync:enable', req),
    disable: () => inv('sync:disable'),
    syncNow: () => inv('sync:syncNow'),
    previewIncoming: () => inv('sync:previewIncoming'),
    onStatus: (cb) => on<[SyncStatus]>('sync:status', cb)
  },
  importer: {
    pick: (source, mode) => inv('importer:pick', { source, mode }),
    fetchNetBox: (req) => inv('importer:fetchNetBox', req),
    resyncNetBox: () => inv('importer:resyncNetBox'),
    plan: (token, options) => inv('importer:plan', { token, ...options }),
    apply: (req) => inv('importer:apply', req),
    cancel: (token) => inv('importer:cancel', token),
    netBoxSource: () => inv('importer:netBoxSource'),
    forgetNetBox: () => inv('importer:forgetNetBox')
  },
  term: {
    open: (tabId, sessionId, cols, rows, password) => inv('term:open', { tabId, sessionId, cols, rows, password }),
    write: (tabId, data) => toHost(tabId, { t: 'w', d: data }),
    resize: (tabId, cols, rows) => toHost(tabId, { t: 'r', cols, rows }),
    ack: (tabId, n) => ports.get(tabId)?.postMessage({ t: 'a', n }),
    sendBreak: (tabId) => toHost(tabId, { t: 'b' }),
    setSignals: (tabId, s) => toHost(tabId, { t: 'sig', ...s }),
    close: (tabId) => {
      ports.get(tabId)?.close()
      ports.delete(tabId)
      early.delete(tabId)
      return inv('term:close', tabId)
    },
    reconnect: (tabId, password) => inv('term:reconnect', { tabId, password }),
    onData: (cb) => {
      dataListeners.add(cb)
      return () => dataListeners.delete(cb)
    },
    onVitals: (cb) => {
      vitalsListeners.add(cb)
      return () => vitalsListeners.delete(cb)
    },
    onSignals: (cb) => {
      signalListeners.add(cb)
      return () => signalListeners.delete(cb)
    },
    onState: (cb) => on<[TabInfo]>('term:state', cb),
    onPlatform: (cb) => on<[PlatformEvent]>('term:platform', cb)
  },
  blocks: {
    rerun: (tabId, command) => inv('blocks:rerun', { tabId, command })
  },
  agent: {
    run: (req) => inv('agent:run', req),
    cancel: (runId) => inv('agent:cancel', runId),
    decide: (proposalId, approve, ack, lines) => inv('agent:decide', { proposalId, approve, ...(ack !== undefined ? { ack } : {}), ...(lines !== undefined ? { lines } : {}) }),
    change: (proposalId, action) => inv('agent:change', { proposalId, action }),
    reset: (tabId) => inv('agent:reset', tabId),
    runSuggestion: (suggestionId) => inv('agent:runSuggestion', suggestionId),
    onEvent: (cb) => on<[AgentEvent]>('agent:event', cb)
  },
  audit: { list: (limit) => inv('audit:list', limit) },
  egress: {
    list: (q) => inv('egress:list', q ?? {}),
    search: (q) => inv('egress:search', q ?? {}),
    get: (id) => inv('egress:get', id),
    stats: () => inv('egress:stats'),
    exportTo: (ids) => inv('egress:export', ids ?? [])
  },
  policy: { info: () => inv('policy:info') },
  updates: {
    status: () => inv('update:status'),
    check: () => inv('update:check'),
    restart: () => inv('update:restart'),
    onStatus: (cb) => on<[UpdateStatus]>('update:status', cb)
  },
  crash: {
    status: () => inv('crash:status'),
    test: () => inv('crash:test'),
    report: (e) => inv('crash:report', e),
    sendDump: (id) => inv('crash:sendDump', id),
    deleteDump: (id) => inv('crash:deleteDump', id),
    deleteAllDumps: () => inv('crash:deleteAllDumps')
  },
  workspaceChat: {
    ask: (req) => inv('workspaceChat:ask', req),
    cancel: () => inv('workspaceChat:cancel'),
    reset: () => inv('workspaceChat:reset')
  },
  packets: {
    openDropped: (file) => inv('packets:drop', webUtils.getPathForFile(file)),
    plan: (req) => inv('packets:plan', req),
    open: (source) => inv('packets:open', source),
    view: (req) => inv('packets:view', req),
    details: (req) => inv('packets:details', req),
    ask: (req) => inv('packets:ask', req),
    save: (id) => inv('packets:save', id),
    finish: () => inv('packets:finish'),
    cancel: () => inv('packets:cancel'),
    close: () => inv('packets:close'),
    onStage: (cb) => on<[string, boolean]>('packets:stage', cb)
  },
  transfer: {
    open: (tabId) => inv('transfer:open', tabId),
    listScpDirectory: (tabId, path) => inv('transfer:scpDirectory', { tabId, path }),
    preview: (tabId, path) => inv('transfer:preview', { tabId, path }),
    op: (tabId, op) => inv('transfer:op', { tabId, op }),
    pickUpload: (req) => inv('transfer:pickUpload', req),
    // Dropped files: the path is resolved here from the File object and never handed to the page.
    uploadDropped: (req, files) => {
      const paths = (Array.isArray(files) ? files : [])
        .filter((f): f is File => f instanceof File)
        .map((f) => webUtils.getPathForFile(f))
        .filter((p) => typeof p === 'string' && p.length > 0)
      if (!paths.length) return Promise.resolve({ queued: 0, conflicts: [], skipped: [{ name: 'dropped item', reason: 'not a file from this computer' }] })
      return inv('transfer:uploadDropped', { ...req, paths })
    },
    download: (req) => inv('transfer:download', req),
    downloadDir: () => inv('transfer:downloadDir'),
    chooseDownloadDir: () => inv('transfer:chooseDownloadDir'),
    resolve: (token, choice) => inv('transfer:resolve', { token, choice }),
    cancel: (id) => inv('transfer:cancel', id),
    retry: (id) => inv('transfer:retry', id),
    clear: () => inv('transfer:clear'),
    list: () => inv('transfer:list'),
    dragOut: (id) => ipcRenderer.send('transfer:dragOut', id),
    reveal: (id) => inv('transfer:reveal', id),
    onEvent: (cb) => on<[TransferEvent]>('transfer:event', cb)
  },
  forward: {
    list: (tabId) => inv('forward:list', tabId),
    add: (tabId, spec) => inv('forward:add', { tabId, spec }),
    start: (tabId, id) => inv('forward:start', { tabId, id }),
    stop: (tabId, id) => inv('forward:stop', { tabId, id }),
    remove: (tabId, id) => inv('forward:remove', { tabId, id }),
    onEvent: (cb) => on<[ForwardEvent]>('forward:event', cb)
  },
  backups: {
    list: (sessionId) => inv('backups:list', sessionId ? { sessionId } : {}),
    get: (id) => inv('backups:get', id),
    take: (sessionIds) => inv('backups:take', { sessionIds }),
    live: (sessionId) => inv('backups:live', sessionId),
    acceptRename: (sessionId, hostname) => inv('backups:acceptRename', { sessionId, hostname }),
    remove: (id) => inv('backups:remove', id),
    exportVersion: (id, includeSecrets) => inv('backups:export', { id, includeSecrets }),
    schedules: () => inv('backups:schedules'),
    saveSchedule: (s) => inv('backups:saveSchedule', s),
    removeSchedule: (id) => inv('backups:removeSchedule', id),
    retention: () => inv('backups:retention'),
    setRetention: (r) => inv('backups:setRetention', r),
    onChanged: (cb) => on<[]>('backups:changed', () => cb())
  },
  ai: {
    account: (provider, action) => inv('ai:account', { provider, action }),
    test: (req) => inv('ai:test', req),
    connect: (req) => inv('ai:connect', req),
    health: () => inv('ai:health'),
    ollamaModels: (endpoint) => inv('ai:ollamaModels', endpoint)
  },
  links: { open: (url) => inv('links:open', url) },
  a11y: {
    screenReader: () => inv('a11y:screenReader'),
    onScreenReader: (cb) => on<[boolean]>('a11y:screenReader', cb)
  },
  frame: {
    state: () => inv('frame:state'),
    minimize: () => inv('frame:minimize'),
    toggleMaximize: () => inv('frame:toggleMaximize'),
    close: () => inv('frame:close'),
    onState: (cb) => on<[FrameState]>('frame:state', cb)
  },
  menu: {
    setState: (snapshot) => inv('menu:state', snapshot),
    onCommand: (cb) => on<[{ id: string; arg?: string }]>('menu:command', cb)
  },
  app: {
    command: (id) => inv('app:command', id),
    info: () => inv('app:info'),
    saveOutput: (name, text) => inv('app:saveOutput', { name, text })
  },
  settings: {
    get: () => inv('settings:get'),
    update: (patch) => inv('settings:update', patch),
    setApiKey: (key, provider) => inv('settings:setApiKey', provider ? { provider, key } : key)
  },
  keymap: {
    get: () => inv('keymap:get'),
    set: (km) => inv('keymap:set', km)
  },
  snippets: {
    list: () => inv('snippets:list'),
    save: (s) => inv('snippets:save', s),
    remove: (id) => inv('snippets:remove', id),
    reorder: (ids) => inv('snippets:reorder', ids),
    prepare: (snippetId, tabId, vars) => inv('snippets:prepare', { snippetId, tabId, vars }),
    run: (planId, approve, ack) => inv('snippets:run', { planId, approve, ...(ack !== undefined ? { ack } : {}) }),
    insert: (snippetId, tabId, vars) => inv('snippets:insert', { snippetId, tabId, vars })
  },
  multi: {
    info: () => inv('multi:info'),
    resolve: (targets) => inv('multi:resolve', targets),
    preview: (req) => inv('multi:preview', req),
    start: (req) => inv('multi:start', req),
    cancel: (runId) => inv('multi:cancel', runId),
    decline: (previewId) => inv('multi:decline', previewId),
    onEvent: (cb) => on<[MultiEvent]>('multi:event', cb)
  },
  ux: {
    onboarding: { get: () => inv('ux:onboarding:get'), set: (st) => inv('ux:onboarding:set', st) },
    overrides: { get: () => inv('ux:overrides:get'), set: (st) => inv('ux:overrides:set', st) },
    themes: {
      get: () => inv('ux:themes:get'),
      set: (list) => inv('ux:themes:set', list),
      import: () => inv('ux:themes:import'),
      export: (t) => inv('ux:themes:export', t)
    },
    onDeepLink: (cb) => on<[DeepLink]>('app:deep-link', cb)
  },
  ...(__HOPLINE_DEV_LAB__ ? { lab: {
    info: () => inv<{ running: boolean; sessionIds: string[] }>('lab:info'),
    start: () => inv<{ running: boolean; sessionIds: string[] }>('lab:start')
  } } : {}),
  fleet: {
    info: () => inv('fleet:info'),
    scope: (spec) => inv('fleet:scope', spec),
    mentions: (req) => inv('fleet:mentions', req),
    start: (req) => inv('fleet:start', req),
    cancel: (runId) => inv('fleet:cancel', runId),
    cancelLane: (runId, lane) => inv('fleet:cancel-lane', { runId, lane }),
    onEvent: (cb) => on<[FleetEvent]>('fleet:event', cb)
  }
}

contextBridge.exposeInMainWorld('hopline', api)
