# Cisco IOS-XR CLI notes (guard / command-tree input)

Researched 2026-11. Tags: `[V:src]` = checked against fetched text; `[unverified, from memory]` = not checked.
Tag `[S:src]` = seen only in a web-search result summary (page not fetched) — NOT verified. Untagged claims = `[unverified, from memory]`.
Sources:
- NM = netmiko `cisco_xr.py` https://github.com/ktbyers/netmiko/blob/develop/netmiko/cisco/cisco_xr.py (curl, verbatim)
- SC = scrapli `cisco_iosxr.yaml` https://github.com/carlmontanari/scrapli/blob/main/scrapli/definitions/cisco_iosxr.yaml (curl, verbatim)
- C8K = Cisco 8000 Setup/Upgrade cmd ref https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/b-setup-and-upgrade-cisco8k/setup-and-upgrade-commands.html
- FR = Cisco "Understand factory reset" https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-xr-software/225260-understand-factory-reset-related.html
- CM = XR 3.7 config-mgmt cmd ref https://www.cisco.com/en/US/docs/ios_xr_sw/iosxr_r3.7/system_management/command/reference/yr37conf.html
- NTC = https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_xr

## 1. Prompts and modes
| Mode | Prompt | Tag |
|---|---|---|
| EXEC | `RP/0/RP0/CPU0:host#` (also `RP/0/RSP0/CPU0:`, `RP/0/RP1/CPU0:`, classic `RP/0/0/CPU0:`) | [V:C8K, FR] |
| Global config | `RP/0/RP0/CPU0:host(config)#` | [V:FR] |
| Sub-mode | `...(config-if)#`, `(config-bgp)#`, `(config-bgp-nbr)#` | [unverified, from memory] |
| Classic admin (32-bit) | `RP/0/RSP0/CPU0:BNG(admin)#`, `(admin-config)#` | [V:NM docstring] |
| eXR sysadmin VM (64-bit) | `sysadmin-vm:0_RSP0#` / `sysadmin-vm:0_RP0#` | [V:FR] / [S:community] |
| Linux shell (eXR, `run`/`bash`) | `[xr-vm_node0_RP0_CPU0:~]$`, `[sysadmin-vm:0_RP0:~]$` | [S: community thread] |
| XR7 (LNT) shell | `[node0_RP0_CPU0:~]$` | [unverified, from memory] |
| ROMMON | `rommon 2 >` | [V:FR] |
- No enable mode; user lands at `#` (netmiko uses `NoEnable`). [V:NM]
- netmiko: `set_base_prompt` terminators `#`/`>`, base prompt truncated to **31 chars** (XR abbreviates prompt in config mode); `check_config_mode` looks for `)#` after stripping `(admin)`. [V:NM]
- scrapli regexes [V:SC]: generic `^.*[>#$]\s?+$`; exec `^[\w.\-@/:]{1,63}#\s?$`; config `^[\w.\-@/:]{1,63}\(config[\w.\-@/:]{0,32}\)#\s?$`.
- Every command echoes a timestamp line first, e.g. `Wed Mar 14 12:31:28.607 UTC` [V:NTC show_version raw].
- XR echoes the command before the prompt returns (netmiko waits for `[>#]`). [V:NM]

## 2. Pager
- Disable: `terminal length 0` (scrapli sends `term len 0`, plus `term width 512`; netmiko `terminal width 511` + default disable_paging). [V:SC, NM]
- Session-only (EXEC). Pager string: ` --More-- ` [unverified, from memory].

## 3. Error strings
- `% Invalid input detected at '^' marker.` (caret line above, under the bad token) — scrapli failure indicator `% Invalid input detected` [V:SC]; full text [unverified, from memory].
- `% Incomplete command.` / `% Ambiguous command: "..."` — prefixes [V:SC], tails [unverified, from memory].
- Commit failure [V:NM]: `% Failed to commit one or more configuration items during a pseudo-atomic operation. All changes made have been reverted. Please issue 'show configuration failed [inheritance]' from this session to view the errors`
- Concurrent commit [V:NM]: `One or more commits have occurred from other configuration sessions since this session started or since the last commit was made from this session.`

## 4. Confirmation prompts
| Trigger | Text | Tag |
|---|---|---|
| `reload` | `Proceed with reload? [confirm]` | [V:C8K] |
| reload w/o standby | `Standby card not present or not Ready for failover. Proceed?[confirm]` | [V:C8K] |
| large `commit` | `This could be a few minutes if your config is large. Confirm? [y/n][confirm]` | [V:NM] |
| other sessions committed | `Do you wish to proceed with this commit anyway? [no]` | [V:NM] |
| `commit replace` | `This commit will replace or remove the entire running configuration. This operation can be service affecting.` then `Do you wish to proceed? [no]:` | [V:NM, FR] |
| `end`/`exit` with pending | `Uncommitted changes found, commit them before exiting(yes/no/cancel)?[cancel]:` | [V:CM] |
| `clear configuration commits` | `Continue with deletion?[confirm]` | [V:CM] |
| `clear logging` | `Clear logging buffer [confirm] [y/n] :` | [V:CM] |
| sysadmin `hw-module location all reload` | `Reload hardware module ? [no,yes]` | [V:FR] |
- Guard note: an agent answering `yes`/`y` to these is the actual destructive step; treat answers to these prompts as part of the command.

## 5. Pipes / output modifiers
- `| begin`, `| exclude`, `| include`, `| file`, `| utility` [S: Cisco Community JP doc, 403 to fetch].
- `| utility wc` used for counting (no `| count`) [S: Nokia SR vs XR comparison table].
- `| utility` sub-tools: `cut egrep fgrep head less sort tail uniq wc` [unverified, from memory].
- **Writes a file:** `| file <fs:/path>` (saves output to disk). **Runs code:** `| utility ...` (on-box Unix utilities). Treat both as non-read. 
- Others `| section`? Not on XR; use `show run formal | i` [S:community]. `| xml` / `| json` on some releases [unverified, from memory].

## 6. Daily read-only commands (exist as ntc templates unless tagged)
`show version` · `show version brief` · `show platform` · `admin show platform` · `admin show inventory` · `admin show environment power` · `admin show environment fan` · `admin show vm` · `show inventory` · `show redundancy summary` · `show install active` · `show processes cpu` · `show interfaces` · `show interfaces description` · `show interfaces summary` · `show interface brief` · `show ipv4 interface brief` · `show ipv4 vrf all interface brief` · `show ip interface brief` · `show route` / `show route ipv4` [route form unverified] · `show bgp` · `show bgp summary` [unverified, from memory] · `show bgp instance all summary` · `show bgp vrf all ipv4 unicast summary` · `show bgp neighbors` · `show ospf neighbor` · `show ospf vrf all neighbor` · `show isis neighbors` · `show mpls ldp neighbor brief` · `show bfd sessions` · `show hsrp` · `show lldp neighbors [detail]` · `show cdp neighbors detail` · `show arp` · `show ipv6 neighbors` · `show running-config` · `show running-config interface` · `show running-config formal` [S: community "show run formal"] · `show configuration commit list` · `show configuration changes diff` (inside config) · `show logging` · `show controllers ...` · `show drops np all` · `ping` / `traceroute` (traffic-generating but non-mutating). Tag: commands named in the ntc template list exist as templates [V:NTC]; C8K lists show install/inventory/platform/redundancy/version [V:C8K]; argument forms of the rest [unverified, from memory].

## 7. Dangerous commands
**Reload / power** [V unless tagged]
- `reload` (RP) [V:C8K]; `reload location {node|all}` and `admin` `reload location all` [S: NCS5500 sysman ref]; `reload bootmedia` [V:C8K TOC]
- `hw-module location <node|all> reload` (sysadmin; real HW reset) [V:FR]; `hw-module location X shutdown` [unverified, from memory]
- `factory-reset reload location ...`, `factory-reset shutdown location all` [V:FR]
- `zapdisk start location all`, `admin zapdisk set|unset` (disk wipe on boot) [V:FR]
**Config replace / commit** (config mode)
- `commit` (applies candidate), `commit replace` (= XR "write erase" equivalent), `commit confirmed <s>` [V:NM, FR]; `commit best-effort` [S: community]
- `load <file>` only stages into the target buffer; the following `commit` applies it. `load rollback changes`, `load commit changes` [V:CM]
- `rollback configuration` [V:CM name]; syntax `to <id>|last <n>` and "applies immediately" [unverified, from memory]
- `clear configuration commits` (deletes old commit IDs) [V:CM]; `clear configuration sessions`, `clear configuration inconsistency` [V:CM, C8K names; effect unverified]
- `configure exclusive` (locks config for others) [V:CM]; `abort` discards candidate silently [V:CM]
- `save configuration ...` writes files [V:CM TOC]
**Shell / code execution**
- `run [cmd]` (ksh on classic QNX, Linux on eXR), `bash` (eXR/XR7), `attach location <node>` (shell on card) [S: community + Cisco ASR9k VM doc]
- `admin` (enter sysadmin plane, classic & eXR) [V:CM TOC]
- `| utility`, `| file` (see §5); `tclsh`? not on XR [unverified, from memory]
**Software / files**
- `install add|activate|commit|apply|replace|rollback|package|source` [V:C8K]; `install deactivate|remove` [unverified, from memory]
- `copy`, `delete`, `format`, `mkdir`, `rmdir`, `scp`, `sftp` [unverified, from memory]
**Traffic / state**
- `clear bgp *`, `clear ospf process`, `clear route`, `clear arp-cache`, `clear counters` (benign-ish) [unverified, from memory]
- `process restart <name>`, `process kill`, `process shutdown` [unverified, from memory]
- `redundancy switchover` [unverified, from memory]
- In config: `shutdown`, `no router ...`, `no interface ...` take effect only at `commit`.
- Guard: XR config is two-stage; classify `configure`/sub-mode lines as config, `commit*` as disruptive-commit, `abort` as safe.

## 8. Fingerprint
- SSH banner: `SSH-1.99-Cisco-2.0` seen from XR [S:community log]; v2-only is presumably `SSH-2.0-Cisco-2.0` [unverified]. `show ssh` reports `Cisco-2.0` (community). nmap regex `^SSH-(\d[\d.]+)-Cisco-(\d[\d.]+)` tags this as IOS, so the banner alone does **not** separate XR from IOS. XR 7.x may offer OpenSSH-based server [unverified, from memory].
- First non-timestamp line of `show version` [V:NTC raw]:
```
Wed Mar 14 12:31:28.607 UTC

Cisco IOS XR Software, Version 6.1.4
Copyright (c) 2013-2016 by Cisco Systems, Inc.
...
cisco NCS-5500 () processor
```
- netmiko autodetect: `show version` / `show version brief` match `Cisco IOS XR` [V: netmiko ssh_autodetect.py].
- Prompt `RP/0/...CPU0:` prefix is the strongest signal.
