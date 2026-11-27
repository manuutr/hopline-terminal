# Cisco IOS and IOS-XE CLI reference for Hopline

> **Scope.** Classic Cisco IOS 12.x/15.x (ISR G2, Catalyst 2960/3560/3750) and Cisco IOS-XE 16.x/17.x (Catalyst 9000, ISR 4000, ASR 1000, C8000). The reference box is the simulator fixture `core-sw1` (C9300-48P, IOS-XE 17.9.4a "Cupertino", AS 65001). Where IOS and IOS-XE differ, the difference is called out under **IOS vs IOS-XE**.
> **Researched.** 2026-11.
>
> **Confidence legend**
> - `[S#]`: the wording was checked against the fetched source with that number (see **Sources**). Cisco pages were read through a fetch tool that paraphrases and caps quotes, so `[S#]` proves the **words**, not column spacing.
> - `[S#, spacing unverified]`: the words are from the source, but the exact spaces and alignment come from memory.
> - `[N#]`: secondary source. These are byte-exact raw captures from the networktocode/ntc-templates test suite, fetched with curl and measured with a script, so their column offsets are exact.
> - `[unverified, from memory]`: not checked this session. Treat it as plausible, not as fact.
> - **Untagged content** (most of the command tables in sections 6–9, and the dangerous-command lists) is `[unverified, from memory]` unless a tag is attached.
>
> **Note on cisco.com.** Akamai blocks non-browser clients (it returned HTTP 403 to curl), and long command-reference pages were truncated by the fetch tool. That is why several `show` layouts below rely on ntc captures rather than Cisco pages.

## 1. Prompts

The prompt is the hostname followed by a mode suffix. The 3850 CLI chapter's mode table gives the canonical set `[S3]`, and the IOS-XE fundamentals guide confirms `Router#`, `Router(config)#` and `Router(config-line)#` `[S2]`. There is **no space** after `>` or `#` when the device prints the prompt. Cisco docs typeset a space (`Switch# show`), but the real device output is `core-sw1#show` `[unverified, from memory]`. Captures logged as `core-sw1#show ...` are consistent with this.

| Mode | Prompt (generic / core-sw1) | Enter with | Leave with | Source |
|---|---|---|---|---|
| User EXEC | `R1>` / `core-sw1>` | login (vty without `privilege level 15`) | `logout`, `quit`, `exit` | [S3] |
| Privileged EXEC | `R1#` / `core-sw1#` | `enable` (then a `Password:` prompt if an enable secret is set) | `disable` (back to `>`) | [S3] |
| Global config | `core-sw1(config)#` | `configure terminal` (`conf t`) | `exit`, `end`, Ctrl-Z | [S3] |
| Interface | `core-sw1(config-if)#` | `interface Gi1/0/1` | `exit` (to config), `end`/Ctrl-Z (to exec) | [S3] |
| Interface range | `core-sw1(config-if-range)#` | `interface range Gi1/0/3 - 6` | same | [unverified, from memory] |
| Sub-interface | `R1(config-subif)#` | `interface Gi0/0/0.100` (routers) | same | [unverified, from memory] |
| Router (OSPF/EIGRP/BGP) | `core-sw1(config-router)#` | `router bgp 65001`, `router ospf 1` | same | [unverified, from memory] |
| BGP address family | `core-sw1(config-router-af)#` | `address-family ipv4 [vrf MGMT]` under `router bgp` | `exit-address-family` | [unverified, from memory] |
| Line | `core-sw1(config-line)#` | `line vty 0 15`, `line con 0` | same | [S2][S3] |
| VLAN | `core-sw1(config-vlan)#` | `vlan 10` | same | [S3] |
| Extended named ACL | `core-sw1(config-ext-nacl)#` | `ip access-list extended EDGE-IN` | same | [unverified, from memory] |
| Standard named ACL | `core-sw1(config-std-nacl)#` | `ip access-list standard MGMT-ONLY` | same | [unverified, from memory] |
| Route map | `core-sw1(config-route-map)#` | `route-map RM-EDGE-IN permit 10` | same | [unverified, from memory] |
| Prefix list | (no sub-mode; one-line `ip prefix-list ...`) | n/a | n/a | [unverified, from memory] |
| VRF (multi-AF) | `core-sw1(config-vrf)#` then `(config-vrf-af)#` | `vrf definition MGMT`, then `address-family ipv4` | `exit-address-family` | [unverified, from memory] |
| Archive | `core-sw1(config-archive)#` | `archive` | same | [unverified, from memory] |
| QoS | `(config-cmap)#`, `(config-pmap)#`, `(config-pmap-c)#` | `class-map`, `policy-map`, then `class` | same | [unverified, from memory] |
| ROMMON | `rommon 1 >` (routers); `switch:` (Catalyst 9000) | break during boot | `boot` | [S2] names ROMMON; the prompt strings are [unverified, from memory] |

**Sample transcript** `[unverified, from memory]`:

```
User Access Verification

Username: netops
Password:
core-sw1>enable
Password:
core-sw1#configure terminal
Enter configuration commands, one per line.  End with CNTL/Z.
core-sw1(config)#interface Gi1/0/2
core-sw1(config-if)#exit
core-sw1(config)#router bgp 65001
core-sw1(config-router)#address-family ipv4
core-sw1(config-router-af)#end
core-sw1#
```

The banner text `Enter configuration commands, one per line.  End with CNTL/Z.` has two spaces before `End`. The "End with CNTL/Z" wording is in [S2]; the two-space spacing is `[unverified, from memory]`. The simulator already prints this banner.

**Hostname rules.** Names must be 63 characters or fewer. They must start with a letter and end with a letter or digit, and interior characters can only be letters, digits and hyphens `[S5]`. Cisco also says "Do not expect case to be preserved" `[S5]`.
- **Dots:** IOS rejects or warns about a hostname with a dot, so an FQDN is normally `hostname` plus `ip domain name`, and the prompt never contains the domain `[unverified, from memory]`.
- **Dashes:** these appear in the prompt as-is (`core-sw1#`).
- **Long names:** older IOS releases truncate long hostnames in config-mode prompts. Reported cut-offs range from 12 to 20 characters depending on the release and platform. Modern IOS-XE prints the full name `[unverified, from memory]`.
- **`prompt` command:** a custom prompt such as `prompt %h%p` (the default) overrides all of this `[unverified, from memory]`.

**Multi-context variations.**
- **IOS-XE StackWise (C9300):** the prompt is unchanged. Stack members show up in interface names (`Gi2/0/1`) and in `show switch`.
- **Standby supervisor console (C9400/C9600 SSO, ASR1k dual RP):** the prompt becomes `core-sw1-stby#`, and config is locked there `[unverified, from memory]`.
- **IOS has no VDC/VDOM-style prompt change.** VRFs never change the prompt.
- **Config lock:** IOS-XE has a config lock (`configuration mode exclusive`, and NETCONF datastore locks). When the lock is held, a second user's `conf t` fails with a `%` message `[unverified, from memory]`.

## 2. Paging

- **Prompt string:** `--More--` appears when output exceeds the screen length `[S2]`. The exact bytes are ` --More-- `, with one leading and one trailing space `[S2, spacing unverified]`. The simulator constant `' --More-- '` matches this.
- **Keys:** Return scrolls one line and Space shows the next screen `[S2][S3]`. Any other key (`q`, Ctrl-C, Ctrl-Z, Escape) quits and returns to the prompt `[unverified, from memory]`.
- **Not supported in the IOS pager:** `/` search, `b` back, and `G`.
- **Self-erase:** after a key press, IOS erases the pager with backspace characters (BS x 9, nine spaces, BS x 9), so the next output line starts at column 0 on the same row. It does not leave a `--More--` line in scrollback `[unverified, from memory]`. A terminal emulator that renders BS normally shows a clean scrollback.
- **Turning paging off:**
  - For the current session: `terminal length 0`. Any `length` of 0 disables pausing `[S2]`.
  - Persistently: under `line vty 0 15` (or `line con 0`), set `length 0` `[S2]`.
  - Allowed range: `terminal length <0-512>` `[unverified, from memory]`. The simulator uses this range.
  - Width: `terminal width 0`/`<0-512>` disables wrapping on IOS-XE (`terminal width 511` on older IOS) `[unverified, from memory]`.
- **Pipes:** `| no-more` does **not** exist on IOS or IOS-XE (it is NX-OS/EOS/Junos syntax).
- **Prompt and paging detection:** automation tools (Netmiko and others) send `terminal length 0` and `terminal width 511` and then key on `#`/`>`.

## 3. Help and completion

**`?` directly after a partial word (no space)** lists the matching keywords on one line `[S2][S3]`:

```
core-sw1#co?
configure  connect  copy

core-sw1#co
```
The listed words are from [S2]. The two spaces between words and the reprint of the typed text on a new prompt line are [S2, spacing unverified].

**`?` after a space** lists the next keywords, one per line, with a two-space indent, the keyword padded to a fixed column, and then its help text. `<cr>` appears when the command is already complete `[S2]` (the list for `configure ?` includes `memory`, `network`, `overwrite-network`, `terminal` and `<cr>`):

```
core-sw1#configure ?
  confirm            Confirm replacement of running-config with a new config file
  memory             Configure from NV memory
  network            Configure from a TFTP network host
  overwrite-network  Overwrite NV memory from TFTP network host
  replace            Replace the running-config with a new config file
  revert             Parameters for reverting the configuration
  terminal           Configure from the terminal
  <cr>               <cr>

core-sw1#configure
```
Keyword list: [S2] for memory/network/overwrite-network/terminal/`<cr>`. The `confirm`, `replace` and `revert` keywords are from [S1] (which documents those commands). The help strings, the column width (padded to the longest keyword + 2), and `<cr>  <cr>` (IOS-XE; older IOS shows a bare `<cr>`) are `[unverified, from memory]`.

**Arguments** appear as `WORD`, `LINE`, `A.B.C.D`, `<1-4294967295>`, and `X:X:X:X::X`. Example: `cdp holdtime ?` returns `<10-255>  Length of time (in sec) ...` `[S3]`.

**Tab** completes a unique prefix in place: `sh conf<Tab>` becomes `show configuration` `[S3]`, and `conf<Tab>` becomes `configure` `[S2]`. If the prefix is ambiguous or unknown, Tab does nothing (it may ring the bell, BEL 0x07) and lists nothing `[S2]`, which says that when an entry matches more than one command the system beeps. There is **no** space-completion like Junos.

**Abbreviation.** Any prefix that is unique in the current mode is accepted (`show conf` runs `show configuration`) `[S3]`.
- **Resolution is per mode.** `sh` is unique in exec, but in config mode `sh` is ambiguous between `shell` and `show` on some releases, so `do sh run` is the safe form `[unverified, from memory]`.
- **Hard-wired short forms.** Some prefixes resolve even though they are not unique by spelling: `sh`, `conf t`, `int`, `wr`, `en`, `ex`, `u all` (undebug all), and `no sh`. Cisco gives priority keywords precedence over spelling `[unverified, from memory]`.

**Error messages** (words from [S2][S3]; spacing noted per line):

```
core-sw1#show ip intrface brief
                    ^
% Invalid input detected at '^' marker.

core-sw1#sh c
% Ambiguous command:  "sh c"
core-sw1#clock set 13:32:00
% Incomplete command.

core-sw1#
```

- **`% Invalid input detected at '^' marker.`**
  - The caret line is printed below the command, with the caret under the first character of the token that failed to parse `[S2]`.
  - The caret column counts **from column 0 of the prompt line**, so it is `len(prompt) + offset of the first character that failed`. The caret sits under the first character IOS could not match, which can be inside the token. Here `core-sw1#` is 9 characters, and `int` still matches `interface` but `intr` matches nothing, so the failing `r` is at offset 11 of `show ip intrface brief`. The caret is therefore at column 9 + 11 = 20 `[unverified, from memory]`. Cisco's own example [S2] puts the caret under the `o` of a mistyped `configur terminal`, which is consistent with this.
  - The simulator offsets by prompt length but points at the **start** of the bad token (column 17 here). See section 10.
- **`% Ambiguous command:  "sh c"`**
  - The 3850 chapter shows `% Ambiguous command: "show con"` with one space `[S3]`. Real devices print **two** spaces after the colon, and the simulator uses two `[S3, spacing unverified]`.
  - No caret line, and no blank line after it `[unverified, from memory]`.
- **`% Incomplete command.`** `[S2][S3]` is followed by a blank line `[unverified, from memory]`.
- **User EXEC to privileged commands.** `core-sw1>configure terminal` gives the caret plus `% Invalid input detected at '^' marker.` (the caret sits under `c`), because `configure` does not exist at privilege level 1 `[unverified, from memory]`.
- **Unknown first word in EXEC (important for the guard).** IOS treats an unrecognized single word at the exec prompt as a **hostname to telnet to**. The output is `Translating "foo"...domain server (255.255.255.255)` and then `% Unknown command or computer name, or unable to find computer address`, or `% Bad IP address or host name` when domain lookup is off `[unverified, from memory]`. A typo can therefore open an outbound telnet session. `transport preferred none` on the vty lines disables this.
- **Other common errors** `[unverified, from memory]`:
  - `% Invalid input detected at '^' marker.` for a bad interface number.
  - `%Interface ... is not a valid ...` (wording varies).
  - `% Unrecognized command`. This is IOS-XE for some config-mode errors.
  - `% Type "show ?" for a list of subcommands`. This appears after `show` with no argument.

## 4. Control characters

| Key | Behavior | Source |
|---|---|---|
| Ctrl-Z | From any config mode, return to privileged EXEC (echoes `^Z`). Same as `end`. | [S3]; the `^Z` echo is [unverified, from memory] |
| Ctrl-C | In a config mode it returns to EXEC like Ctrl-Z (echoes `^C`). At an exec line it discards the line and prints a new prompt. At `[confirm]`/`[yes/no]` prompts it aborts. It **does not** abort a running ping/traceroute by default. | [unverified, from memory] |
| Ctrl-Shift-6 (Ctrl-^, ASCII 0x1E) | The escape character. It aborts ping, traceroute and DNS lookups (ping prints `Type escape sequence to abort.`). Pressing Ctrl-^ then `x` suspends an outbound telnet/ssh session back to the local prompt. | [S6] (secondary); the `Type escape sequence to abort.` banner is [unverified, from memory] |
| `terminal escape-character <n>` / line `escape-character <n>` | Changes the escape character for the session or persistently. For example, `3` makes Ctrl-C the abort key. | [S6] |
| Ctrl-U, Ctrl-X | Delete to the beginning of the line. | [S2][S3] |
| Ctrl-W | Delete the word to the left of the cursor. | [S2][S3] |
| Ctrl-K | Delete to the end of the line. | [S2][S3] |
| Ctrl-A / Ctrl-E | Beginning / end of the line. | [S2][S3] |
| Ctrl-B / Ctrl-F, arrow keys | Move back / forward one character. | [S2][S3] |
| Esc B / Esc F | Move back / forward one word. | [S2][S3] |
| Ctrl-D | Delete the character at the cursor. | [S2][S3] |
| Ctrl-T | Transpose characters. | [S2][S3] |
| Ctrl-Y, Esc Y | Paste the most recently deleted entry, then cycle through older ones. The delete buffer holds 10 entries. | [S2][S3] |
| Ctrl-L, Ctrl-R | Redisplay the current line. This is **not** a reverse history search. | [S2][S3] |
| Ctrl-P / Up, Ctrl-N / Down | Previous / next command in history. The history size is 10 by default (`terminal history size <0-256>`). | [S3]; the size is [unverified, from memory] |
| Esc C / Esc L / Esc U | Capitalize / lowercase / uppercase the word. | [S2] |
| Ctrl-V, Esc Q | Insert the next keystroke literally. Use it to put `?` inside a `description` or regex. | [S2][S3] |
| `terminal no editing` | Disables all of the editing keys above. | [unverified, from memory] |

**For Hopline:**
- **Ctrl-C:** the simulator returns to exec on Ctrl-C from config, which matches. It should **not** stop a ping; only Ctrl-^ should.
- **Ctrl-R:** on IOS this redraws the line. Hopline's own Ctrl-R history search is a client feature, so it must not send 0x12 to the device expecting a search.

## 5. Config model

**There is no candidate configuration.** Every line is parsed and applied to `running-config` the moment Enter is pressed. A bad line is rejected on its own (with the caret error) and the other lines stay applied. Leaving config mode with `end` or Ctrl-Z logs this message:

```
*Nov 24 14:02:11.123: %SYS-5-CONFIG_I: Configured from console by netops on vty0 (10.10.10.50)
```
The `%FACILITY-SEVERITY-MNEMONIC: text` form, with severity 5 = notification, is standard IOS syslog. The exact text `Configured from console by <user> on <line> (<ip>)` is `[unverified, from memory]`; community posts quote `Configured from console by console` for an unauthenticated console. The leading `*` means the clock is not NTP-synced, and `.123` appears with `service timestamps log datetime msec` `[unverified, from memory]`.

**Saving to startup.** Both commands write NVRAM `startup-config`:
- `write memory` (alias `wr`, because `write` alone means `write memory`).
- `copy running-config startup-config`.

```
core-sw1#copy running-config startup-config
Destination filename [startup-config]?
Building configuration...
[OK]
core-sw1#write memory
Building configuration...
[OK]
```
`Destination filename [startup-config]?`, `Building configuration...` and `[OK]` are standard. The `copy running-config startup-config` command is in [S7] (secondary), but the strings themselves were only seen in search snippets, so they are `[unverified, from memory]`. On IOS-XE Catalyst, `[OK]` may be followed by a `%` stack-sync line on stacks `[unverified, from memory]`.

**Erasing startup** (`write erase` or `erase startup-config`):

```
Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]
```
This line is from [S7] (secondary). Then `[OK]` and `Erase of nvram: complete` `[unverified, from memory]`.

**Reload:**

```
core-sw1#reload
System configuration has been modified. Save? [yes/no]: n
Proceed with reload? [confirm]
```
- **The two prompts.** `System configuration has been modified. Save? [yes/no]:` appears only when running differs from startup. `Proceed with reload? [confirm]` follows it `[S7]` (secondary transcript). [S4] confirms `Proceed with reload? [confirm]`.
- **Answering.** At `[yes/no]`, typing `y` or `yes` saves first. At `[confirm]`, Enter or `y` proceeds and any other key aborts `[unverified, from memory]`.
- **C9300 stacks.** A line `Reload command is being issued on Active unit, this will reload the whole stack` precedes the confirm `[unverified, from memory]`.
- **Scheduled reloads.** The syntax is `reload [text | in [hh:]mm [text] | at hh:mm [month day | day month] [text] | cancel]` `[S4]`.
  - `reload in 10` prints `Reload scheduled for 11:57:08 PDT Fri Apr 21 1996 (in 10 minutes)`, then `Proceed with reload? [confirm]` `[S4]`.
  - `reload cancel` prints `%Reload cancelled.` `[S4]`. Modern releases also broadcast `***` / `*** --- SHUTDOWN ABORTED ---` / `***` to all terminals `[unverified, from memory]`.
  - `reload in 10` is the classic safety net for risky remote changes: schedule it, make the change, then `reload cancel`.

**Archive, configuration replace and rollback** (IOS 12.3T+ and all IOS-XE), from [S1]:

```
core-sw1(config)#archive
core-sw1(config-archive)#path flash:archive/core-sw1
core-sw1(config-archive)#maximum 14
core-sw1(config-archive)#time-period 1440
core-sw1(config-archive)#write-memory
core-sw1(config-archive)#end
core-sw1#archive config
core-sw1#show archive
The maximum archive configurations allowed is 14.
There are currently 1 archive configurations saved.
The next archive file will be named flash:archive/core-sw1-2
 Archive #  Name
   1        flash:archive/core-sw1-1 <- Most Recent
   2
   3
...
```
- **Archive settings.** `path`, `maximum` (1-14, default 10) and `time-period` are in [S1]. `write-memory` (archive on each `write mem`) is `[unverified, from memory]`; [S1] does not list it.
- **`show archive` output.** The `There are currently ... saved.`, `The next archive file will be named ...` and `<- Most Recent` lines are [S1]. The `The maximum archive configurations allowed is 14.` first line and the ` Archive #  Name` column header are `[unverified, from memory]`; [S1] did not show them. When archiving is not configured, ntc shows ` Archive feature not enabled` [N13].

`configure replace` replaces the whole running config with a file and computes the diff itself `[S1]`:
- **Syntax:** `configure replace <url> [nolock] [list] [force] [ignorecase] [reverttrigger [error] [timer <min>] | time <min>]` `[S1]`. [S1] writes `reverttrigger` as one word; real devices accept `revert trigger` (two words) `[unverified, from memory]`.
- **`list`** prints each pass's commands (`!Pass 1`, `!List of Commands:`).
- **`force`** skips the prompt.
- **`time <min>`** auto-reverts unless the change is confirmed in time.

```
core-sw1#configure replace flash:archive/core-sw1-1
This will apply all necessary additions and deletions
to replace the current running configuration with the
contents of the specified configuration file, which is
assumed to be a complete configuration, not a partial
configuration. Enter Y if you are sure you want to proceed. ? [no]: Y
Total number of passes: 1
Rollback Done

core-sw1#
```
`This will apply all necessary additions and deletions`, `Enter Y if you are sure you want to proceed. ? [no]:`, `Total number of passes: 1` and `Rollback Done` are [S1]. The middle sentence (from `to replace the current running configuration` to `not a partial configuration.`) and the line breaks are `[unverified, from memory]`. The prompt reads `? [no]:` with a stray `?`, exactly as Cisco prints it.

**Timed rollback (IOS's "commit confirmed")** `[S1]`:
- `configure replace nvram:startup-config time 120` applies the file, then reverts unless `configure confirm` is entered within 120 minutes.
- `configure revert now` reverts immediately. `configure revert timer <min>` or `timer idle <min>` changes the pending timer.

```
core-sw1#configure terminal revert timer 5
Rollback Confirmed Change: Backing up current running config to flash:archive/core-sw1-Nov-24-14-10-02.123-0
Enter configuration commands, one per line.  End with CNTL/Z.
core-sw1(config)#...
core-sw1(config)#end
core-sw1#configure confirm
```
- **Status.** `configure terminal revert timer` and the `Rollback Confirmed Change: Backing up current running config to ...` line are `[unverified, from memory]`. They were seen only in a search snippet of a community thread that returned 403.
- **Requirements.** An `archive path` must be configured first.
- **Unexpected `configure confirm`.** It answers `%No Rollback Confirmed Change pending` `[unverified, from memory]`.
- **Syslog.** Expiry and confirm emit `%ARCHIVE_DIFF-5-ROLLBK_CNFMD_CHG_*` messages `[unverified, from memory]`.

**Other config-management features** `[unverified, from memory]`:
- **Diff:** `show archive config differences [file1] [file2]`.
- **Logging:** `show archive log config all` (with `archive` / `log config` / `logging enable`) records who typed each line, and is the IOS audit trail.
- **Notification:** `notify syslog` under `archive log config` emits `%PARSER-5-CFGLOG_LOGGEDCMD`.
- **Locking:** `configuration mode exclusive` locks config.

**IOS vs IOS-XE.**
- **Model-driven config (XE only).** IOS-XE adds NETCONF/RESTCONF with candidate/running datastores (`netconf-yang feature candidate-datastore`). The CLI stays immediate-apply.
- **Software install (XE only).** IOS-XE uses install mode (`install add file flash:<file>.bin activate commit`, `install remove inactive`, and the boot variable `boot system flash:packages.conf`), which prompts `This operation requires a reload of the system. Do you want to proceed? [y/n]` `[S10]`.
- **16.5.1a and 16.6.1** used `request platform software package install switch all file ... auto-copy` and `request platform software package clean switch all` `[S10]`.
- **Classic IOS** has no install mode. It boots from a `.bin` in `boot system`.

## 6. Show commands

| Command | Purpose | Notes |
|---|---|---|
| `show ip interface brief` | L3 status of every interface | The column widths vary by release (see the sample). |
| `show interfaces status` | L2 port status, VLAN, duplex, speed, type (switches) | [N10] layout |
| `show interfaces description` | Admin/oper status and description | |
| `show interfaces <if>` | Counters, errors, MTU, last flap | Long output |
| `show interfaces trunk` | Trunk ports, allowed / active / forwarding VLANs | Switches |
| `show interfaces counters errors` | Per-port error counters | Switches |
| `show vlan brief` | VLAN to ports | [N11] (`show vlan`) |
| `show spanning-tree [vlan N] [summary]` | STP roles, root, blocked ports | |
| `show etherchannel summary` | Port-channel bundles and flags | |
| `show mac address-table [address|interface|vlan|dynamic]` | L2 table | 12.1 used `show mac-address-table` (with a hyphen) |
| `show ip arp [vrf X]` | ARP | |
| `show ip route [vrf X] [prefix]` | RIB | The legend differs between 12.x and 15.x/XE |
| `show ip route summary` | Route counts per protocol | |
| `show ip cef <prefix>` | FIB entry | |
| `show ip bgp summary` / `show bgp ipv4 unicast summary` | BGP peers | `show bgp all summary` gives per-AF blocks [N9] |
| `show ip bgp neighbors <ip> [advertised-routes|received-routes|routes]` | BGP peer detail | `received-routes` needs soft-reconfig inbound |
| `show ip bgp [prefix]` | BGP table | |
| `show ip ospf neighbor` | OSPF adjacencies | |
| `show ip ospf interface brief` | OSPF-enabled interfaces, area, cost | |
| `show ip eigrp neighbors` | EIGRP peers | |
| `show ip protocols` | Routing protocol summary | |
| `show vrf` / `show vrf brief` / `show ip vrf` | VRFs, RD, interfaces | [N12] |
| `show cdp neighbors [detail]` | CDP neighbors | `detail` gives the IP and the software version |
| `show lldp neighbors [detail]` | LLDP neighbors | LLDP is off by default; enable with `lldp run` |
| `show version` | Software, uptime, model, serial, reload reason | |
| `show inventory` | PIDs and serials | |
| `show logging` | Syslog buffer | |
| `show running-config [interface X] | section <re>` | Running config | `show run all` adds the defaults |
| `show startup-config` | NVRAM config | |
| `show ip access-lists [name]` | ACL entries with hit counts | [N14] |
| `show route-map [name]` | Route maps with match/set and policy-routing hits | [N15] |
| `show ip prefix-list [name]` | Prefix lists | |
| `show processes cpu sorted [5sec]` / `show processes cpu history` | CPU | |
| `show platform resources` (XE) / `show memory statistics` | Memory and CPU | XE only for `platform` |
| `show environment all` | PSU, fans, temperature | On C9300: `show env all` |
| `show switch` (C9300) | Stack members, roles, priority | XE Catalyst |
| `show standby brief` / `show vrrp brief` | FHRP | |
| `show ip dhcp snooping binding` | Snooping table | |
| `show power inline` | PoE | |
| `show clock`, `show users`, `show ntp associations` | Misc | |
| `show tech-support` | Everything | Very long, CPU-heavy, and unsafe for an agent to run unfiltered |

**Pipes** (IOS 12.3+ and XE): `| include`, `| exclude`, `| begin`, `| section`, `| count`, `| redirect <url>`, `| append <url>`, `| tee <url>`, and `| format <spec>` (XE, XML output via an ODM spec) `[unverified, from memory]`.
- **Regex:** the argument is a regex.
- **`| i` abbreviation:** `| i` is accepted as `include`.
- **No `| json` or `| no-more` on IOS or IOS-XE** `[unverified, from memory]`.

### Samples (core-sw1)

The samples use core-sw1 data in the layouts taken from the ntc raw captures. Column offsets were measured with a script and the rows were generated programmatically to keep the alignment exact. One addition to the fixture: the C9300 also has a management port `GigabitEthernet0/0` in the built-in VRF `Mgmt-vrf`.

#### show ip interface brief
Two widths exist in the wild:
- The ntc capture [N1] (IOL/IOS) places `IP-Address` at column 27.
- Catalyst/IOS-XE builds place it at column 23, which fits `GigabitEthernet1/0/48` plus two spaces. Both widths are fixed per release, not computed from the data `[unverified, from memory]`.

The 23-column variant (matching the simulator) is shown here. The rest of the layout (OK?/Method/Status/Protocol spacing, `administratively down` filling the Status field) is from [N1].
```
core-sw1#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
Vlan1                  unassigned      YES NVRAM  administratively down down
Vlan10                 10.10.10.1      YES NVRAM  up                    up
Vlan20                 10.10.20.1      YES NVRAM  up                    up
Vlan30                 10.10.30.1      YES NVRAM  up                    up
GigabitEthernet0/0     192.168.99.21   YES NVRAM  up                    up
GigabitEthernet1/0/1   10.0.0.5        YES NVRAM  up                    up
GigabitEthernet1/0/2   10.0.0.1        YES NVRAM  administratively down down
GigabitEthernet1/0/3   unassigned      YES unset  up                    up
GigabitEthernet1/0/4   unassigned      YES unset  down                  down
GigabitEthernet1/0/5   unassigned      YES unset  up                    up
GigabitEthernet1/0/6   unassigned      YES unset  up                    up
GigabitEthernet1/0/48  unassigned      YES unset  up                    up
Loopback0              10.255.0.1      YES NVRAM  up                    up
```
- **Method values:** `NVRAM` appears for addresses loaded from startup at boot, `manual` for addresses typed since boot, and `unset`, `DHCP`, `TFTP` and `other` in other cases [N1 shows NVRAM].
- **Other Status values:** `deleted` (a removed sub-interface) [N1]. `reset` also exists `[unverified, from memory]`.

#### show ip bgp summary
Layout from [N9] (`show ip bgp summary all`, IPv4 block) and [N8]:
- `Neighbor` is padded to 16 and `V` is at column 16.
- `AS` is right-aligned, ending at column 29. MsgRcvd ends at 37, MsgSent at 45, TblVer at 54, InQ at 59 and OutQ at 64.
- Up/Down is left-aligned at column 66.
- A numeric PfxRcd is right-aligned, ending at column 82. A text state (`Idle`, `Active`, `Idle (Admin)`, `Idle (PfxCt)`) starts at column 76. This was measured from the only text-state row in [N8]: `Idle` sits at column 78 there, and the row has two overflowed numeric fields (an 8-digit MsgRcvd and a 9-digit TblVer) that each push it one column right.

The same header appears in [S9] (an ipv4 multicast sample, where the AS column is narrower: `Neighbor        V    AS MsgRcvd ...`, from older IOS). [S9] defines State/PfxRcd as "State of the neighbor/number of routes received. If no state is indicated, the state is up."
```
core-sw1#show ip bgp summary
BGP router identifier 10.255.0.1, local AS number 65001
BGP table version is 482, main routing table version 482
16 network entries using 3968 bytes of memory
16 path entries using 2176 bytes of memory
5/5 BGP path/bestpath attribute entries using 1480 bytes of memory
2 BGP AS-PATH entries using 64 bytes of memory
0 BGP route-map cache entries using 0 bytes of memory
0 BGP filter-list cache entries using 0 bytes of memory
BGP using 7688 total bytes of memory
BGP activity 491/475 prefixes, 512/496 paths, scan interval 60 secs
16 networks peaked at 09:12:44 Oct 14 2026 UTC (5w6d ago)

Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd
10.0.0.2        4        65002       0       0        1    0    0 03:02:11  Idle
10.0.0.6        4        65000   61234   61190      482    0    0 5w6d           12
```
- **`networks peaked at` line:** XE 16.x+ only `[unverified, from memory]`.
- **Idle reason for 10.0.0.2:** the peer sits behind an admin-down interface, so it shows `Idle`. `Idle (Admin)` would mean `neighbor 10.0.0.2 shutdown`.
- **Up/Down formats:** `hh:mm:ss` below 24 hours (`00:20:06` [N9]), then week forms such as `3w0d`, `19w5d` and `1y10w` [N8]. The `1d02h` day form is `[unverified, from memory]`.

#### show ip ospf neighbor
Invented: the fixture has no OSPF; this assumes `router ospf 1` on Gi1/0/1 and Vlan10. Layout from [N3]: `Neighbor ID` 0, `Pri` right-aligned ending at column 18, `State` 22, `Dead Time` 38, `Address` 50, `Interface` 66. Point-to-point links show `FULL/  -`. The leading blank line is `[unverified, from memory]`.
```
core-sw1#show ip ospf neighbor

Neighbor ID     Pri   State           Dead Time   Address         Interface
10.255.0.2        0   FULL/  -        00:00:34    10.0.0.6        GigabitEthernet1/0/1
10.255.0.11       1   FULL/DR         00:00:37    10.10.10.2      Vlan10
10.255.0.12       1   2WAY/DROTHER    00:00:31    10.10.10.3      Vlan10
```

#### show ip route (IOS 15.x / IOS-XE legend)
The legend below (with `L - local`, `H - NHRP`, `l - LISP`, `a - application route`, `+`/`%`/`p`) is byte-exact from [N7] and matches the cisco community capture [S8].
- **IOS-XE 17.x appends more codes:** `m - OMP`, `n - NAT, Ni - NAT inside, No - NAT outside, Nd - NAT DIA`, `G - NHRP registered, g - NHRP registration summary`, and `& - replicated local route overrides by connected` `[unverified, from memory]`.
- **Classic 12.x** has no `L` code and no local /32 routes. It uses a 7-space code column (`C       10.0.1.0/24`) and parent lines with 5 spaces [N4].
- **15.x/XE** use a 9-character code column and parent lines with 6 spaces [N7][S8].
```
core-sw1#show ip route
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area 
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       a - application route
       + - replicated route, % - next hop override, p - overrides from PfR

Gateway of last resort is 10.0.0.6 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 10.0.0.6
      10.0.0.0/8 is variably subnetted, 10 subnets, 3 masks
C        10.0.0.4/30 is directly connected, GigabitEthernet1/0/1
L        10.0.0.5/32 is directly connected, GigabitEthernet1/0/1
C        10.10.10.0/24 is directly connected, Vlan10
L        10.10.10.1/32 is directly connected, Vlan10
C        10.10.20.0/24 is directly connected, Vlan20
L        10.10.20.1/32 is directly connected, Vlan20
C        10.10.30.0/24 is directly connected, Vlan30
L        10.10.30.1/32 is directly connected, Vlan30
C        10.255.0.1/32 is directly connected, Loopback0
B        10.255.0.2/32 [20/0] via 10.0.0.6, 5w6d
      172.16.0.0/16 is variably subnetted, 2 subnets, 2 masks
B        172.16.0.0/16 [20/0] via 10.0.0.6, 5w6d
B        172.16.8.0/22 [20/0] via 10.0.0.6, 5w6d
```
- **Line forms:** `B*    0.0.0.0/0` (default route, 6-character code column) appears in [N7]. The `S*` form is the same layout `[unverified, from memory]`. The `is variably subnetted, N subnets, M masks` and `is subnetted, N subnets` parent lines appear in [N4][N7].
- **Trailing space:** the **second** legend line, ending `IA - OSPF inter area `, has a real trailing space [N4][N7].
- **ECMP:** extra next hops print on continuation lines indented to the `[` column [N4].
- **VRF tables:** these are prefixed with `Routing Table: <VRF>` [N7].
- **Lookups:** `show ip route 10.10.10.0` prints a `Routing entry for 10.10.10.0/24` block. A missing prefix prints `% Network not in table` (or `% Subnet not in table`) `[unverified, from memory]`.

#### show mac address-table
This is the IOS-XE/Catalyst layout. It is byte-exact from [N5][N6]: `Vlan` right-aligned in 4 columns, `Mac Address` at column 8, `Type` at 26 and `Ports` at 38.
- **Older layouts:** Catalyst 6500 and 4500 use a `Legend: * - primary entry ...` block with lowercase columns. The 12.1 `show mac-address-table` used `Destination Address  Address Type  VLAN  Destination Port`.
```
core-sw1#show mac address-table
          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
 All    ffff.ffff.ffff    STATIC      CPU
   1    00a3.d14f.0180    STATIC      Vl1
  10    3c22.fb81.9e02    DYNAMIC     Gi1/0/48
  10    aabb.cc00.0110    DYNAMIC     Gi1/0/5
  20    0017.c8a1.33f0    DYNAMIC     Gi1/0/3
  30    aabb.cc00.0230    DYNAMIC     Gi1/0/48
  30    f4db.e6a0.1c11    DYNAMIC     Gi1/0/6
Total Mac Addresses for this criterion: 8
```

#### show ip arp
- **Layout used here:** `Protocol  Address          Age (min)  Hardware Addr   Type   Interface` (Address 10, Age 27, Hardware 38, Type 54, Interface 61) `[unverified, from memory]`. The simulator uses this header.
- **Conflict between sources:** the only ntc capture [N2] uses a wider, edited-looking header, `Protocol  Address              Age(min)       Hardware Addr     Type      Interface`.
- **Treat these columns as the least certain of the samples.**
- **Own addresses** show `-` for Age.
```
core-sw1#show ip arp
Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.0.0.5                -   00a3.d14f.0101  ARPA   GigabitEthernet1/0/1
Internet  10.0.0.6               12   3c22.fb81.0006  ARPA   GigabitEthernet1/0/1
Internet  10.10.10.1              -   00a3.d14f.0a0a  ARPA   Vlan10
Internet  10.10.10.57             3   aabb.cc00.0110  ARPA   Vlan10
Internet  10.10.20.1              -   00a3.d14f.0a14  ARPA   Vlan20
Internet  10.10.20.31             0   0017.c8a1.33f0  ARPA   Vlan20
Internet  10.10.30.1              -   00a3.d14f.0a1e  ARPA   Vlan30
Internet  10.10.30.112            1   f4db.e6a0.1c11  ARPA   Vlan30
```
In this layout Age is right-aligned to end at column 34, with three spaces before the MAC at column 38. That is how I remember the classic Cisco command-reference example, but I did not open that page, so the claim is `[unverified, from memory]` and it remains a conflict with [N2]. The simulator left-aligns Age at column 27.

#### show cdp neighbors
The IOS-XE layout is byte-exact from [N16] (a capture with C9300/C9500 neighbors):
- Header columns: `Device ID` 0, `Local Intrfce` 17, `Holdtme` 35, `Capability` 46, `Platform` 58, `Port ID` 68.
- The legend has 3 lines.
- A device ID longer than 16 characters prints on its own line, and the data wraps to the next line at column 17.
- Interfaces are abbreviated **with a space**: `Gig 1/0/1`, `Ten 1/1/3`, `Fas 0/0`.
- The footer is `Total cdp entries displayed : N`, with a space before the colon.
- Older IOS (12.x) uses `Capability Codes: R - Router, T - Trans Bridge, B- Source Route Bridge` with a tab-indented second line and no footer [N17].

`dist-eos1` (Arista) and `isp-r2` (Juniper) do not speak CDP, so only Cisco neighbors appear:
```
core-sw1#show cdp neighbors
Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge
                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,
                  D - Remote, C - CVTA, M - Two-port Mac Relay

Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID
edge-r1.lab.example.net
                 Gig 1/0/1         157              R I   ISR4431/K Gig 0/0/0
AP-3F-East       Gig 1/0/6         122             T B I  C9120AXI- Gig 0

Total cdp entries displayed : 2
```
- **Capability column:** the codes are **centred** around column 53, not right-aligned. Measured in [N16]: `H` starts at 53, `R I` and `S I` at 52, `R S I` at 51 and `R B S I` at 50, so start = 53 - (len-1)/2. Platform always starts at 58.
- **Platform field:** truncated to fit its column (`ISR4431/K`, `C9120AXI-`), as in [N16] (`ASR1002-H`).

#### show lldp neighbors
Byte-exact from [N18][N19]:
- `Device ID` 0 (truncated to 20 characters with no separator, e.g. `long_name_swt.josh-vGi0/2` in [N19]), `Local Intf` 20, `Hold-time` 35, `Capability` 46, `Port ID` 62.
- The legend has 3 lines.
- The footer `Total entries displayed: N` follows one blank line, or two in [N20].
- **`isp-r2` is omitted** because the fixture has Gi1/0/2 admin down, and LLDP neighbors age out on a shut port. The simulator still lists it (see section 10).
```
core-sw1#show lldp neighbors
Capability codes:
    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other

Device ID           Local Intf     Hold-time  Capability      Port ID
edge-r1.lab         Gi1/0/1        120        R               Gi0/0/0
dist-eos1           Gi1/0/48       120        B,R             Ethernet48

Total entries displayed: 2
```

#### show version (IOS-XE 17.9 on C9300)
- **Structure:** follows the IOS-XE Catalyst captures [N21][N22] (C9500 16.9/16.12).
- **First line:** `Cisco IOS XE Software, Version 17.09.04a`, **zero-padded**, while the second line carries the dotted short form `17.9.4a` [N21][N22].
- **Stack table:** the `Switch Ports Model ...` table at the end is C9300/C9200 (stackable) only. It is `[unverified, from memory]`, as is the `Mode` column.
- **Header sections:** the GPL paragraph, the export-compliance paragraph and the license table appear on real output. They are trimmed below as `...`; a simulator should keep at least the license block.
```
core-sw1#show version
Cisco IOS XE Software, Version 17.09.04a
Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2023 by Cisco Systems, Inc.
Compiled Fri 20-Oct-23 10:44 by mcpre


Cisco IOS-XE software, Copyright (c) 2005-2023 by cisco Systems, Inc.
All rights reserved.  Certain components of Cisco IOS-XE software are
...

ROM: IOS-XE ROMMON
BOOTLDR: System Bootstrap, Version 17.9.1r[FC2], RELEASE SOFTWARE (P)

core-sw1 uptime is 5 weeks, 6 days, 7 hours, 12 minutes
Uptime for this control processor is 5 weeks, 6 days, 7 hours, 15 minutes
System returned to ROM by Reload Command at 07:02:10 UTC Tue Oct 13 2026
System restarted at 07:08:31 UTC Tue Oct 13 2026
System image file is "flash:packages.conf"
Last reload reason: Reload Command

...

Technology Package License Information: 

------------------------------------------------------------------------------
Technology-package                                     Technology-package
Current                        Type                       Next reboot  
------------------------------------------------------------------------------
network-advantage       Smart License                    network-advantage   
dna-advantage           Subscription Smart License       dna-advantage                 
AIR License Level: AIR DNA Advantage
Next reload AIR license Level: AIR DNA Advantage


Smart Licensing Status: Registration Not Applicable/Not Applicable

cisco C9300-48P (X86) processor with 1331521K/6147K bytes of memory.
Processor board ID FOC2231X0AB
1 Virtual Ethernet interface
56 Gigabit Ethernet interfaces
8 Ten Gigabit Ethernet interfaces
2048K bytes of non-volatile configuration memory.
8388608K bytes of physical memory.
1638400K bytes of Crash Files at crashinfo:.
11264000K bytes of Flash at flash:.
0K bytes of WebUI ODM Files at webui:.

Base Ethernet MAC Address          : 00:a3:d1:4f:01:00
Motherboard Assembly Number        : 73-17952-06
Motherboard Serial Number          : FOC22301ABC
Model Revision Number              : B0
Motherboard Revision Number        : A0
Model Number                       : C9300-48P
System Serial Number               : FOC2231X0AB


Switch Ports Model              SW Version        SW Image              Mode   
------ ----- -----              ----------        ----------            ----   
*    1 65    C9300-48P          17.09.04a         CAT9K_IOSXE           INSTALL


Configuration register is 0x102
```
- **Uptime format:** spelled out (`5 weeks, 6 days, ...`) in `show version`, unlike the compact `5w6d` in tables [N21].
- **Classic IOS first line:** `Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, RELEASE SOFTWARE (fc1)` `[unverified, from memory]`.
- **IOS-XE 3.x (pre-16) first line:** `Cisco IOS Software, IOS-XE Software, ...` [N23].

#### show logging
- **Header:** structure from [N24]–[N26].
- **Buffered lines:** carry `*` when the clock is not synced, `.mmm` with `service timestamps log datetime msec`, and a `NNNNNN: ` sequence prefix with `service sequence-numbers` [N24].
- **C9300 stacks:** prefix messages from members with `%...` plus `(SW2-...)`-style origin tags on some messages `[unverified, from memory]`.
- **The `%BGP_SESSION-5-ADJCHANGE` line:** IOS-XE 16+ wording `[unverified, from memory]`.
```
core-sw1#show logging
Syslog logging: enabled (0 messages dropped, 3 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)

No Active Message Discriminator.



No Inactive Message Discriminator.


    Console logging: disabled
    Monitor logging: level debugging, 0 messages logged, xml disabled,
                     filtering disabled
    Buffer logging:  level debugging, 214 messages logged, xml disabled,
                    filtering disabled
    Exception Logging: size (4096 bytes)
    Count and timestamp logging messages: disabled
    Persistent logging: disabled

No active filter modules.

    Trap logging: level informational, 218 message lines logged
        Logging to 10.10.10.20  (udp port 514, audit disabled,
              link up),
              218 message lines logged,
              0 message lines rate-limited,
              0 message lines dropped-by-MD,
              xml disabled, sequence number disabled
              filtering disabled
        Logging Source-Interface:       VRF Name:
        Loopback0                       

Log Buffer (102400 bytes):

*Nov 24 11:02:11.418: %SYS-5-CONFIG_I: Configured from console by netops on vty0 (10.10.10.50)
*Nov 24 11:02:13.402: %LINK-5-CHANGED: Interface GigabitEthernet1/0/2, changed state to administratively down
*Nov 24 11:02:14.402: %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet1/0/2, changed state to down
*Nov 24 11:02:14.903: %BGP-5-ADJCHANGE: neighbor 10.0.0.2 Down Interface flap
*Nov 24 11:02:15.003: %BGP_SESSION-5-ADJCHANGE: neighbor 10.0.0.2 IPv4 Unicast topology base removed from session  Interface flap
```
The quirky indentation is real [N24]: `Buffer logging:` is followed by two spaces, and its continuation line is indented one column less than the others.

#### show running-config (excerpt)
- **Preamble:** `Building configuration...` plus a blank line, then `Current configuration : N bytes` (with a space before the colon), then `!` separators [N27].
- **Indentation:** sub-mode lines are indented by one space. Nested blocks (address-family) are indented by two.
- **IOS-XE ordering:** `vrf definition` comes before interfaces.
- **Ending:** with `end`.
- **Body:** `[unverified, from memory]`, modelled on core-sw1.
```
core-sw1#show running-config
Building configuration...

Current configuration : 9874 bytes
!
! Last configuration change at 11:02:11 UTC Tue Nov 24 2026 by netops
! NVRAM config last updated at 09:40:02 UTC Tue Nov 24 2026 by netops
!
version 17.9
service timestamps debug datetime msec
service timestamps log datetime msec
service password-encryption
!
hostname core-sw1
!
vrf definition MGMT
 rd 65001:99
 !
 address-family ipv4
 exit-address-family
!
vlan 10
 name USERS
!
vlan 20
 name PRINTERS
!
vlan 30
 name WIFI
!
interface Loopback0
 ip address 10.255.0.1 255.255.255.255
!
interface GigabitEthernet1/0/1
 description uplink to edge-r1
 no switchport
 ip address 10.0.0.5 255.255.255.252
!
interface GigabitEthernet1/0/2
 description uplink to isp-r2 (AS65002)
 no switchport
 ip address 10.0.0.1 255.255.255.252
 shutdown
!
interface GigabitEthernet1/0/48
 description trunk to dist-eos1
 switchport trunk allowed vlan 10,20,30
 switchport mode trunk
!
interface Vlan10
 description USERS
 ip address 10.10.10.1 255.255.255.0
!
router bgp 65001
 bgp router-id 10.255.0.1
 bgp log-neighbor-changes
 neighbor 10.0.0.2 remote-as 65002
 neighbor 10.0.0.2 description isp-r2
 neighbor 10.0.0.6 remote-as 65000
 neighbor 10.0.0.6 description edge-r1
!
ip route 0.0.0.0 0.0.0.0 10.0.0.6
!
ip access-list extended EDGE-IN
 10 permit tcp any host 10.255.0.1 eq bgp
 20 deny   ip any any log
!
route-map RM-EDGE-IN permit 10
 match ip address prefix-list PL-EDGE-IN
!
line vty 0 15
 transport input ssh
!
end
```
- **ACL sequence numbers:** IOS-XE 16.x+ shows them in `show run` for named ACLs, while classic IOS hides them `[unverified, from memory]`.
- **`deny   ip`:** padding `deny` to the width of `permit` (three spaces) is how IOS prints ACEs [N14].

## 7. Dangerous commands

**Categories** (IOS and IOS-XE unless noted):
- **Reboot.** `reload` (all forms). Also `reload slot N` and `reload /noverify`. On XE: `redundancy force-switchover`, `redundancy reload shelf|peer`, `hw-module switch N reload` and `hw-module subslot ... reload`.
- **Erase and format.**
  - `write erase`, `erase startup-config`, `erase nvram:`, `erase flash:`.
  - `format flash:`, `delete [/force /recursive] flash:...`, `squeeze`, `fsck`.
  - XE: `factory-reset all [secure]`, `factory-reset switch all all` (C9k).
- **Software.**
  - XE: `install add|activate|commit|rollback|remove`.
  - XE 16.5/16.6: `request platform software package ...` `[S10]`.
  - Both: `boot system` (config), `config-register 0x2142` (config; skips startup on the next boot), `upgrade rom-monitor`, `archive download-sw` (classic Catalyst IOS), `software install`.
- **Files.** `copy <any> running-config` (merges into running), `copy <url> startup-config`, `copy ... flash:` (overwrite), `rename`, `mkdir`/`rmdir`, `more` on large files (harmless).
- **Config replace.** `configure replace <url>`, `configure revert now`, `configure memory` (merge startup into running), `configure network`/`configure overwrite-network`.
- **Shell escapes.**
  - `tclsh`, which can run anything including `exec "reload"`.
  - XE: `guestshell run bash`, `app-hosting`, `request platform software system shell` (root shell, needs a consent token).
  - XE: `run`, `start-shell`, which do not exist on Catalyst `[unverified, from memory]`.
- **Outbound sessions.** `telnet`, `ssh -l`, `connect`, `rlogin`, `resume`. Also **any unknown single word** at exec, which is treated as an implicit telnet (see section 3).
- **Debug.** `debug all` can halt the box, and `debug ip packet` without an ACL pins the CPU. `debug platform ...` (XE) and `debug condition` are also risky. Mitigation: `undebug all` / `u all`.
- **Clear.**
  - BGP: `clear ip bgp *` (hard reset of all peers), `clear ip bgp <peer>` (hard reset; `soft` is fine), `clear bgp all *`.
  - Routing and L2: `clear ip ospf process`, `clear ip route *`, `clear arp-cache`, `clear mac address-table dynamic`.
  - Data loss: `clear counters` (loses evidence), `clear logging` (destroys the log buffer).
  - Access: `clear line vty N` (kills sessions), `clear crypto session`, `clear ip nat translation *`, `clear spanning-tree detected-protocols`.
- **Stacks (C9300).** `switch N renumber M`, `switch N priority P` and `switch N provision`; renumbering requires a reload.
- **Crypto.** `crypto key zeroize rsa` (breaks SSH), `crypto key generate rsa` (replaces the key), `crypto pki ... delete`.
- **Licensing.** `license smart deregister`, `license boot level ...`.
- **Test.** `test crash` (XE: crash the box), `test platform ...`.
- **Packet capture (XE).** `monitor capture CAP start` (EPC; CPU load and disk fill), and `monitor session` changes in config.
- **Destructive config-mode commands** (not expressible as top-level exec tokens):
  - Removing protocols: `no router bgp 65001`, `no router ospf 1`, `no ip routing`.
  - Removing interfaces and VLANs: `no interface Vlan10`, `default interface Gi1/0/48`, `no vlan 10`.
  - Shutting things down: `shutdown` on an uplink or SVI, `neighbor X shutdown`, `spanning-tree vlan X` changes, and `no spanning-tree vlan X` (loops).
  - Trunks: `switchport trunk allowed vlan 10` **without `add`** replaces the list and drops the other VLANs (the classic trap).
  - `ip address` changes on the management interface.
  - Locking yourself out: `transport input none` or `access-class` on `line vty`, `no aaa new-model`, AAA method-list changes, `no username netops`, `enable secret` changes.
  - VTP: `vtp mode server`/`vtp domain` (a VTP revision bomb can wipe the VLAN database).
  - Other: `no ip ssh ...`, `logging` removal, `event manager applet ...` (EEM runs CLI as a privileged user), and `kron`.
  - Running exec from config: `do <exec cmd>`.

**PlatformRules proposal** (one rules object for `ios` and `iosxe`, plus an XE-only extension):

```ts
const CISCO_COMMON_BLOCKED = [
  // keep the existing list, and add:
  'factory-reset',   // XE 16.x+: wipes config, flash, licensing
  'switch',          // C9k exec: "switch 2 renumber 3", "switch 1 priority 15", provision
  'debug',           // move from `other`: any debug can pin the CPU on production gear
  'monitor',         // XE "monitor capture ... start" (EPC). Loses "monitor" read uses; acceptable
  'rlogin',
  'resume',          // re-enters suspended outbound sessions
] as const
// Judgment call (not added): 'more' can read flash:/nvram: files that hold secrets
// (e.g. "more nvram:startup-config"); block it if the agent must never see raw config files.

const CISCO_BLOCKED_PAIRS = [
  // existing pairs stay; add:
  ['write', 'network'],           // write to a TFTP host
  ['clear', 'logging'],           // destroys the evidence buffer
  ['clear', 'counters'],
  ['clear', 'line'],              // kills sessions (possibly our own)
  ['clear', 'arp-cache'],
  ['clear', 'mac'],               // "clear mac address-table"
  ['clear', 'crypto'],
  ['clear', 'spanning-tree'],
  ['clear', 'bgp'],               // "clear bgp all *"
  ['configure', 'confirm'],       // commits a timed rollback; the agent should not decide this
  ['terminal', 'shell'],          // enables shell processing in the session
  ['show', 'tech-support'],       // huge and CPU-heavy. Only works if the classifier checks pairs for `read` keywords too
  ['crypto', 'pki'],
] as const

const ios: PlatformRules = {
  read: ['show', 'ping', 'traceroute'],
  blocked: CISCO_COMMON_BLOCKED,
  other: [/* existing list, minus 'debug' and 'monitor' if moved, plus: */ 'mtrace'],
  blockedPairs: CISCO_BLOCKED_PAIRS,
  pipesAllowed: ['include', 'exclude', 'begin', 'section', 'count'],
  pipesBlocked: ['redirect', 'tee', 'append', 'format', 'export'], // "| format" (XE) reads an ODM spec file. Keep it blocked
  execFromConfig: 'do',
}
// XE today aliases ios. If XE ever gets its own object, also block:
// 'install', 'app-hosting', 'guestshell', 'request' (already common); 'platform' pairs such as
// ['platform', 'software'] (rare); ['hw-module', '*'] is already blocked as a keyword.
```

**What the shape cannot express:**
- **Arguments, not keywords.** `clear ip bgp *` vs `clear ip bgp 10.0.0.6 soft in` (safe) is 3+ tokens plus an argument. Today `clear` is `other` (approval needed), which is the right default, but `[clear, ip]` would over-block `clear ip ospf` statistics as well. The same applies to `clear ip route *`, `clear ip nat translation *`, `debug ip packet` vs `debug ip packet 101`, and `reload in 10` vs `reload cancel` (the latter is a safety action, but `reload` is blocked wholesale).
- **Keyword position.** `delete /force /recursive flash:` versus `dir`: the danger is in the flags.
- **Destination-dependent commands.** `copy running-config startup-config` is a benign save; the rest of `copy` is not. Done in 0.4: the IOS tree makes that exact save a `config` command (approval needed) and blocks every other `copy`.
- **Config-mode semantics.** `switchport trunk allowed vlan 10` (without `add`), `no router bgp`, `shutdown` on the uplink carrying the session, `no ip routing`, `line vty` / `transport input`, and `crypto key zeroize`. Everything typed after `configure terminal` is one lump to this classifier. The guard needs a config-line classifier that runs per line and knows the current sub-mode, for example `shutdown` under `interface <the interface the session arrives on>`.
- **`do` from config.** `do reload` must be re-classified as exec (the existing `execFromConfig` handles the prefix). `do` inside nested modes works the same way.
- **Implicit telnet.** A single unknown word at exec opens a connection, so an "unknown" top-level token must never be treated as harmless. The current fall-through to `config` (approval) is correct.
- **Interactive follow-ups.** The answers to `[confirm]`, `Save? [yes/no]:` and `? [no]:` are separate "commands" on the wire. The guard must treat the response to a confirm as part of the original command. A bare `y` or Enter after a blocked command must not get through.

**Abbreviation traps:**
- **`wr`** means `write` (memory) and is safe. **`wr er`** means `write erase` and is destructive. **`wr t`** means `write terminal` (show run) and is safe. Two letters decide it.
- **`er`** is `erase`: destructive and unique in exec. `e` is ambiguous (`enable`, `erase`, `event`, `exit`).
- **`del`** is `delete`. **`rel`** resolves to `release` or `reload` (ambiguous, and both are blocked). **`relo`** is `reload`. **`re`** is ambiguous across `release`, `reload`, `rename`, `renew`, `request`, `resume`, and `redundancy` (XE).
- **`conf rep`** is `configure replace` and **`conf rev`** is `configure revert`. `conf r` alone is ambiguous between them. **`conf m`** is `configure memory`. **`conf t`** is safe, and **`conf c`** is `configure confirm`.
- **`te`** is ambiguous across `telnet`, `terminal` and `test`. `ter len 0` is fine, and **`tes`** is `test`. **`tc`** is `tclsh`.
- **`u all` / `un all`** is `undebug all`, which is safe. **`deb a`** is `debug all`.
- **`cl ip bg *`** is `clear ip bgp *`. `cl` is ambiguous with `clock` on IOS.
- **`fa`** (XE) is `factory-reset`. **`for`** is `format`.
- **`sw`** (C9k) is `switch` (stack commands).
- **`copy run start`** means `copy running-config startup-config`, but **`copy start run`** merges startup into running and is a different operation.

## 8. Live-value sources

IOS has no `| json`. The IOS-XE structured options are:
- **NETCONF/RESTCONF** YANG models (`Cisco-IOS-XE-native`, `Cisco-IOS-XE-*-oper`, OpenConfig) after `netconf-yang` / `restconf`.
- **`| format`** with ODM specs (XML) on some commands.
- **Guestshell Python**, which is blocked for the agent.

For an SSH client, the cheapest robust path is usually plain-text parsing of compact commands, ideally with ntc-templates TextFSM, which covers all of the commands below.

| Value | Command to parse | Field / regex hint | Cheaper / structured alternative |
|---|---|---|---|
| Interfaces (all) | `show ip interface brief` | `^(\S+)\s+(\S+)\s+(YES|NO)\s+(\S+)\s+(administratively down|up|down|deleted)\s+(up|down)` | `show interfaces description` (adds the description). RESTCONF `Cisco-IOS-XE-interfaces-oper` / `ietf-interfaces` |
| Switchports | `show interfaces status` | Fixed columns: Port 0, Name 10, Status 29, Vlan 42, Duplex 53, Speed 60, Type 67 [N10] | `show interfaces switchport` |
| Interface descriptions | `show interfaces description` | `^(\S+)\s+(admin down|up|down)\s+(up|down)\s+(.*)$` | config: `show run | i ^interface|description` |
| VLANs | `show vlan brief` | `^(\d{1,4})\s+(\S+)\s+(active|act/lshut|sus|act/unsup)\s*(.*)$`; port continuation lines start with 48 spaces [N11] | `show running-config | section ^vlan` (VTP transparent only). YANG `Cisco-IOS-XE-vlan-oper` |
| VRFs | `show vrf` (XE / 15.x) or `show ip vrf` | `^  (\S+)\s+(<not set>|\d+:\d+|\S+)\s+(ipv4|ipv6|ipv4,ipv6)?\s*(\S*)$`; extra interfaces sit on continuation lines [N12] | `show vrf brief`; `show run | i ^vrf definition|^ip vrf` |
| BGP neighbors | `show ip bgp summary` (per VRF: `show ip bgp vpnv4 vrf X summary`) | Rows after `^Neighbor\s+V`: `^(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)\s+4\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$`. A digit-only last field means Established | `show bgp all summary` (all AFs, with `For address family:` headers) [N9]. `show run | section ^router bgp` for configured peers |
| BGP peer remote-AS / description | `show running-config | section ^router bgp` | `^ neighbor (\S+) (remote-as|description|peer-group) (.+)$` | `show ip bgp neighbors | i ^BGP neighbor|Description` |
| OSPF neighbors | `show ip ospf neighbor` | Fixed columns [N3] | `show ip ospf interface brief` |
| Route maps | `show route-map` | `^route-map (\S+), (permit|deny), sequence (\d+)` [N15] | `show run | i ^route-map` (cheapest; names only) |
| Prefix lists | `show ip prefix-list` | `^ip prefix-list (\S+): (\d+) entries` `[unverified, from memory]` | `show run | i ^ip prefix-list` and `^ipv6 prefix-list` |
| ACLs | `show ip access-lists` | `^(Standard|Extended) IP access list (\S+)`; entries `^\s+(\d+) (permit|deny|remark) (.*?)(?: \((\d+) match(?:es)?\))?$` [N14] | `show run | i ^ip access-list` (names only). Note that numbered ACLs `access-list 101 ...` are one-liners |
| Object groups (XE) | `show object-group` | `^(Network|Service) object group (\S+)` `[unverified, from memory]` | `show run | i ^object-group` |
| Port-channels | `show etherchannel summary` | `^(\d+)\s+(Po\d+)\((\w+)\)\s+(\S+)\s+(.*)$` `[unverified, from memory]` | `show run | i ^interface Port-channel` |
| Static routes | `show running-config | include ^ip route` | `^ip route (vrf (\S+) )?(\S+) (\S+) (\S+)` | `show ip route static` |
| Line / users | `show users` | `^\*?\s+(\d+) (vty \d+|con \d+)\s+(\S+)` | |
| Hostname / model / version | `show version` | `^(\S+) uptime is`, `^cisco (\S+) \(`, `Version ([\w.()]+)` | `show inventory` (PIDs) |
| Stack members (C9300) | `show switch` | `^\*?(\d)\s+(Active|Standby|Member)\s+(\S+)\s+(\d+)` `[unverified, from memory]` | |
| HSRP groups | `show standby brief` | `^(\S+)\s+(\d+)\s+(\d+)\s+P?\s+(Active|Standby|Listen|Init)` | |

**Tips:**
- **`| section` and `| include` with anchors** (`^interface`) are the cheapest config-derived sources. They need no sub-command parsing and work in both IOS and XE.
- **`show running-config` costs time** on large configs. XE caches it with `parser config cache interface` `[unverified, from memory]`.
- **Prefer `show run | i ^<keyword>`** for name lists, and the oper commands for state.

## 9. Interface naming

| Type | Full name | Short form in `show` tables | Accepted abbreviations | Regex (full) |
|---|---|---|---|---|
| FastEthernet | `FastEthernet0/1` | `Fa0/1` | `f`, `fa`, `fas` ... any unique prefix + number | `^FastEthernet\d+(/\d+){1,2}$` |
| Gigabit | `GigabitEthernet1/0/1` | `Gi1/0/1` | `g`, `gi`, `gig` ... `Gi1/0/1`; spaces are optional (`gi 1/0/1`) | `^GigabitEthernet\d+(/\d+){1,3}(\.\d+)?$` |
| 2.5G/5G (mGig) | `TwoGigabitEthernet1/0/1`, `FiveGigabitEthernet1/0/1` | `Tw1/0/1`, `Fi1/0/1` | `tw`, `fi` | `^(Two|Five)GigabitEthernet\d+(/\d+){2}$` |
| 10G | `TenGigabitEthernet1/1/1` | `Te1/1/1` | `te`, `ten` | `^TenGigabitEthernet\d+(/\d+){1,3}$` |
| 25G | `TwentyFiveGigE1/0/1` | `Twe1/0/1` | `twe` | `^TwentyFiveGigE\d+(/\d+){2}$` |
| 40G | `FortyGigabitEthernet1/1/1` | `Fo1/1/1` | `fo` | `^FortyGigabitEthernet\d+(/\d+){2}$` |
| 100G | `HundredGigE1/0/49` | `Hu1/0/49` | `hu` | `^HundredGigE\d+(/\d+){2}$` |
| Management | `GigabitEthernet0/0` (C9k, in VRF `Mgmt-vrf`), `GigabitEthernet0` (ISR4k `Mgmt-intf`) | `Gi0/0` | `gi0/0` | n/a |
| SVI | `Vlan10` | `Vl10` | `vl`, `vlan 10`, `int vlan10` | `^Vlan\d{1,4}$` |
| Loopback | `Loopback0` | `Lo0` | `lo` | `^Loopback\d+$` |
| Port-channel | `Port-channel1` | `Po1` | `po`, `port-channel 1` | `^Port-channel\d+(\.\d+)?$` |
| Sub-interface | `GigabitEthernet0/0/0.100` | `Gi0/0/0.100` | as the parent + `.N` | `^\S+\.\d+$` |
| Tunnel | `Tunnel0` | `Tu0` | `tu` | `^Tunnel\d+$` |
| Null | `Null0` | `Nu0` | `nu` (`null 0`) | `^Null0$` |
| Serial (IOS) | `Serial0/0/0`, `Serial0/1/0:0` | `Se0/0/0` | `s`, `se` | `^Serial\d+(/\d+){1,2}(:\d+)?(\.\d+)?$` |
| Dialer / Virtual-Template / Virtual-Access | `Dialer1`, `Virtual-Template1`, `Virtual-Access2` | `Di1`, `Vt1`, `Vi2` | `di`, `virtual-t` | |
| BDI (ASR/ISR XE) | `BDI100` | `BD100` | `bdi` | `^BDI\d+$` |
| App/AppGig (C9k) | `AppGigabitEthernet1/0/1` | `Ap1/0/1` | `ap` | `^AppGigabitEthernet\d+/\d+/\d+$` |

**Notes** (all `[unverified, from memory]` except where the ntc tag is given):
- **Catalyst numbering** is `switch/module/port`: front ports are `/0/`, uplink module ports are `/1/` (`Te1/1/1`). Stack member 2 is `Gi2/0/x`. ISR/ASR numbering is `slot/subslot/port` (`Gi0/0/0`).
- **Short forms differ between tables:**
  - **Two-letter + number:** `show ip interface brief` prints full names [N1]. `show mac address-table` [N5][N6], `show lldp neighbors` [N18] and `show interfaces status` [N10] use two-letter forms (`Gi1/0/7`, `Te3/1/2`, `Po1`, `Vl1`).
  - **Three letters + space:** `show cdp neighbors` uses `Gig 1/0/1`, `Ten 1/1/3`, `Fas 0/0` [N16][N17].
  - **ARP and route tables** use full names [N2][N7].
  - **Autocomplete must normalize all three.** A canonicalizer should map `^(Gig|Gi|G)\s?` to `GigabitEthernet`, and likewise for the other types.
- **Ranges:** `interface range Gi1/0/1 - 24 , Gi1/0/48`. Spaces around `-` are required on older IOS. Macros: `define interface-range`.
- **Accepted abbreviations** are any unique prefix of the type keyword, so `g1/0/1` works. Some short forms are ambiguous on platforms with several types, for example `t` on mGig switches (`TwentyFiveGigE`, `TwoGigabitEthernet`, `TenGigabitEthernet`, `Tunnel`). The device answers those with `% Ambiguous command` or with the caret.

## 10. Simulator and guard fit

The current simulator, measured against real IOS-XE 17.9 on a C9300 (see `packages/simulator/src/shell.ts`, `render.ts` and `state.ts`):

**Prompts and modes**
1. **No user EXEC (`core-sw1>`).** Sessions start at `#`, and `enable` is a no-op. Add an `exec-user` level: start at `>` when the account lacks priv 15, have `enable` prompt `Password:`, and add `disable`. Most user-level commands should return the caret error.
2. **Missing modes:** `config-line`, `config-ext-nacl`, `config-std-nacl`, `config-route-map`, `config-router-af`, `config-if-range`, `config-subif`, `config-vrf` and `config-archive`. Recommended Mode names: `'exec-user' | 'exec' | 'config' | 'config-if' | 'config-if-range' | 'config-subif' | 'config-router' | 'config-router-af' | 'config-line' | 'config-vlan' | 'config-ext-nacl' | 'config-std-nacl' | 'config-route-map' | 'config-vrf' | 'config-vrf-af' | 'config-archive'`. The prompt for each is `<host>(<mode>)#`.
3. **`exit` from a sub-mode goes to `(config)#`**, and from `config-router-af` it goes to `(config-router)#`. IOS also implicitly leaves a sub-mode when a global command is typed there (for example `vlan 20` typed in `config-if` moves you to `config-vlan`) `[unverified, from memory]`.
4. **`%SYS-5-CONFIG_I` only on `end`.** The `end` handler logs `%SYS-5-CONFIG_I: Configured from console by admin on vty0`. Ctrl-Z, Ctrl-C and `exit` from `(config)#` do not log anything. On the real device all of these log the message, with the client IP in parentheses (`... on vty0 (10.10.10.50)`) and the logged-in user rather than a hard-coded `admin`.
4a. **Config mode is lenient.** An unparsable config line is silently stored in `extraConfig` and echoed into `show running-config`. Real IOS rejects it with the caret and `% Invalid input detected at '^' marker.`, so a typo never lands in the config. This hides agent mistakes in E2E tests.

**Errors and help**
5. **Unknown first word in exec should attempt an implicit telnet** (`Translating "foo"...` then `% Unknown command or computer name, or unable to find computer address`) rather than show the caret. In config mode the caret is right.
6. **Ambiguous** (`% Ambiguous command:  "..."`) and **incomplete** errors match. `% Type "show ?" for a list of subcommands` for a bare `show` is missing `[unverified, from memory]`.
7. **Prefix priority.** `engine.ts` `match()` prefers an exact word and otherwise needs a unique prefix. `sh`, `wr`, `u all` and `conf t` resolve today only because the exec vocabulary is small. Adding real IOS exec words (`shell`, `systat`, `write` vs `where`, `undelete`) would make them ambiguous in the simulator but not on IOS, which gives priority keywords precedence. Add a per-mode priority table.
7a. **Caret position.** `error()` puts the caret at `promptLen + tokenOffset`, the start of the bad token. IOS points at the first character that failed (`intrface` gives column 20, not 17; see section 3). Separately, `withIface()` hard-codes a 10-space caret (`' '.repeat(10)`), which is wrong for any prompt.
7b. **Non-IOS error strings.** `% Invalid input`, `% Invalid interface`, `% Invalid input detected` (with no marker sentence), `% Invalid pipe "x"` and `% Invalid regular expression` are simulator inventions. IOS answers a bad argument or pipe keyword with the caret plus `% Invalid input detected at '^' marker.`.
8. **`?` output format.** The `help()` function pads every keyword to a fixed 22 columns. IOS pads to the longest keyword in the list plus 2 `[unverified, from memory]`. `<cr>` prints as a bare `  <cr>`; IOS-XE prints `  <cr>               <cr>`. Inline `co?` joins the matches with two spaces, which matches [S2]. An unknown prefix gives `% Unrecognized command`, which IOS also uses `[unverified, from memory]`.
8a. **Tab** appends the completed word plus a trailing space, and does nothing when the prefix is ambiguous. This matches IOS.

**Pager and control keys**
9. **Pager** (`shell.ts` `pageKey()`): it writes ` --More-- `, then on a key press sends BS x 10, 10 spaces and BS x 10. Space gives a page, Enter gives a line, and any other key quits. Ctrl-C quits with CRLF. All of this matches IOS behavior as remembered (section 2).
10. **Keys during a running command.** While a command is busy (ping, traceroute), all input is queued in `this.queue`, so neither Ctrl-C nor Ctrl-^ (0x1E) can abort it. Add a Ctrl-^ handler that aborts ping/traceroute (both already print `Type escape sequence to abort.`). Ctrl-C at an idle prompt prints `^C` and drops to exec, which is fine.
10a. **Missing editing keys.** Only Backspace, Ctrl-C, Ctrl-Z, Ctrl-U, Tab, `?` and Up/Down are handled. Ctrl-A/E/B/F, Ctrl-W, Ctrl-K, Ctrl-P/N, Ctrl-R/L and Left/Right are ignored, and Ctrl-U erases with `\b \b` per character. Ctrl-W and Ctrl-A/E matter most for Hopline's line editing tests.

**Config model and dangerous prompts**
11. **`reload`** should print `System configuration has been modified. Save? [yes/no]:` when running differs from startup (track a `dirty` flag cleared by `write memory`), then `Proceed with reload? [confirm]`. Add `reload in N` / `reload at` / `reload cancel`, using the [S4] strings.
12. **`write erase`** prompt matches [S7]. Add `erase startup-config` with the same prompt. `copy running-config startup-config` already prints `Destination filename [startup-config]?`, but it prints everything at once instead of waiting for Enter.
13. **Add `archive`, `show archive`, `configure replace <file> [list|force|time N]`, `configure confirm`, `configure revert now|timer` and `configure terminal revert timer N`.** Use the [S1] prompt `Enter Y if you are sure you want to proceed. ? [no]:` and the `Total number of passes: 1` / `Rollback Done` messages. This is high-value for demoing safe-change workflows.
14. **`show startup-config` currently returns the running config.** It should return the last-saved snapshot.

**Show-command layouts**
15. **`show ip bgp summary`:** the header is right, but the rows are misaligned. The simulator pads `AS` to 10 after `'4 '`, so the AS column ends at 27, while the header (and real output) ends at 29. MsgRcvd/MsgSent/TblVer shift the same way. Use the widths from section 6: `pad(ip,16) + '4' + lpad(as,13) + ' ' + lpad(rcv,7) + ' ' + lpad(sent,7) + ' ' + lpad(tblver,8) + '    0    0 ' + pad(updown,8) + (est ? lpad(pfx,9) : '  ' + state)`. The PfxRcd count is also left-aligned right after Up/Down (`pad(uptime,9) + state`), where IOS right-aligns it to end at column 82. Also add the memory lines, and use `Idle (Admin)` for `neighbor shutdown`.
16. **`show ip route`:** the legend is the old short form (5 lines, missing N1/N2/E1/E2/IS-IS/`+`/`%`). It needs the parent lines `      10.0.0.0/8 is variably subnetted, N subnets, M masks`, and the static default should be `S*    0.0.0.0/0 [1/0] via 10.0.0.6`. Ensure the BGP lines use the 9-column code field and a real-format age (`5w6d`). `% Network not in table` matches.
17. **`show cdp neighbors` reuses the LLDP renderer.** It needs the CDP legend (3 lines), the `Local Intrfce`/`Holdtme`/`Platform` columns, `Gig 1/0/1` naming, wrapped long device IDs, the `Total cdp entries displayed : N` footer, and **no** non-Cisco neighbors (dist-eos1 and isp-r2 do not run CDP).
18. **`show lldp neighbors`:** the legend is missing its third line, `    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other`. The column widths already match [N18]. Hide neighbors on admin-down ports (isp-r2 on Gi1/0/2). Capability is hard-coded `R,B` for every neighbor.
19. **`show logging`:** the header is too thin. Add the `Console/Monitor/Buffer/Trap logging` block and the `Log Buffer (N bytes):` blank line, as in the sample.
20. **`show version`:** line 1 should be zero-padded (`Version 17.09.04a`). Add the `Compiled` line, the license table, the `Last reload reason:` line, the base-MAC/serial block and the `Mode` column in the switch table. The current `System returned to ROM by Reload Command` is fine.
21. **`show ip arp`:** right-align the Age value. The header and columns are a sources conflict ([N2] vs memory), so do not change them before checking on a real 17.x box.
22. **`show ip interface brief`:** matches the 23-column Catalyst variant. The Method column should be `NVRAM` for addresses in startup and `manual` for addresses typed this session (the simulator uses `manual`). Include `Vlan1` (`administratively down`) and `GigabitEthernet0/0`.
23. **`show mac address-table`:** add the `All ... STATIC CPU` rows and the SVI `STATIC Vl<N>` rows. Otherwise the layout matches.
24. **Missing commands worth adding:** `show ip ospf neighbor`, `show interfaces trunk`, `show etherchannel summary`, `show spanning-tree`, `show ip access-lists`, `show route-map`, `show ip prefix-list`, `show archive`, `show switch`, `show inventory`, `show ip route vrf X`, `show vrf brief`, `show running-config | section`, `show standby brief`, `show processes cpu sorted` and `show cdp neighbors detail`.
25. **Pipes.** The engine's shared pipe set includes `grep`, `json`, `no-more`, `match` and `except`, none of which exist on IOS. With `ios`, they should produce the caret under the pipe word. Add `| redirect`, `| tee` and `| append` (blocked by the guard; the simulator could answer `%Error opening ...`).

**Guard deltas** (written against the Phase 2 guard rules; since 0.4 the deny-list is part of each platform's tree in `packages/cli-model/src/trees/`):
- **`iosxe: ios` aliasing is acceptable** because the blocked list already includes XE words (`install`, `guestshell`, `app-hosting`, `request`, `software`). Still add `factory-reset` and `switch`, consider moving `debug` and `monitor` to blocked, and add the `blockedPairs` from section 7.
- **`copy`** was blocked outright when this was written. Since 0.4 `copy running-config startup-config` is a `config` command (it needs approval) and every other `copy` is blocked (`packages/cli-model/src/trees/ios.ts`).
- **`pipesAllowed` is right for IOS.** `pipesBlocked` should keep `format` (XE ODM). `export` does not exist on IOS, but it is harmless to keep.
- **Confirm responses** (`y`, Enter, `yes`) must be bound to the command that triggered them (see section 7).

## Sources

Cisco (vendor):
- [S1] https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/config-mgmt/configuration/xe-16/config-mgmt-xe-16-book/cm-config-rollback.html: Configuration Replace and Configuration Rollback (IOS-XE 16).
- [S2] https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html: Using the Cisco IOS Command-Line Interface (IOS-XE 16 fundamentals).
- [S3] https://www.cisco.com/c/ja_jp/td/docs/Sanity/anubhkum/b_consolidated_3850_3e_cr/b_consolidated_3850_3e_cr_chapter_01.html: Catalyst 3850 (IOS-XE 3E) "Using the Command-Line Interface" (English text).
- [S4] https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/reload.htm: `reload` command reference.
- [S5] https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/hostname.htm: `hostname` command reference.
- [S9] https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/irg-cr-book/bgp-s1.html: BGP command reference, `show ip bgp ...` (only the ipv4 multicast summary sample and the field descriptions were reachable; the page was truncated).
- [S10] https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/222280-upgrading-catalyst-9300-switches.html: Upgrading Catalyst 9300 switches (install mode).

Secondary (non-vendor or community):
- [S6] https://blog.ipspace.net/2007/03/stop-extended-ping-or-traceroute/: Ctrl-^ escape and `terminal escape-character`.
- [S7] https://courses.cs.ut.ee/all/MTAT.08.003/mat/1int/course/module2/2.2.3.1/2.2.3.1.html: Cisco NetAcad course mirror with reload/save/erase prompts.
- [S8] https://community.cisco.com/kxiwq67737/attachments/kxiwq67737/5991-discussions-wan-routing-switching/371121/5/l3-sw-routing-table.txt: L3 switch `show ip route` capture posted on Cisco Community.

Secondary (ntc-templates raw captures, fetched byte-exact from `https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/`):
- [N1] `show_ip_interface_brief/cisco_ios_show_ip_interface_brief.raw`
- [N2] `show_ip_arp/cisco_ios_show_ip_arp.raw`
- [N3] `show_ip_ospf_neighbor/cisco_ios_show_ip_ospf_neighbor.raw` (also `four_neighbors.raw`)
- [N4] `show_ip_route/cisco_ios_show_ip_route.raw`
- [N5] `show_mac-address-table/cisco_ios_show_mac-address-table6.raw`
- [N6] `show_mac-address-table/cisco_ios_show_mac-address-table13.raw` (also `table`, `2`, `4`, `5`, `12` for the older layouts)
- [N7] `show_ip_route/cisco_ios_show_ip_route_vrf.raw`
- [N8] `show_ip_bgp_summary/cisco_ios_show_ip_bgp_summary.raw`
- [N9] `show_ip_bgp_summary/cisco_ios_show_ip_bgp_summary_all.raw`
- [N10] `show_interfaces_status/cisco_ios_show_interfaces_status.raw`
- [N11] `show_vlan/cisco_ios_show_vlan.raw`
- [N12] `show_vrf/cisco_ios_show_vrf.raw`
- [N13] `show_archive/cisco_ios_show_archive.raw`
- [N14] `show_ip_access-lists/cisco_ios_show_ip_access-lists.raw`
- [N15] `show_route-map/cisco_ios_show_route-map.raw`
- [N16] `show_cdp_neighbors/cisco_ios_show_cdp_neighbors_2.raw` (also `_4`)
- [N17] `show_cdp_neighbors/cisco_ios_show_cdp_neighbors.raw`
- [N18] `show_lldp_neighbors/cisco_ios_show_lldp_neighbors.raw`
- [N19] `show_lldp_neighbors/cisco_ios_show_lldp_neighbors2.raw`
- [N20] `show_lldp_neighbors/cisco_ios_show_lldp_neighbors3.raw`
- [N21] `show_version/cisco_ios_show_version4.raw` (C9500, 16.9.3)
- [N22] `show_version/cisco_ios_show_version5.raw` (C9500, 16.12.4)
- [N23] `show_version/cisco_ios_show_version1.raw` (WS-C3850, 03.06.05E)
- [N24] `show_logging/cisco_ios_show_logging_1.raw`
- [N25] `show_logging/cisco_ios_show_logging_2.raw`
- [N26] `show_logging/cisco_ios_show_logging_3.raw`
- [N27] `show_running-config_partition_access-list/cisco_ios_show_running-config_partition_access-list.raw`

Fetched but not cited (no usable content reached): the IOS-XE IP routing protocol-independent command reference `iri-cr-s1.html` (truncated before `show ip route`). The 9300 17.9 CLI chapter URL returned 404, and a community revert-timer thread returned 403.
