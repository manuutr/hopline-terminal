import { notifyError } from '../../lib/connect'
import { ConnectionDetails } from './ConnectionDetails'
import { providerLabel } from '../ai/setup-parts'
import { writeClipboard } from '../../lib/clipboard'
import { toast } from '../../lib/notify'
import { EchoLatency } from '../terminal/ConnectionStrip'
import { ArrowUpCircle, Loader2, Lock, LockOpen, Network, ShieldAlert, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react'
import { FolderOpen, PanelsTopLeft } from 'lucide-react'
import { showOverview } from '../workspace/store'
import { closeFiles, openFiles, useFiles } from '../files/store'
import { Kbd, Tooltip } from '../../design'
import { panes } from '../../lib/layout'
import { activeTab, activeWorkspace, sessionById, useUi, type Tab } from '../../store'
import { detectedText, openSetPlatform, useTabPlatform } from '../sessions/PlatformDetect'
import { openSettings } from '../../lib/settings-nav'
import { openUnlock } from '../vault/UnlockDialog'
import { useShortcutMap } from '../../lib/actions'
import { READ_ONLY_OFF, READ_ONLY_ON } from '../../lib/read-only'
import { useTrust } from '../trust/store'
import { isRunning, useFleet } from '../fleet/store'
import { usePrivacy } from '../privacy/store'
import { UPDATE_READY_TEXT } from '@shared/privacy'
import { toggleLine, useSerialLines } from '../terminal/serial-lines'
import { cn } from '../../design'

/**
 * A downloaded update (quiet: it installs when Hopline quits, never with sessions open), or a new
 * version this install cannot apply itself (deb/rpm, unsigned macOS).
 */
function UpdateItem(): React.JSX.Element | null {
  const u = usePrivacy((s) => s.update?.state)
  if (u?.kind === 'ready')
    return (
      <Tooltip label={`Hopline ${u.version} installs when you quit. It never restarts while sessions are open.`} side="top">
        <button data-testid="update-ready" className="flex items-center gap-1 hover:text-fg" onClick={() => openSettings('privacy')}>
          <ArrowUpCircle className="size-3" /> {UPDATE_READY_TEXT}
        </button>
      </Tooltip>
    )
  if (u?.kind === 'available')
    return (
      <Tooltip label="Install it the way you installed Hopline (package manager or download)." side="top">
        <button data-testid="update-available" className="flex items-center gap-1 hover:text-fg" onClick={() => (u.url ? void window.hopline.links.open(u.url) : openSettings('privacy'))}>
          <ArrowUpCircle className="size-3" /> Hopline {u.version} available
        </button>
      </Tooltip>
    )
  return null
}

/**
 * A connected serial console: DTR and RTS as the port has them (click to toggle; the palette has
 * Toggle DTR and Toggle RTS too), and BREAK while one is being sent.
 */
function SerialLinesItem({ tab }: { tab: Tab }): React.JSX.Element | null {
  const lines = useSerialLines((s) => s.byTab[tab.tabId])
  if (!lines || tab.state !== 'connected') return null
  const line = (id: 'dtr' | 'rts', name: string) => (
    <Tooltip label={`${name} is ${lines[id] ? 'on' : 'off'}. Click to turn it ${lines[id] ? 'off' : 'on'}.`} side="top">
      <button
        data-serial-line={id}
        aria-pressed={lines[id]}
        aria-label={name}
        disabled={lines.brk}
        className={cn('flex items-center gap-1 font-mono hover:text-fg', lines[id] ? 'text-fg-muted' : 'text-fg-subtle')}
        onClick={() => toggleLine(tab.tabId, id)}
      >
        <span aria-hidden className={cn('size-1.5 rounded-full border', lines[id] ? 'border-accent bg-accent' : 'border-fg-subtle')} />
        {id.toUpperCase()}
      </button>
    </Tooltip>
  )
  return (
    <span data-serial-lines className="flex items-center gap-2">
      ·{line('dtr', 'DTR')}
      {line('rts', 'RTS')}
      {lines.brk && (
        <span data-serial-break className="font-mono text-warn">
          BREAK
        </span>
      )}
    </span>
  )
}

/** The focused tab's platform: what was detected (click to change), or why the AI is blocked. */
function TabPlatformChip({ tab }: { tab: Tab }): React.JSX.Element | null {
  const p = useTabPlatform(tab)
  if (!p || p.state === 'pending') return null
  if (p.state === 'detecting')
    return (
      <span className="flex items-center gap-1">
        · <Loader2 className="size-3 animate-spin" /> detecting platform
      </span>
    )
  if (p.state === 'unknown')
    return (
      <button className="flex items-center gap-1 text-warn hover:underline" onClick={() => openSetPlatform(tab.sessionId)}>
        <ShieldOff className="size-3" /> Platform unknown — AI commands blocked · Set platform
      </button>
    )
  return (
    <Tooltip label="Change platform" side="top">
      <button className="hover:text-fg" onClick={() => openSetPlatform(tab.sessionId)}>
        · {detectedText(p.platform, p.version)}
      </button>
    </Tooltip>
  )
}

export function StatusBar(): React.JSX.Element {
  const sc = useShortcutMap()
  const filesOpen = useFiles((s) => s.open)
  const focusedTab = useUi(activeTab)
  const { settings, vault, sessions, quick } = useUi()
  const readOnlyLocked = useTrust((s) => s.policy.locks.readOnly)
  // A fleet run keeps going (and spending tokens) when its view is closed (review P1-8): say so here,
  // and reopen the view on a click.
  const fleetAway = useFleet((s) => isRunning(s) && !s.open)
  // P1-14: an empty (launcher) pane is focused: describe the workspace's other live session instead.
  const ws = useUi(activeWorkspace)
  const fallback = useUi((s) => {
    if (focusedTab || !ws) return undefined
    const ids = new Set(panes(ws.root).map((p) => p.tabId))
    return s.tabs.find((t) => ids.has(t.tabId))
  })
  const tab = focusedTab ?? fallback
  const session = tab && sessionById({ sessions, quick }, tab.sessionId)
  const address = session ? (session.username ? session.username + '@' : '') + session.host + (session.protocol === 'serial' ? '' : ':' + session.port) : ''
  const copyAddress = async () => {
    try { await writeClipboard(address); toast.success('Connection address copied') }
    catch (err) { notifyError('Could not copy the connection address', err) }
  }
  const toggleReadOnly = async () => {
    if (!settings || readOnlyLocked) return
    try { useUi.getState().setSettings(await window.hopline.settings.update({ aiReadOnly: !settings.aiReadOnly })) }
    catch (err) { notifyError('Could not change read-only mode', err) }
  }
  const model = settings?.aiConfigured ? providerLabel(settings) : null
  return (
    <div className="status-bar flex h-6 shrink-0 items-center gap-4 border-t border-line bg-canvas px-3 text-2xs text-fg-subtle">
      {tab && session ? (
        <span className="flex items-center gap-1.5">
          <ConnectionDetails tab={tab} name={session.name} />
          {fallback && <span>(other pane)</span>}
          <button className="truncate font-mono hover:text-fg" title={'Copy ' + address} aria-label={'Copy connection address ' + address} onClick={() => void copyAddress()}>{address}</button>
          {tab.logPath && <span title={tab.logPath}>· logging</span>}
          <SerialLinesItem tab={tab} />
          <TabPlatformChip tab={tab} />
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          Empty pane · <Kbd keys={sc('session.switcher') ?? 'Mod+P'} /> to connect
        </span>
      )}
      <span className="flex-1" />
      {focusedTab && <EchoLatency id={focusedTab.tabId} />}
      {focusedTab && <span title="Terminal text encoding" className="font-mono">UTF-8</span>}
      {model && <button className="max-w-28 truncate hover:text-fg" title={model.title} aria-label={'AI model ' + model.text} onClick={() => openSettings('aiProvider')}>{model.text}</button>}
      <Tooltip label="Session overview" side="top">
        <button onClick={showOverview} aria-label="Open session overview" className="flex items-center gap-1 hover:text-fg">
          <PanelsTopLeft className="size-3" /><span className="hidden sm:inline">Overview</span>
        </button>
      </Tooltip>
      {focusedTab?.state === 'connected' && session?.protocol === 'ssh' && (
        <Tooltip label="Browse remote files" shortcut={sc('files.toggle')} side="top">
          <button aria-label="Browse remote files" aria-pressed={filesOpen} className="flex items-center gap-1 hover:text-fg aria-pressed:text-accent" onClick={() => filesOpen ? closeFiles() : openFiles(focusedTab.tabId)}>
            <FolderOpen className="size-3" /> Files
          </button>
        </Tooltip>
      )}
      <UpdateItem />
      {fleetAway && (
        <Tooltip label="A fleet investigation is still running and using tokens. Click to show it." side="top">
          <button data-testid="fleet-status-item" className="flex items-center gap-1 text-accent hover:underline" onClick={() => useFleet.getState().show()}>
            <Network className="size-3" /> Fleet · running
          </button>
        </Tooltip>
      )}
      {vault?.mode === 'session' && (
        <Tooltip label="Session-only vault: saved passwords and keys are forgotten when Hopline quits. Set a master password in Settings → Security." side="top">
          <button className="flex items-center gap-1 text-warn hover:underline" onClick={() => openSettings('vaultMode')}>
            <TriangleAlert className="size-3" /> secrets not saved
          </button>
        </Tooltip>
      )}
      {vault?.mode === 'master' && (
        <Tooltip label={vault.locked ? 'Vault locked: stored passwords and keys need your master password' : 'Lock the vault now'} side="top">
          <button
            aria-label={vault.locked ? 'Unlock vault' : 'Lock vault'}
            className={`flex items-center gap-1 hover:text-fg ${vault.locked ? 'text-warn' : ''}`}
            onClick={() => (vault.locked ? openUnlock() : void window.hopline.vault.lock())}
          >
            {vault.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
            {vault.locked ? 'locked' : 'vault'}
          </button>
        </Tooltip>
      )}
      {settings && (
        <div className="flex items-center">
          <button aria-label="Toggle read-only mode" aria-pressed={settings.aiReadOnly} disabled={readOnlyLocked} title={readOnlyLocked ? 'Managed by policy' : 'Toggle read-only mode'} onClick={() => void toggleReadOnly()} className="inline-flex size-6 items-center justify-center text-fg-muted">
            {settings.aiReadOnly ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3 text-warn" />}
          </button>
        <Tooltip label={`${settings.aiReadOnly ? READ_ONLY_ON : READ_ONLY_OFF}${readOnlyLocked ? ' Managed by policy.' : ''}`}>
          <button
            data-testid="read-only-status"
            data-managed={readOnlyLocked || undefined}
            className={`flex items-center gap-1 hover:underline ${settings.aiReadOnly ? 'text-accent' : 'text-warn'}`}
            onClick={() => openSettings('aiReadOnly')}
          >
            {settings.aiReadOnly ? 'Read-only' : 'Changes allowed'}
          </button>
        </Tooltip>
        </div>
      )}
      <span className="flex items-center gap-1">
        <Kbd keys={sc('palette.open') ?? 'Mod+K'} /> commands
      </span>
    </div>
  )
}
