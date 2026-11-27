import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { ACCOUNTS, type AccountAction, type AccountProvider, type AccountState } from '@shared/providers'
import type { SettingsService } from '../settings'
import { fitContext } from './context'
import type { LlmProvider, TurnRequest, TurnResult } from './types'

type Options = { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string; onOutput?: (chunk: string) => void }
type Execute = (bin: string, args: string[], opts: Options) => Promise<string>
const verificationUrls = { chatgpt: 'https://auth.openai.com/codex/device', copilot: 'https://github.com/login/device' }
const loginLimit = 15 * 60_000

/** Run the official executable directly. Only the parsed answer or a fixed error can leave main. */
const execute: Execute = (bin, args, { cwd, env, signal, input, onOutput }) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  const child: ChildProcessWithoutNullStreams = spawn(bin, args, { cwd, env, shell: false, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' })
  let text = '', size = 0, oversized = false
  const stop = () => {
    if (!child.pid) return
    try {
      if (process.platform === 'win32') {
        spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      } else process.kill(-child.pid, 'SIGKILL')
    } catch { child.kill() }
  }
  signal.addEventListener('abort', stop, { once: true })
  const read = (data: string, stdout: boolean) => {
    size += Buffer.byteLength(data)
    if (size > 2 * 1024 * 1024) {
      if (!oversized) stop()
      oversized = true
      return
    }
    if (onOutput) onOutput(data)
    else if (stdout) text += data
  }
  child.stdout.setEncoding('utf8').on('data', chunk => read(chunk, true))
  child.stderr.setEncoding('utf8').on('data', chunk => read(chunk, false))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  child.once('error', () => {
    signal.removeEventListener('abort', stop)
    reject(new Error('The provider client could not start. Check its installation.'))
  })
  child.once('close', code => {
    signal.removeEventListener('abort', stop)
    if (signal.aborted) reject(new Error('The request was cancelled or timed out.'))
    else if (oversized || code !== 0) reject(new Error('The provider client did not complete the request. Check your sign-in, subscription, and CLI version.'))
    else resolve(text)
  })
})

async function findClient(id: AccountProvider): Promise<string> {
  const command = ACCOUNTS[id].command
  const win = process.platform === 'win32'
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs.filter(isAbsolute)) {
    const paths = [join(dir, command + (win ? '.exe' : ''))]
    if (win) {
      // npm's .cmd shim requires a shell. Prefer the native executable it installs.
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
      if (id === 'copilot') paths.push(join(dir, 'node_modules', '@github', 'copilot', 'node_modules', '@github', 'copilot-win32-' + architecture, 'copilot.exe'))
      else {
        const triple = (architecture === 'arm64' ? 'aarch64' : 'x86_64') + '-pc-windows-msvc'
        paths.push(join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-' + architecture, 'vendor', triple, 'codex', 'codex.exe'))
      }
    }
    for (const file of paths) {
      try { await access(file, constants.X_OK); return file } catch { /* Try the next installed location. */ }
    }
  }
  throw new Error(`Install ${ACCOUNTS[id].client} and make its executable available to Hopline.`)
}

function environment(id: AccountProvider, profile: string): NodeJS.ProcessEnv {
  // Dedicated home and provider config. Never inherit API keys, SSH agents, personal CLI
  // config, custom model endpoints, plugins, Node preload scripts, or GitHub tokens.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH','SystemRoot','WINDIR','COMSPEC','TMP','TEMP','TMPDIR','LANG','Display','DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return {
    ...env, HOME: profile, USERPROFILE: profile, APPDATA: join(profile, 'config'), LOCALAPPDATA: join(profile, 'local'),
    XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'), XDG_CACHE_HOME: join(profile, 'cache'),
    GH_CONFIG_DIR: join(profile, 'gh'), NO_COLOR: '1', DO_NOT_TRACK: '1',
    ...(id === 'chatgpt' ? { CODEX_HOME: join(profile, 'client') } : { COPILOT_HOME: join(profile, 'client'), COPILOT_CACHE_HOME: join(profile, 'cache') })
  }
}

const codexFlags = [
  'exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
  '-c', 'default_permissions="hopline"', '-c', 'permissions.hopline.filesystem={":root"="deny"}',
  '-c', 'permissions.hopline.network.enabled=false', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
  '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'include_environment_context=false',
  '-c', 'cli_auth_credentials_store="file"', '-c', 'project_doc_max_bytes=0', '-c', 'forced_login_method="chatgpt"',
  ...['shell_tool','unified_exec','plugins','hooks','browser_use','image_generation','view_image','goals','multi_agent','multi_agent_v2'].flatMap(f => ['--disable', f]),
  '-'
]
const copilotFlags = [
  '--silent', '--stream', 'off', '--no-auto-update', '--no-custom-instructions', '--no-ask-user',
  '--disable-builtin-mcps', '--available-tools=', '--deny-tool=shell', '--deny-tool=write', '--deny-tool=read', '--sync-session=off', '--log-level', 'none'
]

async function copilotUsage(file: string): Promise<TurnResult['usage']> {
  const stat = await lstat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > 256 * 1024) return undefined
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    let inputTokens = 0, outputTokens = 0
    for (const item of Object.values(data.modelMetrics ?? {}) as { usage?: { inputTokens?: number; outputTokens?: number } }[]) {
      const usage = item.usage
      if (typeof usage?.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
    }
    return { inputTokens, outputTokens }
  } catch { return undefined }
}

export class AccountClients {
  private sessions = new Map<AccountProvider, { state: AccountState; abort: AbortController; done: Promise<void> }>()
  private queue = new Map<AccountProvider, Promise<void>>()
  private closed = false
  private disconnecting = new Set<AccountProvider>()
  private running = new Map<AccountProvider, Set<AbortController>>()
  private readonly cleanup: Promise<void>

  constructor(private readonly root: string, private readonly settings: SettingsService, private readonly run = execute, private readonly locate = findClient) {
    // A hard process exit can interrupt finally. Only remove our private run directories.
    this.cleanup = readdir(root, { withFileTypes: true }).then(async entries => {
      await Promise.all(entries.filter(e => e.isDirectory() && /^run-[A-Za-z0-9]{6}$/.test(e.name)).map(e => rm(join(root, e.name), { recursive: true, force: true })))
    }).catch(e => { if (e.code !== 'ENOENT') throw e })
    void this.cleanup.catch(() => {})
  }

  private async exclusive<T>(id: AccountProvider, work: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(id) ?? Promise.resolve()).then(work)
    const tail = next.then(() => {}, () => {})
    this.queue.set(id, tail)
    try { return await next } finally { if (this.queue.get(id) === tail) this.queue.delete(id) }
  }

  private async withProfile<T>(id: AccountProvider, login: boolean, signal: AbortSignal, work: (ctx: { bin: string; cwd: string; env: NodeJS.ProcessEnv }) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    await this.cleanup
    const bin = await this.locate(id)
    const stored = login ? null : await this.settings.accountProfile(id)
    if (!login && !stored) throw new Error('Sign in to your account first.')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const profile = await mkdtemp(join(this.root, 'run-'))
    const client = join(profile, 'client'), cwd = join(profile, 'work')
    // Only these vendor-owned login files survive the run. The entire temporary CLI home
    // (including history, SQLite indexes, caches and logs) is removed in finally.
    const files = id === 'chatgpt' ? ['auth.json'] : ['config.json', 'auth.json']
    try {
      await mkdir(client, { mode: 0o700 })
      await mkdir(cwd, { mode: 0o700 })
      if (id === 'copilot') {
        await writeFile(join(client, 'settings.json'), JSON.stringify({ storeTokenPlaintext: true, disableAllHooks: true, commandHistoryMaxSize: 0 }), { mode: 0o600 })
      }
      if (stored) {
        const state = JSON.parse(stored.toString('utf8'))
        for (const name of files) if (typeof state[name] === 'string') await writeFile(join(client, name), state[name], { mode: 0o600 })
      }
      signal.throwIfAborted()
      const result = await work({ bin, cwd, env: environment(id, profile) })
      signal.throwIfAborted()
      const state: Record<string, string> = {}
      for (const name of files) {
        const path = join(client, name)
        const stat = await lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e })
        if (!stat) continue
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('The provider returned invalid account storage.')
        state[name] = await readFile(path, 'utf8')
      }
      if (!Object.keys(state).length) throw new Error('The provider did not save a signed-in account. Try signing in again.')
      const bytes = Buffer.from(JSON.stringify(state))
      if (!stored?.equals(bytes)) await this.settings.saveAccountProfile(id, bytes)
      return result
    } finally {
      await rm(profile, { force: true, recursive: true })
    }
  }

  status(id: AccountProvider): AccountState {
    const state = this.sessions.get(id)?.state
    if (state && state.phase !== 'connected') return state
    return { phase: this.settings.get().connectedAccounts?.[id] ? 'connected' : 'idle' }
  }

  async action(id: AccountProvider, action: AccountAction): Promise<AccountState> {
    if (action === 'status') return this.status(id)
    if (action === 'disconnect') {
      this.disconnecting.add(id)
      for (const abort of this.running.get(id) ?? []) abort.abort()
    }
    if (action === 'disconnect' || action === 'cancel') this.sessions.get(id)?.abort.abort()
    try { return await this.exclusive(id, () => this.changeAccount(id, action)) }
    finally { if (action === 'disconnect') this.disconnecting.delete(id) }
  }

  private async changeAccount(id: AccountProvider, action: AccountAction): Promise<AccountState> {
    if (this.closed) return { phase: 'idle' }
    const current = this.sessions.get(id)
    if (action === 'cancel' || action === 'disconnect') {
      current?.abort.abort()
      await current?.done
      this.sessions.delete(id)
      if (action === 'disconnect') {
        await this.settings.saveAccountProfile(id, null)
      }
      return this.status(id)
    }
    if (this.settings.get().connectedAccounts?.[id]) return { phase: 'connected' }
    if (current && ['starting','authorize'].includes(current.state.phase)) return current.state
    const session = { state: { phase: 'starting' } as AccountState, abort: new AbortController(), done: Promise.resolve() }
    this.sessions.set(id, session)
    session.done = (async () => {
      try {
        const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(loginLimit)])
        let tail = ''
        const onOutput = (chunk: string) => {
          tail = (tail + stripVTControlCharacters(chunk)).slice(-8192)
          const code = tail.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0]
          if (code && tail.includes(verificationUrls[id])) session.state = { phase: 'authorize', code, verificationUrl: verificationUrls[id] }
        }
        const args = id === 'chatgpt' ? ['login','--device-auth','-c','cli_auth_credentials_store="file"'] : ['login','--device-code','--host','https://github.com']
        await this.withProfile(id, true, signal, ctx => this.run(ctx.bin, args, { ...ctx, signal, onOutput }))
        signal.throwIfAborted()
        session.state = { phase: 'connected' }
      } catch (e) {
        session.state = session.abort.signal.aborted ? { phase: 'idle' } : { phase: 'error', message: e instanceof Error ? e.message : 'Sign-in failed.' }
      }
    })()
    return session.state
  }

  adapter(id: AccountProvider): LlmProvider {
    return {
      id, logsWire: false, capabilities: { tools: false, maxContext: 32_000 },
      turn: (req: TurnRequest): Promise<TurnResult> => this.exclusive(id, async () => {
        req.signal.throwIfAborted()
        if (this.closed) throw new Error('Hopline is closing.')
        if (this.disconnecting.has(id) || !this.settings.get().connectedAccounts?.[id]) throw new Error('Sign in to the provider in Assistant settings.')
        const abort = new AbortController()
        const active = this.running.get(id) ?? new Set<AbortController>()
        active.add(abort)
        this.running.set(id, active)
        const signal = AbortSignal.any([req.signal, abort.signal])
        try {
          const { messages } = fitContext(req.system, req.messages, [], 32_000)
          const prompt = JSON.stringify({ instructions: req.system, conversation: messages.map(m => ({ role: m.role, parts: m.parts.map(p => p.type === 'text' ? { text: p.text } : p.type === 'tool_result' ? { result: p.content } : { tool: p.name, input: p.input }) })) })
          const { out, counts } = await this.withProfile(id, false, signal, async ctx => {
            await req.beforeSend?.({ client: ACCOUNTS[id].client, prompt })
            signal.throwIfAborted()
            req.onAttempt?.()
            const usageFile = join(ctx.cwd, 'usage.json')
            const args = id === 'chatgpt' ? codexFlags : [...copilotFlags, '--usage-output-file', usageFile]
            const out = await this.run(ctx.bin, args, { ...ctx, input: prompt, signal })
            return { out, counts: id === 'copilot' ? await copilotUsage(usageFile) : undefined }
          })
          let answer = out.trim(), usage: TurnResult['usage'] = counts
          if (id === 'chatgpt') {
            answer = ''
            let complete = false
            for (const line of out.split('\n').filter(Boolean)) {
              let event
              try { event = JSON.parse(line) } catch { throw new Error('Codex returned an unreadable response.') }
              if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text
              if (event.type === 'turn.completed') {
                complete = true
                if (Number.isSafeInteger(event.usage?.input_tokens) && Number.isSafeInteger(event.usage?.output_tokens)) usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens }
              }
            }
            if (!complete) throw new Error('Codex did not finish its answer.')
          }
          if (!answer) throw new Error('The provider returned an empty answer.')
          req.onText(answer)
          return { message: { role: 'assistant', parts: [{ type: 'text', text: answer }] }, stop: 'end', usage }
        } finally {
          active.delete(abort)
        }
      })
    }
  }

  close(): void {
    this.closed = true
    this.interrupt()
  }

  interrupt(): void {
    for (const session of this.sessions.values()) session.abort.abort()
    for (const runs of this.running.values()) for (const abort of runs) abort.abort()
  }
}
