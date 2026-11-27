# Cisco AireOS WLC CLI notes (2504/5508/5520/8540/vWLC, 8.x)

Researched 2026-11. `[V:src]` = checked in fetched text; `[unverified, from memory]` = not checked.
Tag `[S:src]` = seen only in a web-search result summary (page not fetched) — NOT verified. Untagged claims = `[unverified, from memory]`.
Sources:
- NM = netmiko `cisco_wlc_ssh.py` https://github.com/ktbyers/netmiko/blob/develop/netmiko/cisco/cisco_wlc_ssh.py (curl)
- AD = netmiko `ssh_autodetect.py` https://github.com/ktbyers/netmiko/blob/develop/netmiko/ssh_autodetect.py (curl)
- SC = scrapli_community `cisco_aireos.py`/`sync_driver.py` https://github.com/scrapli/scrapli_community/tree/main/scrapli_community/cisco/aireos (curl)
- NMAP = https://svn.nmap.org/nmap/nmap-service-probes (curl)
- NTC = https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_wlc_ssh
- CC = Cisco Community threads (cited inline). cisco.com/www3-realm WLC command refs returned 504/were not reachable.

## 1. Prompts and modes
| Mode | Prompt | Tag |
|---|---|---|
| Exec (top) | `(Cisco Controller) >` (default sysname) / `(WLC-NAME) >` | [V:SC regex `^\([\w. -]{1,31}\) >$`] |
| Config | `(Cisco Controller) config>` | [V:SC regex `^\([\w. -]{1,31}\) config>$`] |
| Sub-trees | `(Cisco Controller) config wlan>`? etc. (entering `config` then sub-words) | [unverified, from memory] |
- Login quirk: after SSH auth the WLC prints `(Cisco Controller)` then asks again `User:` / `Password:` (some versions also `login as`). netmiko's `special_login_handler` answers them; scrapli uses `auth_bypass: True` and writes user/pass on the channel. [V:NM, SC]
- netmiko generic prompt pattern `(?m:[>#]\s*$)`; config check string `config`; enter with `config`, leave with `exit`. [V:NM]
- Sysname is limited to 31 chars in the regex. [V:SC]
- **Key semantic:** at the top prompt, `config <anything>` executes immediately (no candidate/commit). `config` alone enters config> where lines are typed without the `config` prefix. Changes are live but **not saved** until `save config`. [unverified, from memory; consistent with NM `send_config_set(enter_config_mode=False)`]

## 2. Pager
- Disable: `config paging disable` (netmiko and scrapli on-open) [V:NM, SC]; netmiko cleanup re-enables with `config paging enable` [V:NM]. It lives in the `config` tree but is session-scoped [unverified]; guard should whitelist exactly these two lines.
- Pager text: `--More-- or (q)uit` [unverified, from memory].
- Even with paging off: `show run-config` prints `Press Enter to continue...` (or `Press any key`) and is very slow (netmiko waits ~30s after `802.11b Advanced Configuration`) [V:NM].
- `show interface summary` (and some lists) asks `Would you like to display the next 15 entries? (y/n)` [V:NM].

## 3. Error strings
- `Incorrect Usage. Use the '?' or <TAB> key to list commands.` [V:SC failed_when_contains]
- `Incorrect input!` [V:SC]
- No caret line. Ambiguous/incomplete give the same `Incorrect usage` form [unverified, from memory].

## 4. Confirmation prompts
| Trigger | Text | Tag |
|---|---|---|
| `logout` with unsaved changes | `... Would you like to save them now? (y/N)` (netmiko matches `Would you like to save them now`) | [V:NM] |
| `reset system` | `The system has unsaved changes. Would you like to save them now? (y/N)` then `Are you sure you would like to reset the system? (y/N)` | save step [S:CC]; exact text [unverified, from memory] |
| `save config` | `Are you sure you want to save? (y/n)` (netmiko answers `y`) | netmiko sends `y` [V:NM]; text [unverified] |
| `clear config` | `Are you sure you want to clear the configuration? (y/n)` | [unverified, from memory] |
| `transfer download start` | `This may take some time. Are you sure you want to start? (y/N)` | [unverified, from memory] |
| `config ap reset <ap>` | `Would you like to reset <ap> ? (y/n)` | [unverified, from memory] |
- Guard: the `y` answer is the real execution step.

## 5. Pipes / output modifiers
- No `|` pipes. Filtering is a separate command: `grep include "<pattern>" "<show command>"` and `grep exclude ...` [S:CC "extract list of APs where ip 0.0.0.0", "nesting grep commands"; single level only].
- Nothing writes files except `transfer upload ...` / `debug` to syslog.

## 6. Daily read-only commands
ntc templates exist [V:NTC]: `show sysinfo` · `show ap summary` · `show ap config general <ap>` · `show ap image all` · `show 802.11a` · `show 802.11a cleanair config` · `show advanced 802.11a channel` · `show band-select` · `show boot` · `show cdp neighbors detail` · `show client detail <mac>` · `show exclusionlist` · `show flexconnect group summary` · `show interface detailed <name>` · `show interface group summary` · `show interface summary` · `show inventory` · `show mobility anchor` · `show mobility summary` · `show port summary` · `show radius summary` · `show redundancy summary` · `show redundancy detail` · `show rf-profile summary` · `show stats port summary` · `show tacacs summary` · `show time` · `show wlan summary`.
[unverified, from memory] `show client summary` · `show run-config` (slow, interactive) · `show run-config commands` · `show running-config`? (not on AireOS) · `show wlan <id>` · `show ap join stats summary all` · `show ap auto-rf 802.11a <ap>` · `show msglog` · `show traplog` · `show license all` · `show certificate summary` · `show network summary` · `show mgmtuser` · `show loginsession` · `show 802.11b`.

## 7. Dangerous commands
- **Any `config ...` line at the top prompt** is an immediate live change [unverified semantics, see §1]. Examples: `config wlan disable <id>` (drops SSID), `config 802.11a disable network` (kills 5 GHz), `config interface address management ...` (lose mgmt), `config mgmtuser add|delete`, `config ap disable <ap>`, `config ap mgmtuser ...`, `config ap primary-base ...` (moves AP to another WLC), `config client deauthenticate <mac>`, `config exclusionlist add <mac>`, `config boot primary|backup` (changes next boot image), `config network ...`, `config redundancy mode sso` (reboots), `config paging` (benign exception).
- `config ap reset <ap>` (reboot AP), `config ap reset all`? [unverified]
- `reset system` (reboot WLC), `reset system in HH:MM:SS`, `reset system at ...`, `reset system forced` (no prompt, newer code) [S:CC], `reset peer-system` (HA) [unverified]
- `clear config` (factory wipe of saved config; with reset = factory default) [S:CC]
- `clear stats ...`, `clear ap-config <ap>` (AP to defaults) [unverified]
- `save config` (persists; needed before reset) [V:NM default save cmd]
- `transfer download datatype {code|config|webauthbundle|...}` + `transfer download start` (software/config download; `code` + reset = upgrade) [unverified]; `transfer upload start` (exports config incl. secrets) [unverified]
- `debug ...` (e.g. `debug client <mac>`, `debug capwap ...`) — CPU impact, auto-disables after 30 min [unverified]; `debug disable-all` safe.
- `config logging ...`, `config time ...`, `config certificate ...` (break joins) [unverified]
- No shell escape on AireOS [unverified, from memory].

## 8. Fingerprint
- SSH banner: `SSH-2.0-CISCO_WLC` — nmap: `match ssh m|^SSH-([\d.]+)-CISCO_WLC\r\n| p/Cisco Wireless LAN Controller sshd/` and `^SSH-2\.0-CISCO_WLC\n` [V:NMAP]; netmiko autodetect matches remote SSH version `CISCO_WLC` for `cisco_wlc` [V:AD]. Strong, unique signal.
- 8.5+ fallback: `show inventory` matches `Cisco.*Wireless.*Controller` [V:AD].
- Pre-login banner: `(Cisco Controller)` line, then `User:` prompt [V:NM docstring].
- `show sysinfo` [V:NTC cisco_wlc_ssh_show_sysinfo.raw]:
```
Manufacturer's Name.............................. Cisco Systems Inc.
Product Name..................................... Cisco Controller
Product Version.................................. 7.4.110.0
Bootloader Version............................... 1.0.16
Field Recovery Image Version..................... 1.0.0
Firmware Version................................. PIC 15.0
```
