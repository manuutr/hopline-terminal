import { z } from 'zod'
import type { WebContents } from 'electron'
import { WORKSPACE_QUESTION_MAX } from '@shared/workspace-chat'
import { handler as h } from '.'
import type { WorkspaceChat } from '../agent/workspace-chat'

export function workspaceChatHandlers(create: () => WorkspaceChat) {
  const conversations = new WeakMap<WebContents, WorkspaceChat>()
  const chat = (wc: WebContents) => {
    const existing = conversations.get(wc)
    if (existing) return existing
    const conversation = create()
    conversations.set(wc, conversation)
    // Reload and navigation discard the previous renderer's messages and outstanding request.
    const reset = () => conversation.reset()
    wc.on('did-navigate', reset)
    wc.once('destroyed', reset)
    return conversation
  }
  return {
    'workspaceChat:ask': h(z.strictObject({ question: z.string().trim().min(1).max(WORKSPACE_QUESTION_MAX) }), (req, e) => chat(e.sender).ask(req.question)),
    'workspaceChat:cancel': h(z.undefined(), (_, e) => conversations.get(e.sender)?.cancel()),
    'workspaceChat:reset': h(z.undefined(), (_, e) => conversations.get(e.sender)?.reset())
  }
}
