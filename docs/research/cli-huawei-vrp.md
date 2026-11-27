# Huawei VRP CLI notes

Short notes behind `packages/cli-model/src/trees/vrp.ts` and `profiles-tier2.ts`. Unless a line has a source, it is `[unverified, from memory]`. Check it against the Huawei command reference for the product line (CE, S, NE, AR differ) before the platform is offered in the app.

## Prompts and views
- User view `<HUAWEI>`. `system-view` enters the system view `[HUAWEI]`. Sub-views show the object: `[HUAWEI-GigabitEthernet0/0/1]`, `[HUAWEI-Vlanif10]`, `[HUAWEI-bgp]`, `[HUAWEI-ospf-1]`, `[HUAWEI-vlan10]`, `[HUAWEI-vpn-instance-RED]`.
- Two-stage platforms (CE, NE) show `[~HUAWEI]`; `[*HUAWEI]` means there are uncommitted changes, which `commit` applies.
- `quit` goes up one view, `return` (or Ctrl+Z) goes back to the user view. `undo` negates.

## Pager
- `  ---- More ----`. Disable for the session with `screen-length 0 temporary` (user view).

## Errors
- `Error: Unrecognized command found at '^' position.`, `Error: Ambiguous command found at '^' position.`, `Error: Incomplete command found at '^' position.`, each under a caret line.

## Confirmations
- `save`: `Are you sure to continue?[Y/N]:`. `reboot`: `System will reboot! Continue?[Y/N]:`. `reset saved-configuration`: `The action will delete the saved configuration in the device. ... Continue? [Y/N]:`.

## Pipes
- `| include`, `| exclude`, `| begin`, `| count` (regex filters). Nothing that writes files is modelled, so anything else is blocked.

## Read-only daily commands
`display version`, `display device`, `display interface brief`, `display ip interface brief`, `display current-configuration [| include x]`, `display saved-configuration`, `display ip routing-table [vpn-instance X]`, `display bgp peer`, `display ospf peer brief`, `display vlan`, `display lldp neighbor brief`, `display eth-trunk`, `display mac-address`, `display arp`, `display alarm active`, `display logbuffer`, `display cpu-usage`, `display memory-usage`, `display this` (in any view).

## Dangerous commands (guard)
- Blocked: `reboot`, `reset saved-configuration`, `startup saved-configuration|system-software|patch ...` (next-boot files), `format`, `delete`, `copy`, `move`, `rename`, `ftp`/`tftp`/`sftp`/`scp`, `patch`, `upgrade`, `rollback configuration`, `clear configuration` (system view), `license`.
- Disruptive: `reset bgp|ospf|isis|arp|mac-address|mpls ...`, `undo bgp|ospf|isis`, `undo vlan`, `undo interface`, `aaa`/`local-user`/`user-interface` changes, `ip binding vpn-instance`.
- Config (approval): `system-view`, `save`, `screen-length 0 temporary`, `reset counters`, `debugging`.

## Fingerprint
- `display version`: `Huawei Versatile Routing Platform Software` then `VRP (R) software, Version 8.180 (...)`.
- SSH server string `SSH-2.0-HUAWEI-1.5` `[unverified]`. The `<host>` prompt is distinctive.
