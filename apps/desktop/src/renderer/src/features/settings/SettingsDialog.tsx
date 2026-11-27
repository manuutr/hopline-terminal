import { isAccount, isKeyProvider } from '@shared/providers'
import { BellRing, CircleHelp, Compass, DatabaseBackup, Keyboard, KeyRound, Network, Palette, PanelsTopLeft, Search, ShieldCheck, SquareTerminal, X, MessagesSquare } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Managed } from '../trust/Managed'
import { useLocks } from '../trust/store'
import { TrustRows } from './TrustRows'
import { toast } from '../../lib/notify'
import type { Settings } from '@shared/types'
import { SETTINGS_SECTIONS, SETTINGS_TABS, searchSettings, tabOfSection, type SettingDef, type SettingsTab } from '@shared/settings-registry'
import { Badge, Button, cn, Dialog, Input, Kbd, Segmented, Select } from '../../design'
import { useSnippets } from '../snippets/store'
import { ThemeOptions } from '../themes/ThemeOptions'
import { TermPreview } from '../themes/TerminalPreview'
import { openKnownHosts } from '../knownhosts/KnownHostsDialog'
import { CredentialsPanel } from '../credentials/CredentialsPanel'
import { applyMotion, applyTheme } from '../../design/theme'
import { askConfirm } from '../../lib/confirm'
import { notifyError } from '../../lib/connect'
import { allActions, keysOf, titleOf, useKeymap } from '../../lib/actions'
import { openSettings, useSettingsNav } from '../../lib/settings-nav'
import { useUi } from '../../store'
import { AssistantSection } from './AssistantSection'
import { DataPanel } from './DataPanel'
import { KeyboardPanel } from './KeyboardPanel'
import { Row, Section, Toggle } from './parts'
import { SecurityPanel } from './SecurityPanel'
import { PrivacyPanel } from './PrivacyPanel'
import { ThemesPanel } from '../themes/ThemesPanel'
import { useThemes } from '../themes/store'
import { GettingStartedRow } from '../onboarding/Checklist'
import { startTour, useTour } from '../onboarding/tour'
import { resetPanelSizes } from '../../lib/panel-sizes'

export type { SettingsTab }
/** Kept for older imports: Settings opens through lib/settings-nav. */
export { openSettings }

/** Tabs whose fields are part of the form (Save / Cancel); the others act at once (Close). */
const FORM_TABS: SettingsTab[] = ['general', 'assistant', 'connections', 'terminal', 'themes']
const TAB_ICONS = { general: PanelsTopLeft, assistant: MessagesSquare, connections: Network, terminal: SquareTerminal, themes: Palette, keyboard: Keyboard, credentials: KeyRound, security: ShieldCheck, privacy: BellRing, data: DatabaseBackup }

export const MONO_FONTS = ['JetBrains Mono', 'Cascadia Code', 'Fira Code', 'SF Mono', 'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Ubuntu Mono', 'IBM Plex Mono']

/** The button bar is a per-machine view preference, applied at once (not part of Save). */
function BarToggle(): React.JSX.Element {
  const visible = useSnippets((s) => s.barVisible ?? s.list.some((x) => x.onBar))
  return <Toggle label="Show the button bar" checked={visible} onChange={(v) => useSnippets.getState().setBar(v)} />
}

/** A search hit: a settings row, or an app shortcut (which lives on the Keyboard tab). */
type Hit = { kind: 'setting'; def: SettingDef } | { kind: 'action'; id: string; title: string; keys: string[] }

/**
 * Scroll a row into view, flash it once and focus it. `focus: 'control'` (search, in-app links)
 * focuses its first control. `focus: 'heading'` (a hopline:// deep link, untrusted) focuses the
 * row's section heading and never a control: a link may only navigate (review M7).
 */
export function land(root: HTMLElement | null, selector: string, focus: 'control' | 'heading' = 'control'): boolean {
  const el = root?.querySelector<HTMLElement>(selector)
  if (!root || !el) return false
  const details = el.closest('details')
  if (details) details.open = true
  el.scrollIntoView({ block: 'center' })
  el.setAttribute('data-flash', '')
  setTimeout(() => el.removeAttribute('data-flash'), 1600)
  if (focus === 'heading') {
    const section = el.closest<HTMLElement>('[data-settings-section]') ?? el.querySelector<HTMLElement>('[data-settings-section]')
    const target = section?.querySelector<HTMLElement>('[data-settings-heading]') ?? root.querySelector<HTMLElement>('[data-settings-heading]') ?? root
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
    return true
  }
  const control = el.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role=switch], [tabindex="0"]')
  ;(control ?? el).focus({ preventScroll: true })
  return true
}

export function SettingsDialog(): React.JSX.Element {
  const { settingsOpen, settings, vault } = useUi()
  const [edits, setEdits] = useState<Partial<Settings>>({})
  const form = useMemo(() => settings && ({ ...settings, ...edits }), [settings, edits])
  const [tips, setTips] = useState(false)
  const touring = useTour(s => s.step !== null)
  const locks = useLocks()
  const [key, setKey] = useState('')
  const [tab, setTab] = useState<SettingsTab>('general')
  const [srActive, setSrActive] = useState(false)
  useEffect(() => {
    if (settingsOpen) void window.hopline.a11y.screenReader().then(setSrActive).catch(() => {})
  }, [settingsOpen])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  /** A row to land on once its tab has rendered. */
  const [pending, setPending] = useState<{ selector: string; n: number; focus?: 'control' | 'heading' } | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const nav = useSettingsNav((s) => s.target)
  const overrides = useKeymap((s) => s.overrides)
  const themes = useThemes((s) => s.list)

  useEffect(() => {
    if (!settingsOpen) {
      setEdits({})
      setKey('')
      setTips(false)
      setTab('general')
      setQ('')
    }
  }, [settingsOpen])

  // openSettings(target): go to the tab, then land on the row (or the section) once it is drawn.
  useEffect(() => {
    if (!nav) return
    setQ('')
    setTab(nav.tab)
    const focus = nav.via === 'link' ? 'heading' : 'control'
    setPending(nav.key ? { selector: `[data-setting-key="${nav.key}"]`, n: nav.n, focus } : nav.section ? { selector: `[data-settings-section="${nav.section}"]`, n: nav.n, focus } : null)
  }, [nav])
  useEffect(() => {
    if (!pending || !settingsOpen) return
    // Two frames: the dialog's content mounts on open, and the tab panel renders after setTab.
    let tries = 0
    let raf = 0
    const tick = () => {
      if (land(body.current, pending.selector, pending.focus) || ++tries > 20) return setPending(null)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pending, tab, settingsOpen, form])

  const hits = useMemo<Hit[]>(() => {
    if (!q.trim()) return []
    const settingHits: Hit[] = searchSettings(q).map((h) => ({ kind: 'setting', def: h.def }))
    const needle = q.trim().toLowerCase()
    const actionHits: Hit[] = allActions()
      .filter((a) => !a.id.startsWith('tab.goto.') && (a.keys?.length || overrides[a.id]?.length) && `${titleOf(a)} ${a.keywords ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 8)
      .map((a) => ({ kind: 'action', id: a.id, title: titleOf(a), keys: keysOf(a, overrides) }))
    return [...settingHits, ...actionHits]
  }, [q, overrides])
  useEffect(() => setSel(0), [q])

  if (!form) return <></>
  const close = () => {
    useUi.getState().set({ settingsOpen: false })
    // Signing in or disconnecting takes effect immediately, including when edits are cancelled.
    if (isAccount(form.aiProvider) || (settings && isAccount(settings.aiProvider))) {
      void window.hopline.settings.get().then(next => useUi.getState().setSettings(next)).catch(() => {})
    }
  }
  const up = <K extends keyof Settings>(k: K, v: Settings[K]) => setEdits(previous => ({ ...previous, [k]: v }))

  const pick = (h: Hit | undefined) => {
    if (!h) return
    setQ('')
    if (h.kind === 'setting') {
      setTab(tabOfSection(h.def.section))
      setPending({ selector: `[data-setting-key="${h.def.key}"]`, n: Date.now() })
    } else {
      setTab('keyboard')
      setPending({ selector: `[data-action="${h.id}"]`, n: Date.now() })
    }
  }

  const save = async () => {
    try {
      let next = await window.hopline.settings.update(edits)
      if (key.trim() && isKeyProvider(form.aiProvider)) next = await window.hopline.settings.setApiKey(key.trim(), form.aiProvider)
      const stoppedRestoring = !!settings?.termRestoreScrollback && !next.termRestoreScrollback
      applyMotion(next.reduceMotion)
      useUi.getState().setSettings(next)
      applyTheme(next.theme)
      // The dialog closing is the confirmation: no "Settings saved" toast.
      close()
      // History saved so far stays on disk unless deleted: offer that when restoring is turned off.
      if (stoppedRestoring && (await askConfirm('Delete saved terminal history?', 'History is no longer restored. The history already saved for your sessions is still on disk, encrypted.', 'Delete history'))) {
        await window.hopline.scrollback.clear()
        toast.success('Saved terminal history deleted')
      }
    } catch (e) {
      notifyError('Could not save settings', e)
    }
  }

  const removeKey = async () => {
    if (!isKeyProvider(form.aiProvider)) return
    const next = await window.hopline.settings.setApiKey(null, form.aiProvider)
    useUi.getState().setSettings(next)
    setKey('')
  }

  const searching = q.trim().length > 0

  return (
    <Dialog
      open={settingsOpen && !touring}
      onOpenChange={(o) => !o && close()}
      title="Settings"
      fill
      className="top-[7vh] h-[min(720px,86vh)] w-[min(960px,96vw)]"
      bodyClassName="flex-row"
      // Open on the dialog itself: no stray ring on the close button, no field grabbing keys.
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        ;(e.currentTarget as HTMLElement | null)?.focus()
      }}
      // Esc clears a search first; a second Esc closes Settings.
      onEscapeKeyDown={(e) => {
        if (q) {
          e.preventDefault()
          setQ('')
          search.current?.focus()
        }
      }}
      footer={
        (Object.keys(edits).length > 0 || key.trim() || (FORM_TABS.includes(tab) && !searching)) ? (
          <>
            <span className="mr-auto self-center text-2xs text-fg-subtle" data-testid="app-version">Hopline {__APP_VERSION__}</span>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()}>Save</Button>
          </>
        ) : (
          <Button onClick={close}>Close</Button>
        )
      }
    >
      <div className="flex w-44 shrink-0 flex-col border-r border-line bg-surface md:w-48">
        <div className="p-2 pb-1">
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-line-input bg-canvas px-2 focus-within:border-accent/60">
            <Search className="size-3.5 shrink-0 text-fg-subtle" />
            <input
              ref={search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              // A combobox over the results: Up/Down move the active option, and a screen reader
              // hears which one (aria-activedescendant; review addendum, settings search).
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={searching && hits.length > 0}
              // Only while the list is on screen: aria-controls must name an element that exists (axe).
              aria-controls={searching && hits.length > 0 ? 'settings-results' : undefined}
              aria-activedescendant={searching && hits[sel] ? `settings-hit-${sel}` : undefined}
              data-testid="settings-search"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
              onKeyDown={(e) => {
                // Enter that confirms an IME composition (Japanese, Chinese...) is not a pick.
                if (!searching || e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const d = e.key === 'ArrowDown' ? 1 : -1
                  setSel((i) => (hits.length ? (i + d + hits.length) % hits.length : 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  pick(hits[Math.min(sel, hits.length - 1)])
                }
              }}
            />
            {q && (
              <button type="button" aria-label="Clear search" className="text-fg-subtle hover:text-fg" onClick={() => (setQ(''), search.current?.focus())}>
                <X className="size-3.5" />
              </button>
            )}
          </label>
        </div>
        {/* Left nav (Zed / Linear): a vertical tablist; Up/Down (wrapping), Home and End move between sections, and focus follows. */}
        <div
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          className="flex min-h-0 flex-col gap-0.5 overflow-auto px-2 pb-3 pt-1"
          onKeyDown={(e) => {
            const i = SETTINGS_TABS.findIndex(([id]) => id === tab)
            const to = e.key === 'ArrowDown' ? (i + 1) % SETTINGS_TABS.length : e.key === 'ArrowUp' ? (i + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? SETTINGS_TABS.length - 1 : -1
            if (to < 0) return
            e.preventDefault()
            const next = SETTINGS_TABS[to]![0]
            setQ('')
            setTab(next)
            // Read the list now: React clears e.currentTarget after the handler, and it was read
            // inside requestAnimationFrame, where it was already null (review P1-1).
            const list = e.currentTarget
            requestAnimationFrame(() => (list.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus())
          }}
        >
          {SETTINGS_TABS.map(([id, label]) => {
            const Icon = TAB_ICONS[id]
            return (
            <button
              key={id}
              role="tab"
              data-tab={id}
              aria-selected={!searching && tab === id}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => (setQ(''), setTab(id))}
              className={cn('flex min-h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors duration-[var(--dur-fast)]', !searching && tab === id ? 'bg-active font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg', (id === 'credentials' || id === 'themes') && 'mt-2')}
            >
              <Icon aria-hidden className={cn('size-4 shrink-0', !searching && tab === id && 'text-accent')} />{label}
            </button>
          )})}
        </div>
      </div>
      {searching ? (
        <div className="min-w-0 flex-1 overflow-auto px-4 py-3">
          {hits.length === 0 ? (
            <p className="px-2 py-1 text-sm text-fg-subtle" role="status">
              No settings match “{q.trim()}”.
            </p>
          ) : (
            <div id="settings-results" role="listbox" aria-label="Matching settings">
              {hits.map((h, i) => {
                const label = h.kind === 'setting' ? h.def.label : h.title
                const section = h.kind === 'setting' ? SETTINGS_SECTIONS[h.def.section] : undefined
                const group = SETTINGS_TABS.find(([id]) => id === section?.tab)?.[1]
                const where = section ? (group === section.title ? group : group + ' › ' + section.title) : 'Keyboard › Shortcuts'
                return (
                  <div
                    key={h.kind === 'setting' ? h.def.key : h.id}
                    id={`settings-hit-${i}`}
                    role="option"
                    aria-selected={i === sel}
                    data-hit={h.kind === 'setting' ? h.def.key : h.id}
                    onMouseMove={() => setSel(i)}
                    onClick={() => pick(h)}
                    className={cn('flex h-8 cursor-default items-center gap-3 rounded-md px-2 text-sm', i === sel ? 'bg-hover text-fg' : 'text-fg-muted')}
                  >
                    <span className="truncate text-fg">{label}</span>
                    <span className="truncate text-2xs text-fg-subtle">{where}</span>
                    {h.kind === 'action' && h.keys[0] && <Kbd keys={h.keys[0]} className="ml-auto" />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div key={tab} ref={body} role="tabpanel" data-settings-page={tab} data-setting-tips={tips ? 'shown' : 'hidden'} aria-label={SETTINGS_TABS.find(([id]) => id === tab)?.[1]} className="min-w-0 flex-1 overflow-auto px-6 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 tabIndex={-1} data-settings-heading className="text-lg font-semibold tracking-tight">{SETTINGS_TABS.find(([id]) => id === tab)?.[1]}</h2>
            {tab !== 'credentials' && tab !== 'keyboard' && <Button size="sm" variant="ghost" aria-pressed={tips} onClick={() => setTips(!tips)}><CircleHelp aria-hidden />{tips ? 'Hide tips' : 'Show tips'}</Button>}
          </div>
          {tab === 'keyboard' && (
            <div data-setting-key="keymap">
              <KeyboardPanel />
            </div>
          )}
          {tab === 'credentials' && (
            <div data-setting-key="credentials">
              <CredentialsPanel />
            </div>
          )}
          {tab === 'security' && <SecurityPanel />}
          {tab === 'privacy' && <PrivacyPanel />}
          {tab === 'data' && <DataPanel />}
          {tab === 'themes' && <ThemesPanel form={form} up={up} />}
          {tab === 'assistant' && (
            <>
              <Section id="assistant" title="Model connection">
                <AssistantSection form={form} up={up} apiKey={key} setApiKey={setKey} onRemoveKey={() => void removeKey()} vaultMode={vault?.mode} vaultLocked={vault?.locked} />
              </Section>
              <Section title="Permissions and limits">
                <Row k="aiReadOnly" essential label="Read-only mode" hint="Restricts automated commands and blocks file uploads. You can still type in the terminal.">
                  <div className="flex items-center gap-2">
                    <Toggle label="Read-only mode" checked={form.aiReadOnly} disabled={locks.readOnly} onChange={(v) => up('aiReadOnly', v)} />
                    <Badge tone={form.aiReadOnly ? 'accent' : 'warn'}>{form.aiReadOnly ? 'read-only' : 'changes allowed'}</Badge>
                    {locks.readOnly && <Managed what="Read-only mode" />}
                  </div>
                </Row>
                <TrustRows form={form} up={up} />
                <Row k="commandTimeoutMs" label="Command timeout" hint="Per agent command. Ctrl-C is sent when exceeded.">
                  <div className="flex items-center gap-2">
                    <Input type="number" min={1} max={300} value={form.commandTimeoutMs / 1000} onChange={(e) => up('commandTimeoutMs', Math.max(1, Number(e.target.value)) * 1000)} className="w-24" />
                    <span className="text-xs text-fg-subtle">seconds</span>
                  </div>
                </Row>
                <Row k="outputCapBytes" label="Output cap" hint="Max output per agent command.">
                  <div className="flex items-center gap-2">
                    <Input type="number" min={4} max={16384} value={Math.round(form.outputCapBytes / 1024)} onChange={(e) => up('outputCapBytes', Math.max(4, Number(e.target.value)) * 1024)} className="w-24" />
                    <span className="text-xs text-fg-subtle">KB</span>
                  </div>
                </Row>
              </Section>
            </>
          )}
          {tab === 'connections' && (
            <>
              <Section id="connections" title="Session defaults">
                <Row k="keepAliveSec" label="Keep-alive" hint="SSH keep-alive interval. 0 disables. A session or folder can override it.">
                  <div className="flex items-center gap-2">
                    <Input type="number" min={0} max={3600} value={form.keepAliveSec} onChange={(e) => up('keepAliveSec', Math.max(0, Number(e.target.value)))} className="w-24" aria-label="Keep-alive seconds" />
                    <span className="text-xs text-fg-subtle">seconds</span>
                  </div>
                </Row>
                <Row k="autoReconnect" label="Auto-reconnect" hint="Retry with backoff when a session drops (not on auth or host-key errors).">
                  <Toggle label="Auto-reconnect" checked={form.autoReconnect} onChange={(v) => up('autoReconnect', v)} />
                </Row>
                <Row k="filesOnConnect" label="Open Files on SSH connect" hint="Show the remote file browser when the active SSH session connects. The terminal keeps keyboard focus.">
                  <Toggle label="Open Files on SSH connect" checked={form.filesOnConnect} onChange={(v) => up('filesOnConnect', v)} />
                </Row>
                <Row k="knownHosts" label="Known hosts" hint="SSH host keys you trust, and import from OpenSSH.">
                  <Button onClick={openKnownHosts}>Manage known hosts…</Button>
                </Row>
              </Section>
              <Section id="logging" title="Logging">
                <Row k="logDir" label="Log folder" hint="Where session logs are written when logging is on.">
                  <Input value={form.logDir} onChange={(e) => up('logDir', e.target.value)} className="font-mono text-xs" aria-label="Log folder" />
                </Row>
                <Row k="logTemplate" label="Log file name" hint="Tokens: %S session, %H host, %P port, %U user, %Y %M %D date, %h %m %s time. Use / for subfolders, e.g. %Y-%M/%S_%D.log">
                  <Input value={form.logTemplate} onChange={(e) => up('logTemplate', e.target.value)} className="font-mono text-xs" aria-label="Log file name" />
                </Row>
                <Row k="logTimestamps" label="Timestamp each line" hint="Prefix logged lines with [hh:mm:ss.ms].">
                  <Toggle label="Timestamp each line" checked={form.logTimestamps} onChange={(v) => up('logTimestamps', v)} />
                </Row>
                <Row k="logRotateDaily" label="New log file daily" hint="Long-running sessions roll over to a new file at midnight.">
                  <Toggle label="New log file daily" checked={form.logRotateDaily} onChange={(v) => up('logRotateDaily', v)} />
                </Row>
              </Section>
            </>
          )}
          {tab === 'terminal' && (
            <>
              <Section id="terminal" title="Text and cursor">
                <Row k="termTheme" label="Theme" hint="Colors for terminal output.">
                  <div className="flex min-w-0 items-center gap-2">
                    <Select value={form.termTheme} onChange={(e) => up('termTheme', e.target.value)} aria-label="Terminal theme" className="min-w-0 max-w-56">
                      <ThemeOptions custom={themes} />
                    </Select>
                    <Button size="sm" variant="ghost" onClick={() => {
                      setTab('themes')
                      setPending({ selector: '[data-setting-key="themeLibrary"]', n: Date.now(), focus: 'control' })
                    }}>Browse palettes…</Button>
                  </div>
                </Row>
                <Row k="termFontFamily" label="Font" hint="Any installed monospace font. Empty uses the bundled JetBrains Mono.">
                  <Input list="mono-fonts" value={form.termFontFamily} onChange={(e) => up('termFontFamily', e.target.value)} placeholder="JetBrains Mono (bundled)" aria-label="Terminal font" />
                  <datalist id="mono-fonts">
                    {MONO_FONTS.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </Row>
                <Row k="termFontSize" label="Size and spacing">
                  <div className="flex items-center gap-2">
                    <Input type="number" min={8} max={32} step={0.5} value={form.termFontSize} onChange={(e) => up('termFontSize', Math.min(32, Math.max(8, Number(e.target.value))))} className="w-20" aria-label="Font size" />
                    <span className="text-xs text-fg-subtle">px, line height</span>
                    <Input type="number" min={1} max={2} step={0.05} value={form.termLineHeight} onChange={(e) => up('termLineHeight', Math.min(2, Math.max(1, Number(e.target.value))))} className="w-20" aria-label="Line height" />
                  </div>
                </Row>
                <Row k="termSmoothCaret" label="Smooth caret movement" hint="Ease the blinking bar cursor between cells.">
                  <Toggle label="Smooth caret movement" checked={form.termSmoothCaret} onChange={(v) => up('termSmoothCaret', v)} />
                </Row>
                <Row k="termLigatures" label="Font ligatures" hint="Join operator pairs such as arrows in the terminal font.">
                  <Toggle label="Font ligatures" checked={form.termLigatures} onChange={(v) => up('termLigatures', v)} />
                </Row>
                <Row k="termCursorStyle" label="Cursor">
                  <div className="flex items-center gap-3">
                    <Segmented
                      label="Cursor style"
                      value={form.termCursorStyle}
                      onChange={(c) => up('termCursorStyle', c)}
                      items={[
                        { value: 'bar', label: 'Bar' },
                        { value: 'block', label: 'Block' },
                        { value: 'underline', label: 'Underline' }
                      ]}
                    />
                    <Toggle inline label="Blink" checked={form.termCursorBlink} onChange={(v) => up('termCursorBlink', v)} />
                  </div>
                </Row>
                <Row label="Preview">
                  <TermPreview s={form} />
                </Row>
              </Section>
              <Section title="History and input">
                <Row k="termRestoreScrollback" label="Restore history" hint="Keep each session's last 5,000 lines, encrypted on disk, and show them when you reconnect. Needs the OS keychain or a master password, set under Security.">
                  <div className="flex items-center gap-2">
                    <Toggle label="Restore history" checked={form.termRestoreScrollback} onChange={(v) => up('termRestoreScrollback', v)} />
                    <Button size="sm" variant="ghost" onClick={() => void window.hopline.scrollback.clear().then(() => toast.success('Saved terminal history deleted'))}>
                      Delete saved history
                    </Button>
                  </div>
                </Row>
                <Row k="termScrollback" label="Scrollback" hint="Lines kept per tab. More lines use more memory (about 1 MB per 10,000 lines).">
                  <div className="flex items-center gap-2">
                    <Input type="number" min={500} max={200000} step={1000} value={form.termScrollback} onChange={(e) => up('termScrollback', Math.min(200_000, Math.max(500, Math.round(Number(e.target.value)))))} className="w-28" aria-label="Scrollback lines" />
                    <span className="text-xs text-fg-subtle">lines</span>
                  </div>
                </Row>
                <Row k="termHighlight" label="Output highlighting" hint="Colors interfaces, IPs, MACs, up/down states, errors and syslog severity. Display only: logs and copy stay plain.">
                  <Toggle label="Output highlighting" checked={form.termHighlight} onChange={(v) => up('termHighlight', v)} />
                </Row>
                <Row k="termScreenReader" label="Screen reader mode" hint={`Reads new output aloud through your screen reader, at most once a second, and summarises long output. Mod+Alt+B opens the scrollback as plain text.${srActive ? ' A screen reader is running.' : ''}`}>
                  <Toggle label="Screen reader mode" checked={form.termScreenReader} onChange={(v) => up('termScreenReader', v)} />
                </Row>
                <Row k="termAutocomplete" label="Autocomplete" hint="Ghost text and command help at the device prompt, from the platform's command model. Tab, → or End accepts; with no suggestion showing, Tab goes to the device. Never sends a command of its own.">
                  <Toggle label="Autocomplete" checked={form.termAutocomplete} onChange={(v) => up('termAutocomplete', v)} />
                </Row>
              </Section>
            </>
          )}
          {tab === 'general' && (
            <>
              <Section id="appearance" title="Appearance">
                <Row k="theme" label="Theme">
                  <Segmented
                    label="Theme"
                    value={form.theme}
                    onChange={(t) => up('theme', t)}
                    items={[
                      { value: 'dark', label: 'Dark' },
                      { value: 'light', label: 'Light' },
                      { value: 'contrast', label: 'High contrast' },
                      { value: 'system', label: 'System' }
                    ]}
                  />
                </Row>
                <Row k="reduceMotion" label="Reduce motion" hint="Keep transitions and the terminal cursor still. Your system’s reduced-motion setting also applies.">
                  <Toggle label="Reduce motion" checked={form.reduceMotion} onChange={(v) => up('reduceMotion', v)} />
                </Row>
                <Row k="buttonBar" label="Button bar" hint="Show saved snippets above the terminal. This takes effect immediately.">
                  <BarToggle />
                </Row>

                <Row k="panelSizes" label="Panel sizes" hint="Restore the default sidebar, assistant and file panel sizes.">
                  <Button size="sm" onClick={resetPanelSizes}>
                    Reset panel sizes
                  </Button>
                </Row>
              </Section>
              <Section title="Getting started">
                <Row k="workspaceTour" label="Workspace tour"><Button data-tour-launch size="sm" onClick={startTour}><Compass aria-hidden />Take a tour</Button></Row>
                <GettingStartedRow />
              </Section>
              <Section id="notifications" title="Notifications">
                <Row k="notifyApprovals" label="Approvals waiting" hint="A desktop notification when the assistant waits for your approval and Hopline is not the focused window.">
                  <Toggle label="Notify when an approval waits" checked={form.notifyApprovals} onChange={(v) => up('notifyApprovals', v)} />
                </Row>
                <Row k="notifyDisconnects" label="Unexpected disconnects" hint="A desktop notification when a session drops without you closing it and Hopline is not the focused window.">
                  <Toggle label="Notify on unexpected disconnects" checked={form.notifyDisconnects} onChange={(v) => up('notifyDisconnects', v)} />
                </Row>
              </Section>
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
