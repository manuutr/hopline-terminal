import { describe, expect, it } from 'vitest'
import { scpCommand, scpPathProblem } from '../src/scp.ts'

// Phase 4 fix-round review S1: `~/x` was quoted (never expanded), and device SCP servers that read
// the path themselves (IOS, NX-OS, FortiOS) got the quotes as part of the name.
describe('S1: SCP paths', () => {
  it('a leading ~/ stays unquoted so the shell expands it; the rest is plain or quoted', () => {
    expect(scpCommand('send', '~/fw.bin')).toBe('scp -t ~/fw.bin')
    expect(scpCommand('send', '~')).toBe('scp -t ~')
    expect(scpCommand('receive', '~/my file;x.bin')).toBe(`scp -f ~/'my file;x.bin'`)
    // Not a home-folder form: quoted whole as before.
    expect(scpCommand('send', '~root/x')).toBe(`scp -t '~root/x'`)
    expect(scpCommand('send', '~/$(reboot)')).toBe(`scp -t ~/'$(reboot)'`)
  })
  it('devices that parse the path themselves refuse paths that need quoting, with a clear reason', () => {
    for (const p of ['ios', 'iosxe', 'nxos', 'fortios', 'asa']) {
      expect(scpPathProblem(p, 'flash:c2900.bin')).toBeNull()
      expect(scpPathProblem(p, 'flash:my file.bin')).toMatch(/reads the path itself.*flash:my_file\.bin/)
      expect(scpPathProblem(p, '~/x.bin')).toMatch(/"~" is not a home folder/)
    }
  })
  it('shells and unknown platforms take any path (quoted by scpCommand)', () => {
    for (const p of ['junos', 'eos', 'auto', 'linux']) expect(scpPathProblem(p, "~/it's a;b.bin")).toBeNull()
  })
})
