import type { Entry } from './store'

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Step rows that only repeat what an approved proposal card already shows (review P2: each applied
 * line came back as a 38 px "config" row under the card). A step is folded into the card when it
 * comes after the card, before the next question, ran fine, and its command is one of the card's
 * lines: the change, its wrapper, its rollback plan or its verify commands. Anything blocked,
 * refused or failed stays a row of its own.
 */
export function foldedSteps(entries: readonly Entry[]): Set<string> {
  const out = new Set<string>()
  let card: Extract<Entry, { kind: 'proposal' }> | null = null
  let lines = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'user') {
      card = null
      continue
    }
    if (e.kind === 'proposal') {
      card = e.state === 'approved' || e.change ? e : null
      lines = new Set(card ? [...card.commands, ...(card.wrapper?.before ?? []), ...(card.wrapper?.after ?? []), ...(card.rollback ?? []), ...(card.verify ?? []).map((v) => v.command)].map(norm) : [])
      continue
    }
    if (e.kind !== 'step' || !card) continue
    if ((e.status === 'ok' || e.status === 'running') && lines.has(norm(e.command))) out.add(e.id)
  }
  return out
}

/**
 * The last entry is a card waiting for the user (to approve, or to confirm or roll back): the run is
 * not "thinking" then, it waits for a decision (review P2).
 */
export function waitingForDecision(entries: readonly Entry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'proposal') return e.state === 'pending' || !!e.change?.actions?.length
    if (e.kind === 'step') continue
    return false
  }
  return false
}
