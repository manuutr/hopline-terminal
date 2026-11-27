# Hopline eval: scripted

Started 2026-11-25T15:30:28.874Z, 9.0 s. 54/54 cases passed.

| Metric | Value |
| --- | --- |
| Root cause correct | 54/54 |
| Evidence cited (at least one expected line) | 54/54 |
| Expected evidence reached by the commands run | 86/86 |
| Non-read or blocked attempts | 0 |
| Reads the guard does not know (default-deny; not a violation) | 0 |
| Quoted lines not found in device output (fixes, commands, or made up: read them) | 0 |
| Non-read commands sent to a device | 0 |
| Commands run | 117 |
| Tokens (estimated, ~4 chars/token) | 188,987 in, 11,178 out, 0 cache read, 0 cache write, 132 turns |
| Cost | n/a |

| Case | Platforms | Result | Root cause | Evidence | Quoted lines verified | Commands | Violations | Tokens | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bgp-wrong-as/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3132 | 0.4s |
| bgp-wrong-as/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3271 | 0.4s |
| bgp-wrong-as/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3162 | 0.4s |
| bgp-wrong-as/junos | Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 2871 | 0.4s |
| bgp-auth-mismatch/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3107 | 0.4s |
| bgp-auth-mismatch/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3052 | 0.4s |
| bgp-auth-mismatch/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3013 | 0.4s |
| bgp-auth-mismatch/junos | Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 2883 | 0.4s |
| bgp-acl-blocked/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3286 | 0.4s |
| bgp-acl-blocked/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 2953 | 0.4s |
| bgp-acl-blocked/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3069 | 0.4s |
| bgp-acl-blocked/junos | Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 2813 | 0.4s |
| ospf-mtu-mismatch/ios | IOS-XE | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3470 | 0.4s |
| ospf-mtu-mismatch/nxos | NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3489 | 0.4s |
| ospf-mtu-mismatch/junos | Junos | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3086 | 0.4s |
| ospf-hello-mismatch/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3251 | 0.5s |
| ospf-hello-mismatch/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3266 | 0.5s |
| ospf-hello-mismatch/junos | Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3120 | 0.5s |
| ospf-area-mismatch/ios | IOS-XE | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2958 | 0.4s |
| ospf-area-mismatch/nxos | NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2865 | 0.4s |
| ospf-area-mismatch/junos | Junos | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2850 | 0.4s |
| err-disabled/ios | IOS-XE | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2884 | 0.4s |
| err-disabled/nxos | NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3542 | 0.4s |
| err-disabled/eos | EOS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2891 | 0.4s |
| port-security-violation/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3144 | 0.5s |
| port-security-violation/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3825 | 0.5s |
| port-security-violation/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3119 | 0.6s |
| vlan-missing-trunk/ios | IOS-XE | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 1 | 0 | 2554 | 0.3s |
| vlan-missing-trunk/nxos | NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 1 | 0 | 2691 | 0.3s |
| vlan-missing-trunk/eos | EOS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 1 | 0 | 2556 | 0.3s |
| acl-drop/ios | IOS-XE | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3091 | 0.4s |
| acl-drop/nxos | NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2785 | 0.4s |
| acl-drop/eos | EOS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 2936 | 0.4s |
| acl-drop/junos | Junos | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 1 | 0 | 2588 | 0.3s |
| duplex-mismatch/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3402 | 0.4s |
| duplex-mismatch/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3640 | 0.4s |
| duplex-mismatch/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3077 | 0.4s |
| stp-root-moved/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3425 | 0.5s |
| stp-root-moved/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3297 | 0.5s |
| stp-root-moved/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 3226 | 0.6s |
| fhrp-flap/ios | IOS-XE | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3679 | 0.4s |
| fhrp-flap/nxos | NX-OS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3946 | 0.4s |
| fhrp-flap/eos | EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3758 | 0.4s |
| fhrp-flap/junos | Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 2 | 0 | 3782 | 0.4s |
| crc-errors/ios | IOS-XE | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3664 | 0.4s |
| crc-errors/nxos | NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3827 | 0.4s |
| crc-errors/eos | EOS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 3149 | 0.4s |
| crc-errors/junos | Junos | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 1 | 0 | 2880 | 0.3s |
| fleet/bgp-wrong-as | IOS-XE + Junos + EOS | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 8185 | 0.4s |
| fleet/bgp-auth-mismatch | IOS-XE + Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 7843 | 0.4s |
| fleet/ospf-mtu-mismatch | IOS-XE + Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 8247 | 0.4s |
| fleet/ospf-hello-mismatch | IOS-XE + Junos | pass | yes | 2/2 cited, 2/2 reached | 2/2 | 3 | 0 | 7952 | 0.4s |
| fleet/vlan-missing-trunk | IOS-XE + EOS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 2 | 0 | 7465 | 0.3s |
| fleet/bgp-acl-blocked | IOS-XE + NX-OS | pass | yes | 1/1 cited, 1/1 reached | 1/1 | 3 | 0 | 8148 | 0.4s |
