/**
 * Toast discipline: every toast in the renderer goes through here (test/toast-discipline.test.ts
 * forbids importing sonner anywhere else).
 *
 * - Dedupe: the same message (kind + title + description) reuses one toast id, so a repeat
 *   refreshes the toast already on screen instead of stacking a copy (sonner updates by id).
 * - Cap: at most MAX_VISIBLE toasts are on screen (the Toaster in main.tsx); older ones queue.
 * - Errors stay until dismissed only when they carry an action; everything else times out.
 *
 * What does not get a toast: things the UI already shows where the user is looking (a dialog that
 * closes on Save, a row that changes, a status dot, a tab glyph). Use the surface, not a toast.
 */
import { toast as sonner, type ExternalToast } from 'sonner'

export const MAX_VISIBLE = 3

type Kind = 'default' | 'success' | 'error' | 'info' | 'warning' | 'loading'
type Title = string | React.ReactNode

const text = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '')

/** The id a message gets: the same kind, title and description always map to the same id. */
export function toastId(kind: Kind, title: unknown, description?: unknown): string | undefined {
  const t = text(title)
  // A non-text title (a React node) can't be compared: no dedupe for it.
  if (!t) return undefined
  return `hop:${kind}:${t}\u0000${text(description)}`
}

const show =
  (kind: Kind) =>
  (title: Title, opts?: ExternalToast): string | number => {
    const id = opts?.id ?? toastId(kind, title, opts?.description)
    const duration = opts?.duration ?? 4000
    const timed = Number.isFinite(duration) && kind !== 'loading'
    const o = {
      ...opts, id, duration,
      className: [opts?.className, timed && 'toast-timed'].filter(Boolean).join(' '),
      style: { ...opts?.style, '--toast-time': duration + 'ms' } as React.CSSProperties
    }
    switch (kind) {
      case 'success':
        return sonner.success(title, o)
      case 'error':
        return sonner.error(title, o)
      case 'info':
        return sonner.info(title, o)
      case 'warning':
        return sonner.warning(title, o)
      case 'loading':
        return sonner.loading(title, o)
      default:
        return sonner(title, o)
    }
  }

/** Drop-in for sonner's `toast` (same call shapes), with dedupe. */
export const toast = Object.assign(show('default'), {
  success: show('success'),
  error: show('error'),
  info: show('info'),
  warning: show('warning'),
  loading: show('loading'),
  message: show('default'),
  dismiss: (id?: string | number) => sonner.dismiss(id)
})
