export const WORKSPACE_QUESTION_MAX = 4000

export interface WorkspaceDeviceSuggestion {
  sessionId: string
  name: string
  reason: string
  /** A diagnostic question for the operator to take into the selected device chat. */
  question: string
}

export interface WorkspaceChatReply {
  text: string
  devices: WorkspaceDeviceSuggestion[]
}

export interface WorkspaceChatApi {
  ask(req: { question: string }): Promise<WorkspaceChatReply>
  cancel(): Promise<void>
  reset(): Promise<void>
}
