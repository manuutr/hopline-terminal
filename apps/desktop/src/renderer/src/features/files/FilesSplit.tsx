import { useEffect, useRef, type ReactNode } from 'react'
import { Group, Panel, type GroupImperativeHandle, type PanelImperativeHandle } from 'react-resizable-panels'
import { Divider } from '../../design/Divider'
import { panelSize, savePanelSize } from '../../lib/panel-sizes'
import { activeTab, sessionById, useUi } from '../../store'
import { FilesPanel } from './FilesPanel'
import { useFiles } from './store'

const handle =
  'relative h-px bg-line transition-colors duration-[var(--dur-fast)] data-[separator=hover]:bg-accent/50 data-[separator=hover]:delay-200 data-[separator=active]:bg-accent data-[separator=active]:delay-0 data-[separator=active]:duration-0 before:absolute before:inset-x-0 before:-top-1 before:-bottom-1 before:content-[""]'

/** The terminal area with the files panel below it (collapsed until opened from the tab menu). */
export function FilesSplit({ children }: { children: ReactNode }): React.JSX.Element {
  const open = useFiles((s) => s.open)
  const ref = useRef<PanelImperativeHandle | null>(null)
  const group = useRef<GroupImperativeHandle | null>(null)
  useEffect(() => useUi.subscribe((current, previous) => {
    if (!current.settings?.filesOnConnect || current.tabs === previous.tabs) return
    const tab = activeTab(current)
    if (tab?.state === 'connected' && previous.tabs.find((t) => t.tabId === tab.tabId)?.state !== 'connected' && sessionById(current, tab.sessionId)?.protocol === 'ssh') {
      useFiles.setState({ open: true, wantFocus: false })
    }
  }), [])
  useEffect(() => {
    const p = ref.current
    if (!p) return
    if (open && p.isCollapsed()) {
      p.expand()
      // First open: the remembered height, else a useful one rather than the minimum.
      const want = panelSize('files', 300, 180, 640)
      if (p.getSize().inPixels < 280 || want !== 300) p.resize(want)
    }
    if (!open && !p.isCollapsed()) p.collapse()
  }, [open])
  return (
    <Group orientation="vertical" className="h-full" groupRef={group}>
      <Panel id="terminals" minSize={160} style={{ overflow: 'hidden' }}>
        {children}
      </Panel>
      {/* Closed: no handle to grab (the panel opens from the tab menu). */}
      <Divider label="Resize files panel" group={group} before="terminals" after="files" horizontal={false} collapsible={ref} panel={ref} panelSide="after" className={open ? handle : 'pointer-events-none h-0'} disabled={!open} />
      <Panel
        id="files"
        panelRef={ref}
        defaultSize={0}
        minSize={180}
        maxSize={640}
        collapsible
        collapsedSize={0}
        style={{ overflow: 'hidden' }}
        onResize={(size) => {
          savePanelSize('files', size.inPixels, 180)
          const isOpen = size.inPixels > 0
          if (isOpen !== useFiles.getState().open) useFiles.setState({ open: isOpen })
        }}
      >
        {open && <FilesPanel />}
      </Panel>
    </Group>
  )
}
