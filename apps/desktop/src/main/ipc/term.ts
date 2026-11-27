import type { Repo } from '../db/repo'
import type { SessionHostClient } from '../host/client'
import type { PromptBroker } from '../prompts'
import { handler as h, registerAll, type Handler } from '.'
import * as S from './schemas'

/** What the term handlers use of the session host (tests pass a stand-in). */
export type TermHost = Pick<SessionHostClient, 'ephemeral' | 'adopt' | 'open' | 'close' | 'reconnect' | 'listSerialPorts'>

/**
 * Tab lifecycle only. Keystrokes, resizes and output travel on each tab's MessagePort
 * directly between the renderer and the session host. Exported by channel for the IPC contract test.
 */
export function termHandlers(host: TermHost, prompts: Pick<PromptBroker, 'answer'>, repo: Repo): Record<string, Handler> {
  return {
    // Quick connect: the record lives in main memory (see EphemeralSessions for why) until saved.
    'sessions:createEphemeral': h(S.QuickConnectInput, (q) =>
      host.ephemeral.create({ ...q, folderId: null, credentialId: null, logToFile: false, notes: '', options: q.options.serial ? { serial: q.options.serial } : {} })
    ),
    'sessions:saveEphemeral': h(S.SaveEphemeral, ({ id, patch }) => {
      const s = host.ephemeral.get(id)
      if (!s) throw new Error('This quick connect session is no longer open')
      const { ephemeral: _e, lastConnectedAt: _l, ...rest } = s
      const { detected, ...fields } = rest
      const saved = repo.saveSession({ ...fields, ...patch, id })
      if (detected && saved.platform !== 'auto') repo.keepDetection(id, detected)
      repo.touchConnected(id)
      host.adopt(saved)
      return repo.getSession(id)!
    }),
    // "Set platform" / "Change" after auto-detect: saved and quick-connect sessions alike.
    'sessions:setPlatform': h(S.SetPlatform, ({ id, platform }) => {
      if (host.ephemeral.get(id)) return host.ephemeral.update(id, { platform, detected: null })!
      if (!repo.getSession(id)) throw new Error('No such session')
      repo.bulkUpdate([id], { platform })
      return repo.getSession(id)!
    }),
    'prompt:answer': h(S.PromptAnswer, ({ id, value }, e) => prompts.answer(e.sender, id, value)),
    'term:open': h(S.TermOpen, ({ tabId, sessionId, cols, rows, password }, e) => host.open(e.sender, tabId, sessionId, cols, rows, password)),
    'term:close': h(S.Id, (tabId, e) => host.close(tabId, e.sender)),
    'serial:list': h({ parse: () => undefined }, () => host.listSerialPorts()),
    'term:reconnect': h(S.TermReconnect, ({ tabId, password }, e) => host.reconnect(e.sender, tabId, password))
  }
}

export function registerTermIpc(host: SessionHostClient, prompts: PromptBroker, repo: Repo): void {
  registerAll(termHandlers(host, prompts, repo))
}
