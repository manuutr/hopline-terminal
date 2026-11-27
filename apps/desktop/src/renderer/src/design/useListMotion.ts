import { useLayoutEffect, useRef, type RefObject } from 'react'
import { layoutMotionOptions, reducedMotion } from './theme'

/** Reconcile already-laid-out rows with compositor transforms. Exiting faces are inert. */
export function useListMotion(ref: RefObject<HTMLElement | null>, attribute: string, keys: string) {
  const last = useRef(new Map<string, { node: HTMLElement; left: number; top: number; width: number; height: number }>())
  useLayoutEffect(() => {
    const container = ref.current
    if (!container || reducedMotion()) { last.current.clear(); return }
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[' + attribute + ']'))
    const now = new Map(nodes.map((node) => [node.getAttribute(attribute)!, {
      node, left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight
    }]))
    const previous = last.current
    last.current = now
    if (!previous.size) return
    const options = layoutMotionOptions(container, '--ease-spring')
    const ghosts: HTMLElement[] = []
    const animations: Animation[] = []
    const scale = 'scaleY(.05)'
    const bounds = container.closest('[data-tree-scroller]')?.getBoundingClientRect() ?? container.getBoundingClientRect()
    const origin = container.getBoundingClientRect().top - container.scrollTop
    const visible = (y: number, h: number) => origin + y < bounds.bottom && origin + y + h > bounds.top
    for (const [key, box] of now) {
      if (!visible(box.top, box.height)) continue
      const old = previous.get(key)
      if (old && old.left === box.left && old.top === box.top && old.width === box.width) continue
      const from = old ? `translate(${old.left - box.left}px,${old.top - box.top}px) scaleX(${old.width / (box.width || 1)})` : scale
      animations.push(box.node.animate([{ transform: from, opacity: old ? 1 : 0 }, { transform: 'none', opacity: 1 }], options))
    }
    for (const [key, box] of previous) {
      if (now.has(key) || !visible(box.top, box.height) || !box.width) continue
      const ghost = document.createElement('div')
      ghost.inert = true
      ghost.setAttribute('aria-hidden', 'true')
      ghost.className = 'list-exit-face'
      ghost.textContent = box.node.textContent
      Object.assign(ghost.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' })
      container.append(ghost)
      ghosts.push(ghost)
      const animation = ghost.animate([{ opacity: .8, transform: 'none' }, { opacity: 0, transform: scale }], options)
      animation.onfinish = () => ghost.remove()
      animations.push(animation)
    }
    return () => { animations.forEach((a) => a.cancel()); ghosts.forEach((g) => g.remove()) }
  }, [ref, keys, attribute])
}
