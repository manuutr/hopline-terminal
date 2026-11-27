import { CLOUD, CLOUD_PROVIDERS, isAccount, providerAllowed, providerName, type AccountProvider, type CloudProvider } from '@shared/providers'
import { app } from 'electron'
import { join } from 'node:path'
import { insecureAcked, isInsecureEndpoint } from '@shared/ollama'
import { DEFAULT_OLLAMA_ENDPOINT, type DerivedSettings, type Settings, type SettingsPatch } from '@shared/types'
import { DEFAULT_LOG_TEMPLATE } from '../session-host/logger'
import type { Repo, SecretCipher } from './db/repo'
import type { PolicyLocks } from '@shared/policy'
import { clampRunBudget, DEFAULT_RUN_TOKEN_BUDGET } from './agent/run-budget'

const DEFAULTS: Omit<Settings, DerivedSettings | 'logDir'> = {
  theme: 'dark',
  reduceMotion: false,
  termSmoothCaret: false,
  termLigatures: false,
  aiReadOnly: true,
  aiProvider: 'anthropic',
  aiModel: CLOUD.anthropic.defaultModel,
  openaiModel: CLOUD.openai.defaultModel,
  geminiModel: CLOUD.gemini.defaultModel,
  ollamaEndpoint: DEFAULT_OLLAMA_ENDPOINT,
  ollamaModel: '',
  ollamaInsecureAck: '',
  aiIntroDismissed: false,
  commandTimeoutMs: 30_000,
  outputCapBytes: 512 * 1024,
  keepAliveSec: 30,
  filesOnConnect: false,
  autoReconnect: true,
  termHighlight: true,
  termAutocomplete: true,
  termFontFamily: '',
  termFontSize: 13,
  termLineHeight: 1.2,
  termCursorStyle: 'bar',
  termCursorBlink: true,
  termScrollback: 20_000,
  termTheme: 'auto',
  termRestoreScrollback: true,
  termScreenReader: false,
  a11yOfferAnswered: false,
  logTemplate: DEFAULT_LOG_TEMPLATE,
  logTimestamps: false,
  logRotateDaily: true,
  aiRunTokenBudget: DEFAULT_RUN_TOKEN_BUDGET,
  egressLog: true,
  notifyApprovals: true,
  notifyDisconnects: true,
  updateAutoCheck: true,
  updateChannel: 'stable',
  crashReports: false,
  crashReportDsn: '',
  privacyReviewed: false
}

/** Thrown by `update` when a patch tries to change what the team policy fixes. */
export class PolicyLockedError extends Error {
  constructor(what: string) {
    super(`${what} is managed by the team policy and cannot be changed here.`)
    this.name = 'PolicyLockedError'
  }
}

/** Pre-DEK: sealed directly with safeStorage. */
const LEGACY_API_KEY = 'anthropic_api_key_enc'
/** AES-GCM under the vault's data key. */
const API_KEY = 'anthropic_api_key_dek'
const API_AAD = 'setting:anthropic_api_key'
/** The last 4 characters of the stored key, in the clear: all the renderer ever learns about it. */
const API_KEY_HINT = 'anthropic_api_key_last4'
const last4 = (k: string) => (k.length >= 12 ? k.slice(-4) : null)

export class SettingsService {
  /** Called after every saved change (main re-reads update and crash-report preferences). */
  onChange?: (s: Settings) => void

  constructor(
    private readonly repo: Repo,
    private readonly cipher?: SecretCipher,
    private readonly legacyUnseal?: (blob: Buffer) => Promise<string | undefined>,
    /** The team policy's locks (docs/POLICY.md), read on every call. */
    private readonly locks: () => PolicyLocks | null = () => null
  ) {}

  /** What the user chose, before the policy overlay: `update` writes on top of this, never the overlay. */
  private stored(): Partial<Settings> {
    const raw = this.repo.getSetting('prefs')
    return raw ? (JSON.parse(raw) as Partial<Settings>) : {}
  }

  /** The team policy over the user's settings: every reader of `get()` (main's checks included) sees the enforced values. */
  private overlay(s: Omit<Settings, DerivedSettings>): Omit<Settings, DerivedSettings> {
    const l = this.locks()
    if (!l) return s
    const out = { ...s }
    if (l.readOnly) out.aiReadOnly = true
    if (l.egressLogRequired) out.egressLog = true
    out.aiRunTokenBudget = clampRunBudget(out.aiRunTokenBudget, l.runMaxTokenBudget)
    if (l.updatesDisabled) out.updateAutoCheck = false
    if (l.updateChannel) out.updateChannel = l.updateChannel
    if (l.crashReportsDisabled) out.crashReports = false
    return out
  }

  get(): Settings {
    const stored = this.stored()
    const summary = (provider: CloudProvider) => {
      const stored = !!this.repo.getSetting(`${provider}_api_key_dek`) || (provider === 'anthropic' && !!this.repo.getSetting(LEGACY_API_KEY))
      const env = process.env[`${provider.toUpperCase()}_API_KEY`]
      return { saved: stored || !!env, last4: stored ? this.repo.getSetting(`${provider}_api_key_last4`) ?? null : env ? last4(env) : null }
    }
    const cloudKeys = { anthropic: summary('anthropic'), openai: summary('openai'), gemini: summary('gemini') }
    const connectedAccounts = { chatgpt: !!this.repo.getSetting('account_chatgpt_dek'), copilot: !!this.repo.getSetting('account_copilot_dek') }
    const base = this.overlay({ ...DEFAULTS, logDir: join(app.getPath('documents'), 'Hopline', 'logs'), ...stored })
    const l = this.locks()
    return {
      ...base,
      cloudKeys, connectedAccounts,
      hasApiKey: cloudKeys.anthropic.saved,
      apiKeyLast4: cloudKeys.anthropic.last4,
      // A remote plain-http server without its acknowledgement is not usable (main refuses it).
      aiConfigured: !providerAllowed(base.aiProvider, l)
        ? false
        : base.aiProvider === 'ollama'
          ? !!base.ollamaModel && !!base.ollamaEndpoint && (!isInsecureEndpoint(base.ollamaEndpoint) || insecureAcked(base.ollamaEndpoint, base.ollamaInsecureAck))
          : isAccount(base.aiProvider) ? connectedAccounts[base.aiProvider] : cloudKeys[base.aiProvider].saved
    }
  }

  /**
   * Save a patch on top of what the user chose. A locked value is refused when the patch would
   * change it, and dropped when it only repeats the enforced value, so the overlay is never written back as the user's own choice.
   */
  update(patch: SettingsPatch): Settings {
    const l = this.locks()
    const p: SettingsPatch = { ...patch }
    if (l) {
      if (l.readOnly && p.aiReadOnly !== undefined) {
        if (!p.aiReadOnly) throw new PolicyLockedError('Read-only mode')
        delete p.aiReadOnly
      }
      if (l.egressLogRequired && p.egressLog !== undefined) {
        if (!p.egressLog) throw new PolicyLockedError('The "what left this machine" log')
        delete p.egressLog
      }
      if (l.updatesDisabled && p.updateAutoCheck !== undefined) {
        if (p.updateAutoCheck) throw new PolicyLockedError('Update checks')
        delete p.updateAutoCheck
      }
      if (l.updateChannel && p.updateChannel !== undefined) {
        if (p.updateChannel !== l.updateChannel) throw new PolicyLockedError('The update channel')
        delete p.updateChannel
      }
      if (l.crashReportsDisabled && p.crashReports !== undefined) {
        if (p.crashReports) throw new PolicyLockedError('Crash reports')
        delete p.crashReports
      }
      if (p.aiRunTokenBudget !== undefined && l.runMaxTokenBudget && p.aiRunTokenBudget > l.runMaxTokenBudget) throw new PolicyLockedError(`A run budget above ${l.runMaxTokenBudget.toLocaleString('en-US')} tokens`)
      if (p.aiProvider !== undefined && p.aiProvider !== (this.stored().aiProvider ?? DEFAULTS.aiProvider) && !providerAllowed(p.aiProvider, l))
        throw new PolicyLockedError(`The ${providerName(p.aiProvider)} provider`)
    }
    const { hasApiKey: _k, apiKeyLast4: _l, aiConfigured: _c, ...defaults } = this.getDefaults()
    void _k, void _l, void _c
    this.repo.setSetting('prefs', JSON.stringify({ ...defaults, ...this.stored(), ...p }))
    const next = this.get()
    this.onChange?.(next)
    return next
  }

  /** Defaults with the log directory, without the overlay. */
  private getDefaults(): Settings {
    return { ...DEFAULTS, logDir: join(app.getPath('documents'), 'Hopline', 'logs'), hasApiKey: false, apiKeyLast4: null, aiConfigured: false }
  }

  /** Opaque account state from the official CLI. Only main can unseal it. */
  async accountProfile(id: AccountProvider): Promise<Buffer | null> {
    const slot = `account_${id}_dek`
    const value = this.repo.getSetting(slot)
    if (!value) return null
    if (!this.cipher) throw new Error('Unlock the vault to use this account.')
    return this.cipher.decrypt(Buffer.from(value, 'base64'), `setting:${slot}`)
  }

  async saveAccountProfile(id: AccountProvider, data: Buffer | null): Promise<void> {
    const slot = `account_${id}_dek`
    if (data && !this.cipher) throw new Error('Unlock the vault to save this account.')
    this.repo.setSetting(slot, data ? (await this.cipher!.encrypt(data, `setting:${slot}`)).toString('base64') : null)
  }

  async setApiKey(key: string | null, provider: CloudProvider = 'anthropic'): Promise<Settings> {
    if (key && !this.cipher) throw new Error('No vault: the API key cannot be stored')
    const slot = `${provider}_api_key`
    const enc = key ? (await this.cipher!.encrypt(Buffer.from(key, 'utf8'), `setting:${slot}`)).toString('base64') : null
    this.repo.setSetting(`${slot}_dek`, enc)
    this.repo.setSetting(`${slot}_last4`, key ? last4(key) : null)
    if (provider === 'anthropic') this.repo.setSetting(LEGACY_API_KEY, null)
    return this.get()
  }

  async apiKey(provider: CloudProvider = 'anthropic'): Promise<string | undefined> {
    const slot = `${provider}_api_key`
    const enc = this.repo.getSetting(`${slot}_dek`)
    if (enc && this.cipher) return (await this.cipher.decrypt(Buffer.from(enc, 'base64'), `setting:${slot}`)).toString('utf8')
    const legacy = provider === 'anthropic' && this.repo.getSetting(LEGACY_API_KEY)
    if (legacy && this.legacyUnseal) return this.legacyUnseal(Buffer.from(legacy, 'base64'))
    return process.env[`${provider.toUpperCase()}_API_KEY`]
  }

  /** Move a pre-DEK API key under the data key. Leaves it untouched if the keychain can't read it. */
  async migrateLegacyApiKey(): Promise<boolean> {
    const legacy = this.repo.getSetting(LEGACY_API_KEY)
    if (!legacy || !this.legacyUnseal || !this.cipher) return false
    const key = await this.legacyUnseal(Buffer.from(legacy, 'base64'))
    if (!key) return false
    this.repo.setSetting(API_KEY, (await this.cipher.encrypt(Buffer.from(key, 'utf8'), API_AAD)).toString('base64'))
    this.repo.setSetting(API_KEY_HINT, last4(key))
    this.repo.setSetting(LEGACY_API_KEY, null)
    return true
  }

  /** Session-only start: an API key saved last run is under a key that no longer exists. */
  dropEphemeralApiKey(): void {
    this.repo.setSetting('account_chatgpt_dek', null)
    this.repo.setSetting('account_copilot_dek', null)
    for (const provider of CLOUD_PROVIDERS) {
      this.repo.setSetting(`${provider}_api_key_dek`, null)
      this.repo.setSetting(`${provider}_api_key_last4`, null)
    }
  }
}
