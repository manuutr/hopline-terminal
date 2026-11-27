# Network CLI overview for Hopline

> Cross-platform summary of the six per-platform files in this folder. Researched 2026-11.
> Every exact string below is copied from a platform file. That file has the citation and the confidence tag.
> - **(v)** a vendor page fetched during research confirms the string.
> - **(s)** a secondary source confirms it: ntc-templates raw captures, automation-library source (netmiko, scrapli, pyntc), or support-KB transcripts.
> - **(u)** unverified, from memory.
>
> Always check the platform file before hard-coding a string.

| Platform | File | Priority |
|---|---|---|
| Cisco IOS / IOS-XE | [cli-cisco-ios.md](cli-cisco-ios.md) | 1 |
| Cisco NX-OS | [cli-cisco-nxos.md](cli-cisco-nxos.md) | 2 |
| Arista EOS | [cli-arista-eos.md](cli-arista-eos.md) | 3 |
| Juniper Junos | [cli-juniper-junos.md](cli-juniper-junos.md) | 4 |
| Palo Alto PAN-OS | [cli-paloalto-panos.md](cli-paloalto-panos.md) | 5 |
| Fortinet FortiOS | [cli-fortinet-fortios.md](cli-fortinet-fortios.md) | 6 |

## 1. Cross-platform comparison

### 1.1 Prompts and modes

| | IOS / IOS-XE | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| Exec prompt | `core-sw1>` user, `core-sw1#` priv (v) | `leaf1#` only, no user/enable split (v) | `dist-eos1>` / `dist-eos1#` (v) | `netops@edge-r1>` (v) | `admin@fw1>` (v) | `fgt-edge1 # ` (v) |
| Config prompt | `(config)#` (v) | `(config)#` (v) | `(config)#` (v) | `[edit]` banner line, then `netops@edge-r1#` (v) | `[edit]` banner line, then `admin@fw1#` (v) | `fgt-edge1 (interface) # `, then `(port1) # ` (v) |
| Sub-mode style | Fixed suffix: `(config-if)#`, `(config-router)#`, `(config-line)#`, `(config-vlan)#` (v); `(config-ext-nacl)#`, `(config-route-map)#` (u) | Fixed suffix, finer-grained: `(config-router-neighbor-af)#`, `(config-vrf)#`, `(config-s)#` (v) | Suffix includes the object: `(config-if-Et1)#`, `(config-router-bgp)#`, `(config-s-<sess>)#` (v) | No suffix; path in the banner `[edit interfaces ge-0/0/1 unit 0]` (v) | No suffix; path in the banner `[edit deviceconfig system]` (v) | Innermost table or entry name in parentheses (v) |
| Context markers | `-stby` on a standby supervisor (u) | `leaf1%TENANT-A#` routing-context (v); N7K VDC `n7k1-PROD#` (u) | `(s1)` supervisor suffix (s); `(vrf:X)` (u) | `{master:0}` (s), `{primary:node0}` (v) on a line above the prompt | `admin@PA-vsys2>` (v); HA `(active)` (u) | VDOM `(root) # ` (v); `$` for restricted admins (u) |
| Dotted hostname | Dots not allowed in `hostname`; the FQDN comes from `ip domain name` (u) | Unconfirmed | Shown in full by default (`%H%P`) (v) | Unconfirmed | Allowed; truncation unconfirmed | Kept (u) |
| Exec from config | `do` | `do` | `do`, or runs directly: EOS config inherits exec commands (v) | `run` | `run` (v) | n/a: `get`/`show`/`diagnose` work at every level |

### 1.2 Paging

| | IOS | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| Pager string | `--More--` (v); padded ` --More-- ` (u) | `--More--` (v); padding (u) | ` --More-- ` (u) | `---(more)---`, `---(more 18%)---` padded with dashes (v) | **Unresolved**: `less`-style `lines 1-24` or `--more--` (u) | `--More--` (v) |
| Line / page / quit | Enter / Space / any other key (v; quit-key (u)) | Enter / Space / `q` or Ctrl-C, plus `/`, `n`, `s`, `f`, `=`, `!` (v) | Enter / Space / `q` (u) | Enter / Space / `q` or Ctrl-C, plus a large `less`-like key table (v) | (u) | Enter / (Space (u)) / `q` (v); auto-truncates after ~30 s idle (v) |
| Session disable | `terminal length 0` (v) | `terminal length 0` (u) | `terminal length 0` prints `Pagination disabled.` (v) | `set cli screen-length 0` (v) | `set cli pager off` (v) | **none**; config write only |
| Persistent disable | `line vty 0 15` / `length 0` (v) | none found | `terminal length 0` in config (v) | none found | none | `config system console` / `set output standard` / `end` (v) |
| Per-command | none (`\| no-more` does not exist) | `\| no-more` (v) | `\| no-more` (u) | `\| no-more` (v) | none | none |
| Self-erase | BS x 9, spaces, BS x 9 (u) | `\r` + spaces + `\r` (u) | `\r` + spaces + `\r` (u) | (u) | (u) | (u) |

### 1.3 Help, completion, errors

| | IOS | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| `sh?` (no space) | Matching words on one line (v) | Same (u) | Same, two-space separated (v) | Matching completions (v) | Same as `?` (u) | Lists matches, or fills in if unique (v) |
| `show ?` | Indented `keyword  help` lines, `<cr>` when complete (v) | Same, no `<cr>` unless complete (u) | Same, `<cr>` (v) | `Possible completions:` block (v) | Marker column `>` / `+` / `*` and `<Enter>` (v) | Two columns, `*` for required (v) |
| Tab | Completes a unique prefix; ambiguous does nothing (v) | Unique: completes; ambiguous: lists the matches (v) | Completes; double Tab lists (u) | **Space and Tab both complete** (`set cli complete-on-space`); Tab only for values (v) | Completes (v) | **Cycles** through matches (v) |
| Abbreviation on Enter | Any unique prefix, with priority shortcuts (`sh`, `wr`, `conf t`) (v) | Any unique prefix (v) | Any unique prefix (v) | Any unique prefix (u) | **Unconfirmed**: may need full words | Any unique prefix (`g sy stat`) (v) |
| Invalid | caret line, then `% Invalid input detected at '^' marker.` (v) | caret line, then `% Invalid command at '^' marker.` (s; the Cisco doc shows the IOS string) | `% Invalid input (at token 3: 'sumary')`, **no caret** (s) | caret line, then `syntax error, expecting <command>: foo` (u) or `syntax error.` (v) | `Unknown command: shwo` / `Invalid syntax.` / `Server error : ...` (s) | `command parse error before 'x'` + `Command fail. Return code -61`, **no caret** (s) |
| Ambiguous | `% Ambiguous command:  "sh c"` (v; spacing (u)) | `% Ambiguous command at '^' marker.` (u) | `% Ambiguous command` (v) | caret line, then `'sy' is ambiguous.` + `Possible completions:` (v) | (u) | probably the parse error (u) |
| Incomplete | `% Incomplete command.` (v) | `% Incomplete command` (v) / `... at '^' marker.` (u) | `% Incomplete command` (s) | caret line, then `syntax error, expecting <identifier>` (v) | (u) | (u) |
| Caret column | From column 0 of the prompt line, under the first character that failed (v) | Same as IOS (s) | n/a | Near the end of the last token, counting the prompt (s) | none | n/a |
| Unknown first word | IOS **tries to telnet** to it: `Translating "foo"...` (u) | invalid-command caret | `% Invalid input (at token 0: ...)` | `unknown command.` (u) | `Unknown command:` | `Unknown action 0` (permission or context) (v) |

### 1.4 Control characters

| Key | IOS | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| Ctrl-Z | Leave config for exec, echoes `^Z` (v) | Leave config; runs the current line first (v) | Leave config (v) | No `end` meaning (u) | None (u) | None (u) |
| Ctrl-C | In config: back to exec. In exec: drop the line (v/u). **Does not stop ping.** | Clear the line, **stay in mode** (v); stop ping or pager (u) | Clear the line, stay in mode; interrupts ping/watch (v) | Interrupt or clear the line (u) | Clear the line, stay (u) | Aborts a config block like `abort`; **at top level it closes the session** (v) |
| Ctrl-U | Delete to start of line (v) | Same (v) | (u) | Delete the whole line (v) | (u) | (u) |
| Ctrl-W | Delete previous word (v) | Same (v) | (u) | Same (v) | (u) | (u) |
| Ctrl-R | **Redraw line** (v) | **Redraw line** (v) | Reverse search (u) | **Reverse history search** (v) | (u) | none (u) |
| Ctrl-Shift-6 | **Break / escape**: aborts ping, traceroute, DNS lookup (v) | not used (u) | not used (u) | not used | not used | not used |

Hopline implication: Ctrl-R and Ctrl-Shift-6 must never be passed through blindly by a client-side "history search" or "abort" feature. Their meaning differs per platform.

### 1.5 Config model

| | IOS / IOS-XE | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| Default apply | Immediate, line by line | Immediate; a `feature X` gate applies first | Immediate (ACL/MST modes apply on exit) | **Candidate**, applied by `commit` | **Candidate**, `commit` runs as an async job | Immediate on `next`/`end`; `abort` discards |
| Transactional option | `configure replace` + `archive`; `configure confirm`/`revert` timer (v) | `configure session` (`verify`/`commit`); `checkpoint`/`rollback running-config checkpoint` (v) | `configure session` + `commit` / `commit timer` / `abort` (v) | `commit check`, `commit confirmed N`, `rollback N`, `show \| compare`, `configure private\|exclusive` (v) | `validate full`, `commit partial`, `revert config`, `show config diff`; no confirmed-commit (v) | `execute config-transaction start\|commit\|abort` (7.x) (v); `cfg-save revert` (v) |
| Persist | `write memory` / `copy run start` | `copy run start` | `write` / `copy run start` | `commit` persists | `commit` persists, `save config` snapshots | `cfg-save automatic` (default) persists immediately |
| Confirm prompts | `Proceed with reload? [confirm]`, `System configuration has been modified. Save? [yes/no]:` (v) | `(y/n)?  [n]` (v) | (u) | `Exit with uncommitted changes? [yes,no] (yes)` (v) | `(y or n)` (v) | `(y/n)` (v) |

### 1.6 Pipes and structured output

| | IOS | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| Filters | `include`, `exclude`, `begin`, `section`, `count` | IOS set + `grep`, `egrep`, `head`, `last`, `wc`, `sort`, `uniq`, `no-more` (v) | `include`, `exclude`, `begin`, `section`, `no-more`, `nz`, `json`; **any other word runs as a Linux command** (s) | `match`, `except`, `count`, `find`, `last`, `trim`, `no-more`, `display` (v) | `match`, `except` only (v) | `grep` with `-i -v -c -A -B -f` (v) |
| Structured | none on the CLI (use NETCONF/RESTCONF) | `\| json`, `\| xml` (u for json) | `\| json` | `\| display json\|xml\|set` | `set cli op-command-xml-output on`, XML API | REST API only |
| Danger pipes | `redirect`, `tee`, `append` | `vsh`, `python`, `email`, `tee`, `sed`, `awk`, `>` redirect, `;` chaining | anything unknown (Linux), `tee`, `bash` | `save`, `tee`, `append`, `request`, **`hold`** (never ends) | none known | none known |

### 1.7 Interface naming (details in each section 9)

| Platform | Physical | Short form | LAG | Loopback | SVI / IRB | Mgmt |
|---|---|---|---|---|---|---|
| IOS-XE | `GigabitEthernet1/0/1`, `TenGigabitEthernet1/1/1`, `TwentyFiveGigE1/0/1` | `Gi1/0/1`, `Te1/1/1`, `Twe1/0/1` | `Port-channel1` / `Po1` | `Loopback0` / `Lo0` | `Vlan10` / `Vl10` | `GigabitEthernet0/0` (in VRF `Mgmt-vrf`) |
| NX-OS | `Ethernet1/1`, breakout `Ethernet1/49/1` | `Eth1/1` (output), `e1/1` (input) | `port-channel10` / `Po10` | `loopback0` / `Lo0` | `Vlan100` | `mgmt0` |
| EOS | `Ethernet1`, `Ethernet49/1` | `Et1` | `Port-Channel10` / `Po10` | `Loopback0` / `Lo0` | `Vlan100` / `Vl100` | `Management1` / `Ma1` |
| Junos | `ge-0/0/1`, `xe-`, `et-` plus `.unit` (`ge-0/0/1.0`) | none (full names, Tab-completed) | `ae0` | `lo0` (`lo0.0`) | `irb.100` (`vlan.100` on legacy EX) | `fxp0` / `em0` / `re0:mgmt-0` |
| PAN-OS | `ethernet1/1`, sub `ethernet1/1.100` | none | `ae1` | `loopback.1` | `vlan.10` | `management` (not an interface object) |
| FortiOS | `port1`, `wan1`, `internal`, `x1` | none (user-named VLANs, e.g. `vlan100`) | user-named aggregate | user-named loopback type | user-named VLAN interface | `mgmt`, `mgmt1` |

## 2. Recommendations for the autocomplete data model

### 2.1 What exists today and why it is not enough

`packages/simulator/src/engine.ts` defines `Spec { words: string[]; args?: boolean; argHelp?: string; modes: Mode[] }`. That has four problems:

- **Arguments are untyped.** `args: true` accepts any trailing tokens, and only one `argHelp` string is shown. There is no notion of `<interface>`, `<1-4094>`, `A.B.C.D` or `WORD`, so the engine cannot ghost-text an interface name, validate a VLAN range, or place the caret inside an argument.
- **Commands are flat.** `show ip bgp summary` and `show ip bgp neighbors` repeat their prefix. Inline docs cannot attach to `show ip bgp` itself, and optional or repeated keywords (`vrf X`, `detail`) need a spec per combination.
- **Modes are IOS-shaped.** `Mode` is `exec | config | config-if | config-router | config-vlan`. There is no user exec (`>`). There is no Junos/PAN-OS model (operational/configuration + edit path), and no FortiOS model (context stack of table and entry).
- **Rendering is hard-wired.** The pager string, error strings, Ctrl-key semantics and `do`/`run` all come from the shell. None of them is per-platform.

### 2.2 Proposed shape

Use a per-platform **command tree**: a trie of nodes. Keyword nodes and typed parameter nodes are siblings, and parameter nodes can bind to live values.

```ts
type Platform = 'ios' | 'iosxe' | 'nxos' | 'eos' | 'junos' | 'panos' | 'fortios'

/** Parameter types, named after how each CLI prints them in `?` help. */
type ParamType =
  | { kind: 'word'; label?: 'WORD' | 'LINE' | '<name>' | '<value>' } // free token; LINE = rest of line
  | { kind: 'int'; min: number; max: number }                      // shows as <1-4094>
  | { kind: 'range-list'; min: number; max: number }               // 10,20-30 (VLAN lists)
  | { kind: 'ipv4' }                                               // A.B.C.D
  | { kind: 'ipv4-mask' }                                          // A.B.C.D A.B.C.D (IOS mask)
  | { kind: 'ipv4-prefix' }                                        // A.B.C.D/LEN
  | { kind: 'ipv6' } | { kind: 'ipv6-prefix' }                     // X:X:X:X::X[/LEN]
  | { kind: 'mac'; style: 'cisco-dot' | 'colon' | 'dash' }         // H.H.H vs aa:bb:..
  | { kind: 'asn' }                                                // 1-4294967295 or asdot
  | { kind: 'interface'; accept: InterfaceSyntax }                 // see 2.4
  | { kind: 'enum'; values: string[] }
  | { kind: 'regex' }                                              // pipe arguments; '?' needs Ctrl-V
  | { kind: 'path'; scheme?: string[] }                            // flash:, bootflash:, /var/tmp

type LiveSource =
  | 'interfaces' | 'subinterfaces' | 'vlans' | 'vrfs' | 'bgp-neighbors' | 'ospf-neighbors'
  | 'route-maps' | 'prefix-lists' | 'acls' | 'policy-statements' | 'firewall-filters'
  | 'zones' | 'address-objects' | 'security-rules' | 'vdoms' | 'vsys' | 'checkpoints'
  | 'config-sessions' | 'rollback-ids' | 'files'

interface Node {
  /** Keyword text, or undefined for a parameter node. */
  word?: string
  param?: ParamType
  /** Shown in `?` help and inline docs. Use the platform's own help string where known. */
  help: string
  /** Left column for parameter help, e.g. "A.B.C.D", "<1-4094>", "WORD", "<interface>". */
  helpLabel?: string
  /** Bind values for completion, ghost text and validation. */
  live?: { source: LiveSource; filter?: string /* e.g. "type=physical", "vrf=$vrf" */; strict?: boolean }
  /** Name this argument for later nodes and for live filters ("vrf=$vrf"). */
  capture?: string
  children?: Node[]
  /** Executable here, so `<cr>` / `<Enter>` is offered. */
  runnable?: boolean
  /** Child subtree may repeat (e.g. Junos `| match x | except y`, EOS keyword options). */
  repeat?: boolean
  /** Enters a sub-mode or pushes an edit path. */
  enters?: ModeRef
  modes?: ModeRef[]
  /** Classification for the guard and for UI warnings. */
  risk?: 'read' | 'config' | 'disruptive' | 'destructive'
  /** Abbreviation priority: IOS resolves "sh", "wr", "conf t" even when not unique by spelling. */
  priority?: number
  minVersion?: string; maxVersion?: string
  /** NX-OS `feature bgp`, EOS agent, Junos licence: hide or warn when the gate is off. */
  requires?: string
  source?: string // citation URL, kept in the data for auditability
}

/** IOS-style suffix modes vs hierarchical edit paths vs FortiOS context stacks. */
type ModeRef =
  | { kind: 'suffix'; id: string }                 // 'exec-user' | 'exec' | 'config' | 'config-if' | ...
  | { kind: 'path'; root: 'operational' | 'configuration' }           // Junos, PAN-OS
  | { kind: 'stack'; frame: 'top' | 'table' | 'entry' | 'vdom' | 'global' } // FortiOS
```

The rule for every keyword vs parameter conflict: an exact keyword match wins, then a unique keyword prefix, then a parameter. This mirrors IOS `ip route ?` showing both `A.B.C.D` and `vrf`.

### 2.3 Platform profile: everything the shell and renderer need

Keep the command tree independent of presentation. Put each platform's quirks in a profile object, shared by the simulator, the autocomplete engine and the guard. Today these quirks are hard-coded in `shell.ts`.

```ts
interface PlatformProfile {
  id: Platform
  prompt: {
    render(ctx: SessionCtx): string        // 'core-sw1(config-if)#', 'netops@edge-r1# ', 'fgt-edge1 (port1) # '
    regex: RegExp                          // used by Hopline to detect "device is idle"
    bannerLines?: (ctx: SessionCtx) => string[] // '{master:0}', '[edit interfaces ge-0/0/1]'
  }
  pager: { text: string | ((pct?: number) => string); erase: 'backspace' | 'cr'; keys: Record<string, 'line' | 'page' | 'half' | 'quit' | 'all'>; disable: string[] }
  errors: {
    invalid(ctx: ErrCtx): string[]         // with or without a caret line
    ambiguous(ctx: ErrCtx): string[]
    incomplete(ctx: ErrCtx): string[]
    caret: 'first-failing-char' | 'token-start' | 'token-end' | 'none'
  }
  completion: { tab: 'unique-only' | 'list-on-ambiguous' | 'cycle'; space: boolean /* Junos */; helpFormat: 'cisco' | 'junos' | 'panos' | 'fortios' }
  keys: { ctrlZ: 'end' | 'none'; ctrlC: 'end' | 'clear-line' | 'abort-or-disconnect'; ctrlR: 'redraw' | 'search'; breakSeq?: '\x1e' }
  execFromConfig: 'do' | 'run' | 'inherit' | null
  pipes: { allowed: string[]; unknownBehaviour: 'error' | 'shell' /* EOS */ }
  structured?: { suffix: string; format: 'json' | 'xml' }  // '| json', '| display json'
}
```

This single object closes most of the simulator deltas listed in each file's section 10:
- **IOS:** caret position, pager erase, lenient config mode, implicit-telnet on an unknown word.
- **NX-OS:** `% Invalid command`, no padded pager, Ctrl-C stays in mode.
- **EOS:** `(at token N: ...)`, no caret.
- **Junos:** banners, `---(more)---`, `syntax error`, `run`.
- **PAN-OS:** `[edit]`, the `>`/`+`/`*` help markers, async commit.
- **FortiOS:** context stack, `--More--`, return codes, Ctrl-C disconnect.

### 2.4 Interface parameters

The `interface` parameter needs per-platform input syntax. Users type abbreviations and spaces that the live list (from `show ip int brief`) never contains.

```ts
interface InterfaceSyntax {
  types: { full: string; abbrevs: string[]; numbering: RegExp }[] // { full:'GigabitEthernet', abbrevs:['Gi','G'], numbering:/\d+\/\d+\/\d+(\.\d+)?/ }
  spaceBetween: boolean       // IOS/NX-OS/EOS accept "int e 1/2" / "Gi 1/0/1"; Junos/PAN-OS do not
  caseInsensitive: boolean
  ranges?: 'cisco' | 'eos' | 'nxos' // "Gi1/0/3 - 6", "Et10-11,13", "Ethernet1/1-4"
  units?: '.N'                // Junos ge-0/0/1.0, PAN-OS ethernet1/1.100
}
```

Normalise both the typed text and the live values to a canonical full name before matching. For ghost text, show the user's own style (short if they typed short).

### 2.5 Live-value bindings: sources and refresh

Each platform file's section 8 lists the exact commands. The recommended binding table, per platform, is `LiveSource -> { command, parser, structuredCommand?, ttl }`:

| LiveSource | IOS | NX-OS | EOS | Junos | PAN-OS | FortiOS |
|---|---|---|---|---|---|---|
| interfaces | `show ip interface brief`, `show interfaces status` | `show interface brief \| json` | `show interfaces status \| json` | `show interfaces terse \| display json` | `show interface logical` (IP, zone, VR), `show interface hardware` | `get system interface`, `get system interface physical` |
| vlans | `show vlan brief` | `show vlan brief \| json` | `show vlan \| json` | `show vlans` | subinterface tags from `show interface logical` | `show system interface \| grep -f "set vlanid"` |
| vrfs / contexts | `show vrf` / `show ip vrf` | `show vrf \| json` | `show vrf \| json` | `show route instance` | `VIRTUAL ROUTER:` headers in `show routing route`; `show advanced-routing logical-router`; vsys via `set system setting target-vsys ?` | `Routing table for VRF=` in `get router info routing-table all`; VDOMs via `diagnose sys vd list` (u) |
| bgp-neighbors | `show ip bgp summary` | `show bgp ipv4 unicast summary vrf all \| json` | `show ip bgp summary \| json` | `show bgp summary \| display json` | `show routing protocol bgp summary` | `get router info bgp summary` |
| route-maps / policies | `show route-map` | `show route-map \| json` | `show route-map \| json` | `show configuration policy-options \| display set` | n/a (CLI) | `show router route-map` |
| prefix-lists | `show ip prefix-list` | `show ip prefix-list` | `show ip prefix-list` | `policy-options prefix-list` (config) | n/a | `show router prefix-list` |
| acls / filters / rules | `show ip access-lists` | `show ip access-lists \| json` | `show ip access-lists \| json` | `show configuration firewall \| display set` | `show running security-policy`, config `show rulebase security rules` | `show firewall policy`, `show router access-list` |
| zones / address objects | n/a | n/a | n/a | `security zones` (SRX, config) | zone column of `show interface logical`; config `show zone`, `show address`, `show address-group` | `show system zone`, `show firewall address`, `show firewall addrgrp` |

Refresh rules:
- **Fetch quietly and cache per session.** Use a hidden exec channel, or the same channel only when idle and the prompt has been detected, with paging disabled as in 1.2.
- **Use a short TTL** (60–300 s) and refresh immediately after a config command that touches the source. For example, after `interface X` or `vlan N`, or after `commit` on candidate platforms.
- **Prefer structured output** (`| json`, `| display json`) where it exists. Fall back to the text layouts sampled in each section 6. Those layouts double as parser fixtures.
- **Mark live bindings `strict: false` by default.** A new VLAN or a peer about to be configured must still be accepted, and only ghost text uses the live list.
- **On candidate platforms, use two sources.** On Junos and PAN-OS, config-mode completion should read the *candidate* (`show` in config mode, i.e. `show | display set`), not the active config.

### 2.6 Guard implications (summary across files)

The Phase 2 `PlatformRules` shape (then in `packages/guard/src/platforms.ts`; since 0.4 the rules and deny-lists are the command trees in `packages/cli-model/src/trees/`) could express "top-level keyword" and "two-keyword pair". Each section 7 lists additions. The shape itself cannot express these cases:
1. **Three or more token commands, and argument-sensitive commands.** For example `request system zeroize`, `clear ip bgp *` vs `clear ip bgp 10.0.0.6 soft in`, `request license info` (read) vs `request license install`, `execute factoryreset`.
2. **Destructive config-mode commands.** For example Junos `delete` / `load override` / `rollback`, FortiOS `purge` / `delete`, IOS `no router bgp`, NX-OS `no feature`, and any `shutdown` on the uplink you are connected through.
3. **Confirm-prompt binding.** The guard must tie a later `y` or Enter to the command that raised `[confirm]` or `(y/n)`.
4. **Chaining and expansion.** NX-OS `;`, `$(VAR)` and aliases; EOS `alias` and unknown-pipe-runs-bash; the IOS implicit telnet on an unknown first word.
5. **Platforms missing from `PLATFORMS`.** `panos` and `fortios` are absent. The files propose rule sets: PAN-OS `execFromConfig: 'run'` and pipes `match`/`except`; FortiOS has no `do`, uses pairs on `execute`/`diagnose`, and its only pipe is `grep`.

Recommendation: drive the guard from the same command tree, using `Node.risk`. Then classification uses the device's own abbreviation resolution, including IOS priority shortcuts. Keep `PlatformRules` as a fallback for commands the tree does not know.

Notable guard fixes from the per-platform research:
- **Junos:** move `hold` to the blocked pipes and add `diagnose`. `| match "a|b"` is split on the inner `|` (`classify.ts`).
- **EOS:** make pipes an allowlist, because unknown pipe words run as Linux commands. Block `alias`, `event-handler`, `daemon` and `watch`.
- **NX-OS:** `init-system` is not a single token; add `init`. `;` chaining needs splitting.
- **IOS:** add `factory-reset` and `switch`. Beware `wr` (safe) vs `wr er` (blocked), and `conf rep`/`conf rev`.

## 3. Simulator priorities (ordered by realism gained per effort)

1. **Platform profile (2.3) for errors, pager and Ctrl keys.** This fixes wrong strings on every non-IOS platform. EOS currently prints IOS errors.
2. **Typed parameter nodes and live bindings in `engine.ts`.** This unlocks interface, VLAN and neighbor completion in demos and tests.
3. **IOS correctness:** user exec `>` with `enable`; reject bad config lines instead of storing them in `extraConfig`; put the caret at the first failing character; ask `Save? [yes/no]:` on reload with unsaved changes; stop sharing LLDP output with `show cdp neighbors`.
4. **Junos simulator.** It is the highest-value new platform: operational/configuration modes, edit path banners, candidate plus `commit`/`commit confirmed`/`rollback`/`show | compare`, and `---(more)---`. Samples are in its section 6.
5. **NX-OS.** It is mostly a re-skin of IOS: `feature` gating, `show interface brief`, `*via` routes and `% Invalid command`.
6. **PAN-OS and FortiOS.** Do these after the pager string for PAN-OS is captured from a real device. The most important open item is in section 2 of that file.

## 4. Open questions to resolve with a real device or lab

- **PAN-OS:** the pager string, the HA prompt suffix form, and whether unique prefixes are accepted on Enter.
- **NX-OS:** the ambiguous and incomplete strings, and the pager padding.
- **EOS:** the ` --More-- ` padding and keys, and whether ambiguous and incomplete carry `(at token N)`.
- **Junos:** the exact `syntax error, expecting <command>: foo` form, and the pager erase sequence.
- **FortiOS:** spaces around `--More--`, and the behaviour on ambiguous or incomplete input.
- **All platforms:** the pager erase byte sequence, which matters for Hopline's output parsing and ghost-text cursor tracking.

A recorded transcript per platform (asciinema or raw PTY capture) of `?`, Tab, a typo, an ambiguous prefix, a paged `show running-config`, and Ctrl-C/Z would settle almost every (u) item. These transcripts could become simulator golden tests.

## Sources

Every claim above is cited in the platform files. Each file ends with a `## Sources` list of the URLs fetched during research: cisco.com, networkingdocs.hpe.com / juniper.net, Internet Archive snapshots of arista.com (arista.com refused automated fetches), docs.paloaltonetworks.com, docs.fortinet.com and community.fortinet.com. Secondary sources are github.com/networktocode/ntc-templates raw captures, and netmiko, scrapli, pyntc and other automation-library source code.

Fetched directly for this overview: https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html. It confirms the IOS-XE `% Invalid input detected at '^' marker.`, `% Incomplete command.`, the `--More--` keys, and `terminal length 0`.
