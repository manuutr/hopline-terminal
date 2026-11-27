# HPE Aruba AOS-CX CLI notes

Short notes behind `packages/cli-model/src/trees/aoscx.ts` and `profiles-tier2.ts`. Unless a line has a source, it is `[unverified, from memory]` and needs a check against the AOS-CX Command-Line Interface Guide for the target release (10.x) before the platform is offered in the app.

## Prompts and modes
- Manager `sw1#`, operator `sw1>`, global config `sw1(config)#`, sub-modes `sw1(config-if)#`, `(config-vlan-10)#`, `(config-lag-if)#`, `(config-bgp)#`, `(config-vrf)#`.
- `do <cmd>` runs an exec command from config. `end` and `exit` leave.

## Pager
- `-- MORE --, next page: Space, next line: Enter, quit: Control-C`. Disable with `no page` (session), re-enable with `page`.

## Errors
- `Invalid input: <token>` and `% Command incomplete.`. There is no caret line.

## Pipes
- `| include`, `| exclude`, `| begin`, `| count`. `| redirect` (some releases) writes a file, so it is blocked. Chaining is not modelled; every `|` splits a stage (conservative).

## Read-only daily commands
`show version`, `show system`, `show interface brief`, `show interface <if>`, `show vlan`, `show ip route [vrf X|all-vrfs]`, `show bgp all summary`, `show ip ospf neighbors`, `show lldp neighbor-info`, `show lacp interfaces`, `show mac-address-table`, `show arp`, `show running-config`, `show vsx status`, `show environment`, `show logging -r`, `show events`, `show checkpoint`, `checkpoint diff`.

## Dangerous commands (guard)
- Blocked: `boot system ...` (this is how AOS-CX reboots), `erase startup-config`, `erase all zeroize`, `copy ...` (except `copy running-config startup-config`), `checkpoint rollback`, `start-shell`, `diag`, `diagnostics`, `vsx update-software`, `vsf ...`, `delete`, `zeroize`.
- Disruptive: `clear bgp`, `clear arp`, `clear mac-address-table`, `clear ip route`, `vlan trunk allowed <list>` (replaces the list), `no routing`, `vrf attach`, removing VLANs, interfaces or routing processes, `user`/`aaa`/`ssh`/`https-server` changes.

## Fingerprint
- `show version` prints an `ArubaOS-CX` banner block and `Version : FL.10.13.1000` (two-letter platform prefix). The SSH server string is OpenSSH (not distinctive).
