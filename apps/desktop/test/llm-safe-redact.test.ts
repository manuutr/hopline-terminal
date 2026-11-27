import { describe, expect, it } from 'vitest'
import { safeProvider } from '../src/main/llm/safe'
import type { LlmProvider, TurnRequest } from '../src/main/llm/types'

const noop = () => {}

// H3: the review's leaking forms, in every part of a request, for both provider ids.
const LEAKS: [string, string][] = [
  [' security wpa psk set-key ascii 8 Q[XfVbM_ZEXOMbOJfAVBMgfM', 'XfVbM_ZEXOMbOJfAVBMgfM'],
  ['user admin group administrators password ciphertext AQBapaGL1SJTdq52XiE0GcZB', 'AQBapaGL1SJTdq52XiE0GcZB'],
  ['    set psksecret ENC LMPzM2tmFkVAZyJ6oFR0aR+Iqg==', 'LMPzM2tmFkVAZyJ6oFR0aR'],
  [' snmp-agent community read cipher %^%#JvZ%Z!f1:7~eWR6p%^%#', 'JvZ%Z!f1'],
  ['ntp authentication-key 1 md5 121A0C0411045D5679 7', '121A0C0411045D5679'],
  ['snmp-server host 10.1.1.1 version 2c MyCommunity', 'MyCommunity']
]

describe('safeProvider redacts the whole request on every provider (H3)', () => {
  it.each(['anthropic', 'ollama'])('%s', async (id) => {
    let seen: TurnRequest | undefined
    const inner: LlmProvider = { id, turn: async (req) => ((seen = req), { message: { role: 'assistant', parts: [] }, stop: 'end' }) }
    const text = LEAKS.map(([l]) => l).join('\n')
    await safeProvider(inner).turn({
      system: `context:\n${text}`,
      messages: [
        { role: 'user', parts: [{ type: 'text', text }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'run_show_command', input: { command: 'show run' } }] },
        { role: 'user', parts: [{ type: 'tool_result', id: 't1', content: text }] }
      ],
      tools: [],
      signal: new AbortController().signal,
      onText: noop,
      onThinking: noop
    })
    const sent = JSON.stringify({ system: seen!.system, messages: seen!.messages })
    for (const [, secret] of LEAKS) expect(sent).not.toContain(secret)
    expect(sent).toContain('set-key ascii 8 <redacted>')
  })
})

describe('network privacy at the model boundary', () => {
  it.each(['anthropic', 'ollama'])('protects the system, earlier mentions, follow-up output and replay for %s', async (id) => {
    const seen: TurnRequest[] = []
    const raw = 'Finance uplink / circuit 777'
    const result = 'hostname orchard-sw\n description ' + raw + '\nGi0/1 is up, 27 input errors'
    const provider = safeProvider({ id, turn: async (r) => {
      seen.push(r)
      return { message: { role: 'assistant', parts: [] }, stop: 'end' }
    } })
    const turn: TurnRequest = {
      system: 'Device: orchard-sw', tools: [], signal: new AbortController().signal, onText: noop, onThinking: noop,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Check ' + raw + ' on ORCHARD-SW' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'run_show_command', input: { filter: { grep: raw } } }],
          native: { provider: 'anthropic', content: [{ type: 'tool_use', id: 'c1', name: 'run_show_command', input: { filter: { grep: raw } } }] } },
        { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: result }] }
      ]
    }
    await provider.turn(turn)
    await provider.turn({ ...turn, messages: [turn.messages[0]!] })
    const bodies = JSON.stringify(seen.map((r) => [r.system, r.messages]))
    expect(bodies).not.toMatch(/orchard-sw|Finance uplink|circuit 777/i)
    expect(bodies).toContain('Gi0/1 is up, 27 input errors')
    expect(seen[0]!.messages[0]).toEqual(seen[1]!.messages[0])
    expect(JSON.stringify(turn)).toContain(raw)
  })

  it('stops before replaying signed reasoning that now contains a protected network value', async () => {
    let called = false
    const p = safeProvider({ id: 'anthropic', turn: async () => {
      called = true
      return { message: { role: 'assistant', parts: [] }, stop: 'end' }
    } })
    await expect(p.turn({
      system: 'Device evidence', tools: [], signal: new AbortController().signal, onText: noop, onThinking: noop,
      messages: [
        { role: 'assistant', parts: [], native: { provider: 'anthropic', content: [{ type: 'thinking', thinking: 'Check the orchard switch', signature: 'fixture' }] } },
        { role: 'user', parts: [{ type: 'text', text: ' description orchard switch' }] }
      ]
    })).rejects.toThrow(/signed reasoning/)
    expect(called).toBe(false)
  })

})
