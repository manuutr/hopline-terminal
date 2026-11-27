import type { Terminal } from '@xterm/xterm'
import { reducedMotion } from '../../design/theme'

/** The WebGL and DOM renderers share one composited caret for the normal, focused bar cursor. */
export function installCaret(term: Terminal, smooth: () => boolean) {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return () => {}
  // xterm exposes the position publicly. Its DEC visibility flags are renderer internals in v6.
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden: boolean; isCursorInitialized: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } } } })._core?.coreService
  if (!core) return () => {}
  const caret = document.createElement('span')
  caret.className = 'terminal-caret'
  caret.setAttribute('aria-hidden', 'true')
  screen.append(caret)
  let width = screen.clientWidth
  let height = screen.clientHeight
  const bounds = new ResizeObserver(([entry]) => {
    if (!entry) return
    width = entry.contentRect.width
    height = entry.contentRect.height
    draw()
  })
  let ink: string | undefined
  let replaced = false
  const draw = () => {
    const buf = term.buffer.active
    const y = buf.baseY + buf.cursorY - buf.viewportY
    const theme = term.options.theme
    if (!theme) return
    const visible = document.activeElement === term.textarea && core.isCursorInitialized && !core.isCursorHidden && y >= 0 && y < term.rows
    const bar = (core.decPrivateModes.cursorStyle ?? term.options.cursorStyle) === 'bar'
    const blink = core.decPrivateModes.cursorBlink ?? term.options.cursorBlink
    const useCaret = visible && bar && !!blink && !reducedMotion() && buf.type === 'normal'
    caret.hidden = !useCaret
    if (!useCaret) {
      if (replaced && theme.cursor === theme.background) term.options.theme = { ...theme, cursor: ink }
      replaced = false
      return
    }
    if (!replaced || theme.cursor !== theme.background) {
      ink = theme.cursor ?? theme.foreground
      replaced = true
      term.options.theme = { ...theme, cursor: theme.background }
      caret.style.backgroundColor = ink ?? 'currentColor'
    }
    const h = height / term.rows
    caret.style.height = h + 'px'
    caret.style.transform = `translate(${Math.min(term.cols - 1, buf.cursorX) * width / term.cols}px,${y * h}px)`
    caret.dataset.smooth = String(smooth())
  }
  bounds.observe(screen)
  const sub = term.onRender(draw)
  return () => { bounds.disconnect(); sub.dispose(); caret.remove() }
}
