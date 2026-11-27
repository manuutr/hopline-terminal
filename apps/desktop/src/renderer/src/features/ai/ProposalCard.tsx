import { Check, ChevronRight, Clock, OctagonAlert, RotateCcw, ShieldAlert, X } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState } from 'react'
import { sameHost } from '@shared/cli'
import type { ChangeUpdate } from '@shared/types'
import { Button, cn, DisruptiveReasons, RiskLabel, TypedHostname } from '../../design'
import { notifyError } from '../../lib/connect'
import { useAi, type Entry } from './store'

/**
 * The approval card (Proposals v2): the exact lines as a diff inside the platform's wrapper, one
 * tick per line, the rollback plan, the verify commands with what the assistant expects, the safety
 * net, and a flag on any line that holds a long run of recent device output (it may have been
 * planted there). Approve is armed only ARM_MS after the card appears, so a stray Enter cannot
 * approve; the gate is in `answer` itself, not just on the button (the hostname field submits on
 * Enter). After the approval the same card follows the change: verify output, the assistant's
 * judgement, the device timer, and Confirm / Roll back (armed the same way).
 */

/** Approve (and Confirm) stay disabled this long after they appear. */
export const ARM_MS = 1500

type ProposalEntry = Extract<Entry, { kind: 'proposal' }>

/** Proposal cards that already took focus once. */
const focusedCards = new Set<string>()

/**
 * A button with a display-only arming countdown (review P2: nothing showed that Approve unlocks by
 * itself): a thin bar along its bottom edge fills over ARM_MS while it is not armed. The gate is
 * still `armed` in the caller (and inside `answer` / `run`); this only shows it.
 */
const ArmedButton = forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button> & { armed: boolean }>(function ArmedButton({ armed, children, className, ...props }, ref) {
  return (
    <Button ref={ref} {...props} className={cn('relative overflow-hidden', className)}>
      {children}
      {!armed && <span data-testid="arm-progress" aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-current/60 animate-arm" style={{ animationDuration: `${ARM_MS}ms` }} />}
    </Button>
  )
})

/** True once `ms` passed since `on` became true (resets when it turns false). */
function useArmed(on: boolean, ms = ARM_MS): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    setArmed(false)
    if (!on) return
    const t = setTimeout(() => setArmed(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return armed
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function Section({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <div data-testid={testId} className="px-3 pt-2">
      <div className="mb-1 text-xs font-medium text-fg-muted">{label}</div>
      {children}
    </div>
  )
}

const copiedOf = (e: ProposalEntry, section: 'commands' | 'rollback' | 'verify', i: number) => e.copied?.find((c) => c.section === section && c.index === i)

/**
 * `pinned`: inside a sideways-scrolling well the flag sticks to its right edge, over an opaque copy
 * of the row's tint, so a long line can neither run under it nor scroll it out of view.
 */
function CopiedFlag({ from, pinned }: { from: string; pinned?: boolean }): React.JSX.Element {
  return (
    <span
      data-testid="copied-flag"
      className={cn('shrink-0', pinned && 'sticky right-0 -mr-2 py-px pl-2 pr-2 [background:linear-gradient(var(--color-warn-soft),var(--color-warn-soft)),var(--color-term)]')}
      title={`This line contains text that appeared in the output of "${from}". A device can plant text (a description, a banner, a neighbour name) for the assistant to relay: check it is what you want.`}>
      <RiskLabel tone="warn">copied from output</RiskLabel>
    </span>
  )
}

/** The short state label in words, never the raw enum (review P2: "rolled-back" was shown as is). */
const PHASE_LABEL: Partial<Record<ChangeUpdate['phase'], string>> = { confirmed: 'confirmed', 'rolled-back': 'rolled back', expired: 'expired', failed: 'not applied', unknown: 'state unknown' }

const PHASE_TEXT: Record<ChangeUpdate['phase'], string> = {
  applying: 'Applying',
  awaiting: 'Applied, waiting for your decision',
  confirming: 'Confirming',
  'rolling-back': 'Rolling back',
  confirmed: 'Confirmed',
  'rolled-back': 'Rolled back',
  expired: 'Rolled back by the device (timer expired)',
  failed: 'Not applied',
  unknown: 'State unknown — check the device'
}

function ChangePanel({ e, card }: { e: ProposalEntry; card: React.RefObject<HTMLDivElement | null> }): React.JSX.Element | null {
  const act = useAi((s) => s.act)
  const ch = e.change
  const [busy, setBusy] = useState(false)
  const open = !!ch?.actions?.length
  const armed = useArmed(open)
  const confirmBtn = useRef<HTMLButtonElement>(null)
  const phase = ch?.phase
  // Review P1-2: after Approve the card's buttons are gone and focus fell to the page, so Confirm and
  // Roll back could not be reached by keyboard. Once Confirm is armed, it takes focus, but only when
  // focus is nowhere (the page) or already in this card: never from the terminal or the composer,
  // where a keystroke meant for them would confirm a change. Once per change.
  const focused = useRef(false)
  useEffect(() => {
    if (!open || !armed || focused.current) return
    focused.current = true
    const a = document.activeElement
    if (a && a !== document.body && !card.current?.contains(a)) return
    // State unknown (the device may or may not have the change): no default action, so Enter does
    // nothing by accident; the card holds focus and Tab reaches Roll back and Confirm.
    const target = phase === 'unknown' ? card.current : confirmBtn.current
    target?.focus({ preventScroll: true })
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [open, armed, card, phase])
  const now = useNow(!!ch?.deadline && (ch.phase === 'awaiting' || ch.phase === 'unknown'))
  if (!ch) return null
  const left = ch.deadline ? Math.max(0, Math.round((ch.deadline - now) / 1000)) : null
  const run = async (action: 'confirm' | 'rollback') => {
    // Both actions are armed: a single stray click must not roll back either (Phase 5 review L6).
    if (busy || !armed) return
    setBusy(true)
    try {
      await act(e.id, action)
    } catch (x) {
      notifyError(action === 'confirm' ? 'Not confirmed' : 'Not rolled back', x)
    } finally {
      setBusy(false)
    }
  }
  const tone = ch.phase === 'confirmed' ? 'ok' : ch.phase === 'unknown' ? 'danger' : ch.phase === 'failed' || ch.phase === 'expired' || ch.phase === 'rolled-back' ? 'warn' : 'neutral'
  return (
    <div data-testid="change-panel" data-phase={ch.phase} className="mt-2 border-t border-line">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span className="font-medium text-fg">{PHASE_TEXT[ch.phase]}</span>
        {ch.partial && <RiskLabel tone="warn">partial</RiskLabel>}
        <span className="flex-1" />
        {left !== null && (ch.phase === 'awaiting' || ch.phase === 'unknown') && (
          <span data-testid="change-timer" className="flex items-center gap-1 tabular-nums text-fg-muted" title="The device rolls the change back by itself unless you confirm it">
            <Clock className="size-3.5" /> rolls back in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </span>
        )}
        {tone !== 'neutral' && PHASE_LABEL[ch.phase] && <RiskLabel tone={tone}>{PHASE_LABEL[ch.phase]}</RiskLabel>}
      </div>
      {ch.message && (
        <div data-testid="change-message" role="status" className="px-3 pb-1.5 text-xs text-fg-muted">
          {ch.message}
        </div>
      )}
      {!!ch.verify?.length && (
        <div data-testid="verify-results" className="space-y-1 px-3 pb-2">
          {ch.verify.map((v, i) => (
            <VerifyRow key={i} v={v} />
          ))}
        </div>
      )}
      {ch.judgement && (
        <div data-testid="judgement" data-verified={ch.judgement.verified} className="mx-3 mb-2 flex items-start gap-2 text-xs">
          <RiskLabel tone={ch.judgement.verified ? 'ok' : 'danger'}>{ch.judgement.verified ? 'verified' : 'not verified'}</RiskLabel>
          <span className="selectable text-fg-muted">{ch.judgement.summary}</span>
        </div>
      )}
      {open && (
        <div data-testid="change-actions" className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 border-t border-line bg-surface px-3 py-2">
          <span data-testid="decision-hint" className="w-full text-2xs text-fg-subtle">
            {ch.judgement ? 'You decide; logged with your name.' : 'Waiting for the assistant\'s judgement. You can decide now.'}
          </span>
          <Button variant={ch.judgement && !ch.judgement.verified ? 'danger' : 'secondary'} disabled={busy || !armed} onClick={() => void run('rollback')}>
            <RotateCcw /> Roll back
          </Button>
          <ArmedButton armed={armed} ref={confirmBtn} variant="ok" disabled={busy || !armed} onClick={() => void run('confirm')}>
            <Check /> Confirm
          </ArmedButton>
        </div>
      )}
    </div>
  )
}

function VerifyRow({ v }: { v: NonNullable<ChangeUpdate['verify']>[number] }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-md bg-term">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-2 py-1 text-left">
        <ChevronRight className={cn('size-3 text-fg-subtle transition-transform duration-[var(--dur-fast)]', open && 'rotate-90')} />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={v.command}>{v.command}</code>
        {v.status !== 'ok' && <RiskLabel tone="warn">{v.status}</RiskLabel>}
      </button>
      {open && (
        <>
          <div className="px-2 text-2xs text-fg-subtle">Expected: {v.expect}</div>
          <pre tabIndex={0} aria-label={`Output of ${v.command}`} className="selectable max-h-48 overflow-auto px-2 py-1 font-mono text-[11.5px] leading-[1.45] text-fg-muted">{v.output || '(no output)'}</pre>
        </>
      )}
    </div>
  )
}

export function ProposalCard({ e, tabId, sessionName }: { e: ProposalEntry; tabId: string; sessionName: string }): React.JSX.Element {
  const decide = useAi((s) => s.decide)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [ticked, setTicked] = useState<boolean[]>(() => e.commands.map(() => true))
  const d = e.disruptive
  const pending = e.state === 'pending'
  const armed = useArmed(pending)
  const confirmed = !d || sameHost(typed, d.confirm)
  const perLine = !e.exec && e.commands.length > 1
  const picked = ticked.map((t, i) => (t ? i : -1)).filter((i) => i >= 0)
  // A new card takes focus (a disruptive one on its hostname field, below), so keyboard and
  // screen-reader users land on the decision.
  const card = useRef<HTMLDivElement>(null)
  // Only the first time a card is shown, not when the panel or tab is re-opened.
  const [fresh] = useState(() => pending && !focusedCards.has(e.id))
  useEffect(() => {
    focusedCards.add(e.id)
    if (fresh && !d) card.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Approve or Reject unmounts the button that had focus: keep focus on the card (not the page),
  // so the keyboard stays here for Confirm / Roll back.
  useEffect(() => {
    if (!pending && document.activeElement === document.body) card.current?.focus({ preventScroll: true })
  }, [pending])
  const answer = async (approve: boolean) => {
    // The arming delay gates the decision itself: Enter in the hostname field lands here too.
    if (busy || (approve && (!armed || !confirmed || !picked.length))) return
    setBusy(true)
    try {
      await decide(tabId, e.id, approve, approve && d ? typed : undefined, approve && perLine && picked.length < e.commands.length ? picked : undefined)
    } catch (x) {
      notifyError('Not approved', x)
    } finally {
      setBusy(false)
    }
  }
  /**
   * Ticking a line that enters a sub-mode ticks the lines typed in it; unticking it unticks them.
   * Inside a section the ticks stay a prefix (main refuses a skipped middle line): unticking a line
   * unticks the ones after it, ticking one ticks its section line and the ones before it.
   */
  const toggle = (i: number) =>
    setTicked((cur) => {
      const next = [...cur]
      next[i] = !cur[i]
      const g = e.groups?.find((x) => x.head === i)
      if (g) for (const m of g.members) next[m] = next[i]!
      const parent = e.groups?.find((x) => x.members.includes(i))
      if (parent) {
        const k = parent.members.indexOf(i)
        if (next[i]) {
          next[parent.head] = true
          for (const m of parent.members.slice(0, k)) next[m] = true
        } else for (const m of parent.members.slice(k + 1)) next[m] = false
      }
      return next
    })
  const disruptiveLine = (c: string) => !!d?.reasons.some((r) => r.startsWith(`"${c}"`))
  const wrapBefore = e.wrapper?.before ?? (e.exec ? [] : ['configure terminal'])
  const wrapAfter = e.wrapper?.after ?? (e.exec ? [] : ['end'])
  const net = e.net
  return (
    <div
      ref={card}
      tabIndex={-1}
      role="group"
      aria-label={`Proposed ${e.exec ? 'command' : 'change'} on ${sessionName}`}
      data-proposal={d ? 'disruptive' : 'config'}
      data-state={e.state}
      data-armed={armed}
      className={cn(
        // Review P1-3: the teal ring covered the amber or red frame. The ring is drawn outside it,
        // offset, in the card's own risk colour.
        'overflow-hidden rounded-md border bg-raised outline-none animate-pop-in focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        !pending && !e.change ? 'border-line-strong focus-visible:ring-ring' : d ? 'border-danger/60 focus-visible:ring-danger' : 'border-warn/50 focus-visible:ring-warn'
      )}
    >
      <div className="@container flex h-8 items-center gap-2 border-b border-line px-3">
        {d ? <OctagonAlert className="size-3.5 shrink-0 text-danger" /> : <ShieldAlert className="size-3.5 shrink-0 text-warn" />}
        {/* Review P1-4: the long label truncated the hostname away at 900 px. */}
        <span className={cn('flex min-w-0 flex-1 items-baseline gap-1 text-xs font-medium', e.state === 'expired' ? 'text-fg-muted' : 'text-fg')}>
          {/* In a narrow panel the host wins over the prefix (the card's aria-label still says it). */}
          <span className="hidden shrink-0 @[18rem]:inline">{e.exec ? 'Command' : 'Change'} on</span>
          <span data-testid="proposal-host" className="min-w-0 truncate font-mono" title={sessionName}>
            {sessionName}
          </span>
        </span>
        {d ? <RiskLabel tone="danger">Disruptive</RiskLabel> : !e.exec && <RiskLabel tone="warn">Configuration</RiskLabel>}
        {e.state === 'approved' && <RiskLabel tone="ok">approved</RiskLabel>}
        {e.state === 'rejected' && <RiskLabel tone="danger">rejected</RiskLabel>}
        {e.state === 'expired' && <RiskLabel tone="neutral">closed</RiskLabel>}
      </div>
      {e.state === 'expired' && e.closed && (
        <div data-testid="proposal-closed" role="status" className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs text-fg-muted">
          <Clock className="size-3.5 shrink-0 text-fg-subtle" /> {e.closed}
        </div>
      )}
      {e.rationale && <div className="px-3 pt-2 text-xs text-fg-muted">{e.rationale}</div>}
      {d && <DisruptiveReasons className="mx-3 mt-2" reasons={d.reasons} />}
      {e.notice && (
        <div data-testid="proposal-notice" className="mx-3 mt-2 text-xs text-warn">
          {e.notice}
        </div>
      )}

      <Section label={e.exec ? 'Command' : 'Change'} testId="plan-lines">
        <div role="list" aria-label="Proposed lines" className="selectable overflow-x-auto rounded-md bg-term py-1 font-mono text-[12px] leading-[1.55]">
          {wrapBefore.map((c, i) => (
            <div key={`b${i}`} className="px-2 text-fg-subtle">
              {'  '}
              {c}
            </div>
          ))}
          {e.commands.map((c, i) => {
            const cp = copiedOf(e, 'commands', i)
            const danger = e.exec || disruptiveLine(c)
            return (
              <div key={i} role="listitem" data-line={i} data-ticked={!!ticked[i]} data-copied={cp ? 'true' : undefined} className={cn('flex w-max min-w-full items-center gap-2 px-2', cp && 'bg-warn-soft')}>
                {perLine && pending ? (
                  // A 24 px target (WCAG 2.5.8) around a 12 px box: the native input fills the target, invisible, over the drawn box.
                  <label className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center">
                    <input type="checkbox" aria-label={`Apply line ${i + 1}: ${c}`} checked={!!ticked[i]} onChange={() => toggle(i)} className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded focus-visible:outline-none" />
                    <span aria-hidden className="pointer-events-none flex size-3 items-center justify-center rounded-[3px] border border-line-input bg-raised text-accent-fg peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--c-ring)] [&_svg]:size-2.5">
                      {ticked[i] && <Check strokeWidth={3} />}
                    </span>
                  </label>
                ) : null}
                {/* An unticked line: struck through in fg-subtle (AA), not faded with opacity (review P2). */}
                {/* Never narrower than its text: a long line scrolls the well sideways rather than running under the flag (review: overlap at 1280x800). */}
                <span data-line-text className={cn('flex-1 whitespace-pre', !ticked[i] ? 'text-fg-subtle line-through' : danger ? 'text-danger' : 'text-ok')}>
                  {wrapBefore.length || wrapAfter.length ? '+ ' : ''}
                  {c}
                </span>
                {cp && <CopiedFlag from={cp.from} pinned />}
                {e.unknown?.includes(i) && (
                  <span data-testid="unknown-line" className="shrink-0 text-2xs text-warn">
                    Hopline doesn't recognise this command
                  </span>
                )}
              </div>
            )
          })}
          {wrapAfter.map((c, i) => (
            <div key={`a${i}`} className="px-2 text-fg-subtle">
              {'  '}
              {c}
            </div>
          ))}
        </div>
        {!e.exec && !!e.wrapper?.abort?.length && (
          <div className="pt-1 text-2xs text-fg-subtle">
            If a line fails: <code className="font-mono text-fg-muted">{e.wrapper.abort.join(' ⏎ ')}</code> discards what was typed.
          </div>
        )}
      </Section>

      {!!e.rollback?.length && (
        <Section label="Rollback plan" testId="rollback-plan">
          <div className="selectable overflow-x-auto rounded-md bg-term py-1 font-mono text-[12px] leading-[1.55]">
            {e.rollback.map((c, i) => {
              const cp = copiedOf(e, 'rollback', i)
              return (
                <div key={i} data-copied={cp ? 'true' : undefined} className={cn('flex w-max min-w-full items-center gap-2 px-2', cp && 'bg-warn-soft')}>
                  <span data-line-text className="flex-1 whitespace-pre text-fg-muted">{c}</span>
                  {cp && <CopiedFlag from={cp.from} pinned />}
                </div>
              )
            })}
          </div>
          {net && net.kind !== 'rollback-lines' && <div className="pt-1 text-2xs text-fg-subtle">Shown for review. Rolling back uses the {net.label}, which restores the previous configuration exactly.</div>}
          {net?.kind === 'rollback-lines' && perLine && picked.length < e.commands.length && <div className="pt-1 text-2xs text-warn">These lines were written for every proposed line; check them before rolling back a partial approval.</div>}
        </Section>
      )}

      {!!e.verify?.length && (
        <Section label="Verify after applying" testId="verify-plan">
          <ul className="space-y-0.5">
            {e.verify.map((v, i) => {
              const cp = copiedOf(e, 'verify', i)
              return (
                <li key={i} data-testid="verify-line" className="min-w-0 text-xs">
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 font-mono text-fg [overflow-wrap:anywhere]">{v.command}</code>
                    {cp && <CopiedFlag from={cp.from} />}
                  </div>
                  <div className="pl-2 text-fg-subtle [overflow-wrap:anywhere]">{v.expect}</div>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {net && (
        <div data-testid="safety-net" data-net={net.kind} className="flex items-baseline gap-2 px-3 pt-2 text-xs">
          <span className="font-medium text-fg-muted">Safety net</span>
          <RiskLabel tone={net.kind === 'rollback-lines' ? 'warn' : 'ok'}>{net.label}</RiskLabel>
          <span className="min-w-0 flex-1 text-fg-subtle">{net.detail}</span>
        </div>
      )}

      {pending && d && (
        <TypedHostname className="mx-3 mt-2" hostname={d.confirm} value={typed} onChange={setTyped} onSubmit={() => void answer(true)} verb="approve" autoFocus={fresh} />
      )}
      {pending ? (
        // Review P1-5: the hint wrapped one word per line beside the buttons; it has its own line.
        <div data-testid="proposal-actions" className="mt-2 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 border-t border-line bg-surface px-3 py-2">
          <span data-testid="decision-hint" className="w-full text-2xs text-fg-subtle">
            {perLine && picked.length < e.commands.length ? `${picked.length} of ${e.commands.length} lines ticked. ` : ''}
            {d ? 'Logged with your name.' : 'Runs exactly these lines. Logged with your name.'}
          </span>
          <Button variant={d ? 'secondary' : 'danger'} disabled={busy} onClick={() => void answer(false)}>
            <X /> Reject
          </Button>
          <ArmedButton armed={armed} variant={d ? 'danger-solid' : 'ok'} disabled={busy || !confirmed || !armed || !picked.length} onClick={() => void answer(true)} title={armed ? undefined : 'Read the change first'}>
            <Check /> {d ? 'Run disruptive' : picked.length < e.commands.length ? `Approve ${picked.length} line${picked.length === 1 ? '' : 's'}` : 'Approve'}
          </ArmedButton>
        </div>
      ) : (
        <ChangePanel e={e} card={card} />
      )}
      {!pending && !e.change && <div className="h-2" />}
    </div>
  )
}
