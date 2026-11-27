/** Engine semantics, checked against what Python textfsm 1.1.3/2.1.0 produces for the same input. */
import { describe, expect, it } from 'vitest'
import { TextFSM, TextFSMError, TextFSMTemplateError, splitLines } from '../src/textfsm'
import { ParseTimeoutError } from '../src/types'

const fsm = (t: string) => new TextFSM(t.replace(/^\n/, ''))

describe('TextFSM engine', () => {
  it('records on Record and appends the last record at EOF', () => {
    const f = fsm(`
Value NAME (\\S+)
Value STATE (up|down)

Start
  ^${'${NAME}'} is ${'${STATE}'} -> Record
  ^${'${NAME}'} spare
`)
    expect(f.header).toEqual(['NAME', 'STATE'])
    expect(f.parseText('a is up\nb is down\nc spare\n')).toEqual([
      ['a', 'up'],
      ['b', 'down'],
      ['c', '']
    ])
  })

  it('Filldown carries a value into later records; Clearall resets it', () => {
    const f = fsm(`
Value Filldown VRF (\\S+)
Value ROUTE (\\S+)

Start
  ^VRF ${'${VRF}'}
  ^route ${'${ROUTE}'} -> Record
  ^reset -> Clearall
`)
    expect(f.parseText('VRF red\nroute 1\nroute 2\nreset\nroute 3\n')).toEqual([
      ['red', '1'],
      ['red', '2'],
      ['', '3']
    ])
  })

  it('a Filldown-only record at EOF is still appended (a value is set)', () => {
    const f = fsm(`
Value Filldown VRF (\\S+)
Value ROUTE (\\S+)

Start
  ^VRF ${'${VRF}'}
  ^route ${'${ROUTE}'} -> Record
`)
    expect(f.parseText('VRF red\nroute 1\n')).toEqual([
      ['red', '1'],
      ['red', '']
    ])
  })

  it('Required drops records without the value', () => {
    const f = fsm(`
Value Required IF (\\S+)
Value DESC (.*)

Start
  ^int ${'${IF}'} -> Record
  ^desc ${'${DESC}'} -> Record
`)
    expect(f.parseText('desc orphan\nint g1\n')).toEqual([['g1', '']])
  })

  it('Fillup copies a value up into earlier records until one has it', () => {
    const f = fsm(`
Value A (\\d+)
Value Fillup B (\\w+)

Start
  ^a ${'${A}'} -> Record
  ^b ${'${B}'} -> Record
`)
    expect(f.parseText('a 1\na 2\nb x\n')).toEqual([
      ['1', 'x'],
      ['2', 'x'],
      ['', 'x']
    ])
  })

  it('List accumulates; nested named groups become dicts', () => {
    const f = fsm(`
Value NAME (\\S+)
Value List MEMBERS (\\S+)
Value List PEOPLE ((?P<who>\\w+)\\s+(?P<age>\\d+))

Start
  ^group ${'${NAME}'}
  ^  m ${'${MEMBERS}'}
  ^  p ${'${PEOPLE}'}
  ^end -> Record
`)
    expect(f.parseText('group g\n  m a\n  m b\n  p bob 32\nend\n')).toEqual([['g', ['a', 'b'], [{ who: 'bob', age: '32' }]]])
  })

  it('Continue keeps matching the same line with the next rules', () => {
    const f = fsm(`
Value A (\\w)
Value B (\\w)

Start
  ^${'${A}'} -> Continue
  ^\\w ${'${B}'} -> Record
`)
    expect(f.parseText('x y\n')).toEqual([['x', 'y']])
  })

  it('Clear keeps Filldown values; state transitions; End stops without the EOF record', () => {
    const f = fsm(`
Value Filldown H (\\S+)
Value V (\\S+)

Start
  ^host ${'${H}'} -> Body

Body
  ^v ${'${V}'} -> Record
  ^drop ${'${V}'} -> Clear
  ^stop -> End
`)
    expect(f.parseText('v ignored\nhost h1\nv 1\ndrop 2\nv 3\nstop\nv 4\n')).toEqual([
      ['h1', '1'],
      ['h1', '3']
    ])
  })

  it('an EOF state suppresses the implicit last record', () => {
    const f = fsm(`
Value V (\\S+)

Start
  ^v ${'${V}'}

EOF
`)
    expect(f.parseText('v 1\n')).toEqual([])
  })

  it('Next.Record with a new state, and Record without a line op', () => {
    const f = fsm(`
Value V (\\S+)

Start
  ^a ${'${V}'} -> Next.Record Two

Two
  ^b ${'${V}'} -> Record Start
`)
    expect(f.parseText('a 1\nb 2\na 3\n')).toEqual([['1'], ['2'], ['3']])
  })

  it('Error raises with the message', () => {
    const f = fsm(`
Value V (\\S+)

Start
  ^ok ${'${V}'}
  ^. -> Error "unexpected line"
`)
    expect(() => f.parseText('ok 1\nboom\n')).toThrow(TextFSMError)
    expect(() => f.parseText('ok 1\nboom\n')).toThrow(/unexpected line/)
  })

  it('$$ is a literal end anchor; regex alternatives anchor at the start (re.match)', () => {
    const f = fsm(`
Value V (\\d+)

Start
  ^x|${'${V}'}$$ -> Record
`)
    expect(f.parseText('12\nzx\n3a\n')).toEqual([['12']])
  })

  it('every all-empty record is skipped, and the FSM is reusable', () => {
    const f = fsm(`
Value V (\\S+)

Start
  ^rec -> Record
  ^v ${'${V}'}
`)
    expect(f.parseText('rec\nrec\nv 1\n')).toEqual([['1']])
    expect(f.parseText('v 2\n')).toEqual([['2']])
  })

  it('Key values are reported', () => {
    const f = fsm(`
Value Key IF (\\S+)
Value Required,Key VLAN (\\d+)
Value DESC (.*)

Start
  ^${'${IF}'} ${'${VLAN}'} -> Record
`)
    expect(f.valuesByAttrib('Key')).toEqual(['IF', 'VLAN'])
  })

  it('checks the time budget between lines', () => {
    const f = fsm(`
Value V (\\S+)

Start
  ^${'${V}'} -> Record
`)
    let t = 0
    expect(() => f.parseText('a\n'.repeat(100), { deadline: 5, now: () => t++ })).toThrow(ParseTimeoutError)
  })

  it('splits lines like Python str.splitlines', () => {
    expect(splitLines('a\r\nb\rc\nd\n')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
  })

  describe('template errors', () => {
    const bad = (t: string, re: RegExp) => expect(() => fsm(t)).toThrow(re)
    it('rejects malformed templates', () => {
      bad('Start\n  ^x\n', /No Value definitions|Expect at least/)
      bad('Value V (x)\n\nStart\n  ^${W}\n', /invalid variable substitution/)
      bad('Value V (x)\n\nStart\n  ^x -> Next Missing\n', /State 'Missing' not found/)
      bad('Value V (x)\n\nOther\n  ^x\n', /Missing state 'Start'/)
      bad('Value V (x)\n\nStart\n  ^x -> Continue Start\n', /with new state/)
      bad('Value V (x)\n\nStart\n ^x\n   ^y\n', /Missing white space/)
      bad('Value Bogus V (x)\n\nStart\n  ^x\n', /Unknown option/)
      bad('Value V (x\n\nStart\n  ^x\n', /must be contained within/)
      bad('Value V (x)\nValue V (y)\n\nStart\n  ^x\n', /Duplicate declarations/)
      bad('Value V (x)\n\nStart\n  ^x\n\nEOF\n  ^y\n', /Non-Empty 'EOF'/)
      bad('Value V (x)\n\nStart\n  ^x -> Bogus.Record\n', /Badly formatted rule/)
      expect(() => fsm('')).toThrow(TextFSMTemplateError)
    })
  })
})
