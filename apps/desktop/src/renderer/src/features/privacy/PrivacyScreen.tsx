import { useEffect, useState } from 'react'
import { Button, Dialog, Toggle } from '../../design'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { Managed } from '../trust/Managed'
import { useLocks } from '../trust/store'
import { usePrivacy } from './store'
import { useOnboarding } from '../onboarding/store'

/**
 * The first-run privacy screen (Phase 7): what leaves this machine, with the two switches that
 * decide it. Three parts, so the onboarding flow can include the step on its own page:
 *
 * - `PrivacyChoices`: the rows and switches, controlled;
 * - `PrivacyStep`: the rows plus a Continue button that saves the choice and marks the screen seen;
 * - `FirstRunPrivacy`: the step in a dialog, shown once while the screen has not been answered.
 *
 * Nothing is checked or sent before the screen is answered (main checks `privacyReviewed`).
 */

export interface PrivacyChoice {
  updateAutoCheck: boolean
  crashReports: boolean
}

function ChoiceRow({ title, children, control }: { title: string; children: React.ReactNode; control?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)_auto] items-start gap-x-4 border-b border-line py-2.5 last:border-0">
      <div className="flex min-h-5 items-center text-sm font-medium text-fg">{title}</div>
      <div className="text-xs leading-5 text-fg-muted">{children}</div>
      <div className="flex min-h-5 items-center justify-end gap-2">{control}</div>
    </div>
  )
}

export function PrivacyChoices({ value, onChange }: { value: PrivacyChoice; onChange: (v: PrivacyChoice) => void }): React.JSX.Element {
  const locks = useLocks()
  const crash = usePrivacy((s) => s.crash)
  // Crash reports need somewhere to go: the release's built-in server, the team's, or one set in Settings.
  const noServer = !!crash && !crash.target
  return (
    <div data-testid="privacy-choices">
      <ChoiceRow
        title="Update checks"
        control={
          locks.updatesDisabled ? (
            <Managed what="Update checks" />
          ) : (
            <Toggle label="Check for updates" checked={value.updateAutoCheck} onChange={(v) => onChange({ ...value, updateAutoCheck: v })} />
          )
        }
      >
        Checks every six hours. GitHub sees your IP address and which version you download.
      </ChoiceRow>
      <ChoiceRow title="AI requests">
        When you ask, Hopline Terminal masks recognized secrets, hostnames and interface descriptions. Other addresses and free-form text can reach your provider. Inspect logged requests in <span className="text-fg">What left this machine</span>.
      </ChoiceRow>
      <ChoiceRow
        title="Crash reports"
        control={
          locks.crashReportsDisabled ? (
            <Managed what="Crash reports" />
          ) : (
            <Toggle label="Send crash reports" checked={value.crashReports && !noServer} disabled={noServer} onChange={(v) => onChange({ ...value, crashReports: v })} />
          )
        }
      >
        Off unless you turn them on. Host names, addresses, usernames, terminal output, commands and file paths are removed first.
        {noServer && <span className="block text-fg-subtle">This build has no crash-report server. You can set one in Settings.</span>}
      </ChoiceRow>
    </div>
  )
}

/** Save a choice and mark the screen answered. A value the team policy fixes is not the user's to save. */
export async function savePrivacyChoice(value: PrivacyChoice, locks: { updatesDisabled: boolean; crashReportsDisabled: boolean }): Promise<void> {
  const next = await window.hopline.settings.update({
    privacyReviewed: true,
    ...(locks.updatesDisabled ? {} : { updateAutoCheck: value.updateAutoCheck }),
    ...(locks.crashReportsDisabled ? {} : { crashReports: value.crashReports })
  })
  useUi.getState().setSettings(next)
  void usePrivacy.getState().load()
}

const initialChoice = (s: { updateAutoCheck?: boolean; crashReports?: boolean } | null): PrivacyChoice => ({ updateAutoCheck: s?.updateAutoCheck ?? true, crashReports: s?.crashReports ?? false })

/**
 * The choices plus Continue: saves them and marks the screen answered. Controlled when `value` and
 * `onChange` are given (a host that also saves on close, like FirstRunPrivacy).
 */
export function PrivacyStep({ onDone, submitLabel = 'Continue', value: controlled, onChange }: { onDone?: () => void; submitLabel?: string; value?: PrivacyChoice; onChange?: (v: PrivacyChoice) => void }): React.JSX.Element {
  const settings = useUi((s) => s.settings)
  const [own, setOwn] = useState<PrivacyChoice>(() => initialChoice(settings))
  const value = controlled ?? own
  const setValue = onChange ?? setOwn
  const [busy, setBusy] = useState(false)
  const locks = useLocks()
  const crashServer = usePrivacy((s) => !s.crash || !!s.crash.target)
  useEffect(() => void usePrivacy.getState().refreshCrash().catch(() => {}), [])
  const save = async () => {
    setBusy(true)
    try {
      await savePrivacyChoice(value, locks)
      onDone?.()
    } catch (e) {
      notifyError('Could not save', e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">Hopline Terminal has no account and no analytics. Three things can leave this machine:</p>
      <PrivacyChoices value={value} onChange={setValue} />
      <div className="flex items-center gap-3">
        {/* What Continue agrees to, in one line: "Continue" without reading is still an informed choice (review P2). */}
        <span className="mr-auto text-2xs text-fg-subtle">
          <span data-testid="privacy-summary" className="text-fg-muted">
            Update checks: {locks.updatesDisabled ? 'off (team policy)' : value.updateAutoCheck ? 'on' : 'off'} · Crash reports: {locks.crashReportsDisabled ? 'off (team policy)' : value.crashReports && crashServer ? 'on' : 'off'}.
          </span>{' '}
          Change this any time in Settings › Updates &amp; privacy.
        </span>
        <Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="privacy-continue">
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

/** Shown once, until the screen is answered. Closing it (Esc, ×) saves the switches as shown. */
export function FirstRunPrivacy(): React.JSX.Element | null {
  const settings = useUi((s) => s.settings)
  const noTabs = useUi((s) => s.tabs.length === 0)
  const onboarding = useOnboarding()
  const locks = useLocks()
  const [closed, setClosed] = useState(false)
  const [value, setValue] = useState<PrivacyChoice | null>(null)
  if (!settings || settings.privacyReviewed || closed) return null
  // Wait for the onboarding state; while its steps are on screen they carry this step inline.
  if (!onboarding.loaded || (!onboarding.state.stepsDone && noTabs)) return null
  const shown = value ?? initialChoice(settings)
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return
        setClosed(true)
        void savePrivacyChoice(shown, locks).catch((e) => notifyError('Could not save', e))
      }}
      title="What leaves this machine"
      className="w-[min(640px,94vw)]"
    >
      <PrivacyStep value={shown} onChange={setValue} onDone={() => setClosed(true)} />
    </Dialog>
  )
}
