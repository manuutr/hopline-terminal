import { describe, expect, it } from 'vitest'
import { DIVIDER_STEP, keyboardLayout, panelKeyboardSize } from '../src/renderer/src/design/Divider'

const o = { before: 'a', after: 'b', horizontal: true, axisPx: 1000 }
const layout = { a: 30, b: 70 }

describe('divider keyboard model (Phase 6 accessibility pack)', () => {
  it('arrows move by the small step in screen direction; Shift by the large one', () => {
    expect(keyboardLayout(layout, 'ArrowRight', false, o)).toEqual({ a: 30 + (DIVIDER_STEP.small / 10), b: 70 - DIVIDER_STEP.small / 10 })
    expect(keyboardLayout(layout, 'ArrowLeft', false, o)).toEqual({ a: 30 - DIVIDER_STEP.small / 10, b: 70 + DIVIDER_STEP.small / 10 })
    expect(keyboardLayout(layout, 'ArrowRight', true, o)).toEqual({ a: 30 + DIVIDER_STEP.large / 10, b: 70 - DIVIDER_STEP.large / 10 })
    expect(DIVIDER_STEP.large).toBeGreaterThan(DIVIDER_STEP.small * 4)
  })

  it('a horizontal divider ignores Left/Right and a vertical one Up/Down', () => {
    expect(keyboardLayout(layout, 'ArrowUp', false, o)).toBeNull()
    const v = { ...o, horizontal: false }
    expect(keyboardLayout(layout, 'ArrowRight', false, v)).toBeNull()
    expect(keyboardLayout(layout, 'ArrowDown', false, v)?.a).toBeGreaterThan(30)
  })

  it('Home moves the divider to its start, End to its end (the library clamps to min, max or collapsed)', () => {
    expect(keyboardLayout(layout, 'Home', false, o)).toEqual({ a: 0, b: 100 })
    expect(keyboardLayout(layout, 'End', false, o)).toEqual({ a: 100, b: 0 })
  })

  it('other panels of the group are untouched; unknown keys and unknown panels do nothing', () => {
    expect(keyboardLayout({ ...layout, c: 10 }, 'ArrowRight', false, o)?.c).toBe(10)
    expect(keyboardLayout(layout, 'Enter', false, o)).toBeNull()
    expect(keyboardLayout(layout, 'ArrowRight', false, { ...o, before: 'x' })).toBeNull()
    expect(keyboardLayout(layout, 'ArrowRight', false, { ...o, axisPx: 0 })).toBeNull()
  })

  it('side panels: a panel after the divider shrinks on Right/Down; Home/End collapse or maximise per side', () => {
    const before = { side: 'before' as const, horizontal: true }
    const after = { side: 'after' as const, horizontal: true }
    expect(panelKeyboardSize(260, 'ArrowRight', false, before)).toBe(260 + DIVIDER_STEP.small)
    expect(panelKeyboardSize(380, 'ArrowRight', false, after)).toBe(380 - DIVIDER_STEP.small)
    expect(panelKeyboardSize(380, 'ArrowLeft', true, after)).toBe(380 + DIVIDER_STEP.large)
    expect(panelKeyboardSize(260, 'Home', false, before)).toBe(0)
    expect(panelKeyboardSize(380, 'End', false, after)).toBe(0)
    expect(panelKeyboardSize(380, 'Home', false, after)).toBeGreaterThan(10_000)
    expect(panelKeyboardSize(300, 'ArrowUp', false, { side: 'after', horizontal: false })).toBe(300 + DIVIDER_STEP.small)
    expect(panelKeyboardSize(300, 'ArrowLeft', false, { side: 'after', horizontal: false })).toBeNull()
  })
})
