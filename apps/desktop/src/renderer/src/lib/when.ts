/**
 * One date/time format for the whole app (round 2): 24-hour clock, the locale's own day/month names.
 *   today 14:05 · yesterday 09:12 · tomorrow 02:30 · Mon 1 Dec 02:30 · 3 Nov 14:05 · 3 Nov 2025 14:05
 * `cap` capitalizes the relative word when the text starts a label ("Today 14:05").
 */
const DAY = 86_400_000

export function fmtTime(ts: number, seconds = false): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' })
}

export function fmtWhen(ts: number, opts: { now?: number; seconds?: boolean; cap?: boolean } = {}): string {
  const now = opts.now ?? Date.now()
  const d = new Date(ts)
  const time = fmtTime(ts, opts.seconds)
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const start = day.getTime()
  const rel = (w: string) => `${opts.cap ? w[0]!.toUpperCase() + w.slice(1) : w} ${time}`
  if (ts >= start + 2 * DAY && ts < start + 7 * DAY) return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
  if (ts >= start + DAY && ts < start + 2 * DAY) return rel('tomorrow')
  if (ts >= start && ts < start + DAY) return rel('today')
  if (ts >= start - DAY && ts < start) return rel('yesterday')
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== day.getFullYear() ? { year: 'numeric' } : {}) })} ${time}`
}
