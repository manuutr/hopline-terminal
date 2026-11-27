import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'

import { errorText } from '../lib/errors'

export { errorText }

export interface Loaded<T> {
  data: T | null
  /** True until the first result (or error) arrives; a reload keeps the old data on screen. */
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

/**
 * Load a list for a surface and keep loading, empty and error apart, so a failed read never shows
 * as "nothing here yet". `enabled` false skips loading (a closed dialog).
 */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[], enabled = true): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const ref = useRef(fn)
  ref.current = fn
  const reload = useCallback(async () => {
    const n = ++seq.current
    try {
      const v = await ref.current()
      if (n !== seq.current) return
      setData(v)
      setError(null)
    } catch (e) {
      if (n !== seq.current) return
      setError(errorText(e))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (enabled) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload, ...deps])
  return { data, loading, error, reload }
}

/** A read that failed: what failed, why, and a retry. Left-aligned, one line (VISUAL-DIRECTION.md). */
export function LoadError({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div role="alert" data-load-error="" className="flex items-start gap-3 px-4 py-5 text-left">
      <p className="min-w-0 flex-1 text-xs text-danger">
        Could not read {what}: {error}
      </p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** CSS delays paint so a fast IPC response never flashes a placeholder. */
export function Loading({ what }: { what: string }): React.JSX.Element {
  return <div role="status" aria-label={'Loading ' + what} className="delayed-skeleton px-4 py-4">
    <span className="sr-only">Loading {what}…</span>
    <span aria-hidden className="skeleton-line block h-2 w-24 rounded-sm bg-active" />
    <span aria-hidden className="skeleton-line mt-2 block h-2 w-36 rounded-sm bg-active" />
  </div>
}
