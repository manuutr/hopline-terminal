import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ MessageChannelMain: class {}, utilityProcess: {}, app: { getPath: () => '/tmp' }, BrowserWindow: {}, dialog: {}, ipcMain: {}, shell: {}, nativeImage: {}, protocol: {} }))

/** Phase 8 security review fixes (scratchpad p8-security-review.md, Appendix C and D). */

const root = join(__dirname, '..')
const src = (p: string) => readFileSync(join(root, 'src', p), 'utf8')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) ? [p] : []
  })
}

describe('D-L1: the Anthropic base URL is always explicit', () => {
  it('defaults to api.anthropic.com and the egress host follows the configured URL', async () => {
    const { anthropicBaseURL, anthropicHostOf, ANTHROPIC_DEFAULT_URL } = await import('../src/main/llm/anthropic')
    expect(ANTHROPIC_DEFAULT_URL).toBe('https://api.anthropic.com')
    expect(anthropicBaseURL(undefined)).toBe('https://api.anthropic.com')
    expect(anthropicBaseURL('http://127.0.0.1:9')).toBe('http://127.0.0.1:9')
    expect(anthropicHostOf(undefined)).toBe('api.anthropic.com')
    expect(anthropicHostOf('http://127.0.0.1:9')).toBe('127.0.0.1:9')
  })
  it('every Anthropic client in main passes baseURL (never the SDK fallback to ANTHROPIC_BASE_URL)', () => {
    const files = walk(join(root, 'src/main'))
    let n = 0
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/new Anthropic\(\{[^\n]*\}\)/g)) {
        n++
        expect(m[0], f).toMatch(/baseURL: anthropicBaseURL\(/)
      }
    }
    expect(n).toBeGreaterThanOrEqual(3)
  })
})

describe('D-L6: the session host does not inherit ANTHROPIC_*', () => {
  it('strips cloud provider credentials and preserves the SSH environment', async () => {
    const { hostEnv } = await import('../src/main/host/client')
    const env = hostEnv({ ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_BASE_URL: 'http://evil', anthropic_auth_token: 't', OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'y', GOOGLE_API_KEY: 'z', SSH_AUTH_SOCK: '/tmp/agent', HOPLINE_E2E: '1', PATH: '/bin' })
    expect(env).toEqual({ SSH_AUTH_SOCK: '/tmp/agent', HOPLINE_E2E: '1', PATH: '/bin' })
  })
  it('the fork passes that environment', () => {
    expect(src('main/host/client.ts')).toMatch(/utilityProcess\.fork\([^\n]*env: hostEnv\(\)/)
  })
})

describe('D-L2 / D-L4: jump-hop username and background host-key trust', () => {
  const session = (o: Record<string, unknown>) => ({ id: 's', name: 's', host: 'h', port: 22, protocol: 'ssh', platform: 'ios', username: '', credentialId: null, logToFile: false, notes: '', options: {}, ...o })
  const settings = { get: () => ({ keepAliveSec: 0, autoReconnect: false, logDir: '/tmp', logTemplate: 'x', logTimestamps: false, logRotateDaily: false }) }

  it('a jump hop signs in with its credential username', async () => {
    const { SessionHostClient } = await import('../src/main/host/client')
    const jump = session({ id: 'j', name: 'bastion', host: 'jump', username: 'wrong', credentialId: 'c1' })
    const repo = {
      getSession: (id: string) => (id === 'j' ? jump : undefined),
      resolveCredential: async () => ({ username: 'netops', kind: 'password', secret: 'P' })
    }
    const c = new SessionHostClient(repo as never, settings as never, {} as never)
    const tab = { tabId: 't', session: session({ options: { ssh: { jump: ['j'] } } }), cols: 80, rows: 24, wc: null, generation: 0 }
    const spec = await (c as unknown as { spec: (t: unknown) => Promise<{ jump: { username: string; auth: { username: string; password?: string } }[] }> }).spec(tab)
    expect(spec.jump[0]).toMatchObject({ username: 'netops', auth: { username: 'netops', password: 'P' } })
  })

  it('a background connection that trusts a new key reports it; a user tab does not', async () => {
    const { SessionHostClient } = await import('../src/main/host/client')
    const added: string[] = []
    const repo = { hostKeys: () => [], addHostKey: (h: string, p: number, f: string) => added.push(`${h}:${p} ${f}`) }
    const c = new SessionHostClient(repo as never, settings as never, {} as never)
    const seen: unknown[] = []
    c.onBackgroundHostKey = (tab, k) => seen.push({ tab: tab?.tabId ?? null, ...k })
    const tabs = (c as unknown as { tabs: Map<string, unknown> }).tabs
    tabs.set('bg', { tabId: 'bg', session: session({ name: 'edge' }), wc: null })
    tabs.set('fg', { tabId: 'fg', session: session({ name: 'core' }), wc: {} })
    const ask = (c as unknown as { answerAsk: (m: unknown) => Promise<{ accept: boolean }> }).answerAsk.bind(c)
    expect(await ask({ t: 'ask', id: 1, tabId: 'bg', q: { kind: 'host-key', host: 'jump', port: 22, fingerprint: 'SHA256:a' } })).toMatchObject({ accept: true })
    expect(await ask({ t: 'ask', id: 2, tabId: 'fg', q: { kind: 'host-key', host: 'h', port: 22, fingerprint: 'SHA256:b' } })).toMatchObject({ accept: true })
    expect(seen).toEqual([{ tab: 'bg', host: 'jump', port: 22, fingerprint: 'SHA256:a' }])
    expect(added).toHaveLength(2)
    expect(src('main/index.ts')).toMatch(/term\.onBackgroundHostKey = /)
  })
})

describe('D-L8: background connections never forward the SSH agent', () => {
  it('the session host forces agentForward off for background specs', () => {
    expect(src('session-host/index.ts')).toContain('agentForward: spec.background ? false : o.agentForward')
  })
})

describe('C-L5: fillSnippet only reads own properties', () => {
  it('Object.prototype names are missing values, not a TypeError', async () => {
    const { fillSnippet } = await import('../src/shared/snippets')
    for (const n of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(fillSnippet(`show {{${n}}}`, {}), n).toEqual({ error: `{{${n}}} has no value` })
    }
    expect(fillSnippet('show {{constructor}}', JSON.parse('{"constructor":"x"}'))).toEqual({ text: 'show x' })
  })
})

describe('I2: dropped upload paths', () => {
  it('must be absolute, without NUL or .. segments', async () => {
    const { FilesSchemas } = await import('../src/main/ipc/files')
    const ok = (paths: string[]) => FilesSchemas.uploadDropped.safeParse({ tabId: 't', remoteDir: '/', policy: 'ask', paths }).success
    expect(ok(['/home/u/a.txt'])).toBe(true)
    expect(ok(['C:\\Users\\u\\a.txt'])).toBe(true)
    expect(ok(['a.txt'])).toBe(false)
    expect(ok(['/home/u/../../etc/passwd'])).toBe(false)
    expect(ok(['C:\\x\\..\\y'])).toBe(false)
    expect(ok(['/tmp/a\0b'])).toBe(false)
  })
})

describe('I4: DevTools and remote debugging in packaged builds', () => {
  it('devTools follows app.isPackaged and a remote-debugging switch is refused', () => {
    const s = src('main/index.ts')
    expect(s).toContain('devTools: !app.isPackaged || benchBuild')
    expect(s).toMatch(/app\.isPackaged && !benchBuild && \['remote-debugging-port', 'remote-debugging-pipe'\]/)
  })
})

describe('C-L6: wrong master passwords back off, in main', () => {
  it('after 5 wrong tries each further one adds a growing wait; the right password resets it', async () => {
    const { Vault } = await import('../src/main/vault/vault')
    const { WrongPasswordError } = await import('../src/main/vault/kdf')
    const m = new Map<string, string>()
    let t = 1_000_000
    const keychain = { backend: () => 'fake', available: async () => true, seal: async (b: Buffer) => Buffer.from(b), unseal: async (b: Buffer) => Buffer.from(b) }
    const vault = new Vault({ settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) }, keychain, kdf: { N: 2 ** 10, r: 8, p: 1 }, now: () => t })
    await vault.init()
    await vault.setMode('master', { password: 'correct-horse' })
    vault.lock()
    for (let i = 0; i < 5; i++) await expect(vault.unlock('nope-nope')).rejects.toBeInstanceOf(WrongPasswordError)
    // Blocked now, even for the right password, and without running scrypt.
    await expect(vault.unlock('correct-horse')).rejects.toThrow(/Try again in 1 s/)
    t += 1000
    await expect(vault.unlock('nope-nope')).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(vault.unlock('nope-nope')).rejects.toThrow(/Try again in 2 s/)
    // changePassword and the other checks share the counter.
    await expect(vault.changePassword('correct-horse', 'another-pass')).rejects.toThrow(/Try again/)
    t += 2000
    await vault.unlock('correct-horse')
    expect(vault.info().locked).toBe(false)
    vault.lock()
    await expect(vault.unlock('nope-nope')).rejects.toBeInstanceOf(WrongPasswordError)
    await vault.unlock('correct-horse')
  })
})

/** Core IPC handlers on a throwaway profile; `answer` decides each native confirmation. */
async function core(answer: (message: string) => boolean, fetchImpl?: (url: string) => unknown) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { openDb } = await import('../src/main/db')
  const { Repo } = await import('../src/main/db/repo')
  const { AuditLog } = await import('../src/main/db/audit')
  const { Vault } = await import('../src/main/vault/vault')
  const { SettingsService } = await import('../src/main/settings')
  const { ScrollbackStore } = await import('../src/main/store/scrollback')
  const { UnlockBroker } = await import('../src/main/vault/unlock')
  const { FolderSync } = await import('../src/main/backup/sync')
  const { coreHandlers } = await import('../src/main/ipc')
  const dir = mkdtempSync(join(tmpdir(), 'p8-'))
  const m = new Map<string, string>()
  const FAST = { N: 2 ** 10, r: 8, p: 1 }
  const vault = new Vault({ settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) }, keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) }, kdf: FAST })
  await vault.init()
  const db = openDb(join(dir, 'h.db'))
  const repo = new Repo(db, vault.key)
  const asked: string[] = []
  const handlers = coreHandlers({
    repo,
    settings: new SettingsService(repo, vault.key),
    audit: new AuditLog(db),
    scrollback: new ScrollbackStore(join(dir, 'sb'), vault.key),
    vault,
    unlock: new UnlockBroker(vault, () => {}),
    sync: new FolderSync(repo, vault.key, { debounceMs: 10, kdf: FAST }),
    kdf: FAST,
    pickers: {
      openKeyFile: async () => null,
      saveExport: async () => null,
      openExport: async () => null,
      pickDir: async () => null,
      openImport: async () => null,
      sshConfigPath: () => '/nonexistent',
      confirm: async (message) => (asked.push(message), answer(message))
    },
    fetch: (async (url: string) => fetchImpl?.(url) ?? { ok: true, status: 200, json: async () => ({ count: 0, next: null, results: [] }) }) as never
  })
  const call = <T>(ch: string, arg?: unknown) => Promise.resolve(handlers[ch]!.fn(handlers[ch]!.schema.parse(arg) as never, {} as never)) as Promise<T>
  return { call, asked, repo }
}

describe('C-L1: a stored credential goes only where the user agreed', () => {
  const sess = (o: Record<string, unknown>) => ({ name: 'x', folderId: null, host: '10.0.0.1', port: 22, protocol: 'ssh', platform: 'ios', username: '', credentialId: null, logToFile: false, notes: '', ...o })
  type Saved = { id: string; credentialId: string | null; options: { ssh?: { agentForward?: boolean } } }

  it('retargeting a session that has a credential asks; declining detaches the credential', async () => {
    let yes = false
    const { call, asked } = await core(() => yes)
    const c = await call<{ id: string }>('credentials:save', { name: 'ops', username: 'netops', kind: 'password', secret: 'P' })
    // First binding of a credential just created: no question.
    const s = await call<Saved>('sessions:save', sess({ credentialId: c.id }))
    expect(s.credentialId).toBe(c.id)
    expect(asked).toEqual([])
    // Rename, same destination: no question either.
    await call('sessions:save', sess({ id: s.id, name: 'renamed', credentialId: c.id }))
    expect(asked).toEqual([])
    // The review's repro: the host changes, the credential stays. Declined → saved without it.
    const moved = await call<Saved>('sessions:save', sess({ id: s.id, host: 'attacker.example', credentialId: c.id }))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/Use the saved credential "ops" with attacker\.example:22\?/)
    expect(moved.credentialId).toBeNull()
    // A brand-new session pointing the same credential somewhere new asks too; agreed → kept.
    yes = true
    const other = await call<Saved>('sessions:save', sess({ host: '10.0.0.2', credentialId: c.id }))
    expect(asked).toHaveLength(2)
    expect(other.credentialId).toBe(c.id)
    // A port or protocol change is a new destination.
    yes = false
    expect((await call<Saved>('sessions:save', sess({ id: other.id, host: '10.0.0.2', port: 2222, credentialId: c.id }))).credentialId).toBeNull()
  })

  it('bulk edit attaching a credential asks once; declining drops only the credential', async () => {
    const { call, asked } = await core(() => false)
    const c = await call<{ id: string }>('credentials:save', { name: 'ops', username: 'netops', kind: 'password', secret: 'P' })
    await call('sessions:save', sess({ credentialId: c.id }))
    const a = await call<Saved>('sessions:save', sess({ host: 'a.example' }))
    const b = await call<Saved>('sessions:save', sess({ host: 'b.example' }))
    const out = await call<(Saved & { favorite: boolean })[]>('sessions:bulkUpdate', { ids: [a.id, b.id], patch: { credentialId: c.id, favorite: true } })
    expect(asked).toEqual([expect.stringMatching(/with 2 sessions\?/)])
    expect(out.map((x) => [x.credentialId, x.favorite])).toEqual([[null, true], [null, true]])
  })

  it('turning on agent forwarding asks; declining saves it off', async () => {
    const { call, asked } = await core(() => false)
    const s = await call<Saved>('sessions:save', sess({ options: { ssh: { agentForward: true } } }))
    expect(asked).toEqual([expect.stringMatching(/Forward your SSH agent to 10\.0\.0\.1\?/)])
    expect(s.options.ssh?.agentForward).toBe(false)
  })
})

describe('D-L3: a NetBox token over plain http needs a native yes', () => {
  it('refuses remote http until agreed, remembers the server, never asks for https or loopback', async () => {
    let yes = false
    const urls: string[] = []
    const { call, asked } = await core(() => yes, (u) => void urls.push(u))
    const req = (url: string) => ({ url, flavor: 'netbox', filter: '', token: 'T' })
    await expect(call('importer:fetchNetBox', req('http://netbox.lab'))).rejects.toThrow(/plain http/)
    expect(urls).toEqual([])
    expect(asked).toEqual([expect.stringMatching(/over plain http/)])
    yes = true
    await call('importer:fetchNetBox', req('http://netbox.lab'))
    await call('importer:fetchNetBox', req('http://netbox.lab/'))
    expect(asked).toHaveLength(2)
    await call('importer:fetchNetBox', req('https://netbox.lab'))
    await call('importer:fetchNetBox', req('http://127.0.0.1:8000'))
    expect(asked).toHaveLength(2)
    expect(urls.length).toBeGreaterThanOrEqual(4)
  })
})

describe('D-L5: an older sync file copied back is flagged', () => {
  it('olderThanNewest is set for a file sealed before the newest written here', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { openDb } = await import('../src/main/db')
    const { Repo } = await import('../src/main/db/repo')
    const { Vault } = await import('../src/main/vault/vault')
    const { FolderSync, SYNC_FILE } = await import('../src/main/backup/sync')
    const dir = mkdtempSync(join(tmpdir(), 'p8-sync-'))
    const m = new Map<string, string>()
    const FAST = { N: 2 ** 10, r: 8, p: 1 }
    const vault = new Vault({ settings: { getSetting: (k) => m.get(k), setSetting: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) }, keychain: { backend: () => 'fake', available: async () => true, seal: async (b) => Buffer.from(b), unseal: async (b) => Buffer.from(b) }, kdf: FAST })
    await vault.init()
    const repo = new Repo(openDb(join(dir, 'a.db')), vault.key)
    const sync = new FolderSync(repo, vault.key, { debounceMs: 10, kdf: FAST })
    const syncDir = mkdtempSync(join(dir, 'folder-'))
    await sync.enable(syncDir, 'sync-passphrase', false)
    const old = readFileSync(join(syncDir, SYNC_FILE))
    await new Promise((r) => setTimeout(r, 15))
    repo.saveSession({ name: 'sw9', folderId: null, host: '10.9.9.9', port: 22, protocol: 'ssh', platform: 'ios', username: '', credentialId: null, logToFile: false, notes: '', options: {} })
    await sync.write(true)
    writeFileSync(join(syncDir, SYNC_FILE), old)
    await sync.check()
    expect(sync.status().incoming).not.toBeNull()
    const inc = await sync.readIncoming()
    expect(sync.olderThanNewest(inc.createdAt)).toBeGreaterThan(inc.createdAt)
    sync.stop()
    // The import handler asks natively before applying it (and refuses on Cancel).
    expect(src('main/ipc/index.ts')).toMatch(/sync\.olderThanNewest\(p\.createdAt\)[\s\S]{0,200}pickers\.confirm\(\s*'Import an older sync file\?'/)
  })
})

describe('I1: IPC schemas refuse unknown keys', () => {
  it('sessions:save drops the read-only Session fields, refuses anything else; export files stay lenient', async () => {
    const S = await import('../src/main/ipc/schemas')
    const base = { name: 'r1', folderId: null, host: 'h', port: 22, protocol: 'ssh', platform: 'ios', username: '', credentialId: null, logToFile: false, notes: '' }
    const out = S.SessionInput.parse({ ...base, lastConnectedAt: 1, ephemeral: false, detected: null })
    expect(out).not.toHaveProperty('lastConnectedAt')
    expect(out).not.toHaveProperty('detected')
    expect(() => S.SessionInput.parse({ ...base, evil: 1 })).toThrow()
    const payload = { format: 'hopline-data', version: 1, exportedAt: 0, includesSecrets: false, folders: [], credentials: [], knownHosts: [], sessions: [{ ...base, id: 's1', futureField: 'x' }] }
    expect(S.ImportPayload.safeParse(payload).success).toBe(true)
  })
  it.each(['FolderInput', 'CredentialInput', 'AgentRequest', 'Move', 'MoveMany', 'BulkUpdate', 'TermOpen', 'TermReconnect', 'PromptAnswer', 'ScrollbackSave', 'HostPort', 'Decide', 'VaultSetMode', 'ChangePassword', 'ExportRequest', 'ImportPreviewRequest', 'ImportApply', 'SyncEnable', 'ImportPick', 'ImportPlanRequest', 'ImportApplyRequest', 'NetBoxFetch', 'SaveEphemeral'])('%s refuses an unknown key', async (name) => {
    const S = (await import('../src/main/ipc/schemas')) as unknown as Record<string, { safeParse: (x: unknown) => { success: boolean; error?: { issues: { code: string }[] } } }>
    const r = S[name]!.safeParse({ __p8_unknown__: 1 })
    expect(r.success).toBe(false)
    expect(r.error!.issues.map((i) => i.code), name).toContain('unrecognized_keys')
  })
})

describe('M4: app:// renderer, strict CSP, file:// fused off', () => {
  it('the index.html meta CSP is the one main serves, with no file:, http or blob: sources', async () => {
    const { RENDERER_CSP } = await import('../src/main/app-protocol')
    const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
    expect(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1]).toBe(RENDERER_CSP)
    for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "worker-src 'self'", "script-src 'self';"]) expect(RENDERER_CSP).toContain(d)
    expect(RENDERER_CSP).not.toMatch(/file:|https?:|blob:|ws:|unsafe-eval/)
  })
  it('resolveAppPath serves only files under the renderer directory', async () => {
    const { resolveAppPath } = await import('../src/main/app-protocol')
    const r = join(root, 'out', 'renderer')
    expect(resolveAppPath(r, 'app://hopline/index.html')).toBe(join(r, 'index.html'))
    expect(resolveAppPath(r, 'app://hopline/')).toBe(join(r, 'index.html'))
    expect(resolveAppPath(r, 'app://hopline/assets/index-x.js?v=1#h')).toBe(join(r, 'assets', 'index-x.js'))
    expect(resolveAppPath(r, 'app://hopline/assets/a%20b.woff2')).toBe(join(r, 'assets', 'a b.woff2'))
    for (const bad of [
      'app://hopline/../../etc/passwd',
      'app://hopline/%2e%2e/%2e%2e/etc/passwd',
      'app://hopline/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'app://hopline/..%2f..%2fetc/passwd',
      'app://hopline/..%5c..%5cwindows',
      'app://hopline/a%00.js',
      'app://hopline/%E0%A4%A',
      'app://evil/index.html',
      'app://hopline:1/index.html',
      'app://u:p@hopline/index.html',
      'file:///etc/passwd',
      'app://hopline//etc/passwd',
      'not a url'
    ]) {
      // Refused, or (when the URL parser already collapsed the dots) still inside the renderer directory.
      const got = resolveAppPath(r, bad)
      expect(got === null || (got.startsWith(r + sep) && !got.includes('..')), bad).toBe(true)
    }
  })
  it('the app:// handler serves files with their type and the CSP, and 404s symlinks out and missing files', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const electron = (await import('electron')) as unknown as { protocol: { handle?: (s: string, fn: (r: Request) => Promise<Response>) => void } }
    let fn: ((r: Request) => Promise<Response>) | undefined
    electron.protocol.handle = (_s, f) => void (fn = f)
    const { serveApp, RENDERER_CSP } = await import('../src/main/app-protocol')
    const base = mkdtempSync(join(tmpdir(), 'p8-app-'))
    const r = join(base, 'renderer')
    mkdirSync(join(r, 'assets'), { recursive: true })
    writeFileSync(join(r, 'index.html'), '<!doctype html>')
    writeFileSync(join(r, 'assets', 'a.js'), 'export {}')
    writeFileSync(join(base, 'secret.txt'), 'SECRET')
    symlinkSync(join(base, 'secret.txt'), join(r, 'assets', 'link.js'))
    serveApp(r)
    const get = (u: string) => fn!(new Request(u))
    const page = await get('app://hopline/index.html')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/^text\/html/)
    expect(page.headers.get('content-security-policy')).toBe(RENDERER_CSP)
    expect((await get('app://hopline/assets/a.js')).headers.get('content-type')).toMatch(/^text\/javascript/)
    expect((await get('app://hopline/assets/link.js')).status).toBe(404)
    expect((await get('app://hopline/assets/nope.js')).status).toBe(404)
    expect((await get('app://hopline/%2e%2e/secret.txt')).status).toBe(404)
    expect((await get('app://other/index.html')).status).toBe(404)
  })
  it('GrantFileProtocolExtraPrivileges is fused off on every platform', () => {
    const { fuseValues } = require(join(root, 'scripts/fuses.cjs')) as { fuseValues: (p: string) => Record<string, boolean> }
    for (const p of ['linux', 'win32', 'darwin']) expect(fuseValues(p)['GrantFileProtocolExtraPrivileges'], p).toBe(false)
  })
  it('main loads app://hopline, never file://, and locks navigation, windows, webviews and permissions', () => {
    const s = src('main/index.ts')
    expect(s).not.toContain('loadFile(')
    expect(s).toContain('void win.loadURL(APP_INDEX')
    expect(s).toContain("wc.setWindowOpenHandler(() => ({ action: 'deny' }))")
    for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) expect(s).toContain(`wc.on('${ev}'`)
    expect(s).not.toContain('shell.openExternal')
    expect(s).toContain("new Set(['clipboard-read', 'clipboard-sanitized-write'])")
    expect(s).toContain('setDevicePermissionHandler(() => false)')
  })
})

describe('C-L4: IPC only from the main frame of the app page', () => {
  it('trustedSender refuses subframes, missing frames, other pages, and everything before setTrustedPage', async () => {
    const { setTrustedPage, trustedSender } = await import('../src/main/ipc/sender')
    const main = { parent: null, url: 'app://hopline/index.html#/settings', processId: 4, routingId: 1 }
    const wc = { mainFrame: main }
    const ev = (f: unknown) => ({ sender: wc, senderFrame: f }) as never
    expect(trustedSender(ev(main))).toBe(false)
    setTrustedPage((u) => u.protocol === 'app:' && u.host === 'hopline' && u.pathname === '/index.html')
    expect(trustedSender(ev(main))).toBe(true)
    expect(trustedSender(ev(null))).toBe(false)
    expect(trustedSender(ev({ ...main, parent: main }))).toBe(false)
    expect(trustedSender(ev({ ...main, routingId: 2 }))).toBe(false)
    expect(trustedSender(ev({ ...main, url: 'file:///home/u/evil.html' }))).toBe(false)
    expect(trustedSender(ev({ ...main, url: 'app://hopline/other.html' }))).toBe(false)
    setTrustedPage(() => false)
  })
  it('handle() and both ipcMain.on channels check the sender', () => {
    expect(src('main/ipc/index.ts')).toMatch(/if \(!trustedSender\(e\)\) throw new Error/)
    expect(src('main/ipc/files.ts')).toMatch(/'transfer:dragOut', \(e, id: unknown\) => \{\n\s+if \(!trustedSender\(e\)\) return/)
    expect(src('main/flush.ts')).toContain('trustedSender(e)) done()')
  })
})

describe('I6: agent events go to the owning window only', () => {
  it('index.ts no longer broadcasts agent:event', () => {
    const s = src('main/index.ts')
    expect(s).not.toContain("broadcast('agent:event'")
    expect(s).toContain("wc.send('agent:event', e)")
  })
})
