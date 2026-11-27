import { classify, classifyConfigLines, isPlatform, type Platform } from '@hopline/guard'
import { toast } from '../../lib/notify'
import { create } from 'zustand'
import type { CommandPlan, Snippet, SnippetInput } from '@shared/productivity'
import { scopeRank, snippetApplies, snippetVars } from '@shared/snippets'
import { notifyError } from '../../lib/connect'
import { sentence } from '../../lib/sentence'
import { terminals } from '../../lib/terminals'
import { sessionById, useUi } from '../../store'

const BAR_KEY = 'hopline.buttonBar'
const readBar = (): boolean | null => {
  try {
    const v = localStorage.getItem(BAR_KEY)
    return v === null ? null : v === '1'
  } catch {
    return null
  }
}

interface SnippetState {
  list: Snippet[]
  loaded: boolean
  /** The button bar row under the tabs (a per-machine view preference); null: shown once it has a button. */
  barVisible: boolean | null
  /** Snippet manager dialog: open, and which snippet is selected ('new' for a blank form). */
  editor: { open: boolean; id?: string | 'new'; draft?: Partial<SnippetInput> }
  /** Variables form for a snippet about to run on a tab. */
  vars: { snippet: Snippet; tabId: string } | null
  /** A run plan the user must confirm (config, disruptive) or read why it is refused. */
  confirm: { plan: CommandPlan; snippet: Snippet; tabId: string } | null
  load: () => Promise<void>
  save: (s: SnippetInput) => Promise<Snippet>
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => Promise<void>
  setBar: (on: boolean) => void
}

export const useSnippets = create<SnippetState>((set, get) => ({
  list: [],
  loaded: false,
  barVisible: readBar(),
  editor: { open: false },
  vars: null,
  confirm: null,
  load: async () => {
    const list = await window.hopline.snippets.list()
    set({ list, loaded: true })
  },
  save: async (s) => {
    const saved = await window.hopline.snippets.save(s)
    const list = get().list
    set({ list: list.some((x) => x.id === saved.id) ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved] })
    return saved
  },
  remove: async (id) => {
    await window.hopline.snippets.remove(id)
    set({ list: get().list.filter((x) => x.id !== id) })
  },
  reorder: async (ids) => {
    // Optimistic: the bar moves at once.
    const pos = new Map(ids.map((id, i) => [id, i]))
    const list = get().list
    set({ list: [...list].sort((a, b) => (pos.get(a.id) ?? ids.length + list.indexOf(a)) - (pos.get(b.id) ?? ids.length + list.indexOf(b))) })
    set({ list: await window.hopline.snippets.reorder(ids) })
  },
  setBar: (on) => {
    try {
      localStorage.setItem(BAR_KEY, on ? '1' : '0')
    } catch {
      /* private mode: in memory only */
    }
    set({ barVisible: on })
  }
}))

/** The session of a tab, as stored now. */
export const sessionOfTab = (tabId: string | null) => {
  const ui = useUi.getState()
  const t = ui.tabs.find((x) => x.tabId === tabId)
  return t ? sessionById(ui, t.sessionId) : undefined
}

/** Snippets that apply to a tab's session (scope and platform), closest scope first. */
export function snippetsFor(tabId: string | null, list = useSnippets.getState().list): Snippet[] {
  const s = sessionOfTab(tabId)
  if (!s) return []
  const folders = useUi.getState().folders
  return list.filter((x) => snippetApplies(x, s, folders)).sort((a, b) => scopeRank(a) - scopeRank(b))
}

/** Values the terminal learned from listings the user ran (interfaces, VLANs…), for variable autocomplete. */
export function learnedValues(tabId: string, source: string | undefined): readonly string[] {
  if (!source) return []
  return terminals.get(tabId)?.ghost?.().live[source] ?? []
}

/**
 * Use a snippet on a tab: ask for its variables, then insert it at the prompt (no Enter) or run it
 * through the guard. Read-only runs go at once; config and disruptive ones need confirmation;
 * blocked ones are refused (and audited).
 */
export async function applySnippet(snippet: Snippet, tabId: string | null = useUi.getState().activeTabId, values?: Record<string, string>): Promise<void> {
  if (!tabId) return void toast('Open a session first', { description: 'Snippets run on the focused terminal.' })
  const tab = useUi.getState().tabs.find((t) => t.tabId === tabId)
  if (tab?.state !== 'connected') return void toast('This session is not connected', { description: `${tab?.title ?? 'The tab'} has to be connected to use “${snippet.name}”.` })
  const vars = snippetVars(snippet.body)
  if (vars.length && !values) return useSnippets.setState({ vars: { snippet, tabId } })
  const v = values ?? {}
  try {
    if (snippet.mode === 'insert') {
      const r = await window.hopline.snippets.insert(snippet.id, tabId, v)
      terminals.get(tabId)?.blocks?.sent(r.text)
      window.hopline.term.write(tabId, r.text)
      terminals.get(tabId)?.focus()
      return
    }
    const plan = await window.hopline.snippets.prepare(snippet.id, tabId, v)
    if (plan.kind === 'read') return void (await finish(snippet, tabId, plan.planId, true))
    if (plan.kind === 'blocked' || plan.kind === 'refused') {
      // Recorded in the audit log as an attempt; nothing reaches the device.
      await window.hopline.snippets.run(plan.planId, false).catch(() => {})
      return void toast.error(`${plan.kind === 'blocked' ? 'Blocked' : 'Not run'}: ${snippet.name}`, { description: sentence(plan.reason) })
    }
    useSnippets.setState({ confirm: { plan, snippet, tabId } })
  } catch (e) {
    notifyError(`Could not use “${snippet.name}”`, e)
  }
}

/** Run (or decline) a prepared plan and report the outcome. */
export async function finish(snippet: Snippet, tabId: string, planId: string, approve: boolean, ack?: string): Promise<void> {
  terminals.get(tabId)?.focus()
  try {
    const r = await window.hopline.snippets.run(planId, approve, ack)
    if (r.status === 'ok') return
    // Declined by the user: they know, and a toast here would sit over the next dialog's buttons.
    if (r.status === 'rejected') return
    toast.error(`${snippet.name}: ${r.status}`, { description: sentence(r.reason) })
  } catch (e) {
    notifyError(`Could not run “${snippet.name}”`, e)
  }
}

export type GuardHint = 'read' | 'config' | 'disruptive' | 'blocked'
const hints = new Map<string, GuardHint | null>()

/**
 * What the guard will probably make of a run snippet on a platform, for the button bar's dot only.
 * It mirrors the runner's shape (all show commands → read; one exec line → its class; otherwise the
 * lines as a config change), with {{variables}} filled by a placeholder. Display only: main
 * classifies the real lines again at prepare and at run, and that decision is the one that counts.
 */
export function guardHint(snippet: Pick<Snippet, 'body' | 'mode'>, platform: string | undefined): GuardHint | null {
  if (snippet.mode !== 'run' || !platform || !isPlatform(platform)) return null
  const key = `${platform}\0${snippet.body}`
  if (hints.has(key)) return hints.get(key)!
  const lines = snippet.body
    .replace(/\{\{\s*[A-Za-z_][\w-]*\s*\}\}/g, 'X1')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  let hint: GuardHint | null = null
  if (lines.length) {
    const exec = lines.map((l) => classify(l, platform as Platform))
    if (exec.every((v) => v.kind === 'read')) hint = 'read'
    else if (lines.length === 1 && exec[0]!.resolved) hint = exec[0]!.kind === 'read' ? 'read' : (exec[0]!.kind as GuardHint)
    else {
      const cfg = classifyConfigLines(lines, platform as Platform)
      hint = cfg.some((v) => v.kind === 'blocked') ? 'blocked' : cfg.some((v) => v.kind === 'disruptive') ? 'disruptive' : 'config'
    }
  }
  if (hints.size > 500) hints.clear()
  hints.set(key, hint)
  return hint
}
