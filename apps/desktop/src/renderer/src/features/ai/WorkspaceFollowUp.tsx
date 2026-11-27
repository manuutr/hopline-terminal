import { CornerUpLeft } from 'lucide-react'
import { WORKSPACE_QUESTION_MAX } from '@shared/workspace-chat'
import { Button } from '../../design'
import { showWorkspaceChat, useWorkspaceChat } from './workspace-chat'

/** Preparing a follow-up is local. The operator can edit it before sending to the model. */
export function WorkspaceFollowUp({ evidence, question }: { evidence: string; question: string }) {
  const draft = useWorkspaceChat((s) => s.draft)
  const prior = draft.trim() ? draft + '\n\n' : ''
  const lead = (prior ? '' : question + '\n\n')
  const room = WORKSPACE_QUESTION_MAX - prior.length - lead.length
  const fits = room >= Math.min(240, evidence.length)
  const excerpt = evidence.length <= room ? evidence : evidence.slice(0, room - 1).trimEnd() + '…'
  return <div className="px-2 pb-1">
    <Button variant="ghost" size="sm" disabled={!fits} onClick={() => {
      useWorkspaceChat.setState({ draft: prior + lead + excerpt })
      showWorkspaceChat()
    }}><CornerUpLeft aria-hidden />Continue in workspace</Button>
    {!fits && <p className="px-2 text-xs text-fg-muted">Shorten your workspace draft to add this finding.</p>}
  </div>
}
