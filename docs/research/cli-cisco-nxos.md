# Cisco NX-OS CLI reference for Hopline

> **Scope:** Cisco NX-OS on Nexus 9000 and Nexus 3000 in standalone NX-OS mode (not ACI), releases 9.3(x) and 10.x (10.3/10.4 docs used). N7K-only features (VDCs) are noted where they change prompts.
> **Researched:** 2026-11.
> **Confidence legend:**
> - **[verified: URL]** means the string or layout was seen on a page fetched this session.
> - **[secondary: ntc-templates]** means the text was copied from a raw device capture in the networktocode/ntc-templates test corpus. These are byte-exact captures, re-anonymised by contributors, and the release is often unknown.
> - **[unverified, from memory]** means the text comes from field experience and was not confirmed this session. Treat it as likely, not authoritative.
> - **Whitespace caveat:** spacing inside `[verified]` strings is as rendered by the fetch tool, which can collapse or add spaces. Only the ntc-templates captures are byte-exact.
>
> **Fixture used in every sample** (invented to fit the lab style):
>
> | Item | Value |
> |---|---|
> | Hostname | `leaf1` |
> | Model and release | N9K-C93180YC-FX, NX-OS 10.3(4a) |
> | BGP | AS 65020, router-id 10.255.0.20 (Lo0) |
> | Eth1/49 | 10.0.2.1/31 to spine1 (10.0.2.0, AS 65100), Established |
> | Eth1/50 | 10.0.2.3/31 to spine2 (10.0.2.2, AS 65100), admin down, peer Idle |
> | OSPF | Underlay process `UNDERLAY`, area 0 on Eth1/49-50. spine1 router-id is 10.255.0.101 |
> | VLANs | 100 `DB` on Eth1/1-2 (servers). 200 `APP` on Eth1/3 |
> | SVIs | Vlan100 10.20.100.1/24 and Vlan200 10.20.200.1/24, in VRF `TENANT-A` |
> | Po10 | Eth1/47-48, LACP trunk to `dist-eos1` |
> | mgmt0 | 192.168.100.20/24, VRF `management` |

## 1. Prompts

### Mode prompts

| Mode | How you enter it | Prompt | Source |
|---|---|---|---|
| EXEC (NX-OS has no user/enable split for network-admin) | login | `leaf1#` | [verified: Fundamentals 10.4 CLI chapter, S1] |
| Global config | `configure terminal` | `leaf1(config)#` | [verified: S1] |
| Interface | `interface Ethernet1/1` | `leaf1(config-if)#` | [verified: S1] |
| Subinterface | `interface Ethernet1/49.10` | `leaf1(config-subif)#` | [verified: S1] |
| Interface range | `interface Ethernet1/1-2` | `leaf1(config-if-range)#` | [unverified, from memory] |
| VLAN | `vlan 100` | `leaf1(config-vlan)#` | [unverified, from memory] |
| VRF | `vrf context TENANT-A` | `leaf1(config-vrf)#` | [verified: S1, S9] |
| VRF address family | `address-family ipv4 unicast` under vrf context | `leaf1(config-vrf-af-ipv4)#` | [unverified, from memory] |
| Router BGP | `router bgp 65020` | `leaf1(config-router)#` | [verified: S8] |
| BGP address family | `address-family ipv4 unicast` | `leaf1(config-router-af)#` | [verified: S8] |
| BGP neighbor | `neighbor 10.0.2.0` (the `remote-as` goes inside the block) | `leaf1(config-router-neighbor)#` | [verified: S8] |
| BGP neighbor AF | `address-family ipv4 unicast` under the neighbor | `leaf1(config-router-neighbor-af)#` | [verified: S8] |
| BGP VRF | `vrf TENANT-A` under router bgp | `leaf1(config-router-vrf)#` | [verified: S8] |
| BGP VRF AF / neighbor / neighbor AF | (nested) | `(config-router-vrf-af)#`, `(config-router-vrf-neighbor)#`, `(config-router-vrf-neighbor-af)#` | [verified: S8] |
| Router OSPF | `router ospf UNDERLAY` | `leaf1(config-router)#` | [verified: S10] |
| OSPF virtual link | `area 1 virtual-link …` | `leaf1(config-router-vlink)#` | [verified: S10] |
| Route-map | `route-map RM-OUT permit 10` | `leaf1(config-route-map)#` | [verified: S8] |
| IP ACL | `ip access-list ACL-IN` | `leaf1(config-acl)#` | [unverified, from memory] |
| Prefix-list | single line, no sub-mode | n/a | [unverified, from memory] |
| Config session | `configure session S1` | `leaf1(config-s)#` | [verified: Session Manager chapter, S6] |
| ACL / interface inside a session | | `leaf1(config-s-acl)#`, `leaf1(config-s-if)#` | [verified: S6] |
| Console / VTY line | `line console`, `line vty` | `leaf1(config-console)#`, `leaf1(config-line)#` | [unverified, from memory] |

- **Prompt structure:** `(config-…)` is appended to the hostname, followed by `#` with no trailing space in the docs. The real device prints `leaf1# ` with one trailing space before the cursor [unverified, from memory; the EOS/IOS simulator already does the same].
- **Context word:** NX-OS never puts the interface name in the prompt. That differs from EOS (`config-if-Et1`), so the sim's EOS-specific branch must not apply.
- **`end` and `exit`:** `end` or Ctrl-Z leaves any config mode for EXEC, and `exit` goes up one level [verified: S1].
- **Partial `end`/`exit`:** typed partially, these give an ambiguity error rather than being silently accepted [verified: S1, "generate an ambiguity error instead of silently accepting a partial command"].

### Routing-context (VRF-scoped EXEC)

`routing-context vrf TENANT-A` scopes subsequent show commands to that VRF and changes the prompt. `routing-context vrf default` restores the normal prompt.

```
leaf1# routing-context vrf TENANT-A
leaf1%TENANT-A#
```

- **`%` form:** `switch%red#` is shown in the Unicast VRF chapter [verified: S9], and `N7k-LabSW%management#` on the Cisco tips page [verified: S4].
- **Doc discrepancy:** the Fundamentals 10.4 CLI chapter's mode table renders it as `switch-red#` [verified: S1]. The two device-style sources agree on `%`, so the dash looks like a typo or extraction artifact. Use `%`.

### VDC (Nexus 7000 / 7700 only)

The N9K and N3K have only the default VDC. `show vdc` returns one row, and `switchto vdc` is not available [unverified, from memory].

On N7K, `switchto vdc PROD` gives a prompt of `<switchname>-<vdcname>#`, e.g. `n7k1-PROD#`, and `switchback` returns [unverified, from memory].

The tips page also shows `attach module 4`, which yields `module-4#` [verified: S4].

### Other prompt facts

- **Hostname length:** the hostname is set with `hostname` (`switchname` is an alias). The maximum is 63 characters [unverified, from memory].
- **Dots in the hostname:** I could not confirm whether NX-OS truncates the prompt at the first dot. CDP shows the remote's full FQDN as device-id (`N9K2_TEST.lab.com(SAL1819S6BE)` [secondary: ntc-templates]), but that is the advertised name, not the prompt. Treat it as unknown, and keep simulator hostnames dot-free.
- **Command chaining:** commands can be chained with ` ; `, e.g. `conf t ; hostname N7k-LabSW-DEFAULT ; end` [verified: S4]. This matters for the guard (section 7).
- **Bash shell:** with `feature bash-shell` enabled, `run bash` gives a Linux prompt such as `bash-4.3$` (`bash-4.4$` on 10.x) [unverified, from memory].
- **Debug plugin:** the tips page shows `Linux(debug)#` after `load dplugin` [verified: S4].

## 2. Paging

- **Pager literal:** the pager prompt is `--More--`. The Fundamentals chapter has a "--More-- Prompt Commands" table [verified: S1].
- **Exact padding:** whether the device prints a leading or trailing space, and whether it uses reverse video, is unverified. From memory, NX-OS prints `--More--` at column 0 with no leading space and no trailing space, in plain text over SSH [unverified, from memory]. The Hopline sim's shared `' --More-- '` (IOS style) is therefore probably wrong for NX-OS by one leading and one trailing space.
- **Self-erase:** after a key press, NX-OS behaves like `less`/`more`. It rewrites the line with a carriage return and spaces (`\r        \r`) rather than backspaces [unverified, from memory]. Either looks the same in xterm.js.

Keys at `--More--` [verified: S1; descriptions paraphrased by the page summary]:

| Key | Action |
|---|---|
| Space | next screen (optionally `<n>` Space) |
| `z` | next screen, and sets the screen size |
| Return | next line (optionally `<n>` Return) |
| `d` / Ctrl-Shift-D | scroll |
| `q`, `Q`, Ctrl-C | quit the pager, back to the prompt |
| `s` | skip lines forward |
| `f` | skip screens forward |
| `=` | show the current line number |
| `/regex` | search forward |
| `n` | repeat the last search |
| `!` or `:!` | run a shell command (a guard concern; normally restricted) |
| `.` | repeat the previous pager command |

### Disabling the pager

- **Per command:** `| no-more`, e.g. `show system internal processes cpu 5 | no-more` [verified: S4].
- **Per session:** `terminal length 0` [unverified, from memory; community-confirmed for Nexus, IOS-equivalent semantics]. The default is 24 lines on VTY [unverified, from memory]. `show terminal` shows the length and width; the command `show terminal | i Width` is [verified: S4]. The output form `Length: 25 lines, Width: 98 columns` is [unverified; seen only in a search snippet].
- **Persistently:** there is no `length` command under `line vty` on N9K [unverified, from memory]. The Terminal Settings chapter lists only `exec-timeout` and `session-limit` under `line vty` [verified: S2]. Automation sets `terminal length 0` per login.
- **Related settings:** `terminal width 511`, `terminal session-timeout 0` [verified: S4], and `terminal edit-mode vi [persist]` [verified: S1].

## 3. Help and completion

### `?` help

- **`?` attached to a word** (`sh?`) lists the keywords that start with that prefix, then re-prints the prompt with the partial line [unverified, from memory; same as IOS].
- **`?` after a space** (`show ?`) lists the next tokens as two columns, with the keyword left-aligned and a description. There is no `<cr>` line unless the command is complete [unverified, from memory for the exact spacing].
- **Doc example:** the Fundamentals chapter shows `clock ?` returning `set  HH:MM:SS Current Time` [verified: S1].
- **Pipe list:** `show running-config | ?` lists the pipes: `begin`, `count`, `end`, `exclude`, `include`, `grep`, `egrep`, `head`, `last`, `less`, `no-more`, `section`, `sed`, `sort`, `tr`, `uniq`, `wc`, `xml`, `human`, `cut`, `diff`, `perl`, `sscp`, `vsh` and `email` [verified: S1].
- **`json` pipes:** the doc's list omits `json` and `json-pretty`, but on N9K 9.3/10.x the device lists `json`, `json-pretty`, `json native` and `xml` [unverified, from memory].

```
leaf1# sh?
sh      show    
leaf1# sh
```
```
leaf1# show ip ?
  access-lists    List IP access lists
  adjacency       Display adjacency information
  arp             Display ARP information
  bgp             Display BGP information
  interface       Display IP interface status and configuration
  ospf            Display OSPF information
  route           Show route table
  ...
leaf1# show ip 
```
Both transcripts are [unverified, from memory]. The help descriptions are illustrative. Note that NX-OS help lists can include commands for features not enabled, but `show ip bgp` returns an error until `feature bgp` is on.

### Tab

- **Unique prefix:** Tab completes a unique command, file name or scheme name [verified: S1].
- **Ambiguous prefix:** Tab lists the matches, then re-prints the line. Example: `co<Tab>` lists `configure` and `copy` [verified: S1].
- **No Tab key:** Ctrl-I works as Tab [verified: S1].
- **Space:** there is no space-completion (Junos-style).

### Abbreviation

- **Uniqueness:** any unique prefix is accepted per mode, e.g. `conf t`, `copy run start`, `int e 1/2`, `sh run` [verified: S1].
- **Interface spacing:** a space between the interface type and the number is accepted (`int e 1/2`) [verified: S1].

### Error messages

Two sources conflict here.

| Situation | What real devices print (recommended for the sim) | What the Cisco doc shows |
|---|---|---|
| Unknown keyword (and, from memory, a command for a disabled feature) | `% Invalid command at '^' marker.` [secondary: NetApp KB device transcripts, S11, S12] | `% Invalid input detected at '^' marker.` [S1, in a `clock set` example] |
| Bad argument value (e.g. year `13`) | `% Invalid number, range is (2000:2030) at '^' marker.`-style or `% Invalid parameter detected at '^' marker.` [unverified, from memory] | `% Invalid input detected at '^' marker.` [verified: S1] |
| Bad interface range | `Invalid range at '^' marker.` (the KB rendering showed no leading `%`; likely `% Invalid range at '^' marker.`) [secondary: S12] | n/a |
| Incomplete | `% Incomplete command at '^' marker.` [unverified, from memory] | `% Incomplete command` (no period) [verified: S1] |
| Ambiguous | `% Ambiguous command at '^' marker.` [unverified, from memory] | the doc confirms an ambiguity error exists, but gives no text [S1] |

**Recommendation:** the NetApp KB captures are real NX-OS (N9K/N3K) output pasted by support engineers, while the Cisco doc example appears copied from IOS documentation. So emit:

- `% Invalid command at '^' marker.` for unknown or disabled-feature keywords. This is the most important fix.
- `% Ambiguous command at '^' marker.` and `% Incomplete command at '^' marker.` with a caret line, on the assumption that NX-OS uses one "at '^' marker" family.

Mark the last two as best-guess in code comments.

**Caret line:**

- **Placement:** NX-OS prints the caret on its own line *before* the `%` message, like IOS [verified: S11 shows `^` then `% Invalid command at '^' marker.` on the next line].
- **Alignment:** in S11 the caret is indented past the prompt, so it is counted from column 0 of the echoed line, prompt included. The exact column could not be established, because the KB lines have doubled leading spaces and the caret lands beyond the end of the echoed command. Keep the sim's current rule (prompt length plus the offset of the failing token) [unverified].

Device transcript [secondary: NetApp KB S11, whitespace as rendered there]:

```
40gj3-rtp-1(config)# interface Ethernet1/31
40gj3-rtp-1(config-if)#  description Intra-Cluster Switch ISL Port 1/31 (port channel)
40gj3-rtp-1(config-if)#  priority-flow-control mode auto
                                                 ^
% Invalid command at '^' marker.
40gj3-rtp-1(config-if)#  mtu 9216
                                                 ^
% Invalid command at '^' marker.
```

Sim-ready transcript for leaf1 [caret placement unverified]:

```
leaf1# show interfaces brief
            ^
% Invalid command at '^' marker.
leaf1# sh ip bgp summ
             ^
% Invalid command at '^' marker.
leaf1# show ip
              ^
% Incomplete command at '^' marker.
leaf1# s ver
       ^
% Ambiguous command at '^' marker.
```

Notes:

- **Rules used:** carets are computed as the prompt length plus the offset of the failing token. The `sh ip bgp summ` example assumes `feature bgp` is disabled [unverified, from memory]. The incomplete caret is placed one past the end of the line.
- **`interfaces`:** NX-OS accepts `show interface` but not `show interfaces` [unverified, from memory; the sim should reject the plural].
- **`s`:** `s` is ambiguous on NX-OS (`show`, `sleep`, `ssh`, `send`, `setup`, `system`, …), so automation always uses `sh`.

## 4. Control characters

From the Fundamentals 10.4 keystroke table [verified: S1, paraphrased]:

| Key | NX-OS behavior |
|---|---|
| Ctrl-A / Ctrl-E | Beginning / end of line |
| Ctrl-B / Ctrl-F | Cursor left / right one character |
| Ctrl-C | Cancel the current command line and return to the prompt (stays in the current mode) |
| Ctrl-D | Delete the character at the cursor |
| Ctrl-G | Exit to the previous command mode *without* removing the typed text |
| Ctrl-K | Delete to end of line |
| Ctrl-L, Ctrl-R | Redisplay the current line (Ctrl-R is **not** reverse search) |
| Ctrl-N / Ctrl-P | Next / previous history |
| Ctrl-O | Clear the terminal screen |
| Ctrl-T | Transpose characters |
| Ctrl-U | Delete from cursor to beginning of line |
| Ctrl-V | Literal next key (e.g. a `?` inside a regex) |
| Ctrl-W | Delete the word left of the cursor |
| Ctrl-X then H | List history |
| Ctrl-Y | Yank the most recent kill buffer |
| Ctrl-Z | Leave config mode and return to EXEC (the current line is executed first) |
| Up/Down, Left/Right | History, cursor |

- **History:** `show cli history [n] [config-mode|exec-mode|this-mode-only] [unformatted]` (default 12 lines), and `!<n>` re-runs entry n [verified: S1].
- **Ctrl-Shift-6:** not documented as a break sequence on NX-OS. Ctrl-C aborts a running ping, traceroute or pager [unverified, from memory].
- **Sim delta, Ctrl-C:** Ctrl-C on NX-OS does **not** drop config mode to EXEC (it only clears the line). The sim currently returns to exec on Ctrl-C for all platforms [Ctrl-C semantics: unverified, from memory, consistent with S1's "return to the prompt"].

## 5. Config model

- **Running config:** changes take effect line by line, immediately, as on IOS. There is no candidate in normal `configure terminal`.
- **Feature model:** most protocols are disabled until a `feature` command enables them.
  - Examples: `feature bgp` [verified: S8], `feature ospf` [verified: S10], `feature interface-vlan` (SVIs), `feature lacp`, `feature lldp`, `feature vpc`, `feature hsrp`, `feature bfd`, `feature nxapi`, `feature bash-shell`, `feature nv overlay`, `feature scp-server`. The names other than bgp and ospf are [unverified, from memory, consistent with the `show feature` capture below].
  - Before a feature is enabled, its config and show keywords are rejected with `% Invalid command at '^' marker.` [unverified, from memory]. S11 shows the same error for `priority-flow-control`, `switchport mode trunk` and `mtu 9216`, but the KB does not say why, so it is not evidence of feature gating.
  - `no feature X` deletes all config for X. NX-OS auto-creates a system checkpoint first, whose name starts with `system-` and includes the feature name [verified: S5]. The exact form is `system-fm-<feature>` [unverified, from memory].
  - `show feature` [secondary: ntc-templates]:

```
Feature Name          Instance  State
--------------------  --------  --------
bash-shell             1          enabled
bfd                    1          disabled
bgp                    1          disabled
dhcp                   1          disabled
eigrp                  1          disabled
```

- **Enter config:**

```
leaf1# configure terminal
Enter configuration commands, one per line. End with CNTL/Z.
leaf1(config)#
```
The banner line is [unverified, from memory; identical to IOS].

- **Save:** `copy running-config startup-config` (`copy run start`) [verified: S1, S3]. `write memory` does not exist on NX-OS; `write` only has `erase` [unverified, from memory].

```
leaf1# copy running-config startup-config
[########################################] 100%
Copy complete, now saving to disk (please wait)...
Copy complete.
```
The progress bar and the final line are [unverified, from memory]. The line `Copy complete, now saving to disk (please wait)...` is [secondary: NetApp KB S12].

- **Checkpoint and rollback** [verified: Rollback chapter S5]:
  - `checkpoint [name] [description text]` or `checkpoint file <file>`.
  - `no checkpoint name` removes one, and `clear checkpoint database` removes all.
  - `rollback running-config {checkpoint name | file f} [atomic | best-effort | stop-at-first-failure]`. The default is **atomic**.
  - `show checkpoint summary [user|system]`, `show checkpoint <name>`, and `show diff rollback-patch checkpoint stable running-config`.
  - At most 10 user checkpoints. They survive reload, but `write erase` plus reload deletes them.

```
leaf1# checkpoint pre-change description before BGP edit
...........Done
leaf1# rollback running-config checkpoint pre-change
Note: Applying config parallelly may fail Rollback verification
Collecting Running-Config
#Generating Rollback Patch
Executing Rollback Patch
Generating Running-config for verification
Generating Patch for verification
Verification is Successful.

Rollback completed successfully.
```
The output strings above are [unverified, from memory]; the docs show the commands only.

- **Configure replace** (9.3(1)+): `configure replace bootflash:golden.cfg [verbose] [commit-timeout <sec>]`, then `configure replace commit` to confirm when a timeout was given. Otherwise it reverts [unverified, from memory].
- **Config sessions** (`configure session <name>`) [verified: S6]:
  - Prompt `(config-s)#`. Inside it: `verify` prints `Verification Successful`, `commit` prints `Commit Successful`, and `abort` discards.
  - `save <file>` writes the session to bootflash:, slot0: or volatile:.
  - `show configuration session [name|status|summary]`.
  - Only ACL and QoS are supported, with at most 32 sessions and 20,000 commands. Sessions do not survive reload.
  - `show configuration session summary` [secondary: ntc-templates]:

```
Session Manager Database:
--------------------------------------------------------------------
Name                    Session Owner           Creation Time
--------------------------------------------------------------------
ACL-SESSION1            ntc                     02:37:14 UTC Oct 28 2017

Number of active configuration sessions = 1
```

- **Confirm prompts** [verified: S3]:

```
leaf1# write erase
Warning: This command will erase the startup-configuration.
Do you wish to proceed anyway? (y/n)  [n] y
leaf1# reload
This command will reboot the system. (y/n)?  [n] y
```

- **Write erase variants:** `write erase boot` also erases the boot variables and the mgmt0 IPv4 config, and `write erase debug` erases the debug config [verified: S3].
- **Confirm format:** NX-OS uses `(y/n)?  [n]`, apparently with two spaces before `[n]` (spacing as rendered by the fetch, see the whitespace caveat), not IOS `[confirm]`. The sim's `[confirm]` is wrong for NX-OS.
- **`vrf member`:** `vrf member TENANT-A` on an interface removes all existing L3 config on that interface [verified: S9]. The device prints a warning such as `Warning: Deleted all L3 config on interface Vlan100` [unverified, from memory].

## 6. Show commands

| Command | Purpose | Notes |
|---|---|---|
| `show interface brief` | All ports: VLAN, mode, status, reason, speed, Po | Multi-section output (mgmt, Ethernet, Po, Lo, Vlan) |
| `show interface status` | IOS-style port status table | |
| `show interface Ethernet1/49` | Full counters and state | |
| `show interface description` | Descriptions | |
| `show interface trunk` | Trunks / allowed VLANs | |
| `show interface transceiver [details]` | Optics / DOM | |
| `show ip interface brief [vrf all]` | L3 interfaces per VRF | **Default VRF only** unless `vrf all` or `vrf X` |
| `show ip interface brief vrf all` | Every VRF | |
| `show vrf [detail\|interface]` | VRFs, IDs, state | |
| `show vlan [brief\|id 100]` | VLANs and ports | |
| `show port-channel summary` | LACP bundles | |
| `show spanning-tree [summary\|vlan 100]` | STP | |
| `show mac address-table [vlan 100\|interface e1/1]` | L2 table | Legend header |
| `show ip arp [vrf all\|vrf X]` | ARP | Flags legend header |
| `show ip route [vrf all\|vrf X] [summary]` | RIB | `*via` format |
| `show bgp ipv4 unicast summary [vrf all]` | BGP peers | Form and equivalence to `show ip bgp summary` [unverified, from memory]. S7 shows only `show ip bgp summary`, and S8 only `show bgp all [summary]` |
| `show bgp l2vpn evpn summary` | EVPN peers | |
| `show ip bgp neighbors 10.0.2.0` | Peer detail | [S7] |
| `show ip bgp neighbors 10.0.2.0 advertised-routes` / `received-routes` / `routes` | Prefix exchange | [S7] |
| `show ip bgp` / `show ip bgp 10.0.0.0/8` | BGP table | [S7] |
| `show bgp all summary [vrf X]` | All AFs | [S8] |
| `show ip ospf neighbors [vrf all]` | OSPF adjacencies | Doc syntax is `neighbors` (plural) [S10]; `neighbor` is an accepted prefix |
| `show ip ospf interface brief` | OSPF interfaces | |
| `show ip ospf [UNDERLAY]` | OSPF process | |
| `show cdp neighbors [detail]` | CDP | |
| `show lldp neighbors [detail]` | LLDP | Needs `feature lldp` |
| `show version` | Release, uptime, hardware | |
| `show module` / `show inventory` / `show environment` | Hardware | |
| `show logging logfile [last-index\|start-time …]` | Local syslog file | [S13] |
| `show logging last 50` | Last n lines | Range 1-9999 [S13] |
| `show running-config [bgp\|interface e1/1\|ospf\|vrf X]` | Config, per feature | `show running-config bgp` [S7] |
| `show running-config diff` | Running vs startup | |
| `show startup-config` | Saved config | |
| `show feature` | Enabled features | |
| `show checkpoint summary` | Checkpoints | [S5] |
| `show vpc [brief]` | vPC state | |
| `show nve peers` / `show nve vni` | VXLAN | |
| `show system resources` / `show processes cpu sort` | CPU / memory | |
| `show accounting log [last n]` | Command audit | [S4] |
| `show cli history` | Session history | [S1] |

### Sample outputs

The column layouts below are cloned from the ntc-templates raw captures (byte-checked with `cat -A`) and refilled with fixture values. Where a capture was whitespace-mangled, the row layout is marked unverified.

#### show interface brief
Layout: [secondary: ntc-templates `cisco_nxos_show_interface_brief*.raw`]

```
leaf1# show interface brief

--------------------------------------------------------------------------------
Port   VRF          Status IP Address                              Speed    MTU
--------------------------------------------------------------------------------
mgmt0  --           up     192.168.100.20                          1000     1500

--------------------------------------------------------------------------------
Ethernet      VLAN    Type Mode   Status  Reason                   Speed     Port
Interface                                                                    Ch #
--------------------------------------------------------------------------------
Eth1/1        100     eth  access up      none                        25G(D) --
Eth1/2        100     eth  access up      none                        25G(D) --
Eth1/3        200     eth  access down    Link not connected         auto(D) --
Eth1/47       1       eth  trunk  up      none                        25G(D) 10
Eth1/48       1       eth  trunk  up      none                        25G(D) 10
Eth1/49       --      eth  routed up      none                       100G(D) --
Eth1/50       --      eth  routed down    Administratively down      auto(D) --

--------------------------------------------------------------------------------
Port-channel VLAN    Type Mode   Status  Reason                    Speed   Protocol
Interface                                                                  
--------------------------------------------------------------------------------
Po10         1       eth  trunk  up      none                       a-25G(D)  lacp

--------------------------------------------------------------------------------
Interface     Status     Description
--------------------------------------------------------------------------------
Lo0           up         router-id / BGP source

--------------------------------------------------------------------------------
Interface Secondary VLAN(Type)                    Status Reason                 
--------------------------------------------------------------------------------
Vlan100   --                                      up     --
Vlan200   --                                      up     --
```

- **Speed column:** speed is right-aligned so that it ends at column 76, and `Port Ch #` starts at column 77.
- **Trunk VLAN:** for a trunk, the VLAN column shows the native VLAN.
- **Leading blank line:** the output starts with an empty line before the first dashed rule.
- **Missing sections:** sections for absent interface types (e.g. no Po) are omitted.

#### show ip interface brief vrf all
Layout: [secondary: ntc-templates `cisco_nxos_show_ip_interface_brief*.raw`]

```
leaf1# show ip interface brief vrf all
IP Interface Status for VRF "default"(1)
Interface            IP Address      Interface Status
Lo0                  10.255.0.20     protocol-up/link-up/admin-up       
Eth1/49              10.0.2.1        protocol-up/link-up/admin-up       
Eth1/50              10.0.2.3        protocol-down/link-down/admin-down 

IP Interface Status for VRF "management"(2)
Interface            IP Address      Interface Status
mgmt0                192.168.100.20  protocol-up/link-up/admin-up       

IP Interface Status for VRF "TENANT-A"(3)
Interface            IP Address      Interface Status
Vlan100              10.20.100.1     protocol-up/link-up/admin-up       
Vlan200              10.20.200.1     protocol-up/link-up/admin-up       
```

- **Columns:** Interface is 21 characters wide and IP Address 16. Status rows carry trailing spaces, padded to about 35.
- **Without `vrf all`:** only the `"default"(1)` block is printed. This is a classic trap: mgmt0 is "missing".

#### show bgp ipv4 unicast summary (equivalently `show ip bgp summary`) [equivalence unverified, from memory]
- **Header lines:** [secondary: ntc-templates `cisco_nxos_show_ip_bgp_summary.raw`, an IPv4 Multicast capture; AF name swapped]. S7 shows the `BGP router identifier …, local AS number …` line and a `Neighbor V AS MsgRcvd…` header [verified: S7]. The "BGP summary information for VRF default, address family IPv4 Unicast" line appeared only in search-result snippets, so it is [secondary: ntc-templates] only.
- **Row layout:** the column table is cloned from the byte-exact rows (10.0.0.1-10.0.0.9) in `cisco_nxos_show_ip_bgp_summary.raw`, plus the clean header in `…summary2.raw` [secondary: ntc-templates]. These columns are right-aligned to AS col 30, MsgRcvd 38, MsgSent 46, TblVer 56, InQ 61 and OutQ 66. Up/Down is **left-aligned** from column 67, and State/PfxRcd is right-aligned to column 84. The neighbor-table header lines in the first capture are whitespace-collapsed and were ignored.

```
leaf1# show bgp ipv4 unicast summary
BGP summary information for VRF default, address family IPv4 Unicast
BGP router identifier 10.255.0.20, local AS number 65020
BGP table version is 42, IPv4 Unicast config peers 2, capable peers 1
14 network entries and 14 paths using 3416 bytes of memory
BGP attribute entries [2/704], BGP AS path entries [1/6]
BGP community entries [0/0], BGP clusterlist entries [0/0]

Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd
10.0.2.0        4        65100    5531    5472        42    0    0 3d22h              12
10.0.2.2        4        65100       0       0         0    0    0 19:21:26 Idle (Admin)
```

- **State column:** an admin-shutdown peer shows `Idle (Admin)` [secondary: ntc-templates]. A peer that never came up shows `never` in Up/Down [secondary: ntc-templates].
- **Up/Down format:** `hh:mm:ss` under 24h, then `XdYh`, `XwYd`, `XyYw` [secondary: ntc-templates rows `3w0d`, `1y10w`, `19w5d`].
- **Error without BGP:** `show bgp …` with `feature bgp` disabled gives `% Invalid command at '^' marker.` [unverified, from memory].

#### show ip ospf neighbors
Layout: [secondary: ntc-templates `cisco_nxos_show_ip_ospf_neighbor.raw`]

```
leaf1# show ip ospf neighbors
 OSPF Process ID UNDERLAY VRF default
 Total number of neighbors: 1
 Neighbor ID     Pri State            Up Time  Address         Interface
 10.255.0.101      1 FULL/ -          3d22h    10.0.2.0        Eth1/49
```

- **Indent:** each line has a one-space indent.
- **`FULL/ -`:** this means a point-to-point link with no DR role. On broadcast links it is `FULL/DR`, `FULL/BDR` or `2WAY/DROTHER` [unverified, from memory].
- **Columns:** Pri is right-aligned to column 19, and the columns start at 21, 38, 47 and 63.

#### show ip route
Layout: [secondary: ntc-templates `cisco_nxos_show_ip_route.raw`]

```
leaf1# show ip route
IP Route Table for VRF "default"
'*' denotes best ucast next-hop
'**' denotes best mcast next-hop
'[x/y]' denotes [preference/metric]
'%<string>' in via output denotes VRF <string>

10.0.2.0/31, ubest/mbest: 1/0, attached
    *via 10.0.2.1, Eth1/49, [0/0], 3d22h, direct
10.0.2.1/32, ubest/mbest: 1/0, attached
    *via 10.0.2.1, Eth1/49, [0/0], 3d22h, local
10.255.0.20/32, ubest/mbest: 2/0, attached
    *via 10.255.0.20, Lo0, [0/0], 3d22h, local
    *via 10.255.0.20, Lo0, [0/0], 3d22h, direct
10.255.0.101/32, ubest/mbest: 1/0
    *via 10.0.2.0, Eth1/49, [110/41], 3d22h, ospf-UNDERLAY, intra
10.100.0.0/16, ubest/mbest: 1/0
    *via 10.0.2.0, [20/0], 3d22h, bgp-65020, external, tag 65100
```

- **Route lines:** `prefix, ubest/mbest: U/M[, attached][, pending]`, then a four-space indent, `*via nh[%vrf], [iface,] [AD/metric], age, proto-instance, type[, tag N]`.
- **Protocol tags:** these are `ospf-<tag>`, `bgp-<asn>`, `eigrp-<tag>`, `static`, `direct` and `local`.
- **eBGP routes:** these omit the interface (recursive) [unverified, from memory; consistent with the capture's static row `*via 10.10.50.1, [1/0], 1d21h, static`].
- **Cross-VRF next hop:** shown as `*via 10.1.100.1%management` [secondary: ntc-templates].

#### show mac address-table
Layout: [secondary: ntc-templates `cisco_nxos_show_mac_address-table.raw`, a 9.x format]

```
leaf1# show mac address-table
Legend:
        * - primary entry, G - Gateway MAC, (R) - Routed MAC, O - Overlay MAC
        age - seconds since last seen,+ - primary entry using vPC Peer-Link,
        (T) - True, (F) - False
     VLAN       MAC Address       Type     age    Secure  NTFY     Ports
------------+-----------------+----------+-------+------+------+------------------
*    100        0050.56a1.0101   dynamic    0        F      F    Eth1/1
*    100        0050.56a1.0102   dynamic    0        F      F    Eth1/2
*    200        0050.56a1.0203   dynamic    0        F      F    Po10
G    100      00de.fb20.0001     static     -        F      F    sup-eth1(R)
```

- **Row columns:** flag at column 0, VLAN at 5, MAC at 16, Type at 33, age at 44, Secure at 53, NTFY at 60 and Ports at 65.
- **Header misalignment:** the header row is offset differently from the data rows in the real capture. Keep that misalignment.
- **Router MAC:** the gateway/router MAC row (`G`) shows the SVI VLAN and port `sup-eth1(R)`. Its spacing differs from the `*` rows (VLAN at 5, MAC at 14), copied exactly from the capture [secondary: ntc-templates].
- **Older format:** 7.x prints `VLAN     MAC Address      Type      age     Secure NTFY Ports/SWID.SSID.LID` [unverified, from memory].

#### show ip arp
Layout: [secondary: ntc-templates `cisco_nxos_show_ip_arp.raw`, captured with `vrf all`]

```
leaf1# show ip arp vrf all

Flags: * - Adjacencies learnt on non-active FHRP router
       + - Adjacencies synced via CFSoE
       # - Adjacencies Throttled for Glean
       D - Static Adjacencies attached to down interface

IP ARP Table for all contexts
Total number of entries: 4
Address         Age       MAC Address     Interface
10.0.2.0        00:12:44  00de.fb65.0101  Ethernet1/49
192.168.100.1   00:04:10  0000.0c9f.f001  mgmt0
10.20.100.11    00:01:02  0050.56a1.0101  Vlan100
10.20.100.12    00:00:57  0050.56a1.0102  Vlan100
```

- **Default-VRF header:** plain `show ip arp` prints `IP ARP Table for context default` [unverified, from memory].
- **Interface names:** the Interface column uses **full** names (`Ethernet1/49`, `Ethernet1/1.2151`).
- **Incomplete entries:** these show `INCOMPLETE` in the MAC column, and static entries show `-` as Age [secondary: ntc-templates].

#### show cdp neighbors
Layout: [secondary: ntc-templates `cisco_nxos_show_cdp_neighbors.raw`, first three entries; the later rows in that file are whitespace-collapsed]

```
leaf1# show cdp neighbors
Capability Codes: R - Router, T - Trans-Bridge, B - Source-Route-Bridge
                  S - Switch, H - Host, I - IGMP, r - Repeater,
                  V - VoIP-Phone, D - Remotely-Managed-Device,
                  s - Supports-STP-Dispute

Device-ID          Local Intrfce  Hldtme Capability  Platform      Port ID
spine1(FDO24120AB1)
                    Eth1/49        133    R S I s   N9K-C9364C    Eth1/1
mgmt-sw1           mgmt0          179    S I         WS-C3850-48T  Gig1/0/20

Total entries displayed: 2
```

- **Device-ID:** NX-OS peers advertise `hostname(serial)`. When that exceeds about 18 characters, the row wraps and the rest is indented by 20 spaces.
- **Remote neighbors:** dist-eos1 is not listed, because Arista does not run CDP by default; use LLDP.
- **JSON:** the NX-API rows are `TABLE_cdp_neighbor_brief_info` with keys `device_id`, `intf_id`, `ttl`, `capability`, `platform_id` and `port_id` [verified: S15].

#### show lldp neighbors
Layout: [secondary: ntc-templates `cisco_nxos_show_lldp_neighbors.raw`]

```
leaf1# show lldp neighbors
Capability codes:
  (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
  (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other
Device ID            Local Intf      Hold-time  Capability  Port ID  
spine1               Eth1/49         120        BR          Ethernet1/1   
dist-eos1            Eth1/47         120        BR          Ethernet45    
dist-eos1            Eth1/48         120        BR          Ethernet46    
Total entries displayed: 3
```

- **Columns:** these start at 0, 21, 37, 48 and 60.
- **Long Device IDs:** a long Device ID wraps, with the next line indented 21 spaces [secondary: ntc-templates].
- **No blank line:** there is no blank line before `Total entries displayed`, unlike CDP.

#### show version
Layout: [secondary: ntc-templates `cisco_nxos_show_version5.raw`, a 10.4(5) capture]

```
leaf1# show version
Cisco Nexus Operating System (NX-OS) Software
TAC support: http://www.cisco.com/tac
Copyright (C) 2002-2023, Cisco and/or its affiliates.
All rights reserved.
The copyrights to certain works contained in this software are
owned by other third parties and used and distributed under their own
licenses, such as open source.  This software is provided "as is," and unless
otherwise stated, there is no warranty, express or implied, including but not
limited to warranties of merchantability and fitness for a particular purpose.
Certain components of this software are licensed under
the GNU General Public License (GPL) version 2.0 or
GNU General Public License (GPL) version 3.0  or the GNU
Lesser General Public License (LGPL) Version 2.1 or
Lesser General Public License (LGPL) Version 2.0.
A copy of each such license is available at
http://www.opensource.org/licenses/gpl-2.0.php and
http://opensource.org/licenses/gpl-3.0.html and
http://www.opensource.org/licenses/lgpl-2.1.php and
http://www.gnu.org/licenses/old-licenses/library.txt.

Software
  BIOS: version 05.47
  NXOS: version 10.3(4a) [Maintenance Release]
  Host NXOS: version 10.3(4a)
  BIOS compile time:  04/28/2022
  NXOS image file is: bootflash:///nxos64-cs.10.3.4a.M.bin
  NXOS compile time:  10/3/2023 12:00:00 [10/04/2023 01:37:52]
  NXOS boot mode: LXC

Hardware
  cisco Nexus9000 C93180YC-FX Chassis
  Intel(R) Xeon(R) CPU D-1528 @ 1.90GHz with 24569028 kB of memory.
  Processor Board ID FDO23260XYZ
  Device name: leaf1
  bootflash:  115805708 kB

Kernel uptime is 3 day(s), 22 hour(s), 59 minute(s), 33 second(s)

Last reset at 431208 usecs after Fri Nov 20 10:02:11 2026
  Reason: Reset Requested by CLI command reload
  System version: 10.3(4a)
  Service:

plugin
  Core Plugin, Ethernet Plugin

Active Package(s):
```

- **NX-API fields:** the reset reason string `Reset Requested by CLI command reload` and the field set are [verified: S14].
- **JSON keys** include `host_name`, `chassis_id`, `proc_board_id`, `kern_uptm_days`/`_hrs`/`_mins`/`_secs`, `rr_reason`, `rr_sys_ver`, `bios_ver_str` and `kickstart_ver_str` [verified: S14]. On 10.x JSON also has `nxos_ver_str` [unverified, from memory].

#### show logging logfile (excerpt)
- **Format:** `YYYY Mon DD HH:MM:SS <hostname> %FAC-SEV-MNEMONIC: text` [verified: S13, example `2019 Mar 11 13:42:44 Cisco-customer %PTP-2-PTP_INCORRECT_PACKET_ON_SLAVE:`].
- **Repeats:** repeated messages get a `(message repeated N times)` suffix [verified: S13].
- **Fixture messages:** the specific mnemonics below are [unverified, from memory].

```
leaf1# show logging logfile | last 6
2026 Nov 20 10:05:31 leaf1 %ETHPORT-5-IF_UP: Interface Ethernet1/49 is up in mode routed
2026 Nov 20 10:05:44 leaf1 %OSPF-5-ADJCHANGE:  ospf-UNDERLAY [11234]  Nbr 10.255.0.101 on Ethernet1/49 went FULL
2026 Nov 20 10:05:52 leaf1 %BGP-5-ADJCHANGE:  bgp-65020 [11502] (default) neighbor 10.0.2.0 Up 
2026 Nov 23 13:40:18 leaf1 %ETHPORT-5-IF_ADMIN_DOWN: Interface Ethernet1/50 is admin down (Administratively down)
2026 Nov 23 13:40:18 leaf1 %BGP-5-ADJCHANGE:  bgp-65020 [11502] (default) neighbor 10.0.2.2 Down - sent:  administratively shutdown
2026 Nov 24 08:15:02 leaf1 %VSHD-5-VSHD_SYSLOG_CONFIG_I: Configured from vty by admin on 192.168.100.5@pts/0
```

- **Logfile:** the default logfile is `messages`, with a default logfile severity of 5 and a console severity of 2 [verified: S13].
- **Other forms:** `show logging last 40` [verified: S13] and `clear logging logfile [persistent]` [verified: S13].

#### show running-config (short excerpt)
The header comment lines and the version/feature ordering are [unverified, from memory].

```
leaf1# show running-config

!Command: show running-config
!Running configuration last done at: Tue Nov 24 08:15:02 2026
!Time: Tue Nov 24 09:01:44 2026

version 10.3(4a) Bios:version 05.47
hostname leaf1
vdc leaf1 id 1
  limit-resource vlan minimum 16 maximum 4094
  limit-resource vrf minimum 2 maximum 4096

feature ospf
feature bgp
feature interface-vlan
feature lacp
feature lldp

vlan 1,100,200
vlan 100
  name DB
vlan 200
  name APP

vrf context TENANT-A
  rd auto
vrf context management
  ip route 0.0.0.0/0 192.168.100.1

interface Vlan100
  no shutdown
  vrf member TENANT-A
  ip address 10.20.100.1/24

interface port-channel10
  switchport mode trunk
  switchport trunk allowed vlan 100,200

interface Ethernet1/1
  switchport access vlan 100

interface Ethernet1/49
  description spine1 Ethernet1/1
  no switchport
  mtu 9216
  ip address 10.0.2.1/31
  ip ospf network point-to-point
  ip router ospf UNDERLAY area 0.0.0.0
  no shutdown

interface mgmt0
  vrf member management
  ip address 192.168.100.20/24

interface loopback0
  ip address 10.255.0.20/32
  ip router ospf UNDERLAY area 0.0.0.0
router ospf UNDERLAY
  router-id 10.255.0.20
router bgp 65020
  router-id 10.255.0.20
  address-family ipv4 unicast
  neighbor 10.0.2.0
    remote-as 65100
    description spine1
    address-family ipv4 unicast
  neighbor 10.0.2.2
    remote-as 65100
    description spine2
    shutdown
    address-family ipv4 unicast
```

Notable differences from IOS:

- IP addresses use prefix notation (`10.0.2.1/31`).
- Indentation is two spaces.
- There are no `!` separators between blocks.
- `ip router ospf <tag> area <a.b.c.d>` goes on the interface; the form is verified in S10.
- `vrf member` must precede `ip address`.
- `remote-as` goes inside the neighbor block.

## 7. Dangerous commands

### Destructive top-level exec commands

- **Restart and erase:** `reload [module n | timer s]`, `write erase [boot|debug]`, `init system` (re-format), `install all nxos bootflash:…` (upgrade plus reboot), `install deactivate|remove`, `restart <process>` (e.g. `restart bgp 65020`, `restart ospf UNDERLAY` [verified: S10]), `system switchover`, and `system mode maintenance`.
- **Config replacement:** `rollback running-config …` replaces the config [S5], and so does `configure replace …`.
- **File operations:** `copy <x> running-config` or `copy <x> startup-config`, `delete bootflash:…`, `format bootflash:`, `move`, `rmdir`, `mkdir`, `gunzip`, `tar` and `echo … > file`.
- **Shell escapes:** `run bash`, `bash`, `python`/`python3`, `guestshell [run]`, `tclsh`, `load <plugin>` [verified: S4 `load dplugin`] and `attach module` [S4].
- **Output escapes:** `| vsh` (re-executes output as CLI: `show run | i hostname | sed … | vsh` [verified: S4]), `echo "…" | vsh` [verified: S4], `| email`, `| perl`, `| sscp`, `| sed` and redirection `show run > bootflash:x` / `>>`.
- **Clear commands:**
  - `clear bgp all *` and `clear bgp ipv4 unicast *` [verified: S8, which documents `*`]. `clear ip bgp *` also works [unverified, from memory].
  - `clear ip ospf neighbor *`, `clear ip route *`, `clear ip arp`, `clear mac address-table dynamic` and `clear counters`.
  - `clear checkpoint database` [S5], `clear logging logfile` [S13] and `clear configuration …`.
- **Debug:** `debug …` (CPU), `debug all` and `ethanalyzer local interface … write bootflash:` (fills flash).
- **Never terminates:** `watch differences interval 1 show …` [verified: S4].
- **Indirection:** CLI aliases (`cli alias name wr copy run start` [unverified, from memory]) and CLI variables `$(SWITCHNAME)` [verified: S4] let a benign-looking token expand into anything.

### Destructive config-mode commands

- **Feature and protocol removal:** `no feature bgp`, `no feature ospf` and `no feature interface-vlan` wipe all related config [S5]. `no router bgp 65020` and `no vrf context X` do the same for their scope.
- **Interfaces and VLANs:** `no interface Vlan100`, `no vlan 100`, `vlan 1-4094` (mass creation) and `default interface Ethernet1/49`.
- **Shutdowns and VRF moves:** `shutdown` on an uplink, `vrf member X` (removes L3 config [S9]), `switchport` / `no switchport` (mode change wipes config) and `channel-group` changes.
- **Management access:** `username admin password …`, `no username`, `no feature ssh`, `ip access-class` on vty, and `no ip route 0.0.0.0/0 …` in `vrf context management` (loses management).
- **Boot:** `boot nxos bootflash:…`.

### PlatformRules proposal

```ts
const nxos: PlatformRules = {
  read: ['show', 'ping', 'ping6', 'traceroute', 'traceroute6'],
  blocked: [
    // existing (keep): reload delete copy run bash python python3 guestshell install format
    // init-system rollback purge move rmdir mkdir source load system attach ssh ssh6
    // telnet telnet6 tar gzip gunzip echo tac-pac test feature restart
    'init',          // `init system` is two words; add alongside the existing `init-system`
    'tclsh',
    'tcl',
    'vsh',
    'watch',         // never terminates
    'ethanalyzer',   // packet capture, can write files
    'switchto',      // N7K VDC context switch
    'switchback',
    'cli',           // `cli alias`, `cli var` -> indirection
    'event',         // `event manager run` (EEM applets)
    'boot',          // config-mode boot variables (via `conf t ; boot …` chains)
    'slot',          // `slot 1 …` module commands
    'poweroff',
    'out-of-service',
  ],
  other: [
    // existing (keep) plus:
    'routing-context', 'terminal', 'checkpoint', 'clear', 'configure', 'debug', 'undebug',
    'dir', 'end', 'exit', 'no', 'write', 'where', 'pwd', 'cd', 'sleep',
  ],
  blockedPairs: [
    ['write', 'erase'],
    ['configure', 'replace'],
    ['configure', 'session'],    // can commit ACL/QoS
    ['debug', 'all'],
    ['clear', 'configuration'],
    ['clear', 'checkpoint'],     // clear checkpoint database
    ['clear', 'logging'],        // destroys evidence
    ['clear', 'bgp'],            // clear bgp all * / ipv4 unicast *
    ['clear', 'ip'],             // clear ip bgp|ospf|route|arp|mroute (all disruptive)
    ['clear', 'ipv6'],
    ['clear', 'mac'],
    ['clear', 'spanning-tree'],
    ['clear', 'vpc'],
    ['clear', 'install'],
    ['no', 'feature'],
    ['no', 'router'],
    ['no', 'vrf'],
    ['no', 'vlan'],
    ['no', 'interface'],
    ['no', 'username'],
    ['checkpoint', 'file'],      // writes to bootflash
  ],
  pipesAllowed: [
    'include', 'exclude', 'begin', 'section', 'count', 'grep', 'egrep', 'head', 'last',
    'wc', 'no-more', 'json', 'json-pretty', 'xml', 'sort', 'uniq',
    // additions from the documented pipe list [S1]:
    'cut', 'tr', 'human', 'end', 'diff',
  ],
  pipesBlocked: [
    'vsh', 'email', 'python', 'tee', 'append', 'redirect', 'upload', 'sed', 'awk',
    // additions [S1]:
    'perl', 'sscp', 'less',   // less is interactive (and has `!` shell escape)
  ],
  execFromConfig: 'do',
}
```

### What this shape cannot express

- **3+ token commands:** cases such as `show tech-support details`, `install all nxos …` vs `show install all status`, or `clear ip arp` (mild) vs `clear ip bgp *` (severe) need a tokens-prefix list (e.g. `['clear','ip','bgp']`) or argument awareness. The `['clear','ip']` pair is deliberately coarse.
- **Arguments:** `clear bgp ipv4 unicast 10.0.2.0` (one peer) vs `*` (all) are indistinguishable. So are `reload module 1` vs `reload`, and `copy run start` (safe-ish) vs `copy tftp: running-config`. When this was written `copy` was blocked wholesale. Since 0.4 the NX-OS tree (`packages/cli-model/src/trees/nxos.ts`) makes `copy running-config startup-config` a `config` command that needs approval and blocks every other `copy`.
- **Config-mode destructive commands:** once `configure` is allowed, `no feature bgp`, `vrf member`, `shutdown`, `no switchport` and `default interface` inside config mode are not top-level keywords. The rules classify only the first token of the session line. Config-mode guarding needs a mode-aware second ruleset.
- **Command chaining:** `show clock ; reload` [`;` chaining verified: S4]. The guard must split on unquoted ` ; ` and classify every segment, or block `;` outright.
- **CLI variables and aliases:** `$(VAR)` substitution [S4] and user-defined aliases defeat keyword matching. Expand `show cli alias` first, or block any line containing `$(`.
- **Redirection:** `show run > bootflash:x` and `>> file` are not pipes. Block `>` outside quoted regexes.
- **Pager shell escape:** `!` at `--More--` [S1]. If the agent drives the pager, force `| no-more` or `terminal length 0`.

### Abbreviation traps

- **`wr`:** this resolves to `write`, and on NX-OS the only `write` sub-command is `erase`. So `wr e` is `write erase`, and `wr mem` is invalid unless an alias exists [unverified, from memory].
- **`rel`:** this resolves to `reload`. There is no other top-level `rel…` command [unverified, from memory].
- **`ro`:** this is ambiguous between `rollback` and `routing-context`. `rol` gives `rollback` [unverified, from memory].
- **`ch`:** this resolves to `checkpoint`. `cl` is ambiguous between `clear` and `cli` [unverified, from memory].
- **`conf r`:** this gives `configure replace`, and `conf s` gives `configure session`. Some releases also have `configure sync` and `configure profile`, which would make `conf s` ambiguous [unverified, from memory]. Resolve prefixes against the full keyword list before checking blockedPairs.
- **`in`:** this is ambiguous between `install` and `init`, but `ins` gives `install` [unverified, from memory].
- **`s` and `sh`:** `s` is ambiguous, while `sh` gives `show` [unverified, from memory].
- **`res`:** this gives `restart` [unverified, from memory].
- **`no f`:** this gives `no feature` [unverified, from memory].
- **Guard rule:** the guard should resolve each token by unique prefix over the platform keyword set, as the device does, and treat "ambiguous" as blocked.

## 8. Live-value sources

| Value | Command | Field / regex hint | Structured alternative |
|---|---|---|---|
| Interfaces (all) | `show interface brief` | rows `^(Eth\S+\|Po\d+\S*\|Lo\d+\|Vlan\d+\|mgmt\d)\s` | `show interface brief \| json` gives `TABLE_interface.ROW_interface[].interface` (full names) [unverified, from memory] |
| L3 interfaces + IP + VRF | `show ip interface brief vrf all` | VRF from `^IP Interface Status for VRF "([^"]+)"`, rows `^(\S+)\s+(\d+\.\d+\.\d+\.\d+\|forward-enabled\|unnumbered)\s+(\S+)` | `\| json`: `TABLE_intf.ROW_intf[]` with `intf-name`, `prefix`, `vrf-name-out` [unverified, from memory] |
| Interface descriptions | `show interface description` | | `\| json` |
| VLANs | `show vlan brief` | `^(\d+)\s+(\S+)\s+(active\|act/lshut\|suspend\|sus/lshut)` | `show vlan brief \| json`: `TABLE_vlanbriefxbrief.ROW_vlanbriefxbrief[]` `vlanshowbr-vlanid`, `vlanshowbr-vlanname` [unverified, from memory] |
| VRFs | `show vrf` | `^(\S+)\s+(\d+)\s+(Up\|Down)` after the `VRF-Name` header [secondary: ntc-templates] | `show vrf \| json`: `TABLE_vrf.ROW_vrf[].vrf_name` [unverified, from memory] |
| BGP ASN | `show running-config bgp` | `^router bgp (\S+)` | `show bgp process \| json` |
| BGP neighbors | `show bgp ipv4 unicast summary vrf all` | VRF from `^BGP summary information for VRF (\S+),`, rows `^(\d+\.\d+\.\d+\.\d+\|[0-9a-f:]+)\s+4\s+(\d+(?:\.\d+)?)\s` | `\| json`: `TABLE_vrf.ROW_vrf[].TABLE_af…ROW_neighbor[]` `neighborid`, `neighboras`, `state` [unverified, from memory] |
| OSPF neighbors | `show ip ospf neighbors vrf all` | `^ (\d+\.\d+\.\d+\.\d+)\s+\d+\s+(\S+/\s?\S*)` | `\| json` |
| OSPF process tags | `show running-config ospf` | `^router ospf (\S+)` | |
| Route-maps | `show route-map` | `^route-map (\S+), (permit\|deny), sequence (\d+)` [unverified, from memory] | `show running-config \| i ^route-map` |
| Prefix-lists | `show ip prefix-list` | `^ip prefix-list (\S+): (\d+) entries` [unverified, from memory] | `show running-config \| i ^ip prefix-list` |
| ACLs | `show ip access-lists summary` / `show access-lists` | `^IP access list (\S+)` | `show running-config aclmgr` |
| Port-channels | `show port-channel summary` | `^(Po\d+)\((\w+)\)\s+(\S+)` [secondary: ntc-templates] | `\| json` |
| Features | `show feature` | `^(\S+)\s+(\d+)\s+(enabled\|disabled)` [secondary: ntc-templates] | `show running-config \| i ^feature` |
| Checkpoints | `show checkpoint summary` | names after `^\d+\) (\S+):` [unverified, from memory] | |
| vPC domain | `show vpc brief` | | `\| json` |
| VNIs | `show nve vni` | | `\| json` |
| CDP/LLDP peers | `show cdp neighbors` / `show lldp neighbors` | see layouts above; handle wrapped Device-ID | `show cdp neighbors \| json` gives `TABLE_cdp_neighbor_brief_info` [verified: S15] |
| Hostname | `show hostname` / prompt | | `show version \| json` `host_name` [S14] |
| Files | `dir bootflash:` | | |

- **CLI JSON:** `| json` / `| json-pretty` exist on N9K/N3K 7.0(3)I2+ for most show commands, and return the same schema as NX-API `output_format: json` [unverified, from memory; NX-API JSON output is verified at S14 and S15]. Some commands return `% Invalid command at '^' marker.` or plain text if they are not JSON-enabled. Fall back to regex parsing in that case.
- **Key layout:** the keys are `TABLE_<x>` / `ROW_<x>`. A single row is returned as an object, not as a 1-element array, so normalize it.
- **`json native`** (9.3+) returns a flatter schema [unverified, from memory].

## 9. Interface naming

| Kind | Full name (config, ARP, LLDP Port ID) | Short form in `brief` tables | Accepted input | Regex (case-insensitive) |
|---|---|---|---|---|
| Ethernet | `Ethernet1/49` | `Eth1/49` | `ethernet1/49`, `eth1/49`, `e1/49`, `e 1/49` [S1 `int e 1/2`] | `^(?:e(?:t(?:h(?:ernet)?)?)?)\s?(\d+)/(\d+)(?:/(\d+))?$` |
| Breakout | `Ethernet1/1/1` | `Eth1/1/1` | as above | three-number form |
| FEX host port | `Ethernet101/1/1` | `Eth101/1/1` [secondary: ntc-templates] | as above | slot ≥ 100 |
| Subinterface | `Ethernet1/49.10` | `Eth1/49.10` | `e1/49.10` | `…(?:\.(\d+))$` |
| Port-channel | `port-channel10` (lowercase in config) | `Po10` | `port-channel10`, `po10`, `port 10` | `^(?:po(?:rt-channel)?)\s?(\d+)(?:\.(\d+))?$` |
| Loopback | `loopback0` | `Lo0` | `loopback0`, `lo0`, `loop0` | `^lo(?:opback)?\s?(\d+)$` |
| SVI | `Vlan100` | `Vlan100` | `vlan100`, `int vlan 100`; needs `feature interface-vlan` | `^vlan\s?(\d+)$` |
| Management | `mgmt0` | `mgmt0` | `mgmt0`, `mgmt 0` | `^mgmt\s?(\d)$` |
| Tunnel | `Tunnel1` | `Tunnel1` | `tunnel1`; needs `feature tunnel` | `^tunnel\s?(\d+)$` |
| VXLAN NVE | `nve1` | `nve1` | `nve1`; needs `feature nv overlay` | `^nve\s?(\d+)$` |
| Ranges | `Ethernet1/1-4, Ethernet1/10` | | `int e1/1-4, e1/10` [S12 shows the comma form] | |

- **Case and spacing:** in config, `Ethernet` and `Vlan` are capitalised, while `port-channel`, `loopback` and `mgmt0` are lowercase [unverified, from memory]. Entry is case-insensitive.
- **Names by command:**
  - `show interface brief`, `show ip interface brief` and `show ip route` use the short forms (`Eth1/49`, `Lo0`, `Po10`) [secondary: ntc-templates].
  - `show ip arp` and LLDP *Port ID* use the full form `Ethernet1/49` [secondary: ntc-templates].
  - Parsers must normalise both.
- **Port-channel members:** `show port-channel summary` uses `Eth1/47(P)`. Some captures show `Et3/36/1(PG+)` [secondary: ntc-templates], so accept `Et` too.

## 10. Simulator and guard fit

### Delta: current Hopline sim vs real NX-OS

1. **Invalid input:** the sim prints `% Invalid input detected at '^' marker.`, but NX-OS prints `% Invalid command at '^' marker.` [S11]. Make it per-platform, e.g. `errors: { invalid, ambiguous, incomplete }` in the platform profile.
2. **Ambiguous:** the sim prints `% Ambiguous command:  "<line>"` (IOS). NX-OS uses `% Ambiguous command at '^' marker.` with a caret line [unverified].
3. **Incomplete:** the sim prints `% Incomplete command.`. NX-OS uses `% Incomplete command at '^' marker.` with a caret [unverified]; the Cisco doc shows `% Incomplete command` [S1].
4. **Pager:** the sim's `' --More-- '` should be `'--More--'` for NX-OS [padding unverified]. Add `q`/Ctrl-C quit, Return for one line and Space for one page.
5. **Confirm prompts:** replace `[confirm]` with `This command will reboot the system. (y/n)?  [n]`, and with `Warning: This command will erase the startup-configuration.` followed by `Do you wish to proceed anyway? (y/n)  [n]`. The default `n` on an empty Enter must abort [S3].
6. **Ctrl-C:** NX-OS clears the line and stays in the current mode [unverified, from memory]. Ctrl-Z goes to EXEC [S1]. The sim returns to exec on Ctrl-C.
7. **Ctrl-R:** this redisplays the line, not reverse search [S1].
8. **Prompts:**
   - Add `config-subif`, `config-if-range`, `config-vrf`, `config-router-af`, `config-router-neighbor`, `config-router-neighbor-af`, `config-router-vrf`, `config-route-map`, `config-acl` and `config-s`.
   - Never put the interface name in the prompt.
   - Support `routing-context vrf X`, which gives `leaf1%X#`.
9. **No user exec:** NX-OS has no `>` user mode and no `enable` for network-admin users, so the sim should start at `leaf1#` [unverified, from memory; S1's mode table starts at EXEC `switch#`].
10. **Feature gating** [unverified, from memory]: reject `router bgp`, `show bgp …` and `interface Vlan…` with `% Invalid command at '^' marker.` until the matching `feature` is enabled. This is important for realism and for demoing a classic NX-OS gotcha.
11. **Commands to add:**
    - **Show:** `show interface brief` (multi-section), `show ip interface brief [vrf all|vrf X]` (default-VRF-only without the arg), `show bgp ipv4 unicast summary` and `show ip bgp summary` (aliases), `show ip ospf neighbors`, `show ip route` with `*via` lines, `show mac address-table` with the legend, `show ip arp`, `show cdp neighbors`, `show lldp neighbors`, `show version`, `show logging logfile`, `show logging last N`, `show feature`, `show vrf`, `show checkpoint summary`, `show port-channel summary`, `show running-config [bgp|ospf|interface X]` and `show running-config diff`.
    - **Exec and config:** `checkpoint <name>`, `rollback running-config checkpoint <name>`, `copy running-config startup-config`, `configure session X`, `terminal length 0`, `vrf context X` and `vrf member X`.
12. **Pipes:**
    - Add `| json` and `| json-pretty` output for the fixture commands; the NX-API key names are in section 8.
    - Add `| last N`, `| head`, `| wc`, `| egrep`, `| sort`, `| uniq` and `| count` [S1]. `| diff` is optional.
13. **`;` chaining:** support splitting `cmd1 ; cmd2` [S4], so the guard has a test target.
14. **Rejected plural:** `show interfaces` must be rejected on NX-OS, unlike IOS and EOS [unverified, from memory].
15. **Config syntax** inside `running-config`: prefix-length addresses, two-space indentation and no `!` separators.

### Recommended Mode names for NX-OS

Extend the sim's `Mode` union, or map the extra modes onto its existing 5 for help scoping only:

```ts
type NxosMode =
  | 'exec'
  | 'config'
  | 'config-if' | 'config-subif' | 'config-if-range'
  | 'config-vlan'
  | 'config-vrf'                       // vrf context X
  | 'config-router'                    // router bgp / router ospf
  | 'config-router-af'
  | 'config-router-neighbor' | 'config-router-neighbor-af'
  | 'config-router-vrf' | 'config-router-vrf-af' | 'config-router-vrf-neighbor'
  | 'config-route-map'
  | 'config-acl'
  | 'config-s'                          // configure session
// mapping to the current engine: subif/if-range→config-if; vrf/route-map/acl/s→config;
// router-*→config-router.
```

### Guard summary

- **Keep `feature` blocked:** enabling a feature is benign, but `no feature` destroys config. The blocked list already covers both. If the agent may enable features, switch to `blockedPairs: ['no','feature']` and keep `feature` in `other`.
- **Fix `init-system`:** if the guard tokenises on spaces, the existing entry cannot match `init system` [unverified, from memory, that NX-OS has no `init-system` keyword]. Add `init` as well.
- **Add the pairs and pipes** proposed in section 7.
- **Add pre-checks** for ` ; `, `$(`, `>` / `>>` and aliases.

## Sources

Cisco documentation (fetched this session):

- **S1:** Cisco Nexus 9000 NX-OS Fundamentals Configuration Guide 10.4(x), "Understanding the Command-Line Interface": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/104x/configuration/fundamentals/cisco-nexus-9000-series-nx-os-fundamentals-configuration-guide-release-104x/m-understanding-the-cli.html
- **S2:** same guide, "Configuring Terminal Settings and Sessions": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/104x/configuration/fundamentals/cisco-nexus-9000-series-nx-os-fundamentals-configuration-guide-release-104x/m-configuring-terninal-settings.html
- **S3:** same guide, "Working with Configuration Files": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/104x/configuration/fundamentals/cisco-nexus-9000-series-nx-os-fundamentals-configuration-guide-release-104x/m-working-with-configuration-files.html
- Fundamentals guide 10.4(x) table of contents: https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/104x/configuration/fundamentals/cisco-nexus-9000-series-nx-os-fundamentals-configuration-guide-release-104x.html
- **S4:** Cisco TechNote "Nexus NX-OS tips and tricks" (200714): https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/nx-os-software/200714-Nexus-NX-OS-tips-and-tricks.html
- **S5:** N9K System Management Configuration Guide 10.3(x), "Configuring Rollback": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/configuration/system-management/cisco-nexus-9000-series-nx-os-system-management-configuration-guide-103x/m-configuring-rollback.html
- **S6:** same guide, "Configuring Session Manager": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/configuration/system-management/cisco-nexus-9000-series-nx-os-system-management-configuration-guide-103x/m-configuring-session-manager.html
- **S13:** same guide, "Configuring System Message Logging": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/configuration/system-management/cisco-nexus-9000-series-nx-os-system-management-configuration-guide-103x/m-configuring-system-message-logging.html
- System Management guide 10.3(x) table of contents: https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/configuration/system-management/cisco-nexus-9000-series-nx-os-system-management-configuration-guide-103x.html
- **S7:** Cisco TechNote "Understand basic BGP troubleshooting" (220604; NX-OS `show ip bgp summary` and others): https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/220604-understand-basic-bgp-troubleshoot.html
- **S8:** N9K Unicast Routing Configuration Guide 10.3(x), "Configuring Basic BGP": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/unicast-routing-configuration/cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide-release-103x/m-n9k-configuring-basic-bgp-101x.html
- **S9:** same guide, "Configuring Layer 3 Virtualization": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/unicast-routing-configuration/cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide-release-103x/m_configuring_layer_3_virtualization.html
- **S10:** same guide, "Configuring OSPFv2": https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/unicast-routing-configuration/cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide-release-103x/m_configuring_ospfv2.html
- Unicast Routing guide 10.3(x) table of contents: https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/103x/unicast-routing-configuration/cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide-release-103x.html
- N9K installation and configuration guides list: https://www.cisco.com/c/en/us/support/switches/nexus-9000-series-switches/products-installation-and-configuration-guides-list.html
- **S14:** NX-API CLI reference, `show version`: https://developer.cisco.com/docs/cisco-nexus-9000-series-nx-api-cli-reference/latest/version-commands
- **S15:** NX-API CLI reference (N9K), CDP commands: https://developer.cisco.com/docs/nx-api-cli-reference-for-the-cisco-nexus-9000-series-platform/cdp-commands
- NX-API CLI reference 9.x landing page (JSON/XML output formats): https://developer.cisco.com/docs/cisco-nexus-9000-series-nx-api-cli-reference-release-9-x

Secondary sources (real device transcripts):

- **S11:** NetApp KB, "Error when upgrade Reference Configuration File (RCF)", N9K/N3K transcripts with `% Invalid command at '^' marker.`: https://kb.netapp.com/on-prem/Switches/Cisco-KBs/Error_when_upgrade_Reference_Configuration_File_RCF
- **S12:** NetApp KB, "RCF install fails with error Invalid range at marker on breakout ports": https://kb.netapp.com/on-prem/Switches/Cisco-KBs/RCF_install_fails_with_error_Invalid_range_at_marker_on_breakout_ports
- ntc-templates raw captures, fetched via raw.githubusercontent.com under `https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_nxos/`:
  - `show_interface_brief/cisco_nxos_show_interface_brief.raw` and `…_02.raw`
  - `show_ip_interface_brief/cisco_nxos_show_ip_interface_brief.raw`, `…_vrf_all_01.raw` and `…_vrf_all_02.raw`
  - `show_ip_bgp_summary/cisco_nxos_show_ip_bgp_summary.raw` and `…summary2.raw`
  - `show_ip_ospf_neighbor/cisco_nxos_show_ip_ospf_neighbor.raw`
  - `show_ip_route/cisco_nxos_show_ip_route.raw`
  - `show_mac_address-table/cisco_nxos_show_mac_address-table.raw`
  - `show_ip_arp/cisco_nxos_show_ip_arp.raw`
  - `show_cdp_neighbors/cisco_nxos_show_cdp_neighbors.raw`
  - `show_lldp_neighbors/cisco_nxos_show_lldp_neighbors.raw`
  - `show_version/cisco_nxos_show_version.raw` and `…version5.raw`
  - `show_vrf/cisco_nxos_show_vrf.raw`
  - `show_vlan/cisco_nxos_show_vlan.raw`
  - `show_port-channel_summary/cisco_nxos_show_port-channel_summary.raw`
  - `show_feature/cisco_nxos_show_feature.raw`
  - `show_configuration_session_summary/cisco_nxos_show_configuration_session_summary.raw`
  - Directory listing: https://api.github.com/repos/networktocode/ntc-templates/contents/tests/cisco_nxos
