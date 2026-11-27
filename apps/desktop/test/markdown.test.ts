import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, splitRow } from '../src/renderer/src/features/ai/markdown-parse'

describe('assistant markdown', () => {
  it('renders the GFM table the assistant actually sends', () => {
    const md = [
      'Two interfaces are down.',
      '',
      '| Interface | Status | Description | What it means |',
      '|---|---|---|---|',
      '| **Gi1/0/2** | administratively down / down | uplink to isp-r2 (AS65002) | Someone shut this port. |',
      '| **Gi1/0/4** | down / down | *(none)* | Nothing connected. |',
      '',
      '**Gi1/0/2 matters most.**'
    ].join('\n')
    const b = parseMarkdown(md)
    expect(b.map((x) => x.t)).toEqual(['p', 'table', 'p'])
    const t = b[1] as Extract<(typeof b)[number], { t: 'table' }>
    expect(t.head).toHaveLength(4)
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0]![0]).toEqual([{ t: 'strong', c: [{ t: 'text', v: 'Gi1/0/2' }] }])
    expect(t.rows[1]![2]).toEqual([{ t: 'em', c: [{ t: 'text', v: '(none)' }] }])
  })

  it('reads alignment, escaped pipes and pipes inside code', () => {
    expect(splitRow('| a | `x | y` | c\\|d |')).toEqual(['a', '`x | y`', 'c|d'])
    const t = parseMarkdown('a | b | c\n:-- | :-: | --:\n1 | 2 | 3')[0]
    expect(t).toMatchObject({ t: 'table', align: ['left', 'center', 'right'] })
  })

  it('pads short rows and tolerates a table still streaming in', () => {
    const t = parseMarkdown('| a | b |\n|---|---|\n| 1 |')[0]
    expect(t).toMatchObject({ t: 'table' })
    expect((t as { rows: unknown[][] }).rows[0]).toHaveLength(2)
    // Header without its delimiter row yet: just a paragraph for now.
    expect(parseMarkdown('| a | b |')[0]!.t).toBe('p')
  })

  it('a pipe in prose or in a CLI command is not a table', () => {
    expect(parseMarkdown('Run `show run | include bgp` to check.').map((b) => b.t)).toEqual(['p'])
    expect(parseMarkdown('show run | i bgp\nnext line').map((b) => b.t)).toEqual(['p'])
  })

  it('does not italicise snake_case or interface_names, but does *emphasis*', () => {
    expect(parseInline('see if_name and snake_case_word here')).toEqual([{ t: 'text', v: 'see if_name and snake_case_word here' }])
    expect(parseInline('a *big* deal')).toEqual([{ t: 'text', v: 'a ' }, { t: 'em', c: [{ t: 'text', v: 'big' }] }, { t: 'text', v: ' deal' }])
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', v: '2 * 3 * 4' }])
    expect(parseInline('~~old~~ new')[0]).toEqual({ t: 'del', c: [{ t: 'text', v: 'old' }] })
  })

  it('keeps fenced code verbatim (no inline parsing) and handles an unclosed fence', () => {
    const b = parseMarkdown('```\ninterface Gi1/0/2\n no shutdown **x**\n```\nafter')
    expect(b[0]).toEqual({ t: 'code', lang: '', v: 'interface Gi1/0/2\n no shutdown **x**' })
    expect(parseMarkdown('```\nstill streaming')[0]).toEqual({ t: 'code', lang: '', v: 'still streaming' })
  })

  it('numbered lists keep their start, plus quotes and rules', () => {
    expect(parseMarkdown('3. c\n4. d')[0]).toMatchObject({ t: 'ol', start: 3 })
    expect(parseMarkdown('> careful\n> really').map((b) => b.t)).toEqual(['quote'])
    expect(parseMarkdown('a\n\n---\n\nb').map((b) => b.t)).toEqual(['p', 'hr', 'p'])
  })
})
