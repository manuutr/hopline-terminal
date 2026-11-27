import { describe, expect, it } from 'vitest'
import { NetworkPrivacy } from '../src/main/llm/network-privacy'
import { frameOutput } from '../src/main/agent/untrusted'
import { selectionForModel } from '../src/main/agent/agent'

describe('network labels and device evidence', () => {
  it('uses a fresh dictionary for each investigation, preserves frame IDs and expands only saved session names for display', () => {
    const p = new NetworkPrivacy()
    const session = { name: 'East & West', host: 'switch07.private.example', tags: ['Night crew'] }
    const alias = p.addSession(session)
    expect(new NetworkPrivacy().addSession(session)).not.toEqual(alias)
    const text = p.protect(frameOutput(session.name, 'show version', 'switch07# show version\nNight crew'))
    expect(text).not.toMatch(/east|west|switch07|night crew/i)
    expect(text).toMatch(/<device_output id="([a-f0-9]+)" [\s\S]*\n<\/device_output id="\1">/)
    let local = ''
    const stream = p.displayStream((s) => { local += s })
    for (const char of 'Check ' + alias + ' now') stream.write(char)
    stream.flush()
    expect(local).toBe('Check East & West now')
  })

  it('keeps states, route evidence and interface identifiers in raw and parsed tables', () => {
    const p = new NetworkPrivacy()
    const sample = [
      'Interface  Status  Protocol  Description',
      'Gi0/1      up      up        Carrier Alpha circuit 337',
      'Gi0/2      down    down      Customer payroll',
      '', 'INTERFACE\tDESCRIPTION\tLINK_STATUS', 'Gi0/3\tSouth annex\tup',
      '', 'System Name: warehouse-2', 'set interfaces ge-0/0/0 description "Juniper circuit";',
      'set alias "Fortinet circuit"', 'Device ID: pear-42.example.net',
      '', 'Interface Status Protocol Description', 'Gi0/7 up up Reserved clinic link',
      '<hosts><host-name>canary-remote</host-name></hosts>', '<description>East loading dock</description>',
      'Nov 26 12:00:03 clinic-sw rpd[123]: link down',
      '192.0.2.0/24   0011.aabb.ccdd   ge-0/0/0.10'
    ].join('\n')
    const out = p.protect(sample)
    expect(out).not.toMatch(/Carrier Alpha|337|payroll|annex|warehouse|Reserved clinic link|canary-remote|loading dock|clinic-sw|Juniper circuit|Fortinet circuit|pear-42|example\.net/)
    expect(out).toMatch(/Gi0\/1\s+up\s+up\s+label-/)
    expect(out).toMatch(/Gi0\/3\tlabel-[\w-]+\tup/)
    expect(out).toContain('192.0.2.0/24   0011.aabb.ccdd   ge-0/0/0.10')
    expect(p.mask('warehouse-2 and pear-42')).not.toMatch(/warehouse|pear/)
  })

  it('masks a long selected description before taking the tail', () => {
    const text = 'hostname customer-sw\n description ' + 'projectword '.repeat(2400)
    expect(selectionForModel(text, new NetworkPrivacy())).not.toMatch(/customer-sw|projectword/)
  })

  it('masks short, indented and wrapped device IDs in neighbor summaries', () => {
    const p = new NetworkPrivacy()
    const text = [
      'Device ID        Local Intrfce     Holdtme  Capability  Platform  Port ID',
      ' north-wing      Gig 1/0/2         129      R S I       C9300     Gig 1/1/1',
      'very-long-private-neighbor',
      '                 Gig 1/0/3         124      R S I       C9300     Gig 1/1/2',
      'Total cdp entries displayed: 2', '', 'west-pe#show clock'
    ].join('\n')
    const masked = p.protect(text)
    expect(masked).not.toMatch(/north-wing|private-neighbor|west-pe/)
    expect(masked).toContain('Gig 1/0/3         124')
    expect(masked).toContain('Total cdp entries displayed: 2')
  })
})
