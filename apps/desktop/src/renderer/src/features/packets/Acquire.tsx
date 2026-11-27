import { useState } from 'react'
import { Cable, FileUp } from 'lucide-react'
import type { DeviceCapturePlan } from '@shared/packets'
import { Button, Input, Segmented, SelectMenu } from '../../design'
import { useUi } from '../../store'
import { openTrace, packetTask, usePackets } from './store'

function Duration({ value, change }: { value: number; change: (n: number) => void }) {
  return <label className="grid gap-1 text-xs text-fg-muted">Duration (s)
    <Input type="number" min={1} max={120} value={value || ''} onChange={(e) => change(Number(e.target.value))} />
  </label>
}

function DeviceSource({ tabId, iosxe }: { tabId: string; iosxe: boolean }) {
  const [mode, setMode] = useState<'receive' | 'collect'>(iosxe ? 'collect' : 'receive')
  const [path, setPath] = useState('')
  const [device, setDevice] = useState('')
  const [seconds, setSeconds] = useState(10)
  const [direction, setDirection] = useState<'in' | 'out' | 'both'>('both')
  const [side, setSide] = useState<'any' | 'source' | 'destination'>('any')
  const [address, setAddress] = useState('')
  const [plan, setPlan] = useState<DeviceCapturePlan | null>(null)
  const [ack, setAck] = useState('')
  if (plan) return <div className="space-y-3">
    <p className="text-sm text-fg">Review capture on <strong>{plan.hostname}</strong></p>
    <pre className="overflow-auto rounded-md bg-surface p-3 font-mono text-xs">{plan.commands.join('\n')}</pre>
    <p className="text-xs text-fg-muted">The device stops after {plan.seconds} seconds or 1,000 packets. Hopline removes the capture point and downloads {plan.remotePath}. The file stays on the device.</p>
    <div className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-xs text-fg-muted">Type {plan.hostname} to approve
      <Input value={ack} onChange={(e) => setAck(e.target.value)} /></label>
      <Button variant="danger-solid" disabled={ack !== plan.hostname} onClick={() => { setPlan(null); void openTrace({ kind: 'iosxe', planId: plan.id, ack }) }}>Capture and transfer</Button>
      <Button onClick={() => setPlan(null)}>Back</Button></div>
  </div>
  return <div className="space-y-3">
    {iosxe && <Segmented label="Device capture source" value={mode} onChange={setMode} items={[{ value: 'collect', label: 'IOS XE capture' }, { value: 'receive', label: 'Existing device file' }]} />}
    {mode === 'collect' ? <div className="flex flex-wrap items-end gap-2">
      <label className="grid min-w-44 flex-1 gap-1 text-xs text-fg-muted">Device interface<Input placeholder="GigabitEthernet1/0/1" maxLength={64} value={device} onChange={(e) => setDevice(e.target.value)} /></label>
      <div className="w-24"><Duration value={seconds} change={setSeconds} /></div>
      <div className="w-24 space-y-1"><label htmlFor="packet-direction" className="text-xs text-fg-muted">Direction</label>
        <SelectMenu id="packet-direction" aria-label="Direction" value={direction} onValueChange={setDirection} options={[{ value: 'both', label: 'Both' }, { value: 'in', label: 'Ingress' }, { value: 'out', label: 'Egress' }]} /></div>
      <div className="w-32 space-y-1"><label htmlFor="packet-match" className="text-xs text-fg-muted">Match traffic</label>
        <SelectMenu id="packet-match" aria-label="Match traffic" value={side} onValueChange={setSide} options={[{ value: 'any', label: 'Any' }, { value: 'source', label: 'Source host' }, { value: 'destination', label: 'Destination host' }]} /></div>
      {side !== 'any' && <label className="grid gap-1 text-xs text-fg-muted">Host address<Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.0.2.10" /></label>}
      <Button disabled={(side !== 'any' && !address.trim()) || !device.trim() || !Number.isInteger(seconds) || seconds < 1 || seconds > 120} onClick={() => void packetTask('Preparing device commands…', async () => {
        const preview = await window.hopline.packets.plan({ tabId, device: device.trim(), seconds, direction, ...(side === 'any' ? {} : { match: { side, address: address.trim() } }) })
        setAck(''); setPlan(preview)
      })}>Preview capture…</Button>
    </div> : <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
      e.preventDefault(); if (path.trim()) void openTrace({ kind: 'remote', tabId, path: path.trim() })
    }}>
      <label className="grid min-w-48 flex-1 gap-1 text-xs text-fg-muted">Capture file on device
        <Input value={path} maxLength={1024} placeholder="flash:incident.pcap or /tmp/incident.pcapng" onChange={(e) => setPath(e.target.value)} /></label>
      <Button variant="primary" type="submit" disabled={!path.trim()}>Transfer and analyze</Button>
    </form>}
  </div>
}

export function Acquire() {
  const [source, setSource] = useState<'file' | 'ssh'>('file')
  const [choice, setChoice] = useState('')
  const tabs = useUi((s) => s.tabs)
  const saved = useUi((s) => s.sessions)
  const quick = useUi((s) => s.quick)
  const active = useUi((s) => s.activeTabId)
  const ssh = tabs.flatMap((tab) => {
    const session = [...saved, ...quick].find((s) => s.id === tab.sessionId)
    return tab.state === 'connected' && session?.protocol === 'ssh' ? [{ tab, session }] : []
  })
  const target = ssh.find((x) => x.tab.tabId === choice) ?? ssh.find((x) => x.tab.tabId === active) ?? ssh[0]
  return <div className="space-y-4">
    <Segmented label="Capture source" value={source} onChange={(v) => {
      setSource(v); usePackets.setState({ error: '' })
    }} items={[{ value: 'file', label: 'Capture file', icon: <FileUp /> }, { value: 'ssh', label: 'SSH device', icon: <Cable /> }]} />
    {source === 'file' && <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" onClick={() => void openTrace({ kind: 'file' })}>Open capture…</Button>
      <span className="text-xs text-fg-muted">PCAP or PCAPNG · up to 64 MiB</span></div>}
    {source === 'ssh' && (target ? <div className="space-y-3"><div className="max-w-sm space-y-1">
      <label htmlFor="packet-tab" className="text-xs text-fg-muted">Connected session</label>
      <SelectMenu id="packet-tab" aria-label="Connected session" value={target.tab.tabId} onValueChange={setChoice} options={ssh.map(({ tab, session }) => ({ value: tab.tabId, label: session.name }))} /></div>
      <DeviceSource key={target.tab.tabId + target.session.platform} tabId={target.tab.tabId} iosxe={target.session.platform === 'iosxe'} /></div> : <p className="text-sm text-fg-muted">Open an SSH session to collect a capture from a device.</p>)}
  </div>
}
