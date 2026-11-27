import { describe, expect, it, vi } from 'vitest'
import { sentence } from '../src/renderer/src/lib/sentence'
import { draftOf, forwardErrors } from '../src/renderer/src/features/forwards/ForwardFields'
import { forwardsProblem } from '../src/renderer/src/features/forwards/ForwardsEditor'

vi.stubGlobal('window', { hopline: {}, addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
const { guardHint } = await import('../src/renderer/src/features/snippets/store')
const { folderLabel } = await import('../src/renderer/src/features/palette/CommandPalette')

/** Polish round 2: snippets, forwards, palette (F4). */
describe('sentence case for guard reasons and device errors', () => {
  it('capitalizes a lower-case start and leaves the rest', () => {
    expect(sentence('configuration change')).toBe('Configuration change')
    expect(sentence('port 8080 is already in use')).toBe('Port 8080 is already in use')
    expect(sentence('"reload" restarts the device')).toBe('"reload" restarts the device')
    expect(sentence('iOS style')).toBe('iOS style')
    expect(sentence(undefined)).toBe('')
  })
})

describe('port forward fields: inline errors, one rule set for the dialog and the session editor', () => {
  const d = (p: Partial<ReturnType<typeof draftOf>>) => ({ kind: 'L' as const, bindHost: '127.0.0.1', bindPort: '', destHost: '10.0.0.1', destPort: '443', ...p })
  it('accepts an empty listen port (any free one) and a full destination', () => {
    expect(forwardErrors(d({}))).toEqual({})
    expect(forwardErrors(d({ kind: 'D', destHost: '', destPort: '' }))).toEqual({})
  })
  it('names the field that is wrong', () => {
    expect(Object.keys(forwardErrors(d({ destHost: '' })))).toEqual(['destHost'])
    expect(Object.keys(forwardErrors(d({ destPort: '0' })))).toEqual(['destPort'])
    expect(Object.keys(forwardErrors(d({ bindPort: '70000' })))).toEqual(['bindPort'])
    expect(Object.keys(forwardErrors(d({ bindHost: '127.0.0.1 x' })))).toEqual(['bindHost'])
  })
  it('the session editor blocks Save with the first problem', () => {
    expect(forwardsProblem([{ id: 'a', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '', destPort: 22 }])).toMatch(/Enter the host/)
    expect(forwardsProblem([{ id: 'a', kind: 'D', bindHost: '127.0.0.1', bindPort: 1080 }])).toBeNull()
  })
})

describe('button bar guard dot (display only; main classifies again)', () => {
  it('show commands get no dot, config is amber, disruptive red', () => {
    expect(guardHint({ mode: 'run', body: 'show ip interface brief' }, 'ios')).toBe('read')
    expect(guardHint({ mode: 'run', body: 'interface {{interface}}\n description {{text}}' }, 'ios')).toBe('config')
    expect(guardHint({ mode: 'run', body: 'clear ip bgp *' }, 'ios')).toBe('disruptive')
    expect(guardHint({ mode: 'run', body: 'interface Gi1/0/1\n shutdown' }, 'ios')).toBe('disruptive')
  })
  it('insert snippets and unknown platforms get no hint', () => {
    expect(guardHint({ mode: 'insert', body: 'reload' }, 'ios')).toBeNull()
    expect(guardHint({ mode: 'run', body: 'reload' }, 'auto')).toBeNull()
  })
})

describe('palette # mode: duplicate folder names show their path', () => {
  const folders = [
    { id: 'dc1', name: 'DC1', parentId: null },
    { id: 'dc2', name: 'DC2', parentId: null },
    { id: 'c1', name: 'Core', parentId: 'dc1' },
    { id: 'c2', name: 'Core', parentId: 'dc2' }
  ]
  it('unique names stay short, twins get the path', () => {
    expect(folderLabel(folders[0]!, folders)).toBe('DC1')
    expect(folderLabel(folders[2]!, folders)).toBe('DC1 / Core')
    expect(folderLabel(folders[3]!, folders)).toBe('DC2 / Core')
  })
})
