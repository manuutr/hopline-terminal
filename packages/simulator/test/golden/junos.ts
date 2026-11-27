/** junos golden fixtures (see harness.ts for the entry shape). */
import type { GoldenEntry } from './harness.ts'

const DOC = 'docs/research/cli-juniper-junos.md'
const base = { platform: 'junos' as const, doc: DOC, trimEnd: true }

export const junos: GoldenEntry[] = [
  { ...base, id: 'mode-prompts', heading: '1.1 Mode prompts', block: 2, mode: 'exact' },
  {
    ...base,
    id: 'help-partial',
    heading: '3.2 `?` inside a word',
    mode: 'exact',
    user: 'user',
    prepare: (d) => {
      d.hostname = 'host'
    }
  },
  { ...base, id: 'show-foo', heading: '3.5 Error formats', mode: 'exact' },
  { ...base, id: 'change-flow', heading: '5.4 Compare, load and rollback', block: 2, mode: 'exact' },
  {
    ...base,
    id: 'show-interfaces-terse',
    heading: '6.2.1',
    mode: 'exact',
    deltas: [{ doc: 'ge-0/0/1.0              up    up   inet     10.0.0.6/30\n                                   multiservice\n', sim: 'ge-0/0/1.0              up    up   inet     10.0.0.6/30\n', why: 'The doc marks the multiservice continuation line as illustrative; the lab unit has only inet.' }]
  },
  { ...base, id: 'show-bgp-summary', heading: '6.2.2', mode: 'exact' },
  { ...base, id: 'show-ospf-neighbor', heading: '6.2.3', mode: 'exact' },
  { ...base, id: 'show-route', heading: '6.2.4', mode: 'exact' },
  { ...base, id: 'show-arp', heading: '6.2.5', mode: 'exact' },
  { ...base, id: 'show-lldp', heading: '6.2.7', mode: 'exact' },
  { ...base, id: 'show-version', heading: '6.2.8', mode: 'exact' },
  { ...base, id: 'show-log', heading: '6.2.9', mode: 'exact' },
  { ...base, id: 'display-set', heading: '6.2.10', mode: 'exact' }
]
