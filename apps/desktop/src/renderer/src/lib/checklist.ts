/**
 * Tick a getting-started item from anywhere (the assistant, multi-device and fleet runs) without
 * importing the onboarding store, which pulls in the app store (and so stays out of pure modules
 * that unit tests load). features/onboarding/store.ts listens.
 */
import type { ChecklistItem } from '@shared/ux'

let listener: ((item: ChecklistItem) => void) | null = null

export const onChecklist = (fn: (item: ChecklistItem) => void): void => {
  listener = fn
}

export const markChecklist = (item: ChecklistItem): void => listener?.(item)
