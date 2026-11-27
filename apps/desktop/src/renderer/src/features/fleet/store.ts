import { create } from 'zustand'
import type { FleetEvent, FleetMentionCurrent, FleetMentionError, FleetReport, FleetScopePreview, FleetScopeSpec, FleetStep, FleetUsage, LaneStatus } from '@shared/fleet'
import type { Folder, Session, SessionPlatform } from '@shared/types'
import { markChecklist } from '../../lib/checklist'

/**
 * Fleet run view state (F10). The renderer picks ids and asks a question; main resolves the scope,
 * stores it, and runs it. Everything shown here arrives as `fleet:event`, already redacted in main.
 */

export interface Lane {
  name: string
  platform: SessionPlatform
  status: LaneStatus
  excluded?: string
  task?: string
  reason?: string
  steps: FleetStep[]
  report?: FleetReport
}

export interface Picked {
  sessions: string[]
  folders: string[]
  tags: string[]
  /** Topology: start from this session. */
  seed: string | null
  hops: 1 | 2
}

/** The view was opened from an "@ai … @device" question (F11): what was typed, and what main made of it. */
export interface FromMentions {
  /** The text as typed, with its mentions (fixes edit it and resolve again). */
  text: string
  tabId: string
  sessionId: string | null
  errors: FleetMentionError[]
  current: FleetMentionCurrent | null
  /** Bumped on every resolution: the view moves the focus to the start button (or the first fix). */
  seq: number
}

interface FleetState {
  open: boolean
  /** Set while the scope step came from @-mentions; cleared when the scope is picked another way. */
  mention: FromMentions | null
  step: 'scope' | 'run'
  picked: Picked
  question: string
  preview: FleetScopePreview | null
  /** The devices the user ticked in the preview (session ids). Topology matches start unticked. */
  selected: string[]
  resolving: boolean
  concurrency: number
  tokenBudget: number
  runId: string | null
  status: 'idle' | 'starting' | 'running' | 'done' | 'cancelled' | 'error'
  error?: string
  asked: string
  startedAt: number
  endedAt: number | null
  lanes: Lane[]
  plan: { device: string; task: string }[]
  answer: string
  notes: string[]
  usage: FleetUsage
  /** The run's token budget (from the run event). */
  budgetTokens: number
  /** Stop pressed before the run id arrived: cancel as soon as it does. */
  stopAsked: boolean
  /** Open the view, optionally with a scope already picked (tree selection, a palette folder or tag). */
  show: (picked?: Partial<Picked>) => void
  close: () => void
}

const emptyPick = (): Picked => ({ sessions: [], folders: [], tags: [], seed: null, hops: 1 })
const zero: FleetUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, metered: 0, costUsd: null }

export const isRunning = (s: Pick<FleetState, 'status'>) => s.status === 'running' || s.status === 'starting'

export const useFleet = create<FleetState>((set, get) => ({
  open: false,
  mention: null,
  step: 'scope',
  picked: emptyPick(),
  question: '',
  preview: null,
  selected: [],
  resolving: false,
  concurrency: 4,
  tokenBudget: 400_000,
  runId: null,
  status: 'idle',
  asked: '',
  startedAt: 0,
  endedAt: null,
  lanes: [],
  plan: [],
  answer: '',
  notes: [],
  usage: zero,
  budgetTokens: 0,
  stopAsked: false,
  show: (picked) => {
    // A run in progress (or just finished) keeps its view: reopening shows it.
    if (isRunning(get()) || (get().step === 'run' && !picked)) return set({ open: true })
    set({ open: true, step: 'scope', preview: null, mention: null, ...(picked ? { picked: { ...emptyPick(), ...picked } } : {}) })
  },
  close: () => set({ open: false })
}))

/**
 * Sessions that ticked folders (with their subfolders) or tags already include, with what includes
 * them: the picker shows them ticked "via …". The same rule as main's scope resolution (fleet/scope.ts).
 */
export function impliedSessions(p: Picked, folders: readonly Pick<Folder, 'id' | 'parentId' | 'name'>[], sessions: readonly (Pick<Session, 'id' | 'folderId' | 'tags'> & { ephemeral?: boolean })[]): Map<string, string> {
  const out = new Map<string, string>()
  const name = new Map(folders.map((f) => [f.id, f.name]))
  const under = new Map<string, string>()
  for (const root of p.folders) {
    const ids = new Set([root])
    for (let grew = true; grew; ) {
      grew = false
      for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true))
    }
    for (const id of ids) if (!under.has(id)) under.set(id, name.get(root) ?? 'folder')
  }
  for (const s of sessions) {
    if (s.ephemeral) continue
    const f = s.folderId ? under.get(s.folderId) : undefined
    const t = s.tags.find((x) => p.tags.includes(x))
    if (f) out.set(s.id, f)
    else if (t) out.set(s.id, `#${t}`)
  }
  return out
}

export function specOf(p: Picked): FleetScopeSpec {
  if (p.seed) return { topology: { seed: p.seed, hops: p.hops } }
  return { sessions: p.sessions, folders: p.folders, tags: p.tags }
}

export { emptyPick }

export const pickedCount = (p: Picked) => (p.seed ? 1 : p.sessions.length + p.folders.length + p.tags.length)

/** Back to the scope step for a new question (the finished run's view is dropped). */
export function newInvestigation(): void {
  useFleet.setState({ step: 'scope', mention: null, runId: null, status: 'idle', error: undefined, lanes: [], plan: [], answer: '', notes: [], usage: zero, endedAt: null })
}

// ------------------------------------------------------------------ events

let subscribed = false
let early: FleetEvent[] = []
const EARLY_MAX = 5000

function patchLane(name: string, f: (l: Lane) => Lane): void {
  const lanes = useFleet.getState().lanes
  // Excluded entries never run; a duplicate name's excluded twin must not take the events.
  const i = lanes.findIndex((l) => l.name === name && !l.excluded)
  if (i < 0) return
  const next = [...lanes]
  next[i] = f(lanes[i]!)
  useFleet.setState({ lanes: next })
}

export function applyFleetEvent(e: FleetEvent): void {
  switch (e.type) {
    case 'run':
      if (e.status === 'running') {
        useFleet.setState({
          status: 'running',
          startedAt: e.startedAt,
          budgetTokens: e.budget.tokens,
          lanes: e.devices.map((d) => ({ name: d.name, platform: d.platform, status: d.excluded ? 'excluded' : 'idle', excluded: d.excluded, steps: [] }))
        })
      } else {
        // Ticks for an investigation that finished, not one that failed or was stopped.
        if (e.status === 'done') markChecklist('multi')
        useFleet.setState({ status: e.status, error: e.error, endedAt: Date.now() })
      }
      return
    case 'usage':
      return useFleet.setState({ usage: e.usage })
    case 'plan':
      return useFleet.setState({ plan: [...useFleet.getState().plan, ...e.tasks] })
    case 'lane':
      return patchLane(e.lane, (l) => ({
        ...l,
        status: e.status,
        ...(e.task !== undefined ? { task: e.task } : {}),
        // A new round on the lane starts with fresh steps.
        ...(e.status === 'queued' ? { steps: [], report: undefined, reason: undefined } : {}),
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
        ...(e.report ? { report: e.report } : {})
      }))
    case 'step':
      return patchLane(e.lane, (l) => {
        const i = l.steps.findIndex((s) => s.stepId === e.step.stepId)
        if (i < 0) return { ...l, steps: [...l.steps, e.step] }
        const steps = [...l.steps]
        steps[i] = { ...steps[i], ...e.step }
        return { ...l, steps }
      })
    case 'text':
      return useFleet.setState({ answer: useFleet.getState().answer + e.text })
    case 'note':
      return useFleet.setState({ notes: [...useFleet.getState().notes, e.text] })
  }
}

/** Route fleet events to the store (once per window). */
export function subscribeFleet(): void {
  if (subscribed) return
  subscribed = true
  window.hopline.fleet.onEvent((e) => {
    const s = useFleet.getState()
    if (s.status === 'starting' && s.runId === null) {
      if (early.length < EARLY_MAX) early.push(e)
      return
    }
    if (e.runId !== s.runId) return
    applyFleetEvent(e)
  })
}

/** Ticked by default: every device that can run, except topology matches (the user opts in to those). */
export const defaultSelection = (p: FleetScopePreview) => p.devices.filter((d) => !d.excluded && !d.optIn).map((d) => d.sessionId)

export function toggleSelected(sessionId: string): void {
  const sel = useFleet.getState().selected
  useFleet.setState({ selected: sel.includes(sessionId) ? sel.filter((x) => x !== sessionId) : [...sel, sessionId] })
}

export async function resolveScope(): Promise<void> {
  const s = useFleet.getState()
  useFleet.setState({ resolving: true, preview: null })
  try {
    const preview = await window.hopline.fleet.scope(specOf(s.picked))
    useFleet.setState({ preview, selected: defaultSelection(preview), concurrency: preview.budget.concurrency, tokenBudget: preview.budget.tokens })
  } finally {
    useFleet.setState({ resolving: false })
  }
}

export async function startRun(): Promise<void> {
  const s = useFleet.getState()
  if (!s.preview || isRunning(s)) return
  early = []
  useFleet.setState({ stopAsked: false, budgetTokens: s.tokenBudget, status: 'starting', runId: null, asked: s.question.trim(), step: 'run', lanes: [], plan: [], answer: '', notes: [], usage: zero, error: undefined, endedAt: null, startedAt: Date.now() })
  try {
    const { runId } = await window.hopline.fleet.start({ scopeId: s.preview.scopeId, question: s.question.trim(), sessionIds: s.selected, concurrency: s.concurrency, tokenBudget: s.tokenBudget })
    const held = early
    early = []
    useFleet.setState({ runId })
    for (const e of held) if (e.runId === runId) applyFleetEvent(e)
    if (useFleet.getState().stopAsked) void window.hopline.fleet.cancel(runId)
  } catch (e) {
    // A scope is used once: pick it again.
    useFleet.setState({ status: 'idle', step: 'scope', preview: null, selected: [] })
    throw e
  }
}

/** Stop one device's lane; the run and the other lanes go on. */
export function stopLane(name: string): void {
  const { runId } = useFleet.getState()
  if (runId) void window.hopline.fleet.cancelLane(runId, name)
}

export function stopRun(): void {
  const { runId, status } = useFleet.getState()
  if (runId) void window.hopline.fleet.cancel(runId)
  else if (status === 'starting') useFleet.setState({ stopAsked: true })
}
