import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import { Dialog as D } from 'radix-ui'
import { useLayoutEffect, useRef, useState } from 'react'
import { restoreFocus } from '../../design/Dialog'
import { useUi } from '../../store'
import { Button } from '../../design'
import { endTour, tourStep, tourStops, useTour } from './tour'

type Bounds = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>

function placement(rect: Bounds, width: number, height: number) {
  const gap = 16
  const right = rect.right + gap
  const left = rect.left - width - gap
  const below = rect.bottom + gap
  const above = rect.top - height - gap
  const clamp = (value: number, max: number) => Math.max(gap, Math.min(value, max - gap))
  const x = right + width <= innerWidth - gap ? right : left >= gap ? left : rect.left
  const beside = x === right || x === left
  const y = beside ? rect.top : below + height <= innerHeight - gap ? below : above >= gap ? above : rect.top + gap
  return { left: clamp(x, innerWidth - width), top: clamp(y, innerHeight - height) }
}

function TourCard({ step }: { step: number }) {
  const stop = tourStops[step]!
  const card = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ rect: Bounds; left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    // Opening a panel moves the target during its slide animation without resizing it.
    // Track its actual bounds only while the tour is on screen.
    let frame = 0
    let last: { rect: Bounds; left: number; top: number } | null = null
    const measure = () => {
      const target = document.querySelector<HTMLElement>(stop.selector)
      if (target && card.current) {
        const rect = target.getBoundingClientRect()
        const { left, top } = placement(rect, card.current.offsetWidth, card.current.offsetHeight)
        if (rect.width > 1 && rect.height > 1 && (!last || rect.x !== last.rect.left || rect.y !== last.rect.top ||
          rect.width !== last.rect.width || rect.height !== last.rect.height || left !== last.left || top !== last.top)) {
          last = { rect, left, top }
          setPosition(last)
        }
      }
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [stop])

  const last = step === tourStops.length - 1
  return <>
    <D.Overlay className="fixed inset-0 z-[var(--z-scrim)] overflow-hidden" data-tour-spotlight={step}>
      {position && <div aria-hidden className="pointer-events-none absolute rounded-md border-2 border-accent shadow-[0_0_0_200vmax_var(--c-scrim)]" style={{
        left: position.rect.left - 2, top: position.rect.top - 2, width: position.rect.width + 4, height: position.rect.height + 4
      }} />}
    </D.Overlay>
    <D.Content ref={card} aria-label="Workspace tour" onCloseAutoFocus={e => {
      if (useUi.getState().settingsOpen) {
        e.preventDefault()
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="dialog"] [data-tour-launch]')?.focus())
      } else restoreFocus(e, useTour.getState().opener)
      if (useTour.getState().step === null) useTour.setState({ opener: null })
    }} onOpenAutoFocus={e => { e.preventDefault(); card.current?.focus() }}
      className="fixed z-[var(--z-dialog)] w-[min(330px,90vw)] rounded-lg border border-line-strong bg-overlay p-4 shadow-overlay focus:outline-none"
      style={{ left: position?.left ?? 16, top: position?.top ?? 72 }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 text-xs font-medium text-fg-muted"><D.Title className="text-xs">Workspace tour</D.Title><span className="ml-1 tabular-nums">{step + 1} of {tourStops.length}</span></div>
        <D.Close asChild><Button variant="ghost" size="icon-sm" aria-label="Skip tour"><X aria-hidden /></Button></D.Close>
      </div>
      <div aria-live="polite" aria-atomic="true">
        <h3 className="mt-2 text-base font-semibold">{stop.title}</h3>
        <D.Description className="mt-1 text-sm leading-relaxed text-fg-muted">{stop.text}</D.Description>
      </div>
      <div className="mt-4 flex justify-end gap-1.5">
        {step > 0 && <Button variant="ghost" onClick={() => tourStep(step - 1)}><ArrowLeft />Back</Button>}
        <Button variant="primary" onClick={() => last ? endTour() : tourStep(step + 1)}>{last ? 'Finish' : 'Next'}{last ? <Check /> : <ArrowRight />}</Button>
      </div>
    </D.Content>
  </>
}

export function WorkspaceTour() {
  const step = useTour(s => s.step)
  return <D.Root open={step !== null} onOpenChange={open => { if (!open) endTour() }}>
    {step !== null && <D.Portal><TourCard step={step} /></D.Portal>}
  </D.Root>
}
