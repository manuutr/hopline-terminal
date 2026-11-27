# Arista EOS CLI reference for Hopline

> **Scope:** Arista EOS 4.2x to 4.3x on fixed and modular DCS switches, cEOS and vEOS. The reference box is the simulator fixture `dist-eos1` (DCS-7050SX3-48YC8, EOS 4.31.2F, AS 65010). Researched 2026-11.
>
> **Source access note:** arista.com blocks automated clients. Every direct fetch returned HTTP 406 or a JS "Client Challenge" page. All Arista manual pages below were therefore read through Internet Archive snapshots taken in 2025 and 2026. The snapshots cover the **EOS 4.36.0F/4.36.1F User Manual**, the current manual at that time. The CLI chapters are largely the same as in 4.2x/4.3x, but some samples in that manual are much older (the `show version` sample is from 4.13).
>
> **Confidence legend**
> - `[A-xxx]` is verified on a fetched Arista manual page (link in Sources). This is a primary source.
> - `[ntc]` is a raw capture from the networktocode/ntc-templates test corpus, a **secondary source** (real device output of mixed EOS versions).
> - `[lib:xxx]` is a string hard-coded in an automation library or test fixture (ANTA/asynceapi by Arista, scrapli, netmiko, Exscript, ansible arista.eos, pyntc, netman). This is a **secondary source** and good evidence for exact wire strings.
> - `[unverified, from memory]` was not confirmed this session. Treat it as a strong guess and verify against a real box before relying on it.

[A-CLI]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-command-line-interface-cli
[A-SESS]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-configuration-sessions-overview
[A-CFGSESS]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-configure-session
[A-SMC]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-session-management-commands
[A-DISP]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-managing-display-attributes
[A-OSPF]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-open-shortest-path-first-version-2
[A-LLDP]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-link-layer-discovery-protocol
[A-DT]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-data-transfer
[A-ETH]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-ethernet-ports
[A-LOG]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-system-event-logging
[A-REC]: http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-recovery-procedures
[ntc]: https://github.com/networktocode/ntc-templates/tree/master/tests/arista_eos
[lib:anta]: https://raw.githubusercontent.com/aristanetworks/anta/main/anta/constants.py
[lib:asynceapi]: https://raw.githubusercontent.com/aristanetworks/anta/main/asynceapi/config_session.py
[lib:scrapli]: https://raw.githubusercontent.com/scrapli/scrapli_definitions/main/definitions/arista_eos.yaml
[lib:netmiko]: https://raw.githubusercontent.com/ktbyers/netmiko/develop/netmiko/arista/arista.py
[lib:exscript]: https://raw.githubusercontent.com/knipknap/exscript/master/Exscript/protocols/drivers/eos.py
[lib:ansible]: https://raw.githubusercontent.com/ansible-collections/arista.eos/main/plugins/terminal/eos.py
[lib:pyntc]: https://raw.githubusercontent.com/networktocode/pyntc/develop/tests/unit/test_devices/test_eos_ssh_device.py
[lib:netman]: https://raw.githubusercontent.com/internap/netman/master/tests/adapters/switches/arista_test.py

## 1. Prompts

### Default prompt format
- The default prompt is `%H%P`: the full hostname followed by the extended command mode. `no prompt` restores it. `%h` is the "host name up to the first" dot (the manual's sentence ends there), `%p` is the short mode, `%r`/`%R` is the redundancy status on modular systems, and `%D` is the date. [A-DISP]
- **Dotted hostnames are not truncated by default.** The manual's own example is `host-name.dut103(config)#` for the default `%H%P`. [A-DISP] Truncation at the first dot happens only if the operator configures `prompt %h%P`.
- Dashes are kept as-is (`dist-eos1#`).
- Hostname length limit: `[unverified, from memory]`. The hostname is limited to 64 characters (one DNS label each). scrapli's prompt regex assumes 1–63 prompt characters before the mode. [lib:scrapli]
- There is **no space after `#`/`>`** in the default prompt. The docs write `switch# ` with a space for readability, but the library regexes allow an optional one (`(?:>|#) ?$`). [lib:ansible] [lib:exscript]
- Modular/SSO systems: netmiko strips a trailing `(s1)`/`(s2)` supervisor suffix from the base prompt, for example `switch(s1)#`. [lib:netmiko]

### Prompts per mode
| Mode | Prompt (`dist-eos1`) | Source |
|---|---|---|
| EXEC (unprivileged) | `dist-eos1>` | [A-CLI] (`switch>`) |
| Privileged EXEC | `dist-eos1#` | [A-CLI] |
| Global config | `dist-eos1(config)#` | [A-CLI] |
| Interface (Ethernet) | `dist-eos1(config-if-Et1)#` | [A-CLI] (`switch(config-if-Et24)#`) |
| Interface range | `dist-eos1(config-if-Et10-11)#`, `dist-eos1(config-if-Et2,3,4)#` | `Et2,3,4` form seen in [A-DT] (`switch(config-if-Et2,3,4)#`); the range form is `[unverified, from memory]` |
| Interface (loopback) | `dist-eos1(config-if-Lo0)#` | [A-DT] shows `switch(config-if-Lo2)#` |
| Interface (SVI / Po / Mgmt) | `(config-if-Vl100)#`, `(config-if-Po10)#`, `(config-if-Ma1)#` | `[unverified, from memory]`; follows the short-name pattern |
| Router BGP | `dist-eos1(config-router-bgp)#` | [A-CLI] |
| BGP address-family | `dist-eos1(config-router-bgp-af)#` | `[unverified, from memory]` |
| BGP VRF | `dist-eos1(config-router-bgp-vrf-MGMT)#` | `[unverified, from memory]` |
| Router OSPF | `dist-eos1(config-router-ospf)#` | [A-CLI] [A-OSPF] |
| OSPF in VRF | `(config-router-ospf-vrf-red)#` | [A-OSPF] |
| OSPFv3 | `(config-router-ospf3)#` | [A-CLI] |
| ACL | `dist-eos1(config-acl-master-list)#` | [A-CLI] |
| VLAN | `dist-eos1(config-vlan-100)#` | `[unverified, from memory]` |
| VRF definition | `dist-eos1(config-vrf-MGMT)#` (`vrf instance MGMT`) | `[unverified, from memory]` |
| Route-map | `dist-eos1(config-route-map-RM-SPINE-IN)#` | `[unverified, from memory]` |
| Management console | `(config-mgmt-console)#` | [A-SMC] |
| Event handler | `(config-event-eth_4)#`, `(config-handler-Eth5)#` | [A-CLI] (both spellings appear) |
| Daemon | `(config-daemon-process1)#` | [A-CLI] |
| VM | `(config-vm-foo)#` | [A-CLI] |
| **Config session** | `dist-eos1(config-s-chg1)#` | [A-SMC] (`switch(config-s-MySession)#`, `switch(config-s-sess-1)#`) |
| Session + sub-mode | `dist-eos1(config-s-chg1-if-Et1)#` | `[unverified, from memory]` |
| Bash | `[admin@dist-eos1 ~]$` | [A-CLI]; banner `Arista Networks EOS shell` |
| Aboot | `Aboot#` | [A-REC] |

**Config-session prompt truncation.** The manual says "the prompt will change to show the first six characters of the session name". [A-SESS] [A-CFGSESS] The same manual also shows `switch(config-s-MySession)#`, which has nine characters. [A-SMC] Treat the 6-character rule as uncertain. A safe recognition regex is `\(config-s-[^)]+\)#`.

**VRF routing context.** `cli vrf MGMT` (older: `routing-context vrf MGMT`) changes the prompt to `dist-eos1(vrf:MGMT)#`. `[unverified, from memory]`

**Login landing mode.** A user with `privilege 15` lands directly at `#` only when `aaa authorization exec default local` (or a TACACS+ equivalent) is configured. Otherwise the user lands at `>` and needs `enable`. `[unverified, from memory]` The enable password prompt is `Password:`. [A-CLI] [lib:scrapli]

Login banner sequence, verbatim from the manual: [A-DISP]
```
This is a login banner
switch login: john
Password:
Last login: Mon Jan 14 09:24:36 2013 from aristanetworks.com
This is an motd banner
switch>
```
`exit` from EXEC or privileged EXEC ends the session (`login:` on the console). [A-CLI]

## 2. Paging

- **Pager prompt string:** ` --More-- `, with one leading and one trailing space, in reverse video. `[unverified, from memory]` No fetched Arista page showed it. The manual only says the output "pauses after each screen of output, prompting the user to continue". [A-CLI]
- **Keys:** Space shows the next page, Enter the next line, and `q` (or Ctrl-C) quits. The EOS pager behaves like `less` (`/pattern` search works on recent releases). `[unverified, from memory]`
- **Self-erase:** after a key press the pager prompt is erased with CR plus spaces plus CR (not a backspace run), and output continues on the same line. `[unverified, from memory]`
- **Default:** "By default, all console sessions have pagination disabled." SSH sessions paginate automatically based on the window size, and "pagination settings may also be overridden when you adjust the size of the SSH terminal window". [A-CLI]

| Command | Effect | Source |
|---|---|---|
| `terminal length 0` (EXEC) | Disables paging for this session only. Prints `Pagination disabled.` | [A-CLI]; netmiko waits for `Pagination disabled` [lib:netmiko] |
| `terminal length 10` | Prints `Pagination set to 10 lines.` (range 0–32767) | [A-CLI] |
| `no terminal length` / `default terminal length` | Back to automatic, window-size-based paging | [A-CLI] |
| `terminal length 0` in **global config** | Persistent; written to running-config | [A-CLI] |
| `show ... \| no-more` | Disables paging for one command | `[unverified, from memory]` |
| `terminal width 32767` | Output width. netmiko uses `terminal width 511` and waits for `Width set to` | [lib:scrapli] [lib:netmiko] |
| `terminal dont-ask` | Suppresses confirm prompts in this session (Exscript sends it at login) | [lib:exscript] |

Transcript from the manual: [A-CLI]
```
switch# terminal length 10
Pagination set to 10 lines.
switch# configure
switch(config)# terminal length 0
Pagination disabled.
```

## 3. Help and completion

### `?` help
- `?` alone lists every command at this level, two-space indented, as `name` plus a padded description: [A-CLI]
```
switchName> ?
  clear       Reset functions
  connect     Open a terminal connection
  default     Set a command to its defaults
  disable     Turn off privileged commands
  enable      Turn on privileged commands
  exit        Exit from the EXEC
  logout      Exit from the EXEC
  no          Negate a command or set its defaults
  ping        Send echo messages
  show        Show running system information
  ssh         Open ssh connection
  tcpdump     Monitor packets with tcpdump
  telnet      Open a telnet connection
  terminal    Configure the terminal
  traceroute  Trace route to destination
  watch       Execute a command repeatedly
  who         Display information about terminal lines
  zerotouch   ZeroTouch configuration
```
- **Prefix help (`di?`, no space)** prints matching keywords on **one line**, separated by two spaces, with **no descriptions**: [A-CLI]
```
switch# di?
diff  dir  disable
```
- **Argument help (`ping ?`, after a space)** lists keywords and arguments with descriptions. Placeholders are upper-case (`WORD`, `A.B.C.D`) and ranges look like `<1-4>`: [A-CLI]
```
switch> ping ?
WORD  Ping destination address or hostname
ip    IPv4 echo
ipv6  IPv6 echo
mpls  Send echo messages for LSP
vrf   Ping in a VRF
```
  In this sample the manual drops the two-space indent. The OSPF and VM samples keep it, and show `<cr>` when the command can run as typed: [A-OSPF] [A-CLI]
```
(config-router-ospf-vrf-red)#dn-bit-ignore ?
  lsa   Disable DN-bit check only for Type-5 and Type-7 LSAs in non-default VRFs
  <cr>
switch(config-vm-foo)# virtual-nic ?
    <1-4>         Virtual NIC Id
```
- After the help listing, the prompt and the partially typed line are redrawn, and the `?` itself is not echoed into the buffer. `[unverified, from memory]`
- Aliases appear in help as `*alias_name=command_name`. [A-CLI]
- To type a literal `?` (for example in an AS-path regex), precede it with **Ctrl-V**. [A-CLI]

### Tab completion
Tab completes a unique keyword prefix and appends a space. When the prefix is ambiguous, the terminal beeps; a second Tab lists the candidates. Tab never completes arguments such as interface numbers. `[unverified, from memory]`

### Abbreviation
- "Command keywords are not case-sensitive. The CLI also accepts truncated keywords that uniquely correspond to one command." [A-CLI]
- `con` is ambiguous (`configure`, `connect`), while `conf` and `config` resolve to `configure`. `en` resolves to `enable` and `dis` to `disable`. [A-CLI]
- Interface names abbreviate: `interface Et24`, `show int et1,2 interactions`, `show interfaces et11/1,11/3`. [A-CLI] [A-ETH]
- `configure` alone enters config mode; `configure terminal` is accepted too. [A-CLI]
- Config mode inherits parent-mode commands, so `ping` and `show` run in `(config)#` without `do`. [A-CLI] `do <cmd>` also works. `[unverified, from memory]`
- Changing mode from a child mode is allowed. For example, `ip access-list X` typed inside `(config-if-Et1)#` jumps to `(config-acl-X)#`. [A-CLI]

### Error messages (exact strings)
EOS **does not print a caret line**. Instead it names the failing token by its **0-based index** in the line and quotes it.

| Case | Exact text on the CLI | Source |
|---|---|---|
| Unknown keyword or bad argument | `% Invalid input (at token 1: 'bogus')` | Over SSH: [lib:pyntc] `"% Invalid input (at token 1: 'bogus')"`; eAPI: [lib:netman] `Invalid input (at token 2: '5001')`, [lib:anta] `Invalid input (at token 2: 'trident')` |
| First token unknown | `% Invalid input (at token 0: 'typocommand')` | cvprac/ansible-cvp fixtures (found via GitHub code search; files not fetched), consistent with [lib:netman] `(at token 0: 'show')` |
| Command exists but needs privileged mode | `% Invalid input (privileged mode required)` | GitHub code-search hits only; `[unverified]` |
| Ambiguous | `% Ambiguous command` | [A-CLI] (`switch# con` then `% Ambiguous command`); [lib:scrapli] |
| Incomplete | `% Incomplete command` (CLI); eAPI form `Incomplete command (at token 4: 'drops')` | [lib:scrapli] `'% Incomplete command'`; [lib:anta]; the manual's alias section quotes "% incomplete command" [A-CLI] |
| Older releases (4.1x) | plain `% Invalid input` with no token info | [lib:pyntc] also matches the bare form |
| Others | `% Unavailable command`, `% Cannot commit`, `% Duplicate sequence number`, `% Error ...`, `% Authorization denied` | [lib:scrapli]; the last is `[unverified]` |

Whether `% Ambiguous command` and `% Incomplete command` also carry an `(at token N: '...')` suffix on the interactive CLI in 4.2x+ is **uncertain**. The eAPI incomplete form does carry it. The safest recognizer is `^% (Invalid input|Ambiguous command|Incomplete command)\b.*$`.

Recommended transcripts for `dist-eos1` (format per sources above, token indexes computed by hand):
```
dist-eos1#show ip bgp sumary
% Invalid input (at token 3: 'sumary')
dist-eos1#show interfaces Ethernet99 status
% Invalid input (at token 2: 'Ethernet99')
dist-eos1#con
% Ambiguous command
dist-eos1#show ip
% Incomplete command
dist-eos1#
```
Notes:
- The error appears on its own line directly under the echoed input, and there is no blank line before the next prompt. `[unverified, from memory]`
- Token counting is 0-based over whitespace-split words (`show`=0). In the second example the interface token is index 2. [lib:netman] shows `Invalid input (at token 1: 'Invalid_Ethernet')` for `interface Invalid_Ethernet`.

## 4. Control characters

| Key | Behavior | Source |
|---|---|---|
| Ctrl-B / Left, Ctrl-F / Right | Move cursor one character | [A-CLI] |
| Ctrl-A / Ctrl-E | Beginning / end of line | [A-CLI] |
| Esc-B / Esc-F | Back / forward one word | [A-CLI] |
| Ctrl-P / Up, Ctrl-N / Down | History (buffer holds the **last 20** commands; `show history` lists them) | [A-CLI] |
| Ctrl-Z | From any config mode back to privileged EXEC (same as `end`). Shown as `<Ctrl-z>` / `^Z` in the docs | [A-CLI] |
| Ctrl-C | Aborts the current line (new prompt, mode unchanged). Interrupts running commands: `ping`, `traceroute`, `watch`, `show logging follow`, `tcpdump`, `bash` children | `[unverified, from memory]` |
| Ctrl-U | Deletes the whole line | `[unverified, from memory]` |
| Ctrl-W | Deletes the word before the cursor | `[unverified, from memory]` |
| Ctrl-K | Deletes to end of line | `[unverified, from memory]` |
| Ctrl-D | Deletes the character under the cursor, or logs out on an empty line in bash | Bash exit via Ctrl-D: [A-CLI]; CLI behavior `[unverified]` |
| Ctrl-R | Reverse history search (readline-style) | `[unverified, from memory]` |
| Ctrl-V | Literal next character (type `?` in regexes) | [A-CLI] |
| Ctrl-] | Leaves `attach vm` console | [A-CLI] |
| Ctrl-Shift-6 | **Not used on EOS** (no IOS-style break sequence); use Ctrl-C | `[unverified, from memory]` |

## 5. Config model

### `configure` (terminal): immediate apply
- `configure` / `configure terminal` applies each line to running-config **as it is entered**, like IOS. [A-CLI]
- **Group-change modes** are the exception. ACL and MST modes (also `[unverified]` prefix-list/role modes) store changes until you leave the mode via `exit`, `end` or a mode-changing command. `abort` discards pending changes in that mode. [A-CLI]
- In config mode, `show active` (and `show active all`) prints only the running-config lines for the current mode. [A-CLI]

### Saving
- `write` (also `write memory`) and `copy running-config startup-config` are equivalent. [A-CLI]
- The manual shows `copy running-config startup-config` returning straight to `switch#` with no output. [A-CLI] Real 4.2x+ boxes print `Copy completed successfully.` `[unverified, from memory]`; the simulator prints that today.
- `show startup-config` begins with `! Command: show startup-config` / `! Startup-config last modified at  Wed Feb 19 08:34:31 2014 by admin` (two spaces after `at`). [A-CLI]

### Configuration sessions (candidate config)
- `configure session [name] [abort | commit | description TEXT]` runs from privileged EXEC. [A-SMC]
- It copies a snapshot of running-config into the session; you edit, then `commit` or `abort`. "Committing a configuration session replaces running-config with the session configuration". Any changes made to running-config since the session started are **overwritten**. [A-SESS] [A-SMC]
- If no name is given, the switch generates one. The manual's example shows `sess-1`. [A-SMC] At most **five uncommitted sessions**; uncommitted sessions are discarded on reboot and time out after **24 hours**. [A-SMC] `Maximum number of pending sessions has been reached` is the error at the limit. [lib:ansible]
- `exit` leaves the session pending; `configure session <name>` re-enters it. Several CLIs may share one named session. [A-SESS]
- In-session commands: `commit`, `abort`, `rollback clean-config` (reset the session to factory defaults), `show session-config`. [A-SESS]
- Inspection commands: `show session-config diffs` (inside the session), `show session-config named <name> diffs` (from EXEC), and `show configuration sessions [detail]`. [lib:asynceapi] The detail output keys are `maxSavedSessions`, `maxOpenSessions`, `sessions.<name>.state` (`pending`/`completed`) and `commitUser`. [lib:asynceapi]
- `no configure session <name>` deletes a session. `service configuration session max completed|pending N` sets the limits. [A-SESS]

**Commit timer (confirmed commit):**
- `commit timer hh:mm:ss` inside the session commits **and** arms an automatic rollback. The example returns to EXEC: [A-SMC]
```
switch(config-s-MySession)# commit timer 01:00:00
switch#
```
- "A second commit action must be made to confirm the config session before the timer expires; otherwise the config-session is automatically aborted." [lib:asynceapi] Confirm with `configure session <name> commit` from EXEC, or by re-entering the session and typing `commit`. [lib:asynceapi] uses `configure session <name> commit [timer hh:mm:ss]` as one-liners.

**Diff output** (`show session-config diffs`) is a unified diff ("diff-patch format"). [lib:asynceapi] The header lines below are `[unverified, from memory]`:
```
dist-eos1(config-s-chg1)#show session-config diffs
--- system:/running-config
+++ session:/chg1-session-config
@@ -61,6 +61,7 @@
 interface Ethernet2
    description spine2
    no switchport
+   shutdown
    ip address 10.0.1.3/31
 !
 interface Ethernet10
```
The manual's own `commit` example shows the prompt staying `switch(config-s-sess-1)#` after `commit`. [A-SMC] Real boxes return to `dist-eos1#` after `commit`. `[unverified, from memory]`; the `commit timer` example above does return to `switch#`.

### Replace / checkpoints / rollback
- `configure replace <url> [ignore-errors] [md5 <sum>] [skip-checkpoint] [vrf X]` replaces running-config, **only if the file loads without errors** unless you add `ignore-errors`. Sources include `flash:`, `startup-config:`, `checkpoint:`, `clean-config:`, `http(s):`, `scp:`, `sftp:`, `terminal:` and more. Internally it runs as a config session. [A-SMC] [A-SESS] Sample output: [A-SMC]
```
switch(config)# configure replace start-config
! Preserving static routes. Use 'no ip routing delete-static-routes' to clear them.
switch#
```
- `copy <url> running-config` **merges** into running-config instead of replacing it. [A-SESS]
- `configure checkpoint save [name]` / `configure checkpoint restore <name>`; `dir checkpoint:` lists checkpoints. With no name, the switch auto-names the checkpoint (date-time-hash). [A-CLI]
- `configure replace clean-config` or `rollback clean-config` (in a session) resets to factory defaults. **Highly destructive.**
- `configure network` is deprecated; use `copy <url> running-config`. [A-CLI]
- `configure convert new-syntax` prompts `Proceed [ y/n ]` after a `WARNING!` block. [A-CLI]

### Confirm prompts (verbatim where known)
| Command | Prompt | Source |
|---|---|---|
| `reload` | `Proceed with reload? [confirm]` | `[unverified, from memory]` |
| `reload` with unsaved changes | `System configuration has been modified. Save? [yes/no/cancel/diff]:` | `[unverified, from memory]` |
| `reload now` / `reload force` | no prompt | `[unverified, from memory]` |
| `write erase` / `erase startup-config` | `Proceed with erasing startup configuration? [confirm]` | `[unverified, from memory]` |
| `configure convert new-syntax` | `Proceed [ y/n ]` | [A-CLI] |
| Some interface/hardware commands | `Do you wish to proceed with this command? [y/N]` | [A-ETH] |
| TCAM profile change | `Proceed with new profile application? [y/n]` | [A-ETH] |
| Aboot fullrecover | `All data on /mnt/flash will be erased; type "yes" and press Enter to proceed, or just press Enter to cancel:` | [A-REC] |
| `banner motd` / `comment` | `Enter TEXT message. Type 'EOF' on its own line to end.` | [A-DISP] [A-CLI] |

## 6. Show commands

| Command | Purpose | Notes |
|---|---|---|
| `show version` | Model, serial, EOS version, uptime, memory | `\| json` gives `version`, `modelName`, `serialNumber` |
| `show interfaces status` | Port, name, link, VLAN, duplex, speed, type | Accepts ranges: `show int et1-4 status` [A-ETH] |
| `show interfaces description` | Status/protocol/description per interface | [ntc] |
| `show interfaces [Et1]` | Counters, MTU, errors, rate | |
| `show interfaces counters errors` | Per-port error counters | `[unverified]` |
| `show interfaces transceiver [detail]` | Optics DOM | [ntc] |
| `show ip interface brief` | L3 interfaces, IP/mask, status, MTU | |
| `show ip interface [Et1]` | L3 detail | |
| `show ip route [vrf X] [prefix]` | RIB | `vrf all` supported |
| `show ip route summary` | Route counts per protocol | [A-OSPF] |
| `show ip bgp summary [vrf X\|all]` | BGP neighbor table | |
| `show ip bgp neighbors [ip] [advertised-routes\|received-routes\|routes]` | Peer detail and adj-RIB | |
| `show ip bgp [prefix]` | BGP RIB | |
| `show bgp evpn summary` | EVPN peers | [ntc] |
| `show ip ospf neighbor [state full] [detail]` | OSPF adjacencies | [A-OSPF] |
| `show ip ospf interface brief` | OSPF interfaces | [A-OSPF] |
| `show ip ospf database [database-summary]` | LSDB | [A-OSPF] |
| `show isis neighbors` | IS-IS adjacencies | [ntc] |
| `show mac address-table [vlan N\|interface X\|address M\|static\|dynamic]` | L2 FDB | [A-DT] |
| `show ip arp [vrf X]` / `show arp` | ARP cache | `show arp` is the 4.2x+ spelling `[unverified]` |
| `show ipv6 neighbors` | ND cache | |
| `show lldp neighbors [detail]` | LLDP neighbors | [A-LLDP] |
| `show vlan [brief\|id N]` | VLANs and access ports | [ntc] |
| `show vrf` | VRFs, RD, protocols, interfaces | [ntc] |
| `show port-channel [summary]` / `show lacp neighbor` | LAG state | [ntc] |
| `show mlag [detail]` / `show mlag config-sanity` | MLAG | [ntc] |
| `show spanning-tree [blockedports]` | STP | |
| `show vxlan vtep` / `show vxlan address-table` | VXLAN | |
| `show logging [last N\|N]` / `show logging follow` | Syslog buffer. **`follow` never terminates** | [A-LOG] |
| `show running-config [interfaces Et1\| section bgp]` / `show running-config all` | Config | `\| section` filter |
| `show startup-config` | Saved config | [A-CLI] |
| `show session-config [diffs]` / `show configuration sessions` | Sessions | [A-SESS] |
| `show active [all]` | Running config for current mode (config modes only) | [A-CLI] |
| `show environment all\|temperature\|power\|cooling` | Hardware health | [ntc] |
| `show inventory` / `show module` | Hardware | [A-SMC] [ntc] |
| `show processes top once` | CPU/memory | [ntc] |
| `show reload cause` | Last reload reason | [ntc] |
| `show users` / `show history` / `show clock` / `show uptime` | Session/system | [A-CLI] |
| `show hardware counter drop` | ASIC drops | [A-ETH] |
| `show tech-support` | Huge bundle; heavy on CPU | Allowed as read, but slow |

### 6.1 `show ip interface brief`
The 4.2x+ layout has a two-line header ("Address" floats over the MTU column), a dash rule, and an **Owner** column (for unnumbered or borrowed addresses). The header words and the rule come from [A-OSPF] (EOS 4.36 manual, `Interface IP Address Status Protocol MTU Owner` plus a dash rule), but the manual's whitespace is mangled. Column widths below are `[unverified, from memory]`. The older 4.1x/4.20 layout has no "Address" line and no Owner column, for example `Interface              IP Address         Status     Protocol         MTU` [ntc]. Status values include `up`, `down`, `adminDown` (`[unverified]`); protocol values include `up`, `down`, `lowerlayerdown`, `notpresent`. [ntc]
```
dist-eos1#show ip interface brief
                                                                                  Address
Interface         IP Address           Status       Protocol            MTU    Owner
----------------- -------------------- ------------ -------------- ----------- -------
Ethernet1         10.0.1.1/31          up           up                 1500
Ethernet2         10.0.1.3/31          down         lowerlayerdown     1500
Loopback0         10.255.0.10/32       up           up                65535
Management1       192.168.255.21/24    up           up                 1500
Vlan100           10.100.0.1/24        up           up                 1500
```
Note: Loopback MTU is 65535. [A-OSPF] [ntc] Interfaces are listed in natural order; addresses are shown in CIDR form.

### 6.2 `show interfaces status`
Header and column order are verified: `Port Name Status Vlan Duplex Speed Type Flags Encapsulation`. [A-ETH] Values verified: `connected`, `notconnect`, `disabled`, `errdisabled`, `inactive`; Vlan values `trunk`, `routed`, `in Po1`, a VLAN number; duplex/speed with an `a-` prefix when auto-negotiated (`a-full a-10G`) or fixed (`full 10G`); and `unconf`. [ntc] [A-CLI] [A-ETH] Exact column widths below are approximated from [ntc]; Flags/Encapsulation are usually blank.
```
dist-eos1#show interfaces status
Port       Name                Status       Vlan     Duplex Speed  Type            Flags Encapsulation
Et1        spine1              connected    routed   full   25G    25GBASE-SR
Et2        spine2              notconnect   routed   full   25G    25GBASE-SR
Et3                            notconnect   1        full   25G    Not Present
Et10       server-db01         connected    100      full   10G    10GBASE-SR
Et11       server-db02         connected    100      full   10G    10GBASE-SR
Et48       trunk to core-sw1   connected    trunk    full   1G     1000BASE-T
Ma1                            connected    routed   a-full a-1G   10/100/1000
```

### 6.3 `show ip bgp summary`
The 4.2x+ layout is verified from [ntc] (captures `summary2`, `summary3`, `vrf2`). The first three header lines are fixed; table rows are **indented two spaces**. The `Description` column appears only when at least one peer has a description. `State` is `Estab`, `Active`, `Idle`, `Connect`, `OpenSent`, `Idle(NoIf)`, `Idle(Admin)`. PfxRcd/PfxAcc are filled only when Estab. Up/Down is `hh:mm:ss` under 24h, then `79d05h` style.
```
dist-eos1#show ip bgp summary
BGP summary information for VRF default
Router identifier 10.255.0.10, local AS number 65010
Neighbor Status Codes: m - Under maintenance
  Description              Neighbor         V AS           MsgRcvd   MsgSent  InQ OutQ  Up/Down State   PfxRcd PfxAcc
  spine1                   10.0.1.0         4 65100          25871     23954    0    0   17d12h Estab   214    214
  spine2                   10.0.1.2         4 65100              0         0    0    0 05:02:11 Idle
```
(The `[ntc]` captures differ by one space between `V` and `AS` across versions. Copy `summary3` exactly if pixel-matching matters. The pre-4.2x layout is `BGP router identifier X, local AS number Y` / `Neighbor V AS MsgRcvd MsgSent InQ OutQ Up/Down State/PfxRcd`. [ntc])

### 6.4 `show ip ospf neighbor`
4.2x+ layout from [ntc] and [A-OSPF]. dist-eos1 runs no OSPF in the fixture; the rows below are a hypothetical underlay for illustration.
```
dist-eos1#show ip ospf neighbor
Neighbor ID     Instance VRF      Pri State                  Dead Time   Address         Interface
10.255.0.100    1        default  0   FULL                   00:00:34    10.0.1.0        Ethernet1
10.255.0.1      1        default  1   FULL/DR                00:00:31    10.10.10.1      Vlan10
```
Point-to-point neighbors show `FULL`; broadcast segments show `FULL/DR`, `FULL/BDR`, `FULL/DROTHER`. [A-OSPF] [ntc]

### 6.5 `show ip route`
Codes block verbatim for 4.3x from [ntc] (`show_ip_route5`). Each route row has a **1-space indent**, a code padded to 8 characters, then the prefix. [ntc] The `Gateway of last resort:` line is followed by the default route on its own line, or reads `Gateway of last resort is not set`. [ntc] [A-OSPF]
```
dist-eos1#show ip route

VRF: default
Codes: C - connected, S - static, K - kernel,
       O - OSPF, IA - OSPF inter area, E1 - OSPF external type 1,
       E2 - OSPF external type 2, N1 - OSPF NSSA external type 1,
       N2 - OSPF NSSA external type2, B - Other BGP Routes,
       B I - iBGP, B E - eBGP, R - RIP, I L1 - IS-IS level 1,
       I L2 - IS-IS level 2, O3 - OSPFv3, A B - BGP Aggregate,
       A O - OSPF Summary, NG - Nexthop Group Static Route,
       V - VXLAN Control Service, M - Martian,
       DH - DHCP client installed default route,
       DP - Dynamic Policy Route, L - VRF Leaked,
       G  - gRIBI, RC - Route Cache Route

Gateway of last resort:
 B E      0.0.0.0/0 [200/0] via 10.0.1.0, Ethernet1

 C        10.0.1.0/31 is directly connected, Ethernet1
 B E      10.20.0.0/16 [200/0] via 10.0.1.0, Ethernet1
 C        10.100.0.0/24 is directly connected, Vlan100
 C        10.255.0.10/32 is directly connected, Loopback0
 B E      10.255.0.100/32 [200/0] via 10.0.1.0, Ethernet1
```
- EOS's default eBGP distance is 200, not IOS's 20 (`[unverified, from memory]`; ntc shows `B I ... [200/0]`).
- A VRF without routing appends `! IP routing not enabled`. [ntc]
- The trailing blank line before the prompt is real. [A-OSPF]

### 6.6 `show mac address-table`
Verbatim layout from [A-DT]: a 66-dash rule, VLAN right-aligned in 4 characters, STATIC rows with no Moves/Last Move, and a multicast table appended. [A-DT] uses the heading `Mac Address Table`, while one [ntc] capture shows lowercase `mac`; use `Mac`.
```
dist-eos1#show mac address-table
          Mac Address Table
------------------------------------------------------------------

Vlan    Mac Address       Type        Ports      Moves   Last Move
----    -----------       ----        -----      -----   ---------
  10    aabb.cc00.0110    DYNAMIC     Et48       1       2 days, 3:11:09 ago
 100    5254.0012.3456    DYNAMIC     Et10       1       17 days, 12:04:51 ago
 100    5254.0012.3457    DYNAMIC     Et11       1       0:05:05 ago
Total Mac Addresses for this criterion: 3

          Multicast Mac Address Table
------------------------------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       ----        -----
Total Mac Addresses for this criterion: 0
```
The simulator is missing the multicast block and right-aligns VLANs correctly. Its `Last Move` should vary per row.

### 6.7 `show ip arp` / `show arp`
4.2x+ layout from [ntc] (`show_ip_arp1`). The age is `h:mm:ss` or `0`, `N/A` for static entries, and the interface is `VlanX, Port` for SVIs.
```
dist-eos1#show ip arp
Address         Age (sec)  Hardware Addr   Interface
10.0.1.0          0:01:12  2899.3a22.0007  Ethernet1
10.100.0.21       0:00:41  5254.0012.3456  Vlan100, Ethernet10
10.100.0.22       0:03:02  5254.0012.3457  Vlan100, Ethernet11
```
The older layout is `Address      Age (min) Hardware Addr  Interface`. [ntc] With `vrf all`, each VRF block is prefixed with `VRF: <name>`. [ntc]

### 6.8 `show lldp neighbors`
Verbatim layout from [ntc] (`neighbors2`, recent) and [A-LLDP] (older, without the dash rule). There are five summary lines, then the table.
```
dist-eos1#show lldp neighbors
Last table change time   : 2 days, 3:11:40 ago
Number of table inserts  : 4
Number of table deletes  : 1
Number of table drops    : 0
Number of table age-outs : 1

Port          Neighbor Device ID       Neighbor Port ID    TTL
---------- ------------------------ ---------------------- ---
Et1           spine1                   Ethernet7           120
Et48          core-sw1                 Gi1/0/48            120
```
- The neighbor port ID is shown as the peer advertises it; IOS advertises `Gi1/0/48` as its port ID. `[unverified]` for IOS-XE, which may send `GigabitEthernet1/0/48`.
- The `detail` form begins with `Interface Ethernet 3/1 detected 1 LLDP neighbors:`. [A-LLDP]

### 6.9 `show version`
Layout from [ntc] (4.28.9M hardware, 4.32.1F cEOS) and [A-CLI]. A blank line separates the hardware, software and runtime blocks.
```
dist-eos1#show version
Arista DCS-7050SX3-48YC8
Hardware version: 11.01
Serial number: JPE19470123
Hardware MAC address: 2899.3a11.0000
System MAC address: 2899.3a11.0000

Software image version: 4.31.2F
Architecture: x86_64
Internal build version: 4.31.2F-35141176.4312F
Internal build ID: 7d8f4a5c-2b1e-4c3a-9f06-1e2d3c4b5a69
Image format version: 3.0
Image optimization: Strata-4GB

Kernel version: 5.10.209-arista-amd64

Uptime: 2 weeks, 3 days, 14 hours and 22 minutes
Total memory: 8099260 kB
Free memory: 5512384 kB
```
`Kernel version:` appears in the 4.32 cEOS capture [ntc] but not in the 4.28.9M one; `[unverified]` whether 4.31 hardware prints it. Uptime words are `N weeks, N days, N hours and N minutes`. [ntc] The simulator lacks `Internal build ID`.

### 6.10 `show logging`
The header block is verbatim from [A-LOG]. A facility table follows (long; usually filtered with `show logging last 50` or `| begin Log Buffer`). The `Log Buffer:` marker and the message line format are `[unverified, from memory]`. Messages are `Mon dd hh:mm:ss <host> <Agent>: %FACILITY-SEV-MNEMONIC: text`.
```
dist-eos1#show logging
Syslog logging: enabled
Buffer logging: level debugging
Console logging: level errors
Persistent logging: disabled
Monitor logging: level errors
Synchronous logging: disabled
Trap logging: level informational
    Logging to '10.255.255.50' port 514 in VRF MGMT via udp
Sequence numbers: disabled
Syslog facility: local7
Hostname format: Hostname only
Repeat logging interval: disabled
Repeat messages: disabled
Root login logging: disabled

External configuration:
    active:
    inactive:

Facility                   Severity            Effective Severity
--------------------       -------------       ------------------
aaa                        debugging           debugging
accounting                 debugging           debugging
...

Log Buffer:
Nov 24 09:12:44 dist-eos1 Ebra: %LINEPROTO-5-UPDOWN: Line protocol on Interface Ethernet2 (spine2), changed state to down
Nov 24 09:12:45 dist-eos1 Bgp: %BGP-3-NOTIFICATION: sent to neighbor 10.0.1.2 (VRF default AS 65100) 6/6 (Cease/other configuration change) 0 bytes
Nov 24 09:12:45 dist-eos1 Bgp: %BGP-5-ADJCHANGE: peer 10.0.1.2 (VRF default AS 65100) old state Established event Stop new state Idle
```

### 6.11 `show running-config` (excerpt)
The header and the 3-space indentation are verified. [A-CLI] The `! device:` and `! boot system` lines are `[unverified, from memory]` but match the simulator.
```
dist-eos1#show running-config
! Command: show running-config
! device: dist-eos1 (DCS-7050SX3-48YC8, EOS-4.31.2F)
!
! boot system flash:/EOS-4.31.2F.swi
!
hostname dist-eos1
!
vlan 100
   name DB
!
vrf instance MGMT
!
interface Ethernet1
   description spine1
   no switchport
   ip address 10.0.1.1/31
!
interface Ethernet10
   description server-db01
   switchport access vlan 100
!
interface Management1
   vrf MGMT
   ip address 192.168.255.21/24
!
ip routing
no ip routing vrf MGMT
!
router bgp 65010
   router-id 10.255.0.10
   neighbor 10.0.1.0 remote-as 65100
   neighbor 10.0.1.0 description spine1
!
end
```

### 6.12 `| json`
- Appending `| json` returns the eAPI JSON model for any converted show command (pyntc's SSH driver appends `| json` on the wire). [lib:pyntc]
- Unconverted commands fail with an error. The exact wording, `% This is an unconverted command`, is `[unverified, from memory]`.
- Output is pretty-printed JSON with 4-space indentation. `[unverified, from memory]`
```
dist-eos1#show version | json
{
    "mfgName": "Arista",
    "modelName": "DCS-7050SX3-48YC8",
    "hardwareRevision": "11.01",
    "serialNumber": "JPE19470123",
    "systemMacAddress": "28:99:3a:11:00:00",
    "hwMacAddress": "28:99:3a:11:00:00",
    "configMacAddress": "00:00:00:00:00:00",
    "version": "4.31.2F",
    "architecture": "x86_64",
    "internalVersion": "4.31.2F-35141176.4312F",
    "internalBuildId": "7d8f4a5c-2b1e-4c3a-9f06-1e2d3c4b5a69",
    "imageFormatVersion": "3.0",
    "imageOptimization": "Strata-4GB",
    "bootupTimestamp": 1762378800.0,
    "uptime": 1512120.5,
    "memTotal": 8099260,
    "memFree": 5512384,
    "isIntlVersion": false
}
```
Key names are `[unverified, from memory]`; MAC addresses use colon notation in JSON.

Other pipe modifiers `[unverified, from memory]`:
- Built-ins: `begin`, `exclude`, `include`, `section`, `json`, `no-more`, `nz`, `append`, `redirect`, `tee`.
- **`LINE`: any other word after `|` is handed to a Linux shell pipeline** (`| grep -c up`, `| wc -l`, `| awk ...`, `| head`). There is no native `| count`; `| wc -l` is the idiom.

## 7. Dangerous commands

Destructive or escaping commands on EOS:
- **Reload:** `reload [now|force|in N|at hh:mm]`, `reload fabric-module N` [A-SMC], `zerotouch cancel` (reloads the box) and `zerotouch disable` (reboots too). `[unverified]` for the zerotouch reload behavior.
- **Erase:** `write erase`, `erase startup-config`, `delete flash:<file>` / `delete /recursive`, `rmdir`, `rename`, `copy <anything> startup-config|running-config|flash:`, `configure replace ...`, `configure checkpoint restore`, `configure session X commit`, `rollback clean-config`, `configure convert new-syntax`, and `reset system storage secure` (listed as a command [A-SMC]).
- **Boot:** `boot system flash:<swi>`, `install`, `extension`, `copy installed-extensions boot-extensions`.
- **Shell and code:** `bash`, `bash timeout N <cmd>`, `python-shell`, `tcpdump`, `schedule ... command bash ...` [A-CLI], `watch` (never ends) [A-CLI], `run`, `ssh`, `telnet`, `connect`, `attach vm`, and `| <linux cmd>` pipes.
- **Agents:** `agent <Name> terminate`, `platform ...`, `hardware ...`, `trace ...`, `debug ...`.
- **Clear:** `clear ip bgp *` / `clear ip bgp neighbor *` / `clear ip bgp 10.0.1.0` (session reset), `clear mac address-table dynamic`, `clear arp-cache`, `clear ip ospf ...`, `clear logging`, `clear counters` (low risk).
- **Config-mode destructive commands** (cannot be expressed as top-level exec keywords):
  - `no router bgp 65010`, `shutdown` under an uplink interface or `router bgp`, `no ip routing`, `default interface Et1`, `no interface ...`, `no vlan 100`.
  - `spanning-tree mode none`, `management ssh` + `shutdown`, `username admin ... nopassword`, `aaa ...`.
  - `ip access-list` edits applied to the management interface, `vrf instance` removal.
  - `event-handler` + `action bash` and `daemon` + `command` (persistent code execution) [A-CLI].
  - **`alias`**: an alias "supercedes the original command" [A-CLI], so `alias show reload` makes every later `show` reload the box.

### PlatformRules proposal
```ts
const eos: PlatformRules = {
  read: ['show', 'ping', 'traceroute'],
  blocked: [
    'reload', 'bash', 'python-shell', 'tcpdump', 'watch', 'schedule', 'run',
    'copy', 'delete', 'rename', 'mkdir', 'rmdir', 'erase', 'format',
    'zerotouch', 'boot', 'install', 'extension',
    'ssh', 'telnet', 'connect', 'attach', 'send',
    'agent', 'platform', 'hardware', 'trace', 'reset',
    'event-handler', 'daemon', 'alias'          // config-level code execution / command shadowing
  ],
  other: [
    'clear', 'configure', 'debug', 'undebug', 'diff', 'dir', 'pwd', 'cd', 'more',
    'disable', 'enable', 'exit', 'end', 'logout', 'quit',
    'monitor', 'no', 'default', 'terminal', 'write', 'who', 'cli', 'routing-context',
    'rollback', 'commit', 'abort'
  ],
  blockedPairs: [
    ['write', 'erase'],
    ['configure', 'replace'],
    ['configure', 'session'],        // session commit replaces running-config wholesale
    ['configure', 'checkpoint'],     // "restore" is the danger; "save" is benign but writes flash
    ['configure', 'convert'],
    ['configure', 'network'],
    ['rollback', 'clean-config'],
    ['debug', 'all'],
    ['clear', 'ip'],                 // clear ip bgp * / clear ip ospf / clear ip arp
    ['clear', 'mac'],
    ['clear', 'arp-cache'],
    ['clear', 'logging'],
    ['show', 'tech-support']         // optional: heavy CPU, multi-MB output
  ],
  pipesAllowed: ['include', 'exclude', 'begin', 'section', 'json', 'no-more', 'nz'],
  pipesBlocked: ['tee', 'append', 'redirect', 'bash', 'python'],
  // IMPORTANT: EOS treats ANY unknown token after '|' as a Linux command (grep/awk/sed/sh -c ...).
  // The guard must treat pipesAllowed as a strict allowlist, not "allowed unless in pipesBlocked".
  execFromConfig: 'do'
}
```
Changes vs the Phase 2 guard rules (since 0.4 the deny-list is part of the EOS tree, `packages/cli-model/src/trees/eos.ts`):
- **Add** to `blocked`: `watch`, `run`, `connect`, `attach`, `hardware`, `trace`, `reset`, `event-handler`, `daemon`, `alias`, `extension`.
- **Add** to `other`: `end`, `default`, `who`, `cli`, `rollback`, `commit`, `abort`.
- **Remove** `count` and `last` from `pipesAllowed`. Neither is a confirmed EOS built-in; a literal `| last` or `| count` would run as Linux commands via the `LINE` pipe if present, and Linux `last` reads wtmp. Keep `nz`.
- `show logging follow` and `show ... | ... follow`-style commands never terminate. This needs a 3-token rule.

### What the PlatformRules shape cannot express
- **3+ token commands:**
  - `configure checkpoint restore X` vs `configure checkpoint save X`
  - `show logging follow` (a read command that never ends)
  - `configure session X commit` vs `configure session X` followed by `show session-config diffs`
  - `reload fabric-module 2`, `clear ip bgp * soft` (soft is safe-ish) vs `clear ip bgp *`
- **Arguments:** `clear ip bgp *` vs `clear ip bgp 10.0.1.2`, and `copy running-config startup-config` (= `write`, arguably fine) vs `copy flash:evil startup-config`.
- **Config-mode semantics:** `shutdown` under `interface Ethernet1` is fatal; under `interface Ethernet3` (unused) it is harmless. `no router bgp`, `no ip routing`, `default interface`, `spanning-tree mode none`, `management ssh` / `shutdown`, `alias` and `event-handler ... action bash` are all config-mode lines.
- **Session context:** inside `(config-s-*)` nothing applies until `commit`, so the danger moves to the `commit` token, and `commit timer` is the safer variant.
- **Pipe-to-shell:** `| grep` vs `| sh -c 'reload'`. The guard must parse after `|` and accept only allowlisted EOS modifiers.
- **User-defined aliases:** an alias can map any harmless-looking word to any command. Reading `show running-config | include ^alias` first is the only defense.

### Abbreviation traps
- `wr` resolves to `write` (save to startup). `wr er` resolves to `write erase` (wipes startup). The pair check must run on resolved tokens.
- `rel` resolves to `reload`. `re` is ambiguous on EOS (`reload`, `rename`, `reset`, `resequence`?), so EOS prints `% Ambiguous command`, but the guard should still treat it as "could be reload".
- `del` resolves to `delete`; `ba` / `bas` to `bash`; `tc` to `tcpdump`; `wa` to `watch`; `zer` to `zerotouch`.
- `con` is ambiguous (`configure` / `connect`). [A-CLI] `conf r` resolves to `configure replace`; `conf s` to `configure session`; `conf ch r` to `configure checkpoint restore`.
- `di` is ambiguous (`diff`, `dir`, `disable`). [A-CLI]
- `cl ip b *` resolves to `clear ip bgp *`.
- `sh` resolves to `show`. Bash is not reachable through `sh`, but `show ... | sh` is a shell.
- Aliases: `e` (as `alias e enable`) [A-CLI] and any custom alias bypass vocabulary resolution.

## 8. Live-value sources

| Value | Text command to parse | Field / regex hint | Structured alternative |
|---|---|---|---|
| Interfaces (all) | `show interfaces status` | `^(Et\S+\|Po\d+\|Ma\d+\|Vx\d+)\s` | `show interfaces status \| json` (`interfaceStatuses.<name>`) / `show interfaces description \| json` |
| L3 interfaces | `show ip interface brief` | `^(\S+)\s+(\d+\.\d+\.\d+\.\d+/\d+\|unassigned)` | `show ip interface brief \| json` (`interfaces.<name>.interfaceAddress`) |
| VLANs | `show vlan` | `^(\d{1,4})\s+(\S+)\s+(active\|suspended\|act/unsup)` [ntc] | `show vlan \| json` (`vlans.<id>.name`) |
| VRFs | `show vrf` | rows indented 3 spaces: `^\s{3}(\S+)\s+(\S+\|<not set>)` [ntc] | `show vrf \| json` (`vrfs.<name>`) |
| BGP neighbors | `show ip bgp summary vrf all` | `^\s{2}(?:\S.*?\s+)?(\d+\.\d+\.\d+\.\d+)\s+4\s+(\d+(?:\.\d+)?)` | `show ip bgp summary vrf all \| json` (`vrfs.<vrf>.peers.<ip>.peerState`, `.asn`, `.description`) |
| BGP local AS / router-id | `show ip bgp summary` | `Router identifier (\S+), local AS number (\S+)` | same JSON: `vrfs.default.asn`, `.routerId` |
| OSPF neighbors | `show ip ospf neighbor` | `^(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+(\S+)` | `show ip ospf neighbor \| json` |
| Route-maps | `show route-map` / `show running-config \| include ^route-map` | `^route-map (\S+) (permit\|deny) (\d+)` | `show route-map \| json` |
| Prefix-lists | `show ip prefix-list` / `\| include ^ip prefix-list` | `^ip prefix-list (\S+)` | `show ip prefix-list \| json` `[unverified]` |
| ACLs | `show ip access-lists summary` | `^IPV4 ACL (\S+)` `[unverified]` | `show ip access-lists \| json` (`aclList[].name`) |
| Port-channels | `show port-channel summary` | `^\s+(Po\d+)\(` [ntc] | `show port-channel \| json` |
| MLAG | `show mlag` | `domain-id\s*:\s*(\S+)` | `show mlag \| json` |
| MAC / ARP | `show mac address-table`, `show ip arp` | see §6 | `\| json` |
| LLDP neighbor names | `show lldp neighbors` | `^(\S+)\s+(\S+)\s+(\S+)\s+\d+$` | `show lldp neighbors \| json` (`lldpNeighbors[]`) |
| Config sessions | `show configuration sessions` | | `show configuration sessions detail \| json` (`sessions.<name>.state`) [lib:asynceapi] |
| Checkpoints | `dir checkpoint:` | last column | |
| Aliases | `show running-config \| include ^alias` | `^alias (\S+) (.+)$` [A-CLI] | `show aliases` `[unverified]` |
| Hostname | prompt or `show hostname` | `Hostname: (\S+)` [ntc] | `show hostname \| json` |

Prefer `| json` everywhere: it is cheap on EOS, stable across releases, and immune to column-width drift. The same JSON is what eAPI (`management api http-commands`) returns.

## 9. Interface naming

| Type | Full name | CLI short / display | Regex |
|---|---|---|---|
| Ethernet (fixed) | `Ethernet1` | `Et1` | `^(?:Ethernet\|Et\|eth)(\d+)$` |
| Ethernet (breakout lane) | `Ethernet49/1` | `Et49/1` | `^(?:Ethernet\|Et)(\d+)/(\d+)$` |
| Ethernet (modular) | `Ethernet3/1`, `Ethernet3/1/4` (module/port/lane) | `Et3/1/4` | `^(?:Ethernet\|Et)(\d+)(?:/(\d+)){1,2}$` |
| Ethernet subinterface | `Ethernet20/1.10`, `Ethernet9.999` | `Et9.999` | `^(?:Ethernet\|Et)[\d/]+\.(\d+)$` [ntc] |
| Port-Channel | `Port-Channel10` | `Po10` | `^(?:Port-Channel\|Po)(\d+)(?:\.(\d+))?$` [ntc] |
| Loopback | `Loopback0` | `Lo0` | `^(?:Loopback\|Lo)(\d+)$` |
| SVI | `Vlan100` | `Vl100` | `^(?:Vlan\|Vl)(\d+)$` [ntc] |
| Management | `Management1`, `Management1/1` (modular), `Management0` (cEOS) | `Ma1` | `^(?:Management\|Ma)(\d+(?:/\d+)?)$` [ntc] [A-LLDP] |
| VXLAN | `Vxlan1` | `Vx1` | `^(?:Vxlan\|Vx)(\d+)$` |
| Tunnel | `Tunnel11` | `Tu11` | `^(?:Tunnel\|Tu)(\d+)$` [ntc] |
| Null | `Null0` | | `^Null0$` [ntc] |
| Recirc / CPU | `Recirc-Channel1`, `Cpu` | | `[unverified]` |

- Fixed switches use `Ethernet <port>` and modular ones `Ethernet <module>/<port>`; multi-lane ports add `/<lane>`. [A-ETH]
- Ranges and lists are accepted wherever an interface is taken: `ethernet 1-5`, `ethernet 4/1-5/8`, `et1,2,5/1`, `interface Et2,3,4`. [A-CLI] [A-ETH] [A-DT]
- A space between type and number is allowed (`interface ethernet 1`, `trigger on-intf Ethernet 5`), and keywords are case-insensitive. [A-CLI]
- **Display rules:**
  - Status tables (`show interfaces status`, `show lldp neighbors`, `show mac address-table`, `show interfaces description`) use short names (`Et1`, `Po1`, `Ma1`).
  - `show ip interface brief`, `show ip route`, `show ip arp`, `show ip ospf neighbor` and running-config use long names.
  - Config prompts use the short form (`config-if-Et24`). [A-CLI] [ntc]
- The simulator's Ethernet speed values should be `25G` or `10G` without the `a-` prefix unless autonegotiated.

## 10. Simulator and guard fit

### Delta: current simulator vs real EOS
| Area | Simulator today | Real EOS | Fix |
|---|---|---|---|
| Invalid input | Caret line + `% Invalid input detected at '^' marker.` | **No caret.** `% Invalid input (at token N: 'word')`, 0-based token index [lib:pyntc] [lib:netman] | Branch in `shell.ts:error()` on `platform === 'eos'` |
| Ambiguous | `% Ambiguous command:  "<line>"` | `% Ambiguous command` [A-CLI] | EOS branch |
| Incomplete | `% Incomplete command.` (with period) | `% Incomplete command` (no period) [lib:scrapli] | EOS branch |
| Privileged required | n/a | `% Invalid input (privileged mode required)` when `>` users run `configure` etc. `[unverified]` | Add once a `>` mode exists |
| Modes | exec(#) only; no `>` | `>` and `#`; `enable`/`disable` | Optional `user-exec` mode |
| Router prompt | `(config-router)#` | `(config-router-bgp)#`, `(config-router-ospf)#` [A-CLI] | Mode-specific suffix |
| VLAN prompt | `(config-vlan)#` | `(config-vlan-100)#` `[unverified]` | Include the VLAN id |
| Interface prompt | `(config-if-Et1)#` | Same. [A-CLI] Ranges `(config-if-Et10-11)#` | OK; add ranges |
| Sessions | absent | `configure session`, `(config-s-<name>)#`, `commit`, `commit timer`, `abort`, `show session-config diffs`, `show configuration sessions` | New mode `config-session` (high value for demos and guard tests) |
| `configure` banner | empty (correct for EOS) | EOS prints nothing on `configure`. [A-CLI] | OK |
| Pager | ` --More-- ` | ` --More-- ` (`[unverified]`); console has no paging by default [A-CLI] | OK |
| `terminal length 0` | (check) | Prints `Pagination disabled.`; `terminal length N` prints `Pagination set to N lines.` [A-CLI] | Echo these strings |
| `terminal width` | (check) | `Width set to N columns.` (netmiko matches `Width set to`) [lib:netmiko] | Echo it |
| `write memory` | `Copy completed successfully.` | Same `[unverified]`; the manual shows silent success [A-CLI] | OK |
| `show ip interface brief` | 2-line header, no Owner column, `adminDown` | 2-line header with an `Owner` column [A-OSPF] | Add `Owner`, align `MTU` right |
| `show interfaces status` | No `Flags Encapsulation` columns | Has them [A-ETH] | Add empty columns |
| `show ip bgp summary` | Description column always, 1-space `V AS` | Matches [ntc] `summary3` closely | Hide the Description column when no peer has one |
| `show ip route` | Short codes block, no route rows for BGP | Full 4.3x codes block (§6.5), `B E` rows with `[200/0]`, blank line after `VRF: default` | Expand |
| `show mac address-table` | No multicast block | Has multicast block [A-DT] | Append |
| `show lldp neighbors` | (check) | 5 summary lines + dash rule [ntc] | Match §6.8 |
| `show logging` | (check) | Header block [A-LOG] + facility table + `Log Buffer:` | Match §6.10 |
| `show version` | Missing `Internal build ID` | Present [ntc] [A-CLI] | Add |
| `bash` | "shell access is disabled" | Banner `Arista Networks EOS shell` then `[admin@dist-eos1 ~]$` [A-CLI] | Keep disabled but use the real banner text in docs only |
| Pipes | include/exclude/begin/section/count/grep/no-more/json | `count` is not built-in; `grep`/`wc` go through the Linux `LINE` pipe | Keep `grep` (real via Linux), drop `count` for EOS or map it to `wc -l` semantics |
| `?` help | Shared format | Prefix help lists keywords on **one line without descriptions** (`diff  dir  disable`) [A-CLI] | EOS branch for `word?` |
| Missing commands | | `show interfaces description`, `show vrf`, `show port-channel summary`, `show ip ospf neighbor`, `show arp`, `show history`, `show active`, `show configuration sessions`, `show session-config diffs`, `show hostname`, `show uptime`, `show inventory`, `dir flash:`, `configure checkpoint save` | Add the top ones |

### Recommended Mode names for EOS
`'exec-user'` (`>`), `'exec'` (`#`), `'config'`, `'config-if'` (prompt carries the short name or range), `'config-router-bgp'`, `'config-router-bgp-af'`, `'config-router-bgp-vrf'`, `'config-router-ospf'`, `'config-vlan'` (prompt `config-vlan-<id>`), `'config-vrf'`, `'config-acl'`, `'config-route-map'`, `'config-mgmt'` (`config-mgmt-api-http-cmds`, `config-mgmt-ssh`, ...), and **`'config-session'`**. The last is a wrapper flag rather than a mode: the prompt becomes `config-s-<name>` plus `-<submode>`, and changes are buffered until `commit`.

### Guard fit summary
- Switch `pipesAllowed` to **strict allowlist** semantics for EOS, because unknown pipe words execute as Linux commands.
- Block `alias`, `event-handler` and `daemon` (config-level persistence and command shadowing) and `watch` (never terminates).
- Treat `configure session` as config, not blocked, **if** the agent flow uses `show session-config diffs` plus `commit timer` as its safe-change workflow. The real danger token is `commit` without a timer.

## Sources
Arista EOS User Manual (4.36.x, read through Internet Archive snapshots because arista.com returned HTTP 406 / JS challenge to automated fetches):
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-command-line-interface-cli
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-configuration-sessions-overview
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-configure-session
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-session-management-commands
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-managing-display-attributes
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-open-shortest-path-first-version-2
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-link-layer-discovery-protocol
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-data-transfer
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-ethernet-ports
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-system-event-logging
- http://web.archive.org/web/2026id_/https://www.arista.com/en/um-eos/eos-recovery-procedures

Secondary sources (raw device captures; files under tests/arista_eos/<command>/ fetched from raw.githubusercontent.com):
- https://github.com/networktocode/ntc-templates/tree/master/tests/arista_eos: show_ip_interface_brief, show_interfaces_status (4 captures), show_interfaces_description, show_ip_bgp_summary (6), show_ip_ospf_neighbor (2), show_ip_route (7), show_mac_address-table, show_ip_arp (2), show_lldp_neighbors (2), show_version (5), show_vlan, show_vrf (4)

Secondary sources (automation libraries / test fixtures with hard-coded EOS strings):
- https://raw.githubusercontent.com/aristanetworks/anta/main/anta/constants.py
- https://raw.githubusercontent.com/aristanetworks/anta/main/asynceapi/config_session.py
- https://raw.githubusercontent.com/scrapli/scrapli_definitions/main/definitions/arista_eos.yaml
- https://raw.githubusercontent.com/ktbyers/netmiko/develop/netmiko/arista/arista.py
- https://raw.githubusercontent.com/knipknap/exscript/master/Exscript/protocols/drivers/eos.py
- https://raw.githubusercontent.com/ansible-collections/arista.eos/main/plugins/terminal/eos.py
- https://raw.githubusercontent.com/networktocode/pyntc/develop/tests/unit/test_devices/test_eos_ssh_device.py
- https://raw.githubusercontent.com/internap/netman/master/tests/adapters/switches/arista_test.py
