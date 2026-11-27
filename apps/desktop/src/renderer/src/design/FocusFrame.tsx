import { useLayoutEffect, useRef } from 'react'
import { layoutMotionOptions, reducedMotion } from './theme'

/** One frame follows the selected element, including when a divider changes its bounds. */
export function FocusFrame({ selector, identity, rail = false }: { selector: string; identity: string; rail?: boolean }) {
  const frame = useRef<HTMLDivElement>(null)
  const previous = useRef<DOMRect | null>(null)
  useLayoutEffect(() => {
    const el = frame.current
    const parent = el?.parentElement
    const target = parent?.querySelector<HTMLElement>(selector)
    if (!el || !parent || !target) return
    let animation: Animation | undefined
    const place = (animate: boolean) => {
      const box = target.getBoundingClientRect()
      const base = parent.getBoundingClientRect()
      const old = previous.current
      const x = box.x - base.x + parent.scrollLeft
      const y = box.y - base.y + parent.scrollTop
      const width = rail ? 2 : box.width
      const height = box.height
      Object.assign(el.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' })
      if (animate && old && width && height && !reducedMotion()) {
        const transform = `translate(${old.x - box.x}px,${old.y - box.y}px) scale(${rail ? 1 : old.width / width},${old.height / height})`
        animation = el.animate([{ transform }, { transform: 'none' }], layoutMotionOptions(el, '--ease-out'))
      }
      previous.current = box
    }
    place(true)
    const observer = new ResizeObserver(() => place(false))
    observer.observe(target)
    observer.observe(parent)
    return () => { observer.disconnect(); animation?.cancel() }
  }, [selector, identity, rail])
  return <div ref={frame} aria-hidden className={rail ? 'selection-rail' : 'focus-frame'} />
}
