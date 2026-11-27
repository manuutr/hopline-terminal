import { useEffect, useState } from 'react'
import { toast } from '../../lib/notify'
import type { SettingsPatch } from '@shared/types'
import type { UpdateStatus } from '@shared/privacy'
import { Button, Input, Segmented } from '../../design'
import { notifyError } from '../../lib/connect'
import { useUi } from '../../store'
import { usePrivacy } from '../privacy/store'
import { Managed } from '../trust/Managed'
import { useLocks } from '../trust/store'
import { Row, Section, Toggle } from './parts'

/** Updates and privacy choices apply immediately. */

const when = (t: number) => new Date(t).toLocaleString()

export function updateLine(u: UpdateStatus): string {
  const s = u.state
  switch (s.kind) {
    case 'off':
      return s.reason === 'policy' ? 'Update checks are turned off by the team policy.' : s.reason === 'dev' ? 'Development build: no update checks.' : s.reason === 'consent' ? 'Not checked yet.' : 'Automatic checks are off.'
    case 'idle':
      return u.lastCheckedAt ? `Up to date (checked ${when(u.lastCheckedAt)}).` : 'Not checked yet.'
    case 'checking':
      return 'Checking…'
    case 'current':
      return `Up to date (checked ${when(s.checkedAt)}).`
    case 'available':
      return `Hopline ${s.version} is available. Install it the way you installed Hopline.`
    case 'downloading':
      return `Downloading Hopline ${s.version}… ${s.percent}%`
    case 'ready':
      return `Hopline ${s.version} is ready. It installs when you quit Hopline.`
    case 'error':
      return `Could not check: ${s.message}`
  }
}

export function PrivacyPanel(): React.JSX.Element {
  const settings = useUi((s) => s.settings)
  const { update, crash } = usePrivacy()
  const locks = useLocks()
  const [dsn, setDsn] = useState(settings?.crashReportDsn ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => void usePrivacy.getState().load(), [])
  useEffect(() => setDsn(settings?.crashReportDsn ?? ''), [settings?.crashReportDsn])
  if (!settings) return <></>

  const save = async (patch: SettingsPatch) => {
    try {
      useUi.getState().setSettings(await window.hopline.settings.update(patch))
      await usePrivacy.getState().load()
    } catch (e) {
      notifyError('Could not save', e)
    }
  }
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      notifyError('Failed', e)
    } finally {
      setBusy(null)
    }
  }

  const checkNow = () =>
    run('check', async () => {
      const s = await window.hopline.updates.check()
      usePrivacy.setState({ update: s })
    })
  const restart = () =>
    run('restart', async () => {
      const r = await window.hopline.updates.restart()
      if (!r.ok && r.reason === 'sessions') toast(`${r.open} session${r.open === 1 ? ' is' : 's are'} open`, { description: 'Hopline never restarts with sessions open. The update installs when you quit.' })
    })
  const testCrash = () =>
    run('test', async () => {
      const r = await window.hopline.crash.test()
      if (r.ok) toast.success('Test crash report sent', { description: r.id ? `Event ${r.id.slice(0, 8)}` : undefined })
      else toast.error('Test crash report not sent', { description: r.status ? `The server answered ${r.status}.` : 'Crash reports are off or the server cannot be reached.' })
    })
  const dumpAction = (id: string, send: boolean) =>
    run(id, async () => {
      if (send) {
        const r = await window.hopline.crash.sendDump(id)
        if (r.ok) toast.success('Crash dump sent')
        else if (r.reason !== 'cancelled') toast.error('Crash dump not sent')
      } else await window.hopline.crash.deleteDump(id)
      await usePrivacy.getState().refreshCrash()
    })

  const dsnValid = dsn.trim() === '' || /^https?:\/\/[A-Za-z0-9]{8,64}@[^\s/]+(\/[^\s]*)?\/\d+$/.test(dsn.trim())
  const ready = update?.state.kind === 'ready'
  return (
    <>
      <p data-settings-extra className="pb-3 text-xs text-fg-muted">
        Review assistant requests in What left this machine.
      </p>
      <Section title="Updates" id="updates">
        <Row k="updateAutoCheck" essential label="Automatic checks" hint="Every six hours. GitHub sees your IP address and which version you download.">
          <div className="flex items-center gap-2">
            <Toggle label="Automatic checks" checked={settings.updateAutoCheck} disabled={locks.updatesDisabled} onChange={(v) => void save({ updateAutoCheck: v })} />
            {locks.updatesDisabled && <Managed what="Update checks" />}
          </div>
        </Row>
        <Row k="updateChannel" label="Channel" hint="Beta gets new versions first, and every stable one too.">
          <div className="flex items-center gap-2">
            <Segmented
              label="Update channel"
              value={settings.updateChannel}
              onChange={(c) => void save({ updateChannel: c })}
              items={[
                { value: 'stable', label: 'Stable', disabled: !!locks.updateChannel || locks.updatesDisabled },
                { value: 'beta', label: 'Beta', disabled: !!locks.updateChannel || locks.updatesDisabled }
              ]}
            />
            {locks.updateChannel && <Managed what="The update channel" />}
          </div>
        </Row>
        <Row label="Status">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="update-status" className="text-xs text-fg-muted">
              {update ? updateLine(update) : '…'}
            </span>
            {update?.state.kind === 'available' && update.state.url && (
              <Button size="sm" variant="ghost" onClick={() => update.state.kind === 'available' && update.state.url && void window.hopline.links.open(update.state.url)}>
                Release notes
              </Button>
            )}
          </div>
        </Row>
        <Row label="" hint={ready ? 'Restart works only with no session open.' : undefined}>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={locks.updatesDisabled || busy === 'check' || update?.state.kind === 'checking' || update?.state.kind === 'downloading'} onClick={() => void checkNow()}>
              Check now
            </Button>
            {ready && (
              <Button size="sm" variant="ghost" disabled={busy === 'restart'} onClick={() => void restart()}>
                Restart and install
              </Button>
            )}
            <span className="text-2xs text-fg-subtle">Hopline {update?.current ?? __APP_VERSION__}</span>
          </div>
        </Row>
      </Section>
      <Section title="Crash reports" id="crash">
        <Row k="crashReports" essential label="Send crash reports" hint="Sends scrubbed error reports. Device output, commands and identifying fields are removed.">
          <div className="flex items-center gap-2">
            <Toggle label="Send crash reports" checked={settings.crashReports} disabled={locks.crashReportsDisabled} onChange={(v) => void save({ crashReports: v })} />
            {locks.crashReportsDisabled && <Managed what="Crash reports" />}
            {settings.crashReports && !crash?.target && <span className="text-2xs text-warn">No server set: nothing is sent.</span>}
          </div>
        </Row>
        <Row k="crashReportDsn" label="Server" hint={locks.crashReportDsn ? 'Set by the team policy.' : crash?.dsnSource === 'built-in' ? `Built into this release: ${crash.target}. A DSN here replaces it (self-hosted Sentry or GlitchTip).` : 'A Sentry or GlitchTip DSN: https://<key>@<host>/<project>.'}>
          {locks.crashReportDsn ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-fg-muted">{crash?.target}</span>
              <Managed what="The crash-report server" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input aria-label="Crash report DSN" value={dsn} onChange={(e) => setDsn(e.target.value)} placeholder={crash?.dsnSource === 'built-in' ? (crash.target ?? '') : 'https://…@sentry.example.com/1'} className="font-mono text-xs" aria-invalid={!dsnValid || undefined} />
              <Button size="sm" disabled={!dsnValid || dsn.trim() === settings.crashReportDsn} onClick={() => void save({ crashReportDsn: dsn.trim() })}>
                Save
              </Button>
            </div>
          )}
        </Row>
        <Row label="Test" hint="Sends a made-up error through the same scrubbing. Nothing crashes.">
          <div className="flex">
            <Button size="sm" disabled={!crash?.enabled || busy === 'test'} onClick={() => void testCrash()}>
              Send a test crash
            </Button>
          </div>
        </Row>
        <Row
          essential={!!crash?.dumps.length}
          label="Native crash dumps"
          hint="Memory dumps can contain passwords and terminal output. Each upload needs your approval. Local copies expire after seven days."
        >
          {crash?.dumps.length ? (
            <div className="flex flex-col">
              <div className="flex h-7 items-center">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="dumps-delete-all"
                  disabled={busy === 'dumps-all'}
                  onClick={() =>
                    void run('dumps-all', async () => {
                      await window.hopline.crash.deleteAllDumps()
                      await usePrivacy.getState().refreshCrash()
                    })
                  }
                >
                  Delete all
                </Button>
              </div>
              {crash.dumps.map((d) => (
                <div key={d.id} className="flex h-7 items-center gap-2 text-xs">
                  <span className="text-fg-muted">{when(d.at)}</span>
                  <span className="text-fg-subtle">{Math.max(1, Math.round(d.bytes / 1024))} KB</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" disabled={!crash.enabled || busy === d.id} onClick={() => void dumpAction(d.id, true)}>
                    Send…
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => void dumpAction(d.id, false)}>
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-xs text-fg-subtle">None.</span>
          )}
        </Row>
      </Section>
    </>
  )
}
