import { describe, expect, it } from 'vitest'
import { acceptMention, activeMention, formatMention, mentionComplete, mentionKey, parseMentions, replaceMentions, suggestMentions } from '@shared/mentions'
import { reservedReason } from '@shared/keymap-rules'
import { altGrText } from '../src/renderer/src/lib/actions'
import type { CredentialInfo, Session } from '@shared/types'
import { resolveMentions } from '../src/main/fleet/mentions'
import { exclusion, FleetScope } from '../src/main/fleet/scope'
import { session } from './fleet-helpers'

/** F11: device @-mentions in an "@ai …" question: parsing, autocomplete helpers, resolution in main. */

const refs = (t: string) => parseMentions(t).map((m) => `${m.kind}:${m.ref}`)

describe('parseMentions', () => {
  it('bare names, with trailing sentence punctuation left out', () => {
    expect(refs('why is bgp down here and on @edge-r1?')).toEqual(['session:edge-r1'])
    expect(refs('compare @core-sw1, @dist-eos1 and @r1.lab.')).toEqual(['session:core-sw1', 'session:dist-eos1', 'session:r1.lab'])
    expect(refs('(@edge-r1) and [@r2]')).toEqual(['session:edge-r1', 'session:r2'])
  })

  it('quoted names with spaces; an unclosed quote is not a mention', () => {
    expect(refs('check @"core-sw1 (telnet)" and @x')).toEqual(['session:core-sw1 (telnet)', 'session:x'])
    expect(refs('check @"core sw')).toEqual([])
    expect(refs('check @""')).toEqual([])
  })

  it('unicode names', () => {
    expect(refs('ospf on @zürich-r1 and @交换机1 and @"Genève core"')).toEqual(['session:zürich-r1', 'session:交换机1', 'session:Genève core'])
  })

  it('@#tag and @folder/Name (bare, quoted, or a path)', () => {
    expect(refs('all of @#edge and @folder/Core')).toEqual(['tag:edge', 'folder:Core'])
    expect(refs('@folder/"Lab (simulator)" and @folder/DC1/Core.')).toEqual(['folder:Lab (simulator)', 'folder:DC1/Core'])
    expect(refs('@#')).toEqual([])
    expect(refs('@folder/')).toEqual([])
  })

  it('emails and user@host are not mentions; nor are a trailing "@" or the @ai trigger', () => {
    expect(refs('mail admin@example.com about ssh admin@10.0.0.1')).toEqual([])
    expect(refs('is this down @')).toEqual([])
    expect(refs('why @ @ is it down')).toEqual([])
    expect(refs('@ai why is bgp down on @edge-r1')).toEqual(['session:edge-r1'])
    expect(refs('@"ai"')).toEqual(['session:ai'])
  })

  it('replaceMentions turns mentions into plain names', () => {
    expect(replaceMentions('why is bgp down here and on @edge-r1? also @#core and @folder/DC1/Core')).toBe('why is bgp down here and on edge-r1? also #core and Core')
    expect(replaceMentions('@"core-sw1 (telnet)" vs user@host')).toBe('core-sw1 (telnet) vs user@host')
  })

  it('formatMention quotes when a name would not parse bare, and round-trips', () => {
    expect(formatMention('session', 'edge-r1')).toBe('@edge-r1')
    expect(formatMention('session', 'core-sw1 (telnet)')).toBe('@"core-sw1 (telnet)"')
    expect(formatMention('session', 'ai')).toBe('@"ai"')
    expect(formatMention('tag', 'edge')).toBe('@#edge')
    expect(formatMention('folder', 'Lab (simulator)')).toBe('@folder/"Lab (simulator)"')
    for (const n of ['edge-r1', 'core-sw1 (telnet)', 'r1.', 'Genève core']) expect(parseMentions(`x ${formatMention('session', n)} y`)[0]!.ref).toBe(n)
  })
})

describe('autocomplete helpers', () => {
  it('activeMention: the mention being typed at the caret', () => {
    expect(activeMention('why is it down on @ed')).toEqual({ start: 18, query: 'ed' })
    expect(activeMention('on @')).toEqual({ start: 3, query: '' })
    expect(activeMention('on @"core s')).toEqual({ start: 3, query: '"core s' })
    expect(activeMention('on @#ed')).toEqual({ start: 3, query: '#ed' })
    expect(activeMention('on @folder/La')).toEqual({ start: 3, query: 'folder/La' })
    expect(activeMention('on @edge-r1 and')).toBeNull()
    expect(activeMention('mail admin@ex')).toBeNull()
    expect(activeMention('on @"core sw1" ')).toBeNull()
  })

  it('suggestMentions: fuzzy on name, host and tag; inserts the name only', () => {
    const src = {
      sessions: [
        { name: 'core-sw1', host: '10.0.0.1', tags: ['core'] },
        { name: 'core-sw1 (telnet)', host: '10.0.0.1', tags: [] },
        { name: 'dist-eos1', host: '10.0.0.5', tags: ['dist'] },
        { name: 'quick', host: '10.9.9.9', tags: [], ephemeral: true }
      ],
      folders: [{ id: 'f1', name: 'Lab (simulator)', parentId: null }]
    }
    expect(suggestMentions('co', src).map((s) => s.name).slice(0, 2)).toEqual(['core-sw1', 'core-sw1 (telnet)'])
    const byHost = suggestMentions('10.0.0.5', src)
    expect(byHost[0]).toMatchObject({ name: 'dist-eos1', insert: '@dist-eos1 ' })
    expect(suggestMentions('dst', src)[0]!.name).toBe('dist-eos1')
    expect(suggestMentions('10.9', src)).toEqual([])
    expect(suggestMentions('#d', src)).toEqual([{ kind: 'tag', name: 'dist', detail: '1 session', insert: '@#dist ' }])
    expect(suggestMentions('folder/lab', src)[0]).toMatchObject({ kind: 'folder', insert: '@folder/"Lab (simulator)" ' })
    expect(suggestMentions('', src)).toHaveLength(3)
  })

  it('list keys: bare ↑↓ Tab Enter Esc only; AltGr "@" (Ctrl+Alt on Windows) is text, never a list key', () => {
    const k = (key: string, m: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...m })
    expect(mentionKey(k('ArrowDown'), 0, 3)).toBe(1)
    expect(mentionKey(k('ArrowUp'), 0, 3)).toBe(2)
    expect(mentionKey(k('Tab'), 1, 3)).toBe('pick')
    expect(mentionKey(k('Enter'), 1, 3)).toBe('pick')
    expect(mentionKey(k('Enter'), 1, 3, true)).toBeNull()
    expect(mentionKey(k('Enter', { shiftKey: true }), 1, 3)).toBeNull()
    expect(mentionKey(k('Escape'), 0, 3)).toBe('close')
    expect(mentionKey(k('Enter'), 0, 0)).toBeNull()
    expect(mentionKey(k('@', { ctrlKey: true, altKey: true }), 0, 3)).toBeNull()
    expect(mentionKey(k('ArrowDown', { ctrlKey: true }), 0, 3)).toBeNull()
    expect(altGrText({ key: '@', code: 'KeyQ', getModifierState: (m) => m === 'AltGraph' })).toBe(true)
    expect(activeMention('why on @')).toEqual({ start: 7, query: '' })
    // The keys the list uses are all ones no shortcut may take (the device's or typing), so no binding shadows them.
    for (const c of ['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown']) expect(reservedReason(c)).not.toBeNull()
    expect(mentionComplete('dist-eos1', [{ kind: 'session', name: 'dist-eos1', detail: '', insert: '@dist-eos1 ' }])).toBe(true)
  })

  it('acceptMention replaces the typed mention', () => {
    expect(acceptMention('why on @co', 7, 10, { insert: '@"core-sw1 (telnet)" ' })).toEqual({ text: 'why on @"core-sw1 (telnet)" ', caret: 28 })
    expect(acceptMention('on @di and', 3, 6, { insert: '@dist-eos1 ' })).toEqual({ text: 'on @dist-eos1 and', caret: 14 })
  })
})

// ------------------------------------------------------------------ resolution in main

const creds: Record<string, Pick<CredentialInfo, 'kind'>> = { 'cred-1': { kind: 'password' }, 'cred-p': { kind: 'prompt' } }
function repoOf(sessions: Session[], folders: { id: string; parentId: string | null; name: string }[] = []) {
  return {
    listSessions: () => sessions,
    listFolders: () => folders,
    getSession: (id: string) => sessions.find((s) => s.id === id),
    getCredential: (id: string) => creds[id],
    hostKeys: () => []
  }
}

const lab = [
  session('core-sw1', 'iosxe', 22, { folderId: 'f-lab', tags: ['core'] }),
  session('core-sw1 (telnet)', 'iosxe', 23, { protocol: 'telnet', folderId: 'f-lab' }),
  session('dist-eos1', 'eos', 24, { folderId: 'f-lab', host: '10.0.0.5' }),
  session('Edge-R1', 'iosxe', 25, { folderId: 'f-dc', tags: ['edge'] }),
  session('edge-r2', 'iosxe', 26, { folderId: 'f-dc', tags: ['edge'] }),
  session('wlc1', 'iosxe', 27, { credentialId: 'cred-p' }),
  { ...session('quick-1', 'iosxe', 28), id: 'quick-abc', ephemeral: true }
]
const folders = [
  { id: 'f-lab', parentId: null, name: 'Lab (simulator)' },
  { id: 'f-dc', parentId: null, name: 'DC1' },
  { id: 'f-core', parentId: 'f-dc', name: 'Core' },
  { id: 'f-core2', parentId: 'f-lab', name: 'Core' }
]
const repo = repoOf(lab, folders)

describe('resolveMentions (main, saved sessions only)', () => {
  it('exact match, with the current tab first and the question in plain names', () => {
    const r = resolveMentions('why is bgp down here and on @dist-eos1?', 'sess-core-sw1', repo)
    expect(r.errors).toEqual([])
    expect(r.current).toEqual({ sessionId: 'sess-core-sw1', name: 'core-sw1' })
    expect(r.spec.sessions).toEqual(['sess-core-sw1', 'sess-dist-eos1'])
    expect(r.question).toBe('why is bgp down here and on dist-eos1? (this device: core-sw1)')
  })

  it('case-insensitive match, then a unique prefix; the canonical name goes in the question', () => {
    const r = resolveMentions('compare @edge-r1 and @DIST', 'sess-core-sw1', repo)
    expect(r.errors).toEqual([])
    expect(r.spec.sessions).toEqual(['sess-core-sw1', 'sess-Edge-R1', 'sess-dist-eos1'])
    expect(r.question).toBe('compare Edge-R1 and dist-eos1 (this device: core-sw1)')
    // The exact name wins over a longer name that starts with it.
    expect(resolveMentions('@core-sw1', null, repo).spec.sessions).toEqual(['sess-core-sw1'])
  })

  it('ambiguous: lists the matches to pick from', () => {
    const r = resolveMentions('is @core ok', 'sess-dist-eos1', repo)
    expect(r.errors).toEqual([{ raw: '@core', kind: 'session', ref: 'core', message: "2 sessions match 'core' — pick one", candidates: [{ name: 'core-sw1', detail: '127.0.0.1' }, { name: 'core-sw1 (telnet)', detail: '127.0.0.1' }] }])
    expect(resolveMentions('@edge', null, repo).errors[0]!.message).toBe("2 sessions match 'edge' — pick one")
  })

  it('unknown: no saved session; never a raw host or address, even when a session has that host', () => {
    expect(resolveMentions('and @edge-r9', 'sess-core-sw1', repo).errors[0]!.message).toBe("no saved session 'edge-r9'")
    const ip = resolveMentions('and @10.0.0.5', 'sess-core-sw1', repo)
    expect(ip.errors[0]!.message).toBe("no saved session '10.0.0.5' (mention a saved session by name, not an address)")
    expect(ip.spec.sessions).toEqual(['sess-core-sw1'])
    // A quick-connect session is not a saved session: it can't be mentioned.
    expect(resolveMentions('and @quick-1', null, repo).errors[0]!.message).toBe("no saved session 'quick-1'")
  })

  it('a quick-connect tab is reported, never added', () => {
    const r = resolveMentions('why is bgp down here and on @dist-eos1', 'quick-abc', repo)
    expect(r.current).toEqual({ quick: true })
    expect(r.spec.sessions).toEqual(['sess-dist-eos1'])
    expect(r.question).toBe('why is bgp down here and on dist-eos1')
  })

  it('@#tag and @folder/Name become the scope\'s tag and folder sources; an ambiguous folder asks for its path', () => {
    const r = resolveMentions('check @#EDGE and @folder/lab', null, repo)
    expect(r.errors).toEqual([])
    expect(r.spec).toEqual({ sessions: [], folders: ['f-lab'], tags: ['edge'] })
    expect(r.question).toBe('check #edge and Lab (simulator)')
    const amb = resolveMentions('@folder/Core', null, repo)
    expect(amb.errors[0]).toMatchObject({ message: "2 folders match 'Core' — pick one", candidates: [{ name: 'DC1/Core' }, { name: 'Lab (simulator)/Core' }] })
    expect(resolveMentions('@folder/DC1/Core', null, repo).spec.folders).toEqual(['f-core'])
    expect(resolveMentions('@#nope', null, repo).errors[0]!.message).toBe("no saved session has the tag '#nope'")
  })

  it('an excluded current session (Telnet) stays first in the scope with its reason; so does a mentioned one needing sign-in', async () => {
    const r = resolveMentions('why is bgp down here and on @dist-eos1 and @wlc1', 'sess-core-sw1 (telnet)', repo)
    expect(r.errors).toEqual([])
    expect(r.spec.sessions).toEqual(['sess-core-sw1 (telnet)', 'sess-dist-eos1', 'sess-wlc1'])
    const scope = await new FleetScope({ repo }).resolve(r.spec)
    const byName = Object.fromEntries(scope.devices.map((d) => [d.name, d.excluded ?? 'ok']))
    expect(byName['core-sw1 (telnet)']).toMatch(/telnet sign-in/)
    expect(byName['wlc1']).toMatch(/needs sign-in/)
    expect(byName['dist-eos1']).toBe('ok')
    expect(exclusion(lab[1]!, repo)).toMatch(/telnet/)
  })
})
