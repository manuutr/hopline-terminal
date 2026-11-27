import { describe, expect, it } from 'vitest'
import { classify } from '@hopline/guard'
import { ARCHIVE_FILE_RE, NET_NAME_RE, PLATFORM_IDS, archiveSucceeds, eosNetState, SAFETY_NETS, netLineAllowed, safetyNet, type PlatformId } from '../src/index'

const NAME = 'hopline-0a1b2c3d'

describe('platform safety nets (cli-model safety-net.ts)', () => {
  it('covers exactly Junos, EOS, NX-OS and IOS-XE; every other platform relies on rollback lines', () => {
    expect(Object.keys(SAFETY_NETS).sort()).toEqual(['eos', 'iosxe', 'junos', 'nxos'])
    expect(SAFETY_NETS.junos!.kind).toBe('commit-confirmed')
    expect(SAFETY_NETS.eos!.kind).toBe('session-timer')
    expect(SAFETY_NETS.nxos!.kind).toBe('checkpoint')
    expect(SAFETY_NETS.iosxe!.kind).toBe('archive')
    for (const p of PLATFORM_IDS.filter((x) => !(x in SAFETY_NETS))) expect(safetyNet(p)).toBeUndefined()
    expect(NET_NAME_RE.test(NAME)).toBe(true)
  })

  /** Every line a net generates, with the mode it is typed in. */
  const generated = (p: PlatformId): [string, 'exec' | 'config'][] => {
    const n = SAFETY_NETS[p]!
    const s = n.session(NAME, 5)
    const net = new Set(n.sessionNetLines(NAME, 5))
    return [
      ...n.arm(NAME).map((l) => [l, 'exec'] as [string, 'exec']),
      ...s.enter.filter((l) => net.has(l)).map((l) => [l, 'exec'] as [string, 'exec']),
      ...s.commit.filter((l) => net.has(l)).map((l) => [l, 'config'] as [string, 'config']),
      ...n.confirm(NAME).map((l) => [l, l === 'configure private' || l.startsWith('configure session') ? 'exec' : 'config'] as [string, 'exec' | 'config']),
      ...n.rollback(NAME, 'flash:archive/core-sw1-3').map((l) => [l, l === 'configure private' || /^(configure|rollback running|archive)/.test(l) ? 'exec' : 'config'] as [string, 'exec' | 'config']),
      ...(n.cleanup?.(NAME) ?? []).map((l) => [l, 'exec'] as [string, 'exec'])
    ]
  }

  it.each(['junos', 'eos', 'nxos', 'iosxe'] as const)('%s: every generated net line matches a template in its mode, and nowhere else', (p) => {
    const lines = generated(p)
    expect(lines.length).toBeGreaterThan(0)
    for (const [line, mode] of lines) {
      expect(netLineAllowed(p, line, mode), `${line} (${mode})`).toBe(true)
      // Another platform's host never accepts it.
      for (const other of ['ios', 'iosxr', 'panos'] as const) expect(netLineAllowed(other, line, mode)).toBe(false)
    }
  })

  it('the deny-list still blocks the app-owned lines for the agent (they are never unblocked)', () => {
    expect(classify('configure replace flash:archive/core-sw1-3 force', 'iosxe').kind).toBe('blocked')
    expect(classify('archive config', 'iosxe').kind).toBe('blocked')
    expect(classify(`rollback running-config checkpoint ${NAME}`, 'nxos').kind).toBe('blocked')
    expect(classify(`configure session ${NAME}`, 'eos').kind).toBe('blocked')
    expect(classify(`configure session ${NAME} commit`, 'eos').kind).toBe('blocked')
    expect(classify(`configure session ${NAME} abort`, 'eos').kind).toBe('blocked')
    expect(classify('rollback 1', 'junos', { mode: 'config' }).kind).toBe('disruptive')
  })

  it('templates refuse anything but the exact shapes: other names, extra words, other files, other modes', () => {
    const no: [PlatformId, string, 'exec' | 'config'][] = [
      ['eos', 'configure session evil', 'exec'],
      ['eos', `configure session ${NAME} commit timer 00:05:00`, 'exec'],
      ['eos', `configure session ${NAME}`, 'config'],
      ['eos', 'commit timer 01:00:00', 'config'],
      ['eos', 'commit', 'config'],
      ['eos', 'configure replace startup-config', 'exec'],
      ['nxos', 'rollback running-config checkpoint user-checkpoint-1', 'exec'],
      ['nxos', `rollback running-config checkpoint ${NAME} best-effort`, 'exec'],
      ['nxos', `checkpoint ${NAME} description x`, 'exec'],
      ['nxos', 'checkpoint file bootflash:x', 'exec'],
      ['iosxe', 'configure replace flash:archive/core-sw1-3', 'exec'],
      ['iosxe', 'configure replace flash:archive/core-sw1-3 force list', 'exec'],
      ['iosxe', 'configure replace tftp://10.0.0.1/evil force', 'exec'],
      ['iosxe', 'configure replace flash:a;b force', 'exec'],
      ['iosxe', 'configure replace flash://10.0.0.1/x force', 'exec'],
      ['iosxe', 'configure replace flash:../x force', 'exec'],
      ['iosxe', 'configure replace http:x force', 'exec'],
      ['iosxe', 'configure replace flash:archive/core-sw1-3 force', 'config'],
      ['iosxe', 'archive config', 'config'],
      ['junos', 'commit confirmed 31', 'config'],
      ['junos', 'commit confirmed', 'config'],
      ['junos', 'commit', 'config'],
      ['junos', 'rollback 2', 'config'],
      ['junos', 'rollback 1', 'exec'],
      ['junos', 'load override terminal', 'config'],
      ['junos', ' configure private', 'exec']
    ]
    for (const [p, line, mode] of no) expect(netLineAllowed(p, line, mode), `${p}: ${line} (${mode})`).toBe(false)
  })

  it('IOS-XE learns the archive file the device chose, and only a well-formed one', () => {
    const parse = SAFETY_NETS.iosxe!.learn!.parse
    expect(parse('   3        flash:archive/core-sw1-3 <- Most Recent\n')).toBe('flash:archive/core-sw1-3')
    expect(parse(' Archive feature not enabled')).toBeNull()
    expect(parse('   1        flash:evil;reload <- Most Recent')).toBeNull()
    expect(SAFETY_NETS.iosxe!.rollback(NAME, 'flash:bad file')).toEqual([])
  })

  it('timer checks are bound to THIS change (Phase 5 review H1/L3): pending, confirmed, rolled back or unknown', () => {
    const j = SAFETY_NETS.junos!.check!
    const row = (i: number, how: string, comment?: string) => `${i}   2026-11-25 10:0${i}:00 UTC by ${how}${comment ? `\n    ${comment}` : ''}`
    const hist = (...rows: [string, string?][]) => rows.map(([how, c], i) => row(i, how, c)).join('\n')
    const ours = (mins = 5) => [`admin via cli commit confirmed, rollback in ${mins}mins`, NAME] as [string, string]
    const oursDone: [string, string] = ['admin via cli commit confirmed', NAME]
    expect(j.state(hist(ours(), ['admin via cli']), NAME)).toBe('pending')
    expect(j.state(hist(['admin via cli', `${NAME}-ok`], oursDone, ['admin via cli']), NAME)).toBe('confirmed')
    expect(j.state(hist(['admin via cli', `${NAME}-undo`], oursDone), NAME)).toBe('rolled-back')
    expect(j.state(hist(['root via other'], oursDone), NAME)).toBe('rolled-back')
    // Another change's commit confirmed at index 0: not ours, so not pending (H1).
    expect(j.state(hist(['admin via cli commit confirmed, rollback in 5mins', 'hopline-ffffffff'], oursDone), NAME)).toBe('unknown')
    // Another admin's plain commit after ours confirmed it: never "rolled back" (L3).
    expect(j.state(hist(['bob via cli'], oursDone), NAME)).toBe('unknown')
    // The timer fired, then our `rollback 1` loaded OUR commit again: it is live, not rolled back.
    expect(j.state(hist(['admin via cli', `${NAME}-undo`], ['root via other'], oursDone), NAME)).toBe('unknown')
    // The timer fired before our confirm: the confirm committed nothing; the change is not in effect.
    expect(j.state(hist(['admin via cli', `${NAME}-ok`], ['root via other'], oursDone), NAME)).toBe('rolled-back')
    // A history without our commit is never a positive claim (the comment may print differently)…
    expect(j.state(hist(['admin via cli']), NAME)).toBe('unknown')
    // …only `absent`, used right after a commit that did not answer, says it never reached the device.
    expect(j.absent!(hist(['admin via cli']), NAME)).toBe(true)
    expect(j.absent!(hist(ours()), NAME)).toBe(false)
    expect(j.absent!(hist(['admin via cli commit confirmed, rollback in 5mins']), NAME)).toBe(false)
    expect(j.absent!('error: permission denied', NAME)).toBe(false)
    // Not a history at all (an error, a refusal, nothing).
    expect(j.state('error: permission denied', NAME)).toBe('unknown')
    expect(j.state('', NAME)).toBe('unknown')
    expect(j.state(`1   2026-11-25 10:00:00 UTC by admin via cli commit confirmed, rollback in 5mins\n    ${NAME}`, NAME)).toBe('unknown')

    const e = SAFETY_NETS.eos!.check!
    const table = (...rows: string[]) => ['  Name          State               User        Terminal', '  ------------- ------------------- ----------- --------', ...rows].join('\n')
    expect(e.state(table(`  ${NAME}pendingCommitTimer  admin`), NAME)).toBe('pending')
    expect(e.state(table(`* ${NAME}   pendingCommitTimer  admin  vty3`), NAME)).toBe('pending')
    expect(e.state(table(`  ${NAME}   completed`), NAME)).toBe('confirmed')
    // A missing row is a rollback only after a complete read (B-7).
    expect(e.state(table('  other-session   pendingCommitTimer'), NAME, true)).toBe('rolled-back')
    expect(e.state(table('  other-session   pendingCommitTimer'), NAME)).toBe('unknown')
    expect(e.state(table(`  ${NAME}   pending   admin`), NAME)).toBe('unknown')
    expect(e.state('% Invalid input', NAME)).toBe('unknown')
  })

  it('IOS-XE: a new archive must follow the previous one (Phase 5 review L5)', () => {
    expect(archiveSucceeds('flash:archive/core-sw1-3', 'flash:archive/core-sw1-4')).toBe(true)
    expect(archiveSucceeds(null, 'flash:archive/core-sw1-1')).toBe(true)
    expect(archiveSucceeds('flash:archive/core-sw1-3', 'flash:archive/core-sw1-3')).toBe(false)
    expect(archiveSucceeds('flash:archive/core-sw1-3', 'flash:archive/core-sw1-2')).toBe(false)
    expect(archiveSucceeds('flash:archive/core-sw1-3', 'bootflash:archive/core-sw1-9')).toBe(false)
    expect(archiveSucceeds('flash:archive/core-sw1-3', 'flash:other/core-sw1-9')).toBe(false)
    expect(archiveSucceeds('flash:a-Nov-25-10-00-00.123-3', 'flash:a-Nov-25-10-05-00.456-4')).toBe(true)
    expect(archiveSucceeds(null, 'flash:archive/core-sw1')).toBe(false)
    expect(archiveSucceeds(null, null)).toBe(false)
    for (const f of ['nvram:startup-config', 'nvram:archive-1', 'flash:/', 'bootflash:/', 'flash:', 'flash:dir/']) expect(ARCHIVE_FILE_RE.test(f), f).toBe(false)
    expect(ARCHIVE_FILE_RE.test('flash:/archive-1')).toBe(true)
    expect(netLineAllowed('iosxe', 'configure replace nvram:startup-config force', 'exec')).toBe(false)
    expect(netLineAllowed('iosxe', 'configure replace flash:/ force', 'exec')).toBe(false)
  })

  it('Junos net lines carry the change comment; a plain commit is never a net line', () => {
    expect(netLineAllowed('junos', `commit confirmed 5 comment ${NAME}`, 'config')).toBe(true)
    expect(netLineAllowed('junos', `commit comment ${NAME}-ok and-quit`, 'config')).toBe(true)
    expect(netLineAllowed('junos', `commit comment ${NAME}-undo and-quit`, 'config')).toBe(true)
    for (const l of ['commit and-quit', 'commit confirmed 5', `commit confirmed 5 comment ${NAME}-ok`, `commit comment ${NAME} and-quit`, 'commit comment evil-ok and-quit', `commit comment "${NAME}-ok" and-quit`])
      expect(netLineAllowed('junos', l, 'config'), l).toBe(false)
  })

  it('timer minutes are bounded (1 to 30) in the template', () => {
    expect(netLineAllowed('junos', `commit confirmed 30 comment ${NAME}`, 'config')).toBe(true)
    expect(netLineAllowed('junos', `commit confirmed 0 comment ${NAME}`, 'config')).toBe(false)
    expect(netLineAllowed('eos', 'commit timer 00:30:00', 'config')).toBe(true)
    expect(netLineAllowed('eos', 'commit timer 00:31:00', 'config')).toBe(false)
  })
})

describe('EOS session state (Phase 8 review B-7)', () => {
  const HEAD = 'Maximum number of completed sessions: 1\n   Name                    State             User    Terminal\n   ----------------------- ----------------- ------- --------\n'
  it('a session whose name extends ours is not ours', () => {
    // The review's repro.
    expect(eosNetState(`${HEAD}   ${NAME}completed pending\n   ${NAME}-x       completed\n`, NAME, true)).toBe('rolled-back')
    expect(eosNetState(`${HEAD}   ${NAME}completed pending\n`, NAME, false)).toBe('unknown')
    // As EOS draws such a session (fixed-width columns: the long name runs into its state).
    expect(eosNetState(`${HEAD}   ${NAME}completedpending             admin\n`, NAME, true)).toBe('rolled-back')
    expect(eosNetState(`${HEAD}   ${NAME}pendingCommitTimercompleted\n`, NAME, true)).toBe('rolled-back')
  })
  it('our row is read by its state', () => {
    expect(eosNetState(`${HEAD}   ${NAME}        pendingCommitTimer admin   vty3\n`, NAME, true)).toBe('pending')
    expect(eosNetState(`${HEAD}   ${NAME}pendingCommitTimer  admin\n`, NAME, true)).toBe('pending')
    expect(eosNetState(`${HEAD}   ${NAME}completed\n`, NAME, true)).toBe('confirmed')
    expect(eosNetState(`${HEAD} * ${NAME}        completed\n`, NAME, true)).toBe('confirmed')
    // The name alone on its line does not take the next line's first word as its state.
    expect(eosNetState(`${HEAD}   ${NAME}\n   completed\n`, NAME, true)).toBe('rolled-back')
  })
  it('header but no row: rolled back only after a complete read with no pager or truncation marker', () => {
    const missing = `${HEAD}   other                   completed\n`
    expect(eosNetState(missing, NAME, true)).toBe('rolled-back')
    expect(eosNetState(missing, NAME)).toBe('unknown')
    expect(eosNetState(missing + ' --More-- ', NAME, true)).toBe('unknown')
    expect(eosNetState('no table here', NAME, true)).toBe('unknown')
  })
})
