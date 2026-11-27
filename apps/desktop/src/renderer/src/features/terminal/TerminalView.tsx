import { useDrafts } from '../ai/drafts'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { appendTerminalSelection } from '../workspace/store'
import { reportShellDirectory, useFiles } from '../files/store'
import { remoteDirectory } from '../files/terminal-directory'
import { fmtWhen } from '../../lib/when'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { ContextMenu as CM } from 'radix-ui'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, cn, Input, Tooltip } from '../../design'
import { ContextItem, menuContent, menuLabel, menuSeparator } from '../../design/Menu'
import { trySplit } from '../actions/builtin'
import { notifyError } from '../../lib/connect'
import { errorText } from '../../lib/errors'
import { AiPrefix, isBarePrompt, isSecretPrompt } from '../../lib/aiprefix'
import { readClipboard, writeClipboard } from '../../lib/clipboard'
import { askConfirm, requestClosePane } from '../../lib/confirm'
import { paneOfTab } from '../../lib/layout'
import { isLinkClick, openTerminalLink } from '../../lib/links'
import { cssVar } from '../../design/theme'
import { deviceKeyFor } from '../../lib/keys'
import { installCaret } from './caret'
import { ConnectionStrip, reconnectTab } from './ConnectionStrip'
import { dropSignals, useSignals, writeWithAlerts } from './liveness'
import { CommandHistory, TargetDialog } from './TranscriptTools'
import { installTargetLinks, selectionAsMarkdown, selectionAsTable, tableWidth } from './output-view'
import { StreamHighlighter, type NetworkTarget } from '../../lib/highlight'
import { terminals } from '../../lib/terminals'
import { cancelSave, queueSave, registerFlush } from '../../lib/save-queue'
import { sessionById, syncTabState, useUi, type Tab } from '../../store'
import { sessionSettings, useOverrides } from '../overrides/store'
import { useThemes } from '../themes/store'
import { TermAutocomplete } from './autocomplete-view'
import { BlockLayer, blockAtPoint } from '../blocks/BlockLayer'
import { useBlocks } from '../blocks/store'
import type { Block } from '../../lib/blocks'
import { BlockController } from '../blocks/controller'
import { TableView } from '../blocks/TableView'
import { BUNDLED_FONT, TERM_MIN_CONTRAST, terminalOptions, terminalTheme } from './theme'
import { useShortcutMap } from '../../lib/actions'
import { visibleSelection } from '../../lib/selection-lines'
import { AnnounceQueue, AnnounceScheduler, visibleText } from '../../lib/announce'
import { announce } from '../a11y/LiveRegion'
import { activeMention, suggestMentions, type MentionSuggestion } from '@shared/mentions'
import { askWithMentions, hasMentions } from '../fleet/mentions'
import { MentionList, mentionComplete, mentionKey } from '../fleet/MentionList'

/** How long a hidden terminal keeps its WebGL renderer before falling back to idle DOM rendering. */
const GL_RELEASE_MS = 5_000

/** One row of the terminal's context menu (design/Menu: the menu bar's look). */

/** Ask the assistant about the current selection. Handled by the AI panel. */
export function explainSelection(tabId: string, text: string): void {
  useUi.getState().set({ aiOpen: true })
  window.dispatchEvent(new CustomEvent('hopline:explain', { detail: { tabId, text } }))
}

/**
 * `active`: the terminal is on screen (its tab is shown). `focused`: it is the focused pane and
 * gets keyboard focus. Mounting and placement are owned by TerminalHost; see there.
 */
export function TerminalView({ tab, active, focused = active }: { tab: Tab; active: boolean; focused?: boolean }): React.JSX.Element {
  const sc = useShortcutMap()
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const wrap = useRef(false)
  const raw = useRef(false)
  const [wrapped, setWrapped] = useState(false)
  const [wide, setWide] = useState(0)
  const [blockTools, setBlockTools] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [target, setTarget] = useState<NetworkTarget | null>(null)
  const [pendingLines, setPendingLines] = useState<number | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const clearRef = useRef<() => void>(() => {})
  /** Find next / previous from the Edit menu: the open find bar's query, else open the bar. */
  const findStepRef = useRef<(dir: 'next' | 'prev') => void>(() => {})
  /** Load / drop the WebGL renderer (set once xterm is open). */
  const glRef = useRef<{ acquire: () => void; release: () => void } | null>(null)
  const activeRef = useRef(active)
  useLayoutEffect(() => { activeRef.current = active }, [active])
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  /** Search results from the addon: index is -1 when the active match is past the limit. */
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const [attachmentAt, setAttachmentAt] = useState<{ top: number; left: number } | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  // The command block under the right-click, for the context menu's block actions.
  const [menuBlock, setMenuBlock] = useState<Block | null>(null)
  // Command blocks (features/blocks): created once xterm is open.
  const [blocks, setBlocks] = useState<BlockController | null>(null)
  // "@ai … @dev" (F11): the device list under the "@ai" line while a mention is typed.
  const [mentionView, setMentionView] = useState<{ items: MentionSuggestion[]; index: number; pos: React.CSSProperties } | null>(null)
  const pickMentionRef = useRef<(i: number) => void>(() => {})

  useEffect(() => {
    let disposed = false
    let removeCaret = () => {}
    // Scrollback persistence: save when something changed, every 30 s and when the tab closes.
    let dirty = false
    /** The 30 s save: through the shared queue once the terminal is live (lib/save-queue). */
    let periodicSave = (): void => {}
    let highlighter: StreamHighlighter | null = null
    let autocomplete: TermAutocomplete | null = null
    let blockCtl: BlockController | null = null
    let webgl: WebglAddon | null = null
    let glFailed = false
    let srScheduler: AnnounceScheduler | null = null
    const term = new Terminal({
      ...terminalOptions(sessionSettings(tab.sessionId)),
      letterSpacing: 0,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      // OSC 8 hyperlinks: the device chooses the address, so ask in-app (never the native confirm()).
      linkHandler: { activate: (_e, uri) => void openTerminalLink(uri), allowNonHttpProtocols: false }
    })
    let joiner: number | null = null
    const updateLigatures = () => {
      if (!term.element) return
      const enabled = sessionSettings(tab.sessionId)?.termLigatures
      if (enabled && joiner === null) {
        joiner = term.registerCharacterJoiner((line) =>
          Array.from(line.matchAll(/===?|!==?|=>|->|<=|>=|&&|\|\|/g), (m) => [m.index, m.index + m[0].length])
        )
      } else if (!enabled && joiner !== null) {
        term.deregisterCharacterJoiner(joiner)
        joiner = null
      }
    }
    let folderTimer: ReturnType<typeof setTimeout> | undefined
    let latestFolder: string | null = null
    const folderReports = term.parser.registerOscHandler(7, (uri) => {
      const saved = sessionById(useUi.getState(), tab.sessionId)
      if (saved?.protocol !== 'ssh') return true
      const path = remoteDirectory(uri, saved.host)
      if (!path) return true
      latestFolder = path
      if (!folderTimer) folderTimer = setTimeout(() => {
        folderTimer = undefined
        if (latestFolder) reportShellDirectory(tab.tabId, latestFolder)
      }, 200)
      return true
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    // Plain URLs in output: Ctrl/Cmd+click, then the same in-app confirmation.
    term.loadAddon(new WebLinksAddon((e, uri) => isLinkClick(e) && void openTerminalLink(uri)))
    termRef.current = term
    let tableCols = 0
    let historyCols = 0
    const fitGrid = () => {
      if (!term.element || !host.current?.offsetWidth) return
      const dims = fit.proposeDimensions()
      const screen = term.element.querySelector<HTMLElement>('.xterm-screen')
      if (!dims || !screen || !screen.clientWidth) return
      const cellWidth = screen.getBoundingClientRect().width / term.cols
      // Reflow is synchronous in xterm. Keep deep scrollback at its existing width when a
      // dock opens. The same Wrap control lets the operator explicitly request a full reflow.
      if (term.buffer.active.type === 'normal' && term.buffer.active.length >= 25_000 && dims.cols < term.cols) historyCols = Math.max(historyCols, term.cols)
      const preserved = Math.max(tableCols, historyCols)
      const overflow = term.buffer.active.type === 'normal' && preserved > dims.cols
      const cols = overflow && !wrap.current ? preserved : dims.cols
      term.element.style.width = cols > dims.cols ? Math.ceil(cols * cellWidth + 16) + 'px' : ''
      if (term.cols !== cols || term.rows !== dims.rows) term.resize(cols, dims.rows)
      setWide(overflow ? preserved : 0)
    }
    fitRef.current = fitGrid
    searchRef.current = search
    search.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount }))

    term.onWriteParsed(() => (dirty = true))
    const saveScrollback = () => {
      if (!dirty || !useUi.getState().settings?.termRestoreScrollback || !term.element) return
      dirty = false
      const data = serialize.serialize({ scrollback: 5000 })
      return window.hopline.scrollback.save(tab.sessionId, data).catch(() => {})
    }
    // Main asks for an immediate save before the window closes or Hopline quits (review L8).
    const offFlush = registerFlush(tab.tabId, saveScrollback)
    // "Clear scrollback" also clears what is saved, so old history does not come back on reconnect.
    // term.clear() fires no write, so mark the buffer changed by hand.
    clearRef.current = () => {
      term.clear()
      tableCols = 0
      historyCols = 0
      fitRef.current?.()
      if (useUi.getState().settings?.termRestoreScrollback) {
        dirty = true
        saveScrollback()
      } else void window.hopline.scrollback.clear(tab.sessionId).catch(() => {})
    }
    const el = host.current!
    // Measure with the real font, not the fallback.
    void document.fonts.load(`13px ${BUNDLED_FONT}`).finally(async () => {
      if (disposed) return
      term.open(el)
      el.dataset.renderer = 'dom'
      // WebGL only while the terminal is on screen (see the [active] effect): Chromium allows 16
      // live WebGL contexts, so the 17th tab used to make the oldest one lose its context, and every
      // hidden tab kept a glyph atlas and GPU buffers for nothing (bench: 20 tabs).
      glRef.current = {
        acquire: () => {
          if (webgl || disposed || glFailed) return
          // Benchmarks (e2e builds only) can force the DOM renderer to measure the fallback path.
          if (window.hopline.testMode && localStorage.getItem('hopline:bench:renderer') === 'dom') return
          try {
            const addon = new WebglAddon()
            addon.onContextLoss(() => {
              if (webgl === addon) {
                webgl = null
                el.dataset.renderer = 'dom'
              }
              addon.dispose()
            })
            term.loadAddon(addon)
            webgl = addon
            el.dataset.renderer = 'webgl'
          } catch {
            // No WebGL (e.g. software rendering): xterm falls back to the DOM renderer.
            glFailed = true
          }
        },
        release: () => {
          const addon = webgl
          webgl = null
          el.dataset.renderer = 'dom'
          addon?.dispose()
        }
      }
      removeCaret = installCaret(term, () => !!sessionSettings(tab.sessionId)?.termSmoothCaret)
      updateLigatures()
      if (activeRef.current) glRef.current.acquire()
      fit.fit()
      let queuedFit = false
      term.onRender(({ start, end }) => {
        const width = tableWidth(term, start, end, tableCols)
        if (width <= tableCols) return
        tableCols = width
        if (queuedFit) return
        queuedFit = true
        queueMicrotask(() => { queuedFit = false; if (!disposed) fitGrid() })
      })
      term.buffer.onBufferChange(fitGrid)
      installTargetLinks(term, setTarget)
      let away = false
      let incoming = 0
      term.onLineFeed(() => { if (away) incoming++ })
      const scrollPosition = () => {
        const buf = term.buffer.active
        const scrolled = buf.type === 'normal' && buf.viewportY < buf.baseY
        if (!scrolled) incoming = 0
        if (scrolled || away) setPendingLines(scrolled ? incoming : null)
        away = scrolled
      }
      term.onScroll(scrollPosition)
      let deepHistory = false
      term.onWriteParsed(() => {
        scrollPosition()
        const deep = term.buffer.active.length >= 25_000
        if (deep !== deepHistory) {
          deepHistory = deep
          el.toggleAttribute('data-deep-history', deep)
        }
      })

      // Screen reader mode (docs/ACCESSIBILITY.md): new complete lines of the active tab are queued
      // and spoken through the app's polite live region, at most once a second, summarised when long.
      // xterm's own live region is assertive and unthrottled: it is muted whenever it exists.
      const muteXtermLiveRegion = () => {
        for (const r of el.querySelectorAll('.xterm-accessibility .live-region')) {
          r.setAttribute('aria-live', 'off')
          r.setAttribute('aria-hidden', 'true')
        }
      }
      const srQueue = new AnnounceQueue()
      const srAllowed = () => {
        const st = useUi.getState()
        return !!st.settings?.termScreenReader && st.activeTabId === tab.tabId && term.buffer.active.type === 'normal'
      }
      srScheduler = new AnnounceScheduler(srQueue, announce, undefined, undefined, srAllowed)
      const cursorRow = () => term.buffer.active.baseY + term.buffer.active.cursorY
      let announcedTo = cursorRow()
      term.onWriteParsed(() => {
        const cur = cursorRow()
        if (!srAllowed()) {
          announcedTo = cur
          srQueue.clear()
          return
        }
        muteXtermLiveRegion()
        if (cur < announcedTo) announcedTo = cur // cleared, or scrolled out of the scrollback
        const lines: string[] = []
        // As shown: concealed (SGR 8) cells are spoken as blanks (lib/announce › visibleText).
        for (let y = announcedTo; y < cur; y++) lines.push(visibleText(term.buffer.active.getLine(y)))
        announcedTo = cur
        srQueue.setPartial(visibleText(term.buffer.active.getLine(cur)))
        if (lines.length) {
          srQueue.push(lines)
          srScheduler?.kick()
        }
      })
      muteXtermLiveRegion()

      const ctl = new BlockController(term, tab.tabId, tab.sessionId, () => sessionById(useUi.getState(), tab.sessionId)?.platform ?? 'auto')
      blockCtl = ctl
      term.onWriteParsed(() => ctl.written())
      setBlocks(ctl)
      const hl = new StreamHighlighter((s) => writeWithAlerts(term, tab.tabId, s), () => !raw.current && (sessionSettings(tab.sessionId)?.termHighlight ?? true))
      highlighter = hl
      // When the device last wrote, and when we last sent it a key (for the fresh-prompt check below).
      let lastKeyAt = 0
      let lastOutputAt = 0
      let ac: TermAutocomplete | null = null
      terminals.set(tab.tabId, {
        term,
        focus: () => term.focus(),
        openFind: () => setFindOpen(true),
        findStep: (dir) => findStepRef.current(dir),
        clear: () => clearRef.current(),
        paste: (text, o) => paste(text, o),
        write: (d) => {
          lastOutputAt = performance.now()
          ac?.output(d)
          hl.push(d)
        },
        ghost: () => ({ text: ac?.ghost ?? '', latencies: ac?.latencies ?? [], work: ac?.work ?? [], live: ac?.harvest.values ?? {} }),
        blocks: ctl,
        renderer: () => (webgl ? 'webgl' : 'dom')
      })
      // "@ai <question>" typed at the prompt goes to the assistant, not the device. The prefix is
      // held locally until it is resolved (see lib/aiprefix), so no keystroke races its echo.
      const aiColor = () => {
        const hex = cssVar('--c-accent').replace('#', '')
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
        return Number.isNaN(r) ? '\x1b[36m' : `\x1b[38;2;${r};${g};${b}m`
      }
      const ai = new AiPrefix((s) => aiColor() + s + '\x1b[0m')
      /** Text before the cursor on its line. */
      const beforeCursor = () => {
        const b = term.buffer.active
        return b.getLine(b.cursorY + b.viewportY)?.translateToString(true, 0, b.cursorX) ?? ''
      }
      // Mention autocomplete inside the "@ai" capture: the list follows what is typed after "@".
      // Accepting types backspaces and the name through `input` (still the capture: nothing reaches the device).
      let mention: { start: number; query: string; items: MentionSuggestion[]; index: number } | null = null
      let mentionClosed: number | null = null
      const showMention = () => {
        const cap = ai.capture
        const a = cap === null ? null : activeMention(cap)
        if (!a) mentionClosed = null
        if (!a || cap === null || mentionClosed === a.start) {
          if (mention) setMentionView((mention = null))
          return
        }
        const st = useUi.getState()
        const items = suggestMentions(a.query, { sessions: st.sessions, folders: st.folders })
        mention = { start: a.start, query: a.query, items, index: 0 }
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
        const outer = host.current?.parentElement
        if (!screen || !outer || !term.cols || !term.rows) return
        const sr = screen.getBoundingClientRect()
        const or = outer.getBoundingClientRect()
        const cw = sr.width / term.cols
        const ch = sr.height / term.rows
        const b = term.buffer.active
        const col = Math.max(0, b.cursorX - (cap.length - a.start))
        const left = Math.max(0, Math.min(sr.left - or.left + col * cw, or.width - 320))
        const below = b.cursorY + 1 + Math.min(items.length, 8) + 2 <= term.rows
        const pos: React.CSSProperties = below ? { position: 'absolute', left, top: sr.top - or.top + (b.cursorY + 1) * ch + 2 } : { position: 'absolute', left, bottom: or.bottom - (sr.top + b.cursorY * ch) + 2 }
        setMentionView({ items, index: 0, pos })
      }
      const moveMention = (index: number) => {
        if (!mention) return
        mention.index = index
        setMentionView((v) => (v ? { ...v, index } : v))
      }
      pickMentionRef.current = (i: number) => {
        const item = mention?.items[i]
        if (!mention || !item || ai.capture === null) return
        const typed = ai.capture.length - mention.start - 1
        input('\x7f'.repeat(typed) + item.insert.slice(1))
      }
      /** A key the list used on keydown: its keypress (Enter's "\r") must not reach xterm either. */
      let swallow: string | null = null
      const input = (d: string) => {
        const before = beforeCursor()
        const lineBefore = ai.busy ? null : ai.line
        const o = ai.input(d, {
          mayHold: !isSecretPrompt(before),
          // Only trusted when the screen is current: device output after our last keystroke.
          atLineStart: () => lastOutputAt > lastKeyAt && isBarePrompt(before)
        })
        if (o.echo) term.write(o.echo, showMention)
        else if (mention && ai.capture === null) showMention()
        if (o.send) {
          lastKeyAt = performance.now()
          ctl.sent(o.send)
          window.hopline.term.write(tab.tabId, o.send)
        }
        for (const q of o.ask) {
          // Device mentions: the fleet view with this tab's session and the mentioned ones (nothing starts).
          if (hasMentions(q)) {
            void askWithMentions(tab.tabId, q)
            continue
          }
          useUi.getState().set({ aiOpen: true })
          window.dispatchEvent(new CustomEvent('hopline:ask', { detail: { tabId: tab.tabId, text: q } }))
        }
        ac?.sent(d, lineBefore)
      }
      term.onData(input)
      // Autocomplete: ghost text and hints at the device prompt (features/terminal/autocomplete-view).
      ac = new TermAutocomplete(term, {
        platform: () => {
          const s = sessionById(useUi.getState(), tab.sessionId)
          return s && s.platform !== 'auto' ? s.platform : null
        },
        enabled: () => sessionSettings(tab.sessionId)?.termAutocomplete !== false,
        blocked: () => ai.busy || !!useUi.getState().tabs.find((t) => t.tabId === tab.tabId)?.agentBusy,
        line: () => (ai.busy ? null : ai.line),
        setLine: (line) => ai.syncDeviceLine(line),
        type: input
      })
      autocomplete = ac
      term.onWriteParsed(() => ac?.parsed())
      term.onScroll(() => ac?.refresh())
      term.onResize(() => ac?.refresh())
      // After arrows/Tab the line is unknown; a fresh, empty prompt from the device (output that
      // arrived after our last keystroke) makes it known again, so "@ai" works on the next line.
      term.onWriteParsed(() => {
        if (ai.line === null && lastOutputAt > lastKeyAt && isBarePrompt(beforeCursor())) ai.promptSeen()
      })
      term.onResize(({ cols, rows }) => window.hopline.term.resize(tab.tabId, cols, rows))
      term.onSelectionChange(() => {
        const sel = term.getSelection()
        setHasSelection(!!sel)
        const end = term.getSelectionPosition()?.end
        const grid = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
        const pane = host.current?.parentElement?.getBoundingClientRect()
        const y = end && end.y - term.buffer.active.viewportY
        if (sel && end && grid && pane && y !== undefined && y >= 0 && y < term.rows) {
          setAttachmentAt({
            left: Math.max(4, Math.min(pane.width - 72, grid.left - pane.left + end.x * grid.width / term.cols)),
            top: Math.max(4, Math.min(pane.height - 28, grid.top - pane.top + (y + 1) * grid.height / term.rows))
          })
        } else setAttachmentAt(null)
        if (sel) void writeClipboard(sel) // copy-on-select
      })
      // Shortcuts that belong to the app, not the device.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const live = useUi.getState().tabs.find((t) => t.tabId === tab.tabId)
          if (live && (live.state === 'down' || (live.state === 'reconnecting' && useSignals.getState()[tab.tabId]?.vitals?.retryAt))) {
            e.preventDefault()
            reconnectTab(live)
            return false
          }
        }
        // Keys xterm does not translate (Ctrl+Shift+6 = Ctrl+^): straight to the device on keydown, even
        // during an "@ai" capture, without touching the line tracking; keypress/keyup are swallowed.
        const seq = deviceKeyFor(e)
        if (seq !== undefined) {
          if (e.type === 'keydown') {
            e.preventDefault()
            ctl.sent(seq)
            window.hopline.term.write(tab.tabId, seq)
          }
          return false
        }
        if (swallow !== null && e.type !== 'keydown' && e.key === swallow) {
          if (e.type === 'keyup') swallow = null
          return false
        }
        // The mention list (inside an "@ai" capture): ↑↓ choose, Tab/Enter insert, Esc closes the list only.
        if (mention && ai.capture !== null && e.type === 'keydown') {
          const k = mentionKey(e, mention.index, mention.items.length, mentionComplete(mention.query, mention.items))
          if (k !== null) {
            e.preventDefault()
            swallow = e.key
            if (k === 'pick') pickMentionRef.current(mention.index)
            else if (k === 'close') {
              mentionClosed = mention.start
              setMentionView((mention = null))
            } else moveMention(k)
            return false
          }
        }
        if (e.type !== 'keydown') return true
        // → / End accept the ghost text (only while one is shown; otherwise they go to the device).
        if (ac?.keydown(e)) return false
        const mod = e.ctrlKey && e.shiftKey
        if (mod && e.code === 'KeyC') {
          void writeClipboard(term.getSelection())
          return false
        }
        if (mod && e.code === 'KeyV') {
          void readClipboard().then((t) => paste(t))
          return false
        }
        return true
      })
      term.focus()

      // Credentials are resolved in main; anything missing (password, passphrase, MFA) is asked
      // for by the session host through the prompt dialog, only when the device wants it.
      // Show this session's previous history (encrypted at rest) above the new connection.
      // The tab may close during any of these awaits: then never open the connection, or it would
      // stay alive with no terminal to show it.
      if (useUi.getState().settings?.termRestoreScrollback) {
        const saved = await window.hopline.scrollback.load(tab.sessionId).catch(() => null)
        if (disposed) return
        if (saved?.data) {
          await new Promise<void>((r) => term.write(saved.data, r))
          if (disposed) return
          const when = fmtWhen(saved.savedAt)
          await new Promise<void>((r) => term.write(`\x1b[0m\r\n\x1b[2mrestored history from ${when}\x1b[0m\r\n`, r))
          if (disposed) return
          const marker = term.registerMarker(-1)
          if (marker) {
            const decoration = term.registerDecoration({ marker, layer: 'top' })
            decoration?.onRender((chip) => {
              chip.classList.add('history-chip')
              chip.textContent = 'Restored · ' + when
              chip.title = new Date(saved.savedAt).toLocaleString()
            })
            const shade = () => {
              const rows = Math.max(0, Math.min(term.rows, marker.line - term.buffer.active.viewportY))
              el.style.setProperty('--history-height', (rows / term.rows * 100) + '%')
            }
            term.onRender(shade)
            shade()
          }
        }
      }
      if (disposed) return
      ctl.live = true
      dirty = false
      periodicSave = () => queueSave(tab.tabId, saveScrollback, () => performance.now() - lastOutputAt < 1000)
      try {
        const info = await window.hopline.term.open(tab.tabId, tab.sessionId, term.cols, term.rows)
        // Closed while opening: the close went out before the open landed, so close again.
        if (disposed) return void window.hopline.term.close(tab.tabId).catch(() => {})
        syncTabState(info)
      } catch (e) {
        // Some failures happen before the host can emit a connection-state event.
        if (disposed) return
        useUi.getState().updateTab({ tabId: tab.tabId, state: 'down', detail: errorText(e) })
        notifyError(`Could not open ${tab.title}`, e)
      }
    })

    const paste = (text: string, o?: { confirm?: boolean }) => {
      if (!text) return
      const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => l || i < a.length - 1)
      // Edit › Paste to device… always shows what is about to be sent, even one line.
      if (lines.length < 2 && !o?.confirm) return void term.paste(text)
      // Several lines run as several commands on a device: ask first, in-app (Enter pastes, Esc cancels).
      const preview = lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… ${lines.length - 8} more` : '')
      void askConfirm(`Paste ${lines.length === 1 ? 'a line' : `${lines.length} lines`} into ${tab.title}?`, lines.length > 1 ? 'Each line is sent as a command.' : /[\r\n]$/.test(text) ? 'It is sent as a command.' : 'It is typed at the prompt; nothing runs until you press Enter.', 'Paste', { tone: 'primary', preview }).then((ok) => {
        if (ok && !disposed) term.paste(text)
      })
    }
    // Intercept native paste (Ctrl+V on some platforms, middle click) to confirm multi-line pastes.
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      paste(e.clipboardData?.getData('text/plain') ?? '')
    }
    el.addEventListener('paste', onPaste, true)

    // Layout: fit at most every 100 ms (trailing), so dragging a divider or a panel transition
    // does not send the device a resize storm; the last call lands after the layout settles.
    let fitTimer = 0
    let lastFit = 0
    const fitNow = () => {
      fitTimer = 0
      lastFit = performance.now()
      if (el.offsetParent !== null) fitGrid()
    }
    const ro = new ResizeObserver(() => {
      if (fitTimer) return
      fitTimer = window.setTimeout(fitNow, Math.max(0, 100 - (performance.now() - lastFit)))
    })
    ro.observe(el)
    // The padding around the grid takes the terminal theme's background too.
    const paintBg = () => {
      const bg = term.options.theme?.background ?? ''
      el.style.background = bg
      // The active tab and empty panes join the pane below in whatever colour it really paints.
      // Only the focused terminal sets it: with per-host themes, tabs paint different colours.
      const focusedTab = useUi.getState().activeTabId
      if (focusedTab && focusedTab !== tab.tabId) return
      if (bg) document.documentElement.style.setProperty('--term-paint', bg)
      else document.documentElement.style.removeProperty('--term-paint')
    }
    paintBg()
    const onTheme = () => {
      const theme = terminalTheme(sessionSettings(tab.sessionId)?.termTheme)
      term.options.theme = theme
      term.options.minimumContrastRatio = TERM_MIN_CONTRAST
      paintBg()
    }
    // Font, cursor, scrollback and theme apply live when settings change.
    // So do a session's or folder's overrides, custom themes, and a move to another folder.
    const reapply = () => {
      const st = sessionSettings(tab.sessionId)
      if (!st) return
      Object.assign(term.options, terminalOptions(st))
      updateLigatures()
      // Turning screen reader mode on creates xterm's live region: mute it (we announce instead).
      for (const r of el.querySelectorAll('.xterm-accessibility .live-region')) {
        r.setAttribute('aria-live', 'off')
        r.setAttribute('aria-hidden', 'true')
      }
      paintBg()
      if (term.element) fitRef.current?.()
    }
    const unsubUi = useUi.subscribe((st, prev) => {
      if (st.settings !== prev.settings || st.folders !== prev.folders || st.sessions !== prev.sessions) reapply()
      else if (st.activeTabId !== prev.activeTabId && st.activeTabId === tab.tabId) paintBg()
      if (st.settings !== prev.settings || st.tabs !== prev.tabs) autocomplete?.refresh()
    })
    const unsubOverrides = useOverrides.subscribe(reapply)
    const unsubThemes = useThemes.subscribe(reapply)
    const motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
    motionQuery.addEventListener('change', reapply)
    window.addEventListener('hopline:theme', onTheme)
    // Benchmarks (e2e builds only): run the periodic scrollback save now.
    const saveTimer = setInterval(() => periodicSave(), 30_000)
    const onBenchSave = () => periodicSave()
    if (window.hopline.testMode) window.addEventListener('hopline:bench:save-scrollback', onBenchSave)
    ;(el as HTMLDivElement & { __paste?: (t: string) => void }).__paste = paste

    return () => {
      disposed = true
      removeCaret()
      autocomplete?.dispose()
      blockCtl?.dispose()
      srScheduler?.dispose()
      clearInterval(saveTimer)
      cancelSave(tab.tabId)
      offFlush()
      saveScrollback()
      clearTimeout(fitTimer)
      ro.disconnect()
      el.removeEventListener('paste', onPaste, true)
      motionQuery.removeEventListener('change', reapply)
      window.removeEventListener('hopline:theme', onTheme)
      window.removeEventListener('hopline:bench:save-scrollback', onBenchSave)
      unsubUi()
      unsubOverrides()
      unsubThemes()
      terminals.delete(tab.tabId)
      dropSignals(tab.tabId)
      highlighter?.flush()
      glRef.current = null
      folderReports.dispose()
      clearTimeout(folderTimer)
      if (!useUi.getState().tabs.some((t) => t.tabId === tab.tabId)) useFiles.setState((s) => {
        if (!s.byTab[tab.tabId]) return s
        const byTab = { ...s.byTab }
        delete byTab[tab.tabId]
        return { byTab }
      })
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId])

  // A hidden terminal gives its WebGL context back after a while (quick tab switches keep it).
  useEffect(() => {
    if (active) return void glRef.current?.acquire()
    const t = window.setTimeout(() => glRef.current?.release(), GL_RELEASE_MS)
    return () => clearTimeout(t)
  }, [active])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      fitRef.current?.()
      if (focused) termRef.current?.focus()
    })
  }, [active, focused])

  const find = (dir: 'next' | 'prev', q = query, o: { caseSensitive: boolean; regex: boolean; incremental?: boolean } = { caseSensitive, regex }) => {
    const s = searchRef.current
    if (!s) return
    if (!q) {
      s.clearDecorations()
      setResults(null)
      return
    }
    // Decorations are what make the addon report result counts.
    const opts = { ...o, decorations: { matchOverviewRuler: '#3dd6bd', activeMatchColorOverviewRuler: '#3dd6bd', activeMatchBackground: '#3dd6bd66', matchBackground: '#3dd6bd22' } }
    try {
      if (dir === 'next') s.findNext(q, opts)
      else s.findPrevious(q, opts)
    } catch {
      setResults({ index: -1, count: 0 }) // an unfinished regex
    }
  }
  useLayoutEffect(() => {
    findStepRef.current = (dir) => (findOpen && query ? find(dir) : setFindOpen(true))
  })
  const closeFind = () => {
    setFindOpen(false)
    setResults(null)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }
  const noMatch = !!query && results?.count === 0
  const counter = !query || !results ? '' : results.count === 0 ? 'No results' : results.index < 0 ? `${results.count}+ matches` : `${results.index + 1} of ${results.count}`
  /** The pane this terminal is in (a right-click acts on it, not on the focused one). */
  const paneHere = () => {
    const ws = useUi.getState().workspaces.find((w) => paneOfTab(w.root, tab.tabId))
    return ws ? paneOfTab(ws.root, tab.tabId)?.id : undefined
  }
  const pasteFromMenu = async () => {
    const t = await readClipboard()
    ;(host.current as (HTMLDivElement & { __paste?: (t: string) => void }) | null)?.__paste?.(t)
  }

  const toggleWrap = () => {
    wrap.current = !wrap.current
    setWrapped(wrap.current)
    fitRef.current?.()
  }
  return (
    <div className="relative h-full w-full bg-term" style={{ display: active ? 'block' : 'none' }}>
      {mentionView && active && <MentionList id={`term-mentions-${tab.tabId}`} items={mentionView.items} index={mentionView.index} onPick={(i) => pickMentionRef.current(i)} style={mentionView.pos} />}
      <CM.Root modal={false}>
        <CM.Trigger asChild>
          <div ref={host} onContextMenu={(e) => setMenuBlock(blocks ? (blockAtPoint(blocks, e.clientY) ?? null) : null)} className="terminal-grid absolute inset-x-0 bottom-0 top-7 overflow-x-auto overflow-y-hidden py-1.5 pl-2.5" />
        </CM.Trigger>
        <CM.Portal>
          <CM.Content className={menuContent}>
            <ContextItem label="Copy" keys="Mod+C" disabled={!hasSelection} onSelect={() => void writeClipboard(termRef.current?.getSelection() ?? '')} />
            <ContextItem label="Copy as table" disabled={!hasSelection} onSelect={() => void writeClipboard(selectionAsTable(termRef.current?.getSelection() ?? ''))} />
            <ContextItem label="Copy as Markdown" disabled={!hasSelection} onSelect={() => void writeClipboard(selectionAsMarkdown(termRef.current?.getSelection() ?? ''))} />
            <ContextItem label="Paste" keys="Mod+V" onSelect={() => void pasteFromMenu()} />
            <ContextItem label="Paste to device…" keys={sc('edit.pasteToDevice')} onSelect={() => void readClipboard().then((t) => terminals.get(tab.tabId)?.paste?.(t, { confirm: true }))} />
            <ContextItem label="Select all" keys={sc('edit.selectAll')} onSelect={() => termRef.current?.selectAll()} />
            <CM.Separator className={menuSeparator} />
            <ContextItem label={blockTools ? 'Hide command block tools' : 'Show command block tools'} onSelect={() => setBlockTools(!blockTools)} />
            <ContextItem label="Command blocks…" onSelect={() => setHistoryOpen(true)} />
            <ContextItem label={raw.current ? 'Use semantic colors' : 'Use raw device colors'} onSelect={() => { raw.current = !raw.current }} />
            <ContextItem label={wrapped ? 'Preserve table columns' : 'Wrap output to pane'} onSelect={toggleWrap} />
            <ContextItem label="Find…" keys={sc('terminal.find') ?? 'Mod+F'} onSelect={() => setFindOpen(true)} />
            <ContextItem label="Clear scrollback" keys={sc('terminal.clear')} onSelect={() => clearRef.current()} />
            <CM.Separator className={menuSeparator} />
            <ContextItem label="Add selection to scratchpad" disabled={!hasSelection} onSelect={() => appendTerminalSelection(tab.tabId)} />
            <ContextItem label="Explain selection" disabled={!hasSelection} onSelect={() => explainSelection(tab.tabId, termRef.current ? visibleSelection(termRef.current) : '')} />
            {blocks && menuBlock && (
              <>
                <CM.Separator className={menuSeparator} />
                <CM.Label className={cn(menuLabel, 'font-mono')}>{menuBlock.command}</CM.Label>
                <ContextItem label="Copy output" keys={sc('blocks.copyOutput')} onSelect={() => void blocks.copyOutput(menuBlock)} />
                <ContextItem label="Copy command" keys={sc('blocks.copyCommand')} onSelect={() => void blocks.copyCommand(menuBlock)} />
                <ContextItem label="Copy for ticket" keys={sc('blocks.copyReport')} onSelect={() => void blocks.copyForTicket(menuBlock)} />
                {useBlocks.getState().parsed[tab.tabId]?.[menuBlock.id] && <ContextItem label="Show as table" keys={sc('blocks.table')} onSelect={() => blocks.openTable(menuBlock)} />}
                <ContextItem label="Re-run" keys={sc('blocks.rerun')} onSelect={() => void blocks.rerun(menuBlock)} />
                <ContextItem label="Ask AI about this block" onSelect={() => blocks.ask(menuBlock)} />
              </>
            )}
            <CM.Separator className={menuSeparator} />
            <ContextItem
              label="Split right"
              keys={sc('pane.splitRight')}
              onSelect={() => {
                const p = paneHere()
                if (p) useUi.getState().focusPane(p)
                trySplit('row')
              }}
            />
            <ContextItem
              label="Split down"
              keys={sc('pane.splitDown')}
              onSelect={() => {
                const p = paneHere()
                if (p) useUi.getState().focusPane(p)
                trySplit('column')
              }}
            />
            <ContextItem
              label="Close pane"
              keys={sc('pane.close')}
              onSelect={() => {
                const p = paneHere()
                if (p) void requestClosePane(p)
              }}
            />
          </CM.Content>
        </CM.Portal>
      </CM.Root>

      {hasSelection && attachmentAt && <button className="terminal-pill absolute z-10" style={attachmentAt}
        onPointerDown={(e) => e.preventDefault()} onClick={() => {
          const term = termRef.current
          if (!term?.hasSelection()) return
          const selection = visibleSelection(term)
          useDrafts.getState().edit(tab.tabId, { attachment: { label: 'Selected terminal output', selection } })
          useUi.getState().activate(tab.tabId)
          useUi.getState().set({ aiOpen: true })
        }}>Attach</button>}
      {target && termRef.current && <TargetDialog term={termRef.current} target={target} close={() => setTarget(null)} ask={(t) => explainSelection(tab.tabId, t)} />}
      {historyOpen && blocks && <CommandHistory ctl={blocks} close={() => setHistoryOpen(false)} />}
      {wide > 0 && <button className="terminal-pill absolute bottom-3 left-3" aria-pressed={!wrapped} onClick={toggleWrap} title={wrapped ? 'Scroll horizontally to preserve columns' : 'Wrap output to the pane width'}>
        {wrapped ? 'Fit columns' : wide + ' columns · Wrap'}
      </button>}
      {pendingLines !== null && <button className="terminal-pill absolute bottom-3 right-3" onClick={() => { termRef.current?.scrollToBottom(); termRef.current?.focus() }}>
        Jump to bottom{pendingLines > 0 && ' · ' + pendingLines + ' new'}
      </button>}
      {blockTools && blocks && <BlockLayer ctl={blocks} />}
      {blocks && <TableView ctl={blocks} />}

      <ConnectionStrip tab={tab} focused={focused} visible={active} />

      {findOpen && (
        <div role="search" aria-label="Find in scrollback" className="absolute right-4 top-2 z-10 flex items-center gap-0.5 rounded-lg bg-overlay p-1 shadow-overlay animate-pop-in">
          <Input
            autoFocus
            value={query}
            placeholder="Find in scrollback"
            aria-label="Find in scrollback"
            aria-invalid={noMatch || undefined}
            className="h-6 w-52"
            onChange={(e) => {
              setQuery(e.target.value)
              find('next', e.target.value, { caseSensitive, regex, incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') closeFind()
            }}
          />
          <span aria-live="polite" className={cn('w-20 shrink-0 px-1.5 text-right text-2xs tabular-nums', noMatch ? 'text-danger' : 'text-fg-subtle')}>
            {counter}
          </span>
          {(
            [
              ['Match case', 'Aa', caseSensitive, () => (setCaseSensitive(!caseSensitive), find('next', query, { caseSensitive: !caseSensitive, regex }))],
              ['Regular expression', '.*', regex, () => (setRegex(!regex), find('next', query, { caseSensitive, regex: !regex }))]
            ] as const
          ).map(([label, glyph, on, toggle]) => (
            <Tooltip key={label} label={label}>
              <button
                type="button"
                aria-label={label}
                aria-pressed={on}
                onClick={toggle}
                className={cn(
                  'flex size-6 items-center justify-center rounded-md font-mono text-2xs transition-colors duration-[var(--dur-fast)]',
                  on ? 'bg-accent-soft text-accent' : 'text-fg-subtle hover:bg-hover hover:text-fg'
                )}
              >
                {glyph}
              </button>
            </Tooltip>
          ))}
          <Button variant="ghost" size="icon-sm" aria-label="Previous match" onClick={() => find('prev')}>
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next match" onClick={() => find('next')}>
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={closeFind}>
            <X />
          </Button>
        </div>
      )}
    </div>
  )
}
