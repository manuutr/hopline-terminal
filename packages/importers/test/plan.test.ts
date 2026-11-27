import { describe, expect, it } from 'vitest'
import { planImport, toSessionInput, type Folder, type ImportedSession, type ImportResult, type Session } from '../src'

const folders: Folder[] = [
  { id: 'f-dc1', name: 'DC1', parentId: null, sort: 0 },
  { id: 'f-core', name: 'Core', parentId: 'f-dc1', sort: 0 },
  { id: 'f-lab', name: 'Lab', parentId: null, sort: 1 }
]

const ex = (id: string, name: string, folderId: string | null, extra: Partial<Session> = {}): Session => ({
  id,
  name,
  folderId,
  host: `${name}.example.net`,
  port: 22,
  protocol: 'ssh',
  platform: 'iosxe',
  username: 'netops',
  credentialId: 'cred-1',
  logToFile: true,
  notes: '',
  options: {},
  ...extra
})

const imp = (name: string, folderPath: string[], extra: Partial<ImportedSession> = {}): ImportedSession => ({
  name,
  folderPath,
  host: `${name}.example.net`,
  port: 22,
  protocol: 'ssh',
  username: '',
  notes: '',
  options: {},
  tags: [],
  source: { format: 'netbox', ref: name },
  ...extra
})

const result = (sessions: ImportedSession[], extraFolders: string[][] = []): ImportResult => ({
  folders: [...sessions.map((s) => s.folderPath), ...extraFolders].filter((p) => p.length).map((path) => ({ path })),
  sessions,
  warnings: []
})

describe('planImport', () => {
  const existing = [
    ex('1', 'core-sw1', 'f-core'),
    ex('2', 'core-sw2', 'f-core'),
    ex('3', 'lab-sw', 'f-lab'),
    ex('4', 'moved-sw', 'f-lab'),
    ex('5', 'old-name', null, { host: 'renamed.example.net' }),
    ex('6', 'twin', 'f-lab'),
    ex('7', 'twin', 'f-lab')
  ]

  it('sorts imports into new, changed, unchanged and conflicts', () => {
    const plan = planImport(
      existing,
      result([
        imp('core-sw1', ['DC1', 'Core']),
        imp('core-sw2', ['dc1', 'core'], { host: '10.0.0.2', port: 2222, platform: 'nxos', username: 'admin' }),
        imp('lab-sw', ['Lab'], { options: { ssh: { agentForward: true } } }),
        imp('moved-sw', ['DC1', 'Core']),
        imp('new-name', [], { host: 'renamed.example.net' }),
        imp('twin', ['Lab']),
        imp('brand-new', ['DC2']),
        imp('core-sw1', ['DC1', 'Core'], { host: '10.9.9.9' })
      ]),
      { folders }
    )
    expect(plan.unchanged.map((u) => [u.imported.name, u.existing.id])).toEqual([['core-sw1', '1']])
    expect(plan.new.map((n) => n.imported.name)).toEqual(['brand-new'])
    expect(plan.newFolders).toEqual([['DC2']])

    const changed = Object.fromEntries(plan.changed.map((c) => [c.imported.name, c.changes.map((x) => x.field)]))
    expect(changed).toEqual({
      'core-sw2': ['host', 'port', 'username', 'platform'],
      'lab-sw': ['ssh'],
      'moved-sw': ['folderPath']
    })
    expect(plan.changed.find((c) => c.imported.name === 'core-sw2')!.changes[0]).toEqual({ field: 'host', from: 'core-sw2.example.net', to: '10.0.0.2' })

    const conflicts = Object.fromEntries(plan.conflicts.map((c) => [c.imported.host, c.reason]))
    expect(conflicts).toEqual({ 'renamed.example.net': 'same-target', 'twin.example.net': 'ambiguous', '10.9.9.9': 'duplicate-in-import' })

    // Everything is accounted for.
    const total = plan.new.length + plan.changed.length + plan.unchanged.length + plan.conflicts.length
    expect(total).toBe(8)
  })

  it('never reports blank usernames, undetermined platforms or unknown fields as changes', () => {
    const plan = planImport([ex('1', 'r1', null, { notes: 'kept by user', platform: 'junos' })], result([imp('r1', [])]))
    expect(plan.unchanged).toHaveLength(1)
  })

  it('matches by name only without folders, for re-sync from a flat source', () => {
    const plan = planImport([ex('1', 'core-sw1', 'f-core')], result([imp('core-sw1', ['Elsewhere'])]))
    expect(plan.unchanged).toHaveLength(1)
  })

  it('does not let two imports claim one existing session', () => {
    const plan = planImport([ex('1', 'r1', 'f-lab')], result([imp('r1', ['DC1']), imp('r1', ['DC1', 'Core'])]), { folders })
    expect(plan.changed).toHaveLength(1)
    // The second row reaches the same host as the claimed session: the user decides.
    expect(plan.conflicts.map((c) => c.reason)).toEqual(['same-target'])
  })

  it('settles exact matches before the moved fallback, whatever the row order', () => {
    const existingSw = [ex('1', 'sw1', 'f-lab')]
    const elsewhere = imp('sw1', ['DC1'], { host: '10.2.2.2' })
    const exact = imp('sw1', ['Lab'])
    for (const rows of [[elsewhere, exact], [exact, elsewhere]]) {
      const plan = planImport(existingSw, result(rows), { folders })
      expect(plan.unchanged.map((u) => u.imported.folderPath)).toEqual([['Lab']])
      expect(plan.new.map((n) => n.imported.host)).toEqual(['10.2.2.2'])
      expect(plan.conflicts).toEqual([])
    }
  })

  it('diffs serial settings', () => {
    const serial = { baudRate: 9600, dataBits: 8 as const, parity: 'none' as const, stopBits: 1 as const, flow: 'none' as const, breakMs: 300 }
    const e = ex('1', 'con', null, { protocol: 'serial', host: 'COM3', port: 0, options: { serial } })
    const same = planImport([e], result([imp('con', [], { protocol: 'serial', host: 'com3', port: 0, options: { serial } })]))
    expect(same.unchanged).toHaveLength(1)
    const diff = planImport([e], result([imp('con', [], { protocol: 'serial', host: 'COM3', port: 0, options: { serial: { ...serial, baudRate: 115200 } } })]))
    expect(diff.changed[0]!.changes.map((c) => c.field)).toEqual(['serial'])
  })
})

describe('toSessionInput', () => {
  it('fills the fields the import does not know', () => {
    const s = toSessionInput(imp('r1', ['DC1'], { options: { ssh: { agentForward: true } } }), { folderId: 'f-dc1', platform: 'ios', jumpIds: ['j1'] })
    expect(s).toEqual({
      name: 'r1',
      folderId: 'f-dc1',
      host: 'r1.example.net',
      port: 22,
      protocol: 'ssh',
      platform: 'ios',
      username: '',
      credentialId: null,
      logToFile: false,
      notes: '',
      options: { ssh: { agentForward: true, jump: ['j1'] } }
    })
    expect(toSessionInput(imp('r2', [], { platform: 'eos' }), { folderId: null, platform: 'ios' }).platform).toBe('eos')
  })
})
