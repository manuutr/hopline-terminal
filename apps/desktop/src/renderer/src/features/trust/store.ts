import { create } from 'zustand'
import type { AiHealth } from '@shared/types'
import { NO_LOCKS, type PolicyInfo, type PolicyLocks } from '@shared/policy'

/** Trust UX and team policy state in the window: the policy as main loaded it, provider health, the egress viewer. */
interface TrustState {
  policy: PolicyInfo
  health: AiHealth | null
  checking: boolean
  egressOpen: boolean
  loadPolicy: () => Promise<void>
  checkHealth: () => Promise<void>
  openEgress: (open: boolean) => void
}

export const useTrust = create<TrustState>((set, get) => ({
  policy: { state: 'none', source: null, locks: NO_LOCKS },
  health: null,
  checking: false,
  egressOpen: false,
  loadPolicy: async () => {
    try {
      set({ policy: await window.hopline.policy.info() })
    } catch {
      /* keep "none": main enforces regardless of what the window shows */
    }
  },
  checkHealth: async () => {
    if (get().checking) return
    set({ checking: true })
    try {
      set({ health: await window.hopline.ai.health() })
    } catch {
      set({ health: null })
    } finally {
      set({ checking: false })
    }
  },
  openEgress: (open) => set({ egressOpen: open })
}))

export const useLocks = (): PolicyLocks => useTrust((s) => s.policy.locks)

/** The label on settings a policy fixes. */
export const policyName = (p: PolicyInfo): string => (p.state === 'active' && p.name ? p.name : 'team policy')
