import { create } from 'zustand'
import { markChecklist } from '../../lib/checklist'
import type { MultiEvent, MultiMode, MultiPreview, ResolvedTarget, TargetSpec } from '@shared/productivity'

export interface TargetResult extends Omit<MultiEvent, 'runId' | 'key' | 'done'> {
  /** When the target started connecting or running (for a live timer). */
  startedAt?: number
  /** When this window received the target's final result. */
  recordedAt?: number
}

interface MultiState {
  open: boolean
  mode: MultiMode
  step: 'compose' | 'preview' | 'results'
  /** What is picked, as ids by kind (resolved to devices in main). */
  picked: Required<TargetSpec>
  resolved: ResolvedTarget[]
  command: string
  perPlatform: boolean
  concurrency: number
  preview: MultiPreview | null
  runId: string | null
  running: boolean
  results: Record<string, TargetResult>
  info: { parser: boolean; maxTargets: number; maxConcurrency: number } | null
  /** Open the dialog, optionally with targets already picked (a palette group, the selected tabs). */
  show: (mode: MultiMode, picked?: TargetSpec) => void
  close: () => void
}

const empty = (): Required<TargetSpec> => ({ tabs: [], sessions: [], folders: [], tags: [] })

export const useMulti = create<MultiState>((set, get) => ({
  open: false,
  mode: 'run',
  step: 'compose',
  picked: empty(),
  resolved: [],
  command: '',
  perPlatform: true,
  concurrency: 4,
  preview: null,
  runId: null,
  running: false,
  results: {},
  info: null,
  show: (mode, picked) => {
    // A run in progress keeps its results: reopening shows them.
    if (get().running) return set({ open: true })
    set({ open: true, mode, step: 'compose', preview: null, runId: null, results: {}, ...(picked ? { picked: { ...empty(), ...picked } } : {}) })
    if (!get().info) void window.hopline.multi.info().then((info) => set({ info }))
  },
  close: () => set({ open: false })
}))

let subscribed = false
/** Events that arrived after Run but before main answered with the run id (a fast device). */
let early: MultiEvent[] = []
const EARLY_MAX = 2000

function apply(e: MultiEvent): void {
  const s = useMulti.getState()
  if (e.done) return useMulti.setState({ running: false })
  const prev = s.results[e.key]
  const startedAt = e.status === 'connecting' || (e.status === 'running' && !prev?.startedAt) ? Date.now() : prev?.startedAt
  // The getting-started item counts a run that reached a device, not one where every target failed.
  if (e.status === 'ok') markChecklist('multi')
  const { runId: _r, key: _k, done: _d, ...rest } = e
  useMulti.setState({ results: { ...useMulti.getState().results, [e.key]: { ...prev, ...rest, startedAt, ...(isFinal(e.status) ? { recordedAt: Date.now() } : {}) } } })
}

/** Route run events to the store (once per window). */
export function subscribeMulti(): void {
  if (subscribed) return
  subscribed = true
  window.hopline.multi.onEvent((e) => {
    const s = useMulti.getState()
    // Started but the id is not known yet: hold the event until attachRun.
    if (s.running && s.runId === null) {
      if (early.length < EARLY_MAX) early.push(e)
      return
    }
    if (e.runId !== s.runId) return
    apply(e)
  })
}

/** The run id is known: keep it and replay the events that belong to it (others are dropped). */
export function attachRun(runId: string): void {
  const held = early
  early = []
  useMulti.setState({ runId })
  for (const e of held) if (e.runId === runId) apply(e)
}

/** Test hook: forget held events. */
export function resetEarly(): void {
  early = []
}

export const isFinal = (s: TargetResult['status'] | undefined) => !!s && s !== 'queued' && s !== 'connecting' && s !== 'running'
