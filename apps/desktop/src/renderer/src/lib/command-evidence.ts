import { redact } from '@hopline/guard'
import { cleanTerminalText } from '@shared/cli'
import { writeClipboard } from './clipboard'

export interface TicketEvidence {
  device: string
  session?: string
  host?: string
  platform: string
  recordedAt?: number
  command: string
  output?: string
  status?: string
  reason?: string
}

const OUTPUT_LIMIT = 16_000
export const scrubTerminalText = (s: string) => redact(cleanTerminalText(s)).text
const field = (s: string) => scrubTerminalText(s).replace(/\s+/g, ' ').trim()
// Indented code keeps device output literal even when it contains fences, HTML or Markdown links.
const literal = (s: string) => s.split('\n').map((line) => '    ' + line).join('\n')

export function outputExcerpt(s: string): string {
  const text = scrubTerminalText(s)
  if (text.length <= OUTPUT_LIMIT) return text
  const half = OUTPUT_LIMIT / 2
  return text.slice(0, half) + '\n[… middle of output omitted …]\n' + text.slice(-half)
}

/** Plain Markdown for a ticket. Observations and device-provided strings stay inside code blocks. */
export function formatTicketReport(kind: 'block' | 'run', evidence: readonly TicketEvidence[], exportedAt: number): string {
  const sections = [kind === 'run' ? '# Multi-device run' : '# Terminal observation', 'Exported ' + new Date(exportedAt).toISOString()]
  for (const e of evidence) {
    const metadata = ['Device: ' + field(e.device)]
    if (e.session && e.session !== e.device) metadata.push('Session: ' + field(e.session))
    if (e.host) metadata.push('Connection host: ' + field(e.host))
    metadata.push('Platform: ' + field(e.platform))
    if (e.recordedAt !== undefined) metadata.push('Recorded: ' + new Date(e.recordedAt).toISOString())
    if (e.status) metadata.push('Result: ' + field(e.status))
    if (e.reason) metadata.push('Detail: ' + field(e.reason))
    sections.push('---', literal(metadata.join('\n')))
    if (e.command) sections.push(kind === 'run' ? '**Requested command**' : '**Command**', literal(scrubTerminalText(e.command)))
    const output = outputExcerpt(e.output ?? '')
    sections.push('**Output**', output ? literal(output) : 'No output captured.')
  }
  return sections.join('\n\n') + '\n'
}

export function copyTicketReport(kind: 'block' | 'run', evidence: readonly TicketEvidence[]): Promise<void> {
  return writeClipboard(formatTicketReport(kind, evidence, Date.now()))
}
