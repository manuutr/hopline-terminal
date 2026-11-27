import { describe, expect, it } from 'vitest'
import { impliedSessions } from '../src/renderer/src/features/fleet/store'

describe('fleet scope picker: sessions a ticked folder or tag brings in (review P2)', () => {
  const folders = [
    { id: 'f1', name: 'Core', parentId: null },
    { id: 'f2', name: 'Core/West', parentId: 'f1' },
    { id: 'f3', name: 'Edge', parentId: null }
  ]
  const sessions = [
    { id: 's1', folderId: 'f1', tags: [] },
    { id: 's2', folderId: 'f2', tags: [] },
    { id: 's3', folderId: 'f3', tags: ['bgp'] },
    { id: 's4', folderId: null, tags: [] },
    { id: 's5', folderId: 'f1', tags: [], ephemeral: true }
  ]
  it('a folder includes its subfolders; a tag includes its sessions; quick connects never', () => {
    const m = impliedSessions({ sessions: [], folders: ['f1'], tags: ['bgp'], seed: null, hops: 1 }, folders, sessions)
    expect([...m.entries()]).toEqual([
      ['s1', 'Core'],
      ['s2', 'Core'],
      ['s3', '#bgp']
    ])
  })
  it('nothing ticked: nothing implied', () => {
    expect(impliedSessions({ sessions: ['s1'], folders: [], tags: [], seed: null, hops: 1 }, folders, sessions).size).toBe(0)
  })
})
