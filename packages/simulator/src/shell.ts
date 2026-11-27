/**
 * One interactive CLI session on a simulated device. Kept for the SSH/Telnet servers and older
 * callers: a Terminal driven by the device platform's personality (vendors/index.ts).
 */
import { Terminal, type TerminalOptions } from './core/terminal.ts'
import { personalityFor } from './vendors/index.ts'
import type { Device } from './state.ts'

export interface ShellIO {
  write: (s: string) => void
  close: () => void
}

export class Shell extends Terminal {
  constructor(d: Device, io: ShellIO, rows = 24, opts: Omit<TerminalOptions, 'rows'> = {}) {
    super(d, io, personalityFor(d.platform), { ...opts, rows })
  }
}
