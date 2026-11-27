import { describe, expect, it } from 'vitest'
import type { AgentEvent, Session } from '@shared/types'
import type { ExecResultMsg } from '@shared/host-protocol'
import { Agent } from '../src/main/agent/agent'
import type { AuditLog } from '../src/main/db/audit'
import type { TabControl } from '../src/main/host/client'
import type { LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'
import type { SettingsService } from '../src/main/settings'

/**
 * Fault paths that must stop a run. If the audit log cannot be written, nothing more may reach the
 * device: the run ends with an error instead of the model being told to carry on.
 */
describe('agent fault paths', () => {
  it('an audit write that fails ends the run after the command in flight; nothing else runs', async () => {
    const session = { id: 's1', name: 'dev', host: '10.0.0.1', platform: 'iosxe' } as unknown as Session
    const sent: string[] = []
    const term: TabControl = {
      get: (id) => (id === 't1' ? { tabId: 't1', session } : undefined),
      exec: async (_t, command): Promise<ExecResultMsg> => (sent.push(command), { status: 'ok', output: 'ok', durationMs: 1, bytes: 2 }),
      mode: async () => 'exec',
      prompt: async () => ({ mode: 'exec', prompt: 'dev#', hostname: 'dev' })
    }
    const read = (command: string) => ({ type: 'tool_call' as const, id: command, name: 'run_show_command', input: { command, reason: 'x' } })
    const script = [[read('show version')], [read('show clock')]]
    let turns = 0
    const provider: LlmProvider = {
      id: 'scripted',
      async turn(_req: TurnRequest): Promise<TurnResult> {
        turns++
        const step = script.shift()
        if (!step) return { message: { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }, stop: 'end' }
        return { message: { role: 'assistant', parts: step }, stop: 'tool_use' }
      }
    }
    const audit = {
      append: () => {
        throw new Error('audit log unavailable')
      }
    } as unknown as AuditLog
    const settings = { get: () => ({ aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) } as unknown as SettingsService
    const done = new Promise<AgentEvent>((resolve) => {
      const agent = new Agent({ term, settings, audit, provider: async () => provider, emit: (e) => e.type === 'done' && resolve(e) })
      agent.start({ tabId: 't1', prompt: 'go' })
    })
    const end = await done
    expect(end).toMatchObject({ type: 'done', error: expect.stringMatching(/audit log unavailable/) })
    expect(sent).toEqual(['show version'])
    expect(turns).toBe(1)
  })
})
