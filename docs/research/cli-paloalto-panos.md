# Palo Alto Networks PAN-OS CLI reference for Hopline

> **Scope:** PAN-OS 10.1 / 10.2 / 11.x on NGFWs (hardware and PA-VM). Panorama and WildFire appliances use the same shell but different command trees; they are out of scope. Researched 2026-11.
> **Confidence legend:**
> - **[doc]**: text seen on a docs.paloaltonetworks.com or knowledgebase.paloaltonetworks.com page fetched this session (URL inline).
> - **[secondary]**: a fetched third-party source: ntc-templates `.raw` captures, Netmiko or scrapli-community driver source.
> - **[unverified, from memory]**: not confirmed this session.
>
> **Whitespace caveat:** vendor pages were read through an HTML-to-text converter. Vendor transcripts below are text-verified but spacing-unverified. Column layouts in section 6 were taken byte-for-byte from ntc-templates `.raw` captures and filled with Hopline values at the same field widths. Several captures predate 10.x (noted per block).
>
> **Hopline lab topology (invented, 10.x style):** `fw1` is a PA-VM on PAN-OS 11.1.6, with management 10.255.10.10/24 and HA peer `fw2`.
> - ethernet1/1 10.0.3.2/30, zone `untrust`, eBGP to edge-r1 10.0.3.1 AS 65000.
> - ethernet1/2 10.0.3.6/30, zone `trust`, to core-sw1 10.0.3.5 (OSPF area 0 and iBGP AS 65001 peer).
> - ethernet1/3.100 10.100.0.1/24, zone `dmz`.
> - loopback.1 10.255.0.20/32.
> - tunnel.1 169.254.10.1/30, zone `vpn`.
> - fw1 local AS 65020, virtual router `default` (legacy engine), or logical router `default` (advanced routing).

## 1. Prompts

PAN-OS has exactly two shell modes. In both, the prompt is `username@hostname` followed by a mode character.

| Mode | Prompt | Enter / leave | Source |
|---|---|---|---|
| Operational | `admin@fw1>` | Login lands here | [doc] https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start ("the command prompt ends with a >") |
| Configuration | `admin@fw1#`, preceded by an `[edit]` banner line | `configure` / `exit` or `quit` | [doc] https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/get-started-with-the-cli/change-cli-modes |
| Config, inside a sub-hierarchy | `admin@fw1#`, preceded by `[edit deviceconfig system ntp-servers]` | `edit <path>`, `up`, `top` | [doc] https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/use-the-cli/modify-the-configuration |

Mode transitions, verbatim from the docs above (spacing unverified):
```
username@hostname> configure
Entering configuration mode
[edit]
username@hostname#

username@hostname# quit
Exiting configuration mode
username@hostname>

username@hostname# run ping host 10.1.1.2
PING 10.1.1.2 (10.1.1.2) 56(84) bytes of data
...
username@hostname#
```
```
[edit]
admin@PA-3060# edit deviceconfig system ntp-servers
[edit deviceconfig system ntp-servers]
admin@PA-3060#
```
Key points:
- **There is no `config-if` style prompt.** The hierarchy position is shown only by the `[edit ...]` banner that is printed on its own line before every config-mode prompt, after each command's output. The prompt character stays `#`. Netmiko strips a trailing `\[edit.*\]` line from every config-mode response and detects config mode by checking for `]` [secondary] https://raw.githubusercontent.com/ktbyers/netmiko/develop/netmiko/paloalto/paloalto_panos.py. The config-output-format doc example shows `[edit]` printed after `show` output in config mode [doc] https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/get-started-with-the-cli/customize-the-cli.
- `edit` moves the context. `up` goes one level up and `top` goes back to the root [doc] (modify-the-configuration URL above).
- **Multi-vsys:** `set system setting target-vsys <name>` is an operational-mode command. The docs show this verbatim [doc] https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/cli-cheat-sheets/cli-cheat-sheet-vsys:
  ```
  admin@PA> set system setting target-vsys ?
  none     none
  vsys1    vsys1
  vsys2    vsys2
  <value>  <value>

  > set system setting target-vsys vsys2
  Session target vsys changed to vsys2
  admin@PA-vsys2>
  ```
  So the vsys is appended to the hostname with a hyphen. With a hostname of `fw1` this gives `admin@fw1-vsys2>` [unverified, from memory: extrapolated from the single doc example]. `set system setting target-vsys none` returns to the device-wide context. A vsys created from the CLI appears in that list only after you log out and back in [doc, same page]. Multi-vsys is reported by `show system info` as `multi-vsys: on|off` [secondary, ntc raw].
- **HA state:** in an HA pair the local HA state is appended in parentheses, for example `admin@fw1(active)>`, `admin@fw2(passive)>`, `admin@fw1(suspended)>`, `admin@fw1(non-functional)>`, and in active/active mode `admin@fw1(active-primary)>` / `admin@fw2(active-secondary)>`. In config mode the form is `admin@fw1(active)#`. These are [unverified, from memory]. A search snippet of a LIVEcommunity thread showed `admin@pafw2(active)>`, but the page could not be opened (HTTP 403). Indirect evidence: scrapli-community's PAN-OS prompt regex `^[\w\._-]+@[\w\.\(\)_-]+>\s?$` explicitly allows `(` and `)` in the host part [secondary] https://raw.githubusercontent.com/scrapli/scrapli_community/main/scrapli_community/paloalto/panos/paloalto_panos.py. The active-primary / active-secondary role names exist for active/active HA, but the prompt string itself was not seen.
- When HA and vsys combine, the order is likely `admin@fw1-vsys2(active)>`. This is [unverified, from memory].
- **Hostnames:** dots and dashes are allowed in the hostname (`Lab-5250`, `PA-3060` appear in docs). No doc seen says whether the prompt truncates at the first dot; Hopline should treat everything between `@` and `>`/`#` as the host. There is no `>`→privileged step: no `enable`. Admin role (superuser, superreader, device admin and so on) restricts commands, not the prompt.

Regexes Hopline can use:
```ts
const PANOS_PROMPT = /^([\w.\-]+)@([\w.\-]+?)(?:-(vsys\d+))?(?:\(([a-z-]+)\))?([>#])\s?$/
// groups: user, host, vsys, haState, modeChar  (vsys/HA suffix order unverified)
const PANOS_EDIT_BANNER = /^\[edit(?: ([^\]]+))?\]\s*$/
```

## 2. Paging

- **Disable per session:** `set cli pager off`. It is listed in the op-mode hierarchy as `set cli pager <on|off>` [doc] https://docs.paloaltonetworks.com/pan-os/10-2/pan-os-cli-quick-start/cli-command-hierarchy-for-pan-os-10-2/pan-os-10-2-cli-ops-command-hierarchy (this URL served the 11.1 ops hierarchy page). Both Netmiko and scrapli-community send it after login [secondary]. Like other `set cli ...` settings, it is believed to apply to the current session only [unverified; LIVEcommunity search snippet only]. Whether a persistent per-admin pager setting exists was not found [unverified].
- **Related session settings** (the same hierarchy page lists all of these):
  - `set cli scripting-mode <on|off>`: stops line-wrapping and CLI decorations for paste and automation. Netmiko sends it first, then `set cli terminal width 500`, then `set cli pager off`, then `show system info`, and waits for `operational-mode` in that output. Its `mode on` pattern matches the echoed command after the prompt, not a reply [secondary netmiko].
  - `set cli config-output-format <default|xml|set|json>`.
  - `set cli confirmation-prompt <on|off>`.
  - `set cli op-command-xml-output <on|off>`.
  - `set cli timeout idle <1-1440>|<never>`.
- **Pager prompt string: UNRESOLVED.** Two candidates:
  1. A `less`-style status line such as `lines 1-24 ` while paging, and `lines 25-40/40 (END)` at the end, with Space for a page, Enter or `j` for a line, `q` to quit, and `/` to search. This is [unverified, from memory]. It is the more likely behaviour on 8.x+, because the PAN-OS pager behaves like `less` (the CLI also has a real `less mp-log ...` command).
  2. `--more--`, the string mentioned in Netmiko's `disable_paging` docstring ("Disable paging (the '--more--' prompts)"). This is a code comment, not a capture [secondary].

  Whether the pager line erases itself after a key press is [unverified]. If it is `less`-style, the status line is redrawn in place with `\r` / ESC[K rather than backspaces.
- **Hopline implication:** the shared `' --More-- '` constant in `shell.ts` is wrong or unverified for PAN-OS either way. Make the pager string a per-platform setting, and have the PAN-OS sim default to pager off, or to the `lines N-M` form, until a capture is obtained.

## 3. Help and completion

**`?` after a space** lists the next tokens with a type marker in column 1 [doc] https://docs.paloaltonetworks.com/pan-os/10-2/pan-os-cli-quick-start/get-started-with-the-cli/get-help-on-command-syntax:

| Marker | Meaning |
|---|---|
| `>` | Nested commands follow |
| `+` | Option that takes a value |
| `*` | Required option |
| (blank) | Leaf value or `<Enter>` |

```
username@hostname# set deviceconfig system dns-setting ?
> dns-proxy-object   Dns proxy object to use for resolving fqdns
> servers            Primary and secondary dns servers
  <Enter>            Finish input

username@hostname# set deviceconfig system dns-setting servers ?
+ primary     Primary DNS server IP address
+ secondary   Secondary DNS server IP address
  <Enter>     Finish input

username@hostname# set deviceconfig system dns-setting servers primary ?
<ip>  <ip>

admin@PA-3060# set deviceconfig high-availability enabled ?
  no    no
  yes   yes

username@hostname> scp import configuration ?
+ remote-port   SSH port number on remote host
+ source-ip     Set source address to specified interface address
* from          Source (username@host:path)
```
The page shows the help text at two different spacings, so treat the column widths as unverified. The layout is a marker column, a space, the keyword padded to the longest keyword plus about two spaces, then the description. After the list, the command line is reprinted with the cursor at the end [unverified, from memory].

**Inline `?` (`sh?`)** lists the keywords that start with `sh` in the same format [unverified, from memory].

**Tab** completes a unique prefix: `set dev<Tab>` becomes `set deviceconfig` [doc, same page]. If the prefix is ambiguous, Tab lists the candidates and redraws the line [unverified].

**Abbreviation (important for the guard):** none of the fetched pages show a unique prefix being accepted on Enter, such as `sh sys info`. PAN-OS is generally believed to require full keywords (completed by Tab or space) and to reject unexpanded prefixes. This is [unverified, from memory]; verify on a real device. If confirmed, the guard's prefix resolution is harmless but unnecessary for PAN-OS. If prefixes are accepted, the traps in section 7 apply.

**Pipes:** only `| match <regex>` and `| except <regex>` are documented [doc, same page]:
```
username@hostname> show system info | match app-version
app-version: 8087-5126
username@hostname> show user group list | except ou=acme
```

**Error strings.** scrapli-community fails a command when its output contains any of `Unknown command:`, `Invalid syntax.`, `Server error` or `Validation Error:` [secondary] (scrapli URL above). Only those substrings are verified. Full forms [unverified, from memory]:
```
admin@fw1> shwo system info
Unknown command: shwo
admin@fw1> show interface ethernet9/9
Server error : show -> interface ethernet9/9 is invalid
admin@fw1> show routing route bogus
Invalid syntax.
admin@fw1# set network interface ethernet ethernet1/1 layer3 ip 10.0.3.300/30
Invalid syntax.
```
- There is **no caret line** (`^`) like IOS uses [unverified, from memory].
- `Invalid syntax.` covers incomplete, malformed and ambiguous input alike. There is no separate "ambiguous" or "incomplete" message [unverified].
- Whether `Server error :` has a space before the colon is unverified.
- Commit failures print `Validation Error:` plus an indented list of xpath problems, then `commit failed` [unverified; substring `Validation Error:` is secondary-verified].

## 4. Control characters

All of this section is [unverified, from memory]. The CLI line editor is Emacs/readline-style:
- Ctrl-A / Ctrl-E move to the start / end of the line.
- Ctrl-B / Ctrl-F and the arrow keys move the cursor.
- Ctrl-U kills the whole line, Ctrl-K kills to the end of the line, and Ctrl-W deletes the previous word.
- Ctrl-P / Ctrl-N and Up / Down step through history.
- Ctrl-R reverse search is probably not supported.
- Ctrl-C aborts the current line, or interrupts a running `ping`, `tail follow yes` or commit wait (the commit itself continues as a job). It stays in the current mode.
- Ctrl-Z has no meaning. It does not leave config mode; use `exit` or `quit`.
- Ctrl-Shift-6 has no break-sequence meaning.
- `q` quits the pager.

Hopline delta: the simulator's "Ctrl-Z returns to exec" is Cisco behaviour; disable it for PAN-OS.

## 5. Config model

PAN-OS is a candidate/running model like Junos, but commits are **asynchronous jobs**.

- Edits (`set`, `delete`; also `rename`, `move`, `copy`, `clone`, which are built-ins not listed in the hierarchy page [unverified]) change the **candidate**. `commit` applies the candidate to the **running** config. A commit runs syntactic and then semantic validation [doc] https://docs.paloaltonetworks.com/pan-os/10-1/pan-os-cli-quick-start/use-the-cli/commit-configuration-changes. Commits are queued in the order they are initiated, and automatic commits such as content installs and FQDN refreshes get priority [doc, same].
- Every commit also saves a new running-config version, which you can roll back to. "The firewall automatically saves a new version of the running configuration whenever you commit changes" [doc] https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/firewall-administration/manage-configuration-backups/revert-firewall-configuration-changes. The running config is also the startup config: there is no separate "write memory" step.
- **The candidate is not persistent** across reboot until saved with `save config` (the GUI "Save Changes" writes the default snapshot) [doc, revert page above].

Config-mode command syntax, from the configure hierarchy [doc] https://docs.paloaltonetworks.com/content/techdocs/en_US/ngfw/pan-os-cli-quick-start/cli-command-hierarchy/pan-os-11-1-configure-cli-command-hierarchy.html:

| Command | Effect |
|---|---|
| `commit` | Full commit. Options: `description <text>`, `force`, `partial ... excluded` |
| `commit force` | Commit even if the firewall thinks nothing changed or a full commit is required |
| `commit partial device-and-network excluded` / `... policy-and-objects excluded` / `... shared-object excluded` / `admin <names>` / `object-xpaths <xpaths>` | Partial commit. With `partial` you must name what to exclude [doc commit page] |
| `commit partial admin jsmith vsys vsys1 device-and-network excluded` | Multi-vsys example [doc commit page] |
| `validate full` / `validate partial ...` | Validates without committing. Runs as a job |
| `revert config` (`skip-validate`, `partial ...`) | Discards candidate changes and goes back to the running config |
| `save config to <name>` (`partial ...`) | Saves the candidate as a named snapshot |
| `load config from <file>` / `load config last-saved` / `load config version <n>` / `load config partial from-xpath ... to-xpath ...` (`key`, `skip-validate`, `regenerate-rule-uuid-all`) | Loads a snapshot or version **into the candidate**. Needs `commit` afterwards |
| `save device-state` / `load device-state` | Device state bundle |
| `check pending-changes` / `check full-commit-required` | Read-only checks |
| `run <op command>` | Runs an operational command from config mode [doc change-cli-modes] |

Operational-mode diffs: `show config diff` (candidate vs running; empty output when nothing is pending, per KB/community search snippets [unverified]) and `diff config num-context-lines <0|1|5|10|20|all> partial ...` [doc, ops hierarchy URL in section 2]. `show config running`, `show config candidate`, `show config pushed-template` and `show config saved <name>` are also available. `show config diff` prints a unified diff (`@@` hunks, `+`/`-` lines) of the set or XML-style tree [unverified, from memory].

Transcripts [doc] (commit page above; spacing from the page):
```
admin@PA-3060# validate full
Validate job enqueued with jobid 3041

> show jobs id 3041
Enqueued              Dequeued       ID             Type    Status Result Completed
2015/05/18 14:00:40   14:00:40     3041         Validate       FIN     OK  14:01:11
Details:Configuration is valid
```
Commit output [unverified, from memory]: `Commit job <N> is in progress. Use Ctrl+C to return to command prompt`, then progress dots with `55%` and `100%` markers, then `Configuration committed successfully`, then `[edit]` and the prompt. Netmiko waits for `100%` and then checks, case-insensitively, for `configuration committed successfully` [secondary]; that is the only verified part.
On a failed commit, Hopline should expect `Validation Error:` followed by indented detail and then `commit failed` [unverified]. Confirmed-commit, automatic rollback after a timer, does **not exist** on PAN-OS. Grepping the 11.1 configure hierarchy for `confirm` finds nothing [doc]. Configuration locks for multi-admin use are `request config-lock ...` and `request commit-lock ...` [doc ops hierarchy].

**Confirm prompts.** The y/n style is `(y or n)`, not IOS `[confirm]` [doc] https://knowledgebase.paloaltonetworks.com/kcsArticleDetail?id=kA10g000000PNns:
```
admin@Lab-5250> request system software install version 9.0.4
Executing this command will install a new version of software. It will not take effect until system is restarted. Do you want to continue? (y or n)

admin@Lab-5250> request restart system
Executing this command will disconnect the current session. Do you want to continue? (y or n)
```
Whether the line breaks fall between the sentences is unverified. `set cli confirmation-prompt off` disables some of these prompts. This is dangerous for Hopline: the guard should not let the agent run it.

## 6. Show commands

`show` works in both modes; in config mode, `show` displays the **candidate** config tree, and op commands need `run`. Syntax below is from the op-mode hierarchy [doc] (ops hierarchy URL) unless noted.

| Command | Purpose | Notes |
|---|---|---|
| `show system info` | Hostname, model, serial, sw-version, content versions, uptime, multi-vsys | `key: value` lines |
| `show system resources` | `top`-like MP CPU/memory | Non-interactive snapshot |
| `show system disk-space` | `df` | |
| `show interface all` / `hardware` / `logical` / `management` / `<name>` | Interface table, or detail for one interface | See sample |
| `show routing route` (`virtual-router`, `type`, `destination`, `interface`, `afi`, `count`) | Legacy-engine RIB | See sample |
| `show routing fib virtual-router <vr>` | FIB | |
| `show routing protocol bgp summary` (`virtual-router <vr>`) | Legacy BGP summary | See sample |
| `show routing protocol bgp peer` (`peer-name`, `virtual-router`) | Peer detail | |
| `show routing protocol ospf neighbor` (`virtual-router <vr>`) | OSPF adjacencies | |
| `show advanced-routing route` (`type`, `afi`, `destination`, `logical-router`) | ARE RIB (11.x advanced routing) | [doc networking cheat sheet] |
| `show advanced-routing bgp summary logical-router <lr>` | ARE BGP summary | [doc networking cheat sheet] |
| `show advanced-routing bgp peer status peer-name <p> logical-router <lr>` | ARE peer status | |
| `show advanced-routing ospf neighbor` (`brief yes`) | ARE OSPF neighbors | |
| `show arp all` / `show arp <ifname>` | ARP table | `show arp` listed as `show arp` (takes `all` / an interface) |
| `show mac all` | L2 MAC table (vwire/L2 interfaces) | |
| `show lldp neighbors all` | LLDP detail per port | LLDP must be enabled per interface profile |
| `show high-availability state` | HA local/peer state | [doc KB kA10g000000ClhK] |
| `show high-availability all` | Full HA detail | |
| `show high-availability state-synchronization` | Session sync counters | |
| `show session info` | Session table summary | [doc view-settings page] |
| `show session all` (`filter source/destination/application/from/to/state ...`, `start-at`) | Session table | See sample |
| `show session id <id>` | One session in detail | |
| `show counter global filter delta yes` (`severity drop`, `packet-filter yes`, `aspect`, `category`) | Dataplane counters since the last run | See sample |
| `test security-policy-match from <zone> to <zone> source <ip> destination <ip> destination-port <p> protocol <n> application <app>` | Shows which rule would match | Read-only, despite starting with `test` |
| `test nat-policy-match ...` / `test routing fib-lookup virtual-router <vr> ip <ip>` | NAT / FIB lookup tests | Read-only |
| `show running security-policy` / `show running nat-policy` | Compiled dataplane policy | See sample |
| `show jobs all` / `show jobs id <n>` / `show jobs pending` / `show jobs processed` | Commit / download / install jobs | See sample |
| `show log system` (`direction equal backward`, `receive_time in last-hour`, `query equal '...'`, `csv-output equal yes`) | System log | Also `show log traffic`, `threat`, `config` |
| `show config diff` | Candidate vs running | |
| `show vpn ike-sa` / `show vpn ipsec-sa` / `show vpn flow` | IPsec | [doc networking cheat sheet] |
| `show admins` / `show admins all` | Logged-in / all admins | [doc device mgmt cheat sheet] |
| `request license info` | Installed licenses | Read-only despite `request` |
| `request system software info` / `check` | Available PAN-OS images | Read-only |
| `less mp-log <file>` / `tail follow yes mp-log <file>` / `grep ... mp-log` | Management-plane logs | `tail follow yes` never ends: block it for the agent |
| `ping source <dp-ip> host <ip>` / `traceroute source <ip> host <ip>` | Reachability | Without `source`, these use the management interface |

### Samples (fw1)

**`show system info`.** Field names and order are from the ntc raw capture (PAN-OS 7.0.1 PA-VM) [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_system_info/paloalto_panos_show_system_info.raw. Values are Hopline's. Key order matches the raw. 10.x/11.x insert more keys, such as `device-certificate-status`, `advanced-routing` and `cloud-mode`, which are omitted here [unverified]. The doc example on the view-settings page uses the same `key: value` style.
```
admin@fw1> show system info

hostname: fw1
ip-address: 10.255.10.10
netmask: 255.255.255.0
default-gateway: 10.255.10.1
ipv6-address: unknown
ipv6-link-local-address: fe80::250:56ff:fe8a:1000/64
ipv6-default-gateway: 
mac-address: 00:50:56:8a:10:00
time: Tue Nov 24 09:12:44 2026
uptime: 12 days, 3:41:07
family: vm
model: PA-VM
serial: 007954000123456
vm-mac-base: BA:DB:EE:FB:AD:00
vm-mac-count: 256
vm-uuid: 564D8B6D-7BDB-75AF-400F-B062016DC67E
vm-cpuid: ESX:FB060000FDFB8B07
vm-license: VM-300
vm-mode: VMWare ESXi
sw-version: 11.1.6
global-protect-client-package-version: 0.0.0
app-version: 8930-9310
app-release-date: 2026/11/18 15:04:12 PST
av-version: 5021-5539
av-release-date: 2026/11/23 06:01:33 PST
threat-version: 8930-9310
threat-release-date: 2026/11/18 15:04:12 PST
wf-private-version: 0
wf-private-release-date: unknown
url-db: paloaltonetworks
wildfire-version: 0
wildfire-release-date: unknown
url-filtering-version: 20261124.20142
global-protect-datafile-version: 0
global-protect-datafile-release-date: unknown
logdb-version: 11.1.2
platform-family: vm
vpn-disable-mode: off
multi-vsys: off
operational-mode: normal
```

**`show interface all`.** The layout, including the blank line between the logical header and its dashes, is from ntc raw (PAN-OS version not stated; the `fec` column suggests 10.x+) [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_interface_all/paloalto_panos_show_interface_all.raw
```
total configured hardware interfaces: 8
name                    id    speed/duplex/state/fec        mac address
--------------------------------------------------------------------------------
ethernet1/1             16    1000/full/up/auto             00:50:56:8a:10:01
ethernet1/2             17    1000/full/up/auto             00:50:56:8a:10:02
ethernet1/3             18    1000/full/up/auto             00:50:56:8a:10:03
ethernet1/4             19    ukn/ukn/down((autoneg))/ukn   00:50:56:8a:10:04
ae1                     64    [n/a]/[n/a]/up/[n/a]          00:50:56:8a:10:40
vlan                    1     [n/a]/[n/a]/up/[n/a]          00:50:56:8a:10:01
loopback                3     [n/a]/[n/a]/up/[n/a]          00:50:56:8a:10:03
tunnel                  4     [n/a]/[n/a]/up/[n/a]          00:50:56:8a:10:04

aggregation groups: 1
ae1 members:
  ethernet1/5 ethernet1/6


total configured logical interfaces: 11

name                      id    vsys zone             forwarding               tag    address

------------------- ----- ---- ---------------- ------------------------ ------ ------------------
ethernet1/1               16    1    untrust          vr:default               0      10.0.3.2/30
ethernet1/2               17    1    trust            vr:default               0      10.0.3.6/30
ethernet1/3               18    1                     N/A                      0      N/A
ethernet1/3.100           256   1    dmz              vr:default               100    10.100.0.1/24
ethernet1/4               19    1                     N/A                      0      N/A
ae1                       64    1                     N/A                      0      N/A
vlan                      1     1                     N/A                      0      N/A
loopback                  3     1                     N/A                      0      N/A
loopback.1                257   1    trust            vr:default               0      10.255.0.20/32
tunnel                    4     1                     N/A                      0      N/A
tunnel.1                  258   1    vpn              vr:default               0      169.254.10.1/30
```

**`show routing route`.** The layout is from ntc raw `..._route3.raw` [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_routing_route/paloalto_panos_show_routing_route3.raw. Note the `?` (loose) flag on BGP routes and the empty metric for BGP. The age column is 6 wide but overflows on long ages. The formatter was checked byte-for-byte against all 4 raw rows. With advanced routing on, use `show advanced-routing route`. That output uses a different, FRR-like layout grouped by `logical router: default`, which is [unverified].
```
flags: A:active, ?:loose, C:connect, H:host, S:static, ~:internal, R:rip, O:ospf, B:bgp,
       Oi:ospf intra-area, Oo:ospf inter-area, O1:ospf ext-type-1, O2:ospf ext-type-2, E:ecmp, M:multicast

VIRTUAL ROUTER: default (id 1)
  ==========
destination                                 nexthop                                 metric flags      age   interface          next-AS
0.0.0.0/0                                   10.0.3.1                                       A?B        86012                    65000
10.0.3.0/30                                 10.0.3.2                                0      A C              ethernet1/1
10.0.3.2/32                                 0.0.0.0                                 0      A H
10.0.3.4/30                                 10.0.3.6                                0      A C              ethernet1/2
10.0.3.6/32                                 0.0.0.0                                 0      A H
10.10.10.0/24                               10.0.3.5                                10     A Oi       86020 ethernet1/2
10.10.20.0/24                               10.0.3.5                                10     A Oi       86020 ethernet1/2
10.100.0.0/24                               10.100.0.1                              0      A C              ethernet1/3.100
10.100.0.1/32                               0.0.0.0                                 0      A H
10.255.0.1/32                               10.0.3.5                                11     A Oi       86020 ethernet1/2
10.255.0.20/32                              10.255.0.20                             0      A C              loopback.1
172.16.0.0/16                               169.254.10.2                            10     A S              tunnel.1
total routes shown: 12
```

**`show routing protocol bgp summary`.** The layout is from ntc raw [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_routing_protocol_bgp_summary/paloalto_panos_show_routing_protocol_bgp_summary.raw. Peers are listed by their configured **peer name**, not by IP.
```
  ==========
  router id:                     10.255.0.20
  virtual router:                default
  reject default route:          no
  redist default route:          allow
  Install BGP routes:            yes
  Graceful Restart:              supported
  AS size:                       4
  Local AS:                      65020
  Local member AS:               0
  Cluster id:                    0.0.0.0
  Default local preference:      100
  Always compare MED:            no
  Aggregate regardless MED:      yes
  Deterministic MED processing:  yes
  Accept ORF:                    no
  Accept CISCO style prefix:     yes
  mp-bgp-enable:                 yes
  afi-safi-ipv4-unicast:         yes
  rib-out entries:               current 14, peak 14
    peer edge-r1: AS 65000, Established, IP 10.0.3.1
      bgpAfiIpv4/unicast pfx:    Accepted pfx: 1, Advertised pfx: 6
    peer core-sw1: AS 65001, Established, IP 10.0.3.5
      bgpAfiIpv4/unicast pfx:    Accepted pfx: 5, Advertised pfx: 2
```

**`show routing protocol ospf neighbor`.** The layout is [unverified, from memory]: a `==========` separator, then one key/value block per neighbor. Keys include `virtual router:`, `neighbor address:`, `neighbor router ID:`, `area id:`, `status:` (`full`) and `lifetime remain:`. The command exists as `show routing protocol ospf neighbor virtual-router <value>` [doc ops hierarchy]. The ARE equivalent is `show advanced-routing ospf neighbor brief <yes|no> logical-router <value>`.

**`show arp all`.** The layout is from ntc raw. Note `default timeout:` with no space before the colon, while the MAC table uses `default timeout :` [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_arp_all/paloalto_panos_show_arp_all.raw
```

maximum of entries supported :      1500
default timeout:                    1800 seconds
total ARP entries in table :        4
total ARP entries shown :           4
status: s - static, c - complete, e - expiring, i - incomplete

interface         ip address      hw address        port              status   ttl
--------------------------------------------------------------------------------
ethernet1/1       10.0.3.1        2c:6b:f5:a1:00:01 ethernet1/1         c      1712
ethernet1/2       10.0.3.5        70:0f:6a:b2:30:30 ethernet1/2         c      1544
ethernet1/3.100   10.100.0.10     00:50:56:8a:20:0a ethernet1/3.100     c      903
ethernet1/3.100   10.100.0.11     (incomplete)      ethernet1/3.100     i      2
```

**`show mac all`** [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_mac_all/paloalto_panos_show_mac_all.raw
```

maximum of entries supported :      1500
default timeout :                   1800 seconds
total MAC entries in table :        2
total MAC entries shown :           2
status: s - static, c - complete, i - incomplete

vlan                hw address        interface         status   ttl
--------------------------------------------------------------------------------
l2-lab              00:50:56:8a:30:01 ethernet1/7         c      1778
l2-lab              00:50:56:8a:30:02 ethernet1/8         c      1796
```

**`show lldp neighbors all`.** One block per local port. `Index` is the interface id and `Local Port ID` is the port number [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_lldp_neighbors_all/paloalto_panos_show_lldp_neighbors_all.raw
```
Local information:
Index 17
Local interface: ethernet1/2
Local Port ID: 2
Neighbor information:

Chassis type: MAC address
Chassis ID: 70:0f:6a:b2:30:00
Port type: Interface name
Port ID: Gi1/0/47
Port description: to-fw1
TTL: 120
System name: core-sw1
System description: Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a
System capabilities:
Supported: B, R,
Enabled: B, R,
```

**`show session all`.** The header and rows are from [doc] https://knowledgebase.paloaltonetworks.com/kcsArticleDetail?id=kA10g000000ClsV (spacing unverified). Each session takes two lines.
```
ID/vsys  application    state  type flag  src[sport]/zone/proto (translated IP[port])
                                              dst[dport]/zone (translated IP[port]
-------------------------------------------------------------------------------
35299/1  ssl            ACTIVE  FLOW  NS  10.100.0.10[52648]/dmz/6 (10.0.3.2[19044])
                                          93.184.216.34[443]/untrust (93.184.216.34[443])
35301/1  dns-base       ACTIVE  FLOW  NS  10.100.0.11[40112]/dmz/17 (10.0.3.2[23811])
                                          8.8.8.8[53]/untrust (8.8.8.8[53])
```
The header is as the KB rendered it. The missing `]` at the end of line 2 is in the KB text. Newer releases may capitalise the header as `ID  Application  State  Type Flag  Src[Sport]/Zone/Proto ...`, with `Vsys` on line 2; this is [unverified, from memory]. Where exactly the flag column sits is also unverified. The flags are `NS` (source NAT), `ND` (destination NAT), `NB` (both), and `D`/`P` for decrypt/proxy.

**`show counter global filter delta yes`.** The header is from [doc] https://knowledgebase.paloaltonetworks.com/KCSArticleDetail?id=kA10g000000ClXO; the column layout is from ntc raw [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_counter_global/paloalto_panos_show_counter_global.raw
```
Global counters:
Elapsed time since last sampling: 55.446 seconds

name                                   value     rate severity  category  aspect    description
--------------------------------------------------------------------------------
pkt_recv                                1832       33 info      packet    pktproc   Packets received
pkt_sent                                1710       30 info      packet    pktproc   Packets transmitted
flow_ipv6_disabled                         3        0 drop      flow      parse     Packets dropped: IPv6 disabled on interface
flow_policy_deny                          12        0 drop      flow      session   Session setup: denied by policy
flow_host_service_deny                     4        0 drop      flow      mgmt      Device management session denied
--------------------------------------------------------------------------------
Total counters shown: 5
--------------------------------------------------------------------------------
```

**`show jobs all`.** The layout is from the newer ntc raw, which has `Dequeued` and `PositionInQ` columns [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_jobs_all/paloalto_panos_show_jobs_all2.raw
```

Enqueued              Dequeued           ID  PositionInQ                              Type                         Status Result Completed
------------------------------------------------------------------------------------------------------------------------------------------
2026/11/24 09:05:12   09:05:12          412                                         Commit                            FIN     OK 09:05:41
2026/11/24 08:30:02   08:30:02          411                                    FqdnRefresh                            FIN     OK 08:30:09
2026/11/24 01:00:07   01:00:07          410                                         Downld                            FIN     OK 01:00:19
2026/11/23 22:14:50   22:14:50          409                                       Validate                            FIN     OK 22:15:18
```

**`test security-policy-match from dmz to untrust source 10.100.0.10 destination 8.8.8.8 destination-port 53 protocol 17`.** The format is from ntc raw, including the vendor typo `destinataion-device` [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/test_security-policy-match/paloalto_panos_test_security-policy-match.raw
```
"dmz-dns-out; index: 3" {
        from dmz;
        source 10.100.0.0/24;
        source-region none;
        to untrust;
        destination [ 8.8.8.8 8.8.4.4 ];
        destination-region none;
        user any;
        source-device any;
        destinataion-device any;
        category any;
        application/service 0:dns/udp/any/53;
        action allow;
        icmp-unreachable: no
        terminal yes;
}
```
`show running security-policy` prints every rule in the same brace format, without the `; index: N` suffix. The ntc raw uses `application/service [ any/tcp/any/8000 ... ]` [secondary] https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_running_security-policy/paloalto_panos_show_running_security-policy.raw.

**`show high-availability state`.** Lines are taken from the `show high-availability all` raw (PAN-OS 6.1 capture) [secondary]. That `state` prints only this subset is [unverified, from memory]. Raw: https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/show_high-availability_all/paloalto_panos_show_high-availability_all.raw
```

Group 1:
  Mode: Active-Passive
  Local Information:
    Version: 1
    Mode: Active-Passive
    State: active (last 12 days)
    State Synchronization: Complete; type: ethernet
  Peer Information:
    Connection status: up
    Version: 1
    Mode: Active-Passive
    State: passive (last 12 days)
  Configuration Synchronization:
    Enabled: yes
    Running Configuration: synchronized
```

**`show log system direction equal backward`.** The layout is [unverified, from memory]: a header with `Time`, `Severity`, `Subtype`, `Object`, `EventID`, `ID` and `Description`, a `====` rule, then one line per event, for example `2026/11/24 09:05:41   informational general ... Configuration committed by admin`. The filters `direction equal`, `receive_time in last-hour`, `query equal`, `csv-output equal yes`, `start-time` and `end-time` are [doc ops hierarchy].

**Running config excerpt** (`set cli config-output-format set`, then `show` in config mode). The format is [doc] customize-the-cli. Note the trailing `[edit]` banner.
```
admin@fw1# show network interface ethernet ethernet1/1
set network interface ethernet ethernet1/1 layer3 ip 10.0.3.2/30
set network interface ethernet ethernet1/1 layer3 interface-management-profile allow-ping
set network interface ethernet ethernet1/1 comment "to edge-r1"
[edit]
admin@fw1#
```

## 7. Dangerous commands

Syntax is from the ops and configure hierarchies [doc] unless noted.

| Command | Effect |
|---|---|
| `request restart system` | Reboot. Prompts `(y or n)` [doc KB PNns] |
| `request restart dataplane` / `request restart software` | Traffic outage |
| `request shutdown system` (`with-swap-scrub dod|nnsa`) | Powers off. Remote recovery is impossible |
| `request system private-data-reset` (`shutdown`) | Wipes logs and config and restores the default config while keeping the PAN-OS image. Behaviour per LIVEcommunity search snippets, [unverified] |
| `request system software install version <v>` / `download` / `request content upgrade install ...` / `request content downgrade ...` | Upgrade or downgrade |
| `request license install` / `fetch` / `deactivate` / `api-key delete` | License changes. `request license info` is read-only |
| `request high-availability state suspend` / `peer suspend` / `functional` | Forces HA failover |
| `request system bootstrap-usb ...`, `request system self-test force-software-integrity-failure` | |
| `debug ...` (2,690 hierarchy lines) | `debug software restart process <proc>` restarts daemons. `debug dataplane packet-diag ...` and `debug system maintenance-mode` are also listed [doc]. Some `debug ... show` forms are read-only, but treat the whole verb as blocked |
| `delete config saved <n>`, `delete software version <v>`, `delete core ...`, `delete license key ...`, `delete admin-sessions ...`, `delete config-audit-history` | Operational-mode `delete`: file and state removal |
| `clear session all` (`filter ...`), `clear session id <n>` | Drops traffic sessions |
| `clear log <type>` | Erases logs (system, traffic, threat, config, ...) |
| `clear arp`, `clear mac`, `clear routing bgp virtual-router <vr> ...`, `clear high-availability ...`, `clear counter global` | Mostly disruptive; `clear counter` is harmless but changes `delta` baselines |
| `scp export/import ...`, `tftp export/import ...`, `ftp ...` | Moves files on or off the box: config exfiltration or config/image import |
| `set cli confirmation-prompt off` | Removes `(y or n)` safety prompts |
| `set password`, `set clock ...`, `set system setting ...` (most), `set session ...`, `set management-server ...` | Op-mode `set` mutates device state. `set cli pager/scripting-mode/config-output-format/terminal` are benign |
| `tail follow yes ...`, `show log ... follow`, `ping` without `count` | Never terminate |
| `ssh host ...` (op-mode client; no `telnet` in the 11.1 hierarchy) | Pivots off the box |
| `schedule ...` | Starts report jobs |
| **Config mode:** `commit` (any form), `delete <anything>`, `set ...`, `load config ...`, `revert config`, `rename`, `move`, `clone`, `edit`, `override` | Changes the candidate or running config. `delete network`, `delete rulebase`, `delete deviceconfig` and `load config from` followed by `commit` are catastrophic |

PlatformRules proposal (new `panos` platform). PAN-OS has no `do`; config mode uses `run`.
```ts
const panos: PlatformRules = {
  read: ['show', 'ping', 'traceroute', 'less', 'grep', 'ls', 'find', 'diff'],
  // ping without `count` runs until Ctrl-C: Hopline must enforce a timeout or inject `count 5`
  // `test` is read-only on PAN-OS (security-policy-match, nat-policy-match, routing fib-lookup)
  // but `test` also has vpn ike-sa / ipsec-sa which *initiate* tunnels; keep it in `other`.
  blocked: ['debug', 'delete', 'scp', 'tftp', 'ftp', 'ssh', 'schedule', 'tail', 'view-pcap'],
  other: ['request', 'clear', 'set', 'test', 'configure', 'exit', 'quit', 'commit', 'validate',
          'revert', 'load', 'save', 'edit', 'up', 'top', 'run', 'rename', 'move', 'copy', 'clone',
          'check', 'override'],   // rename/move/copy/clone/override: built-ins, not in hierarchy page [unverified]
  blockedPairs: [
    ['request', 'restart'],
    ['request', 'shutdown'],
    ['request', 'system'],        // private-data-reset, software install, bootstrap-usb (also blocks read-only `request system software info`)
    ['request', 'content'],
    ['request', 'license'],       // also blocks read-only `request license info`: allowlist it as a 3-token exception
    ['request', 'high-availability'],
    ['request', 'certificate'],
    ['clear', 'session'],
    ['clear', 'log'],
    ['clear', 'routing'],
    ['clear', 'high-availability'],
    ['set', 'password'],
    ['set', 'system'],
    ['set', 'clock'],
    ['set', 'session'],
    ['set', 'management-server'],
    ['load', 'config'],
    ['revert', 'config'],
    ['commit', 'force'],
  ],
  pipesAllowed: ['match', 'except'],
  pipesBlocked: [],               // PAN-OS has no redirect/tee pipes (only match/except documented)
  execFromConfig: 'run'
}
```
What this shape **cannot** express:
- **3+ token distinctions.** Examples: `request license info` (read) vs `request license install` (bad); `request system software info` (read) vs `... install` (bad); `set cli pager off` (fine) vs `set cli confirmation-prompt off` (bad); `test security-policy-match` (read) vs `test vpn ike-sa` (initiates IKE); `debug ... show` vs `debug software restart`. A `readTriples` or allow-exception list is needed.
- **Arguments:** `tail follow yes` vs `tail follow no`; `ping` with or without `count`; `clear session id 123` vs `clear session all`.
- **Config-mode state.** `delete` in config mode removes candidate config while op-mode `delete` removes files. Both are top-level `delete`, so blocking `delete` covers both, but nothing distinguishes `delete rulebase security rules X` from `delete deviceconfig system ntp-servers`. Also, `commit` is only destructive together with whatever the candidate holds, so the guard should treat every `commit` as config.
- **`run` wrapping.** `run request restart system` from config mode must be unwrapped with `execFromConfig: 'run'` before classification.
- **The `[edit ...]` context.** After `edit rulebase security`, a bare `delete rules X` is relative to the context. A per-token guard cannot see the context.

Abbreviation traps (only relevant if PAN-OS accepts prefixes on Enter, which is unverified; see section 3):
- `del` resolves only to `delete`.
- `re` is ambiguous between `request`, `revert` (config) and `rename` (config).
- `cl` → `clear`.
- `sh` resolves only to `show`. `shutdown` sits under `request`, so `sh` is safe.
- `t` covers `test`, `tail`, `tftp`, `traceroute`.
- `s` covers `show`, `set`, `scp`, `ssh`, `schedule`, `save`.

In all cases, block when any expansion is blocked, which is the current guard behaviour.

## 8. Live-value sources

Cheapest structured route on the CLI: `set cli config-output-format set` (or `json` or `xml`), then `show <xpath>` in config mode for config objects. For op state, `set cli op-command-xml-output on` makes op commands return XML [doc: ops hierarchy lists it; behaviour unverified]. The XML API (`/api/?type=op&cmd=<show><interface>all</interface></show>`) is the robust alternative; it uses the same XML as the op-command output.

| Value | Command | Field / regex hint | Structured alternative |
|---|---|---|---|
| Interfaces (physical) | `show interface hardware` | `^(ethernet\d+/\d+|ae\d+|ha\d-[ab]|...)\s+\d+\s+` | `show network interface` in `set` format; API `<show><interface>all</interface></show>` |
| Interfaces (logical, IPs, zones, VR) | `show interface logical` | Columns: name, id, vsys, zone, forwarding (`vr:<name>`), tag, address. Continuation lines carry extra IPs | Same API |
| Zones | `show interface logical` (zone column), config `show zone` | `set zone (\S+) network layer3 ` | `show running ...`; API config xpath `/config/devices/entry/vsys/entry/zone` |
| Virtual routers / logical routers | `show routing route` (`VIRTUAL ROUTER: (\S+) \(id \d+\)`), `show advanced-routing logical-router` | | config `show network virtual-router` (`set` format) |
| vsys | `set system setting target-vsys ?` (completion list), `show system info \| match vsys` | `^(vsys\d+)\s` | API `<show><system><setting><target-vsys/></setting></system></show>` [unverified] |
| BGP peers | `show routing protocol bgp summary` | `peer (\S+): AS (\d+), (\w+), IP ([\d.]+)` | `show routing protocol bgp peer`; ARE: `show advanced-routing bgp peer status` |
| OSPF neighbors | `show routing protocol ospf neighbor` | `neighbor address:\s+(\S+)` | |
| Security rules | config `show rulebase security rules` | `set rulebase security rules "?([^" ]+)"? ` | `show running security-policy` (`^"([^"]+)" \{`) |
| NAT rules | `show running nat-policy` | `^"([^"]+)" \{` | config `show rulebase nat` |
| Address / address-group / service objects | config `show address`, `show address-group`, `show service` | `set address (\S+) ip-netmask` | API config xpath |
| Applications | `show running application ...` / Tab completion on `application` | | [unverified] |
| Saved config snapshots | `load config from ?` completion | file names `*.xml` | `show config saved ?` |
| Jobs | `show jobs all` | `^\d{4}/\d\d/\d\d \S+\s+\S+\s+(\d+)` | API `<show><jobs><all/></jobs></show>` |
| HA state | `show high-availability state` / the prompt suffix | `State: (\S+)` under Local Information | API |
| Sessions | `show session all filter ...` | Two lines per session | API (`show session all` XML) |

## 9. Interface naming

All names are lower-case and written in full. There is no CLI abbreviation such as `e1/1` [unverified that it is rejected]. Name patterns come from ntc raws and docs.

| Kind | Pattern | Regex |
|---|---|---|
| Physical | `ethernet<slot>/<port>` (`ethernet1/1`; PA-7000 slots >1) | `^ethernet\d+/\d+$` |
| L3 subinterface (VLAN tag) | `ethernet1/3.100` (tag = suffix by convention, set separately as `tag 100`) | `^ethernet\d+/\d+\.\d{1,4}$` |
| Aggregate (LAG) | `ae1`, subif `ae1.99` | `^ae\d+(\.\d+)?$` |
| Loopback | `loopback` (parent), `loopback.1` | `^loopback(\.\d+)?$` |
| Tunnel | `tunnel` (parent), `tunnel.1` | `^tunnel(\.\d+)?$` |
| VLAN (L3 SVI-equivalent) | `vlan` (parent), `vlan.10` | `^vlan(\.\d+)?$` |
| HA | `ha1-a`, `ha1-b`, `hsci`, `dedicated-ha1`, `dedicated-ha2` | `^(ha[1-4](-[ab])?|hsci|dedicated-ha[12])$` |
| Management | `management` (`show interface management`); not in the dataplane list | `^management$` |
| Virtual wire | Uses physical names; the vwire object has its own name | |
| SD-WAN | `sdwan.901` (10.x+) | `^sdwan\.\d+$` [unverified] |

Combined regex for Hopline's live-value parser:
```ts
const PANOS_IF = /\b(ethernet\d+\/\d+(?:\.\d+)?|ae\d+(?:\.\d+)?|(?:loopback|tunnel|vlan|sdwan)(?:\.\d+)?|ha[1-4](?:-[ab])?|hsci|dedicated-ha[12]|management)\b/
```

## 10. Simulator and guard fit

Deltas between the current Hopline simulator (`shell.ts`, `engine.ts`) and PAN-OS:

1. **Prompt.**
   - Format: Hopline uses `hostname>` / `hostname(config)#`, while PAN-OS uses `user@host>` / `user@host#`, plus optional `-vsysN` and `(active)` suffixes.
   - The `[edit]` / `[edit <path>]` banner line must be printed before every config-mode prompt, including after command output.
   - Login: the banner prints `Last login: ...` and ends with `admin@fw1>` [unverified]. Netmiko then runs `show system info` and waits for its `operational-mode:` line, so the sim must implement that command [secondary].
2. **Modes.** Hopline has 5 Cisco modes; PAN-OS needs only `exec` and `config`, plus an `editPath: string[]` context. Recommended Mode names: `'op'` and `'configure'`. Alternatively, map them to the existing `'exec'` and `'config'` and add `editPath`. There is no `config-if`, `config-router` or `config-vlan`. Sub-mode is a path such as `['network','interface','ethernet','ethernet1/1']`. `exit` in config mode at `[edit]` leaves to op mode. At a deeper path, `exit` behaves like `up` [unverified]. `quit` always leaves.
3. **Enter config.** `configure` prints `Entering configuration mode`. `exit`/`quit` prints `Exiting configuration mode` [doc]. If uncommitted changes exist, PAN-OS warns about them on exit [unverified string].
4. **Error strings** (substrings verified via scrapli; full forms unverified; see section 3). Replace the IOS `% Invalid input detected at '^' marker.`, `% Ambiguous command:` and `% Incomplete command.` with `Unknown command: <word>`, `Invalid syntax.` and `Server error : <msg>`. Do not print a caret line.
5. **Pager** (string unresolved; see section 2). Replace the shared `' --More-- '` with a per-platform pager. For PAN-OS, default to a `less`-style `lines A-B` status (or no pager) until it is captured. Support `set cli pager off|on`.
6. **Confirm prompt.** `[confirm]` becomes `Executing this command will ... Do you want to continue? (y or n)` for `request restart system`, `request shutdown system` and `request system software install`. There is no `write erase` on PAN-OS.
7. **Control keys.** Ctrl-Z should not leave config mode. Ctrl-C clears the line and stays in the mode. Ctrl-U clears the line, as the simulator already does.
8. **Pipes.** Allow only `match` and `except`. The engine's `include`/`exclude`/`begin`/`section`/`count`/`grep`/`no-more`/`json` should be rejected with `Invalid syntax.` [unverified string] on PAN-OS. `| json` is not a PAN-OS pipe; use `set cli config-output-format json` (config only).
9. **`?` help format.** Use the `> ` / `+ ` / `* ` / `  ` marker column and `<Enter>  Finish input` instead of Cisco's two-column list.
10. **Abbreviation.** If verification confirms that PAN-OS rejects unexpanded prefixes, disable `engine.ts` prefix matching for this platform and keep only Tab and space completion.
11. **Commit model.** The sim needs candidate and running state, `commit` with a job id and progress dots, `validate full` → `Validate job enqueued with jobid N`, `show jobs id N`, `show config diff`, `revert config` and `save config to`. There is no `write memory` or `copy run start`.
12. **Missing commands for a demo.** Every command in the section 6 table, at minimum: `show system info`, `show interface all|logical`, `show routing route`, `show routing protocol bgp summary`, `show routing protocol ospf neighbor`, `show arp all`, `show lldp neighbors all`, `show session all`, `show counter global filter delta yes`, `test security-policy-match`, `show running security-policy`, `show jobs all`, `show high-availability state`, `show log system`, and `set cli pager|scripting-mode|config-output-format`.
13. **Guard.**
    - Add `panos` to `PLATFORMS` with the rules in section 7 and `PLATFORM_LABELS.panos = 'Palo Alto PAN-OS'`.
    - Add a 3-token read allowlist (`request license info`, `request system software info`, `request system software check`, `request content upgrade check`, `request content upgrade info`).
    - Treat op-mode `set` as config by default, except `set cli pager`, `set cli scripting-mode`, `set cli config-output-format` and `set cli terminal`.
    - `execFromConfig` is `'run'`.

## Sources

Vendor (fetched this session):
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/get-started-with-the-cli/customize-the-cli
- https://docs.paloaltonetworks.com/pan-os/10-2/pan-os-cli-quick-start/get-started-with-the-cli/get-help-on-command-syntax
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/get-started-with-the-cli/change-cli-modes
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/use-the-cli/modify-the-configuration
- https://docs.paloaltonetworks.com/pan-os/10-1/pan-os-cli-quick-start/use-the-cli/commit-configuration-changes
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/firewall-administration/manage-configuration-backups/revert-firewall-configuration-changes
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/use-the-cli/view-settings-and-statistics
- https://docs.paloaltonetworks.com/pan-os/10-2/pan-os-cli-quick-start/cli-cheat-sheets/cli-cheat-sheet-device-management
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/cli-cheat-sheets/cli-cheat-sheet-networking
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/cli-cheat-sheets/cli-cheat-sheet-ha
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-cli-quick-start/cli-cheat-sheets/cli-cheat-sheet-vsys
- https://docs.paloaltonetworks.com/pan-os/10-2/pan-os-cli-quick-start/cli-command-hierarchy-for-pan-os-10-2/pan-os-10-2-cli-ops-command-hierarchy (served the PAN-OS 11.1 ops hierarchy)
- https://docs.paloaltonetworks.com/content/techdocs/en_US/ngfw/pan-os-cli-quick-start/cli-command-hierarchy/pan-os-11-1-configure-cli-command-hierarchy.html
- https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/policy/policy-based-forwarding/use-case-pbf-for-outbound-access-with-dual-isps
- https://knowledgebase.paloaltonetworks.com/kCSArticleDetail?id=kA10g000000ClhK (HA reboot procedure)
- https://knowledgebase.paloaltonetworks.com/kcsArticleDetail?id=kA10g000000PNns (CLI upgrade, `(y or n)` prompts)
- https://knowledgebase.paloaltonetworks.com/KCSArticleDetail?id=kA10g000000ClXO (global counters)
- https://knowledgebase.paloaltonetworks.com/kcsArticleDetail?id=kA10g000000ClsV (show session all)

Secondary (fetched this session):
- https://raw.githubusercontent.com/ktbyers/netmiko/develop/netmiko/paloalto/paloalto_panos.py
- https://raw.githubusercontent.com/scrapli/scrapli_community/main/scrapli_community/paloalto/panos/paloalto_panos.py
- https://raw.githubusercontent.com/scrapli/scrapli_community/main/scrapli_community/paloalto/panos/sync_driver.py
- ntc-templates raws under https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/paloalto_panos/: `show_system_info`, `show_interface_all`, `show_routing_route` (1–3), `show_routing_protocol_bgp_summary`, `show_arp_all`, `show_mac_all`, `show_lldp_neighbors_all`, `show_counter_global`, `show_jobs_all` (1–2), `test_security-policy-match`, `show_running_security-policy`, `show_high-availability_all`
