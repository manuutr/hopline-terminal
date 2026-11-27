import { AccountSignIn } from '../ai/AccountSignIn'
import { CLOUD, CLOUD_PROVIDERS, ACCOUNT_PROVIDERS, isAccount, isKeyProvider, providerAllowed, providerName, keyInfo, modelFor } from '@shared/providers'
import { Cloud, HardDrive, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_OLLAMA_ENDPOINT, type AiProviderId, type Settings } from '@shared/types'
import { Button, cn, Input, PasswordInput, SelectMenu } from '../../design'
import { insecureAcked, isInsecureEndpoint, normalizeEndpoint } from '@shared/ollama'
import { anthropicOptions, ConnectStatus, EndpointNotice, ollamaOptions, runCheck, TOOL_NOTE, useOllamaModels, type TestState } from '../ai/setup-parts'
import { Row } from './parts'
import { Managed } from '../trust/Managed'
import { useLocks } from '../trust/store'

/**
 * Settings → Assistant: provider, model, key or endpoint, and "Test connection" (which tests the
 * values in the form, unsaved, with the stored key unless a new one is typed).
 */
export function AssistantSection({
  form,
  up,
  apiKey,
  setApiKey,
  onRemoveKey,
  vaultMode,
  vaultLocked
}: {
  form: Settings
  up: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  apiKey: string
  setApiKey: (v: string) => void
  onRemoveKey: () => void
  vaultMode?: string
  vaultLocked?: boolean
}): React.JSX.Element {
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const locks = useLocks()
  const allowed = (p: AiProviderId) => providerAllowed(p, locks)
  const [replacing, setReplacing] = useState(false)
  const ollama = form.aiProvider === 'ollama'
  const cloud = isKeyProvider(form.aiProvider) ? CLOUD[form.aiProvider] : null
  const keyState = isKeyProvider(form.aiProvider) ? keyInfo(form.aiProvider, form) : null
  const model = modelFor(form.aiProvider, form)
  const discovery = useOllamaModels(form.ollamaEndpoint, ollama)
  const models = discovery.result?.ok ? discovery.result.models : []
  const reset = () => setTest({ kind: 'idle' })
  // Saved with the form: the acknowledgement names the endpoint, so editing the address voids it.
  const endpoint = normalizeEndpoint(form.ollamaEndpoint)
  const insecure = isInsecureEndpoint(endpoint)
  const acked = insecureAcked(endpoint, form.ollamaInsecureAck)

  const runTest = async () => {
    setTest({ kind: 'testing', label: ollama ? `Asking ${form.ollamaModel || 'the model'}…` : 'Checking with a minimal request…' })
    const result = await runCheck(() =>
      window.hopline.ai.test(
        ollama
          ? { provider: 'ollama', model: form.ollamaModel, endpoint, ...(insecure && acked ? { insecureAck: true } : {}) }
          : { provider: form.aiProvider, model: model.trim(), key: apiKey.trim() || undefined }
      )
    )
    setTest({ kind: 'done', result })
  }

  return (
    <>
      <Row k="aiProvider" label="Provider" hint="Choose a cloud API, a ChatGPT or GitHub Copilot account, or an Ollama server you control.">
        <SelectMenu<AiProviderId>
          aria-label="Provider"
          disabled={test.kind === 'testing'}
          value={form.aiProvider}
          onValueChange={(v) => {
            setApiKey('')
            setReplacing(false)
            up('aiProvider', v)
            reset()
          }}
          options={[
            ...CLOUD_PROVIDERS.map(value => ({ value, label: value === 'anthropic' ? 'Anthropic (Claude)' : CLOUD[value].label, icon: <Cloud className="size-3.5 text-fg-subtle" />, hint: allowed(value) ? 'cloud' : 'not allowed by policy', disabled: !allowed(value) })),
            ...ACCOUNT_PROVIDERS.map(value => ({ value, label: providerName(value), hint: 'subscription', disabled: !allowed(value) })),
            { value: 'ollama', label: 'Ollama', icon: <HardDrive className="size-3.5 text-fg-subtle" />, hint: allowed('ollama') ? 'your machine or server' : 'not allowed by policy', disabled: !allowed('ollama') }
          ]}
        />
        {(locks.allowedProviders || locks.aiDisabled) && <Managed className="mt-1" what="Allowed providers" />}
      </Row>

      {isAccount(form.aiProvider) ? <Row k="aiModel" label="Account"><AccountSignIn key={form.aiProvider} provider={form.aiProvider} /></Row> : cloud ? (
        <>
          <Row k="apiKey" label="API key" hint="Encrypted in your vault. Never sent to the window or put in a prompt.">
            {keyState?.saved && !replacing ? (
              <div className="flex h-7 items-center gap-2">
                <span data-testid="api-key-saved" className="font-mono text-sm text-fg-muted">
                  Saved · ••••{keyState?.last4 ?? '····'}
                </span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setReplacing(true)} disabled={vaultLocked}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={onRemoveKey} disabled={vaultLocked}>
                  Remove
                </Button>
              </div>
            ) : (
              <PasswordInput
                aria-label={`${cloud.label} API key`}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  reset()
                }}
                placeholder={`Paste ${cloud.label} API key`}
                className="font-mono"
              />
            )}
            {vaultMode === 'session' && <div className="mt-1.5 text-2xs text-warn">Session-only vault: a key saved here is forgotten when Hopline quits. Set a master password under Security, or set {form.aiProvider.toUpperCase()}_API_KEY.</div>}
            {vaultLocked && <div className="mt-1.5 text-2xs text-warn">The vault is locked: unlock it to change the key.</div>}
          </Row>
          <Row k="aiModel" label="Model" hint={`Use a model with function calling at ${cloud.host}.`}>
            {form.aiProvider === 'anthropic' ? (
              <SelectMenu
                aria-label="Claude model"
                value={form.aiModel}
                onValueChange={(v) => {
                  up('aiModel', v)
                  reset()
                }}
                options={anthropicOptions(form.aiModel)}
              />
            ) : (
              <Input
                aria-label={`${cloud.label} model ID`}
                value={model}
                onChange={(e) => {
                  up(cloud.modelField, e.target.value)
                  reset()
                }}
                className="font-mono"
              />
            )}
          </Row>
        </>
      ) : (
        <>
          <Row k="ollamaEndpoint" label="Ollama server" hint="Default http://127.0.0.1:11434. Device output is redacted before it is sent.">
            <div className="flex gap-2">
              <Input
                aria-label="Ollama server"
                value={form.ollamaEndpoint}
                onChange={(e) => {
                  up('ollamaEndpoint', e.target.value)
                  reset()
                }}
                onBlur={() => endpoint !== form.ollamaEndpoint && up('ollamaEndpoint', endpoint)}
                placeholder={DEFAULT_OLLAMA_ENDPOINT}
                className="font-mono"
              />
              <Button size="icon" aria-label="Find models" title="Find models" onClick={discovery.refresh} disabled={discovery.loading}>
                <RefreshCw className={cn(discovery.loading && 'animate-spin')} />
              </Button>
            </div>
            <EndpointNotice
              className="mt-1.5"
              endpoint={endpoint}
              acked={acked}
              onAck={(v) => {
                up('ollamaInsecureAck', v ? endpoint : '')
                reset()
              }}
            />
          </Row>
          <Row k="aiModel" label="Model" hint={TOOL_NOTE}>
            {discovery.result && !discovery.result.ok ? (
              <ConnectStatus state={{ kind: 'done', result: discovery.result }} />
            ) : (
              <SelectMenu
                aria-label="Ollama model"
                value={form.ollamaModel}
                onValueChange={(v) => {
                  up('ollamaModel', v)
                  reset()
                }}
                options={ollamaOptions(models, form.ollamaModel)}
                placeholder={discovery.loading ? 'Looking for models…' : 'Pick a model'}
                disabled={!models.length && !form.ollamaModel}
              />
            )}
          </Row>
        </>
      )}

      {!isAccount(form.aiProvider) && <Row k="aiConnection" label="Connection" hint="Makes one minimal request with the values above. Nothing is saved until you press Save.">
        <div className="flex min-h-7 items-center gap-3">
          <Button onClick={() => void runTest()} disabled={test.kind === 'testing' || (ollama ? !form.ollamaModel || (insecure && !acked) : !model.trim() || (!keyState?.saved && !apiKey.trim()))}>
            Test connection
          </Button>
          <ConnectStatus state={test} className="min-w-0" />
        </div>
      </Row>}
    </>
  )
}
