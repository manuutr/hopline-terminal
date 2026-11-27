import { useLayoutEffect, useRef } from 'react'
import { layoutMotionOptions, reducedMotion } from './theme'

/** A single face follows the selected control. CSS keeps the actual input and focus ring in place. */
export function SelectionIndicator({ kind, value, items }: { kind: 'tab' | 'segment'; value: string; items: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const initialized = useRef(false)
  const motion = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const face = ref.current
    const group = face?.parentElement
    if (!face || !group) return
    const role = kind === 'tab' ? 'tab' : 'radio'
    const choice = group.querySelector<HTMLElement>(kind === 'tab' ? '[role=tab][aria-selected=true]' : '[role=radio][aria-checked=true]')
    if (!choice) {
      face.hidden = true
      initialized.current = false
      return
    }

    const place = (animate: boolean) => {
      const vertical = kind === 'tab'
      const left = choice.offsetLeft, top = choice.offsetTop + (vertical ? 6 : 0)
      const width = vertical ? 3 : choice.offsetWidth, height = choice.offsetHeight - (vertical ? 12 : 0)
      if (!choice.offsetWidth || height <= 0) { face.hidden = true; initialized.current = false; return }
      if (!face.hidden && face.offsetLeft === left && face.offsetTop === top && face.offsetWidth === width && face.offsetHeight === height) return
      const previous = initialized.current && animate && !reducedMotion() ? face.getBoundingClientRect() : null
      motion.current?.cancel()
      face.hidden = false
      Object.assign(face.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' })
      initialized.current = true
      if (!previous?.width) return
      const destination = face.getBoundingClientRect()
      motion.current = face.animate([
        { transform: `translate(${previous.x - destination.x}px, ${previous.y - destination.y}px) scaleX(${previous.width / destination.width})` },
        { transform: 'none' }
      ], layoutMotionOptions(face, '--ease-spring'))
    }
    place(true)
    const observer = new ResizeObserver(() => place(false))
    observer.observe(group)
    for (const item of group.querySelectorAll('[role=' + role + ']')) observer.observe(item)
    return () => observer.disconnect()
  }, [kind, value, items])
  return <span ref={ref} aria-hidden="true" data-selection-face={kind} />
}
