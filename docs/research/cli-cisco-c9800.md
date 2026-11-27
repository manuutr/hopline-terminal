# Cisco Catalyst 9800 WLC (IOS-XE) CLI notes

Researched 2026-11. `[V:src]` = checked in fetched text; `[unverified, from memory]` = not checked.
Tag `[S:src]` = seen only in a web-search result summary (page not fetched) — NOT verified. Untagged claims = `[unverified, from memory]`.
The 9800 runs IOS-XE 16.10+/17.x, so everything in `cli-cisco-ios.md` (IOS-XE) applies; this file lists the wireless deltas.
Sources:
- TN = Cisco TAC "Catalyst 9800 common ... commands" 213970 https://www.cisco.com/c/en/us/support/docs/wireless/catalyst-9800-series-wireless-controllers/213970-catalyst-9800-wireless-controllers-commo.html
- SC = scrapli `cisco_iosxe.yaml` https://github.com/carlmontanari/scrapli/blob/main/scrapli/definitions/cisco_iosxe.yaml (fetched, summarised)
- NM = netmiko: no 9800-specific driver; use `cisco_ios`/`cisco_xe` (netmiko/cisco/cisco_ios.py) [unverified that no driver exists]
- CC = Cisco Community "reboot access points on 9800 WLC via CLI" https://community.cisco.com/t5/wireless/reboot-access-points-on-9800-wlc-via-cli-command/m-p/4601862

## 1. Prompts and modes
| Mode | Prompt | Tag |
|---|---|---|
| User EXEC | `WLC>` | [V:SC exec `>`] |
| Privileged | `WLC#` | [V:SC] |
| Config | `WLC(config)#` | [V:SC] |
| WLAN | `WLC(config-wlan)#` (`wlan <name> <id> <ssid>`) | [unverified, from memory] |
| Policy profile | `WLC(config-wireless-policy)#` (`wireless profile policy X`) | cmd [V:TN]; prompt [unverified] |
| Tags | `(config-policy-tag)#`, `(config-site-tag)#`, `(config-rf-tag)#` | [unverified, from memory] |
| AP profile | `(config-ap-profile)#` | [unverified, from memory] |
| tclsh | `WLC(tcl)#` | mode exists [V:SC `tclsh`/`tclquit`]; prompt [unverified] |
- scrapli iosxe: on open enters privileged_exec, `terminal width 512`, paging disabled; modes exec/privileged_exec/configuration/tclsh [V:SC].
- Prompt regex: same as IOS-XE (`^[\w.\-@/:]{1,63}#\s?$`, config `\(config[\w.\-@/:]{0,32}\)#`) [unverified for iosxe file; verified identical pattern in scrapli iosxr file].
- HA SSO pair: standby console prompt `WLC-stby>` [unverified, from memory].

## 2. Pager
- `terminal length 0` (session) [V:SC "disables paging"; exact command from IOS convention]. `--More--` [unverified, from memory].

## 3. Error strings
- scrapli iosxe failure indicators [V:SC]: `% Ambiguous command`, `% Unknown command`, `% Invalid input detected`, `Command authorization failed`.
- `% Incomplete command.` and caret form `% Invalid input detected at '^' marker.` [unverified, from memory].

## 4. Confirmation prompts (IOS-XE)
- `reload`: `Proceed with reload? [confirm]`; unsaved: `System configuration has been modified. Save? [yes/no]:` [unverified, from memory].
- `write erase`: `Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]` [unverified, from memory].
- `ap name X reset`: no prompt [unverified]. `wireless client mac-address X deauthenticate`: no prompt [unverified].
- `redundancy force-switchover`: `Proceed with switchover to standby RP? [confirm]` [unverified, from memory].

## 5. Pipes / output modifiers (IOS-XE)
- `| include`, `| exclude`, `| begin`, `| section`, `| count`, `| format` (read) [unverified, from memory; see cli-cisco-ios.md].
- **Write files:** `| redirect <url>`, `| append <url>`, `| tee <url>` [S:CC IOS post lists `append`, `redirect`].
- **Write files (wireless-specific):** `show logging profile wireless filter {mac|ip} <x> to-file <bootflash:name>` and `show logging profile wireless internal ... to-file ...` [V:TN]. A `show` that writes a file — guard must check `to-file`.

## 6. Daily read-only commands
[V:TN] `show clock` · `show logging` · `show debugging` · `show wireless client mac-address <mac> detail` · `show wireless profile policy detailed <name>` · `show vlan brief` · `more bootflash:<file>` · `dir bootflash:`
[unverified, from memory] `show version` · `show running-config` · `show wireless summary` · `show wireless client summary` · `show ap summary` · `show ap uptime` · `show ap cdp neighbors` · `show ap config general` · `show ap name <ap> config general` · `show ap dot11 5ghz summary` · `show ap dot11 24ghz summary` · `show ap tag summary` · `show wlan summary` · `show wlan name <x>` · `show wireless tag policy summary` · `show wireless tag site summary` · `show wireless profile policy summary` · `show wireless stats ap join summary` · `show wireless mobility summary` · `show wireless country configured` · `show wireless management trustpoint` · `show ap rf-profile summary` · `show redundancy` · `show chassis` · `show platform software ...` · `show ip interface brief` · `show interfaces` · `show license summary` · `show install summary` · `show logging profile wireless` (no `to-file`).

## 7. Dangerous commands
**Wireless-specific**
- `wireless client mac-address <mac> deauthenticate` (kicks client) [V:TN]
- `ap name <ap> reset` (reboots AP) [S:CC]; `ap name <ap> reset capwap` (restarts CAPWAP join only) [S:CC]
- `clear ap config <ap>` / `ap name <ap> erase ...` / `ap name <ap> no dot11 ... shutdown`, `ap name X dot11 5ghz shutdown` [unverified, from memory]
- `ap dot11 {5ghz|24ghz} shutdown` (disables band network-wide; config) [unverified]; `ap dot11 ... rrm channel dca ...` (config, RF churn) [V:TN cmd exists]
- `wlan X` → `shutdown`/`no shutdown`; `wireless profile policy X` → `shutdown` (drops all clients on that profile) [V:TN cmds]
- `security wpa psk set-key ascii 0 <pw>` (exposes PSK in clear in history) [V:TN]
- `debug wireless mac <mac> [monitor-time N]` (RA trace; writes `ra_trace_*.log` to bootflash) [V:TN]; `clear platform condition all` [V:TN]
- `wireless config vwlc-ssc ...`, `wireless management trustpoint` (cert; breaks AP join) [unverified]
- `ap name X image predownload`, `ap image predownload` (AP upgrade) [unverified]
**IOS-XE general** (see cli-cisco-ios.md): `reload`, `write erase`/`erase startup-config`/`erase nvram:`, `configure replace`, `copy ... running-config|startup-config`, `copy bootflash:X tftp://...` [V:TN example], `delete`, `format`, `install add file ... activate commit` / `install remove inactive`, `redundancy force-switchover`, `tclsh` (runs Tcl) [V:SC mode], `guestshell`/`app-hosting` [unverified], `request platform software ...` [unverified], `clear ...`.
- 9800 has config sync to standby; `write memory` persists both [unverified].

## 8. Fingerprint
- SSH banner: same Cisco stack as IOS-XE, `SSH-2.0-Cisco-1.25` [unverified, from memory] (nmap regex `^SSH-(\d[\d.]+)-Cisco-(\d[\d.]+)` → IOS).
- `show version` first line (IOS-XE): `Cisco IOS XE Software, Version 17.09.04a` then `Cisco IOS Software [Cupertino], C9800 Software (C9800_IOSXE-K9), Version 17.9.4a, RELEASE SOFTWARE (fc3)` [unverified, from memory; no ntc 9800 sample found]. Model line `cisco C9800-40-K9 (...) processor` / `C9800-CL-K9` [unverified].
- Discriminators vs a Catalyst switch: image name `C9800_IOSXE-K9` / model `C9800-*`; `show wireless summary` succeeds.
