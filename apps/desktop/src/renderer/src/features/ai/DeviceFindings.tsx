import { useAi } from './store'
import { WorkspaceFollowUp } from './WorkspaceFollowUp'

export function DeviceFindings({ tabId, sessionName }: { tabId: string; sessionName: string }) {
  const thread = useAi((s) => s.byTab[tabId])
  if (!thread || thread.runId || thread.waiting) return null
  const answer = thread.entries.findLast(e => e.kind !== 'suggestions')
  if (answer?.kind !== 'assistant' || !answer.text.trim()) return null
  const lastQuestion = thread.entries.findLastIndex(e => e.kind === 'user')
  const checks = thread.entries.slice(lastQuestion + 1).flatMap(e =>
    e.kind === 'step' && e.status === 'ok' ? [e.command] : []
  )
  const evidence = [
    'Device: ' + sessionName,
    ...(checks.length ? ['Completed commands: ' + [...new Set(checks)].slice(0, 5).join(', ')] : []),
    'Device assistant’s answer: ' + answer.text.trim()
  ].join('\n')
  return <WorkspaceFollowUp evidence={evidence} question="Given this device finding, what should I check next and on which device?" />
}
