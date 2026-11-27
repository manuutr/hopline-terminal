import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeIosDevice, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AgentEventBody, Settings } from '@shared/types'
import { policyBlocked } from '@shared/policy-deny'
import { FAIL_CLOSED, loadPolicy, parsePolicy, PolicyService, POLICY_ENV } from '../src/main/policy/policy'
import { Repo } from '../src/main/db/repo'
import { openDb } from '../src/main/db'
import { AuditLog } from '../src/main/db/audit'
import { PolicyLockedError, SettingsService } from '../src/main/settings'
import { AiService } from '../src/main/llm/service'
import { analyze } from '../src/main/productivity/runner'
import { DeviceTools } from '../src/main/agent/device-tools'
import { FleetService } from '../src/main/fleet/service'
import { fakeAnthropic, fakeOllama } from './fake-llm'
import { fakeTab, localControl } from './helpers'
import { policyRefusal } from '../src/session-host/guard-check'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} } }))

const dir = mkdtempSync(join(tmpdir(), 'hopline-policy-'))
const file = (name: string, text: string) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}
const NOWHERE = join(dir, 'no-admin', 'policy.json')

describe('policy file: format and fail-closed loading', () => {
  it('a valid policy gives its locks', () => {
    const p = parsePolicy(
      JSON.stringify({
        version: 1,
        name: 'ACME NetOps',
        readOnly: true,
        blockedCommands: { all: ['debug'], iosxe: ['show running-config'] },
        allowedProviders: ['ollama'],
        allowedOllamaEndpoints: ['http://10.0.0.5:11434/'],
        fleet: { maxConcurrency: 2, maxTokenBudget: 100_000 },
        maxRunTokenBudget: 50_000,
        requireEgressLog: true
      }),
      '/etc/hopline/policy.json'
    )
    expect(p).toMatchObject({
      state: 'active',
      name: 'ACME NetOps',
      locks: {
        readOnly: true,
        allowedProviders: ['ollama'],
        allowedOllamaEndpoints: ['http://10.0.0.5:11434'],
        blockedCommands: { all: ['debug'], iosxe: ['show running-config'] },
        fleetMaxConcurrency: 2,
        fleetMaxTokenBudget: 100_000,
        runMaxTokenBudget: 50_000,
        egressLogRequired: true,
        aiDisabled: false
      }
    })
  })

  it.each([
    ['not JSON', '{ readOnly: true'],
    ['an unknown key', JSON.stringify({ version: 1, readonly: true })],
    ['a wrong type', JSON.stringify({ version: 1, readOnly: 'yes' })],
    ['an unknown platform', JSON.stringify({ version: 1, blockedCommands: { cisco: ['reload'] } })],
    ['an unknown provider', JSON.stringify({ version: 1, allowedProviders: ['unknown-cloud'] })],
    ['a missing version', JSON.stringify({ readOnly: true })],
    ['an Ollama URL with credentials', JSON.stringify({ version: 1, allowedOllamaEndpoints: ['http://u:p@10.0.0.5:11434'] })],
    ['concurrency out of range', JSON.stringify({ version: 1, fleet: { maxConcurrency: 99 } })]
  ])('%s fails closed: read-only on, AI off', (_why, text) => {
    const p = parsePolicy(text, '/x/policy.json')
    expect(p.state).toBe('invalid')
    expect(p.locks).toEqual(FAIL_CLOSED)
    expect(new PolicyService(p).aiOff()).toMatch(/AI is turned off: the team policy file \/x\/policy.json is invalid/)
  })

  it('the admin location wins over HOPLINE_POLICY; the env path is used only without an admin file', () => {
    const admin = file('admin.json', JSON.stringify({ version: 1, name: 'admin', readOnly: true }))
    const user = file('user.json', JSON.stringify({ version: 1, name: 'user' }))
    expect(loadPolicy({ adminPath: admin, env: { [POLICY_ENV]: user } })).toMatchObject({ state: 'active', name: 'admin', source: admin })
    expect(loadPolicy({ adminPath: NOWHERE, env: { [POLICY_ENV]: user } })).toMatchObject({ state: 'active', name: 'user', source: user })
    expect(loadPolicy({ adminPath: NOWHERE, env: {} })).toMatchObject({ state: 'none' })
  })

  it('HOPLINE_POLICY pointing at a missing file, a directory, or an oversized file fails closed', () => {
    expect(loadPolicy({ adminPath: NOWHERE, env: { [POLICY_ENV]: join(dir, 'missing.json') } })).toMatchObject({ state: 'invalid', error: 'the file does not exist' })
    const d = join(dir, 'a-dir')
    mkdirSync(d)
    expect(loadPolicy({ adminPath: NOWHERE, env: { [POLICY_ENV]: d } })).toMatchObject({ state: 'invalid', error: 'not a regular file' })
    expect(loadPolicy({ adminPath: NOWHERE, env: { [POLICY_ENV]: file('big.json', ' '.repeat(300 * 1024)) } })).toMatchObject({ state: 'invalid', error: expect.stringMatching(/larger than/) })
  })

  it.skipIf(process.platform === 'win32' || userInfo().uid === 0)('an admin file that cannot be read (EACCES) fails closed, not "no policy"', () => {
    const p = file('locked.json', JSON.stringify({ version: 1 }))
    chmodSync(p, 0o000)
    expect(loadPolicy({ adminPath: p, env: {} })).toMatchObject({ state: 'invalid', error: 'cannot be read (EACCES)' })
    chmodSync(p, 0o600)
  })
})

describe('extra blocked commands: matched on canonical words, so abbreviations do not get around them', () => {
  const rules = { iosxe: ['show running-config', 'write erase', 'snmp-server community'], all: ['debug'], ios: ['sh ver'] }
  it.each([
    ['show running-config', 'iosxe'],
    ['sh run', 'iosxe'],
    ['sh run | i snmp', 'iosxe'],
    ['do sh run', 'iosxe'],
    ['  SHOW   Running-Config ', 'iosxe'],
    ['wr er', 'iosxe'],
    ['snmp-server community s3cret RO', 'iosxe'],
    ['snmp comm s3cret RO', 'iosxe'],
    ['debug ip packet', 'eos'],
    ['deb ip packet', 'iosxe'],
    // The pattern itself may be abbreviated ("sh ver").
    ['show version', 'ios']
  ])('%s on %s is blocked', (cmd, platform) => {
    expect(policyBlocked(rules, platform, cmd)).toMatch(/blocked by team policy/)
  })

  it.each([
    ['show ip route', 'iosxe'],
    ['show running-config', 'nxos'],
    ['show ipv6 route', 'iosxe'],
    ['show version', 'iosxe'],
    ['show interfaces status', 'iosxe']
  ])('%s on %s is not', (cmd, platform) => {
    expect(policyBlocked(rules, platform, cmd)).toBeNull()
  })

  it('the session host refuses them again, from the rules main sent at init', () => {
    expect(policyRefusal(rules, 'iosxe', 'sh run')).toBe('refused by session host: blocked by team policy ("show running-config")')
    expect(policyRefusal(rules, 'iosxe', 'show clock')).toBeNull()
    expect(policyRefusal({}, 'iosxe', 'sh run')).toBeNull()
  })

  it('previews of snippets and multi-device runs show the policy refusal', () => {
    expect(analyze('iosxe', ['sh run'], { policy: rules })).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/"sh run" is blocked by team policy \("show running-config"\)/) })
    expect(analyze('iosxe', ['show clock'], { policy: rules })).toMatchObject({ kind: 'read' })
  })
})

describe('the assistant meets the policy deny-list before the device', () => {
  let sim: RunningSim
  beforeAll(async () => {
    sim = await startSim({ device: makeIosDevice(), port: 0 })
  })
  afterAll(() => sim.close())

  it('a policy-blocked read is refused, audited as blocked, and nothing is sent', async () => {
    const { tab, client } = await fakeTab(sim.port)
    const audit = new AuditLog(openDb(':memory:'))
    const sent: string[] = []
    const ctl = localControl(tab)
    const term = { ...ctl, exec: (...a: Parameters<typeof ctl.exec>) => (sent.push(a[1]), ctl.exec(...a)), policyRules: { iosxe: ['show running-config'] } }
    const events: AgentEventBody[] = []
    const settings = { get: () => ({ aiReadOnly: true, commandTimeoutMs: 5000, outputCapBytes: 512 * 1024 }) as Settings }
    const dt = new DeviceTools(tab, { term, settings, audit, emit: (e) => events.push(e) }, { proposeConfig: async () => ({ text: '' }), proposeDisruptive: async () => ({ text: '' }) } as never)
    const r = await dt.call('run_show_command', { command: 'sh run', reason: 'x' }, { runId: 'r', signal: new AbortController().signal })
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/^BLOCKED: blocked by team policy \("show running-config"\)/) })
    expect(sent).toEqual([])
    expect(audit.list()[0]).toMatchObject({ command: 'sh run', decision: 'blocked', reason: 'blocked by team policy ("show running-config")' })
    expect((await dt.call('run_show_command', { command: 'show clock', reason: 'x' }, { runId: 'r', signal: new AbortController().signal })).isError).toBeFalsy()
    expect(sent).toEqual(['show clock'])
    client.end()
  })
})

describe('settings under a policy', () => {
  const service = (locks: PolicyService) => new SettingsService(new Repo(openDb(':memory:')), undefined, undefined, () => locks.locks)
  const active = (o: object) => new PolicyService(parsePolicy(JSON.stringify({ version: 1, ...o }), '/p.json'))

  it('read-only is forced on and cannot be turned off; repeating the value is fine and is not saved as the user\'s', () => {
    const repo = new Repo(openDb(':memory:'))
    new SettingsService(repo).update({ aiReadOnly: false })
    const s = new SettingsService(repo, undefined, undefined, () => active({ readOnly: true }).locks)
    expect(s.get().aiReadOnly).toBe(true)
    expect(() => s.update({ aiReadOnly: false })).toThrow(PolicyLockedError)
    // General → Save sends every field, the locked one included.
    s.update({ ...s.get(), theme: 'light' })
    expect(s.get()).toMatchObject({ aiReadOnly: true, theme: 'light' })
    // Without the policy, the user's own choice is still there.
    expect(new SettingsService(repo).get().aiReadOnly).toBe(false)
  })

  it('a provider the policy does not allow is not configured and cannot be picked', () => {
    const s = service(active({ allowedProviders: ['ollama'] }))
    expect(s.get()).toMatchObject({ aiProvider: 'anthropic', aiConfigured: false })
    s.update({ ...s.get() }) // saving the current (disallowed) value is not a change
    expect(() => s.update({ aiProvider: 'anthropic', aiModel: 'x' })).not.toThrow()
    s.update({ aiProvider: 'ollama', ollamaModel: 'qwen3:8b' })
    expect(s.get()).toMatchObject({ aiProvider: 'ollama', aiConfigured: true })
    expect(() => s.update({ aiProvider: 'anthropic' })).toThrow(/managed by the team policy/)
  })

  it('the egress log is required and the run budget capped', () => {
    const s = service(active({ requireEgressLog: true, maxRunTokenBudget: 50_000 }))
    expect(s.get()).toMatchObject({ egressLog: true, aiRunTokenBudget: 50_000 })
    expect(() => s.update({ egressLog: false })).toThrow(PolicyLockedError)
    expect(() => s.update({ aiRunTokenBudget: 80_000 })).toThrow(/run budget above 50,000/)
    s.update({ aiRunTokenBudget: 20_000 })
    expect(s.get().aiRunTokenBudget).toBe(20_000)
  })

  it('an invalid policy: read-only, AI not configured', () => {
    const s = service(new PolicyService(parsePolicy('nope', '/p.json')))
    expect(s.get()).toMatchObject({ aiReadOnly: true, aiConfigured: false, egressLog: true })
  })
})

describe('providers under a policy', () => {
  const settings = (p: Partial<Settings>, key = 'sk-ant-policy-CANARY') => {
    let s = { aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', ollamaEndpoint: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', egressLog: false, ...p } as Settings
    return { get: () => ({ ...s, aiConfigured: true }), update: (x: Partial<Settings>) => ((s = { ...s, ...x }), s), apiKey: async () => key, setApiKey: async () => s } as unknown as SettingsService
  }

  it('Ollama-only: nothing goes to Anthropic, not even the connect check', async () => {
    const api = await fakeAnthropic()
    const policy = new PolicyService(parsePolicy(JSON.stringify({ version: 1, allowedProviders: ['ollama'] }), '/p.json'))
    const ai = new AiService(settings({}), { anthropicBaseURL: api.url, policy })
    expect(await ai.test({ provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-x' })).toMatchObject({ ok: false, code: 'policy', message: expect.stringMatching(/Anthropic \(cloud\) is not allowed by the team policy/) })
    expect(await ai.connect({ provider: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-x' })).toMatchObject({ ok: false, code: 'policy' })
    await expect(ai.provider()).rejects.toThrow(/not allowed by the team policy/)
    expect(await ai.health()).toMatchObject({ ok: false, policy: expect.stringMatching(/not allowed/) })
    expect(api.requests).toEqual([])
    await api.close()
  })

  it('an Ollama server outside the allowed list is refused for discovery, test and runs', async () => {
    const o = await fakeOllama()
    const policy = new PolicyService(parsePolicy(JSON.stringify({ version: 1, allowedOllamaEndpoints: ['http://10.9.9.9:11434'] }), '/p.json'))
    const ai = new AiService(settings({ aiProvider: 'ollama', ollamaEndpoint: o.url }), { policy })
    expect(await ai.ollamaModels(o.url)).toMatchObject({ ok: false, code: 'policy' })
    expect(await ai.test({ provider: 'ollama', model: 'qwen3:8b', endpoint: o.url })).toMatchObject({ ok: false, code: 'policy' })
    await expect(ai.provider()).rejects.toThrow(/This Ollama server is not allowed/)
    expect(o.requests).toEqual([])
    await o.close()
  })

  it('an invalid policy turns the AI off', async () => {
    const policy = new PolicyService(parsePolicy('{', '/etc/hopline/policy.json'))
    const ai = new AiService(settings({ aiProvider: 'ollama' }), { policy })
    await expect(ai.provider()).rejects.toThrow(/AI is turned off: the team policy file \/etc\/hopline\/policy.json is invalid/)
  })

  it('fleet: concurrency and budget never go above the policy; an invalid policy refuses the run', () => {
    const fleet = (p: { fleetMaxConcurrency: number | null; fleetMaxTokenBudget: number | null; aiOff: string | null }) =>
      new FleetService({ host: {} as never, repo: {} as never, settings: { get: () => ({ aiProvider: 'anthropic' }) as Settings }, audit: { append: () => {} }, provider: async () => Promise.reject(new Error('x')), emit: () => {}, policy: () => p })
    expect(fleet({ fleetMaxConcurrency: 2, fleetMaxTokenBudget: 50_000, aiOff: null }).info()).toMatchObject({ maxConcurrency: 2, defaults: { concurrency: 2, tokens: 50_000 } })
    expect(fleet({ fleetMaxConcurrency: null, fleetMaxTokenBudget: null, aiOff: null }).info()).toMatchObject({ maxConcurrency: 8, defaults: { concurrency: 4, tokens: 400_000 } })
  })
})
