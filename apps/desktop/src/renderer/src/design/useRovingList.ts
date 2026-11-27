import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One keyboard model for every list (round 2): backup versions, multi results, the snippet list and
 * the target picker. Spread `listProps` on the role=listbox container and `optionProps(i)` on each
 * row (role=option). Roving tabindex: the list is one Tab stop and focus follows the active row.
 *
 *   ↑/↓ move · Home/End · PageUp/PageDown (10) · Enter → onEnter · Space → onSpace (else onEnter)
 *
 * Rows are addressed by index; keep `count` in sync with what you render. Define row components at
 * module scope: a component declared inside render re-mounts on every state change and drops focus.
 */
export function useRovingList(opts: {
  count: number
  /** Controlled active index; omit to let the hook own it. */
  active?: number
  onActiveChange?: (i: number) => void
  onEnter?: (i: number, e: React.KeyboardEvent) => void
  onSpace?: (i: number, e: React.KeyboardEvent) => void
}): {
  active: number
  setActive: (i: number, focus?: boolean) => void
  focus: (i?: number) => void
  listProps: { role: 'listbox'; onKeyDown: (e: React.KeyboardEvent) => void }
  optionProps: (i: number) => { role: 'option'; tabIndex: number; 'data-roving': number; ref: (el: HTMLElement | null) => void; onFocus: () => void }
} {
  const [own, setOwn] = useState(0)
  const active = opts.count <= 0 ? 0 : Math.max(0, Math.min(opts.count - 1, opts.active ?? own))
  const els = useRef(new Map<number, HTMLElement>())
  const o = useRef(opts)
  o.current = opts

  const show = (i: number) => {
    const el = els.current.get(i)
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest' })
  }

  const setActive = useCallback((i: number, focus = false) => {
    const n = o.current.count
    if (n <= 0) return
    const next = Math.max(0, Math.min(n - 1, i))
    if (o.current.active === undefined) setOwn(next)
    o.current.onActiveChange?.(next)
    if (focus) show(next)
  }, [])

  const focus = useCallback((i?: number) => show(i ?? active), [active])

  useEffect(() => {
    if (opts.active === undefined && opts.count > 0 && own >= opts.count) setOwn(opts.count - 1)
  }, [opts.count, opts.active, own])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    // Typing in an input inside a row (rare) keeps its own keys.
    if ((e.target as HTMLElement).closest?.('input,textarea,select,[contenteditable="true"]')) return
    const n = o.current.count
    let to: number
    switch (e.key) {
      case 'ArrowDown': to = active + 1; break
      case 'ArrowUp': to = active - 1; break
      case 'Home': to = 0; break
      case 'End': to = n - 1; break
      case 'PageDown': to = active + 10; break
      case 'PageUp': to = active - 10; break
      case 'Enter':
        if (o.current.onEnter && n > 0) {
          e.preventDefault()
          o.current.onEnter(active, e)
        }
        return
      case ' ': {
        const fn = o.current.onSpace ?? o.current.onEnter
        if (fn && n > 0) {
          e.preventDefault()
          fn(active, e)
        }
        return
      }
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    setActive(to, true)
  }

  const optionProps = (i: number) => ({
    role: 'option' as const,
    tabIndex: i === active ? 0 : -1,
    'data-roving': i,
    ref: (el: HTMLElement | null) => {
      if (el) els.current.set(i, el)
      else els.current.delete(i)
    },
    onFocus: () => {
      if (i === active) return
      if (o.current.active === undefined) setOwn(i)
      o.current.onActiveChange?.(i)
    }
  })

  return { active, setActive, focus, listProps: { role: 'listbox', onKeyDown }, optionProps }
}
