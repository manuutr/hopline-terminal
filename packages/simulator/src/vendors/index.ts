/** Platform -> personality registry. Each vendor lives in its own module under vendors/<v>/. */
import type { PersonalityFactory } from '../core/personality.ts'
import type { SimPlatform } from '../state.ts'
import { iosFactory } from './ios/index.ts'
import { eosFactory } from './eos/index.ts'
import { nxosFactory } from './nxos/index.ts'
import { junosFactory } from './junos/index.ts'
import { panosFactory } from './panos/index.ts'
import { fortiosFactory } from './fortios/index.ts'
import { iosxrFactory } from './iosxr/index.ts'
import { asaFactory } from './asa/index.ts'
import { aireosFactory } from './aireos/index.ts'
import { c9800Factory } from './c9800/index.ts'
import { aoscxFactory } from './aoscx/index.ts'
import { vrpFactory } from './vrp/index.ts'
import { routerosFactory } from './routeros/index.ts'
import { extraShow } from '../scenarios/extra.ts'

const registry: Partial<Record<SimPlatform, PersonalityFactory>> = {}
for (const [p, f] of [
  ['ios', iosFactory],
  ['eos', eosFactory],
  ['nxos', nxosFactory],
  ['junos', junosFactory],
  ['panos', panosFactory],
  ['fortios', fortiosFactory],
  ['iosxr', iosxrFactory],
  ['asa', asaFactory],
  ['aireos', aireosFactory],
  ['c9800', c9800Factory],
  ['aoscx', aoscxFactory],
  ['vrp', vrpFactory],
  ['routeros', routerosFactory]
] as const)
  if (f) registry[p] = f

export function registerPersonality(p: SimPlatform, f: PersonalityFactory): void {
  registry[p] = f
}

export function personalityFor(p: SimPlatform): PersonalityFactory {
  const f = registry[p]
  if (!f) throw new Error(`simulator: no personality for platform "${p}"`)
  return withExtraShows(f)
}

/** Scenario state the vendor tree does not render (scenarios/extra.ts) answers first, in exec mode only. */
function withExtraShows(f: PersonalityFactory): PersonalityFactory {
  return (s) => {
    const p = f(s)
    const run = p.execute.bind(p)
    p.execute = async (line: string) => {
      if (!/\(config|\[edit/.test(p.prompt('command'))) {
        const out = extraShow(s.d, line)
        if (out !== undefined) return s.print(out)
      }
      return run(line)
    }
    return p
  }
}
