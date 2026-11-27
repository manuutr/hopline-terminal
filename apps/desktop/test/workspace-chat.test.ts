import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { Session } from '@shared/types'
import { WorkspaceChat } from '../src/main/agent/workspace-chat'
import { workspaceChatHandlers } from '../src/main/ipc/workspace-chat'
import type { LlmProvider, TurnRequest, TurnResult } from '../src/main/llm/types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} } }))

const session = (name: string, platform: Session['platform']): Session => ({
  id: 'saved-' + name, name, platform, host: name + '.example.test', port: 22, protocol: 'ssh', folderId: 'site', username: 'private-admin',
  notes: 'private-note', tags: ['private-site'], options: {}, credentialId: 'private-login', logToFile: false, color: null, favorite: false, lastConnectedAt: null
})
const deviceA = session('core-alpha', 'iosxe')
const deviceB = session('core-bravo', 'eos')
const firewall = session('border-charlie', 'fortios')
const folders = [{ id: 'site', parentId: null, name: 'Customer West', sort: 0 }]
const reply = (answer: string): TurnResult => ({ stop: 'end', message: { role: 'assistant', parts: [{ type: 'text', text: answer }] } })
const config = (turn: LlmProvider['turn'], sessions = [deviceA, deviceB, firewall]) => new WorkspaceChat(
  () => ({ sessions, folders }), async () => ({ id: 'test', capabilities: { tools: false, maxContext: 8000 }, turn })
)
const withDevices = (prose: string, choices: unknown[]) => prose + '\n```devices\n' + JSON.stringify(choices) + '\n```'
const recommendation = (device: string) => ({ device, reason: 'Check the tunnel endpoint for phase two failures.', question: 'Is the site tunnel established, and what read-only evidence explains the outage?' })

describe('workspace assistant', () => {
  it('shares candidate metadata only when the question calls for it', async () => {
    const requests: TurnRequest[] = []
    const chat = config(async req => { requests.push(req); return reply('OK') })
    for (const q of ['Hi', 'What is OSPF?', 'What is a VPN?', 'Which sessions are saved?']) await chat.ask(q)
    for (const req of requests.slice(0, 3)) expect(req.system).toContain('Current saved candidates: []')
    expect(requests[3]!.system).toContain('Total saved sessions: 3')
    expect(requests[3]!.system).toContain('"ref":"D3"')
  })

  it('answers without any sessions or tool support, remembers follow-ups, bounds history and resets', async () => {
    const requests: TurnRequest[] = []
    const chat = config(async req => { requests.push(req); return reply('Which clients see the timeouts?') }, [])
    for (let i = 0; i < 11; i++) expect((await chat.ask('Exchange number ' + i)).devices).toEqual([])
    expect(requests.at(-1)?.messages).toHaveLength(17)
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Exchange number 2')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Exchange number 0')
    expect(requests[1]?.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(requests[0]?.tools).toEqual([])
    expect(requests[0]?.meta).toEqual({ source: 'workspace' })
    chat.reset()
    await chat.ask('New conversation')
    expect(requests.at(-1)?.messages).toHaveLength(1)
  })

  it('limits recommendations to saved candidates, resolves aliases locally and protects the wire request', async () => {
    const chat = config(async req => {
      const wire = JSON.stringify([req.system, req.messages])
      for (const confidential of ['core-alpha', 'Customer West', 'private-site', 'private-admin', 'private-note', 'private-login', 'example.test']) {
        expect(wire.toLowerCase()).not.toContain(confidential.toLowerCase())
      }
      const alias = /(device-\d+-[a-f\d]{6})/.exec(req.system)![1]
      return reply(withDevices('Start with ' + alias + '.', [
        recommendation('invented-id'), { ...recommendation('D1'), command: 'extra field' }, recommendation('D1'), recommendation('D1'), recommendation('D2')
      ]))
    })
    const response = await chat.ask('Check core-alpha in Customer West for private-site')
    expect(response.text).toBe('Start with core-alpha.')
    expect(response.devices).toEqual([{ sessionId: deviceA.id, name: deviceA.name, reason: recommendation('D1').reason, question: recommendation('D1').question }])
  })

  it('keeps multiple matching saved sessions available and gives a handoff task for text-only replies', async () => {
    const chat = config(async () => reply('Which core device should we inspect?'))
    const ambiguous = await chat.ask('Log into core and check interfaces')
    expect(ambiguous.devices.map(d => d.sessionId)).toEqual([deviceA.id, deviceB.id])
    expect(ambiguous.devices.every(d => d.reason.includes('session name matches “core”'))).toBe(true)
    expect(ambiguous.devices.every(d => d.question.includes('interface state and counters') && d.question.includes('Log into core and check interfaces'))).toBe(true)
    const symptom = await chat.ask('The site VPN tunnel is down')
    expect(symptom.devices.map(d => d.sessionId)).toEqual([firewall.id])
    expect(symptom.devices[0]?.reason).toMatch(/Fortinet FortiOS.*firewall/)
    expect(symptom.devices[0]?.question).toContain('tunnel counters')
    const concept = await chat.ask('What is a VPN?')
    expect(concept.devices).toEqual([])
  })

  it('prefers the complete saved name and supports explicit requests naming both transports', async () => {
    const ssh = session('core-sw1', 'iosxe')
    const telnet = { ...session('core-sw1 (telnet)', 'iosxe'), host: ssh.host, protocol: 'telnet' as const }
    const chat = config(async () => reply('Check interface state.'), [ssh, telnet])
    expect((await chat.ask('Check core-sw1 (telnet)')).devices.map(d => d.name)).toEqual([telnet.name])
    expect((await chat.ask('Check core-sw1')).devices.map(d => d.name)).toEqual([ssh.name])
    expect((await chat.ask('Check core-sw1 and core-sw1 (telnet)')).devices.map(d => d.name).sort()).toEqual([ssh.name, telnet.name])
    expect((await chat.ask('Check Customer West')).devices.every(d => d.reason.includes('saved folder “Customer West”'))).toBe(true)
    expect((await chat.ask('Inspect private-site')).devices.every(d => d.reason.includes('saved tag “private-site”'))).toBe(true)
  })

  it('omits invalid choices, incomplete footers and targets removed during a request', async () => {
    const sessions = [deviceA, deviceB]
    const chat = config(async () => {
      sessions.shift()
      return reply(withDevices('Check the interface counters.', [recommendation('D1'), recommendation('made-up')]))
    }, sessions)
    expect((await chat.ask('Check core-alpha')).devices).toEqual([])
    const malformed = config(async () => reply('Look at the error counters.\n```devices\n!broken'))
    expect(await malformed.ask('What is an input error?')).toEqual({ text: 'Look at the error counters.', devices: [] })
  })

  it('isolates windows and cancels pending work on navigation even when an adapter finishes late', async () => {
    const requests: TurnRequest[] = []
    let finish!: (result: TurnResult) => void
    const channels = workspaceChatHandlers(() => config(async req => {
      requests.push(req)
      if (req.messages.some(m => m.parts.some(p => p.type === 'text' && p.text === 'Waiting'))) return new Promise(resolve => { finish = resolve })
      return reply('OK')
    }))
    const a = new EventEmitter(), b = new EventEmitter()
    const invoke = (win: EventEmitter, q: string) => {
      const h = channels['workspaceChat:ask']
      return h.fn(h.schema.parse({ question: q }) as never, { sender: win } as unknown as IpcMainInvokeEvent)
    }
    await invoke(a, 'First question')
    await invoke(b, 'Separate conversation')
    expect(requests[1]!.messages).toHaveLength(1)
    const pending = invoke(a, 'Waiting')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(requests[2]!.messages).toHaveLength(3)
    await expect(invoke(a, 'Double send')).rejects.toThrow(/already in progress/)
    a.emit('did-navigate')
    expect(requests[2]!.signal.aborted).toBe(true)
    await invoke(a, 'Fresh chat')
    finish(reply('Stale reply'))
    await expect(pending).rejects.toThrow(/cancelled/)
    await invoke(a, 'Follow up on fresh chat')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toMatch(/First question|Waiting|Stale reply/)
    await invoke(b, 'Follow up in second window')
    expect(requests.at(-1)?.messages).toHaveLength(3)
  })
})
