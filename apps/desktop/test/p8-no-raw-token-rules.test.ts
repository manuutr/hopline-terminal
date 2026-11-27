import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Phase 8 H3, as a lint: no safety rule may match on raw tokens again. The fleet reach guard
 * compared the raw first word with `ping`, so `pi`, `do ping` and FortiOS `execute ping` walked
 * past it. Every rule now works on the shared canonicaliser (cli-model canonical.ts: the guard's
 * own resolution of the head, option words resolved with the device's prefix rule).
 *
 * This scans the rule sources for the shapes that compare a typed word exactly:
 *  - an anchored word regex applied to a token (`/^count$/i.test(a)`, `/^(?:clear|reset)$/`);
 *  - `.toLowerCase() === 'word'`;
 *  - a hand-rolled tokenizer (`.split(/\s+/)`) in a rule module.
 *
 * Exempt, with the reason:
 *  - dsl.ts `shellFilter`: pipe stages that run as Linux programs get their argv literally (a
 *    Linux option is not abbreviated), so the literal comparison is the right one; `forbidsWord`
 *    already matches abbreviations.
 *  - engine.ts and canonical.ts: they ARE the tokenizer and the canonicaliser.
 *  - policy-deny.ts `plainWords`: the as-typed fallback candidate, compared in addition to the
 *    canonical one (it can only block more).
 */

const root = join(__dirname, '../../..')
const trees = join(root, 'packages/cli-model/src/trees')
const RULE_FILES = [
  ...readdirSync(trees).map((f) => join(trees, f)),
  join(root, 'packages/cli-model/src/probe.ts'),
  join(root, 'packages/guard/src/classify.ts'),
  join(root, 'apps/desktop/src/main/fleet/reach.ts'),
  join(root, 'apps/desktop/src/main/agent/device-tools.ts'),
  join(root, 'apps/desktop/src/shared/policy-deny.ts'),
  join(root, 'apps/desktop/src/session-host/guard-check.ts')
]

const SHAPES: [string, RegExp][] = [
  ['anchored word regex on a token', /\/\^\(?(?:\?:)?[a-z][a-z|-]*\)?\$\/i?\.test\(/],
  ['exact lowercase comparison', /\.toLowerCase\(\)\s*===\s*['"]/],
  ['hand-rolled tokenizer', /\.split\(\/\\s\+\/\)/]
]

/** Lines allowed to keep a shape, with why (file basename → line substrings). */
const ALLOWED: Record<string, string[]> = {
  // The as-typed fallback candidate of a policy pattern (see the header).
  'policy-deny.ts': ['.split(/\\s+/)']
}

describe('Phase 8 lint: rules use the shared canonicaliser, not raw tokens', () => {
  it('covers the rule sources', () => {
    expect(RULE_FILES.length).toBeGreaterThan(15)
  })

  it.each(RULE_FILES.map((f) => [f.slice(root.length + 1), f]))('%s', (_name, file) => {
    const base = basename(file)
    const hits: string[] = []
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        for (const [what, re] of SHAPES)
          if (re.test(line) && !(ALLOWED[base] ?? []).some((a) => line.includes(a))) hits.push(`${base}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`)
      })
    expect(hits).toEqual([])
  })

  it('the lint catches the old reach guard', () => {
    const old = "const verb = (tokens[0] ?? '').toLowerCase() === 'ping'; const k = /^(repeat|count)$/i.test(a); command.trim().split(/\\s+/)"
    expect(SHAPES.filter(([, re]) => re.test(old)).length).toBe(3)
  })
})
