import { ACCOUNTS, CLOUD, isAccount, modelFor } from '@shared/providers'
import { Check, CircleAlert, Cloud, HardDrive, Loader2, Server, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { INSECURE_ENDPOINT_WARNING, isInsecureEndpoint, isLoopbackEndpoint, normalizeEndpoint, ollamaHostLabel } from '@shared/ollama'
import { ANTHROPIC_MODELS, type AiTestResult, type OllamaModel, type OllamaModelsResult, type Settings } from '@shared/types'
import { cn, type SelectOption } from '../../design'

/** Shared by the panel's connect card and Settings → Assistant. */

export type TestState = { kind: 'idle' } | { kind: 'testing'; label: string } | { kind: 'done'; result: AiTestResult }

const errText = (e: unknown) => friendly(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e))

/**
 * IPC validation failures arrive as zod's JSON issue list: show what to fix instead (Low 3).
 */
export function friendly(message: string): string {
  if (!/^\s*\[\s*\{/.test(message) && !/"code"\s*:/.test(message)) return message
  if (/endpoint|url|http/i.test(message)) return 'The server address must look like http://host:11434 (http or https, no user name or password).'
  if (/model/i.test(message)) return 'Pick a model name (letters, digits and . : / @ - _ only).'
  return 'Some of the values are not valid. Check them and try again.'
}

/** Wrap an ai.test/ai.connect call so IPC failures (a zod error) still end as a result. */
export async function runCheck(f: () => Promise<AiTestResult>): Promise<AiTestResult> {
  try {
    return await f()
  } catch (e) {
    return { ok: false, code: 'other', message: errText(e) }
  }
}

/** One line under the connect button: ✓ Connected · model, or the specific error. */
export function ConnectStatus({ state, className }: { state: TestState; className?: string }): React.JSX.Element | null {
  if (state.kind === 'idle') return null
  if (state.kind === 'testing')
    return (
      <div role="status" className={cn('flex items-center gap-1.5 text-xs text-fg-muted', className)}>
        <Loader2 className="size-3.5 shrink-0 animate-spin" /> {state.label}
      </div>
    )
  const r = state.result
  const warn = r.code === 'rate_limit' || r.code === 'overloaded'
  return (
    <div
      role={r.ok ? 'status' : 'alert'}
      data-testid="ai-connect-status"
      data-code={r.code}
      className={cn('flex items-start gap-1.5 text-xs leading-snug animate-fade-in', r.ok ? 'text-ok' : warn ? 'text-warn' : 'text-danger', className)}
    >
      {r.ok ? <Check className="mt-px size-3.5 shrink-0" /> : <CircleAlert className="mt-px size-3.5 shrink-0" />}
      <span>{r.message}</span>
    </div>
  )
}

export function anthropicOptions(current: string): SelectOption<string>[] {
  const opts: SelectOption<string>[] = ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.note }))
  if (current && !ANTHROPIC_MODELS.some((m) => m.id === current)) opts.push({ value: current, label: current, hint: 'custom' })
  return opts
}

const ctx = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n))
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)

export function ollamaOptions(models: OllamaModel[], current: string): SelectOption<string>[] {
  const opts: SelectOption<string>[] = models.map((m) => ({
    value: m.name,
    label: m.name,
    text: m.name,
    hint: [m.parameterSize, gb(m.sizeBytes), m.tools === true ? 'tools' : m.tools === false ? 'suggest mode' : 'tools unknown', m.contextLength ? `ctx ${ctx(m.contextLength)}${m.numCtx < m.contextLength ? ` (uses ${ctx(m.numCtx)})` : ''}` : null].filter(Boolean).join(' · ')
  }))
  if (current && !models.some((m) => m.name === current)) opts.unshift({ value: current, label: current, hint: 'not found on server' })
  return opts
}

export const TOOL_NOTE =
  'With tool calling (Qwen 3, Llama 3.1 and later, Mistral Small 3, Command R; prefer 7B or larger) the assistant runs read-only commands itself. A model without it runs in suggest mode: it proposes commands and you click to run each one. ctx is the model\'s context; Hopline uses at most 32k.'

/** Discover models on an Ollama server; re-run with `refresh`. */
export function useOllamaModels(endpoint: string, enabled: boolean): { result: OllamaModelsResult | null; loading: boolean; refresh: () => void } {
  const [result, setResult] = useState<OllamaModelsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const refresh = useCallback(() => {
    const n = ++seq.current
    setLoading(true)
    window.hopline.ai
      .ollamaModels(normalizeEndpoint(endpoint))
      // The IPC schema refuses anything but an http(s) URL; the message is fixed, like main's.
      .catch((): OllamaModelsResult => ({ ok: false, code: 'bad_endpoint', error: 'invalid_url', message: 'Enter a full http:// or https:// address, like http://127.0.0.1:11434.' }))
      .then((r) => {
        if (n !== seq.current) return
        setResult(r)
        setLoading(false)
      })
  }, [endpoint])
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(refresh, 350)
    return () => clearTimeout(t)
  }, [enabled, refresh])
  return { result, loading, refresh }
}

/**
 * Where device output goes for an Ollama endpoint (L3): a remote server is named as such, and a
 * remote plain-http one needs the user to accept that the traffic is unencrypted.
 */
export function EndpointNotice({ endpoint, acked, onAck, className }: { endpoint: string; acked: boolean; onAck: (v: boolean) => void; className?: string }): React.JSX.Element | null {
  const e = endpoint.trim()
  if (!e || isLoopbackEndpoint(e)) return null
  const insecure = isInsecureEndpoint(e)
  return (
    <div data-testid="ollama-endpoint-notice" className={cn('space-y-1 text-2xs leading-snug text-warn', className)}>
      <p className="flex items-start gap-1.5">
        <TriangleAlert className="mt-px size-3 shrink-0" />
        <span>
          {ollamaHostLabel(e)} is not on this machine: redacted device output is sent to this server. Use one you control.
          {insecure && <> {INSECURE_ENDPOINT_WARNING}</>}
        </span>
      </p>
      {insecure && (
        <label className="flex items-center gap-1.5 text-fg-muted">
          <input type="checkbox" className="accent-[var(--c-accent)]" checked={acked} onChange={(ev) => onAck(ev.target.checked)} />
          I understand: send device output to {e} without encryption
        </label>
      )}
    </div>
  )
}

/** Which model answers, with a cloud, local or remote-server mark (ARCHITECTURE §6.1: always visible). */
export function providerLabel(s: Settings): { icon: React.JSX.Element; text: string; title: string } {
  if (s.aiProvider === 'ollama') {
    const local = isLoopbackEndpoint(s.ollamaEndpoint)
    const where = local ? 'on this machine' : isInsecureEndpoint(s.ollamaEndpoint) ? 'on a remote server, unencrypted (http)' : 'on a remote server'
    return {
      icon: local ? <HardDrive className="size-3" /> : <Server className="size-3" />,
      // The model only: the server is the trust bar's destination, right under it (review P1-7).
      text: s.ollamaModel,
      title: `Ollama model ${s.ollamaModel} at ${s.ollamaEndpoint} (${where})`
    }
  }
  if (isAccount(s.aiProvider)) {
    const a = ACCOUNTS[s.aiProvider]
    return { icon: <Cloud className="size-3" />, text: a.label, title: a.destination }
  }
  const cloud = CLOUD[s.aiProvider]
  const model = modelFor(s.aiProvider, s)
  const m = s.aiProvider === 'anthropic' ? ANTHROPIC_MODELS.find((x) => x.id === model) : undefined
  return { icon: <Cloud className="size-3" />, text: (m?.label ?? model).replace(/^Claude /, ''), title: `${cloud.label} ${m?.label ?? model} (cloud)` }
}
