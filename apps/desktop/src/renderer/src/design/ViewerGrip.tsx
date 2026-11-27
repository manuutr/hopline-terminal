import { useLayoutEffect, useRef, useState } from 'react'
import { GripHorizontal, MoveDiagonal2 } from 'lucide-react'

/** Resize the docked table vertically, or the centered results dialog in two dimensions. */
export function ViewerGrip({ dialog = false, onClose }: { dialog?: boolean; onClose?: () => void }) {
  const grip = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const [percent, setPercent] = useState(58)
  const target = () => grip.current?.closest<HTMLElement>(dialog ? '[role=dialog]' : '[data-table-drawer]')
  const label = dialog ? 'Resize results viewer' : 'Resize table viewer'
  const key = dialog ? 'hopline.resultsSize' : 'hopline.tableHeight'
  const apply = (width: number, height: number) => {
    const el = target()
    if (!el) return
    if (dialog) {
      el.style.setProperty('--viewer-width', Math.min(innerWidth * .96, Math.max(480, width)) + 'px')
      el.style.setProperty('--viewer-height', Math.min(innerHeight * .94, Math.max(300, height)) + 'px')
    } else {
      const total = el.parentElement!.clientHeight
      const value = Math.min(96, Math.max(Math.min(96, 14000 / Math.max(total, 1)), height * 100 / Math.max(total, 1)))
      el.style.setProperty('--table-height', value + '%')
      setPercent(Math.round(value))
    }
  }
  const save = () => {
    const el = target()
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    localStorage.setItem(key, dialog ? JSON.stringify([width, height]) : el.style.getPropertyValue('--table-height'))
  }
  useLayoutEffect(() => {
    const el = target(), saved = localStorage.getItem(key)
    if (!el || !saved) return
    if (dialog) {
      try {
        const size: unknown = JSON.parse(saved)
        if (Array.isArray(size) && size.length === 2 && size.every(Number.isFinite)) apply(size[0], size[1])
      } catch { /* Old or invalid preference. */ }
    } else if (/^\d+(?:\.\d+)?%$/.test(saved)) {
      apply(0, el.parentElement!.clientHeight * parseFloat(saved) / 100)
    }
  }, [dialog, key])
  const reset = () => {
    const el = target()
    if (!el) return
    for (const prop of ['--viewer-width', '--viewer-height', '--table-height']) el.style.removeProperty(prop)
    setPercent(58)
    localStorage.removeItem(key)
  }
  return <button type="button" ref={grip} aria-label={label} role={dialog ? undefined : 'separator'}
    aria-orientation={dialog ? undefined : 'horizontal'} aria-valuemin={dialog ? undefined : 0}
    aria-valuemax={dialog ? undefined : 100} aria-valuenow={dialog ? undefined : percent}
    title={label + ' · Drag or use the arrow keys. Home resets the size. End expands.'}
    className={dialog ? 'results-resize-grip' : 'table-resize-grip'}
    onDoubleClick={reset}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      const box = target()!.getBoundingClientRect()
      drag.current = { x: e.clientX, y: e.clientY, width: box.width, height: box.height }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.currentTarget.focus({ preventScroll: true })
      e.preventDefault()
    }}
    onPointerMove={(e) => {
      const start = drag.current
      if (start && e.currentTarget.hasPointerCapture(e.pointerId)) apply(start.width + 2 * (e.clientX - start.x), start.height + (dialog ? 1 : -1) * (e.clientY - start.y))
    }}
    onLostPointerCapture={() => { if (drag.current) save(); drag.current = null }}
    onKeyDown={(e) => {
      const box = target()!.getBoundingClientRect(), step = e.shiftKey ? 64 : 16
      if (e.key === 'Escape' && onClose) onClose()
      else if (e.key === 'Home') reset()
      else if (e.key === 'End' || (dialog && (e.key === 'Enter' || e.key === ' '))) { apply(innerWidth, innerHeight); save() }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        apply(box.width, box.height + ((e.key === 'ArrowDown') === dialog ? step : -step)); save()
      } else if (dialog && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { apply(box.width + (e.key === 'ArrowRight' ? step : -step), box.height); save() }
      else return
      e.preventDefault(); e.stopPropagation()
    }}>
    {dialog ? <MoveDiagonal2 size={15} /> : <GripHorizontal size={18} />}
  </button>
}
