import { useEffect, useId, useRef } from 'react'

const CONTROLS = 'input:not([type=hidden]), select, textarea, button[role=combobox], [role=switch], [role=radiogroup], [role=slider]'

/** True when the control already has an accessible name of its own. */
function named(el: Element): boolean {
  if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return true
  const id = el.getAttribute('id')
  if (id && el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)) return true
  return !!el.closest('label')
}

/**
 * A form row's visible label names its control (axe `label` / `select-name`). Settings rows and
 * dialog fields put the label beside the control rather than around it, so the label is given an id
 * and every unnamed control in the row points at it with `aria-labelledby`. Controls that set their
 * own name keep it. (The hint is not wired as aria-describedby: axe then reads a label scrolled out
 * of view as missing and reports the field as "title only".)
 */
export function useFieldLabel<T extends HTMLElement>(): { ref: React.RefObject<T | null>; labelId: string; hintId: string } {
  const ref = useRef<T | null>(null)
  const base = useId()
  const labelId = `${base}-label`
  const hintId = `${base}-hint`
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const apply = () => {
      for (const el of root.querySelectorAll(CONTROLS)) {
        if (el.getAttribute('data-field-label') === labelId) continue
        if (named(el)) continue
        el.setAttribute('aria-labelledby', labelId)
        el.setAttribute('data-field-label', labelId)
      }
    }
    apply()
    // Controls appear later (a field that switches between an input and a select).
    const mo = new MutationObserver(apply)
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [labelId])
  return { ref, labelId, hintId }
}
