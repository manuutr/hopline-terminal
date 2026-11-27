import { Label } from '../../design'
import { useFieldLabel } from '../../design/useFieldLabel'

/** Settings pages can reveal optional hints together. Consequences that affect privacy or data stay visible. */
export function Row({ k, label, hint, essential, children }: { essential?: boolean; k?: string; label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  // `k` names the row in shared/settings-registry.ts: search, openSettings(key) and deep links land here.
  // The label names the row's control for screen readers (and axe); the hint describes it.
  const { ref, labelId, hintId } = useFieldLabel<HTMLDivElement>()
  return (
    <div ref={ref} data-settings-row data-setting-key={k} className="group/row -mx-2 grid scroll-mt-4 grid-cols-[168px_minmax(0,1fr)] items-start gap-x-4 rounded-md px-2 py-1.5 data-[flash]:bg-accent-soft data-[flash]:outline data-[flash]:outline-1 data-[flash]:outline-accent/50">
      <Label id={labelId} className="flex min-h-7 items-center text-fg">
        {label}
      </Label>
      <div className="min-w-0">
        <div data-settings-control className="flex min-h-7 flex-col justify-center [&>[role=radiogroup]]:self-start [&>[role=switch]]:self-start [&>button]:self-start">
          {children}
        </div>
        {hint && (
          <div id={hintId} data-settings-hint data-essential={essential || undefined} className="mt-1 max-w-prose text-xs leading-relaxed text-fg-muted">
            {hint}
          </div>
        )}
      </div>
    </div>
  )
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section data-settings-section={id} className="pb-3 pt-2 first:pt-0 last:pb-0">
      {/* tabIndex -1: a deep link focuses the heading, never a control (review M7). */}
      <h3 data-settings-heading tabIndex={-1} className="mb-2 text-xs font-semibold text-fg-muted focus:outline-none">
        {title}
      </h3>
      <div data-settings-fields>{children}</div>
    </section>
  )
}

/** The one switch (design/Toggle); re-exported so settings panels keep importing it from here. */
export { Toggle } from '../../design'

/** Remote errors arrive as "Error invoking remote method 'x': Error: message": keep the message. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e))
