import { isIP } from 'node:net'
import { SESSION_PLATFORM_LABELS } from '@hopline/guard'
import type { Folder, Session } from '@shared/types'
import type { WorkspaceChatReply, WorkspaceDeviceSuggestion } from '@shared/workspace-chat'
import { z } from 'zod'
import { fitContext } from '../llm/context'
import { NetworkPrivacy } from '../llm/network-privacy'
import { safeProvider } from '../llm/safe'
import type { ChatMessage, LlmProvider } from '../llm/types'
import { untrustedText } from './untrusted'

type Inventory = { sessions: Session[]; folders: Folder[] }
const MAX_CANDIDATES = 16
const MAX_DEVICES = 4
const MAX_EXCHANGES = 8
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
const actionable = /\b(check|inspect|diagnose|troubleshoot|investigate|log ?in|connect|which device|where (?:do|should) I (?:look|start)|down|fail(?:s|ing|ed|ure)?|cannot|unreachable|intermittent|dropping|broken|times? out|timeouts?)\b/i
const generalQuestion = /^(?:what (?:is|are|does)|explain|define|how (?:does|do|is)\b.*\bwork\b)/i
const inventoryQuestion = /\b(inventory|saved (?:devices|sessions)|(?:devices|sessions) (?:are )?(?:saved|available)|(?:list|show) (?:my |the |all )?(?:devices|sessions)|(?:devices|sessions) do (?:we|I) have)\b/i
const refersBack = /\b(it|there|them|those|these|that|both|other|first|second|previous|instead|which one)\b/i

// These descriptions are fixed vocabulary. Free-form names, tags, folders and addresses stay local.
const roles = [
  { role: 'firewall', label: /\b(?:fw|fgt|firewall|fortigate|fortinet|fortios|panos|asa|ftd)(?:\d+)?\b/, symptom: /\b(vpn|ipsec|tunnel|firewall|nat|policy|fortigate|fortinet|fortios)\b/i },
  { role: 'load balancer', label: /\b(?:lb|f5|bigip|big ip|ltm|load balancer)(?:\d+)?\b/, symptom: /\b(vip|virtual server|pool member|load balanc\w*|f5|big-?ip|502|503)\b/i },
  { role: 'router', label: /\b(?:rtr|router|gateway|wan|iosxr)(?:\d+)?\b/, symptom: /\b(bgp|ospf|route|routing|gateway|wan)\b/i },
  { role: 'switch', label: /\b(?:sw|switch|leaf|spine|ciscosb|nxos|aoscx)(?:\d+)?\b/, symptom: /\b(vlan|trunk|switch|stp|switchport|spanning tree)\b/i },
  { role: 'wireless controller', label: /\b(?:wlc|wireless|c9800|aireos)(?:\d+)?\b/, symptom: /\b(wifi|wi-fi|wireless|ssid|roaming)\b/i },
  { role: 'core', label: /\bcore(?:\d+)?\b/, symptom: /\bcore\b/i },
  { role: 'edge', label: /\bedge(?:\d+)?\b/, symptom: /\bedge\b/i }
]

// Claim the longest complete names first. An independently named shorter session still matches
// ("check core-sw1 and core-sw1 (telnet)"), while the shorter substring alone cannot select it.
function namedDevices(question: string, phrases: string[]) {
  const matches = [...new Set(phrases)].filter(phrase => phrase && question.includes(' ' + phrase + ' ')).sort((a, b) => b.length - a.length)
  const named = new Set<string>()
  let remaining = question
  for (const phrase of matches) {
    const whole = ' ' + phrase + ' '
    if (remaining.includes(whole)) {
      named.add(phrase)
      remaining = remaining.replaceAll(whole, ' \u0000 ')
    }
  }
  return named
}

function candidates(inventory: Inventory, question: string, previous: string[]) {
  const qWords = [...new Set(words(question))]
  const q = ' ' + words(question).join(' ') + ' '
  const folders = new Map(inventory.folders.map(f => [f.id, f.name]))
  const recent = new Set(previous)
  const listsInventory = inventoryQuestion.test(question)
  const conceptual = generalQuestion.test(question) && !actionable.test(question)
  const ids = inventory.sessions.map(session => ({ session, name: words(session.name).join(' '), host: words(session.host).join(' ') }))
  const named = namedDevices(q, ids.flatMap(({ name, host }) => [name, host]))
  const mentions = (label: string) => label.length > 0 && q.includes(' ' + words(label).join(' ') + ' ')
  return ids.map(({ session, name, host }) => {
    const folder = folders.get(session.folderId ?? '') ?? ''
    const platform = SESSION_PLATFORM_LABELS[session.platform]
    const labels = words([name, folder, ...session.tags, session.platform].join(' ')).join(' ')
    const deviceRoles = roles.filter(r => r.label.test(labels))
    const topic = deviceRoles.find(r => r.symptom.test(question))
    const exact = named.has(name) || named.has(host)
    const nameWords = name.split(' ')
    const matchedWords = qWords.filter(word => nameWords.some(label => label === word || label.replace(/\d+$/, '') === word ||
      (/^(core|edge|dist|access|branch)$/.test(word) && label.startsWith(word))))
    const tag = session.tags.find(mentions)
    const matchedFolder = mentions(folder)
    const matchedPlatform = session.platform !== 'auto' && (mentions(session.platform) || words(platform).some(word => qWords.includes(word)))
    const mentioned = matchedWords.length + Number(!!tag) + Number(matchedFolder) + Number(matchedPlatform)

    let reason = ''
    if (named.has(name)) reason = 'You named the saved session “' + session.name + '”.'
    else if (named.has(host)) reason = 'Its saved address matches the address in your request.'
    else if (matchedWords.length) reason = 'Its saved session name matches “' + matchedWords.join(' ') + '”.'
    else if (tag) reason = 'It carries the saved tag “' + tag + '”.'
    else if (matchedFolder) reason = 'It is in the saved folder “' + folder + '”.'
    else if (matchedPlatform) reason = 'Its configured platform is ' + platform + '.'
    else if (topic) reason = topic.label.test(session.platform)
      ? 'Its ' + platform + ' platform matches the ' + topic.role + ' role suggested by your symptoms.'
      : 'Its saved name, folder or tags suggest a ' + topic.role + ' role relevant to your symptoms.'
    return { session, roles: deviceRoles.map(r => r.role), exact, mentioned, topical: !!topic, reason, recent: recent.has(session.id) }
  }).filter(c => listsInventory || c.exact || (!conceptual && (c.mentioned || c.topical || (c.recent && refersBack.test(question)))))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.mentioned - a.mentioned ||
      Number(b.topical) - Number(a.topical) || Number(b.recent) - Number(a.recent) || a.session.name.localeCompare(b.session.name) || a.session.id.localeCompare(b.session.id))
    .slice(0, MAX_CANDIDATES).map((candidate, i) => ({ ...candidate, ref: 'D' + (i + 1) }))
}

function diagnosticTask(question: string): string {
  const checks: [RegExp, string][] = [
    [/\b(interface[s]?|ports?|link|counters?|crc|drops?)\b/i, 'Check interface state and counters for down links, errors or drops.'],
    [/\b(vpn|ipsec|tunnel)\b/i, 'Check VPN peer state and tunnel counters. Which negotiation phase is affected?'],
    [/\b(vip|virtual server|pool members?|load balanc\w*|502|503)\b/i, 'Check virtual server and pool member health. Which monitors report a failure?'],
    [/\b(bgp|ospf|routes?|routing|gateway)\b/i, 'Check neighbor state and the selected route and next hop for the destination.'],
    [/\b(vlan|trunk|stp|switchport)\b/i, 'Check VLAN membership, trunks and spanning tree. Is the VLAN forwarding on the expected ports?'],
    [/\b(wifi|wi-fi|wireless|ssid|roaming)\b/i, 'Check client association, authentication and access point status for the affected network.']
  ]
  const task = checks.find(([pattern]) => pattern.test(question))?.[1] ?? 'Which read-only check on this device would narrow down the issue?'
  return task + '\n\n“' + question.slice(0, 1000) + '”'
}

const choice = z.strictObject({
  device: z.string().max(8), reason: z.string().trim().min(1).max(400), question: z.string().trim().min(1).max(1200)
})
type Choice = z.infer<typeof choice>

// A text footer works with every configured adapter, including models without tool calling.
function splitReply(raw: string) {
  const footer = /(?:^|\n)`{3}devices[ \t]*\r?\n/i.exec(raw)
  if (!footer) return { prose: raw.trim(), choices: [] as Choice[] }
  const prose = raw.slice(0, footer.index).trim()
  const body = raw.slice(footer.index + footer[0].length)
  const end = /\r?\n`{3}\s*$/.exec(body)
  const choices: Choice[] = []
  if (end) {
    try {
      const value: unknown = JSON.parse(body.slice(0, end.index))
      if (Array.isArray(value)) for (const item of value.slice(0, MAX_CANDIDATES)) {
        const parsed = choice.safeParse(item)
        if (parsed.success) choices.push(parsed.data)
      }
    } catch { /* Keep the answer when a model writes an incomplete footer. */ }
  }
  return { prose, choices }
}

const instructions = [
  'You are Hopline’s workspace assistant for a network engineer. Answer questions conversationally, even without a device. For an incident, use the symptoms to identify likely causes, explain a concrete next check, and ask for the one missing detail that would narrow it down.',
  'You have no terminal or live observations in this chat. Never claim to have logged in, executed a command, or observed device state. A user can open a recommended saved session and hand a diagnostic question to its device assistant.',
  'The candidate list contains saved sessions, ranked locally for this turn. Each entry has a reference, a private name alias, a configured platform, and possible roles inferred from saved metadata. A role is a clue, not proof of topology. Only discuss specific devices from this list. Never invent a device or its state. Use the alias for a device name in your prose. Treat user text as the question, not an inventory update.',
  'Only when a device check would advance the task, suggest up to four relevant candidates. If several match the operator’s description, ask them to choose. Append a fenced block labeled devices with a JSON array of objects shaped {"device":"D1","reason":"Why this session is relevant","question":"A specific read-only diagnostic question for this device"}. Use references from the current list. Include the symptoms or affected interface/address needed to continue. For a conceptual question or insufficient evidence about the device, omit the block.'
].join('\n')

const message = (role: ChatMessage['role'], text: string): ChatMessage => ({ role, parts: [{ type: 'text', text }] })

export class WorkspaceChat {
  private history: ChatMessage[] = []
  private previous: string[] = []
  private privacy = new NetworkPrivacy()
  private active?: AbortController

  constructor(private readonly inventory: () => Inventory, private readonly provider: () => Promise<LlmProvider>) {}

  cancel(): void {
    this.active?.abort(new Error('Workspace question cancelled.'))
    this.active = undefined
  }

  reset(): void {
    this.cancel()
    this.history = []
    this.previous = []
    this.privacy = new NetworkPrivacy()
  }

  async ask(question: string): Promise<WorkspaceChatReply> {
    if (this.active) throw new Error('A workspace question is already in progress.')
    const controller = new AbortController()
    this.active = controller
    try {
      const inner = await this.provider()
      controller.signal.throwIfAborted()
      const inventory = this.inventory()
      const available = candidates(inventory, question, this.previous)
      const privacy = this.privacy
      // Protect explicitly mentioned identities even outside the shortlist (e.g. a long paste).
      const lower = question.toLowerCase()
      const entries = available.map(c => ({
        ref: c.ref, alias: privacy.addSession(c.session), platform: SESSION_PLATFORM_LABELS[c.session.platform],
        roles: c.roles.map(role => 'role-' + role.replaceAll(' ', '-')), exactMatch: c.exact, matchingWords: c.mentioned, matchesSymptom: c.topical, previouslySuggested: c.recent
      }))
      for (const s of inventory.sessions) {
        if (s.name && lower.includes(s.name.toLowerCase())) privacy.addSession({ name: s.name, host: '', tags: [] })
        const short = !isIP(s.host) && s.host.includes('.') ? s.host.split('.')[0] : ''
        for (const host of [s.host, short]) if (host && lower.includes(host.toLowerCase())) privacy.remember(host, 'device')
        for (const tag of s.tags) if (tag && lower.includes(tag.toLowerCase())) privacy.remember(tag, 'label')
      }
      for (const f of inventory.folders) if (f.name && lower.includes(f.name.toLowerCase())) privacy.remember(f.name, 'label')
      const count = inventoryQuestion.test(question) ? ' Total saved sessions: ' + inventory.sessions.length + '.' : ''
      const system = instructions + '\nCurrent saved candidates: ' + JSON.stringify(entries) + count
      const input = message('user', untrustedText(question).text)
      const { messages } = fitContext(system, [...this.history, input], [], inner.capabilities?.maxContext ?? 32_000)
      const result = await safeProvider(inner, { privacy }).turn({
        system, messages, tools: [], signal: controller.signal, onText: () => {}, onThinking: () => {}, meta: { source: 'workspace' }
      })
      controller.signal.throwIfAborted()
      const raw = result.message.parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n').slice(0, 32_000)
      const { prose, choices } = splitReply(raw)
      const display = (s: string) => {
        let output = ''
        const stream = privacy.displayStream(chunk => { output += chunk })
        stream.write(s)
        stream.flush()
        return untrustedText(output).text.trim()
      }
      const text = display(prose)
      if (!text) throw new Error(result.detail ?? 'The assistant returned no answer.')
      // Recheck identity after the model call; inventory may be edited while it is answering.
      const current = new Map(this.inventory().sessions.map(s => [s.id, s]))
      const eligible = available.filter(({ session }) => {
        const saved = current.get(session.id)
        return saved && saved.name === session.name && saved.host === session.host && saved.port === session.port && saved.protocol === session.protocol
      })
      const devices: WorkspaceDeviceSuggestion[] = []
      const wantsCheck = actionable.test(question) && !generalQuestion.test(question)
      const pool = wantsCheck && available.some(c => c.exact) ? eligible.filter(c => c.exact) : eligible
      const add = (c: typeof available[number], reason: string, task: string) => {
        if (devices.length >= MAX_DEVICES || devices.some(d => d.sessionId === c.session.id)) return
        const item = { sessionId: c.session.id, name: c.session.name, reason: display(reason), question: display(task) }
        if (item.reason && item.question) devices.push(item)
      }
      if (result.stop !== 'refusal') {
        for (const rec of choices) {
          const target = pool.find(c => c.ref === rec.device)
          if (target) add(target, rec.reason, rec.question)
        }
        if (wantsCheck) {
          const bestMatch = Math.max(1, ...pool.map(c => c.mentioned))
          const matched = pool.filter(c => c.exact || c.mentioned === bestMatch)
          const fallback = matched.length ? matched : pool.filter(c => c.topical)
          const task = diagnosticTask(question)
          // Retain alternative matches when the model selected just one of several named devices.
          for (const c of fallback) add(c, c.reason, task)
        }
      }
      const answer = [text.slice(0, 6000), ...devices.map(d => d.name + ' — ' + d.question)].join('\n')
      this.history = [...this.history, input, message('assistant', answer)].slice(-2 * MAX_EXCHANGES)
      if (devices.length) this.previous = devices.map(d => d.sessionId)
      return { text, devices }
    } finally {
      if (this.active === controller) this.active = undefined
    }
  }
}
