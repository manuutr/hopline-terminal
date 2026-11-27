import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { CredentialInfo, ImportPreview, KeyImportInfo, NetBoxSource, SessionImportOutcome, SessionImportPlan, SyncStatus, VaultInfo } from '@shared/types'
import { generateEd25519 } from '../../../packages/simulator/src/index.ts'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { FolderSync } from '../src/main/backup/sync'
import { coreHandlers, type Handler, type Pickers, type Services } from '../src/main/ipc'
import { agentHandlers } from '../src/main/ipc/agent'
import { blocksHandlers } from '../src/main/ipc/blocks'
import { PacketWorkspace } from '../src/main/packets/workspace'
import { packetsHandlers } from '../src/main/ipc/packets'
import { workspaceChatHandlers } from '../src/main/ipc/workspace-chat'
import { WorkspaceChat } from '../src/main/agent/workspace-chat'
import { aiHandlers } from '../src/main/ipc/ai'
import { AiService } from '../src/main/llm/service'
import { fakeAnthropic, fakeOllama, type FakeServer } from './fake-llm'
import { termHandlers, type TermHost } from '../src/main/ipc/term'
import { keymapHandlers, multiHandlers, snippetHandlers } from '../src/main/ipc/productivity'
import { MultiService } from '../src/main/productivity/multi'
import { fleetHandlers } from '../src/main/ipc/fleet'
import { trustHandlers } from '../src/main/ipc/trust'
import { privacyHandlers } from '../src/main/ipc/privacy'
import { CrashReporting } from '../src/main/crash/service'
import { UpdateService } from '../src/main/update/service'
import { NO_LOCKS } from '@shared/policy'
import { EgressLog } from '../src/main/egress/store'
import { PolicyService } from '../src/main/policy/policy'
import { FleetService } from '../src/main/fleet/service'
import { GuardedRunner } from '../src/main/productivity/runner'
import { SnippetService } from '../src/main/productivity/snippets'
import { ProductivityStore } from '../src/main/productivity/store'
import { backupHandlers } from '../src/main/ipc/backups'
import { BackupService } from '../src/main/backups/service'
import { BackupStore } from '../src/main/backups/store'
import { Agent } from '../src/main/agent/agent'
import { EphemeralSessions } from '../src/main/ephemeral'
import { PromptBroker } from '../src/main/prompts'
import { SettingsService } from '../src/main/settings'
import { ScrollbackStore } from '../src/main/store/scrollback'
import { UnlockBroker } from '../src/main/vault/unlock'
import { Vault } from '../src/main/vault/vault'

// SettingsService computes its default log folder from Electron's app paths.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} } }))

/**
 * The safety rule, checked at the IPC boundary: secrets go renderer → main and never come back.
 * Canary secrets are planted through every path, then every handler's result is scanned for them.
 */
const FAST = { N: 2 ** 10, r: 8, p: 1 }
const NETBOX_TOKEN = 'CANARY-NETBOX-TOKEN-2d6e'
const CANARIES = [NETBOX_TOKEN, 'CANARY-PASSWORD-7f3a', 'CANARY-PASSPHRASE-91c2', 'CANARY-SYNC-PASS-55d1', 'CANARY-EXPORT-PASS-0b9e', 'CANARY-MASTER-PW-c4d8', 'sk-ant-CANARY-API-KEY-3e7f']
const dir = mkdtempSync(join(tmpdir(), 'ipc-'))
const FIXTURES = join(__dirname, '../../../packages/importers/test/fixtures')
/** A headerless CSV: nothing to recognise, so the preview must ask for a column mapping. */
const headerless = join(dir, 'devices.csv')
writeFileSync(headerless, 'edge-1,10.9.0.1,CANARY-PASSWORD-7f3a\r\nedge-2,10.9.0.2,\r\n')
/** Real titles, none of them known: shown so the user can map by name. */
const oddHeaders = join(dir, 'odd.csv')
let pickCsv = headerless
writeFileSync(oddHeaders, 'Mgmt Addr,Device,Rack Unit\n10.8.0.1,sw-a,U12\n')
let teardown = () => {}
let llm: FakeServer[] = []
afterAll(async () => {
  await Promise.all(llm.map((x) => x.close()))
  // Windows can't delete files that are still open (EPERM): stop watchers, close the database first.
  teardown()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

// generateEd25519 retries around an ssh2 keygen bug that makes ~1 key in 256 unreadable.
const key = generateEd25519({ passphrase: 'CANARY-PASSPHRASE-91c2', rounds: 4, comment: 'ops@lab' })
const keyFile = join(dir, 'id_ed25519')
writeFileSync(keyFile, key.private)
/** Distinctive base64 from inside the private key: must never leave main either. */
const keyBody = key.private.split('\n')[3]!

const results: { channel: string; value: unknown }[] = []
let handlers: Record<string, Handler>
let vault: Vault
let svcSettings: SettingsService
/**
 * The renderer's window as main sees it: push events sent on it (prompt:ask, prompt:done,
 * agent:event) are recorded and scanned like results. vault:state and sync:status are taken from
 * the services' events (what main/index.ts forwards); term:state comes from the real session host, not covered here.
 */
const window_ = {
  isDestroyed: () => false,
  on: () => {},
  once: () => {},
  off: () => {},
  send: (channel: string, payload: unknown) => void results.push({ channel: `event ${channel}`, value: payload })
}
const ev = { sender: window_ } as unknown as IpcMainInvokeEvent
let prompts: PromptBroker
const eph = new EphemeralSessions()
let lastOpenPassword: string | undefined
let ollamaUrl = ''

async function call<T>(channel: string, arg?: unknown): Promise<T> {
  const h = handlers[channel]
  if (!h) throw new Error(`no handler ${channel}`)
  called.add(channel)
  try {
    const value = (await h.fn(h.schema.parse(arg) as never, ev)) as T
    results.push({ channel, value })
    return value
  } catch (e) {
    // Errors cross IPC to the renderer too: they are scanned like results.
    results.push({ channel, value: { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) } })
    throw e
  }
}
const called = new Set<string>()

beforeAll(async () => {
  const db = openDb(join(dir, 'h.db'))
  const m = new Map<string, string>()
  vault = new Vault({
    settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) },
    keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) },
    kdf: FAST
  })
  await vault.init()
  const repo = new Repo(db, vault.key)
  const exportTo = join(dir, 'out.hopline')
  const pickers: Pickers = {
    openKeyFile: async () => keyFile,
    saveExport: async () => exportTo,
    openExport: async () => exportTo,
    pickDir: async () => mkdtempSync(join(dir, 'sync-')),
    confirm: async () => true,
    openImport: async ({ dir: isDir, title }) => (isDir ? join(FIXTURES, 'securecrt/Config/Sessions') : /CSV/.test(title) ? pickCsv : join(FIXTURES, 'ssh_config')),
    sshConfigPath: () => join(FIXTURES, 'ssh_config')
  }
  const settings = new SettingsService(repo, vault.key)
  svcSettings = settings
  const svc: Services = {
    repo,
    settings,
    audit: new AuditLog(db),
    scrollback: new ScrollbackStore(join(dir, 'sb'), vault.key),
    vault,
    unlock: new UnlockBroker(vault, () => {}),
    sync: new FolderSync(repo, vault.key, { debounceMs: 10, kdf: FAST }),
    pickers,
    kdf: FAST,
    // A NetBox that only answers the canary token. CSV/PuTTY passwords never reach here: the importers drop them.
    fetch: async (_url, init) =>
      init.headers.Authorization === `Token ${NETBOX_TOKEN}`
        ? { ok: true, status: 200, json: async () => ({ count: 1, next: null, results: [{ id: 7, name: 'nb-sw1', primary_ip: { address: '10.7.0.1/32' }, site: { name: 'AMS1' }, platform: { slug: 'eos' } }] }) }
        : { ok: false, status: 403, json: async () => ({}) }
  }
  handlers = coreHandlers(svc)
  // Push events from main's services, as main/index.ts broadcasts them.
  vault.on('change', (info) => results.push({ channel: 'event vault:state', value: info }))
  svc.sync.on('status', (st) => results.push({ channel: 'event sync:status', value: st }))
  // Term and agent channels, with a stand-in session host (the real one is a separate process).
  prompts = new PromptBroker()
  const host: TermHost = {
    ephemeral: eph,
    adopt: () => {},
    open: async (_wc, tabId, sessionId, _c, _r, password) => {
      lastOpenPassword = password
      return { tabId, sessionId, state: 'connecting' }
    },
    close: () => {},
    reconnect: async (_wc, tabId, password) => {
      lastOpenPassword = password
      return { tabId, sessionId: 'x', state: 'connecting' }
    },
    listSerialPorts: async () => []
  }
  const term = { get: (tabId: string) => (tabId === 'tab-ai' ? { tabId, session: repo.listSessions()[0]! } : undefined), exec: async () => Promise.reject(new Error('no device')), mode: async () => 'exec' as const, prompt: async () => ({ mode: 'exec' as const, prompt: 'r1#', hostname: 'r1' }) }
  const productivity = new ProductivityStore(repo)
  const runner = new GuardedRunner({ term, settings, audit: new AuditLog(db) })
  const agentTerm = term
  const agent = new Agent({
    term,
    settings,
    audit: new AuditLog(db),
    provider: async () => Promise.reject(new Error('Add your Anthropic API key in Settings to use the assistant.')),
    emit: (e) => window_.send('agent:event', e)
  })
  const anthropic = await fakeAnthropic()
  const ollama = await fakeOllama()
  llm = [anthropic, ollama]
  ollamaUrl = ollama.url
  handlers = { ...handlers, ...termHandlers(host, prompts, repo), ...agentHandlers(agent), ...aiHandlers(new AiService(settings, { anthropicBaseURL: anthropic.url })), ...blocksHandlers({ term: agentTerm, audit: new AuditLog(db), settings, owns: (tabId) => tabId === 'tab-ai' }), ...keymapHandlers(productivity), ...snippetHandlers(productivity, new SnippetService(productivity, runner, repo), (tabId) => tabId === 'tab-ai'),
    ...multiHandlers(new MultiService({ host: { ...term, tabsOf: () => [], ownedBy: () => false, close: () => {}, openBackground: () => Promise.reject(new Error('no device')) }, runner, repo, emit: (_wc, ev) => window_.send('multi:event', ev) })),
    ...fleetHandlers(new FleetService({ host: { ...term, close: () => {}, openBackground: () => Promise.reject(new Error('no device')) }, repo, settings, audit: new AuditLog(db), provider: async () => Promise.reject(new Error('no model')), emit: (_wc, ev) => window_.send('fleet:event', ev) })) }
  const packets = new PacketWorkspace({
    choose: async () => null, saveAs: async () => null, download: () => undefined, receive: async () => null, destination: async () => false,
    runner, owns: () => false, stage: () => {}, provider: () => Promise.reject(new Error('No model')), sessions: () => []
  })
  Object.assign(handlers, packetsHandlers(() => packets))
  Object.assign(handlers, workspaceChatHandlers(() => new WorkspaceChat(
    () => ({ sessions: repo.listSessions(), folders: repo.listFolders() }), () => Promise.reject(new Error('No model'))
  )))
  // Config backups: a device whose running config holds the password canary.
  const backupStore = new BackupStore(db, vault.key)
  const backupSvc = new BackupService({
    host: {
      tabsOf: (id) => [{ tabId: 'tab-bk', session: repo.getSession(id)! }],
      ownedBy: () => true,
      exec: async () => ({ status: 'ok', output: 'Building configuration...\n!\nhostname bk1\nusername admin privilege 15 secret 0 CANARY-PASSWORD-7f3a\nsnmp-server community CANARY-PASSWORD-7f3a RO\nend', durationMs: 1, bytes: 100 })
    },
    repo,
    audit: new AuditLog(db),
    settings: () => settings.get(),
    store: backupStore
  })
  // Trust UX: the egress log holds one request recorded the way llm/egress.ts records it.
  const egress = new EgressLog(db, vault.key)
  await egress.record({ provider: 'anthropic', model: 'claude-opus-5-5', destination: 'api.anthropic.com', source: 'agent', sessionName: 'r1', runId: 'run-1', body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'show version' }] } })
  handlers = { ...handlers, ...trustHandlers({ egress, policy: PolicyService.none(), saveFile: async () => join(dir, 'egress.jsonl') }) }
  // Phase 7: updates (no updater in a test: a dev build never checks) and crash reports (a stub transport).
  const crash = new CrashReporting({ settings: () => settings.get(), locks: () => NO_LOCKS, known: () => [], version: '0.7.0', builtInDsn: '', fetch: async () => ({ status: 200, headers: { get: () => null } }), dumpsDir: () => join(dir, 'dumps'), confirm: async () => true })
  const updates = new UpdateService({ backend: () => { throw new Error('no updater in tests') }, settings: () => settings.get(), locks: () => NO_LOCKS, version: '0.7.0', mode: () => 'auto', openSessions: () => 0, emit: () => {}, releaseUrl: () => null, dev: true, installOnQuit: false })
  settings.onChange = () => crash.apply()
  handlers = { ...handlers, ...privacyHandlers({ updates, crash }) }
  handlers = { ...handlers, ...backupHandlers({ service: backupSvc, store: backupStore, saveFile: async () => join(dir, 'cfg.txt'), confirm: async () => true, audit: new AuditLog(db) }) }
  teardown = () => {
    svc.sync.stop()
    vault.stop()
    db.close()
  }
})

const CRED_KEYS = ['hasPassphrase', 'hasSecret', 'id', 'keyEncrypted', 'keyFingerprint', 'keyType', 'kind', 'name', 'usedBy', 'username']

describe('IPC never returns secrets', () => {
  it('credential handlers return metadata only, in exactly the CredentialInfo shape', async () => {
    const pw = await call<CredentialInfo>('credentials:save', { name: 'Lab admin', username: 'admin', kind: 'password', secret: 'CANARY-PASSWORD-7f3a' })
    expect(Object.keys(pw).sort()).toEqual(CRED_KEYS)
    expect(await call('credentials:replacePasswords', { ids: [pw.id], password: 'CANARY-PASSWORD-7f3a' })).toBe(1)
    expect(pw).toMatchObject({ kind: 'password', hasSecret: true, hasPassphrase: false })

    const picked = await call<KeyImportInfo>('credentials:importKey')
    expect(Object.keys(picked).sort()).toEqual(['comment', 'encrypted', 'file', 'fingerprint', 'format', 'keyType', 'token'])
    // (An encrypted OpenSSH key keeps its comment in the encrypted part: not readable yet.)
    expect(picked).toMatchObject({ file: 'id_ed25519', format: 'openssh', keyType: 'ssh-ed25519', encrypted: true, comment: '' })
    expect(picked.fingerprint).toMatch(/^SHA256:/)
    // A wrong passphrase is refused at save time, not discovered at connect time.
    await expect(call('credentials:save', { name: 'Key', username: 'ops', kind: 'key', keyToken: picked.token, passphrase: 'nope' })).rejects.toThrow(/Wrong passphrase/)
    const k = await call<CredentialInfo>('credentials:save', { name: 'Key', username: 'ops', kind: 'key', keyToken: picked.token, passphrase: 'CANARY-PASSPHRASE-91c2' })
    expect(Object.keys(k).sort()).toEqual(CRED_KEYS)
    expect(k).toMatchObject({ kind: 'key', hasSecret: true, hasPassphrase: true, keyType: 'ssh-ed25519', keyFingerprint: picked.fingerprint, keyEncrypted: true })
    // The token is single-use.
    await expect(call('credentials:save', { name: 'Again', username: 'ops', kind: 'key', keyToken: picked.token })).rejects.toThrow(/expired/)

    await call('credentials:save', { name: 'Agent', username: 'ops', kind: 'agent' })
    await call('credentials:save', { name: 'Ask', username: 'ops', kind: 'prompt' })
    await call('sessions:save', { name: 'sw1', folderId: null, host: '10.0.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: '', credentialId: pw.id, logToFile: false, notes: '', options: {} })
    const list = await call<CredentialInfo[]>('credentials:list')
    expect(list).toHaveLength(4)
    for (const c of list) expect(Object.keys(c).sort()).toEqual(CRED_KEYS)
    expect(list.find((c) => c.id === pw.id)?.usedBy).toBe(1)
  })

  it('the renderer cannot smuggle a path or a secret field back out', () => {
    // Strict schemas refuse unknown fields (P8 I1): there is no way to ask for "secret" in a list or a path in a pick.
    expect(() => handlers['credentials:save']!.schema.parse({ name: 'x', username: '', kind: 'password', path: '/etc/shadow' })).toThrow()
    expect(() => handlers['credentials:save']!.schema.parse({ name: 'x', username: '', kind: 'password', keyToken: '../../id_rsa' })).toThrow()
  })

  it('vault, export, import and sync results carry no secret', async () => {
    const v = await call<VaultInfo>('vault:setMode', { mode: 'master', password: 'CANARY-MASTER-PW-c4d8' })
    expect(Object.keys(v).sort()).toEqual(['autoLockMin', 'backend', 'chosen', 'keychainAvailable', 'keychainBroken', 'locked', 'mode', 'persistent'])
    await call('vault:lock')
    await expect(call('vault:unlock', 'wrong-password')).rejects.toThrow(/Wrong master password/)
    await call('vault:unlock', 'CANARY-MASTER-PW-c4d8')
    await call('vault:status')

    const dirPick = await call<{ dirToken: string; dir: string }>('sync:pickDir')
    const s = await call<SyncStatus>('sync:enable', { dirToken: dirPick.dirToken, passphrase: 'CANARY-SYNC-PASS-55d1', includeSecrets: true })
    expect(s.enabled).toBe(true)
    await call('sync:status')

    const out = await call<{ file: string }>('data:export', { passphrase: 'CANARY-EXPORT-PASS-0b9e', includeSecrets: true })
    // The file holds the secrets (encrypted); the IPC result doesn't.
    const raw = readFileSync(out.file)
    for (const c of [...CANARIES, keyBody]) expect(raw.includes(Buffer.from(c))).toBe(false)
    const f = await call<{ token: string }>('data:pickImport')
    await expect(call('data:previewImport', { token: f.token, passphrase: 'wrong-passphrase' })).rejects.toThrow(/Wrong passphrase/)
    const pv = await call<ImportPreview>('data:previewImport', { token: f.token, passphrase: 'CANARY-EXPORT-PASS-0b9e' })
    expect(pv.includesSecrets).toBe(true)
    expect(pv.counts.secrets).toBe(2)
    await call('data:applyImport', { token: f.token, mode: 'merge' })
    await call('credentials:list')
  })

  it('settings, sessions, known hosts, scrollback, audit and the rest carry no secret either', async () => {
    const s = await call<Record<string, unknown>>('settings:setApiKey', 'sk-ant-CANARY-API-KEY-3e7f')
    expect(s['hasApiKey']).toBe(true)
    expect(s['apiKeyLast4']).toBe('3e7f')
    // Onboarding: the key goes in once; results carry a code, a message and settings, never the key.
    const c = await call<Record<string, unknown>>('ai:connect', { provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-CANARY-API-KEY-3e7f' })
    expect(c).toMatchObject({ ok: true, settings: { aiConfigured: true, apiKeyLast4: '3e7f' } })
    await call('ai:test', { provider: 'anthropic', model: 'claude-opus-5-5' })
    await call('ai:ollamaModels', ollamaUrl)
    expect(() => handlers['ai:ollamaModels']!.schema.parse('file:///etc/passwd')).toThrow()
    expect(() => handlers['ai:ollamaModels']!.schema.parse('http://user:pw@10.0.0.1:11434')).toThrow()
    expect(() => handlers['ai:test']!.schema.parse({ provider: 'unknown-cloud', model: 'x' })).toThrow()
    await expect(svcSettings.apiKey()).resolves.toBe('sk-ant-CANARY-API-KEY-3e7f')
    await call('settings:get')
    await call('settings:update', { termFontSize: 14 })
    await expect(call('vault:setAutoLock', { minutes: 30 })).rejects.toThrow(/current master password/)
    await call('vault:setAutoLock', { minutes: 30, current: 'CANARY-MASTER-PW-c4d8' })
    // Only for a broken keychain: a working vault says so (the error is scanned too).
    await call('vault:retryKeychain')
    await expect(call('vault:resetToMaster', 'CANARY-MASTER-PW-c4d8')).rejects.toThrow(/keychain works/)
    await call('vault:touch')
    await call('vault:skipUnlock')
    await expect(call('vault:changePassword', { current: 'wrong-password', next: 'another-password' })).rejects.toThrow(/Wrong master password/)
    await call('vault:changePassword', { current: 'CANARY-MASTER-PW-c4d8', next: 'CANARY-MASTER-PW-c4d8' })
    await call('sync:syncNow')
    await call('sync:previewIncoming').catch(() => undefined)
    await call('sync:disable')
    const f = await call<{ token: string }>('data:pickImport')
    await call('data:cancelImport', f.token)
    const { sessions } = await call<{ sessions: { id: string }[] }>('sessions:list')
    const folder = await call<{ id: string }>('sessions:saveFolder', { name: 'Core', parentId: null })
    await call('sessions:move', { sessionId: sessions[0]!.id, folderId: folder.id })
    await call('sessions:moveMany', { items: { sessionIds: [sessions[0]!.id], folderIds: [] }, folderId: null })
    await call('sessions:bulkUpdate', { ids: [sessions[0]!.id], patch: { favorite: true, addTags: ['core'] } })
    await call('scrollback:save', { sessionId: sessions[0]!.id, data: 'show run\r\nhostname sw1' })
    await call('scrollback:load', sessions[0]!.id)
    await call('scrollback:clear', sessions[0]!.id)
    await call('knownHosts:list')
    await call('knownHosts:remove', { host: '10.0.0.1', port: 22 })
    await call('audit:list', 50)
    const creds = await call<CredentialInfo[]>('credentials:list')
    await call('credentials:remove', creds.find((c) => c.kind === 'prompt')!.id)
    await call('sessions:removeFolder', folder.id)
    await call('sessions:remove', sessions[0]!.id)
  })

  it('session import: plans carry display fields only; the NetBox token goes in and never comes back', async () => {
    const ssh = await call<SessionImportPlan>('importer:pick', { source: 'ssh-config', mode: 'default' })
    expect(ssh.rows.length).toBeGreaterThan(5)
    const replanned = await call<SessionImportPlan>('importer:plan', { token: ssh.token, targetFolderId: null, keepFolders: false })
    expect(replanned.rows.length).toBe(ssh.rows.length)
    await call('importer:cancel', ssh.token)
    await expect(call('importer:plan', { token: ssh.token, targetFolderId: null, keepFolders: true })).rejects.toThrow(/expired/)

    const csv = await call<SessionImportPlan>('importer:pick', { source: 'csv' })
    expect(csv.rows).toHaveLength(0)
    expect(csv.csv).toMatchObject({ needsMapping: true, hasHeader: true })
    // Row 1 might be data, not titles: its cells are never sent (the password canary is in it).
    expect(csv.csv!.columns).toEqual([0, 1, 2].map((i) => ({ index: i, header: `Column ${i + 1}` })))
    const mapped = await call<SessionImportPlan>('importer:plan', { token: csv.token, targetFolderId: null, keepFolders: true, csv: { mapping: { name: 0, host: 1 }, hasHeader: false } })
    expect(mapped.rows.map((r) => [r.name, r.host, r.status])).toEqual([
      ['edge-1', '10.9.0.1', 'new'],
      ['edge-2', '10.9.0.2', 'new']
    ])
    expect(mapped.csv).toMatchObject({ needsMapping: false, hasHeader: false, mapping: { name: 0, host: 1 } })
    expect(mapped.csv!.columns[0]).toEqual({ index: 0, header: 'Column 1' })
    await call('importer:cancel', csv.token)
    pickCsv = oddHeaders
    const odd = await call<SessionImportPlan>('importer:pick', { source: 'csv' })
    expect(odd.csv).toMatchObject({ needsMapping: true, hasHeader: true })
    expect(odd.csv!.columns.map((c) => c.header)).toEqual(['Mgmt Addr', 'Device', 'Rack Unit'])
    const oddMapped = await call<SessionImportPlan>('importer:plan', { token: odd.token, targetFolderId: null, keepFolders: true, csv: { mapping: { host: 0, name: 1 }, hasHeader: true } })
    expect(oddMapped.rows.map((r) => [r.name, r.host])).toEqual([['sw-a', '10.8.0.1']])
    await call('importer:cancel', odd.token)

    const crt = await call<SessionImportPlan>('importer:pick', { source: 'securecrt', mode: 'dir' })
    const rows = crt.rows.filter((r) => r.status === 'new')
    const platforms = Object.fromEntries(rows.filter((r) => r.platformPrompt === 'missing').map((r) => [String(r.index), 'ios']))
    const out = await call<SessionImportOutcome>('importer:apply', { token: crt.token, targetFolderId: null, keepFolders: true, rows: rows.map((r) => r.index), remove: [], platforms })
    expect(out.created).toBe(rows.length)
    // A path can't be passed in: the schema has no field for it, and refuses unknown ones (P8 I1).
    expect(() => handlers['importer:pick']!.schema.parse({ source: 'csv', path: '/etc/shadow' })).toThrow()

    await expect(call('importer:fetchNetBox', { url: 'https://nb.example.com', flavor: 'netbox', filter: '', token: 'wrong-token' })).rejects.toThrow(/Authentication failed/)
    const nb = await call<SessionImportPlan>('importer:fetchNetBox', { url: 'https://nb.example.com', flavor: 'netbox', filter: 'site=ams1', token: NETBOX_TOKEN })
    expect(nb.rows).toHaveLength(1)
    // Saved only once applied.
    expect(await call('importer:netBoxSource')).toBeNull()
    await call('importer:apply', { token: nb.token, targetFolderId: null, keepFolders: true, rows: [0], remove: [], platforms: {} })
    const src = await call<NetBoxSource>('importer:netBoxSource')
    expect(Object.keys(src).sort()).toEqual(['filter', 'flavor', 'hasToken', 'keepFolders', 'lastSyncAt', 'targetFolderId', 'url'])
    expect(src.hasToken).toBe(true)
    // Re-sync uses the token from the vault.
    const again = await call<SessionImportPlan>('importer:resyncNetBox')
    expect(again).toMatchObject({ resync: true, gone: [] })
    expect(again.rows[0]!.status).toBe('unchanged')
    await call('importer:cancel', again.token)
    // A new filter where nothing changes: applying no rows still saves the source.
    const refiltered = await call<SessionImportPlan>('importer:fetchNetBox', { url: 'https://nb.example.com', flavor: 'netbox', filter: 'site=ams1&role=core' })
    expect(refiltered.rows.every((r) => r.status === 'unchanged')).toBe(true)
    const none = await call<SessionImportOutcome>('importer:apply', { token: refiltered.token, targetFolderId: null, keepFolders: true, rows: [], remove: [], platforms: {} })
    expect(none).toMatchObject({ created: 0, updated: 0, removed: 0 })
    expect(await call<NetBoxSource>('importer:netBoxSource')).toMatchObject({ filter: 'site=ams1&role=core', hasToken: true })
    await call('importer:forgetNetBox')
    await expect(call('importer:resyncNetBox')).rejects.toThrow(/No NetBox source/)
  })

  it('term, prompt and agent channels: secrets go in, never out; quick connect takes only what it needs', async () => {
    // #15: an unsaved quick-connect session can't carry a credential, logging, notes or a jump host.
    const quick = { name: 'admin@10.5.0.1', host: '10.5.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: 'admin', options: {} }
    for (const extra of [{ credentialId: 'c1' }, { logToFile: true }, { notes: 'x' }, { folderId: null }, { options: { ssh: { jump: ['s1'] } } }, { options: { ssh: { agentForward: true } } }])
      await expect(call('sessions:createEphemeral', { ...quick, ...extra }), JSON.stringify(extra)).rejects.toThrow()
    const q = await call<{ id: string; credentialId: string | null; logToFile: boolean; options: object }>('sessions:createEphemeral', quick)
    expect(q).toMatchObject({ credentialId: null, logToFile: false, options: {} })
    await call('sessions:createEphemeral', { ...quick, name: 'COM3 @ 9600', host: 'COM3', port: 0, protocol: 'serial', username: '', options: { serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', breakMs: 300 } } })
    await expect(call('sessions:saveEphemeral', { id: 'quick-gone', patch: { name: 'x', folderId: null } })).rejects.toThrow(/no longer open/)
    const saved = await call<{ id: string }>('sessions:saveEphemeral', { id: q.id, patch: { name: 'Saved quick', folderId: null } })
    expect(saved.id).toBe(q.id)
    // Set platform (after auto-detect could not tell): saved sessions; 'auto' and unmodelled ids only by the enum.
    const plat = await call<{ platform: string; detected: unknown }>('sessions:setPlatform', { id: q.id, platform: 'junos' })
    expect(plat).toMatchObject({ platform: 'junos' })
    await expect(call('sessions:setPlatform', { id: q.id, platform: 'vyos' })).rejects.toThrow()
    await expect(call('sessions:setPlatform', { id: 'nope', platform: 'ios' })).rejects.toThrow(/No such session/)

    // A typed password reaches the session host and is never echoed back.
    await call('term:open', { tabId: '6f1c1e0e-58e4-4d2b-9a43-4b4ea5d3c1a1', sessionId: q.id, cols: 80, rows: 24, password: 'CANARY-PASSWORD-7f3a' })
    expect(lastOpenPassword).toBe('CANARY-PASSWORD-7f3a')
    await call('term:reconnect', { tabId: '6f1c1e0e-58e4-4d2b-9a43-4b4ea5d3c1a1', password: 'CANARY-PASSWORD-7f3a' })
    await call('term:close', '6f1c1e0e-58e4-4d2b-9a43-4b4ea5d3c1a1')
    await call('serial:list')

    // A prompt answer (a key passphrase here) goes to the asker only; prompt:ask/done never carry it.
    const asked = prompts.ask(window_ as never, { kind: 'secret', host: '10.0.0.1', secret: 'passphrase', label: 'Passphrase for id_ed25519' }, { tabId: 't1', sessionName: 'sw1' })
    const ask = results.findLast((r) => r.channel === 'event prompt:ask')!.value as { id: string }
    await call('prompt:answer', { id: ask.id, value: 'CANARY-PASSPHRASE-91c2' })
    expect(await asked).toBe('CANARY-PASSPHRASE-91c2')

    // Agent channels and its push events.
    await expect(call('agent:run', { tabId: 'no-such-tab', prompt: 'show version' })).rejects.toThrow(/No such tab/)
    const run = await call<{ runId: string }>('agent:run', { tabId: 'tab-ai', prompt: 'show version', selection: 'password CANARY-PASSWORD-7f3a' })
    await expect.poll(() => results.some((r) => r.channel === 'event agent:event' && JSON.stringify(r.value).includes('"error"'))).toBe(true)
    // A decision on a proposal that is not open is an error (review R2-H2), not a silent no-op.
    await expect(call('agent:decide', { proposalId: 'p-none', approve: true })).rejects.toThrow(/no longer open/)
    // Confirm/rollback of a change that is not waiting: an error, never a silent no-op.
    await expect(call('agent:change', { proposalId: 'p-none', action: 'confirm' })).rejects.toThrow(/no longer waiting/)
    await call('agent:cancel', run.runId)
    await call('agent:reset', 'tab-ai')
    // Suggest mode: an id main never issued runs nothing.
    await expect(call('agent:runSuggestion', 'forged-id')).rejects.toThrow(/no longer available/)
    await call('ai:health')
    await call('ai:account', { provider: 'chatgpt', action: 'status' })
    expect(() => handlers['ai:account']!.schema.parse({ provider: 'copilot', action: 'start', executable: '/tmp/untrusted' })).toThrow()
    // Trust UX: what left this machine, and the team policy.
    const rows = await call<{ id: number }[]>('egress:list', {})
    await call('egress:list', { search: 'show version' })
    expect(await call('egress:search', { search: 'show version' })).toMatchObject({ payloadsSearched: true })
    await call('egress:get', rows[0]!.id)
    await call('egress:stats')
    expect(await call('egress:export', [])).toMatchObject({ rows: 1 })
    expect(await call('policy:info')).toMatchObject({ state: 'none' })
  })

  it('backups: config text reaches the renderer redacted; export writes the file, the result carries only its path', async () => {
    const s = await call<{ id: string }>('sessions:save', { name: 'bk1', folderId: null, host: '10.4.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: '', credentialId: null, logToFile: false, notes: '', options: {} })
    const [r] = await call<{ outcome: string; versionId: string }[]>('backups:take', { sessionIds: [s.id] })
    expect(r!.outcome).toBe('saved')
    const list = await call<{ id: string }[]>('backups:list', { sessionId: s.id })
    expect(list).toHaveLength(1)
    await call('backups:list', {})
    const v = await call<{ text: string; redactions: number }>('backups:get', r!.versionId)
    expect(v.text).toContain('hostname bk1')
    expect(v.redactions).toBeGreaterThan(0)
    await call('backups:live', s.id)
    const red = await call<{ file: string }>('backups:export', { id: r!.versionId, includeSecrets: false })
    expect(readFileSync(red.file, 'utf8')).not.toContain('CANARY-PASSWORD-7f3a')
    // Phase 4 Low 7: an export over an existing world-readable file is still 0600.
    if (process.platform !== 'win32') chmodSync(red.file, 0o644)
    // With secrets only after main's own confirmation; the file has them, the IPC result doesn't.
    const full = await call<{ file: string }>('backups:export', { id: r!.versionId, includeSecrets: true })
    expect(readFileSync(full.file, 'utf8')).toContain('CANARY-PASSWORD-7f3a')
    if (process.platform !== 'win32') expect(statSync(full.file).mode & 0o777).toBe(0o600)
    // Both exports are audited, the one with secrets with its approver.
    const exports = (await call<{ kind: string; source: string; reason: string; approver: string | null }[]>('audit:list', 50)).filter((a) => a.kind === 'export')
    expect(exports.filter((a) => a.source === 'backup').map((a) => /with secrets in clear text/.test(a.reason))).toEqual([true, false])
    expect(exports[0]!.approver).toBeTruthy()
    // The sessions export (earlier test) is audited too.
    expect(exports.find((a) => a.source === 'user' && /with passwords and private keys/.test(a.reason))).toBeTruthy()
    rmSync(full.file)
    expect(() => handlers['backups:export']!.schema.parse({ id: r!.versionId, includeSecrets: false, path: '/etc/passwd' })).toThrow()
    const sched = await call<{ id: string }>('backups:saveSchedule', { kind: 'tag', target: 'core', cadence: 'weekly', weekday: 1, time: '02:30', enabled: true })
    await call('backups:schedules')
    expect(() => handlers['backups:saveSchedule']!.schema.parse({ kind: 'tag', target: 'core', cadence: 'daily', weekday: 1, time: '25:00', enabled: true })).toThrow()
    await call('backups:removeSchedule', sched.id)
    await call('backups:retention')
    await call('backups:setRetention', { keepLast: 20, maxAgeDays: 90 })
    // The canary device was not renamed: accepting a name it does not show stores nothing new.
    expect(await call<{ outcome: string }>('backups:acceptRename', { sessionId: s.id, hostname: 'not-this-one' })).toMatchObject({ outcome: expect.stringMatching(/unchanged|saved|skipped|failed/) })
    expect(() => handlers['backups:acceptRename']!.schema.parse({ sessionId: s.id, hostname: '' })).toThrow()
    await call('backups:remove', r!.versionId)
  })

  it('locking drops what main holds in clear for a pending step (#16)', async () => {
    const picked = await call<KeyImportInfo>('credentials:importKey')
    const f = await call<{ token: string }>('data:pickImport')
    await call('data:previewImport', { token: f.token, passphrase: 'CANARY-EXPORT-PASS-0b9e' })
    await call('vault:lock')
    await expect(call('credentials:save', { name: 'Late', username: 'ops', kind: 'key', keyToken: picked.token, passphrase: 'CANARY-PASSPHRASE-91c2' })).rejects.toThrow(/expired/)
    // The decrypted payload is gone too.
    await expect(call('data:applyImport', { token: f.token, mode: 'merge' })).rejects.toThrow(/expired/)
    await call('vault:unlock', 'CANARY-MASTER-PW-c4d8')
  })

  it('multi-delete is one call and one transaction (#18)', async () => {
    const a = await call<{ id: string }>('sessions:save', { name: 'del-a', folderId: null, host: '10.6.0.1', port: 22, protocol: 'ssh', platform: 'iosxe', username: '', credentialId: null, logToFile: false, notes: '', options: {} })
    const f = await call<{ id: string }>('sessions:saveFolder', { name: 'Del', parentId: null })
    await call('sessions:removeMany', { sessionIds: [a.id], folderIds: [f.id] })
    const after = await call<{ sessions: { id: string }[]; folders: { id: string }[] }>('sessions:list')
    expect(after.sessions.some((s) => s.id === a.id) || after.folders.some((x) => x.id === f.id)).toBe(false)
    expect(() => handlers['sessions:removeMany']!.schema.parse({ sessionIds: [a.id], folderIds: [], path: '/x' })).toThrow()
  })

  it('keymap and snippet channels: strict inputs, plans without secrets (Phase 4)', async () => {
    await call('keymap:set', { 'pane.splitRight': ['Ctrl+Alt+K'] })
    expect(await call('keymap:get')).toEqual({ 'pane.splitRight': ['Ctrl+Alt+K'] })
    const s = await call<{ id: string }>('snippets:save', { name: 'Brief', body: 'show ip interface brief', mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: true })
    const i = await call<{ id: string }>('snippets:save', { name: 'Ins', body: 'show interfaces {{interface}}', mode: 'insert', scope: { kind: 'global' }, platforms: [], onBar: false })
    expect(() => handlers['snippets:save']!.schema.parse({ name: 'x', body: 'y', mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: false, password: 'CANARY-PASSWORD-7f3a' })).toThrow()
    expect((await call<{ id: string }[]>('snippets:list')).map((x) => x.id)).toEqual([s.id, i.id])
    expect((await call<{ id: string }[]>('snippets:reorder', [i.id, s.id])).map((x) => x.id)).toEqual([i.id, s.id])
    const plan = await call<{ planId: string; kind: string }>('snippets:prepare', { snippetId: s.id, tabId: 'tab-ai', vars: {} })
    expect(plan.kind).toBe('read')
    // The stand-in device refuses everything: the run reports it as a failed result, not a thrown secret.
    expect(await call<{ status: string }>('snippets:run', { planId: plan.planId, approve: true })).toMatchObject({ status: 'error' })
    expect(await call('snippets:insert', { snippetId: i.id, tabId: 'tab-ai', vars: { interface: 'Gi1' } })).toMatchObject({ text: 'show interfaces Gi1' })
    await call('snippets:remove', i.id)
    expect(await call('multi:info')).toMatchObject({ parser: false })
    const listed = await call<{ sessions: { id: string }[] }>('sessions:list')
    const targets = await call<{ key: string }[]>('multi:resolve', { sessions: listed.sessions.map((x) => x.id) })
    expect(targets.length).toBeGreaterThan(0)
    expect(() => handlers['multi:resolve']!.schema.parse({ sessions: [], password: 'x' })).toThrow()
    expect(() => handlers['multi:start']!.schema.parse({ previewId: 'p', confirmConfig: true, concurrency: 99 })).toThrow()
    const p = await call<{ previewId: string }>('multi:preview', { mode: 'run', targets: { sessions: [targets[0]!.key] }, command: 'show version' })
    const { runId } = await call<{ runId: string }>('multi:start', { previewId: p.previewId, confirmConfig: false, concurrency: 2 })
    await call('multi:cancel', runId)
    await call('multi:decline', p.previewId)
  })

  it('fleet channels: strict inputs, scopes resolved in main and started by id, no device list from the renderer (F10)', async () => {
    expect(await call('fleet:info')).toMatchObject({ maxDevices: 32, maxConcurrency: 8 })
    const listed = await call<{ sessions: { id: string }[] }>('sessions:list')
    const scope = await call<{ scopeId: string; devices: { name: string; excluded?: string }[] }>('fleet:scope', { sessions: listed.sessions.map((x) => x.id) })
    expect(scope.devices.length).toBeGreaterThan(0)
    expect(() => handlers['fleet:scope']!.schema.parse({ hosts: ['10.9.9.9'] })).toThrow()
    expect(() => handlers['fleet:start']!.schema.parse({ scopeId: scope.scopeId, question: 'q', devices: ['10.9.9.9'] })).toThrow()
    expect(() => handlers['fleet:start']!.schema.parse({ scopeId: scope.scopeId, question: 'q', concurrency: 99 })).toThrow()
    // No model connected here: refused before anything runs.
    await expect(call('fleet:start', { scopeId: scope.scopeId, question: 'why is BGP down?' })).rejects.toThrow(/Connect a model first|expired|can be reached/)
    await call('fleet:cancel', 'no-such-run')
    expect(await call('fleet:cancel-lane', { runId: 'no-such-run', lane: 'core-sw1' })).toBe(false)
    expect(() => handlers['fleet:cancel-lane']!.schema.parse({ runId: 'r', lane: 'x', host: '10.9.9.9' })).toThrow()
  })

  it('fleet:mentions takes the raw text and the tab\'s session id, never a device list (F11)', async () => {
    const listed = await call<{ sessions: { id: string; name: string }[] }>('sessions:list')
    const [here, other] = listed.sessions
    const r = await call<{ question: string; errors: { message: string }[]; preview: { devices: { sessionId: string }[] } | null }>('fleet:mentions', { text: `why is bgp down here and on @"${other!.name}"`, sessionId: here!.id })
    expect(r.errors).toEqual([])
    expect(r.preview!.devices[0]!.sessionId).toBe(here!.id)
    expect(r.question).toContain(other!.name)
    const bad = await call<{ errors: { message: string }[]; preview: unknown }>('fleet:mentions', { text: 'and @10.9.9.9', sessionId: null })
    expect(bad.preview).toBeNull()
    expect(bad.errors[0]!.message).toMatch(/no saved session '10\.9\.9\.9'/)
    expect(() => handlers['fleet:mentions']!.schema.parse({ text: 'x', sessionId: null, hosts: ['10.9.9.9'] })).toThrow()
    expect(() => handlers['fleet:mentions']!.schema.parse({ text: '', sessionId: null })).toThrow()
  })

  it('blocks:rerun takes one bounded line and only inserts what is not a read', async () => {
    const r = await call<{ action: string }>('blocks:rerun', { tabId: 'tab-ai', command: 'configure terminal' })
    expect(r).toMatchObject({ action: 'insert', command: 'configure terminal' })
    expect(() => handlers['blocks:rerun']!.schema.parse({ tabId: 'tab-ai', command: 'x'.repeat(2000) })).toThrow()
    expect(() => handlers['blocks:rerun']!.schema.parse({ tabId: 'tab-ai', command: 'show version', enter: true })).toThrow()
  })

  it('snippets and blocks only reach tabs of the asking window (review Low 1)', async () => {
    const s = await call<{ id: string }>('snippets:save', { name: 'Own', body: 'show clock', mode: 'run', scope: { kind: 'global' }, platforms: [], onBar: false })
    await expect(call('snippets:prepare', { snippetId: s.id, tabId: 'tab-bg-1', vars: {} })).rejects.toThrow(/closed/)
    await expect(call('snippets:insert', { snippetId: s.id, tabId: 'tab-bg-1', vars: {} })).rejects.toThrow(/closed/)
    await expect(call('blocks:rerun', { tabId: 'tab-bg-1', command: 'show clock' })).rejects.toThrow(/No such tab/)
    // A preview made by one window can't be run by another.
    const plan = await call<{ planId: string }>('snippets:prepare', { snippetId: s.id, tabId: 'tab-ai', vars: {} })
    await expect(handlers['snippets:run']!.fn({ planId: plan.planId, approve: true } as never, { sender: {} } as never)).rejects.toThrow(/expired/)
    await call('snippets:remove', s.id)
  })

  it('updates and crash-report channels: strict inputs, no key in what they return (Phase 7)', async () => {
    await call('settings:update', { crashReports: true, crashReportDsn: 'http://abcdef0123456789@127.0.0.1:9/1' })
    expect(await call('update:status')).toMatchObject({ state: { kind: 'off', reason: 'dev' }, current: '0.7.0' })
    expect(await call('update:check')).toMatchObject({ state: { kind: 'off', reason: 'dev' } })
    expect(await call('update:restart')).toEqual({ ok: false, reason: 'not-ready' })
    const st = await call<{ target: string; enabled: boolean }>('crash:status')
    expect(st).toMatchObject({ enabled: true, target: '127.0.0.1:9 / 1', dsnSource: 'user', dumps: [] })
    expect(await call('crash:test')).toMatchObject({ ok: true, status: 200 })
    await call('crash:report', { name: 'Error', message: 'boom CANARY-PASSWORD-7f3a', stack: '', kind: 'exception' })
    expect(() => handlers['crash:report']!.schema.parse({ name: 'E', message: 'm', stack: '', kind: 'exception', extra: { a: 1 } })).toThrow()
    expect(() => handlers['crash:report']!.schema.parse({ name: 'E', message: 'x'.repeat(5000), stack: '', kind: 'exception' })).toThrow()
    expect(() => handlers['settings:update']!.schema.parse({ crashReportDsn: 'https://key:secret@sentry.io/1' })).toThrow()
    expect(await call('crash:sendDump', 'no-such-dump')).toEqual({ ok: false, reason: 'missing' })
    await expect(call('crash:sendDump', '../../etc/passwd')).rejects.toThrow()
    expect(await call('crash:deleteDump', 'no-such-dump')).toBe(false)
    expect(await call('crash:deleteAllDumps')).toBe(0)
    await call('settings:update', { crashReports: false, crashReportDsn: '' })
  })

  it('workspace chat accepts a bounded question and takes the inventory from main', async () => {
    await expect(call('workspaceChat:ask', { question: 'Where should I start?' })).rejects.toThrow(/No model/)
    await call('workspaceChat:cancel')
    await call('workspaceChat:reset')
    for (const input of [{ question: '' }, { question: 'x'.repeat(4001) }, { question: 'x', sessions: ['injected'] }]) {
      expect(() => handlers['workspaceChat:ask']!.schema.parse(input)).toThrow()
    }
  })

  it('packet actions accept bounded fields and window-owned IDs', async () => {
    const id = '5156f6d3-a7b4-49b3-9a8a-adf73b945870'
    await expect(call('packets:drop', '../file.pcap')).rejects.toThrow()
    expect(await call('packets:open', { kind: 'file' })).toBeNull()
    await expect(call('packets:open', { kind: 'download', transferId: id })).rejects.toThrow(/completed download/)
    await expect(call('packets:plan', { tabId: 'other', device: 'Gi1/0/1', seconds: 5, direction: 'both' })).rejects.toThrow(/this window/)
    await expect(call('packets:view', { id, filter: '', page: 0 })).rejects.toThrow(/current window/)
    await expect(call('packets:details', { id, frame: 1 })).rejects.toThrow(/current window/)
    await expect(call('packets:save', id)).rejects.toThrow(/current window/)
    await expect(call('packets:ask', { question: 'Where should I capture?' })).rejects.toThrow(/No model/)
    await call('packets:finish')
    await call('packets:cancel')
    await call('packets:close')
    for (const req of [{ kind: 'file', path: '/tmp/f' }, { kind: 'iosxe', planId: id, ack: 'sw1', commands: ['show clock'] },
      { kind: 'interface', device: 'lo', seconds: 121, filter: '' }]) {
      expect(() => handlers['packets:open']!.schema.parse(req)).toThrow()
    }
  })

  it('no handler result or error ever contained a canary, a key body, or a secret-named field', () => {
    // Every channel is exercised, or skipped for a stated reason: a new handler can't slip past the scan.
    const SKIP: Record<string, string> = { 'knownHosts:import': "reads the user's ~/.ssh/known_hosts (public host keys only)" }
    const missing = Object.keys(handlers).filter((c) => !called.has(c) && !SKIP[c])
    expect(missing).toEqual([])
    const secretField = /"(secret|passphrase|password|privateKey|secret_enc|passphrase_enc|apiKey)"\s*:/
    for (const { channel, value } of results) {
      // A secret prompt names which kind of secret it asks for (secret: "password"): a label, not a value.
      const raw = JSON.stringify(value ?? null)
      const json = channel === 'event prompt:ask' ? raw.replace(/"secret":"(password|passphrase)"/g, '"secretKind":"$1"') : raw
      for (const c of [...CANARIES, keyBody, 'PRIVATE KEY']) expect(json, `${channel} leaked ${c}`).not.toContain(c)
      expect(json, `${channel} has a secret field`).not.toMatch(secretField)
    }
  })
})
