import { treeRow } from '../fixtures'
import { expect, type Page } from '@playwright/test'
import { fakeOllama, type OllamaChatBody, type OllamaTurn } from '../../test/fake-llm'
import { picture } from './example-session'

const question = 'Why is BGP between 10.0.0.5 and 10.0.0.6 stuck in Active? Check both ends and quote the device output that explains it.'
const tool = (name: string, args: unknown): OllamaTurn => ({ tools: [{ name, arguments: args }] })

/** Only the model's choices are scripted. Evidence for each report comes from that worker's SSH reads. */
function bgpInvestigation({ messages = [] }: OllamaChatBody): OllamaTurn {
  const system = messages[0]?.content ?? ''
  const replies = messages.filter(m => m.role === 'tool')
  if (system.includes('fleet coordinator')) {
    if (!replies.length) {
      const devices = Array.from(system.matchAll(/^\| ([^|\n]+) \| [^|\n]+ \| - \|$/gm), m => m[1]!.trim())
      return tool('dispatch_tasks', { tasks: devices.map(device => ({ device, task: 'Check the BGP peer state and the TCP digest errors for this adjacency.' })) })
    }
    return { text: 'Both routers reject TCP authentication for this BGP session.\n\n- **IOS XE** reports an invalid MD5 digest from **10.0.0.6**.\n- **Junos** reports a wrong MD5 digest from **10.0.0.5**.\n\nAsk the peer owners to verify the intended key and the rotation window. The logs do not identify which key is correct.' }
  }

  const junos = /Your device: .*junos/i.test(system)
  const peer = junos ? '10.0.0.5' : '10.0.0.6'
  const summary = junos ? 'show bgp summary' : 'show ip bgp summary'
  const log = junos ? 'show log messages' : 'show logging'
  if (!replies.length) return tool('run_show_command', { command: summary, reason: 'Check the peering state' })
  if (replies.length === 1) return tool('run_show_command', { command: log, reason: 'Find TCP authentication errors for the peer' })

  const matchingLines = (output: string, match: (line: string) => boolean) =>
    output.split('\n').map(line => line.trim()).filter(match).slice(0, 1)
  return tool('submit_report', {
    status: 'found', confidence: 'high',
    findings: [`This router rejects the TCP digest from ${peer} on port 179.`],
    evidence: [
      { command: summary, lines: matchingLines(replies[0]!.content, line => line.startsWith(peer) && /Active|Idle/i.test(line)) },
      { command: log, lines: matchingLines(replies[1]!.content, line => line.includes(peer) && /MD5 digest/i.test(line)) }
    ]
  })
}

export async function captureBgpInvestigation(page: Page) {
  const model = await fakeOllama({ models: ['qwen3:8b'], route: bgpInvestigation })
  try {
    await page.evaluate(url => window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: url, ollamaModel: 'qwen3:8b' }), model.url)
    await page.reload()
    await treeRow(page, 'Transit peering').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Investigate across devices…' }).click()
    const view = page.getByRole('dialog', { name: 'Investigate across devices' })
    await view.getByRole('button', { name: 'Resolve scope' }).click()
    await view.getByLabel('Question').fill(question)
    const start = view.getByRole('button', { name: 'Investigate 2 devices' })
    await expect(start).toBeEnabled()
    await picture(page, 'bgp-peer-auth', '07-ask-both-routers', undefined, view)
    await start.click()
    await expect(view.getByTestId('fleet-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
    for (const [device, peer] of [['Campus core', '10.0.0.6'], ['Transit edge', '10.0.0.5']] as const) {
      const lane = view.locator(`section[data-lane="${device}"]`)
      await expect(lane).toHaveAttribute('data-status', 'found')
      const evidence = lane.getByTestId('evidence-line')
      await expect(evidence).toHaveCount(2)
      await expect(evidence.first()).toContainText(peer)
      await expect(evidence.last()).toContainText(/MD5 digest/i)
      await expect(lane.getByTestId('report-flag')).toHaveCount(0)
    }
    await expect(view.getByTestId('fleet-answer')).toContainText('Both routers reject TCP authentication')
    await picture(page, 'bgp-peer-auth', '08-read-both-reports', 410, view)
  } finally {
    await model.close()
  }
}
