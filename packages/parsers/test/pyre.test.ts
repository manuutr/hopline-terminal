import { describe, expect, it } from 'vitest'
import { compilePyRegex, convertPyRegex, PyRegexError } from '../src/pyre'

const conv = (p: string) => convertPyRegex(p).source

describe('Python re → JS', () => {
  it('named groups and named backreferences', () => {
    expect(conv('(?P<NAME>\\w+)-(?P=NAME)')).toBe('(?<NAME>\\w+)-\\k<NAME>')
    expect(compilePyRegex('(?P<a>x+)-(?P=a)$').exec('xx-xx')?.groups?.['a']).toBe('xx')
    expect(compilePyRegex('^(?P<a>x+)-(?P=a)$').test('xx-x')).toBe(false)
  })

  it('\\Z and \\A anchors, but not inside a class', () => {
    expect(conv('\\Afoo\\Z')).toBe('^foo$')
    expect(conv('[\\Z]')).toBe('[\\Z]')
    expect(conv('\\\\Z')).toBe('\\\\Z')
  })

  it('a ] first in a class is a literal', () => {
    expect(conv('[]a]')).toBe('[\\]a]')
    expect(conv('[^]a]')).toBe('[^\\]a]')
    expect(compilePyRegex('^[]x]+$').test(']x]')).toBe(true)
    expect(compilePyRegex('^[^]]+$').test('ab')).toBe(true)
    expect(compilePyRegex('^[^]]+$').test('a]')).toBe(false)
  })

  it('global inline flags become RegExp flags; verbose is refused', () => {
    expect(convertPyRegex('(?i)^show')).toEqual({ source: '^show', flags: 'i' })
    expect(convertPyRegex('(?ms)a.b')).toEqual({ source: 'a.b', flags: 'ms' })
    expect(() => convertPyRegex('(?x) a b')).toThrow(PyRegexError)
    expect(compilePyRegex('(?i)^SHOW').test('show')).toBe(true)
  })

  it('{,n} means {0,n}; comments are dropped; identity escapes stay valid without the u flag', () => {
    expect(conv('a{,3}')).toBe('a{0,3}')
    expect(conv('a(?#note)b')).toBe('ab')
    expect(compilePyRegex('^\\-\\/\\:\\s+$').test('-/: ')).toBe(true)
  })

  it('quantified lookbehind: minimum 1 keeps one assertion, minimum 0 drops it', () => {
    expect(conv('a(?<=a)+b')).toBe('a(?<=a)b')
    expect(conv('a(?<![x])*b')).toBe('ab')
    expect(conv('a(?<=a){2,}b')).toBe('a(?<=a)b')
    expect(compilePyRegex('^\\w+(?<=[^()\\s])+(\\s\\((\\d+)\\))*$').test('permit (3)')).toBe(true)
  })

  it('sticky compile anchors like re.match (start only, not end)', () => {
    const re = compilePyRegex('a|b', { sticky: true })
    re.lastIndex = 0
    expect(re.exec('xb')).toBeNull()
    re.lastIndex = 0
    expect(re.exec('bx')?.[0]).toBe('b')
  })

  it('rejects broken patterns', () => {
    expect(() => compilePyRegex('(')).toThrow(PyRegexError)
    expect(() => convertPyRegex('[abc')).toThrow(PyRegexError)
    expect(() => convertPyRegex('abc\\')).toThrow(PyRegexError)
  })
})
