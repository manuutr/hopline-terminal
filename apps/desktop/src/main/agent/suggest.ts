import { classify, isPlatform, type Platform } from '@hopline/guard'
import { randomUUID } from 'node:crypto'
import type { AgentSuggestion } from '@shared/types'
import { policyBlocked, type BlockRules } from '@shared/policy-deny'
import { checkProposal } from './config-apply'

/**
 * Suggest mode: a model without tool calling (many small Ollama models) proposes commands as text,
 * and the user clicks to run each one. Main extracts the commands from the model's answer,
 * classifies them with the guard, and keeps them here under random ids; the renderer only sends an
 * id back, so it can never run text of its own through this path. A clicked suggestion runs
 * through `DeviceTools` exactly like the model's own tool call, with the user as approver (reads),
 * or as a proposal card (configuration lines, disruptive commands).
 */

export const SUGGEST_RULES = `
This model cannot run commands itself (no tool calling): you are in suggest mode.
- When you need device output, propose the exact CLI commands inside ONE fenced code block (\`\`\`), one command per line, nothing else in the block, and stop. The user runs each one; its output is added to the conversation.
- For a configuration change, put only the configuration lines (as typed inside configuration mode, without "configure terminal" or "end") in a separate fenced block, and say what it does. The user approves it like any change.
- Never invent command output. Use only output that appears in the conversation.`

/** At most this many suggestions per answer; the rest are ignored. */
export const MAX_SUGGESTIONS = 10
/** How long a suggestion can be clicked. */
export const SUGGESTION_TTL_MS = 30 * 60_000
const MAX_LINE = 512

/** A device prompt in front of a command ("core-sw1#show ip int br", "admin@fw> show ..."). */
const PROMPT = /^(?:[\w.:/@()-]{1,64}[#>$%]\s*)+/

/** Command lines from an answer: every line of every fenced block, plus "RUN: …" lines. */
export function extractCommandBlocks(text: string): string[][] {
  const blocks: string[][] = []
  const fence = /```[^\n`]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(text))) {
    const lines = m[1]!
      .split('\n')
      .map((l) => l.replace(/\s+$/, '').replace(/^\s+/, ''))
      .map((l) => {
        const stripped = l.replace(PROMPT, '')
        return stripped.trim() ? stripped.trim() : l
      })
      .filter((l) => l && !/^(!|#|\/\/)/.test(l) && l.length <= MAX_LINE)
    if (lines.length) blocks.push(lines)
  }
  const outside = text.replace(fence, '')
  for (const line of outside.split('\n')) {
    const r = /^\s*RUN:\s*`?([^`]+?)`?\s*$/i.exec(line)
    if (r && r[1]!.length <= MAX_LINE) blocks.push([r[1]!.trim()])
  }
  return blocks
}

interface Stored extends AgentSuggestion {
  tabId: string
  at: number
}

/**
 * Turn an answer into suggestions for one platform: each read command is its own suggestion; a
 * disruptive exec command too (it runs as a red card with the typed hostname); the configuration
 * lines of a block become one suggestion that opens a proposal card. Blocked lines are shown with
 * the guard's reason and cannot be run.
 */
export function classifySuggestions(blocks: string[][], platform: string, policy?: BlockRules): AgentSuggestion[] {
  const out: AgentSuggestion[] = []
  const known = isPlatform(platform)
  for (const block of blocks) {
    const config: string[] = []
    for (const line of block) {
      if (!known) {
        out.push({ id: randomUUID(), commands: [line], kind: 'blocked', reason: 'the device platform is unknown, so every command is refused until you set the platform' })
        continue
      }
      const v = classify(line, platform as Platform)
      const denied = policy ? policyBlocked(policy, platform, line) : null
      if (denied || v.kind === 'blocked') out.push({ id: randomUUID(), commands: [v.command || line], kind: 'blocked', reason: denied ?? v.reason })
      else if (v.kind === 'read') out.push({ id: randomUUID(), commands: [v.command], kind: 'read', reason: v.reason })
      else if (v.kind === 'disruptive' && v.resolved) out.push({ id: randomUUID(), commands: [v.command], kind: 'disruptive', reason: v.reason })
      else config.push(line)
    }
    if (config.length) {
      // Only for the label: the proposal itself is checked again when the card is made.
      const checked = checkProposal(platform as Platform, config)
      const risky = 'disruptive' in checked && checked.disruptive.length > 0
      out.push({
        id: randomUUID(),
        commands: config,
        kind: 'config',
        reason: risky ? `configuration lines, disruptive: ${checked.disruptive[0]}. Opens a proposal card that asks for the hostname` : 'configuration lines: opens a proposal card for your approval',
        ...(risky ? { disruptive: true as const } : {})
      })
    }
  }
  // Duplicates (the same command proposed twice) are shown once.
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = s.commands.join('\n')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, MAX_SUGGESTIONS)
}

/** Suggestions waiting for a click, by id. A new answer on the same tab replaces the tab's old ones. */
export class SuggestionStore {
  private items = new Map<string, Stored>()

  constructor(private readonly now: () => number = Date.now) {}

  put(tabId: string, items: AgentSuggestion[]): void {
    this.dropTab(tabId)
    for (const s of items) this.items.set(s.id, { ...s, tabId, at: this.now() })
  }

  /** The suggestion, once: it is removed whether or not it can run. */
  take(id: string): Stored | null {
    const s = this.items.get(id)
    if (!s) return null
    this.items.delete(id)
    if (this.now() - s.at > SUGGESTION_TTL_MS) return null
    return s
  }

  peek(id: string): Stored | undefined {
    return this.items.get(id)
  }

  dropTab(tabId: string): void {
    for (const [id, s] of this.items) if (s.tabId === tabId) this.items.delete(id)
  }
}
