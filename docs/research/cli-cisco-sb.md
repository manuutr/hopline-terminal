# Cisco Small Business switches (SG300/SG350/SG350X/SG550X, CBS250/CBS350) CLI notes

Researched 2026-11. `[V:src]` = checked in fetched text; `[unverified, from memory]` = not checked.
Tag `[S:src]` = seen only in a web-search result summary (page not fetched) — NOT verified. Untagged claims = `[unverified, from memory]`.
IOS-like but a different OS (Marvell-based "Sx" firmware 1.x/2.x/3.x). CBS250 CLI is limited; SG300 needs CLI enabled.
Sources:
- NM = netmiko `cisco_s300.py` https://github.com/ktbyers/netmiko/blob/develop/netmiko/cisco/cisco_s300.py (curl)
- SC = scrapli_community `cisco_cbs.py`/`sync_driver.py` https://github.com/scrapli/scrapli_community/tree/main/scrapli_community/cisco/cbs (curl)
- RL = Cisco "How to manually reload or reset a switch through the CLI (CBS)" https://www.cisco.com/c/en/us/support/docs/smb/switches/Cisco-Business-Switching/kmgmt-2542-how-to-manually-reload-or-reset-a-switch-through-the-command-cbs.html
- SX = Sx350 CLI guide via manualslib (search snippet) https://www.manualslib.com/manual/1242524/Cisco-Sx350.html?page=430
- NTC = https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_s300

## 1. Prompts and modes
| Mode | Prompt | Tag |
|---|---|---|
| User EXEC | `switch>` | [V:SC `^[a-zA-Z0-9-.]{1,58}>$`] |
| Privileged | `CBS350#` / `switchXXXXXX#` (default hostname is `switch` + MAC suffix) | [V:RL, SC]; default name [unverified, from memory] |
| Config | `CBS350(config)#` | [V:RL] |
| Sub-modes | `(config-if)#`, `(config-if-range)#`, `(config-vlan)#`, `(config-line)#` | regex `\([\w.\-@/:+]{1,32}\)#` [V:SC]; names [unverified] |
- scrapli regexes [V:SC]: exec `^[a-zA-Z0-9-.]{1,58}>$`, priv `^[a-zA-Z0-9-.]{1,58}#$`, config `^[a-zA-Z0-9-.]{1,58}\([\w.\-@/:+]{1,32}\)#$` (no trailing space; hostname up to 58 chars).
- netmiko [V:NM]: sets `ansi_escape_codes = True` (output contains ANSI codes); wait for `[>#]`; double login prompt (SSH auth then `User Name:`/`Password:`) unless `ip ssh password-auth` is configured.
- Login banner prompt `User Name:` [unverified, from memory].

## 2. Pager
- Disable: `terminal datadump` (netmiko + scrapli) [V:NM, SC]. Width: netmiko `terminal width 511`, scrapli `terminal width 0` [V].
- Pager text: `More: <space>,  Quit: q or CTRL+Z, One line: <return> ` [unverified, from memory].
- `terminal datadump` is session-only (EXEC) [unverified].

## 3. Error strings
scrapli failure list [V:SC]: `% Incomplete command`, `% Unrecognized command`, `% missing mandatory parameter`, `% bad parameter value`, `% Ambiguous command`.
- Caret line: `^` printed under the bad token? [unverified, from memory].

## 4. Confirmation prompts
| Trigger | Text | Tag |
|---|---|---|
| `copy running-config startup-config` / `write memory` | `Overwrite file [startup-config].... (Y/N)[N] ?` (netmiko answers `Y`) | `Overwrite file [startup-config]…` [V:RL]; `(Y/N)[N] ?` tail [unverified]; netmiko save = `write memory` + `Y` [V:NM] |
| `reload` | `This command will reset the whole system and disconnect your current session. Do you want to continue ? (Y/N)[N]` | first sentence [V:RL]; tail [unverified] |
| `delete startup-config` | `Delete startup-config [y/n]?` | [unverified, from memory] |
| `boot system ...` / `crypto key generate` | `Overwrite... (Y/N)[N]` style | [unverified, from memory] |
- Note uppercase `Y/N` and default `[N]`.

## 5. Pipes / output modifiers
- `| include`, `| exclude`, `| begin`, `| count` [unverified, from memory]. No file-writing pipe known.
- File writes only via `copy`.

## 6. Daily read-only commands
ntc templates [V:NTC]: `show version` · `show system` · `show system id` · `show interfaces status` · `show interfaces description` · `show interfaces switchport <if>` · `show ip interface` · `show lldp neighbors` · `show mac address-table` · `show vlan`.
[V:RL] `show reload`.
[unverified, from memory] `show running-config` · `show startup-config` · `show inventory` · `show bootvar` · `show logging` · `show clock` · `show users` · `show cdp neighbors` · `show spanning-tree` · `show interfaces counters` · `show interfaces GigabitEthernet1/0/1` · `show ip route` · `show arp` · `show power inline` · `show env all` · `show cpu utilization` · `show ip ssh` · `show port-channel` / `show interfaces port-channel` · `show stack` (SG350X/SG550X) · `show system mode` (Sx300) · `show lldp neighbors detail`.

## 7. Dangerous commands
- `reload` [V:RL]; `reload in hhh:mm|mmm`, `reload at hh:mm [day month]` (scheduled) [V:RL]; `reload cancel` (safe) [V:RL]; `reload slot N` (stack) [unverified]
- `delete startup-config` (factory-default on next boot) [S: Sx350 guide via manualslib]; `delete flash://...` [S: same]
- `copy running-config startup-config` / `write memory` / `write` (persist) [V:RL, NM]; `copy tftp://... running-config|startup-config|image` (replace/merge/upgrade); `copy ... flash://`; `copy startup-config tftp://` (exports secrets) [unverified]
- `boot system image-1|image-2|inactive-image` (changes next boot image) [unverified, from memory]
- `set system mode router|switch` (Sx300; deletes config and reboots) [unverified, from memory]
- `crypto key generate rsa`/`dsa` (regenerates SSH keys; breaks known_hosts) [unverified]
- `clear arp-cache`, `clear mac address-table dynamic`, `clear logging`, `clear counters` [unverified]
- In config: `shutdown` on uplink, `no ip address` / `ip address dhcp` on mgmt VLAN, `management vlan` change, `no ip ssh server`, `username ... privilege`, `enable password` [unverified]
- `stack ...` / `stack unit` renumber (stack reboot) [unverified]
- No shell escape known. Firmware upgrade = `copy tftp://... flash://system/images/...` + `boot system inactive-image` + `reload` [unverified].

## 8. Fingerprint
- SSH banner: not confirmed. One CC user saw `OpenSSH_7.3p1` from a CBS350 [S:CC "SSH access to CBS350 ... not PoSh"] — weak, possibly client string [unverified]. Not discriminating anyway.
- Distinct signals: ANSI escapes in output [V:NM]; second login prompt after SSH auth (netmiko docstring: "disable SG300 from prompting for username twice") [V:NM]; prompt text `User Name:` [unverified]; `show version` format below.
- `show version` (1.x firmware) [V:NTC cisco_s300_show_version.raw]:
```
SW version    1.3.7.18 ( date  12-Jan-2014 time  18:02:59 )
Boot version    1.1.0.6 ( date  11-May-2011 time  18:31:00 )
HW version    V02
```
- `show version` (2.x/3.x, Sx350/CBS) [V:NTC cisco_s300_show_version2.raw]:
```
Active-image: flash://system/images/image1.bin
  Version: 2.4.0.94
  MD5 Digest: 6f5be217100f34929986f2e93dd2d5e9
  Date: 31-May-2018
```
- `show system` [V:NTC]: `System Description:                       24-Port 10/100 PoE Managed Switch`, `System Object ID:                         1.3.6.1.4.1.9.6.1.82.24.2` (OID prefix `1.3.6.1.4.1.9.6.1` = Cisco SB [unverified, from memory]).
