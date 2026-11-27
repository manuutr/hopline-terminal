import { ACCOUNTS, CLOUD, isAccount, modelFor } from '@shared/providers'
import { ArrowUpFromLine, Cloud, HardDrive, Server } from 'lucide-react'
import { useEffect } from 'react'
import { isLoopbackEndpoint, parseEndpoint } from '@shared/ollama'
import { ANTHROPIC_MODELS, type Settings } from '@shared/types'
import { Badge, Button, cn, StatusDot, Tooltip } from '../../design'
import { useTrust } from '../trust/store'
import type { RunUsage } from './store'

/** Where prompts go, in words: "Anthropic cloud" or "Ollama at host:port" (this machine or a server). */
/** `short`: what the bar shows when the panel is narrow (the icon and the tooltip carry the rest). */
export function destinationOf(s: Settings): { icon: React.JSX.Element; label: string; short: string; detail: string; local: boolean } {
  if (s.aiProvider === 'ollama') {
    const local = isLoopbackEndpoint(s.ollamaEndpoint)
    const host = parseEndpoint(s.ollamaEndpoint)?.host ?? s.ollamaEndpoint
    return {
      icon: local ? <HardDrive className="size-3" /> : <Server className="size-3" />,
      label: `Ollama · ${host}`,
      short: local ? 'local' : host,
      detail: `${s.ollamaModel} on ${local ? 'this machine' : `the server ${host}`}`,
      local
    }
  }
  if (isAccount(s.aiProvider)) {
    const a = ACCOUNTS[s.aiProvider]
    return { icon: <Cloud className="size-3" />, label: a.label, short: a.label, detail: `Masked prompt passed to ${a.client}`, local: false }
  }
  const cloud = CLOUD[s.aiProvider]
  const model = modelFor(s.aiProvider, s)
  const m = s.aiProvider === 'anthropic' ? ANTHROPIC_MODELS.find((x) => x.id === model) : undefined
  return { icon: <Cloud className="size-3" />, label: `${cloud.label} cloud`, short: 'cloud', detail: `${m?.label ?? model} at ${cloud.host}`, local: false }
}

/** Compact token counts for a narrow panel: 859, 2.3k, 200k, 1.2M (review P1-7: "2,343 / 200k" wrapped). */
export const compact = (n: number): string =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`

/** The per-run token budget: used of budget, amber from 80%, red once the run is closing. */
export function BudgetMeter({ usage }: { usage: RunUsage }): React.JSX.Element {
  const f = usage.budget > 0 ? Math.min(1, usage.used / usage.budget) : 0
  const tone = usage.closing || f >= 1 ? 'bg-danger' : f >= 0.8 ? 'bg-warn' : 'bg-accent'
  const cost = usage.costUsd !== null ? ` · about $${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}` : ''
  return (
    <Tooltip label={`This run: ${usage.used.toLocaleString('en-US')} of ${usage.budget.toLocaleString('en-US')} budget tokens (input ${usage.inputTokens.toLocaleString('en-US')}, output ${usage.outputTokens.toLocaleString('en-US')})${cost}. Set the budget in Settings › Assistant.`}>
      <span data-testid="ai-budget" data-used={usage.used} data-budget={usage.budget} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-2xs tabular-nums text-fg-subtle">
        <span className="relative hidden h-1 w-10 overflow-hidden rounded-full bg-line @[22rem]:block" role="meter" aria-label="Run token budget" aria-valuemin={0} aria-valuemax={usage.budget} aria-valuenow={usage.used}>
          <span className={cn('absolute inset-y-0 left-0', tone)} style={{ width: `${Math.round(f * 100)}%` }} />
        </span>
        {compact(usage.used)} / {compact(usage.budget)}
      </span>
    </Tooltip>
  )
}

/**
 * One quiet row under the assistant header: where prompts go (provider indicator), whether the
 * model answers (health), suggest mode, the run's budget, and the "what left this machine" log.
 */
export function TrustBar({ settings, usage, suggest }: { settings: Settings; usage?: RunUsage; suggest?: boolean }): React.JSX.Element {
  const { health, checking, checkHealth } = useTrust()
  const dest = destinationOf(settings)
  const key = `${settings.aiProvider}|${modelFor(settings.aiProvider, settings)}|${settings.ollamaEndpoint}|${settings.ollamaModel}`
  useEffect(() => {
    if (settings.aiConfigured) void checkHealth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, settings.aiConfigured])
  const fresh = health && health.provider === settings.aiProvider && health.model === modelFor(settings.aiProvider, settings) ? health : null
  const state = checking && !fresh ? 'connecting' : !fresh ? 'idle' : fresh.ok ? 'connected' : 'down'
  const suggestMode = suggest ?? (fresh?.tools === false)
  return (
    <div data-testid="ai-trust" className="@container flex h-7 items-center gap-2 border-b border-line px-3 text-2xs text-fg-muted">
      <Tooltip label={`Prompts go to ${dest.detail}. ${dest.local ? 'They stay on this machine.' : 'Hopline Terminal masks recognized device names, interface descriptions and secrets before sending. Route addresses and free text can still be visible.'}${fresh ? ` ${fresh.message}.` : ''} Click to check again.`}>
        <button data-testid="ai-destination" data-local={dest.local} onClick={() => void checkHealth()} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded px-1 hover:bg-hover hover:text-fg">
          <StatusDot state={state} />
          <span className="shrink-0">{dest.icon}</span>
          {/* Review P1-7: at 900-1100 px the label was cut to "Olla…". Narrow: "local", the host, or "cloud". */}
          <span data-testid="ai-destination-label" className="hidden truncate font-mono @[26rem]:inline">
            {dest.label}
          </span>
          <span data-testid="ai-destination-short" className="truncate font-mono @[26rem]:hidden">
            {dest.short}
          </span>
        </button>
      </Tooltip>
      {suggestMode && (
        <Tooltip label="This model has no tool calling. It proposes commands as text, and you run each one; every run goes through the guard and the audit log.">
          <span data-testid="ai-suggest-mode" className="shrink-0 whitespace-nowrap">
            <Badge tone="warn">
              suggest<span className="hidden @[22rem]:inline"> mode</span>
            </Badge>
          </span>
        </Tooltip>
      )}
      <span className="ml-auto" />
      {usage && <BudgetMeter usage={usage} />}
      <Tooltip label="What left this machine: every request sent to the model, as sent.">
        <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="What left this machine" data-testid="ai-egress" onClick={() => useTrust.getState().openEgress(true)}>
          <ArrowUpFromLine />
        </Button>
      </Tooltip>
    </div>
  )
}
