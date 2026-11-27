import { describe, expect, it, vi } from 'vitest'
import type { MultiEvent } from '@shared/productivity'

/** Round 2 (blocks + multi): default keys, the shared table's headers, merged tables, baselines, early run events. */

vi.mock('sonner', () => ({ toast: Object.assign(() => {}, { error: () => {}, success: () => {}, loading: () => {}, dismiss: () => {} }), Toaster: () => null }))

let onEvent: ((e: MultiEvent) => void) | undefined
vi.stubGlobal('window', {
  hopline: { multi: { onEvent: (f: (e: MultiEvent) => void) => ((onEvent = f), () => {}), info: async () => null } },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true
})
vi.stubGlobal('document', { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} })

const { reservedReason, physicalId } = await import('../src/renderer/src/lib/keymap')
const { BUILTIN_ACTIONS } = await import('../src/renderer/src/features/actions/builtin')
const { BLOCK_ACTIONS } = await import('../src/renderer/src/features/blocks/actions')
const { multiRunKeys } = await import('../src/renderer/src/features/multi/actions')
const { humanizeHeader } = await import('../src/renderer/src/design/DataTable')
const { mergeTables } = await import('../src/renderer/src/features/multi/tables')
const { defaultBaseline } = await import('../src/renderer/src/features/multi/MultiDialog')
const { attachRun, subscribeMulti, useMulti } = await import('../src/renderer/src/features/multi/store')

describe('default shortcuts: valid and conflict-free on both platforms', () => {
  for (const mac of [false, true]) {
    const all = [
      ...BUILTIN_ACTIONS.filter((a) => !a.fixed).map((a) => ({ id: a.id, keys: a.keys ?? [] })),
      ...BLOCK_ACTIONS.map((a) => ({ id: a.id, keys: a.keys ? [a.keys] : [] })),
      { id: 'multi.run', keys: multiRunKeys(mac) }
    ]
    it(`${mac ? 'macOS' : 'Windows/Linux'}: no default is a device key`, () => {
      for (const a of all) for (const k of a.keys) expect(reservedReason(k, mac), `${a.id} ${k}`).toBeNull()
    })
    it(`${mac ? 'macOS' : 'Windows/Linux'}: no two actions share a key`, () => {
      const seen = new Map<string, string>()
      for (const a of [...all, ...BUILTIN_ACTIONS.filter((x) => x.fixed).map((x) => ({ id: x.id, keys: x.keys ?? [] }))])
        for (const k of a.keys) {
          const id = physicalId(k, mac)
          expect(seen.get(id) ?? a.id, `${k} on ${a.id} and ${seen.get(id)}`).toBe(a.id)
          seen.set(id, a.id)
        }
    })
  }
  it('blocks.copyOutput and blocks.table have bindable defaults', () => {
    expect(BLOCK_ACTIONS.find((a) => a.id === 'blocks.copyOutput')?.keys).toBeTruthy()
    expect(BLOCK_ACTIONS.find((a) => a.id === 'blocks.table')?.keys).toBeTruthy()
  })
  it('Run on many devices leaves ⌘M to the macOS Minimize item', () => {
    expect(physicalId(multiRunKeys(true)[0]!, true)).toBe('Shift+Meta+M')
    expect(physicalId(multiRunKeys(false)[0]!, false)).toBe('Ctrl+Shift+M')
  })
})

describe('DataTable headers', () => {
  it('humanizes TextFSM names to sentence case and keeps acronyms', () => {
    expect(humanizeHeader('SOFTWARE_IMAGE')).toBe('Software image')
    expect(humanizeHeader('IP_ADDRESS')).toBe('IP address')
    expect(humanizeHeader('VLAN_ID')).toBe('VLAN ID')
    expect(humanizeHeader('Device')).toBe('Device')
  })
})

describe('multi results', () => {
  it('merges tables of one template across devices with a Device column', () => {
    const t = (rows: string[][], template = 'cisco_ios_show_version.textfsm') => ({ template, headers: ['VERSION', 'HOSTNAME'], rows })
    const m = mergeTables(
      [
        { name: 'sw1', table: t([['17.9', 'sw1']]) },
        { name: 'sw2', table: t([['17.6', 'sw2']]) },
        { name: 'leaf', table: t([['4.32', 'leaf']], 'arista_eos_show_version.textfsm') }
      ],
      'cisco_ios_show_version.textfsm'
    )!
    expect(m.headers).toEqual(['Device', 'VERSION', 'HOSTNAME'])
    expect(m.rows).toEqual([
      ['sw1', '17.9', 'sw1'],
      ['sw2', '17.6', 'sw2']
    ])
    expect(m.devices).toBe(2)
  })
  it('defaults the compare baseline to the platform most devices share', () => {
    expect(defaultBaseline([{ key: 'j', platform: 'junos' }, { key: 'a', platform: 'iosxe' }, { key: 'b', platform: 'iosxe' }])).toBe('a')
    expect(defaultBaseline([])).toBeUndefined()
  })
  it('keeps events that arrive before the run id, and drops other runs', () => {
    subscribeMulti()
    useMulti.setState({ running: true, runId: null, results: {} })
    onEvent!({ runId: 'r1', key: 's1', status: 'ok', output: 'fast' })
    onEvent!({ runId: 'old', key: 's2', status: 'ok', output: 'stale' })
    expect(useMulti.getState().results).toEqual({})
    attachRun('r1')
    expect(useMulti.getState().results['s1']?.output).toBe('fast')
    expect(useMulti.getState().results['s2']).toBeUndefined()
    onEvent!({ runId: 'r1', key: 's3', status: 'running' })
    expect(useMulti.getState().results['s3']?.status).toBe('running')
    onEvent!({ runId: 'r1', key: '', status: 'ok', done: true })
    expect(useMulti.getState().running).toBe(false)
  })
})
