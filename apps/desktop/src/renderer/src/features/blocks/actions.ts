/**
 * Command-block actions: registered in the action registry (features/actions/external.ts), so the
 * palette lists them, the dispatcher fires their keys and Settings → Keyboard rebinds them. The
 * terminal context menu and the block toolbar use the same list.
 */
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'
import type { BlockController } from './controller'

export interface BlockAction {
  id: string
  title: string
  keywords: string
  keys?: string
  /** Needs a finished block (not just a terminal). */
  needsBlock: boolean
  run: (ctl: BlockController) => void
}

const withBlock = (f: (ctl: BlockController, b: NonNullable<ReturnType<BlockController['current']>>) => void) => (ctl: BlockController) => {
  const b = ctl.current()
  if (b) f(ctl, b)
}

export const BLOCK_ACTIONS: readonly BlockAction[] = [
  { id: 'blocks.prev', title: 'Jump to previous prompt', keywords: 'block navigate previous prompt command up', keys: 'Mod+ArrowUp', needsBlock: false, run: (c) => c.navigate(-1) },
  { id: 'blocks.next', title: 'Jump to next prompt', keywords: 'block navigate next prompt command down', keys: 'Mod+ArrowDown', needsBlock: false, run: (c) => c.navigate(1) },
  { id: 'blocks.copyOutput', title: 'Copy block output', keywords: 'block copy output last command', keys: 'Mod+Alt+C', needsBlock: true, run: withBlock((c, b) => void c.copyOutput(b)) },
  { id: 'blocks.copyCommand', title: 'Copy block command', keywords: 'block copy command', needsBlock: true, run: withBlock((c, b) => void c.copyCommand(b)) },
  { id: 'blocks.copyReport', title: 'Copy block for ticket', keywords: 'incident handoff evidence report markdown redacted', needsBlock: true, run: withBlock((c, b) => void c.copyForTicket(b)) },
  { id: 'blocks.rerun', title: 'Re-run block command', keywords: 'block rerun repeat again command', needsBlock: true, run: withBlock((c, b) => void c.rerun(b)) },
  { id: 'blocks.ask', title: 'Ask AI about this block', keywords: 'block ai explain assistant output', needsBlock: true, run: withBlock((c, b) => c.ask(b)) },
  { id: 'blocks.table', title: 'Show block as table', keywords: 'block table textfsm parse rows csv', keys: 'Mod+Alt+T', needsBlock: true, run: withBlock((c, b) => c.openTable(b)) }
]

/** The active tab's block controller, if its terminal is open. */
export function activeBlocks(): BlockController | undefined {
  const id = useUi.getState().activeTabId
  return id ? terminals.get(id)?.blocks : undefined
}
