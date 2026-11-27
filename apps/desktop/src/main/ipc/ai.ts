import type { AiService } from '../llm/service'
import { handler as h, registerAll, type Handler } from '.'
import * as S from './schemas'

/** Exported by channel for the IPC contract test. Results never carry the key. */
const none = { parse: (): undefined => undefined }

export function aiHandlers(ai: Pick<AiService, 'account' | 'test' | 'connect' | 'ollamaModels' | 'health'>): Record<string, Handler> {
  return {
    'ai:account': h(S.AccountRequest, ({ provider, action }) => ai.account(provider, action)),
    'ai:test': h(S.AiTestRequest, (req) => ai.test(req)),
    'ai:connect': h(S.AiTestRequest, (req) => ai.connect(req)),
    'ai:ollamaModels': h(S.Endpoint, (endpoint) => ai.ollamaModels(endpoint)),
    'ai:health': h(none, () => ai.health())
  }
}

export function registerAiIpc(ai: AiService): void {
  registerAll(aiHandlers(ai))
}
