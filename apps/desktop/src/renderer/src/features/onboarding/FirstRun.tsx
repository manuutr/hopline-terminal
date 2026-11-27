import { startTour } from './tour'
import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { Button, cn } from '../../design'
import { notifyError, openSession } from '../../lib/connect'
import { useUi } from '../../store'
import { openImport } from '../import/store'
import { useOnboarding } from './store'
import { PrivacyStep } from '../privacy/PrivacyScreen'

type Step = 0 | 1 | 2

const STEPS: { title: string; body: string }[] = [
  { title: 'Bring your sessions', body: 'From SecureCRT, MobaXterm, a CSV, NetBox or your ssh_config. You review every session first.' },
  { title: 'Add a host', body: 'A name, an address and how to sign in. SSH, Telnet or a serial port.' },
  { title: 'Connect', body: 'Open a saved session or add the device you want to connect to.' }
]

/** Start the bundled lab and open its first device. */
export async function openLab(): Promise<void> {
  try {
    if (!window.hopline.lab) return
    const info = await window.hopline.lab.start()
    const { sessions, folders } = await window.hopline.sessions.list()
    useUi.getState().set({ sessions, folders })
    const first = sessions.find((s) => s.id === info.sessionIds[0])
    if (first) openSession(first)
  } catch (e) {
    notifyError('Could not start the simulator lab', e)
  }
}

/**
 * Whether the privacy step is waiting on this window's launcher: the Launcher then draws the steps
 * first, above the session list, so the consent and its Continue button are on screen at
 * 1100×700 (review P1), not below the fold.
 */
export function usePrivacyFirst(): boolean {
  const { state, loaded } = useOnboarding()
  const pending = useUi((s) => !!s.settings && !s.settings.privacyReviewed)
  return loaded && !state.stepsDone && pending
}

/**
 * The first-run steps, under the launcher when no tab is open: what leaves this machine (until it is
 * answered), import, add a host, connect. The privacy step is "before you start" and is not
 * counted: the three steps are "Step n of 3" whether or not it was shown (review P2). The last three can be skipped, and so can all of them; the
 * privacy step cannot be skipped silently (skipping setup brings it back as its own dialog). Non-modal: the launcher's search keeps focus, the tree
 * stays usable, and the first connection made any way ends the steps.
 */
export function FirstRun({ lead = false }: { lead?: boolean } = {}): React.JSX.Element | null {
  const { state, loaded, finishSteps } = useOnboarding()
  const sessions = useUi((s) => s.sessions)
  // Sessions arrive with the first settings load: before that, an empty list is not a baseline.
  const ready = useUi((s) => s.settings !== null)
  const [step, setStep] = useState<Step>(0)
  const [done, setDone] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  // Sessions that existed when the step started: anything new was imported or added by it.
  const baseline = useRef<Set<string> | null>(null)
  const [added, setAdded] = useState<Session[]>([])
  // The privacy step leads the flow when it was unanswered as the flow began (Phase 7, D8).
  const reviewed = useUi((s) => s.settings?.privacyReviewed ?? true)
  const withPrivacy = useRef<boolean | null>(null)
  if (ready && withPrivacy.current === null) withPrivacy.current = !reviewed
  const shownPrivacy = !!withPrivacy.current
  const total = 3
  // Leading the launcher (privacy pending): no rule above, a rule below.
  const frame = lead ? 'mb-6 border-b border-line pb-4' : 'mt-8 border-t border-line pt-4'

  useEffect(() => {
    if (!ready) return
    baseline.current ??= new Set(sessions.map((s) => s.id))
    if (step > 1) return
    const fresh = sessions.filter((s) => !baseline.current!.has(s.id))
    if (!fresh.length) return
    setAdded((a) => [...a, ...fresh.filter((f) => !a.some((x) => x.id === f.id))])
    for (const f of fresh) baseline.current!.add(f.id)
    setDone((d) => ({ ...d, [step]: true }))
    // An import or a new host moves on: two steps to a connection at most.
    setStep(step === 0 ? 1 : 2)
  }, [sessions, step, ready])

  if (!loaded || state.stepsDone) return null

  const target = added.find((s) => s.protocol !== 'serial') ?? added[0] ?? (!__HOPLINE_DEV_LAB__ ? sessions[0] : undefined)
  const action = (i: Step) => {
    if (i === 0) return <Button size="sm" onClick={() => openImport()}>Import…</Button>
    if (i === 1) return <Button size="sm" onClick={() => useUi.getState().set({ editing: { open: true } })}>Add host…</Button>
    return (
      <div className="flex flex-wrap items-center gap-2">
        {target && (
          <Button size="sm" variant="primary" onClick={() => openSession(target)}>
            Connect to {target.name}
          </Button>
        )}
        {!target && !__HOPLINE_DEV_LAB__ && <Button size="sm" variant="primary" onClick={() => useUi.getState().set({ editing: { open: true } })}>Add host…</Button>}
        {__HOPLINE_DEV_LAB__ && <Button size="sm" variant={target ? 'secondary' : 'primary'} disabled={busy} onClick={() => (setBusy(true), void openLab().finally(() => setBusy(false)))}>
          {busy ? 'Starting the lab…' : 'Open the simulator lab'}
        </Button>}
      </div>
    )
  }

  const header = (where: string) => (
    <div className="mb-2 flex items-center">
      <h2 className="text-xs font-medium text-fg-muted">Get started</h2>
      <span className="ml-2 text-2xs text-fg-subtle">{where}</span>
      {reviewed && <Button size="sm" variant="ghost" className="ml-auto mr-2" onClick={startTour}>Take a tour</Button>}
      <button type="button" className={cn(!reviewed && 'ml-auto', 'text-2xs text-fg-subtle hover:text-fg')} onClick={finishSteps}>
        Skip setup
      </button>
    </div>
  )
  const num = (n: number | null, isDone: boolean, current: boolean) => (
    <span className={cn('mt-px flex size-4 items-center justify-center rounded-full text-2xs tabular-nums', isDone ? 'bg-accent-soft text-accent' : current ? 'bg-active text-fg' : 'text-fg-subtle')}>
      {isDone ? <Check className="size-3" /> : n ?? <span className="size-1.5 rounded-full bg-current" />}
    </span>
  )
  const PRIVACY_TITLE = 'What leaves this machine'

  if (!reviewed)
    return (
      <section aria-label="Get started" data-first-run className={frame}>
        {header('Before you start')}
        <ol className="flex flex-col">
          <li data-step="privacy" aria-current="step" className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 py-1.5">
            {num(null, false, true)}
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{PRIVACY_TITLE}</p>
              <div className="mt-1">
                <PrivacyStep submitLabel="Continue" />
              </div>
            </div>
          </li>
          {STEPS.map((s, i) => (
            <li key={s.title} data-step={i} className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 py-1.5 text-fg-subtle">
              {num(i + 1, false, false)}
              <span className="text-sm">{s.title}</span>
            </li>
          ))}
        </ol>
      </section>
    )

  return (
    <section aria-label="Get started" data-first-run className={frame}>
      {header(`Step ${step + 1} of ${total}`)}
      <ol className="flex flex-col">
        {shownPrivacy && (
          <li data-step="privacy" className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 py-1.5 text-fg-subtle">
            {num(null, true, false)}
            <span className="text-sm">{PRIVACY_TITLE}</span>
          </li>
        )}
        {STEPS.map((s, i) => {
          const current = i === step
          return (
            <li key={s.title} data-step={i} aria-current={current ? 'step' : undefined} className={cn('grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 py-1.5', !current && 'text-fg-subtle')}>
              <span className={cn('mt-px flex size-4 items-center justify-center rounded-full text-2xs tabular-nums', done[i] ? 'bg-accent-soft text-accent' : current ? 'bg-active text-fg' : 'text-fg-subtle')}>
                {done[i] ? <Check className="size-3" /> : i + 1}
              </span>
              <div className="min-w-0">
                <button type="button" className={cn('text-left text-sm', current ? 'font-medium text-fg' : 'hover:text-fg')} onClick={() => setStep(i as Step)} aria-expanded={current} aria-label={`Step ${i + 1}: ${s.title}`}>
                  {s.title}
                </button>
                {current && (
                  <div className="mt-0.5 space-y-2">
                    <p className="text-xs text-fg-muted">{s.body}</p>
                    <div className="flex items-center gap-2">
                      {action(i as Step)}
                      {i < 2 && (
                        <Button size="sm" variant="ghost" onClick={() => setStep((i + 1) as Step)}>
                          Skip
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
