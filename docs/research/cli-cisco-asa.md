# Cisco ASA CLI notes (guard / command-tree input)

Researched 2026-11. `[V:src]` = checked in fetched text; `[unverified, from memory]` = not checked.
Tag `[S:src]` = seen only in a web-search result summary (page not fetched) — NOT verified. Untagged claims = `[unverified, from memory]`.
Sources:
- NM = netmiko `cisco_asa_ssh.py` https://github.com/ktbyers/netmiko/blob/develop/netmiko/cisco/cisco_asa_ssh.py (curl)
- SC = scrapli_community `cisco_asa.py` + `sync_driver.py` https://github.com/scrapli/scrapli_community/tree/main/scrapli_community/cisco/asa (curl)
- G72 = ASA 7.2 CLI guide (search snippet) https://www.cisco.com/en/US/docs/security/asa/asa72/configuration/guide/cli.html
- CR = ASA command reference mirror https://www3-realm.cisco.com/en/US/docs/security/asa/command-reference/ (504 at fetch; search snippets only)
- CC = Cisco Community threads (cited inline; search summaries only, so `[S:CC]`)
- NTC = https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_asa

## 1. Prompts and modes
| Mode | Prompt | Tag |
|---|---|---|
| User EXEC | `host>` | [V:SC regex] |
| Privileged | `host#` | [V:SC] |
| Config | `host(config)#`, `host(config-if)#`, `host(config-network-object)#` | [V:SC regex]; sub-mode names [unverified, from memory] |
| Multi-context (system/ctx) | `host/ctxname#`, `host/ctxname(config)#`; system space `host#` | regex allows `/` [V:SC]; shape [unverified, from memory] |
| Failover state in prompt (if `prompt hostname priority state`) | `host/pri/act#` | [unverified, from memory] |
- scrapli regexes [V:SC]: exec `^[\w\./-]{1,63}>\s?$`; priv `^[\w\./-]{1,63}#\s?$`; config `^[\w\./-]{1,63}\([\w-]{0,32}\)#\s?$`.
- netmiko [V:NM]: sends `show curpriv` first; `enable` with `ssword` pattern; if no secret uses `login` (Username/Password prompt) to reach priv 15; config check `)#`; after any `changeto` it re-reads the base prompt and strips `(conf.*`.
- netmiko enters **config mode** to send `terminal width 511` (guard must allow or the session prep breaks). [V:NM]

## 2. Pager
- Disable per session: `terminal pager 0` (netmiko + scrapli both send it). [V:NM, SC]
- `pager lines 0` / `pager 0` is a **config** command saved to running-config [S: CC "show the complete configuration without breaks"; CR `show running-config pager`]. Classify as config, not session.
- ASA 7.0+ moved `terminal pager` to global-config-capable; session only, not saved [S:CR 7.1].
- More prompt: `<--- More --->` [unverified, from memory; CR text shows "---More---"].

## 3. Error strings
- scrapli failure list [V:SC]: `% Invalid input detected`, `% Ambiguous command`, `% Incomplete command`.
- Full form (caret line under offending token): `ERROR: % Invalid input detected at '^' marker.` [unverified, from memory].
- `ERROR: Command authorization failed` [unverified, from memory].

## 4. Confirmation prompts
| Trigger | Text | Tag |
|---|---|---|
| `write erase` | `Erase configuration in flash memory? [confirm]` | [S:CC "ASA erase config" threads] |
| `reload` | `Proceed with reload? [confirm]`; unsaved: `System config has been modified. Save? [Y]es/[N]o:` | [unverified, from memory] |
| `copy` | `Source filename [...]?`, `Destination filename [...]?` (skip with `copy /noconfirm`) | [unverified, from memory] |
| `delete` | `Delete filename [...]?` then `Delete disk0:/x? [confirm]` (`/noconfirm` skips) | [unverified, from memory] |
| `configure factory-default` | `Based on the management IP address and mask, the DHCP address pool size is reduced...` / `Do you wish to proceed? [confirm]` | [unverified, from memory] |
| `crypto key zeroize rsa` | `WARNING: All RSA keys will be removed... Do you really want to remove these keys? [yes/no]:` | [unverified, from memory] |
- Guard: `/noconfirm` flag removes the safety prompt; treat its presence as aggravating.

## 5. Pipes / output modifiers
- `show <cmd> | {include | exclude | begin | grep [-v]} <regexp>` [S: G72 + CR search snippets; pages not fetched]. Same filter set verified for FTD diagnostic/Lina CLI in cli-cisco-ftd.md [V:UC].
- Only **one** filter per command; chaining not supported [S:CC "ASA multiple show command filters"].
- No `| redirect`/`| append` found in docs [not found]; file writes go via `copy`, `capture ... ` + `copy /pcap capture:`, `write net`, `write memory`.
- `more system:running-config` shows config incl. secrets in clear-ish form [S:CR]. Read-only but sensitive.

## 6. Daily read-only commands
ntc templates exist for: `show version`, `show running-config ...` (object, object-group, access-group, crypto map, tunnel-group, ipsec), `show access-list [brief]`, `show arp`, `show asp drop`, `show bgp summary`, `show cpu usage detailed`, `show crypto ikev1 sa detail`, `show crypto ipsec sa`, `show failover`, `show interface [detail]`, `show interface ip brief`, `show inventory`, `show license all`, `show logging`, `show module [details]`, `show nat`, `show ospf neighbor`, `show port-channel summary`, `show resource usage`, `show route`, `show vpn-sessiondb [anyconnect|detail l2l]`, `show xlate`, `dir`, `ping`. [V:NTC]
Also (from memory): `show run` (abbrev OK), `show startup-config`, `show conn count`, `show conn [address X]`, `show local-host`, `show context` / `show context detail`, `show mode`, `show firewall`, `show failover state`, `show monitor-interface`, `show cluster info`, `show capture [name]`, `show service-policy`, `show threat-detection rate`, `show memory`, `show clock`, `show ssh sessions`, `show curpriv`, `show blocks`, `show traffic`.
- `packet-tracer input <if> <proto> <src> <sport> <dst> <dport> [detailed|xml]` [S: Cisco TAC doc syntax]. Whether it is pure simulation is **unverified**: one Cisco deck notes a capture saw packet-tracer "generate real packet". Newer releases may have `transmit`/`bypass-checks`/`persist` options [unverified, from memory]; classify `packet-tracer` as non-read (diagnostic) and `transmit` as disruptive.
- `ping`, `traceroute` send real packets (benign but not pure read).

## 7. Dangerous commands
**Erase / replace config**
- `write erase` (startup) [S:CC]; `clear configure all` (running; keeps licenses/enable pw per CC); `clear configure <feature>` (e.g. `clear configure access-list` wipes ACLs) [CR family]; `configure factory-default [ip mask]` [S:CC]; `configure net`/`configure memory` (merge from TFTP/startup) [unverified, from memory]; `copy <src> running-config` (merge) / `copy <src> startup-config`.
- `write memory` / `copy run start` (persist) — config-class, not destructive per se.
**Reload / HA**
- `reload [in|at|quick|noconfirm|save-config]` [unverified flags, from memory]; `failover active` (become active, switch standby→active), `no failover active` (go standby) [S: CR]; `no failover` (break HA), `failover reload-standby`, `failover exec mate <cmd>` (runs on peer!), `failover active group N` [unverified, from memory]; `cluster remove unit`, `no enable` under cluster group [unverified].
**Traffic drop / state**
- `clear conn [all|address X]`, `clear xlate`, `clear local-host` (drops sessions), `clear crypto ipsec sa`, `clear crypto ikev1|ikev2 sa`, `vpn-sessiondb logoff all|name X`, `clear arp`, `shun <ip>` [unverified, from memory].
- `capture <name> interface X ...` (CPU/ram load; also stored) / `no capture` [unverified, from memory].
**Keys / crypto**: `crypto key zeroize rsa|ecdsa [label X|default]` (removes all keys; breaks SSH/VPN) [S:CC].
**Context**: `changeto context X` / `changeto system` — switches the admin's scope (state change for the session, not device). netmiko re-reads prompt after it [V:NM]. In system space, `context X` + `no context X` deletes a context [unverified].
**Files**: `copy`, `delete [/noconfirm] [/recursive]`, `format disk0:` / `erase disk0:`, `rename`, `mkdir`, `rmdir` [unverified, from memory].
**Software**: `boot system disk0:/asa*.bin`, `upgrade`, `asdm image` (config) [unverified, from memory].
**Shell-ish**: `debug ...` (CPU risk), `test aaa-server`, `test regex` (benign); no Linux shell on ASA; on FPR hardware `connect fxos` reaches FXOS [unverified, from memory].

## 8. Fingerprint
- SSH banner: `SSH-2.0-Cisco-1.25` [S:CC "what is Cisco-1.25": debug `SSH0: Exchanging versions - SSH-2.0-Cisco-1.25`]; older/SSHv1-enabled: `SSH-1.99-Cisco-1.25` [S:CC]. Identical to IOS, so not discriminating. Cisco's new SSH stack in 9.17.1 (cisco-sa-asa-ssh-keybypass-cr5xPUSf) — banner change [unverified].
- `show version` first lines [V:NTC cisco_asa_show_version1.raw]:
```
Cisco Adaptive Security Appliance Software Version 9.5(2)204
Device Manager Version 7.5(2)

Compiled on Mon 15-Feb-16 19:00 PST by builders
System image file is "boot:/asa952-204-smp-k8.bin"
Config file at boot was "startup-config"

asa1 up 41 days 19 hours

Hardware:   ASAv, 2048 MB RAM, CPU Pentium II 1800 MHz,
Model Id:   ASAv10
```
- netmiko autodetect patterns: `Cisco Adaptive Security Appliance`, `Cisco ASA` [V: netmiko ssh_autodetect.py]. FPR running ASA prints `Cisco Adaptive Security Appliance Software Version 9.x` too.
