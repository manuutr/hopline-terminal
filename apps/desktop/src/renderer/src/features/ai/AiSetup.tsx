import { AccountSignIn } from './AccountSignIn'
import { CLOUD, PROVIDERS, isAccount, isKeyProvider, keyInfo, modelFor, providerAllowed, providerName } from '@shared/providers'
import { Cloud, HardDrive, RefreshCw } from 'lucide-react'
import { Managed } from '../trust/Managed'
import { policyName, useLocks, useTrust } from '../trust/store'
import { useState } from 'react'
import { DEFAULT_OLLAMA_ENDPOINT, type AiProviderId } from '@shared/types'
import { Button, cn, Input, PasswordInput, Segmented, SelectMenu } from '../../design'
import { useUi } from '../../store'
import { insecureAcked, isInsecureEndpoint, normalizeEndpoint } from '@shared/ollama'
import { anthropicOptions, ConnectStatus, EndpointNotice, ollamaOptions, runCheck, TOOL_NOTE, useOllamaModels, type TestState } from './setup-parts'

/**
 * F2: connect inside the panel. Replaces the composer while no provider is configured (P1-7).
 * Anthropic: paste a key, Hopline makes a real minimal request, then saves it in the vault.
 * Ollama: point at a local server, pick a discovered model. Nothing blocks: the panel's question
 * (if any) waits above and is sent once this succeeds.
 */
export function AiSetup({ pendingQuestion }: { pendingQuestion: boolean }): React.JSX.Element {
  const settings = useUi((s) => s.settings)
  const vault = useUi((s) => s.vault)
  const locks = useLocks()
  const policy = useTrust((s) => s.policy)
  const allowed = (p: AiProviderId) => providerAllowed(p, locks)
  const [provider, setProvider] = useState<AiProviderId>(() => {
    const want = settings?.aiProvider ?? 'anthropic'
    return allowed(want) ? want : PROVIDERS.find(allowed) ?? want
  })
  const [key, setKey] = useState('')
  const [model, setModel] = useState(() => modelFor(provider, settings))
  const [endpoint, setEndpoint] = useState(settings?.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT)
  const [localModel, setLocalModel] = useState(settings?.ollamaModel ?? '')
  const [state, setState] = useState<TestState>({ kind: 'idle' })
  // Remote plain-http: the user must accept unencrypted traffic to exactly this endpoint (main checks too).
  const [ackFor, setAckFor] = useState(settings?.ollamaInsecureAck ?? '')
  const insecure = isInsecureEndpoint(normalizeEndpoint(endpoint))
  const acked = insecureAcked(normalizeEndpoint(endpoint), ackFor)
  const discovery = useOllamaModels(endpoint, provider === 'ollama')
  const models = discovery.result?.ok ? discovery.result.models : []
  // A model with tool calling first; one without runs in suggest mode.
  const pickLocal = localModel || models.find((m) => m.tools === true)?.name || models[0]?.name || ''
  const cloud = isKeyProvider(provider) ? CLOUD[provider] : null
  const keyState = isKeyProvider(provider) ? keyInfo(provider, settings) : null
  const savedKey = !!keyState?.saved
  const busy = state.kind === 'testing'

  const connect = async () => {
    if (busy) return
    if (cloud && (!model.trim() || (!key.trim() && !savedKey))) return
    if (provider === 'ollama' && (!pickLocal || (insecure && !acked))) return
    setState({ kind: 'testing', label: isAccount(provider) ? 'Connecting your account…' : cloud ? 'Checking the key with a minimal request…' : `Loading ${pickLocal} (the first request can take a minute)…` })
    const result = await runCheck(() =>
      window.hopline.ai.connect(isAccount(provider) ? { provider, model: modelFor(provider) } : cloud ? { provider, model: model.trim(), key: key.trim() || undefined } : { provider, model: pickLocal, endpoint: normalizeEndpoint(endpoint), ...(insecure && acked ? { insecureAck: true } : {}) })
    )
    setState({ kind: 'done', result })
    if (result.settings) {
      setKey('')
      // Flips aiConfigured: the store sends any waiting question and the composer comes back.
      useUi.getState().setSettings(result.settings)
    }
  }

  const pick = (id: AiProviderId) => {
    if (busy || provider === id) return
    setKey('')
    setModel(modelFor(id, settings))
    setProvider(id)
    setState({ kind: 'idle' })
  }

  if (policy.state === 'invalid' || locks.aiDisabled)
    return (
      <div data-testid="ai-off-by-policy" role="status" className="text-xs text-danger">
        The assistant is off: the team policy file is invalid. Read-only mode is on. Ask your administrator to fix {policy.source}.
      </div>
    )
  if (!PROVIDERS.some(allowed))
    return (
      <div data-testid="ai-off-by-policy" role="status" className="text-xs text-fg-muted">
        The assistant is turned off by {policyName(policy)}: no model provider is allowed. <Managed />
      </div>
    )

  return (
    <form
      aria-label="Connect a model"
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        void connect()
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium text-fg">Connect a model</h2>
        {pendingQuestion && <span className="text-2xs text-fg-subtle">Your question is sent once connected</span>}
      </div>
      <Segmented
        label="Model provider"
        value={provider}
        onChange={pick}
        className="grid h-auto w-full grid-cols-2 [&>button]:h-7"
        items={PROVIDERS.map(value => ({
          value, label: providerName(value),
          icon: value === 'ollama' ? <HardDrive /> : <Cloud />, disabled: busy || !allowed(value)
        }))}
      />
      {locks.allowedProviders && <Managed what={`Allowed: ${locks.allowedProviders.join(', ') || 'none'}`} />}
      <p className="text-2xs leading-snug text-fg-muted">
        Hopline masks recognized secrets, device names and interface descriptions. Network addresses and free-form notes can still reach the model.
      </p>

      {isAccount(provider) ? <AccountSignIn key={provider} provider={provider} onUse={() => void connect()} /> : cloud ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <label htmlFor="ai-api-key" className="text-2xs font-medium text-fg-muted">
              API key
            </label>
            <PasswordInput
              id="ai-api-key"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={savedKey ? `Saved key ••••${keyState?.last4 ?? ''} · paste to replace` : `Paste ${cloud.label} API key`}
              className="font-mono"
            />
          </div>
          {provider === 'anthropic'
            ? <SelectMenu aria-label="Claude model" value={model} onValueChange={setModel} options={anthropicOptions(model)} />
            : <label className="block space-y-1 text-2xs text-fg-muted">{cloud.label} model ID
                <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
              </label>}
          <p className="text-2xs leading-snug text-fg-subtle">
            Hopline sends requests to {cloud.host} using your {cloud.label} API account. The key is encrypted in your vault.
          </p>
          {vault?.mode === 'session' && <p className="text-2xs text-warn">Session-only vault: the key is forgotten when Hopline quits.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-1">
            <label htmlFor="ai-ollama-endpoint" className="text-2xs font-medium text-fg-muted">
              Ollama server
            </label>
            <div className="flex gap-1.5">
              <Input id="ai-ollama-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} onBlur={() => setEndpoint(normalizeEndpoint(endpoint))} className="font-mono" placeholder={DEFAULT_OLLAMA_ENDPOINT} />
              <Button size="icon" aria-label="Find models" title="Find models" onClick={discovery.refresh} disabled={discovery.loading}>
                <RefreshCw className={cn(discovery.loading && 'animate-spin')} />
              </Button>
            </div>
          </div>
          {discovery.result && !discovery.result.ok ? (
            <ConnectStatus state={{ kind: 'done', result: discovery.result }} />
          ) : (
            <SelectMenu
              aria-label="Ollama model"
              value={pickLocal}
              onValueChange={(v) => {
                setLocalModel(v)
                setState({ kind: 'idle' })
              }}
              options={ollamaOptions(models, localModel)}
              placeholder={discovery.loading ? 'Looking for models…' : discovery.result?.ok && !models.length ? 'No models installed: ollama pull qwen3' : 'Pick a model'}
              disabled={!models.length && !localModel}
            />
          )}
          <EndpointNotice endpoint={normalizeEndpoint(endpoint)} acked={acked} onAck={(v) => setAckFor(v ? normalizeEndpoint(endpoint) : '')} />
          <p className="text-2xs leading-snug text-fg-subtle">{TOOL_NOTE}</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        {!isAccount(provider) && <Button
          type="submit"
          variant="primary"
          className="shrink-0"
          disabled={busy || (cloud ? !model.trim() || (!key.trim() && !savedKey) : !pickLocal || (insecure && !acked)) || (!!cloud && !!vault?.locked)}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>}
        <ConnectStatus state={state} className="min-w-0" />
        {cloud && vault?.locked && state.kind === 'idle' && <span className="text-2xs text-warn">Unlock the vault to save a key.</span>}
      </div>
    </form>
  )
}
