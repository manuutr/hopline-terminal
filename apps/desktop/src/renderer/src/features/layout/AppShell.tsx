import { useEffect, useRef } from 'react'
import { Group, Panel, type GroupImperativeHandle, type PanelImperativeHandle } from 'react-resizable-panels'
import { reducedMotion } from '../../design/theme'
import { AiPanel } from '../ai/AiPanel'
import { CommandPalette } from '../palette/CommandPalette'
import { QuickConnect } from '../palette/QuickConnect'
import { BulkEditDialog } from '../sessions/BulkEditDialog'
import { SessionDialog } from '../sessions/SessionDialog'
import { SessionTree } from '../sessions/SessionTree'
import { SettingsDialog } from '../settings/SettingsDialog'
import { AuditDialog } from '../audit/AuditDialog'
import { FilesSplit } from '../files/FilesSplit'
import { ForwardsDialog } from '../forwards/ForwardsDialog'
import { TerminalArea } from '../terminal/TerminalArea'
import { PromptHost } from '../../lib/prompt'
import { ConfirmHost } from '../../lib/confirm'
import { dispatchKey, useKeymap } from '../../lib/actions'
import { useUi } from '../../store'
import { cn } from '../../design'
import { Divider } from '../../design/Divider'
import { onPanelSizesReset, panelSize, savePanelSize } from '../../lib/panel-sizes'
import { installBuiltinActions } from '../actions/builtin'
import { ShortcutSheet } from '../actions/ShortcutSheet'
import { ButtonBar } from '../snippets/ButtonBar'
import { SnippetEditor } from '../snippets/SnippetEditor'
import { SnippetConfirmDialog, SnippetVarsDialog } from '../snippets/SnippetDialogs'
import { installSnippetActions } from '../snippets/actions'
import { installMultiActions } from '../multi/actions'
import { installExternalActions } from '../actions/external'
import { MultiDialog } from '../multi/MultiDialog'
import { FleetView } from '../fleet/FleetView'
import { installFleetActions } from '../fleet/actions'
import { SessionSwitcher } from './SessionSwitcher'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { OpenConnections } from './OpenConnections'
import { TabCycler } from './TabCycler'
import { BufferView } from '../a11y/BufferView'
import { LiveRegion, useScreenReaderOffer } from '../a11y/LiveRegion'
import { installA11yActions } from '../a11y/actions'
import { installMenuActions } from '../menu/actions'
import { OverridesDialog } from '../overrides/OverridesDialog'

const handle =
  'relative w-px bg-line transition-colors duration-[var(--dur-fast)] data-[separator=hover]:bg-accent/50 data-[separator=hover]:delay-200 data-[separator=active]:bg-accent data-[separator=active]:delay-0 data-[separator=active]:duration-0 before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""]'

export function AppShell(): React.JSX.Element {
  const { sidebarOpen, aiOpen } = useUi()
  const left = useRef<PanelImperativeHandle | null>(null)
  const right = useRef<PanelImperativeHandle | null>(null)
  const assistantWasOpen = useRef(false)
  const group = useRef<GroupImperativeHandle | null>(null)
  useScreenReaderOffer()

  // Keep panels in sync with store toggles (keyboard / palette).
  useEffect(() => {
    const p = left.current
    if (!p) return
    if (sidebarOpen && p.isCollapsed()) p.expand()
    if (!sidebarOpen && !p.isCollapsed()) p.collapse()
  }, [sidebarOpen])
  useEffect(() => {
    const p = right.current
    if (!p) return
    if (aiOpen) {
      assistantWasOpen.current = true
      if (p.isCollapsed()) p.expand()
    }
    if (!aiOpen && !p.isCollapsed()) {
      if (!assistantWasOpen.current || reducedMotion()) p.collapse()
      else {
        const timer = setTimeout(() => p.collapse(), 120)
        return () => clearTimeout(timer)
      }
    }
  }, [aiOpen])
  // Settings → Appearance → Panel sizes → Reset: open side panels go back to their defaults.
  useEffect(
    () =>
      onPanelSizesReset(() => {
        if (left.current && !left.current.isCollapsed()) left.current.resize(260)
        if (right.current && !right.current.isCollapsed()) right.current.resize(380)
      }),
    []
  )

  useEffect(() => {
    installBuiltinActions()
    installSnippetActions()
    installMultiActions()
    installFleetActions()
    installA11yActions()
    installMenuActions()
    // Command blocks and config backups declare their own lists; they join the registry here.
    installExternalActions()
    void useKeymap.getState().load()
    // One capture-phase handler for every app shortcut (lib/actions); unbound keys reach the device.
    const onKey = (e: KeyboardEvent) => void dispatchKey(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Landmarks (axe region / landmark-one-main): title bar, sessions, terminals, assistant, status bar. */}
      <TitleBar />
      <Group role="main" aria-label="Device workspace" orientation="horizontal" className="min-h-0 flex-1" groupRef={group}>
        <Panel
          id="sidebar"
          panelRef={left}
          defaultSize={panelSize('sidebar', 260, 180, 480)}
          minSize={180}
          maxSize={480}
          collapsible
          collapsedSize={0}
          // The panel clips; its own contents scroll (a scrollable wrapper with nothing to focus fails axe).
          style={{ overflow: 'hidden' }}
          onResize={(size) => {
            savePanelSize('sidebar', size.inPixels, 180)
            const open = size.inPixels > 0
            if (open !== useUi.getState().sidebarOpen) useUi.getState().set({ sidebarOpen: open })
          }}
        >
          {/* Collapsed to zero width, its contents stay mounted: inert keeps Tab and screen readers out. */}
          <aside role="region" aria-label="Sessions" className="flex h-full flex-col" inert={!sidebarOpen}>
            <OpenConnections />
            <div data-saved-sessions className="min-h-0 flex-1"><SessionTree /></div>
          </aside>
        </Panel>
        {/* A collapsed panel leaves no hairline at the window edge. */}
        <Divider label="Resize session sidebar" group={group} before="sidebar" after="main" horizontal collapsible={left} panel={left} className={cn(handle, !sidebarOpen && 'bg-transparent')} />
        <Panel id="main" minSize={360} style={{ overflow: 'hidden' }}>
          <section aria-label="Terminals" className="flex h-full flex-col">
            <h1 className="sr-only">Hopline</h1>
            <LiveRegion />
            <ButtonBar />
            <div className="min-h-0 flex-1">
              <FilesSplit>
                <TerminalArea />
              </FilesSplit>
            </div>
          </section>
        </Panel>
        <Divider label="Resize assistant panel" group={group} before="main" after="ai" horizontal collapsible={right} panel={right} panelSide="after" className={cn(handle, !aiOpen && 'bg-transparent')} />
        <Panel
          id="ai"
          panelRef={right}
          defaultSize={panelSize('ai', 380, 300, 720)}
          minSize={300}
          maxSize={720}
          collapsible
          collapsedSize={0}
          style={{ overflow: 'hidden' }}
          onResize={(size, _id, previous) => {
            savePanelSize('ai', size.inPixels, 300)
            const open = size.inPixels > 0
            if (previous && (previous.inPixels === 0) === open && open !== useUi.getState().aiOpen) useUi.getState().set({ aiOpen: open })
          }}
        >
          <aside role="region" aria-label="Assistant" data-open={aiOpen} className="assistant-dock h-full" inert={!aiOpen}>
            <AiPanel />
          </aside>
        </Panel>
      </Group>
      <footer className="shrink-0">
        <StatusBar />
      </footer>
      <CommandPalette />
      <SessionDialog />
      <BulkEditDialog />
      <QuickConnect />
      <SettingsDialog />
      <AuditDialog />
      <ForwardsDialog />
      <SessionSwitcher />
      <TabCycler />
      <ShortcutSheet />
      <SnippetEditor />
      <SnippetVarsDialog />
      <SnippetConfirmDialog />
      <MultiDialog />
      <FleetView />
      <BufferView />
      <PromptHost />
      <OverridesDialog />
      <ConfirmHost />
    </div>
  )
}
