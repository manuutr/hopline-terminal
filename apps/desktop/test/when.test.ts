import { describe, expect, it } from 'vitest'
import { fmtTime, fmtWhen } from '../src/renderer/src/lib/when'

/** Round 2: one date helper, 24-hour clock, relative words for yesterday/today/tomorrow. */
describe('fmtWhen', () => {
  const now = new Date(2026, 10, 25, 12, 0, 0).getTime()
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime()
  it('uses relative words around today, lower case unless capitalized', () => {
    expect(fmtWhen(at(25, 9, 5), { now })).toBe('today 09:05')
    expect(fmtWhen(at(24, 23, 59), { now })).toBe('yesterday 23:59')
    expect(fmtWhen(at(26, 2, 30), { now })).toBe('tomorrow 02:30')
    expect(fmtWhen(at(26, 2, 30), { now, cap: true })).toBe('Tomorrow 02:30')
  })
  it('is 24-hour, never AM/PM', () => {
    expect(fmtTime(at(25, 14, 5))).toBe('14:05')
    expect(fmtWhen(at(25, 0, 5), { now })).not.toMatch(/AM|PM/i)
  })
  it('shows a date beyond the relative window and the year only when it differs', () => {
    expect(fmtWhen(at(3, 14, 5), { now })).toMatch(/3/)
    expect(fmtWhen(at(3, 14, 5), { now })).toMatch(/14:05$/)
    expect(fmtWhen(new Date(2025, 0, 2, 8, 0).getTime(), { now })).toMatch(/2025/)
  })
  it('adds seconds on request', () => {
    expect(fmtTime(new Date(2026, 0, 1, 8, 9, 7).getTime(), true)).toBe('08:09:07')
  })
})
