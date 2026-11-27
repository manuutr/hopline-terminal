import type { BackupSchedule } from '@shared/backups'

const DAY = 24 * 60 * 60 * 1000

/** The most recent scheduled time at or before `now` (local time), or null before the first one. */
export function lastSlot(s: Pick<BackupSchedule, 'cadence' | 'weekday' | 'time'>, now: number): number {
  const [h, m] = s.time.split(':').map(Number) as [number, number]
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  let t = d.getTime()
  if (t > now) {
    d.setDate(d.getDate() - 1)
    t = d.getTime()
  }
  if (s.cadence === 'weekly') {
    // Step back day by day (DST-safe) to the configured weekday.
    for (let i = 0; i < 7 && d.getDay() !== s.weekday; i++) d.setDate(d.getDate() - 1)
    t = d.getTime()
  }
  return t
}

/** The next scheduled time after `now`. */
export function nextSlot(s: Pick<BackupSchedule, 'cadence' | 'weekday' | 'time'>, now: number): number {
  const last = lastSlot(s, now)
  const d = new Date(last)
  d.setDate(d.getDate() + (s.cadence === 'weekly' ? 7 : 1))
  // Re-apply the wall-clock time across DST changes.
  const [h, m] = s.time.split(':').map(Number) as [number, number]
  d.setHours(h, m, 0, 0)
  return d.getTime() > now ? d.getTime() : last + (s.cadence === 'weekly' ? 7 : 1) * DAY
}

/**
 * Due when a slot passed that has not run yet: since the last run, or since the schedule was
 * created (a schedule made at 10:00 for 09:00 waits until tomorrow). A slot missed while the app
 * was closed is caught up once on start: only the latest missed slot runs, never one per day.
 */
export function isDue(s: Pick<BackupSchedule, 'cadence' | 'weekday' | 'time' | 'enabled' | 'createdAt' | 'lastRunAt'>, now: number): boolean {
  if (!s.enabled) return false
  const slot = lastSlot(s, now)
  return slot > Math.max(s.createdAt, s.lastRunAt ?? 0)
}
