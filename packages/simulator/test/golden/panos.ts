/** panos golden fixtures (see harness.ts for the entry shape). */
import type { GoldenEntry } from './harness.ts'

const DOC = 'docs/research/cli-paloalto-panos.md'
const base = { platform: 'panos' as const, doc: DOC }
const SAMPLES = 'Samples (fw1)'
const host = (name: string) => (d: { hostname: string }) => {
  d.hostname = name
}

export const panos: GoldenEntry[] = [
  {
    ...base,
    id: 'mode-transitions',
    heading: '1. Prompts',
    block: 0,
    mode: 'elided',
    trimEnd: true,
    user: 'username',
    prepare: host('hostname'),
    inputs: ['configure\r', 'quit\r', 'configure\r', 'run ping count 2 host 10.1.1.2\r'],
    deltas: [
      { doc: 'username@hostname#\n\nusername@hostname# quit', sim: 'username@hostname# quit', why: 'The doc block is three separate snippets; the blank prompt and blank line only separate them.' },
      { doc: 'username@hostname>\n\nusername@hostname# run ping host 10.1.1.2', sim: 'username@hostname> configure\nEntering configuration mode\n[edit]\nusername@hostname# run ping count 2 host 10.1.1.2', why: 'The third snippet starts in config mode, so the replay enters it again; `count 2` stops the ping (without it ping runs until Ctrl-C, which the harness cannot send while a command runs).' }
    ]
  },
  {
    ...base,
    id: 'edit-banner',
    heading: '1. Prompts',
    block: 1,
    mode: 'exact',
    trimEnd: true,
    prepare: host('PA-3060'),
    setup: ['configure'],
    deltas: [{ doc: '[edit]\nadmin@PA-3060# edit', sim: 'admin@PA-3060# edit', why: 'The leading [edit] banner belongs to the `configure` run during setup, before the replay starts.' }]
  },
  {
    ...base,
    id: 'help',
    heading: '3. Help and completion',
    block: 0,
    mode: 'excerpt',
    trimEnd: true,
    user: 'username',
    prepare: host('hostname'),
    inputs: ['configure\r', 'set deviceconfig system dns-setting ?', 'servers ?', 'primary ?', '\x03', 'set deviceconfig high-availability enabled ?', '\x03', 'quit\r', 'scp import configuration ?'],
    deltas: [
      { doc: 'admin@PA-3060# set deviceconfig high-availability enabled ?', sim: 'username@hostname# set deviceconfig high-availability enabled ?', why: 'The doc mixes snippets from two devices (PA-3060 and a generic host); the replay uses one.' }
    ]
  },
  {
    ...base,
    id: 'pipes',
    heading: '3. Help and completion',
    block: 1,
    mode: 'exact',
    user: 'username',
    prepare: host('hostname'),
    deltas: [{ doc: 'app-version: 8087-5126', sim: 'app-version: 8930-9310', why: 'The doc example is from an older content release; fw1 runs the content version of the section 6 sample.' }]
  },
  {
    ...base,
    id: 'errors',
    heading: '3. Help and completion',
    block: 2,
    mode: 'exact',
    inputs: ['shwo system info\r', 'show interface ethernet9/9\r', 'show routing route bogus\r', 'configure\r', 'set network interface ethernet ethernet1/1 layer3 ip 10.0.3.300/30\r'],
    deltas: [
      { doc: 'Invalid syntax.\nadmin@fw1# set', sim: 'Invalid syntax.\nadmin@fw1> configure\nEntering configuration mode\n[edit]\nadmin@fw1# set', why: 'The doc jumps into config mode without showing `configure`.' },
      { doc: '10.0.3.300/30\nInvalid syntax.', sim: '10.0.3.300/30\nInvalid syntax.\n[edit]', why: 'Every config-mode prompt is preceded by the [edit] banner; the doc cuts the block before it.' }
    ]
  },
  {
    ...base,
    id: 'validate-full',
    heading: '5. Config model',
    block: 0,
    mode: 'exact',
    prepare: (d) => {
      d.hostname = 'PA-3060'
      ;(d.vendor['panosData'] as { nextJob: number }).nextJob = 3041
    },
    setup: ['configure'],
    inputs: ['validate full\r', 'run show jobs id 3041\r'],
    deltas: [
      { doc: '> show jobs id 3041', sim: '[edit]\nadmin@PA-3060# run show jobs id 3041', why: 'The doc abbreviates the follow-up command as `> show jobs id`; from config mode it is `run show jobs id`.' },
      { doc: '2015/05/18', sim: '2026/11/24', why: 'The doc job ran in 2015; the replay runs on the lab clock.' },
      { doc: 'Details:Configuration is valid', sim: 'Details:Configuration is valid\n[edit]', why: 'The [edit] banner precedes the next prompt.' }
    ]
  },
  {
    ...base,
    id: 'confirm-prompts',
    heading: '5. Config model',
    block: 1,
    mode: 'exact',
    trimEnd: true,
    prepare: host('Lab-5250'),
    inputs: ['request system software install version 9.0.4\r', 'n', 'request restart system\r', 'n']
  },
  { ...base, id: 'show-system-info', heading: SAMPLES, block: 0, mode: 'exact' },
  { ...base, id: 'show-interface-all', heading: SAMPLES, block: 1, mode: 'excerpt', inputs: ['show interface all\r'] },
  {
    ...base,
    id: 'show-routing-route',
    heading: SAMPLES,
    block: 2,
    mode: 'excerpt',
    inputs: ['show routing route\r'],
    deltas: [{ doc: 'total routes shown: 12', sim: 'total routes shown: 14', why: 'The doc omits the connected and host routes of tunnel.1 (169.254.10.0/30); the simulator installs them (extra lines are allowed in excerpt mode).' }]
  },
  { ...base, id: 'show-bgp-summary', heading: SAMPLES, block: 3, mode: 'excerpt', inputs: ['show routing protocol bgp summary\r'] },
  { ...base, id: 'show-arp-all', heading: SAMPLES, block: 4, mode: 'excerpt', inputs: ['show arp all\r'] },
  { ...base, id: 'show-mac-all', heading: SAMPLES, block: 5, mode: 'excerpt', inputs: ['show mac all\r'] },
  { ...base, id: 'show-lldp-neighbors', heading: SAMPLES, block: 6, mode: 'excerpt', inputs: ['show lldp neighbors all\r'] },
  { ...base, id: 'show-session-all', heading: SAMPLES, block: 7, mode: 'excerpt', inputs: ['show session all\r'] },
  { ...base, id: 'show-counter-global', heading: SAMPLES, block: 8, mode: 'excerpt', inputs: ['show counter global filter delta yes\r'] },
  { ...base, id: 'show-jobs-all', heading: SAMPLES, block: 9, mode: 'excerpt', inputs: ['show jobs all\r'] },
  { ...base, id: 'test-security-policy-match', heading: SAMPLES, block: 10, mode: 'excerpt', inputs: ['test security-policy-match from dmz to untrust source 10.100.0.10 destination 8.8.8.8 destination-port 53 protocol 17\r'] },
  { ...base, id: 'show-ha-state', heading: SAMPLES, block: 11, mode: 'excerpt', inputs: ['show high-availability state\r'] },
  { ...base, id: 'config-set-format', heading: SAMPLES, block: 12, mode: 'exact', trimEnd: true, setup: ['set cli config-output-format set', 'configure'] }
]
