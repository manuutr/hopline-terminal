import { describe, expect, it } from 'vitest'
import type { Folder, Session } from '@shared/types'
import {
  allTags,
  dropFolder,
  entityOrder,
  fKey,
  highlight,
  matchesSession,
  parentRow,
  planMove,
  rangeSelect,
  sKey,
  stepFocus,
  tagHue,
  terms,
  toggleSelect,
  visibleRows,
  zoneAt
} from '../src/renderer/src/features/sessions/tree'

const folder = (id: string, parentId: string | null = null, name = id): Folder => ({ id, name, parentId, sort: 0 })
const session = (id: string, o: Partial<Session> = {}): Session => ({
  id,
  name: id,
  folderId: null,
  host: `${id}.lab`,
  port: 22,
  protocol: 'ssh',
  platform: 'iosxe',
  username: 'admin',
  credentialId: null,
  logToFile: false,
  notes: '',
  options: {},
  tags: [],
  color: null,
  favorite: false,
  lastConnectedAt: null,
  ...o
})

const folders = [folder('dc1'), folder('core', 'dc1'), folder('lab')]
const sessions = [
  session('core-sw1', { folderId: 'core', tags: ['core', 'prod'], favorite: true, lastConnectedAt: 30 }),
  session('core-sw2', { folderId: 'core', tags: ['core'], platform: 'nxos', lastConnectedAt: 10 }),
  session('edge-r1', { folderId: 'dc1', tags: ['prod'], platform: 'junos', host: '10.0.0.1' }),
  session('sim-eos', { folderId: 'lab', platform: 'eos', lastConnectedAt: 20 }),
  session('loose')
]
const keys = (rows: ReturnType<typeof visibleRows>) => rows.map((r) => `${'  '.repeat(r.level - 1)}${r.key}`)

describe('visibleRows', () => {
  it('Favorites, Recent (newest first), then folders before loose sessions', () => {
    const rows = visibleRows({ folders, sessions, collapsed: new Set() })
    expect(keys(rows)).toEqual([
      'sec:fav',
      '  fav:s:core-sw1',
      'sec:recent',
      '  recent:s:core-sw1',
      '  recent:s:sim-eos',
      '  recent:s:core-sw2',
      'tree:f:dc1',
      '  tree:f:core',
      '    tree:s:core-sw1',
      '    tree:s:core-sw2',
      '  tree:s:edge-r1',
      'tree:f:lab',
      '  tree:s:sim-eos',
      'tree:s:loose'
    ])
    const dc1 = rows.find((r) => r.key === 'tree:f:dc1')!
    expect(dc1).toMatchObject({ level: 1, posinset: 3, setsize: 5, expanded: true, count: 3 })
    expect(rows.find((r) => r.key === 'tree:s:edge-r1')).toMatchObject({ level: 2, posinset: 2, setsize: 2 })
  })

  it('keeps only the last 10 connected in Recent', () => {
    const many = Array.from({ length: 14 }, (_, i) => session(`r${i}`, { lastConnectedAt: i + 1 }))
    const recent = visibleRows({ folders: [], sessions: many, collapsed: new Set() }).filter((r) => r.section === 'recent' && r.kind === 'session')
    expect(recent.map((r) => r.session!.id)).toEqual(['r13', 'r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4'])
  })

  it('hides children of collapsed folders and sections', () => {
    const rows = visibleRows({ folders, sessions, collapsed: new Set(['dc1', 'recent']) })
    expect(keys(rows)).toEqual(['sec:fav', '  fav:s:core-sw1', 'sec:recent', 'tree:f:dc1', 'tree:f:lab', '  tree:s:sim-eos', 'tree:s:loose'])
    expect(rows.find((r) => r.key === 'tree:f:dc1')!.expanded).toBe(false)
  })

  it('filters by search: no sections, folders pruned to matches and forced open', () => {
    const rows = visibleRows({ folders, sessions, collapsed: new Set(['dc1']), query: 'nx' })
    expect(keys(rows)).toEqual(['tree:f:dc1', '  tree:f:core', '    tree:s:core-sw2'])
  })

  it('filters by tag (every selected tag must be present), combined with search', () => {
    expect(keys(visibleRows({ folders, sessions, collapsed: new Set(), tags: new Set(['prod']) }))).toEqual([
      'tree:f:dc1',
      '  tree:f:core',
      '    tree:s:core-sw1',
      '  tree:s:edge-r1'
    ])
    expect(visibleRows({ folders, sessions, collapsed: new Set(), tags: new Set(['prod', 'core']) }).filter((r) => r.kind === 'session').map((r) => r.label)).toEqual(['core-sw1'])
    expect(visibleRows({ folders, sessions, collapsed: new Set(), tags: new Set(['prod']), query: 'junos' }).filter((r) => r.kind === 'session').map((r) => r.label)).toEqual(['edge-r1'])
  })

  it('treats sessions in a missing folder as loose and survives a parent cycle', () => {
    const rows = visibleRows({ folders: [folder('a', 'b'), folder('b', 'a')], sessions: [session('x', { folderId: 'gone' })], collapsed: new Set() })
    expect(rows.map((r) => r.key)).toEqual(['tree:s:x'])
  })

  it('entityOrder lists each entity once', () => {
    const rows = visibleRows({ folders, sessions, collapsed: new Set() })
    const order = entityOrder(rows)
    expect(order.filter((k) => k === sKey('core-sw1'))).toHaveLength(1)
    expect(order[0]).toBe(sKey('core-sw1'))
  })
})

describe('search', () => {
  it('matches name, host, tags, platform id and label', () => {
    const s = sessions[2]!
    expect(matchesSession(s, terms('edge'))).toBe(true)
    expect(matchesSession(s, terms('10.0.0'))).toBe(true)
    expect(matchesSession(s, terms('prod'))).toBe(true)
    expect(matchesSession(s, terms('junos'))).toBe(true)
    expect(matchesSession(s, terms('juniper'))).toBe(true)
    expect(matchesSession(s, terms('edge eos'))).toBe(false)
  })

  it('highlights every occurrence, merging overlaps, case-insensitively', () => {
    expect(highlight('Core-SW1-core', ['core'])).toEqual([
      { text: 'Core', hit: true },
      { text: '-SW1-', hit: false },
      { text: 'core', hit: true }
    ])
    expect(highlight('abcdef', ['bcd', 'cde'])).toEqual([
      { text: 'a', hit: false },
      { text: 'bcde', hit: true },
      { text: 'f', hit: false }
    ])
    expect(highlight('abc', [])).toEqual([{ text: 'abc', hit: false }])
  })

  it('lists tags by use, and gives each a stable hue', () => {
    expect(allTags(sessions)).toEqual([
      { tag: 'core', count: 2 },
      { tag: 'prod', count: 2 }
    ])
    expect(tagHue('core')).toBe(tagHue('core'))
  })
})

describe('selection and focus', () => {
  const order = [sKey('a'), sKey('b'), fKey('c'), sKey('d')]
  it('ranges in either direction, and toggles', () => {
    expect(rangeSelect(order, sKey('b'), sKey('d'))).toEqual([sKey('b'), fKey('c'), sKey('d')])
    expect(rangeSelect(order, sKey('d'), sKey('a'))).toEqual(order)
    expect(rangeSelect(order, null, fKey('c'))).toEqual([fKey('c')])
    expect(toggleSelect([sKey('a')], sKey('b'))).toEqual([sKey('a'), sKey('b')])
    expect(toggleSelect([sKey('a'), sKey('b')], sKey('a'))).toEqual([sKey('b')])
  })

  it('steps focus within bounds and finds a row parent', () => {
    const rows = visibleRows({ folders, sessions, collapsed: new Set() })
    expect(stepFocus(rows, null, 1)).toBe(0)
    expect(stepFocus(rows, null, -1)).toBe(rows.length - 1)
    expect(stepFocus(rows, rows[0]!.key, -1)).toBe(0)
    expect(stepFocus(rows, rows.at(-1)!.key, 5)).toBe(rows.length - 1)
    const sw2 = rows.findIndex((r) => r.key === 'tree:s:core-sw2')
    expect(rows[parentRow(rows, sw2)]!.key).toBe('tree:f:core')
    expect(parentRow(rows, 0)).toBe(-1)
  })
})

describe('drag and drop', () => {
  const rows = visibleRows({ folders, sessions, collapsed: new Set() })
  const row = (k: string) => rows.find((r) => r.key === k)!

  it('maps a drop position to a folder', () => {
    expect(zoneAt('folder', 2, 28)).toBe('before')
    expect(zoneAt('folder', 14, 28)).toBe('inside')
    expect(zoneAt('folder', 26, 28)).toBe('after')
    expect(zoneAt('session', 20, 28)).toBe('after')
    expect(dropFolder(row('tree:f:core'), 'inside')).toBe('core')
    expect(dropFolder(row('tree:f:core'), 'before')).toBe('dc1')
    expect(dropFolder(row('tree:s:sim-eos'), 'after')).toBe('lab')
    expect(dropFolder(row('tree:s:loose'), 'before')).toBeNull()
    expect(dropFolder(null, 'inside')).toBeNull()
    expect(dropFolder(row('fav:s:core-sw1'), 'inside')).toBeUndefined()
  })

  it('plans multi-moves: skips items already there and items riding with a dragged folder', () => {
    expect(planMove(folders, sessions, [sKey('core-sw1'), sKey('loose'), sKey('sim-eos')], 'lab')).toEqual({ sessionIds: ['core-sw1', 'loose'], folderIds: [] })
    expect(planMove(folders, sessions, [fKey('dc1'), fKey('core'), sKey('core-sw2'), sKey('loose')], 'lab')).toEqual({ sessionIds: ['loose'], folderIds: ['dc1'] })
    expect(planMove(folders, sessions, [sKey('sim-eos')], 'lab')).toBeNull()
    expect(planMove(folders, sessions, [fKey('core')], null)).toEqual({ sessionIds: [], folderIds: ['core'] })
  })

  it('refuses a folder into itself or its subtree', () => {
    expect(planMove(folders, sessions, [fKey('dc1')], 'core')).toEqual({ error: 'A folder cannot move into itself' })
    expect(planMove(folders, sessions, [fKey('dc1')], 'dc1')).toEqual({ error: 'A folder cannot move into itself' })
  })
})
