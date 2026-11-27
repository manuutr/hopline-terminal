import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { EgressLog } from '../src/main/egress/store'
import { AccountClients } from '../src/main/llm/account-clients'
import { safeProvider } from '../src/main/llm/safe'
import { AiService } from '../src/main/llm/service'
import { PolicyService, parsePolicy } from '../src/main/policy/policy'
import { SettingsService } from '../src/main/settings'
import { DataKey } from '../src/main/vault/datakey'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const secret = 'only-the-vendor-should-see-this-fixture'
const fakeUrls = { chatgpt: 'https://auth.openai.com/codex/device', copilot: 'https://github.com/login/device' }

it.each(['chatgpt','copilot'] as const)('%s authorizes, restores encrypted client state, and passes only masked evidence to the CLI', async id => {
  const db = openDb(':memory:')
  const root = await mkdtemp(join(tmpdir(), 'hopline-account-test-'))
  const key = new DataKey()
  key.setKey(randomBytes(32))
  const repo = new Repo(db)
  const settings = new SettingsService(repo, key)
  const log = new EgressLog(db, key)
  let authorize!: () => void
  const consent = new Promise<void>(resolve => { authorize = resolve })
  let received = ''
  vi.stubEnv('OPENAI_API_KEY', 'ambient-key')
  vi.stubEnv('GITHUB_TOKEN', 'ambient-token')
  const accounts = new AccountClients(root, settings, async (_bin, args, opts) => {
    expect(opts.env.OPENAI_API_KEY).toBeUndefined()
    expect(opts.env.GITHUB_TOKEN).toBeUndefined()
    const home = (id === 'chatgpt' ? opts.env.CODEX_HOME : opts.env.COPILOT_HOME)!
    const stateFile = join(home, id === 'chatgpt' ? 'auth.json' : 'config.json')
    if (args[0] === 'login') {
      opts.onOutput?.(secret + ' ' + fakeUrls[id] + '\n')
      opts.onOutput?.('ABCD-1234')
      await consent
      await writeFile(stateFile, secret)
      return ''
    }
    expect(await readFile(stateFile, 'utf8')).toBe(secret)
    received = opts.input!
    if (id === 'chatgpt') {
      expect(args).toContain('permissions.hopline.filesystem={":root"="deny"}')
      return '{"type":"item.completed","item":{"type":"agent_message","text":"The link is down."}}\n{"type":"turn.completed","usage":{"input_tokens":61,"output_tokens":6}}'
    }
    expect(args).toContain('--available-tools=')
    await writeFile(args[args.indexOf('--usage-output-file') + 1]!, JSON.stringify({ modelMetrics: { fixture: { usage: { inputTokens: 61, outputTokens: 6 } } } }))
    await writeFile(join(home, 'session-store.db'), received)
    return 'The link is down.'
  }, async () => 'official-test-client')
  const ai = new AiService(settings, { accounts, egress: log })
  try {
    expect(await ai.account(id, 'start')).toMatchObject({ phase: 'starting' })
    await vi.waitFor(() => expect(accounts.status(id)).toEqual({ phase: 'authorize', code: 'ABCD-1234', verificationUrl: fakeUrls[id] }))
    expect(settings.get().connectedAccounts?.[id]).toBe(false)
    authorize()
    await vi.waitFor(() => expect(accounts.status(id).phase).toBe('connected'))
    expect(JSON.stringify(settings.get())).not.toContain(secret)
    const encrypted = repo.getSetting('account_' + id + '_dek')!
    expect(Buffer.from(encrypted, 'base64').includes(Buffer.from(secret))).toBe(false)
    expect(await readdir(root)).toEqual([])
    await ai.connect({ provider: id, model: 'Account default' })
    const provider = safeProvider(await ai.provider())
    const result = await provider.turn({
      system: 'Inspect dc-west', meta: { sessionName: 'dc-west' }, signal: new AbortController().signal, tools: [],
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'dc-west#show interface\nPort Description: Payroll transit\nGi1/2 down' }] }],
      onText: () => {}, onThinking: () => {}
    })
    expect(provider.capabilities?.tools).toBe(false)
    expect(result).toMatchObject({ stop: 'end', usage: { inputTokens: 61, outputTokens: 6 } })
    expect(received).not.toMatch(/dc-west|Payroll transit|ambient-|only-the-vendor/)
    expect(received).toContain('Gi1/2 down')
    const entry = await log.get(log.list()[0]!.id)
    expect(JSON.parse(entry!.payload!).prompt).toBe(received)
    expect(await readdir(root)).toEqual([])
    expect(await ai.account(id, 'disconnect')).toEqual({ phase: 'idle' })
    expect(await settings.accountProfile(id)).toBeNull()
    expect(settings.get().aiConfigured).toBe(false)
  } finally { accounts.close(); vi.unstubAllEnvs(); db.close(); await rm(root, { recursive: true, force: true }) }
})

it('blocks sign-in under team policy and cancels pending consent without retaining credentials', async () => {
  const db = openDb(':memory:')
  const root = await mkdtemp(join(tmpdir(), 'hopline-account-cancel-'))
  const settings = new SettingsService(new Repo(db))
  const bin = vi.fn(async () => 'fixture')
  const accounts = new AccountClients(root, settings, async (_, __, { signal, onOutput }) => {
    onOutput?.(fakeUrls.chatgpt + ' AAAA-BBBB')
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))
    return ''
  }, bin)
  try {
    for (const p of [{ allowedProviders: ['openai'] }, { requireEgressLog: true }]) {
      const policy = new PolicyService(parsePolicy(JSON.stringify({ version: 1, ...p }), '/policy.json'))
      const ai = new AiService(settings, { accounts, policy })
      expect(await ai.account('chatgpt','start')).toMatchObject({ phase: 'error' })
      expect(await ai.test({ provider: 'chatgpt', model: 'default' })).toMatchObject({ code: 'policy' })
    }
    expect(bin).not.toHaveBeenCalled()
    await mkdir(join(root, 'unrelated'))
    await accounts.action('chatgpt','start')
    await vi.waitFor(() => expect(accounts.status('chatgpt').phase).toBe('authorize'))
    expect(await accounts.action('chatgpt','cancel')).toEqual({ phase: 'idle' })
    expect(settings.get().connectedAccounts?.chatgpt).toBe(false)
    expect(await readdir(root)).toEqual(['unrelated'])
  } finally { accounts.close(); db.close(); await rm(root, { recursive: true, force: true }) }
})
