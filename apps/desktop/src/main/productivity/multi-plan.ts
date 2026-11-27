import { equivalentOf, type PlatformId } from '@hopline/cli-model'
import { classify, isPlatform } from '@hopline/guard'

/**
 * The command a platform gets for a typed one, through the cli-model equivalents table: "show
 * interfaces status" stays as typed on IOS and becomes "show interfaces terse" on Junos. Commands
 * without a row, and platforms the row does not cover, get the command as typed.
 */
export function translate(command: string, platform: string): { command: string; translated: boolean } {
  if (!isPlatform(platform)) return { command, translated: false }
  const e = equivalentOf(command, (c, p) => classify(c, p).expanded)
  const mapped = e?.commands[platform as PlatformId]
  if (!mapped) return { command, translated: false }
  // The typed command already is this platform's form (maybe abbreviated): keep what was typed.
  const same = mapped.trim().toLowerCase() === command.trim().replace(/\s+/g, ' ').toLowerCase() || classify(command, platform).expanded === classify(mapped, platform).expanded
  return same ? { command, translated: false } : { command: mapped, translated: true }
}
