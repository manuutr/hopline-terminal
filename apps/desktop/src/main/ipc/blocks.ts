import { z } from 'zod'
import { rerunBlock, type RerunDeps } from '../blocks/rerun'
import { handler as h, registerAll, type Handler } from '.'
import * as S from './schemas'

/** Command blocks (Phase 4). Exported by channel for the IPC contract test. */
const Rerun = z.object({ tabId: S.Id, command: z.string().min(1).max(1024) }).strict()

/** `owns`: the tab is shown in the asking window (never a background connection). */
export function blocksHandlers(d: RerunDeps & { owns: (tabId: string, sender: object) => boolean }): Record<string, Handler> {
  return {
    'blocks:rerun': h(Rerun, ({ tabId, command }, e) => {
      if (!d.owns(tabId, e.sender)) throw new Error('No such tab')
      return rerunBlock(d, tabId, command)
    })
  }
}

export function registerBlocksIpc(d: RerunDeps & { owns: (tabId: string, sender: object) => boolean }): void {
  registerAll(blocksHandlers(d))
}
