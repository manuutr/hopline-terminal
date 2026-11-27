import type { PolicyLocks } from './policy'
import type { Settings } from './types'

export const CLOUD_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const
export const ACCOUNT_PROVIDERS = ['chatgpt', 'copilot'] as const
export type AccountProvider = typeof ACCOUNT_PROVIDERS[number]
export const ACCOUNTS = {
  chatgpt: { label: 'ChatGPT', client: 'Codex CLI', command: 'codex', destination: 'ChatGPT via Codex', install: 'https://developers.openai.com/codex/cli/' },
  copilot: { label: 'GitHub Copilot', client: 'Copilot CLI', command: 'copilot', destination: 'GitHub Copilot CLI', install: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli' }
} as const
export const isAccount = (p: string): p is AccountProvider => p === 'chatgpt' || p === 'copilot'
export const isKeyProvider = (p: string): p is CloudProvider => CLOUD_PROVIDERS.some(id => id === p)
export type AccountAction = 'start' | 'status' | 'cancel' | 'disconnect'
export type AccountState =
  | { phase: 'idle' | 'starting' | 'connected' }
  | { phase: 'authorize'; verificationUrl: string; code: string }
  | { phase: 'error'; message: string }

export const PROVIDERS = [...CLOUD_PROVIDERS, 'ollama', ...ACCOUNT_PROVIDERS] as const
export type CloudProvider = typeof CLOUD_PROVIDERS[number]
export const CLOUD = {
  anthropic: { label: 'Anthropic', host: 'api.anthropic.com', modelField: 'aiModel', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'OpenAI', host: 'api.openai.com', modelField: 'openaiModel', defaultModel: 'gpt-5.4-mini' },
  gemini: { label: 'Gemini', host: 'generativelanguage.googleapis.com', modelField: 'geminiModel', defaultModel: 'gemini-4-hydrogen' }
} as const

export function modelFor(p: typeof PROVIDERS[number], s?: Settings | null): string {
  if (isAccount(p)) return 'Account default'
  if (p === 'ollama') return s?.ollamaModel ?? ''
  return s?.[CLOUD[p].modelField] ?? CLOUD[p].defaultModel
}

export function keyInfo(p: CloudProvider, s?: Settings | null) {
  return s?.cloudKeys?.[p] ?? { saved: p === 'anthropic' && !!s?.hasApiKey, last4: p === 'anthropic' ? s?.apiKeyLast4 : null }
}

export function providerName(id: string): string {
  if (isAccount(id)) return ACCOUNTS[id].label
  if (id === 'ollama') return 'Ollama'
  const cloud = CLOUD_PROVIDERS.find(p => p === id)
  return cloud ? CLOUD[cloud].label : id
}

export function providerAllowed(id: typeof PROVIDERS[number], locks: PolicyLocks | null): boolean {
  return !locks || (!locks.aiDisabled && (!locks.allowedProviders || locks.allowedProviders.includes(id)) && !(isAccount(id) && locks.egressLogRequired))
}
