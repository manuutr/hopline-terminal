import { Columns2, Copy, Minus, PanelLeft, PanelRight, Plus, Rows2, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FrameState } from '@shared/types'
import { Button, cn, Tooltip } from '../../design'
import { isMac } from '../../lib/keys'
import { useShortcutMap } from '../../lib/actions'
import { useUi } from '../../store'
import { INLINE_MENUS_MIN_WIDTH, MenuBar } from '../menu/MenuBar'

export function TitleBar(): React.JSX.Element {
  const sc = useShortcutMap()
  const hasWs = useUi((s) => s.workspaces.length > 0)
  const sidebarOpen = useUi((x) => x.sidebarOpen)
  const aiOpen = useUi((x) => x.aiOpen)
  const frame = useFrame()
  const mac = frame ? frame.platform === 'darwin' : isMac
  const wide = useWide(INLINE_MENUS_MIN_WIDTH)
  const iconBtn = 'size-7 text-fg-subtle [-webkit-app-region:no-drag]'
  return (
    <header
      data-titlebar=""
      // Empty title-bar space drags the window. Controls opt out.
      className="relative flex h-[var(--titlebar-h)] shrink-0 select-none items-stretch bg-canvas [-webkit-app-region:drag]"
      // Double-click on empty bar space maximises. Windows and macOS do it themselves (the page never
      // sees that double-click); Linux window managers may not, so it is done here there.
      onDoubleClick={(e) => {
        if (frame?.platform !== 'linux') return
        if ((e.target as HTMLElement).closest('button,[role=menuitem],[role=menubar]')) return
        void window.hopline.frame.toggleMaximize()
      }}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-line" />
      {/* macOS: room for the native traffic lights (gone in full screen). */}
      {mac && !frame?.fullScreen && <span aria-hidden className="w-[76px] shrink-0" />}
      {/* Windows and Linux: the in-app menu bar (macOS has the native one). */}
      {frame && !mac && <MenuBar compact={!wide} />}
      <div className="relative flex shrink-0 items-center px-1.5">
        <Tooltip label={sidebarOpen ? 'Hide sessions' : 'Show sessions'} shortcut={sc('view.sidebar')}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle session sidebar"
            aria-controls="sidebar"
            aria-pressed={sidebarOpen}
            className={cn(iconBtn, sidebarOpen && 'text-fg')}
            onClick={() => useUi.getState().set({ sidebarOpen: !sidebarOpen })}
          >
            <PanelLeft />
          </Button>
        </Tooltip>
      </div>
      <div data-titlebar-drag className="min-w-0 flex-1" />
      <div className="relative flex shrink-0 items-center gap-0.5 px-1.5">
        {hasWs && (
          <>
            <Tooltip label="Split right" shortcut={sc('pane.splitRight')}>
              <Button variant="ghost" size="icon" aria-label="Split right" className={iconBtn} onClick={() => useUi.getState().split('row')}>
                <Columns2 />
              </Button>
            </Tooltip>
            <Tooltip label="Split down" shortcut={sc('pane.splitDown')}>
              <Button variant="ghost" size="icon" aria-label="Split down" className={iconBtn} onClick={() => useUi.getState().split('column')}>
                <Rows2 />
              </Button>
            </Tooltip>
          </>
        )}
        <Tooltip label="Go to session" shortcut={sc('session.switcher')}>
          <Button variant="ghost" size="icon" aria-label="Go to session" className={iconBtn} onClick={() => useUi.getState().set({ switcherOpen: true })}>
            <Plus />
          </Button>
        </Tooltip>
        <Tooltip label={aiOpen ? 'Hide assistant' : 'Show assistant'} shortcut={sc('ai.toggle')}>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Toggle assistant"
            aria-controls="ai"
            aria-pressed={aiOpen}
            className={cn('h-7 gap-1.5 px-2 [-webkit-app-region:no-drag]', aiOpen && 'bg-active text-fg')}
            onClick={() => useUi.getState().set({ aiOpen: !aiOpen })}
          >
            <PanelRight /> Assistant
          </Button>
        </Tooltip>
      </div>
      {!mac && frame && <WindowControls maximized={frame.maximized} />}
    </header>
  )
}

/** The window is at least `px` wide (inline menus or the compact ≡ button). */
function useWide(px: number): boolean {
  const q = `(min-width: ${px}px)`
  const [wide, setWide] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [q])
  return wide
}

/** The frame's platform and maximised / full-screen state (null until main answers). */
function useFrame(): FrameState | null {
  const [s, setS] = useState<FrameState | null>(null)
  useEffect(() => {
    const f = window.hopline.frame
    if (!f) return
    void f.state().then(setS)
    return f.onState(setS)
  }, [])
  return s
}

/** Windows and Linux: minimal minimise / maximise / close at the right end of the title bar. */
function WindowControls({ maximized }: { maximized: boolean }): React.JSX.Element {
  const btn =
    'relative flex h-full w-11 items-center justify-center text-fg-subtle transition-colors duration-[var(--dur-fast)] [-webkit-app-region:no-drag] hover:bg-hover hover:text-fg [&_svg]:size-3.5'
  return (
    <div className="flex shrink-0 items-stretch" role="group" aria-label="Window">
      <button type="button" tabIndex={-1} aria-label="Minimize" className={btn} onClick={() => void window.hopline.frame.minimize()}>
        <Minus />
      </button>
      <button type="button" tabIndex={-1} aria-label={maximized ? 'Restore' : 'Maximize'} className={btn} onClick={() => void window.hopline.frame.toggleMaximize()}>
        {maximized ? <Copy className="-scale-x-100" /> : <Square className="size-3!" />}
      </button>
      <button type="button" tabIndex={-1} aria-label="Close window" className={cn(btn, 'hover:bg-danger hover:text-white')} onClick={() => void window.hopline.frame.close()}>
        <X />
      </button>
    </div>
  )
}
