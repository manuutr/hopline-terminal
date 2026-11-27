# @hopline/parsers

A TypeScript TextFSM engine (a faithful port of Google's Python `textfsm`) plus a curated,
bundled subset of [ntc-templates](https://github.com/networktocode/ntc-templates) (Apache-2.0,
pinned at commit `06fa33389fbcca31cd59aac5fd5cb2ce5c900939`). Pure TypeScript, no filesystem or
network at build or run time. It runs in main, in workers and in the renderer.

## API (stable)

```ts
import { parseOutput } from '@hopline/parsers'
parseOutput(platform, command, text, { budgetMs? }) // → { template, ntcPlatform, headers, rows, keys? } | null
```

- **Arguments.** `platform` is a cli-model id (`ios`, `iosxe`, `nxos`, `eos`, `junos`, …). `command` is the command as typed, and abbreviations work the way ntc's index handles them (`sh ip int br`).
- **Returns.** `rows` are aligned with `headers`, which are the TextFSM Value names. A cell is a string, or a `string[]` for a `List` value. `keys` holds the Values that have the `Key` option.
- **Returns null** when:
  - no bundled template matches;
  - the command has a `|` filter;
  - the template raises an `Error` action;
  - nothing is recorded.
- **Throws** `ParseTimeoutError` once `budgetMs` has elapsed. The budget is checked between lines, so it cannot stop one runaway regex. Callers that parse untrusted output must run the parse in a worker they can terminate, or in a `vm` context with a timeout.
- **Firewall routes.** `parseOutput` appends `VRF` on FortiOS IPv4 routing tables and `VIRTUAL_ROUTER` on PAN-OS routing tables. FortiOS 7.x tunnel routes retain the reported tunnel peer in `GATEWAY`, tunnel name in `INTERFACE`, and bracketed path attributes separately from the age. An absent heading leaves the context empty. Routes from overlapping address spaces can be compared by context, prefix and path. `parseWithTemplate` retains the upstream fixture shape.
- **Input.** Pass the command's output only, without the echoed command line or the next prompt. Many templates end with a strict `^. -> Error` catch-all.
- **List cells follow ntc's output shape.** Like ntc's `clitable`, every List entry goes through Python's `str()`. A missing entry becomes `'None'`, and a nested-group dict becomes its Python repr (`{'name': 'x'}`). `parseWithTemplate()` returns the raw engine cells.

`@hopline/parsers/match` is a separate entry point. It provides `findTemplate`, `listTemplates`, `lookup` and `PLATFORM_MAP`, and imports only the index rows (~70 KB), not the template texts (~510 KB). A UI thread can use it to ask "is there a parser for this?" and leave the parsing to a worker.

## Platform map

| Hopline | ntc-templates |
| --- | --- |
| ios, iosxe, c9800 | cisco_ios (ntc has no cisco_xe; the 9800 wireless templates live there) |
| nxos | cisco_nxos |
| iosxr | cisco_xr |
| asa | cisco_asa |
| ftd | cisco_ftd, then cisco_asa (FTD's CLI is ASA's for most show commands; ntc's index row `cisco_(asa\|ftd)` covers them) |
| aireos | cisco_wlc_ssh |
| ciscosb | cisco_s300 |
| eos | arista_eos |
| junos | juniper_junos |
| panos | paloalto_panos |
| fortios | fortinet |
| aoscx | aruba_aoscx |
| vrp | huawei_vrp |
| routeros (simulator only) | mikrotik_routeros |

## What is bundled

358 templates, each with all of its ntc test fixtures (893 raw/yml pairs):

| Platform | Templates |
| --- | --- |
| cisco_ios | 94 |
| cisco_nxos | 51 |
| cisco_xr | 34 |
| arista_eos | 34 |
| cisco_asa | 29 |
| cisco_wlc_ssh | 20 |
| juniper_junos | 19 |
| huawei_vrp | 17 |
| paloalto_panos | 14 |
| mikrotik_routeros | 13 |
| aruba_aoscx | 12 |
| fortinet | 11 |
| cisco_s300 | 9 |
| cisco_ftd | 1 |

The curated list is in `scripts/fetch-templates.mjs`. Cisco IOS/IOS-XE comes first: version, inventory, interfaces, ip int brief, CDP/LLDP, VLAN/MAC/STP/etherchannel, ARP, routes, BGP/OSPF/EIGRP/IS-IS/BFD, HSRP/VRRP, ACLs, NAT, DHCP snooping, 802.1X, DMVPN, the 9800 AP tables, ping and traceroute. The other platforms get their equivalents.

Templates are copied unmodified, along with `templates/LICENSE` (Apache-2.0) and `templates/NOTICE`.

## Refreshing

```
node packages/parsers/scripts/fetch-templates.mjs                  # fetches the pinned commit (dev time only)
node packages/parsers/scripts/fetch-templates.mjs ~/src/ntc-templates  # or use a local checkout
```

The script writes:
- `templates/` (the texts, `index`, LICENSE and NOTICE);
- `test/fixtures/`;
- `src/index.generated.ts` (index rows and the bundled names);
- `src/templates.generated.ts` (the texts).

To move to a new commit, change `NTC_COMMIT` in the script, run it, then run `npx vitest run packages/parsers`.

**Index rows (a deliberate choice).** The generated index keeps every row of each mapped platform, whether its template is bundled or not, in upstream order. A command therefore resolves to the template ntc itself would pick. When that template isn't bundled, the command reports "no parser"; it is never handed to a shorter, wrong template. For example, `show ip bgp neighbors X advertised-routes` does not fall through to `show ip bgp neighbors`.

## Tests

| File | What it checks |
| --- | --- |
| `test/corpus.test.ts` | The CI corpus (ROADMAP D4). Every bundled template parses every ntc fixture to its `parsed_sample`, the way ntc's own test does it: the command comes from the directory name, then goes through the index, keys are lowercased, and the comparison is order-sensitive. 893/893 pass. |
| `test/textfsm.test.ts` | Engine semantics: options, actions, states, EOF/End, substitution, template errors, the budget. |
| `test/pyre.test.ts` | Python-to-JS regex conversion. |
| `test/api.test.ts` | Index matching, the platform map, keys, and that the match entry stays light. |
| `test/simulator.test.ts` | Every bundled template's command is run against each of the 13 simulated platforms. Whatever the simulator models must parse into rows, apart from the pinned `KNOWN_GAPS` listed below. |

## Engine notes (deviations from Python)

- **Regex dialect** (`src/pyre.ts`):
  - `(?P<n>)` becomes `(?<n>)` and `(?P=n)` becomes `\k<n>`.
  - `\Z` becomes `$` and `\A` becomes `^`.
  - A literal `]` first in a class is escaped.
  - `{,n}` becomes `{0,n}`.
  - `(?#…)` comments are dropped.
  - Leading `(?imsx)` flags become RegExp flags. Verbose mode (`x`) is refused.
  - A quantified lookbehind such as `(?<=…)+` is legal in Python but a syntax error in JS. Minimum 1 becomes the assertion once; minimum 0 drops the assertion.
  - Patterns compile without the `u` flag, because templates use identity escapes like `\-`.
  - `\w`, `\d` and `\b` are ASCII in JS; Python's are Unicode. This doesn't matter for CLI output.
- **Captures inside a repeated group.** In Python a capture inside a repeated group keeps the value of the last iteration in which it took part. JS resets it on every iteration. This only changes the result when the last iteration skips the capture. `cisco_nxos_show_lldp_neighbors` depends on it (`(${CAPABILITIES}?\s)+`), so it is **not bundled**, which means NX-OS `show lldp neighbors` has no table (`show lldp neighbors detail` does). These bundled templates also put a Value inside a repeated group, but pass their whole corpus:
  - `arista_eos_show_interfaces`
  - `arista_eos_show_ip_access-lists`
  - `cisco_asa_show_access-list`
  - `cisco_asa_show_route`
  - `cisco_ios_show_access-list`
  - `cisco_nxos_show_access-lists`
  - `cisco_nxos_show_interface`
  - `cisco_xr_show_interfaces`
- **Merged templates are not supported.** Index rows that name several templates joined by `:` (clitable merges their tables on Key values) return null. Examples are IOS `show module`, IOS `show switch detail`, ASA `show module` and VRP `display vlan`.

## Gaps

- **Simulator output that does not parse** (`KNOWN_GAPS` in `test/simulator.test.ts`). These are mostly simulator outputs written from memory in a different layout, which the template's strict catch-all rejects. Others are just headers, because nothing is configured.
  - **RouterOS.** The simulator prints RouterOS 7 (`Columns:` headers); ntc's templates are for RouterOS 6.
  - **VRP.** The simulator prints the CE (VRP 8) layout; the templates expect the S-series layout.
  - **Junos:** `show chassis hardware`, `show system uptime`, `show bgp summary` and `show interfaces`.
  - **EOS:** `show processes top once` and `show ip access-lists`.
  - **NX-OS:** `show processes cpu`.
  - **IOS-XR:** `show bgp neighbors`.
  - **ASA:** `show failover` and `show name`.
  - **AireOS:** `show port summary` and `show time`.
  - **AOS-CX:** `show interface`.
  - **FortiOS:** BGP neighbors, OSPF status and HA status.
  - **C9800:** `show cdp neighbors` (`B,R` capabilities).

  Fixing these belongs in the simulator, with goldens.
- **One simulator fix shipped here.** IOS `show ip access-lists` now prints standard ACL entries the way IOS does (`10.0.0.0, wildcard bits 0.0.0.255`, and a host without `host`).
- **Commands without any ntc template are unsupported.** On IOS these include `show ntp associations`, `show interfaces trunk` and `show ip ospf`.
