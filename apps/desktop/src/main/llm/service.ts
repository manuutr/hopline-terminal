import type { AccountClients } from './account-clients'
import { ACCOUNTS, CLOUD, isAccount, modelFor, type AccountAction, type AccountProvider, type AccountState } from '@shared/providers'
import { ChatCompletionsProvider } from './chat-completions'
import { INSECURE_ENDPOINT_WARNING, insecureAcked, isInsecureEndpoint, parseOrigin } from '@shared/ollama'
import Anthropic from '@anthropic-ai/sdk'
import type { AiHealth, AiTestRequest, AiTestResult, OllamaModelsResult } from '@shared/types'
import type { EgressLog } from '../egress/store'
import type { PolicyService } from '../policy/policy'
import type { SettingsService } from '../settings'
import { isLocked } from '../vault/datakey'
import { anthropicBaseURL, anthropicHostOf, anthropicLabel, AnthropicProvider, classifyAnthropicError, testAnthropic } from './anthropic'
import { egressProvider } from './egress'
import { listOllamaModels, modelInfo, numCtxFor, OllamaError, ollamaHealth, OllamaProvider, testOllama, type ModelInfo } from './ollama'
import type { CheckRequest, LlmProvider } from './types'

/** Thrown by `provider()` when nothing is connected; the renderer queues the question instead. */
export const NO_PROVIDER = 'No AI provider is connected yet. Connect one in the Assistant panel (a cloud API key or an Ollama model).'

/** Refusal for a remote plain-http Ollama server nobody acknowledged (L3). */
export const INSECURE_REFUSAL = `${INSECURE_ENDPOINT_WARNING} Confirm that you accept this before using it, or use https or a server on this machine.`

export interface AiServiceOptions {
  /** e2e (dev builds only) and tests: a local fake Anthropic API. */
  anthropicBaseURL?: string
  /** Tests: replace the network checks. */
  vaultLocked?: () => boolean
  accounts?: AccountClients
  cloudFetch?: typeof fetch
  testAnthropic?: typeof testAnthropic
  testOllama?: typeof testOllama
  /** Tests: replace the /api/show lookup. */
  modelInfo?: typeof modelInfo
  /** The team policy (docs/POLICY.md); none: no policy. */
  policy?: PolicyService
  /** "What left this machine": every request is recorded here (when the setting or the policy says so). */
  egress?: EgressLog
}

/** How long a model's /api/show answer is reused. */
const MODEL_INFO_TTL_MS = 5 * 60_000

/**
 * Builds the agent's provider from settings, and runs the connect checks for onboarding.
 * Keys are read here, in main, and never returned: results carry a code, a message and settings.
 */
export class AiService {
  private infoCache = new Map<string, { at: number; info: ModelInfo }>()

  constructor(
    private readonly settings: SettingsService,
    private readonly opts: AiServiceOptions = {}
  ) {}

  private policyRefusal(provider: AiTestRequest['provider'], endpoint?: string): string | null {
    return this.opts.policy?.providerRefusal(provider, endpoint) ?? null
  }

  async account(id: AccountProvider, action: AccountAction): Promise<AccountState> {
    const refusal = this.policyRefusal(id)
    if (refusal && action !== 'cancel' && action !== 'disconnect') return { phase: 'error', message: refusal }
    if (this.opts.vaultLocked?.() && action !== 'cancel' && action !== 'disconnect') return { phase: 'error', message: 'Unlock the vault to use a provider account.' }
    if (!this.opts.accounts) return { phase: 'error', message: 'Account sign-in is unavailable.' }
    return this.opts.accounts.action(id, action)
  }

  /** Tool calling and context length of the configured Ollama model (cached; unknown on an old server). */
  private async ollamaInfo(endpoint: string, model: string): Promise<ModelInfo> {
    const k = `${endpoint}\n${model}`
    const hit = this.infoCache.get(k)
    if (hit && Date.now() - hit.at < MODEL_INFO_TTL_MS) return hit.info
    let info: ModelInfo = { tools: null, contextLength: null }
    try {
      info = await (this.opts.modelInfo ?? modelInfo)(endpoint, model)
    } catch (e) {
      // A missing model fails the run with its own message; anything else: run with the defaults.
      if (e instanceof OllamaError && e.code === 'model_not_found') throw e
    }
    this.infoCache.set(k, { at: Date.now(), info })
    return info
  }

  /**
   * The provider for one run: the team policy's provider rules, then the adapter, wrapped so every
   * request is recorded in the egress log. `AgentLoop` adds `safeProvider` around it, so the log
   * sees the redacted request exactly as the adapter sends it.
   */
  async provider(): Promise<LlmProvider> {
    const s = this.settings.get()
    const refusal = this.policyRefusal(s.aiProvider, s.aiProvider === 'ollama' ? s.ollamaEndpoint : undefined)
    if (refusal) throw new Error(refusal)
    let inner: LlmProvider
    let target: { provider: string; model: string; destination: string }
    if (s.aiProvider === 'ollama') {
      if (!s.ollamaModel) throw new Error(NO_PROVIDER)
      const u = parseOrigin(s.ollamaEndpoint)
      if (!u) throw new Error('The Ollama server address must be an http:// or https:// address with no path or query. Fix it in Settings → Assistant.')
      // Enforced here, not only in the window: device output never goes to an unacknowledged
      // remote plain-http server.
      if (isInsecureEndpoint(s.ollamaEndpoint) && !insecureAcked(s.ollamaEndpoint, s.ollamaInsecureAck)) throw new Error(INSECURE_REFUSAL)
      const info = await this.ollamaInfo(s.ollamaEndpoint, s.ollamaModel)
      inner = new OllamaProvider(s.ollamaEndpoint, s.ollamaModel, { tools: info.tools, numCtx: numCtxFor(info.contextLength), contextLength: info.contextLength })
      target = { provider: 'ollama', model: s.ollamaModel, destination: u.host }
    } else if (isAccount(s.aiProvider)) {
      if (!s.connectedAccounts?.[s.aiProvider] || !this.opts.accounts) throw new Error(NO_PROVIDER)
      inner = this.opts.accounts.adapter(s.aiProvider)
      target = { provider: s.aiProvider, model: modelFor(s.aiProvider), destination: ACCOUNTS[s.aiProvider].destination }
    } else if (s.aiProvider === 'openai' || s.aiProvider === 'gemini') {
      const id = s.aiProvider
      const key = await this.settings.apiKey(id)
      if (!key) throw new Error(NO_PROVIDER)
      const model = modelFor(id, s)
      inner = new ChatCompletionsProvider(id, key, model, this.opts.cloudFetch)
      target = { provider: id, model, destination: CLOUD[id].host }
    } else {
      const key = await this.settings.apiKey()
      if (!key) throw new Error(NO_PROVIDER)
      inner = new AnthropicProvider(key, s.aiModel, { baseURL: this.opts.anthropicBaseURL })
      target = { provider: 'anthropic', model: s.aiModel, destination: this.anthropicHost() }
    }
    const required = !!this.opts.policy?.locks.egressLogRequired
    const log = s.egressLog || required ? (this.opts.egress ?? null) : null
    return egressProvider(inner, { log, required, target })
  }

  /**
   * The connect checks send a request to the model too, so each one is logged (review L4) with
   * source `check`, recorded just before it is sent (`onSend`), one row per request on the wire:
   * the Anthropic models lookup and the one-line message, the Ollama chat with a tool and, for a
   * model without tools, the plain one after it. They carry no conversation and no device output.
   * Best effort: a check that cannot be recorded (vault locked) still runs. Not logged: the health
   * check (`ai:health`: a models lookup, /api/version and /api/show, run each time the panel opens)
   * and model discovery (/api/tags, /api/show): neither sends a prompt.
   */
  private checkLog(target: { provider: string; model: string; destination: string }) {
    const required = !!this.opts.policy?.locks.egressLogRequired
    const log = this.settings.get().egressLog || required ? (this.opts.egress ?? null) : null
    let open: { id: number; t0: number } | null = null
    const close = (status: 'ok' | 'error') => {
      if (open && log) log.finish(open.id, { status, durationMs: Date.now() - open.t0, attempts: 1 })
      open = null
    }
    return {
      /** Before each request; `prevOk` closes the previous request's row. */
      onSend: async (request: CheckRequest, prevOk = true): Promise<void> => {
        close(prevOk ? 'ok' : 'error')
        if (!log) return
        try {
          open = { id: (await log.record({ ...target, source: 'check', body: request })).id, t0: Date.now() }
        } catch {
          open = null
        }
      },
      done: (ok: boolean) => close(ok ? 'ok' : 'error')
    }
  }

  private anthropicHost(): string {
    return anthropicHostOf(this.opts.anthropicBaseURL)
  }

  /** Health of the configured provider (no tokens spent: Ollama /api/version + /api/show; Anthropic models.retrieve). */
  async health(): Promise<AiHealth> {
    const s = this.settings.get()
    const refusal = this.policyRefusal(s.aiProvider, s.aiProvider === 'ollama' ? s.ollamaEndpoint : undefined)
    if (s.aiProvider === 'ollama') {
      const u = parseOrigin(s.ollamaEndpoint)
      if (refusal) return { ok: false, provider: 'ollama', destination: u?.host ?? '', local: false, model: s.ollamaModel, message: refusal, policy: refusal }
      const h = await ollamaHealth(s.ollamaEndpoint, s.ollamaModel)
      if (h.ok) this.infoCache.set(`${s.ollamaEndpoint}\n${s.ollamaModel}`, { at: Date.now(), info: { tools: h.tools ?? null, contextLength: h.contextLength ?? null } })
      return h
    }
    const id = s.aiProvider
    if (isAccount(id)) {
      const ok = !refusal && !!s.connectedAccounts?.[id] && !!this.opts.accounts
      return { provider: id, destination: ACCOUNTS[id].destination, local: false, model: modelFor(id), tools: false, ok, message: refusal ?? (ok ? 'Account connected locally. Model access is checked when you ask a question.' : 'Sign in to your account.'), ...(refusal ? { policy: refusal } : {}) }
    }
    const base = { provider: id, destination: id === 'anthropic' ? this.anthropicHost() : CLOUD[id].host, local: false, model: modelFor(id, s) }
    if (refusal) return { ...base, ok: false, message: refusal, policy: refusal }
    let key: string | undefined
    try {
      key = await this.settings.apiKey(id)
    } catch (e) {
      if (isLocked(e)) return { ...base, ok: false, message: 'The vault is locked. Unlock it to use the saved API key.' }
      throw e
    }
    if (!key) return { ...base, ok: false, message: 'No API key is saved.' }
    const t0 = Date.now()
    if (id !== 'anthropic') {
      const h = await new ChatCompletionsProvider(id, key, base.model, this.opts.cloudFetch).health()
      return { ...base, ok: h.ok, message: h.message, latencyMs: Date.now() - t0 }
    }
    try {
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000, baseURL: anthropicBaseURL(this.opts.anthropicBaseURL) })
      const info = await client.models.retrieve(s.aiModel)
      return { ...base, ok: true, tools: true, latencyMs: Date.now() - t0, message: `${info.display_name || anthropicLabel(s.aiModel)} is reachable` }
    } catch (e) {
      return { ...base, ok: false, latencyMs: Date.now() - t0, message: classifyAnthropicError(e)?.message ?? 'The Anthropic API could not be reached.' }
    }
  }

  private async cloudKey(provider: keyof typeof CLOUD, keyOverride?: string): Promise<{ key: string } | AiTestResult> {
    if (keyOverride) return { key: keyOverride }
    try {
      const key = await this.settings.apiKey(provider)
      return key ? { key } : { ok: false, code: 'no_key', message: `Enter your ${CLOUD[provider].label} API key first.` }
    } catch (e) {
      if (isLocked(e)) return { ok: false, code: 'vault_locked', message: 'The vault is locked. Unlock it to use the saved API key.' }
      throw e
    }
  }

  async test(req: AiTestRequest): Promise<AiTestResult> {
    // The policy first: an Ollama-only site never sends even the connect check to the cloud.
    const refusal = this.policyRefusal(req.provider, req.provider === 'ollama' ? (req.endpoint ?? '') : undefined)
    if (refusal) return { ok: false, code: 'policy', message: refusal }
    if (isAccount(req.provider)) {
      const connected = !!this.settings.get().connectedAccounts?.[req.provider] && !!this.opts.accounts
      return { ok: connected, code: connected ? 'ok' : 'no_key', message: connected ? 'Account connected. Commands require your approval.' : 'Sign in to your account first.', suggestMode: true }
    }
    if (req.provider === 'ollama') {
      if (!req.endpoint) return { ok: false, code: 'bad_endpoint', message: 'Enter the Ollama server address.' }
      if (!parseOrigin(req.endpoint)) return { ok: false, code: 'bad_endpoint', message: 'The Ollama server must be an http:// or https:// address (scheme, host and port only) without credentials.' }
      if (isInsecureEndpoint(req.endpoint) && !req.insecureAck && !insecureAcked(req.endpoint, this.settings.get().ollamaInsecureAck))
        return { ok: false, code: 'insecure_endpoint', message: INSECURE_REFUSAL }
      const endpoint = req.endpoint
      const c = this.checkLog({ provider: 'ollama', model: req.model, destination: parseOrigin(endpoint)!.host })
      const r = await (this.opts.testOllama ?? testOllama)(endpoint, req.model, c.onSend)
      c.done(r.ok)
      return r
    }
    const k = await this.cloudKey(req.provider, req.key)
    if (!('key' in k)) return k
    if (req.provider !== 'anthropic') {
      const id = req.provider
      const check = this.checkLog({ provider: id, model: req.model, destination: CLOUD[id].host })
      const r = await new ChatCompletionsProvider(id, k.key, req.model, this.opts.cloudFetch).check(check.onSend)
      check.done(r.ok)
      return r
    }
    const c = this.checkLog({ provider: 'anthropic', model: req.model, destination: this.anthropicHost() })
    const r = await (this.opts.testAnthropic ?? testAnthropic)(k.key, req.model, { baseURL: this.opts.anthropicBaseURL, onSend: c.onSend })
    c.done(r.ok || r.code === 'rate_limit')
    return r
  }

  /** Test, then save. A rate-limited key is valid, so it is saved too (with the rate-limit message). */
  async connect(req: AiTestRequest): Promise<AiTestResult> {
    const r = await this.test(req)
    if (!r.ok && !(req.provider === 'anthropic' && r.code === 'rate_limit')) return r
    try {
      if (isAccount(req.provider)) return { ...r, settings: this.settings.update({ aiProvider: req.provider }) }
      if (req.provider !== 'ollama') {
        if (req.key) await this.settings.setApiKey(req.key, req.provider)
        return { ...r, settings: this.settings.update({ aiProvider: req.provider, [CLOUD[req.provider].modelField]: req.model }) }
      }
      // The acknowledgement is stored bound to this exact endpoint: changing it later needs a new one.
      const ack = isInsecureEndpoint(req.endpoint!) ? (req.insecureAck || insecureAcked(req.endpoint!, this.settings.get().ollamaInsecureAck) ? req.endpoint!.trim() : '') : ''
      return { ...r, settings: this.settings.update({ aiProvider: 'ollama', ollamaEndpoint: req.endpoint!, ollamaModel: req.model, ollamaInsecureAck: ack }) }
    } catch (e) {
      if (isLocked(e)) return { ok: false, code: 'vault_locked', message: 'The key works, but the vault is locked, so it could not be saved. Unlock the vault and connect again.' }
      return { ok: false, code: 'other', message: `The key works, but could not be saved: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async ollamaModels(endpoint: string): Promise<OllamaModelsResult> {
    const refusal = this.policyRefusal('ollama', endpoint)
    if (refusal) return { ok: false, code: 'policy', error: 'policy', message: refusal }
    return listOllamaModels(endpoint)
  }
}
