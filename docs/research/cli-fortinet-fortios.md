# Fortinet FortiOS CLI reference for Hopline

> **Scope:** FortiGate / FortiOS 7.0, 7.2, 7.4 and 7.6 (CLI over SSH or console). Researched 2026-11.
> **Lab topology used in samples:** `fgt-edge1`, a FortiGate-VM64 on 7.4.x, local AS 65020, router-id 10.255.0.20.
> - `port1` WAN 203.0.113.2/30, eBGP to ISP 203.0.113.1 AS 64500.
> - `port2` 10.0.2.1/30 to core-sw1 (10.0.2.2, AS 65001, OSPF router-id 10.255.0.1).
> - `port3` LAN 10.20.0.1/24, with VLAN interface `vlan100` 10.20.100.1/24 (VLAN 100).
> - `port10` management 192.168.1.99/24, and a second ISP peer 198.51.100.9 AS 64501 that is down.
>
> **Confidence legend:**
> - `[S#]`: verified against a source fetched this session (see Sources).
> - `[S# secondary]`: from ntc-templates raw captures or a third-party blog.
> - `[unverified, from memory]`: not confirmed this session.
> - "values adapted": the column layout comes from the cited capture, but the IPs and names were swapped for the fgt-edge1 topology.
>
> **Fetch caveat:** Most samples were read through a summarising fetcher. Samples marked "byte-exact" were downloaded with curl and checked with `cat -A`. For every other sample, column whitespace is not guaranteed.

## 1. Prompts

FortiOS has no user/privileged split like IOS. After login you are at the top level. There, `config`, `get`, `show`, `diagnose`, `execute`, `tree` and `exit` are available, subject to the admin profile.

| Context | Prompt | Source |
|---|---|---|
| Top level | `fgt-edge1 # ` | `FGT # diagnose ips cfgscript run` [S12]; `FGT # show` [S8] |
| Inside a table (`config system interface`) | `fgt-edge1 (interface) # ` | `FortigateName (interface) # edit "default"` [S16] |
| Inside a table (`config firewall local-in-policy`) | `fgt-edge1 (local-in-policy) # ` | `Hub (local-in-policy) # edit 1` [S15] |
| Inside an entry (`edit port1`) | `fgt-edge1 (port1) # ` | `Hub (1) # set intf port3` [S15] |
| Inside a single-object table (`config system global`) | `fgt-edge1 (global) # ` | `xxxxx (global) # get` [S20] |
| Multi-VDOM, inside a VDOM (`config vdom` / `edit root`) | `fgt-edge1 (root) # ` | `FW_prod (root) # diagnose sys session list ...` [S28] |
| Multi-VDOM, after `config vdom`, before `edit` | `fgt-edge1 (vdom) # ` | [unverified, from memory; seen only in a search snippet] |
| Multi-VDOM, after `config global` | `fgt-edge1 (global) # ` | [unverified, from memory]. It is the same label as `config system global`. |
| Non-super-admin / restricted profile | `FIREWALL-1 (1) $ ` | A `$` terminator appears in [S17] (FortiManager-pushed session). That `$` means a read-only or non-super-admin profile is [unverified, from memory]. |

Prompt rules:
- **Format:** The prompt is `<hostname> ` + `(<innermost-context>) ` + `# ` (or `$ `). The innermost context is the last `config` table's short name (the last word of the path, e.g. `config router bgp` -> `(bgp)`, `config firewall policy` -> `(policy)`) or the `edit` key (`(port1)`, `(10)`, `(root)`). Only one level is shown, never a full path [S15, S16; table short-name rule from memory].
  - Nested `config` inside an `edit` (e.g. `config router bgp` -> `config neighbor` -> `edit 10.0.2.2`) shows `(neighbor) #` and then `(10.0.2.2) #` [unverified, from memory].
- **Quoting:** `edit "port1"` shows `(port1)` without quotes [unverified, from memory].
- **Default hostname:** The default is the serial number (e.g. `FGVM01TM19008000 # `) [unverified, from memory; search snippet only].
- **Hostname length:** The hostname is max 35 characters. Dots and dashes are kept, so the prompt is not truncated at the first dot [unverified, from memory].
- **HA:** HA state is not shown in the prompt [unverified, from memory]. Use `get system ha status` (section 6). `execute ha manage <index> <user>` jumps to the other member, whose prompt uses that member's hostname [S7].
- **New entry:** `edit` on a name that does not exist creates it and prints `new entry 'VXLAN1' added` [S13]. `edit 0` creates the next free numeric ID in numbered tables [S2].

```text
fgt-edge1 # config system interface
fgt-edge1 (interface) # edit port1
fgt-edge1 (port1) # set alias WAN-ISP1
fgt-edge1 (port1) # next
fgt-edge1 (interface) # end
fgt-edge1 #
```
(Prompt shapes per [S15, S16]; the session as a whole is illustrative.)

## 2. Paging

- **Pager string:** `--More--` [S1, S8]. The leading and trailing spaces, and whether it is followed by a space, are [unverified, from memory]. Observed captures show the bare token on its own line [S8].
- **Keys** [S1]:
  - Enter: show the next line.
  - `q`: stop output and return to the prompt.
  - No key: if nothing is pressed for about 30 seconds, the console truncates the output and returns to the prompt.
  - Space for the next page is [unverified, from memory]; S1 does not list it.
- **Erase behaviour:** Whether the pager erases itself (CR plus spaces or backspaces) after a key press is [unverified, from memory]. Netmiko-style clients usually strip it with a regex.
- **Disabling paging:** this is persistent only. It is a config write and there is no per-session `terminal length 0` [S1, S8]:
  ```text
  config system console
      set output standard
  end
  ```
  - **Restore paging:** `set output more`, which is the default [S1, S8].
  - **Scope:** It applies to `get`/`show` output, not to debug or sniffer output (search snippet; [unverified]).
  - **Multi-VDOM:** `config system console` is a global object, so it needs `config global` first [unverified, from memory].
  - **Workspace mode:** It is one of the objects that cannot be changed inside a config transaction [S9].
- **Grep alternative:** `| grep` output is still paged, but filters shrink it.

## 3. Help and completion

`?` and Tab behaviour [S1]:
- **`?` at an empty prompt:** lists the available commands with a description of each.
- **`<cmd> ?` (with a space):** lists the options of that command.
- **`<partial>?` (no space):** lists matching commands. If only one matches, it is filled in automatically.
- **Tab:** completes the word with the next match. Pressing Tab repeatedly cycles through the matches. This cycling differs from IOS, which does nothing on ambiguity.
- **Literal `?` or Tab:** type Ctrl+V then `?` (or Ctrl+Shift+-), or Ctrl+V then Tab. `?` and Tab cannot be pasted in some SSH clients [S1].
- **Tab and spaces:** Tab completion on a name with a space inserts a backslash escape (`set srcaddr Test\ Address`) [S14].

Abbreviation [S1]:
- Any word can be shortened to its shortest unambiguous prefix. Fortinet's example is `get system status` -> `g sy stat`.
- This applies to keywords, not to object names such as interface or address names.

Help output format: two columns, the name padded then the description. `*` marks a required or name-type token (meaning [unverified]). Example from a real `set member ?` on a switch-interface [S13]:
```text
*interface-name    Physical interface name.
```
Illustrative layout [unverified, from memory]:
```text
fgt-edge1 # get router info ?
bfd           Show BFD information.
bgp           Show BGP information.
...
fgt-edge1 (port1) # set status ?
up      Interface up.
down    Interface down.
```

Special characters [S1]:
- `<`, `>`, `(`, `)`, `#`, `'` and `"` cannot be used in most values.
- Wrap a value containing spaces in quotes, or escape the space with `\`.
- A trailing `\` followed by Enter continues the command on the next line.

### Error formats

FortiOS never prints a caret line. Errors quote the offending token in `before '<token>'`, and most are followed by a numeric return-code line.

| Situation | Output | Source |
|---|---|---|
| Unknown keyword/field in a valid context | `command parse error before 'cfgscript'` + `Command fail. Return code -61` | Real device capture [S12] (lowercase `command`). The docs render it `Command parse error before 'test'` [S3, S4]. |
| Bad value for a field | `value parse error before 'port16'` + `Command fail. Return code -3` | [S13] |
| Reference to a missing object (address, interface…) | `entry not found in datasource` + `value parse error before '<x>'` + `Command fail. Return code -3` | [S13, S14] |
| Name invalid in this context | `node_check_object fail! for name port3` + `value parse error before 'port3'` + `Command fail. Return code -651` | [S15] |
| Reserved name | `The input 'default' can't be interface name.` + `node_check_object fail! for name default` | [S16] |
| Leaving an entry (`next`/`end`) with a mandatory field empty | `Attribute 'intf' MUST be set.` + `Command fail. Return code 1` | [S15, S17] |
| Unsetting a required field | `The attribute can't be empty!` + `Command fail. Return code -56` | [S17] |
| Object locked by another workspace transaction | `Can not config the object since either the object or the referenced objects are` / `being configured by other transactions.` / `Command fail. Return code 14` | [S10 secondary] |
| Command not permitted or not available in this context (admin profile lacks `cli-diagnose`, fnsysctl as non-super-admin, global command inside a VDOM) | `Unknown action 0` (sometimes prefixed by a PID, e.g. `8762: Unknown action 0`, followed by `Command fail. Return code -1`) | [S18, S19, S20] |
| Typo of a top-level verb (`shw`, `exceute`) | `Unknown action 0` | [unverified, from memory]. All fetched evidence ties it to permission or context, not typos. |
| Ambiguous prefix (e.g. `e` = `edit`/`end` in a table) | [unverified]. Believed to be the same `command parse error before 'e'` / `Return code -61`. FortiOS has no distinct "ambiguous" message. | from memory |
| Incomplete command (e.g. `get router info` + Enter) | [unverified]. Believed to print the option list or a parse error, not `% Incomplete command`. | from memory |

Documented return codes [S3]:

| Code | Meaning |
|---|---|
| 1 | Generic CLI syntax error |
| -1 | Invalid length of value |
| -4 | Maximum number of entries has been reached |
| -5 | A duplicate entry already exists |
| -8 | Invalid IP Address |
| -37 | Permission denied |
| -56 | Empty values are not allowed |
| -61 | Input not as expected |
| -160 | CFG_ER_GENERIC |
| -553 | Name conflicts with an interface, VDOM, switch-interface, zone… |
| -651 | Input value is invalid |

-3 (entry not found) is observed in [S13] but not in the doc table.

```text
fgt-edge1 # config firewall policy
fgt-edge1 (policy) # edit 10
fgt-edge1 (10) # set srcaddr LAN-NET
entry not found in datasource

value parse error before 'LAN-NET'
Command fail. Return code -3
fgt-edge1 (10) # set bogus 1
command parse error before 'bogus'
Command fail. Return code -61
fgt-edge1 (10) # abort
fgt-edge1 (policy) #
```
(The strings are verified per the table above. The blank line between them and the exact line sequence are [unverified].)

## 4. Control characters

| Key | Behaviour | Source |
|---|---|---|
| Up / Ctrl+P | Previous command in history | [S1] |
| Down / Ctrl+N | Next command | [S1] |
| Ctrl+A / Ctrl+E | Beginning / end of line | [S1] |
| Ctrl+B / Ctrl+F | Back / forward (the doc says "one word"; it is likely one character) | [S1] |
| Ctrl+D | Delete the character under the cursor | [S1] |
| Ctrl+C | Aborts the current interactive command, e.g. a `config`/`edit` block, discarding changes like `abort`. **Outside `config`/`edit` it closes the CLI connection.** | [S1] |
| `\` + Enter | Line continuation | [S1] |
| Ctrl+V | Quote the next char (`?`, Tab) | [S1] |
| Ctrl+Z | Not documented. Believed to do nothing (FortiOS has no Ctrl+Z to exit). | [unverified, from memory] |
| Ctrl+U / Ctrl+W / Ctrl+K | Believed to erase the line or word (readline-like) | [unverified, from memory] |
| Ctrl+R | No reverse history search known | [unverified, from memory] |
| Ctrl+Shift+6 | Not used. Long-running `diagnose sniffer` and `diagnose debug` output is stopped with Ctrl+C. Background debug keeps running until `diagnose debug disable` / `diagnose debug reset` [S7]. | [S7] + from memory |

## 5. Config model

**Immediate apply, no candidate config** [S2]:
- **`set <field> <value>`:** stages a field in the current entry.
- **`next`:** "saves the entry and exits `edit`". The entry is validated and applied at this point, which is where `MUST be set` errors appear [S15].
- **`end`:** "saves the configuration and exits the current `config` command".
- **`abort`:** "exits a command without saving", discarding changes to the current edit or table.

Other subcommands:
- **Field subcommands:** `unset <field>` (back to default), `append`, `select`, `unselect`, `clear` (for multi-value lists) [S2].
- **Table subcommands:**
  - `edit`, `delete <entry>`
  - `purge`, which deletes every entry and "cannot be undone" [S2]
  - `move <id> before|after <id>`, for ordered tables such as firewall policy
  - `clone <a> to <b>`
  - `rename <a> to <b>`
  - `get`, which lists current values including defaults
  - `show`, which lists only non-default values [S2]
- **`show full-configuration`:** includes defaults [unverified, from memory].
- **`purge` warning** [S2]: Purging `system interface` or `system admin` does not restore defaults, and "can result in being unable to connect to or log in to the FortiGate, requiring the FortiGate to be formatted and restored".

**Saving to flash (`config system global` / `set cfg-save`)** [S11]:
- **`automatic` (default):** every applied change is also written to flash, so there is no "write memory".
- **`manual`:** changes apply but are only persisted with `execute cfg save`. `execute cfg reload` reboots to the last saved config.
- **`revert`:** like manual, but the unit reverts (reboots to the saved config) if the admin session is idle longer than `cfg-revert-timeout` (default 600 s) [S11]. This is the closest thing to a Junos `commit confirmed`.

**Workspace mode / config transactions (6.2+; CLI-only from 7.4.x)** [S5, S9, S10 secondary]:
- **Start:** `execute config-transaction start <minutes>`. The idle timeout is 1–60 minutes, default 5 [S5].
- **Commit and abort:** `execute config-transaction commit` merges into the running config. `execute config-transaction abort` discards [S5, S9].
- **Status:** `diagnose sys config-transaction status` and `diagnose sys config-transaction show txn-meta|txn-info|txn-entity|txn-lock|txn-cli-commands` [S9, S10].
- **Isolation:** other sessions do not see uncommitted changes. Objects touched by a transaction are locked (Return code 14 above).
- **Restrictions:** `execute batch` cannot start it [S9]. Some objects cannot be edited inside a transaction, including `system console`, `system global` (some options), `system settings opmode`, `npu`, `vdom-property` and `storage` [S9].
- **Expiry:** the unit warns, then discards on expiry:

```text
fgt-edge1 # execute config-transaction start 10
config transaction (id=7) started
fgt-edge1 # diagnose sys config-transaction status
The CLI is running config transaction (id=7)
...
config transaction id=7 will expire in 30 seconds
config transaction id=7 will expire in 20 seconds
config transaction id=7 will expire in 10 seconds
config transaction id=7 has expired
fgt-edge1 # execute config-transaction commit
config transaction (id=7) committed
```
(Messages per [S10 secondary, S9]. Whether the prompt changes during a transaction is not documented; believed not to.)

**Backups, restores and revisions:**
- **Backup:** `execute backup config {tftp|ftp|sftp|usb} ...` [unverified, from memory].
- **Restore:** `execute restore config tftp <file> <server>` prompts and reboots by default [S23]:
  ```text
  fgt-edge1 # execute restore config tftp test.conf 10.82.2.2
  This operation will overwrite the current setting and could possibly reboot the system!
  Do you want to continue? (y/n)y

  Please wait...

  Connect to TFTP server 10.82.2.2 ...
  Get file from TFTP server OK.
  File check OK.
  ```
  The blank lines are [unverified].
- **Revisions:** `execute revision list config` and `execute revision delete config <id>` [unverified, from memory].

**Confirm prompts.** FortiOS uses `Do you want to continue? (y/n)`, not `[confirm]`:
- **`execute reboot`:** `This operation will reboot the system !` then `Do you want to continue? (y/n)` [S21]. There is a space before `!`. The source collapsed the line breaks; two lines are assumed.
- **`execute factoryreset`:** `This operation will reset the system to factory default!` then `Do you want to continue? (y/n)` [S22].
- **`execute formatlogdisk`** [S24]:
  ```text
  Log disk is /dev/sda1.
  Formatting this storage will erase all data on it, including
  logs, quarantine files;
  certificate revocation lists (CRLs);
  and require the unit to reboot.
  Do you want to continue? (y/n)
  ```
- **`execute shutdown`:** `This operation will shutdown the system !` / `Do you want to continue? (y/n)` [unverified, from memory].
- **Answering:** a single keypress `y` or `n` answers without Enter [unverified, from memory].

## 6. Show commands

Top-level verbs [S7]:
- **`get`:** formatted status, or a config object with defaults.
- **`show`:** config, non-default lines only.
- **`diagnose`:** low-level state and debug.
- **`execute`:** actions, some of them read-only (`ping`, `log display`).

`| grep` is the only pipe [unverified that no others exist]. It takes options `-i -v -c -A n -B n -f` (`-f` keeps the whole config block) [S27, S28; options -i/-v/-c from memory].

| Command | Purpose | Notes |
|---|---|---|
| `get system status` | Version, serial, hostname, HA mode, VDOM mode | [S7] |
| `get system performance status` | CPU, memory, sessions, uptime | [S7, S25] |
| `get system interface` | Interface summary, one line per interface | [S7] |
| `get system interface physical` | Physical link, speed, duplex, IP | [S7] |
| `show system interface [<name>]` | Interface config | `get system interface <name>` shows all fields |
| `diagnose netlink interface list [<if>]` | Kernel interface table, ifindex, counters | Maps the LLDP index to a name [S30] |
| `diagnose ip address list` | All IPs per interface | [S7] |
| `get hardware nic <if>` / `diagnose hardware deviceinfo nic <if>` | NIC detail, errors | [S7] |
| `get router info routing-table all` | RIB (Quagga-like) | [S7] |
| `get router info routing-table database` | Includes inactive routes | [S7] |
| `get router info kernel` / `diagnose ip route list` | FIB | [S7] |
| `get router info bgp summary` | BGP peers | [S7] |
| `get router info bgp neighbors [<ip> [advertised-routes\|received-routes\|routes]]` | Peer detail | [S7] |
| `get router info bgp network` | BGP table | [unverified, from memory] |
| `get router info ospf neighbor [all]` | OSPF adjacencies | [S7] |
| `get router info ospf interface` / `status` / `database brief` | OSPF state | [S7] |
| `get router info bfd neighbor` | BFD | [S7] |
| `get system arp` | ARP table | [S7] |
| `diagnose ip arp list` | ARP with state and ifindex | [S7, S29] |
| `diagnose netlink brctl name host <switch>` | MAC table of a software switch | [S7] |
| `diagnose switch-controller switch-info mac-table` | MAC table of managed FortiSwitches | [S7] |
| `diagnose lldprx neighbor summary` | LLDP neighbors (needs `set lldp-reception enable` on the interface) | [S30]. 7.6.3+ is said to rename it to `diagnose lldp rx ...` [unverified] |
| `diagnose lldprx port neighbor details <port>` | LLDP TLV detail | [S32 secondary] |
| `diagnose switch-controller switch-info lldp` | LLDP seen by managed FortiSwitches | [S7] |
| `get system interface lldp` | **Not found.** Believed not to exist. | [unverified] |
| `diagnose sys session filter ...` / `diagnose sys session list` | Session table (set a filter first!) | [S7, S28] |
| `diagnose sys session stat` / `get system session status` | Session counts | [S7, S28] |
| `diagnose debug flow filter ...` / `... trace start <n>` + `diagnose debug enable` | Per-packet path and policy trace | [S7, S31] |
| `diagnose sniffer packet <if> '<filter>' <verbose> <count> <a\|l>` | Packet capture; set a count or it runs forever | [S7] |
| `execute log filter ...` / `execute log display` | Read logs (10 per page by default) | [S7, S32] |
| `get system ha status` / `diagnose sys ha checksum cluster` | HA state and sync | [S7] |
| `show firewall policy [<id>]` | Policy config | |
| `diagnose firewall iprope list` | Internal policy table | [S7] |
| `get vpn ipsec tunnel summary` / `diagnose vpn ike gateway list` / `diagnose vpn tunnel list` | IPsec | [S7] |
| `diagnose sys sdwan member` / `health-check status` | SD-WAN | [S7] |
| `diagnose sys top` / `diagnose sys mpstat` | Processes / CPU (runs until `q`) | [S7] |
| `diagnose debug crashlog read` | Crash log | [S7] |
| `diagnose sys vd list` | VDOMs | [S7] |
| `execute ping` / `execute traceroute` / `execute ping-options source <ip>` | Reachability | [S7] |
| `tree [execute\|diagnose]` | Dump the command tree (useful for building completion data) | [S7] |

### 6.1 `get system status`
Byte-exact layout, from [S32 secondary, 7.4.8 capture]. Values adapted from the top 8 lines plus the remaining fields.
```text
fgt-edge1 # get system status
Version: FortiGate-VM64 v7.4.4,build2662,240514 (GA.F)
First GA patch build date: 230509
Current Security Level: Low
Firmware Signature: certified
Virus-DB: 93.06337(2025-11-26 16:20)
Extended DB: 93.06337(2025-11-26 16:20)
AV AI/ML Model: 4.03476(2025-11-26 19:45)
IPS-DB: 34.00122(2025-11-20 01:21)
IPS-ETDB: 0.00000(2001-01-01 00:00)
APP-DB: 34.00124(2025-11-25 00:56)
FMWP-DB: 25.00090(2025-09-15 13:20)
IPS Malicious URL Database: 5.00603(2025-11-21 01:46)
IoT-Detect: 35.00125(2025-11-25 16:28)
OT-Detect-DB: 34.00123(2025-11-21 15:16)
OT-Patch-DB: 34.00123(2025-11-21 13:21)
OT-Threat-DB: 34.00122(2025-11-20 01:20)
IPS-Engine: 7.00575(2025-07-03 18:00)
Serial-Number: FGVM08TM24000123
License Status: Valid
Log hard disk: Available
Hostname: fgt-edge1
Private Encryption: Disable
Operation Mode: NAT
Current virtual domain: root
Max number of virtual domains: 1
Virtual domains status: 1 in NAT mode, 0 in TP mode
Virtual domain configuration: disable
FIPS-CC mode: disable
Current HA mode: standalone
Branch point: 2662
Release Version Information: GA
System time: Tue Nov 24 10:12:44 2026
Last reboot reason: warm reboot
```
- **Not from the capture:** `License Status` (VM-only) and the build/branch numbers for 7.4.4 are [unverified, from memory].
- **Hardware units:** they show `BIOS version:` and `System Part-Number:` instead [S32].

### 6.2 `get system interface physical`
Byte-exact layout [S32 secondary, 7.4 capture]:
```text
fgt-edge1 # get system interface physical
== [onboard]
    ==[port1]
        mode: static
        ip: 203.0.113.2 255.255.255.252
        ipv6: ::/0
        status: up
        speed: 10000Mbps (Duplex: full)
        FEC: none
        FEC_cap: none
    ==[port2]
        mode: static
        ip: 10.0.2.1 255.255.255.252
        ipv6: ::/0
        status: up
        speed: 10000Mbps (Duplex: full)
        FEC: none
        FEC_cap: none
    ==[port10]
        mode: static
        ip: 192.168.1.99 255.255.255.0
        ipv6: ::/0
        status: up
        speed: 1000Mbps (Duplex: full)
        FEC: none
        FEC_cap: none
```
A down port shows `status: down` and `speed: n/a` [unverified, from memory].

### 6.3 `get system interface` (one line per interface)
Byte-exact layout [S32 secondary]. Long lines are truncated here with `...`; real lines continue with `netflow-sampler`, `sflow-sampler`, `src-check`, `explicit-web-proxy` and so on.
```text
fgt-edge1 # get system interface
== [ port1 ]
name: port1   mode: static    ip: 203.0.113.2 255.255.255.252   status: up    netbios-forward: disable    type: physical   ...
== [ port2 ]
name: port2   mode: static    ip: 10.0.2.1 255.255.255.252   status: up    netbios-forward: disable    type: physical   ...
== [ port3 ]
name: port3   mode: static    ip: 10.20.0.1 255.255.255.0   status: up    netbios-forward: disable    type: physical   ...
== [ vlan100 ]
name: vlan100   mode: static    ip: 10.20.100.1 255.255.255.0   status: up    netbios-forward: disable    type: vlan   ...
```
Switch members print a short form, e.g. `name: lan1   status: up    type: physical` [S32].

### 6.4 `get router info routing-table all`
Byte-exact header and code legend [S32 secondary]. Values adapted.
```text
fgt-edge1 # get router info routing-table all
Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP
       O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area
       * - candidate default

Routing table for VRF=0
B*      0.0.0.0/0 [20/0] via 203.0.113.1, port1, 2d03h10m
B       10.10.10.0/24 [20/0] via 10.0.2.2, port2, 2d03h11m
B       10.10.20.0/24 [20/0] via 10.0.2.2, port2, 2d03h11m
C       10.0.2.0/30 is directly connected, port2
C       10.20.0.0/24 is directly connected, port3
C       10.20.100.0/24 is directly connected, vlan100
O       10.255.0.1/32 [110/2] via 10.0.2.2, port2, 01:12:33
C       192.168.1.0/24 is directly connected, port10
C       203.0.113.0/30 is directly connected, port1
```
- **Code column:** 8 characters (`O E2    `, `O*E2    `).
- **ECMP:** a second next-hop is printed on a continuation line indented under the `[` [S32].
- **Static routes:** some 7.x builds append `, [1/0]` (weight/priority) [unverified, from memory].

### 6.5 `get router info bgp summary`
Byte-exact layout [S32 secondary]. The neighbor column is padded to 16. One capture row is one column short; that row looks anonymised.
```text
fgt-edge1 # get router info bgp summary
BGP router identifier 10.255.0.20, local AS number 65020
BGP table version is 7
1 BGP AS-PATH entries
0 BGP community entries

Neighbor        V         AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd
10.0.2.2        4      65001   48211   48230        7    0    0 2d03h11m        5
203.0.113.1     4      64500    9120    9131        7    0    0 2d03h10m        1
198.51.100.9    4      64501       0       0        0    0    0    never Idle       

Total number of neighbors 3
```
Non-established peers print the state left-aligned and padded (`Active     `, `Idle       `), including trailing spaces [S32].

### 6.6 `get router info bgp neighbors`
From [S32 secondary]. Values adapted; first block shown.
```text
fgt-edge1 # get router info bgp neighbors 10.0.2.2
VRF 0 neighbor table:
BGP neighbor is 10.0.2.2, remote AS 65001, local AS 65020, external link
  BGP version 4, remote router ID 10.255.0.1
  BGP state = Established, up for 2d03h11m
  Last read 00:00:01, hold time is 180, keepalive interval is 60 seconds
  Configured hold time is 180, keepalive interval is 60 seconds
  Neighbor capabilities:
    Route refresh: advertised and received (old and new)
    Address family IPv4 Unicast: advertised and received
  Received 48211 messages, 0 notifications, 0 in queue
  Sent 48230 messages, 0 notifications, 0 in queue
  Route refresh request: received 0, sent 0
  Minimum time between advertisement runs is 30 seconds

 For address family: IPv4 Unicast
  BGP table version 7, neighbor version 7
  Index 1, Offset 0, Mask 0x2
  ...
```

### 6.7 `get router info ospf neighbor`
From [S26]. The header is verbatim. Data rows sit one column right of the header in the source, and that offset is kept here. The state renders as `Full/ DR`, `Full/ BDR`, `Full/ DROTHER`, or `Full/ -` on point-to-point links [S26].
```text
fgt-edge1 # get router info ospf neighbor
OSPF process 0:
Neighbor ID     Pri   State           Dead Time   Address         Interface
10.255.0.1        1   Full/ -          00:00:35    10.0.2.2        port2
```

### 6.8 `get system arp` and `diagnose ip arp list`
Byte-exact layout for `get system arp` [S32 secondary]:
```text
fgt-edge1 # get system arp
Address           Age(min)   Hardware Addr      Interface
10.0.2.2          0          00:1e:bd:4a:10:01 port2
10.20.0.50        2          3c:9b:d6:66:52:ab port3
203.0.113.1       0          00:0c:29:aa:01:01 port1
```
The capture has a single space between MAC and interface, while the header implies wider. Keep it.

Layout for `diagnose ip arp list` [S29]:
```text
fgt-edge1 # diagnose ip arp list
index=4 ifname=port2 10.0.2.2 00:1e:bd:4a:10:01 state=00000002 use=32 confirm=670 update=212 ref=6
index=5 ifname=port3 10.20.0.50 3c:9b:d6:66:52:ab state=00000002 use=0 confirm=0 update=3159 ref=2
```

### 6.9 `get system performance status`
From [S25]. Each "session setup rate" entry is one long line on the device.
```text
fgt-edge1 # get system performance status
CPU states: 1% user 0% system 0% nice 99% idle 0% iowait 0% irq 0% softirq
CPU0 states: 0% user 0% system 0% nice 100% idle 0% iowait 0% irq 0% softirq
CPU1 states: 2% user 0% system 0% nice 98% idle 0% iowait 0% irq 0% softirq
Memory: 3112532k total, 1018512k used (32.7%), 1863964k free (59.9%), 230056k freeable (7.4%)
Average network usage: 99 / 9 kbps in 1 minute, 99 / 4 kbps in 10 minutes, 102 / 21 kbps in 30 minutes
Maximal network usage: 144 / 37 kbps in 1 minute, 158 / 61 kbps in 10 minutes, 1069 / 4463 kbps in 30 minutes
Average sessions: 20 sessions in 1 minute, 19 sessions in 10 minutes, 18 sessions in 30 minutes
Maximal sessions: 32 sessions in 1 minute, 35 sessions in 10 minutes, 56 sessions in 30 minutes
Average session setup rate: 0 sessions per second in last 1 minute, 0 sessions per second in last 10 minutes, 0 sessions per second in last 30 minutes
Maximal session setup rate: 3 sessions per second in last 1 minute, 12 sessions per second in last 10 minutes, 21 sessions per second in last 30 minutes
Average NPU sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes
Maximal NPU sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes
Average nTurbo sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes
Maximal nTurbo sessions: 0 sessions in last 1 minute, 0 sessions in last 10 minutes, 0 sessions in last 30 minutes
Virus caught: 0 total in 1 minute
IPS attacks blocked: 0 total in 1 minute
Uptime: 2 days, 3 hours, 14 minutes
```

### 6.10 `diagnose sys session list`
Field layout from [S28]. The FortiOS typo `orgin->sink` is real.
```text
fgt-edge1 # diagnose sys session filter dst 10.10.10.5
fgt-edge1 # diagnose sys session list

session info: proto=6 proto_state=01 duration=42 expire=3558 timeout=3600 flags=00000000 socktype=0 sockport=0 av_idx=0 use=3
origin-shaper=
reply-shaper=
per_ip_shaper=
class_id=0 ha_id=0 policy_dir=0 tunnel=/ vlan_cos=0/255
state=log may_dirty npu f00
statistic(bytes/packets/allow_err): org=4120/31/1 reply=18230/29/1 tuples=2
tx speed(Bps/kbps): 98/0 rx speed(Bps/kbps): 434/3
orgin->sink: org pre->post, reply pre->post dev=5->4/4->5 gwy=10.0.2.2/10.20.0.50
hook=pre dir=org act=noop 10.20.0.50:51514->10.10.10.5:443(0.0.0.0:0)
hook=post dir=reply act=noop 10.10.10.5:443->10.20.0.50:51514(0.0.0.0:0)
misc=0 policy_id=10 pol_uuid_idx=0 auth_info=0 chk_client_info=0 vd=0
serial=002b1aec tos=ff/ff app_list=0 app=0 url_cat=0
rpdb_link_id=00000000 ngfwid=n/a
npu_state=00000000
total session 1
```
`total session N` and the leading blank line are [unverified, from memory].

### 6.11 `diagnose debug flow` (shape)
Function names and messages from [S31]. The `id=20085 trace_id=N func=... line=... msg="..."` prefix comes from search snippets only [unverified].
```text
fgt-edge1 # diagnose debug reset
fgt-edge1 # diagnose debug flow filter addr 10.10.10.5
fgt-edge1 # diagnose debug flow show function-name enable
fgt-edge1 # diagnose debug flow trace start 10
fgt-edge1 # diagnose debug enable
id=20085 trace_id=1 func=print_pkt_detail line=5895 msg="vd-root:0 received a packet(proto=1, 10.20.0.50:1->10.10.10.5:2048) tun_id=0.0.0.0 from port3. type=8, code=0, id=1, seq=1."
id=20085 trace_id=1 func=vf_ip_route_input_common line=2605 msg="find a route: flag=00000000 gw-10.0.2.2 via port2"
id=20085 trace_id=1 func=__iprope_check_one_policy line=2029 msg="checked gnum-100004 policy-10, ret-matched, act-accept"
id=20085 trace_id=1 func=fw_forward_handler line=874 msg="Allowed by Policy-10:"
```

### 6.12 `execute log display`, `get system ha status`, `diagnose lldprx neighbor summary`, `show` excerpts
`execute log display` (byte-exact layout [S32 secondary]; each entry is one long `key=value` line followed by a blank line). Without logs it prints `0 logs found.` / `0 logs returned.`
```text
fgt-edge1 # execute log display
2492 logs found.
10 logs returned.
5.8% of logs has been searched.

1: date=2026-11-24 time=10:01:18 logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" eventtime=1795000878378886140 tz="+0000" srcip=10.20.0.50 srcport=51514 srcintf="port3" srcintfrole="lan" dstip=10.10.10.5 dstport=443 dstintf="port2" ... policyid=10 ... action="accept" ...

```
`get system ha status`, from [S32 secondary, 7.0 capture], first lines:
```text
fgt-edge1 # get system ha status
HA Health Status: OK
Model: FortiGate-VM64
Mode: HA A-P
Group: 28
Debug: 0
Cluster Uptime: 23 days 1:31:39
Cluster state change time: 2026-11-01 13:03:51
Primary selected using:
    <2026/11/01 13:03:51> FGVM08TM24000123 is selected as the primary because its override priority is larger than peer member FGVM08TM24000124.
ses_pickup: enable, ses_pickup_delay=disable
override: enable
Configuration Status:
    FGVM08TM24000123(updated 3 seconds ago): in-sync
    FGVM08TM24000124(updated 4 seconds ago): in-sync
...
Primary     : fgt-edge1      , FGVM08TM24000123, HA cluster index = 1
Secondary   : fgt-edge2      , FGVM08TM24000124, HA cluster index = 0
```
- **`HA Health Status: OK`:** from memory. The capture shows the WARNING form.
- **Standalone units:** they print `HA Health Status: OK` followed by `Mode: standalone` [unverified].

`diagnose lldprx neighbor summary` on 7.0.4+ [S30]. Index 1 is the local interface name, then its ifindex. Releases up to 7.0.3 printed only the ifindex.
```text
fgt-edge1 # diagnose lldprx neighbor summary
1 port 'port2' 4 mac 00:1E:BD:4A:10:01 chassis 00:1E:BD:4A:10:00 port 'Gi1/0/1' system 'core-sw1'
```
There may be a header or a count line; none is shown in the source.

`show` excerpts. The format is from memory [unverified]: 4-space indent per level, quoted strings, `next`/`end`.
```text
fgt-edge1 # show system interface port2
config system interface
    edit "port2"
        set vdom "root"
        set ip 10.0.2.1 255.255.255.252
        set allowaccess ping
        set type physical
        set alias "to-core-sw1"
        set lldp-reception enable
        set snmp-index 2
    next
end
fgt-edge1 # show firewall policy 10
config firewall policy
    edit 10
        set name "LAN-to-core"
        set uuid 2c6b1d7e-5f1a-51ef-6f3a-1a2b3c4d5e6f
        set srcintf "port3"
        set dstintf "port2"
        set action accept
        set srcaddr "LAN-NET"
        set dstaddr "all"
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
end
```

## 7. Dangerous commands

Destructive actions sit under two verbs: `execute` and `diagnose`. Both also hold everyday read commands, such as `execute ping`, `execute log display`, `diagnose sys session list` and `diagnose debug flow`. Neither verb can therefore go in `blocked` or `read` wholesale; the classification must be at the second token or deeper.

| Command | Risk | Source |
|---|---|---|
| `execute reboot` / `execute shutdown` | Outage | [S7, S21] |
| `execute factoryreset` / `factoryreset2` / `factoryreset-shutdown` / `factoryreset-for-central-management` | Wipes config (the command is `factoryreset`; **`factory-reset` does not exist**) | [S7, S22] |
| `execute formatlogdisk` / `execute disk format <ref>` | Wipes logs and caches, then reboots | [S7, S24] |
| `execute erase-disk <disk>` | Secure-erases a disk | [unverified, from memory] |
| `execute restore {config\|image\|...}` | Replaces config or firmware and reboots | [S23] |
| `execute cfg reload` | Reboots to the saved config | [S11] |
| `execute batch`, `execute config-transaction` | Bulk or deferred config | [S9] |
| `execute router clear bgp all` / `execute router restart` | Routing flap | [S7] |
| `execute log delete` / `execute log delete-all` | Destroys logs | [S7; delete-all from memory] |
| `execute ha synchronize stop`, `execute ha failover set` | HA disruption | [S7; failover from memory] |
| `execute vpn sslvpn del-tunnel` | Kicks users | [S7] |
| `execute ssh` / `execute telnet` | Pivot to another host | [S7] |
| `execute backup ...` / `execute tac report` | Exfiltrates config / heavy CPU | [S7] |
| `diagnose sys kill <sig> <pid>` | Kills daemons | [S7] |
| `diagnose sys session clear` (clears the **whole** table if no filter is set) | Drops all sessions | [S7] |
| `diagnose vpn tunnel flush`, `diagnose vpn ike gateway clear\|flush`, `diagnose vpn ike restart` | VPN outage | [S7] |
| `diagnose test application <daemon> 99` (restart) / `ipsmonitor 98` (stop IPS) | Daemon restart | [S7] |
| `diagnose debug application <x> -1` + `diagnose debug enable`, `diagnose debug flow trace start`, `diagnose sniffer packet` without a count | CPU load; output runs until stopped. Debug persists after logout until `diagnose debug reset`. | [S7] |
| `diagnose hardware test suite all`, `diagnose disktest ...` | Hardware test, possibly disruptive | [S7] |
| `diagnose sys ha reset-uptime` | Triggers failover | [S7] |
| `fnsysctl ...` | Shell-like file ops (super_admin only) | [S18] |
| `config ...` + `purge` | Deletes an entire table; can lock you out | [S2] |
| `config ...` + `delete <entry>` | Removes an object | [S2] |
| `config system interface` + `edit portX` + `set mode`/`set ip`/`set allowaccess`, `unset allowaccess` | Management lockout | from memory |

Proposed rules:
```ts
const fortios: PlatformRules = {
  read: ['get', 'show', 'tree'],            // top-level get/show are read-only
  blocked: ['fnsysctl', 'sudo'],            // sudo = run in another VDOM/global context [unverified]
  other: ['config', 'diagnose', 'execute', 'exit', 'end', 'alias'],
  blockedPairs: [
    ['execute', 'reboot'], ['execute', 'shutdown'],
    ['execute', 'factoryreset'], ['execute', 'factoryreset2'],
    ['execute', 'factoryreset-shutdown'], ['execute', 'factoryreset-for-central-management'],
    ['execute', 'formatlogdisk'], ['execute', 'erase-disk'], ['execute', 'disk'],
    ['execute', 'restore'], ['execute', 'cfg'], ['execute', 'batch'],
    ['execute', 'config-transaction'], ['execute', 'revision'],
    ['execute', 'backup'], ['execute', 'usb-disk'], ['execute', 'tac'],
    ['execute', 'ssh'], ['execute', 'telnet'], ['execute', 'set-next-reboot'],
    ['execute', 'central-mgmt'], ['execute', 'update-now'],
    ['diagnose', 'test'], ['diagnose', 'hardware'], ['diagnose', 'disktest'],
    ['diagnose', 'sniffer'],                // never terminates without a count
  ],
  pipesAllowed: ['grep'],
  pipesBlocked: [],                         // no redirect/tee pipes known on FortiOS
  execFromConfig: '',                       // no "do"/"run"; see note
}
```
Read-safe second tokens for a finer classifier: `execute ping|ping-options|traceroute|traceroute-options|log display|log filter|time|date|dhcp lease-list` and `diagnose sys session list|stat|filter`, `diagnose ip arp list`, `diagnose ip route list`, `diagnose netlink interface list`, `diagnose lldprx`, `diagnose sys ha checksum cluster`, `diagnose vpn ike gateway list`, `diagnose vpn tunnel list`.

**What the shape cannot express:**
- **3+ token commands:**
  - `diagnose sys kill`, `diagnose sys session clear` vs `diagnose sys session list`
  - `diagnose debug enable`/`application` vs `diagnose debug crashlog read`
  - `execute log delete` vs `execute log display`
  - `execute router clear bgp` vs `execute router restart`
  - `diagnose vpn tunnel flush` vs `list`
  - `diagnose test application ... 99`
  - `execute ha synchronize stop`
  - The fix is a `blockedPrefixes: string[][]` with arbitrary depth.
- **Arguments:** `execute router clear bgp all` vs `... ip 10.0.2.2 soft in`. `diagnose sys session clear` with or without a filter is stateful; the danger depends on an earlier `diagnose sys session filter`.
- **Config-mode destructive subcommands:** `purge` and `delete` inside any table. Others need the context path:
  - `set allowaccess` / `unset allowaccess` on the management port
  - `set status down` on a port
  - `set vdom-mode multi-vdom`, which logs you out [S6]
  - `set cfg-save revert` with a tiny timeout
  - A context-aware rule set (current table + subcommand) is required.
- **Session-closing keys:** Ctrl+C at the top level closes the session [S1]. A guard that injects Ctrl+C to cancel output can disconnect.

**Abbreviation traps:**
- **`exe` / `diag`:** these are the normal abbreviations, so expansion must happen before pair matching.
- **`exe re`:** ambiguous between `reboot`, `restore`, `revision` and `router`. Treat it as blocked if any expansion is blocked. `exe reb` resolves to `reboot`.
- **`exe fac`:** prefixes all four factoryreset variants. `exe factoryreset` itself is also a prefix of `factoryreset2` and `factoryreset-shutdown`, so exact matching beats prefix matching.
- **`exe form`:** resolves to `formatlogdisk`. `exe sh` is ambiguous between `shutdown` and `ssh`.
- **`pur` / `del`:** inside a table, `pur` = `purge`. `del` = `delete`, but in some tables `delete` competes with nothing, so `d` alone may resolve to it.
- **`un`:** ambiguous between `unset` and `unselect`.
- **`e`:** ambiguous between `edit`, `end` and `execute` depending on context.

**`execFromConfig` note:** FortiOS has no `do`. Inside a table, `get` and `show` act on the table and are read-only. `execute` and `diagnose` are not available until `end` [unverified, from memory]. The guard should treat `get`/`show` as read in config contexts too.

## 8. Live-value sources

| Value | CLI to parse | Field / regex hint | Cheaper structured alternative |
|---|---|---|---|
| Interfaces | `get system interface` | `^== \[ (\S+) \]` and `name: (\S+) .*ip: (\S+ \S+).*status: (\w+).*type: (\w+)` | REST `GET /api/v2/cmdb/system/interface` / `monitor/system/interface` [unverified] |
| Physical link state | `get system interface physical` | `==\[(\S+)\]` then `status:`, `speed:` | `diagnose netlink interface list` |
| Interface names for completion only | `config system interface` + `edit ?`, or `show system interface \| grep edit` | `edit "(\S+)"` | — |
| VLANs | `show system interface \| grep -f "set vlanid"` | Blocks with `set type vlan`, `set vlanid (\d+)`, `set interface "(\S+)"` | REST cmdb `system/interface?filter=type==vlan` [unverified] |
| VDOMs (≈VRF contexts) | `diagnose sys vd list` or `config vdom` + `edit ?` | `name=(\S+)` [unverified] | `get system status` -> `Virtual domain configuration:` |
| VRFs (7.x per-interface `set vrf <n>`) | `get router info routing-table all` | `Routing table for VRF=(\d+)` | — |
| BGP neighbors | `get router info bgp summary` | Rows after `^Neighbor\s+V`: `^(\S+)\s+4\s+(\d+)` | `show router bgp \| grep -f neighbor`; REST `monitor/router/bgp/neighbors` [unverified] |
| OSPF neighbors | `get router info ospf neighbor` | `^(\d+\.\d+\.\d+\.\d+)\s+\d+\s+(\S+(?: \S+)?)\s+\S+\s+(\S+)\s+(\S+)$` | — |
| Route-maps | `show router route-map` | `edit "(\S+)"` at depth 1 | — |
| Prefix-lists | `show router prefix-list` | `edit "(\S+)"` | — |
| Access-lists | `show router access-list` | `edit "(\S+)"` | — |
| Firewall policies | `show firewall policy` | `edit (\d+)` + `set name "(.+)"` | `diagnose firewall iprope list` (internal) |
| Zones | `show system zone` | `edit "(\S+)"` | — |
| SD-WAN zones | `show system sdwan` (`config zone`) | `edit "(\S+)"` | `diagnose sys sdwan member` |
| Address objects / groups | `show firewall address`, `show firewall addrgrp` | `edit "(.+)"` (names may contain spaces; quote them [S14]) | — |
| Services | `show firewall service custom` | `edit "(.+)"` | — |
| IPsec tunnels | `get vpn ipsec tunnel summary` | `'(\S+)'` at line start [unverified] | `show vpn ipsec phase1-interface` |
| ARP | `get system arp` | `^(\S+)\s+(\d+)\s+([0-9a-f:]{17})\s+(\S+)` | `diagnose ip arp list` |
| LLDP neighbors | `diagnose lldprx neighbor summary` | `port '(\S+)' \d+ mac \S+ chassis \S+ port '(.+?)' system '(.+?)'` | — |
| Admin users | `show system admin` | `edit "(\S+)"` | — |

Tips:
- **Object names:** `show <path> | grep edit` is the cheapest generic extractor for any table's names.
- **No `| json` or `| display xml`:** the only structured interface is the REST API (`/api/v2/cmdb/...` for config, `/api/v2/monitor/...` for state), which needs an API token [unverified, from memory].

## 9. Interface naming

- **Opaque names:** FortiOS interface names are opaque strings. There are no type prefixes and no IOS-style abbreviations such as `Gi`/`Te`. Names must be typed in full or Tab-completed. Max length is 15 characters [unverified, from memory].

| Kind | Typical names | Regex hint |
|---|---|---|
| Physical (VM, high-end) | `port1` … `port48`, `x1`/`x2` (10G) [from memory] | `^port\d+$`, `^x\d+$` |
| Physical (desktop models) | `wan`, `wan1`, `wan2`, `dmz`, `internal1`…, `lan1`…, `a`, `b`, `modem` [S32] | |
| Hardware switch | `internal`, `lan` (members hidden from routing) | |
| Management / HA | `mgmt`, `mgmt1`, `mgmt2`, `ha`, `ha1`, `ha2` [S32] | `^(mgmt\|ha)\d*$` |
| VLAN | Any name (e.g. `vlan100`, `Vlan40` [S32]), with `set type vlan`, `set vlanid`, `set interface <parent>` | Not derivable from the name |
| Aggregate (LACP) / redundant | Any name, with `set type aggregate`/`redundant`, `set member` | |
| Loopback | Any name, with `set type loopback` | |
| IPsec tunnel | phase1-interface name (e.g. `Tu-Hub01-Main` [S32]) | |
| SSL VPN | `ssl.root` (`ssl.<vdom>`) | `^ssl\.\S+$` |
| SD-WAN | `virtual-wan-link` (pre-7.0 style and zone) [S15] | |
| VDOM links | `<name>0` / `<name>1` [S6], NPU links `npu0_vlink0`, `npu1_vlink1` [S30] | `^npu\d+_vlink\d+$` |
| Software switch / VXLAN / FortiLink | Any name; `fortilink` is the default [S7 context] | |
| Reserved | `default` cannot be an interface name [S16] | |

- **Quoting:** names are case-sensitive and quoted in `show` output (`edit "port2"`).
- **`edit` on an interface:** `edit <name>` on a non-existent physical name creates a new virtual interface entry, which then fails validation at `next` if `type` or `interface` is missing [unverified, from memory].

## 10. Simulator and guard fit

Deltas between the current Hopline simulator/guard and a real FortiOS device:

1. **Prompt:** the simulator uses IOS `host#` / `host(config-if)#`. FortiOS uses `host # ` with a space before `#` and a trailing space, and `host (<ctx>) # ` with only the innermost context. Add `$ ` for restricted admins.
2. **Pager:** the simulator's shared `' --More-- '` has leading and trailing spaces. FortiOS shows `--More--` [S1, S8]; whether it has surrounding spaces is unverified, so make it per-platform. Keys:
   - Enter = one line, `q` = quit [S1].
   - Add the 30 s auto-truncate as an option.
   - Paging is disabled only by the config write `config system console` / `set output standard`. There is no session command, so the simulator should accept that block and flip a session or global flag.
3. **Errors:** replace the IOS `% Invalid input detected at '^' marker.`, `% Ambiguous command:` and `% Incomplete command.` strings, and drop caret lines entirely. Emit:
   - `command parse error before '<tok>'` + `Command fail. Return code -61` for unknown tokens [S12].
   - `Unknown action 0` for unknown or unpermitted top-level verbs.
   - `value parse error before '<val>'` (+ `entry not found in datasource`) / `Command fail. Return code -3` for bad references [S13].
   - `Attribute '<f>' MUST be set.` / `Command fail. Return code 1` on `next` [S15].
4. **Confirm:** `[confirm]` becomes `Do you want to continue? (y/n)` with the FortiOS lead-in lines (section 5).
   - `execute reboot`, `execute factoryreset`, `execute formatlogdisk` and `execute restore` all prompt.
   - Single-key `y`/`n` [unverified].
5. **Control keys:**
   - **Ctrl+C at the top level closes the session** [S1]; inside `config`/`edit` it aborts like `abort`.
   - Ctrl+Z should be a no-op, not "return to exec".
   - Ctrl+U stays as line-clear [unverified].
6. **Help and completion:**
   - Tab cycles through matches rather than completing only the common prefix [S1].
   - `?` on a partial word auto-fills a unique match [S1].
   - `?` output is two-column `name<pad>Description.`, with `*name` for required name tokens [S13].
7. **Modes:** the current union `exec|config|config-if|config-router|config-vlan` does not fit. FortiOS is a context stack: `config <path>` pushes a table, `edit <key>` pushes an entry, `config <sub>` nests, `next` pops an entry, `end` pops a table, `abort` pops and discards. Recommended Mode names:
   - `fgt-top`: `host # `
   - `fgt-table`: `host (<table>) # `
   - `fgt-entry`: `host (<key>) # `
   - `fgt-vdom`: `host (vdom) # `, then `(<vdomname>)` after `edit`
   - `fgt-global`: `host (global) # `
   - Store the stack (`['system','interface','port1']`) separately and derive the prompt from the top element.
8. **Apply model:** no candidate. `next`/`end` apply and persist (with `cfg-save automatic`); `abort` discards. Optionally support `execute config-transaction start|commit|abort` with the messages in section 5, and `execute cfg save` when `cfg-save manual`.
9. **Pipes:** only `| grep` with `-i -v -c -A -B -f` (`-f` keeps the full `config`/`edit` block containing the match). Remove `include`, `exclude`, `begin`, `section`, `count`, `json` and `no-more` for this platform.
10. **Missing commands to simulate first:**
    - `get system status`
    - `get system interface`
    - `get system interface physical`
    - `get router info routing-table all`
    - `get router info bgp summary`
    - `get router info bgp neighbors`
    - `get router info ospf neighbor`
    - `get system arp`
    - `get system performance status`
    - `get system ha status`
    - `diagnose sys session filter|list`
    - `diagnose lldprx neighbor summary`
    - `execute log display`
    - `show system interface [x]`
    - `show firewall policy [id]`
    - `show` and `get` inside a table
    - `execute ping`
    - `execute reboot`, with its prompt
    - `tree` (cheap way to expose the command tree)
11. **Guard:**
    - Add `fortios` to `PLATFORMS` / `PLATFORM_LABELS` ("Fortinet FortiOS") with the rules in section 7.
    - `execFromConfig` must be allowed to be empty.
    - Classification needs depth-3 prefixes for `diagnose`/`execute`, and context-aware handling of `purge`/`delete`/`set allowaccess` inside `config`.
12. **Abbreviation engine:** the simulator's prefix-abbreviation logic matches FortiOS's rule [S1] (`g sy stat`). However, FortiOS also abbreviates inside config paths (`conf sys int`), and object names (interface, address) are never abbreviated.

## Sources

Fetched this session. Tags are used inline above.

- [S1] FortiOS 7.4.0 Admin Guide, CLI basics: https://docs.fortinet.com/document/fortigate/7.4.0/administration-guide/896276/cli-basics
- [S2] FortiOS 7.4.2 Admin Guide, Subcommands: https://docs.fortinet.com/document/fortigate/7.4.2/administration-guide/627485/subcommands
- [S3] FortiOS 7.2.9 Admin Guide, CLI error codes: https://docs.fortinet.com/document/fortigate/7.2.9/administration-guide/403690
- [S4] FortiOS 7.6.7 Admin Guide, CLI error codes: https://docs.fortinet.com/document/fortigate/7.6.7/administration-guide/257686/cli-error-codes
- [S5] FortiOS 7.6.4 CLI Reference, execute config-transaction: https://docs.fortinet.com/document/fortigate/7.6.4/cli-reference/148302082/execute-config-transaction
- [S6] FortiOS 7.4.0 Admin Guide, VDOM general configurations: https://docs.fortinet.com/document/fortigate/7.4.0/administration-guide/32293
- [S7] FortiOS 7.6.0 CLI troubleshooting cheat sheet: https://docs.fortinet.com/document/fortigate/7.6.0/cli-troubleshooting-cheat-sheet
- [S8] Fortinet KB, CLI command console output mode: https://community.fortinet.com/t5/FortiGate/Technical-Tip-CLI-command-console-output-mode/ta-p/190475
- [S9] Fortinet KB, Workspace mode commit/abort/timeout: https://community.fortinet.com/fortigate-3/technical-tip-fortigate-workspace-mode-commit-abort-and-timeout-behavior-226126
- [S10] (secondary) yurisk.info, Workspace mode example: https://yurisk.info/2022/04/04/fortigate-workspace-mode-commit-changes-example/
- [S11] Fortinet KB, Configuration file save mode: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Configuration-file-save-mode-for-configuration/ta-p/194054
- [S12] Fortinet KB, cfgscript parse error: https://community.fortinet.com/t5/FortiGate/Troubleshooting-Tip-Cannot-run-FortiGate-s-CLI-command-diagnose/ta-p/373434
- [S13] Fortinet forum, entry not found in datasource (switch-interface): https://community.fortinet.com/support-forum-92/solved-error-creating-switch-interface-entry-not-found-in-datasource-71857
- [S14] Fortinet KB, entry not found with spaces: https://community.fortinet.com/t5/FortiGate/Troubleshooting-Tip-Error-Entry-not-found-in-datasource-when/ta-p/387358
- [S15] Fortinet KB, local-in-policy node_check_object fail: https://community.fortinet.com/fortigate-3/troubleshooting-tip-unable-to-create-local-in-policy-node-check-object-fail-194550
- [S16] Fortinet forum, cannot edit "default" interface: https://community.fortinet.com/support-forum-92/cannot-edit-default-interface-through-cli-199547
- [S17] Fortinet forum, FMG install "MUST be set": https://community.fortinet.com/support-forum-92/unknown-change-blocking-my-installation-225511
- [S18] Fortinet KB, fnsysctl Unknown action 0: https://community.fortinet.com/fortigate-3/troubleshooting-tip-fnsysctl-command-returns-unknown-action-0-182691
- [S19] Fortinet KB, Unable to run debug command: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Unable-to-run-debug-command/ta-p/220583
- [S20] Fortinet forum, Error CLI console: https://community.fortinet.com/support-forum-92/error-cli-console-23321
- [S21] Fortinet forum, execute without y/n confirmation: https://community.fortinet.com/t5/Support-Forum/Execute-commands-without-yes-no-confirmation/m-p/214237
- [S22] Fortinet KB, factory reset without losing management: https://community.fortinet.com/fortigate-3/technical-tip-how-to-reset-a-fortigate-with-the-default-factory-settings-without-losing-management-access-98538
- [S23] Fortinet KB, restore config via TFTP: https://community.fortinet.com/fortigate-3/technical-tip-restoring-a-config-file-from-the-cli-by-using-tftp-server-93894
- [S24] Fortinet KB, format log disk: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Standard-procedure-to-format-a-FortiGate-Log-Disk/ta-p/190473
- [S25] Fortinet KB, get system performance status: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Explaining-the-get-system-performance-status/ta-p/228275
- [S26] Fortinet KB, OSPF network types and neighbor state: https://community.fortinet.com/fortigate-3/technical-tip-ospf-network-types-and-corresponding-neighbor-state-219732
- [S27] Fortinet KB, check OSPF sessions: https://community.fortinet.com/t5/FortiGate/Technical-Tip-How-to-check-OSPF-sessions-in-FortiGate/ta-p/218088
- [S28] Fortinet KB, session list filter: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Check-the-session-list-and-filter-by-IP-address-or/ta-p/242090
- [S29] Fortinet KB, diagnostic ARP command: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Diagnostic-ARP-command-information/ta-p/192498
- [S30] Fortinet KB, diagnose lldprx neighbor output: https://community.fortinet.com/t5/FortiGate/Technical-Tip-Query-on-output-of-diagnose-lldprx-neighbor/ta-p/240590
- [S31] Fortinet KB, BGP passthrough debug flow: https://community.fortinet.com/fortigate-3/technical-tip-to-check-how-bgp-passthrough-traffic-flows-with-the-debug-flow-feature-on-the-fortigate-111668
- [S32] (secondary) ntc-templates FortiOS raw captures:
  - https://github.com/networktocode/ntc-templates/tree/master/tests/fortinet
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_system_status/fortinet_get_system_status_7.4.8.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_system_interface_physical/fortinet_get_system_interface_physical_7.4.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_system_interface/fortinet_get_system_interface.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_router_info_routing-table_all/fortinet_get_router_info_routing-table_all.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_router_info_bgp_summary/fortinet_get_router_info_bgp_summary.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_router_info_bgp_neighbors/fortinet_get_router_info_bgp_neighbors.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_router_info_ospf_status/fortinet_get_router_info_ospf_status.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_system_arp/fortinet_get_system_arp.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/get_system_ha_status/fortinet_get_system_ha_status_7.0_hbdev.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/execute_log_display/fortinet_execute_log_display.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/execute_log_display/fortinet_execute_log_display_no_logs.raw
  - https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/fortinet/diagnose_lldprx_port_neighbor_details_port-name/fortinet_diagnose_lldprx_port_neighbor_details_port-name.raw
