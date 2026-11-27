import type { KeyboardEvent, RefObject } from 'react'
import { Separator, type GroupImperativeHandle, type PanelImperativeHandle } from 'react-resizable-panels'
import { cn } from './cn'

/** Keyboard steps in pixels: an arrow nudges, Shift+arrow moves a lot (docs/ACCESSIBILITY.md). */
export const DIVIDER_STEP = { small: 16, large: 96 } as const

export type Layout = Record<string, number>

/**
 * The next layout for a keyboard press on the divider between `before` and `after` (percentages,
 * as react-resizable-panels keeps them), or null when the key is not a resize key. Arrows move the
 * divider in screen direction (Right/Down grows `before`); Home moves it to its start (`before` at
 * its minimum or collapsed), End to its end. The library clamps the result to each panel's limits.
 */
export function keyboardLayout(
  layout: Layout,
  key: string,
  shift: boolean,
  o: { before: string; after: string; horizontal: boolean; axisPx: number }
): Layout | null {
  const a = layout[o.before]
  const b = layout[o.after]
  if (a === undefined || b === undefined || o.axisPx <= 0) return null
  const [dec, inc] = o.horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  let delta: number
  if (key === inc || key === dec) {
    const pct = ((shift ? DIVIDER_STEP.large : DIVIDER_STEP.small) / o.axisPx) * 100
    delta = key === inc ? pct : -pct
  } else if (key === 'Home') delta = -a
  else if (key === 'End') delta = b
  else return null
  return { ...layout, [o.before]: a + delta, [o.after]: b - delta }
}

/**
 * The next pixel size of a side panel for a key on its divider, or null when the key is not a
 * resize key. Same model as `keyboardLayout`: the divider moves in screen direction, so a panel
 * after it shrinks on Right/Down; Home/End put the divider at its start/end (0 = collapse or
 * minimum, a huge value = the panel's maximum; the library clamps).
 */
export function panelKeyboardSize(px: number, key: string, shift: boolean, o: { side: 'before' | 'after'; horizontal: boolean }): number | null {
  const [dec, inc] = o.horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  const grow = o.side === 'before' ? 1 : -1
  const step = shift ? DIVIDER_STEP.large : DIVIDER_STEP.small
  if (key === inc) return px + grow * step
  if (key === dec) return px - grow * step
  const big = 100_000
  if (key === 'Home') return o.side === 'before' ? 0 : big
  if (key === 'End') return o.side === 'before' ? big : 0
  return null
}

/**
 * A resizable divider (window splitter): react-resizable-panels' Separator, which is already a
 * focusable `role="separator"` with `aria-valuenow` (the size of the panel before it, in percent),
 * plus our keyboard model: arrows by a small step, Shift+arrow by a large one, Home and End to
 * either end, Enter to collapse or restore the collapsible panel. Keys are taken in the capture
 * phase so the library's own fixed 5 % step never runs as well.
 */
export function Divider({
  label,
  group,
  before,
  after,
  horizontal,
  collapsible,
  onKeyboardResize,
  panel,
  panelSide = 'before',
  className,
  disabled,
  id
}: {
  /** "Resize session sidebar": what a screen reader announces. */
  label: string
  group: RefObject<GroupImperativeHandle | null>
  before: string
  after: string
  /** The group lays out left to right (the divider is a vertical line). */
  horizontal: boolean
  /** The panel Enter collapses and restores. */
  collapsible?: RefObject<PanelImperativeHandle | null>
  /** Resize this panel (pixels) instead of the group's layout: the sidebar, assistant, files and answer column. */
  panel?: RefObject<PanelImperativeHandle | null>
  /** Which side of the divider `panel` is on. */
  panelSide?: 'before' | 'after'
  /** Called with the layout a key produced (the library reports it as not user-made). */
  onKeyboardResize?: (layout: Layout) => void
  className?: string
  disabled?: boolean
  id?: string
}): React.JSX.Element {
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey) return
    const g = group.current
    if (!g) return
    if (e.key === 'Enter') {
      const p = collapsible?.current
      if (!p) return
      e.preventDefault()
      e.stopPropagation()
      if (p.isCollapsed()) p.expand()
      else p.collapse()
      onKeyboardResize?.(g.getLayout())
      return
    }
    const box = e.currentTarget.parentElement?.getBoundingClientRect()
    // A side panel with pixel limits resizes through its own handle (the group's setLayout does not
    // move pixel-sized panels); split panes, all percentages, through the group.
    const p = panel?.current
    if (p) {
      const px = panelKeyboardSize(p.getSize().inPixels, e.key, e.shiftKey, { side: panelSide, horizontal })
      if (px === null) return
      e.preventDefault()
      e.stopPropagation()
      if (px <= 0 && collapsible?.current === p) p.collapse()
      else {
        if (p.isCollapsed()) p.expand()
        p.resize(Math.max(1, px))
      }
      return
    }
    const next = keyboardLayout(g.getLayout(), e.key, e.shiftKey, { before, after, horizontal, axisPx: box ? (horizontal ? box.width : box.height) : 0 })
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    onKeyboardResize?.(g.setLayout(next))
  }
  return (
    <Separator
      id={id}
      aria-label={label}
      title={label}
      disabled={disabled}
      onDoubleClick={() => {
        const g = group.current
        if (!g || panel || disabled) return
        const sizes = g.getLayout()
        const half = ((sizes[before] ?? 0) + (sizes[after] ?? 0)) / 2
        onKeyboardResize?.(g.setLayout({ ...sizes, [before]: half, [after]: half }))
      }}
      onKeyDownCapture={onKeyDownCapture}
      className={cn('focus-visible:z-10 focus-visible:bg-accent', className)}
    />
  )
}
