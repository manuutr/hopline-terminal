import { describe, expect, it } from 'vitest'
import type { AgentEventBody, Settings } from '@shared/types'
import { Proposals, type ChangeContext } from '../src/main/agent/proposals'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import type { AgentTab, TabControl } from '../src/main/host/client'

/**
 * Phase 4 fix-round review X2: the agent's disruptive path applies the runner's shape rules. A
 * line that changes the mode or that is a configuration line is refused before any card or prompt.
 */
function setup(platform: string) {
  const audit = new AuditLog(openDb(':memory:'))
  const events: AgentEventBody[] = []
  const calls: string[] = []
  const term = {
    get: () => undefined,
    exec: async (_t: AgentTab, c: string) => (calls.push(`exec ${c}`), { status: 'ok' as const, output: '', durationMs: 0, bytes: 0 }),
    mode: async () => 'exec' as const,
    prompt: async () => (calls.push('prompt'), { mode: 'exec' as const, prompt: 'wlc1#', hostname: 'wlc1' })
  } as unknown as TabControl
  const settings = { get: () => ({ aiReadOnly: false, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) as Settings }
  const p = new Proposals({ term, settings, audit, emit: (e) => events.push(e) })
  const tab = { tabId: 't1', session: { id: 's1', name: 'wlc1', host: '10.0.0.1', platform } } as unknown as AgentTab
  const ctx: ChangeContext = { runId: 'r1', tab, signal: new AbortController().signal, report: () => ({ text: 'ran' }) }
  return { p, ctx, audit, events, calls }
}

describe('X2: the agent disruptive path refuses mode changes and configuration lines', () => {
  it('a configuration line the exec tree calls disruptive must be a config proposal', async () => {
    const t = setup('c9800')
    const r = await t.p.proposeDisruptive(t.ctx, 'wireless profile policy x1 shutdown', 'shuts a policy profile down', {})
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^REFUSED: .*configuration line: propose it with propose_config_change/)
    expect(t.calls).toEqual([])
    expect(t.events.some((e) => e.type === 'proposal')).toBe(false)
    expect(t.audit.list()[0]).toMatchObject({ command: 'wireless profile policy x1 shutdown', kind: 'disruptive', decision: 'refused', source: 'agent' })
  })
  it('a mode or context change never becomes an exec proposal', async () => {
    const t = setup('nxos')
    const r = await t.p.proposeDisruptive(t.ctx, 'routing-context vrf blue', 'test', {})
    expect(r.text).toMatch(/^REFUSED: .*changes the CLI mode, privilege level or context/)
    expect(t.calls).toEqual([])
  })
})
