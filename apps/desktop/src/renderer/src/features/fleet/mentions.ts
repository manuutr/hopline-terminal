import type { FleetMentionError } from '@shared/fleet'
import { formatMention, hasMentions } from '@shared/mentions'
import { notifyError } from '../../lib/connect'
import { toast } from '../../lib/notify'
import { useUi } from '../../store'
import { defaultSelection, emptyPick, isRunning, useFleet } from './store'

/**
 * "@ai why is bgp down here and on @edge-r1" (F11). A question with device mentions opens the
 * fleet view with the question and the scope filled in: the current tab's session first, then the
 * mentioned ones. Main parses the raw text again and resolves it against saved sessions only.
 * Nothing starts here: the scope preview is the consent step, and the user starts the run there.
 *
 * Called from the terminal's "@ai" line and the panel composer, with text the user typed. Never
 * with device output ("Explain this output" goes to the single-device assistant as before).
 */

export { hasMentions }

export async function askWithMentions(tabId: string, text: string): Promise<void> {
  const fleet = useFleet.getState()
  if (isRunning(fleet)) {
    fleet.show()
    toast.info('A fleet run is in progress', { description: 'Stop it or let it finish, then ask again.' })
    return
  }
  const tab = useUi.getState().tabs.find((t) => t.tabId === tabId)
  const sessionId = tab?.sessionId ?? null
  try {
    const r = await window.hopline.fleet.mentions({ text, sessionId })
    const prev = useFleet.getState().mention
    useFleet.setState({
      open: true,
      step: 'scope',
      picked: { ...emptyPick(), sessions: r.spec.sessions ?? [], folders: r.spec.folders ?? [], tags: r.spec.tags ?? [] },
      question: r.question,
      preview: r.preview,
      selected: r.preview ? defaultSelection(r.preview) : [],
      ...(r.preview ? { concurrency: r.preview.budget.concurrency, tokenBudget: r.preview.budget.tokens } : {}),
      mention: { text, tabId, sessionId, errors: r.errors, current: r.current, seq: (prev?.seq ?? 0) + 1 }
    })
  } catch (e) {
    notifyError('Could not resolve the devices', e)
  }
}

/** Fix one mention in the view: pick a candidate (ambiguous) or drop the "@" (unknown), then resolve again. */
export function fixMention(err: FleetMentionError, name: string | null): void {
  const m = useFleet.getState().mention
  if (!m) return
  const at = m.text.indexOf(err.raw)
  if (at < 0) return
  const next = m.text.slice(0, at) + (name === null ? err.ref : formatMention(err.kind, name)) + m.text.slice(at + err.raw.length)
  if (hasMentions(next)) void askWithMentions(m.tabId, next)
  else useFleet.setState({ mention: { ...m, text: next, errors: [], seq: m.seq + 1 }, question: next.trim() })
}
