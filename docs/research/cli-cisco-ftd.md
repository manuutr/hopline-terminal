# Cisco FTD (Secure Firewall Threat Defense) CLI and FXOS notes

Researched 2026-11. `[V:src]` = checked in fetched text; `[unverified, from memory]` = not checked.
Tag `[S:src]` = seen only in a web-search result summary (page not fetched) — NOT verified. Untagged claims = `[unverified, from memory]`.
Sources:
- UC = FTD cmd ref "Using the CLI" https://www.cisco.com/c/en/us/td/docs/security/firepower/command_ref/b_Command_Reference_for_Firepower_Threat_Defense/using_the_FTD_CLI.html
- C3 = FTD cmd ref chapter "c" (cluster/configure/connect/copy/crashinfo) https://www.cisco.com/c/en/us/td/docs/security/firepower/command_ref/b_Command_Reference_for_Firepower_Threat_Defense/c_3.html
- NM = netmiko `cisco_ftd_ssh.py` https://github.com/ktbyers/netmiko/blob/develop/netmiko/cisco/cisco_ftd_ssh.py (curl)
- SC = scrapli_community `cisco_ftd.py` https://github.com/scrapli/scrapli_community/tree/main/scrapli_community/cisco/ftd (curl)
- FX = Cisco "FXOS ..." TAC doc 215551 https://www.cisco.com/c/en/us/support/docs/security/firepower-4100-series/215551-firepower-extensible-operating-system-f.html
- FMC = cdFMC `system` cmd pages https://docs.manage.security.cisco.com/cdfmc/c_fmc_system_commands.html (search summary only, not fetched)
- NTC = https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_ftd , .../cisco_fxos

## 1. Prompts and modes
| Mode | Prompt | Enter / leave | Tag |
|---|---|---|---|
| FTD CLI (CLISH) | `> ` | SSH login lands here | [V:UC, SC `^>\s*`] |
| Diagnostic CLI (Lina/ASA) user | `firepower>` | `system support diagnostic-cli` | [V:UC, NM] |
| Diagnostic CLI priv | `firepower#` | `enable` (empty password, press Enter) | [V:UC, NM] |
| Recovery config (7.7+) | `firepower(recovery-config)#` | `configure recovery-config` | [V:UC] |
| Expert (Linux) | `admin@firepower:~$` | `expert`; `exit` | [V:UC]; scrapli `^[\w.-]{1,63}@[^$]+\$\s*$` [V:SC] |
| Root | `root@firepower:~#` | `sudo su -` (asks `Password:`) | [V:SC `^root@[^#]+#\s*$`] |
| FXOS (appliance-mode 1000/2100/3100) | `firepower#` | `connect fxos`; `exit` | [V:UC] |
- Leave diagnostic CLI: Ctrl-a then d (netmiko sends `\x01d`) [V:NM]; Cisco doc says `exit` until back at `>` [V:UC].
- netmiko: `NoConfig` (no config mode on FTD CLI); `enable()` = enter diagnostic CLI + `enable` [V:NM].
- FTD CLI allows **no abbreviations** (diag CLI does); Space/Tab completes [V:UC]. scrapli warns partial words stall the session (e.g. use `show running-config`, not `show run`) [V:SC].
- Note diagnostic-CLI `firepower#` and FXOS `firepower#` look identical; track entry command.

## 2. Pager
- Stop long output with `q`; Ctrl-C stops long commands [V:UC].
- No pager-disable command found for the `>` CLI; scrapli/netmiko send none [V:SC, NM]. In diagnostic CLI `terminal pager 0` (ASA) [unverified]. Pager text `--More--` [unverified, from memory].

## 3. Error strings
- `Syntax error:` (scrapli failed_when_contains) [V:SC]; full forms like `Syntax error: Illegal parameter` / `Syntax error: The command is not complete` [unverified, from memory].
- Diagnostic CLI uses ASA errors (`ERROR: % Invalid input detected at '^' marker.`) [unverified, from memory].

## 4. Confirmation prompts
- `configure manager delete`: `Do you want to continue[yes/no]:` [V:C3].
- `configure high-availability suspend`: `Please ensure that no deployment operation is in progress before suspending...` [V:C3].
- `reboot`: `This command will reboot the system.  Continue?` / `Please enter 'YES' or 'NO':` [unverified, from memory]; `shutdown` similar [unverified].
- `configure firewall transparent`: warns config will be cleared, `Are you sure? (yes/no)`? [unverified].
- FXOS `erase configuration` (local-mgmt): `All configurations are erased and system must reboot. Are you sure? (yes/no):` [V:FX].
- Guard: answers like `YES` are the destructive step.

## 5. Pipes / output modifiers
- `show <cmd> | {grep | include | exclude | begin} <regex>` (no quotes; trailing spaces count) [V:UC]. scrapli warns filters are buggy on FTD (parentheses fail) [V:SC].
- Writes files: `system generate-troubleshoot ...` (bundle), `capture ...` + `copy`, `file` commands, `cpu profile dump` [C3 TOC]. FXOS: no pipes beyond `| grep`? [unverified].

## 6. Daily read-only commands
[unverified, from memory unless tagged] `show version` · `show version system`? · `show managers` · `show network` · `show interface ip brief` · `show interface` · `show running-config` (full words) · `show route` · `show conn` / `show conn count` · `show xlate` · `show nat` · `show access-list` [V:UC example] · `show failover` / `show failover state` · `show high-availability config` · `show cluster info` · `show cpu usage` · `show memory` · `show asp drop` · `show crypto ipsec sa` · `show vpn-sessiondb anyconnect` [V:NTC] · `show arp` [V:NTC] · `ping` [V:NTC] · `show logging` · `show capture` · `show snort statistics` / `show snort3 status` · `show disk` · `show ssh-access-list` · `show https-access-list` · `show ntp` · `show dns` · `show user` · `show inventory` · `show serial-number` · `packet-tracer input ...` (simulation) · `show-` commands in diag CLI same as ASA.
FXOS read-only: `show server status` [V:FX] · `show processes` (local-mgmt) [V:FX] · `scope eth-uplink` → `scope fabric a` → `show interface` [V:FX prompt sample] · `show system firmware` [ntc template exists] · `show fault` · `show chassis` · `show app-instance` · `show version` [unverified].

## 7. Dangerous commands (FTD CLI `>`)
- `configure manager delete` — **resets FTD config to factory default** [V:C3]
- `configure manager add ...` — also resets config to factory default [V:C3]; `configure manager edit|local` [V:C3 TOC]
- `configure firewall routed|transparent` — changing mode **clears the device configuration** [V:C3]
- `configure high-availability ...` — enabling failover on standalone brings data interfaces down [V:C3]; `... suspend|resume|disable`
- `configure disable-ssh-access` — cuts SSH, console only [V:C3]; `configure ssh-access-list`, `configure https-access-list`, `configure disable-https-access` [V:C3 TOC]
- `configure network ipv4|ipv6 manual|dhcp|delete`, `configure network management-data-interface`, `configure network management-interface`, `configure network static-routes`, `configure network hostname|dns|mtu|speed` (mgmt reachability) [V:C3 TOC]
- `configure password`, `configure user add|delete|access|disable|password|forcereset` [V:C3 TOC]
- `configure policy rollback`, `configure raid`, `configure recovery-config`, `configure snort ...`, `configure coredump`, `configure flow-offload`, `configure inspection` [V:C3 TOC]
- `cluster disable|enable|remove unit|control-node unit|reset-interface-mode`, `cluster exec <cmd>` (runs on all units) [V:C3 TOC]
- `crashinfo force ...` (forces a crash/reload) [V:C3 TOC; semantics unverified]
- `copy` [V:C3 TOC], `file delete`, `file secure-copy` [unverified]
- `reboot`, `shutdown` (`system reboot` / `system shutdown` on FMC) [S:FMC; FTD form unverified]; `system restart` (application restart) [S:FMC]
- `system generate-troubleshoot ALL|...` (heavy, writes bundle) [S:FMC]; a `lockdown` option is irreversible without a Support hotfix [S:FMC]; exact command name (`system lockdown`?) [unverified]
- `expert`, `sudo su -` — Linux shell [V:UC, SC]; `system support diagnostic-cli` — enters Lina (then `clear conn`, `capture`, `failover active`, `debug` etc. like ASA) [V:UC]
- `connect fxos` [V:C3 TOC]; `clear conn`, `clear xlate`, `capture`, `failover active`, `no failover` [unverified on FTD CLI]
- `upgrade ...`, `install ...` [unverified]
**FXOS** (4100/9300 supervisor, or `connect fxos`):
- Transaction model: `scope ...` / `enter ...` / `create` / `set` / `delete` stage changes; prompt gets `*` (e.g. `firepower /security* #`); `commit-buffer` applies, `commit-buffer verify-only` checks, `discard-buffer` cancels [V:FX]. In appliance mode, commits may fail with `Error: Changes not allowed. Use 'connect ftd' to make changes.` [S:CC "commit-buffer not working in FTD connect fxos"].
- `connect local-mgmt` → `erase configuration` (factory reset + reboot, mgmt IP lost) [V:FX]
- `connect module 1 console`, `connect ftd`, `connect asa` (into app) [unverified, from memory]
- `scope chassis 1` → `reboot` / `shutdown`?, `scope ssa` → `scope slot 1` → `restart`, `scope firmware` → `auto-install` [unverified, from memory]
- `scope eth-uplink` → `scope fabric a` → `enter interface Ethernet1/1` → `disable` [unverified]

## 8. Fingerprint
- SSH banner: FTD/FXOS run Linux; OpenSSH banner `SSH-2.0-OpenSSH_x.y` [unverified, from memory]; not discriminating.
- After login: Cisco banner `Copyright 2004-20xx, Cisco and/or its affiliates...` then `Cisco Firepower Extensible Operating System (FX-OS) v2.x.y (build z)` and `Cisco Firepower Threat Defense for <model> v7.x.y (build z)` before `>` [unverified, from memory].
- `show version` (FTD CLI): `-------------------[ firepower ]--------------------` / `Model : Cisco Firepower 2130 Threat Defense (77) Version 7.2.5 (Build 208)` / `UUID : ...` [unverified, from memory]; netmiko autodetect pattern `Cisco Firepower` [V: netmiko ssh_autodetect.py].
- Prompt `> ` alone (no hostname) is a strong FTD signal [V:UC].
- FXOS `show system firmware` sample [V:NTC]: `    Version: 2.16(0.128)` / `    Startup-Vers: 2.16(0.128)`.
