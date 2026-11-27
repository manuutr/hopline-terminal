import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { DeviceCaptureOptions, DeviceCapturePlan } from '@shared/packets'
import { analyze, type GuardedRunner } from '../productivity/runner'

export type Prepared = DeviceCapturePlan & { tabId: string; sessionId: string; expires: number }

export async function prepareDevice(runner: GuardedRunner, { tabId, device, seconds, direction, match }: DeviceCaptureOptions): Promise<Prepared> {
  const tab = runner.term.get(tabId)
  if (tab?.session.platform !== 'iosxe' || tab.session.protocol !== 'ssh') throw new Error('Connect an IOS XE session over SSH to collect on the device.')
  const { hostname, mode } = await runner.term.prompt(tab)
  if (mode !== 'exec' || !hostname) throw new Error('Open the privileged EXEC prompt before starting a capture.')
  const id = randomUUID()
  const name = 'H' + id.slice(0, 7)
  const prefix = 'monitor capture ' + name
  const remotePath = 'flash:' + name + '.pcap'
  let selector = 'any'
  if (match) {
    const family = match.address.includes(':') ? 'ipv6' : 'ipv4'
    selector = family + (match.side === 'source' ? ' host ' + match.address + ' any' : ' any host ' + match.address)
  }
  const commands = [
    `${prefix} interface ${device} ${direction}`, prefix + ' match ' + selector,
    `${prefix} limit duration ${seconds} packets 1000`, `${prefix} file location ${remotePath}`,
    prefix + ' start', prefix + ' stop', 'no ' + prefix
  ]
  for (const command of commands) {
    const a = analyze('iosxe', [command], { readOnlyMode: runner.readOnlyMode(), policy: runner.policyRules() })
    if (a.kind !== 'disruptive' || a.shape !== 'exec') throw new Error(a.reason)
  }
  return { id, tabId, sessionId: tab.session.id, hostname, commands, remotePath, seconds, expires: Date.now() + 5 * 60_000 }
}

export async function collectDevice(runner: GuardedRunner, plan: Prepared, ack: string, signal: AbortSignal, finish: AbortSignal, owns: () => boolean, stage: (s: string, canFinish?: boolean) => void) {
  const { commands, tabId } = plan
  const run = async (command: string, stop?: AbortSignal) => {
    const tab = runner.term.get(tabId)
    if (!owns() || tab?.session.id !== plan.sessionId || tab.session.platform !== 'iosxe') throw new Error('The capture session changed.')
    const a = analyze('iosxe', [command])
    const r = await runner.run(tabId, a, { source: 'capture', approved: true, hostname: plan.hostname, ack, signal: stop, session: tab.session })
    // A busy interface can reach the packet limit before the operator clicks Stop.
    if (command === commands.at(-2) && (r.status === 'ok' || r.status === 'error') &&
        /^(?:%\s*)?(?:error:\s*)?capture\b[^\r\n]{0,80}\b(?:not (?:active|running)|already stopped)\b/im.test(r.output)) return
    if (r.status !== 'ok') throw new Error(r.reason || r.status)
    if (/^\s*(?:%\s*)?(?:failed to|unable to|error:)/im.test(r.output)) throw new Error(r.output.trim().slice(-500))
  }
  let configured = false
  let startAttempted = false
  const errors: string[] = []
  try {
    for (const command of commands.slice(0, -2)) {
      signal.throwIfAborted()
      stage(command)
      if (command === commands.at(-3)) startAttempted = true
      await run(command, signal)
      configured = true
    }
    stage(`Capturing on ${plan.hostname} for up to ${plan.seconds} s…`, true)
    try { await delay((plan.seconds + 1) * 1000, undefined, { signal: AbortSignal.any([signal, finish]) }) }
    catch (e) { if (signal.aborted || !finish.aborted) throw e }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  } finally {
    // The device-side duration is armed before start, including if SSH drops.
    // On natural expiry the point is already stopped. On cancel stop it before removing it.
    if (configured) {
      if (startAttempted && (signal.aborted || finish.aborted || errors.length)) {
        try { await run(commands.at(-2)!) } catch (e) { errors.push(String(e)) }
      }
      stage('Releasing the device capture point…')
      try { await run(commands.at(-1)!) } catch (e) { errors.push(`Check the capture point on the device: ${String(e)}`) }
    }
  }
  if (errors.length) throw new Error(errors.join('\n') + (configured ? '\nDevice capture file: ' + plan.remotePath : ''))
}
