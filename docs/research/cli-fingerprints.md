# SSH server identification strings (pre-auth fingerprint)

Researched 2026-11. The banner is the first line the server sends (`SSH-<proto>-<softwareversion>[ comments]\r\n`, RFC 4253).
Tags: **V** = seen in a fetched source; **P** = partially verified (community report only); **U** = `[unverified, from memory]`.
Primary source: NMAP = nmap `nmap-service-probes` https://svn.nmap.org/nmap/nmap-service-probes (curl; regexes quoted verbatim).

| Platform | Banner (example) | Tag | Source / note |
|---|---|---|---|
| Cisco IOS / IOS-XE | `SSH-2.0-Cisco-1.25`; `SSH-1.99-Cisco-1.25` if SSHv1 also on | V (regex) / P (1.25) | NMAP `match ssh m\|^SSH-(\d[\d.]+)-Cisco-(\d[\d.]+)\r?\n$\| p/Cisco SSH/ ... o/IOS/`; also `^SSH-(\d[\d.]+)-CiscoIOS_([\d.]+)XA` (IOS XA). `1.25` value from ASA/IOS debug logs on Cisco Community. |
| Cisco NX-OS | `SSH-2.0-OpenSSH_<ver> FIPS` (NX-OS 9.x+ OpenSSH) | V (regex) | NMAP `match ssh m\|^SSH-([\d.]+)-OpenSSH_([\w_.-]+) FIPS\r\n\| p/OpenSSH/ ... i/protocol $1; Cisco NX-OS/ d/switch/`. Older NX-OS also plain OpenSSH (U). |
| Arista EOS | `SSH-2.0-OpenSSH_<ver>` (Linux OpenSSH) | U | No Arista-specific nmap match. Not discriminating; use `show version` (`Arista DCS-...`). |
| Juniper Junos | `SSH-2.0-OpenSSH_<ver>` (FreeBSD/Junos-built OpenSSH) | U | No Junos-specific nmap match. (ScreenOS, not Junos: `^SSH-([\d.]+)-NetScreen` — V NMAP.) |
| Palo Alto PAN-OS | OpenSSH-based; exact banner not confirmed (some builds report a custom/obscured string) | U | PAN advisory CVE-2016-6210 says PAN-OS uses OpenSSH (https://security.paloaltonetworks.com/CVE-2016-6210). No nmap PAN-OS match. |
| Fortinet FortiOS | Older: `SSH-2.0-FortiSSH_<ver>`; newer: random 5–15 char token (illustrative shape: `SSH-2.0-<random>`) | V | NMAP `^SSH-([\d.]+)-FortiSSH_([\d.]+)\r?\n`; comment "FortiSSH uses random server name" with two heuristic regexes → `cpe:/o:fortinet:fortios`; also `^SSH-([\d.]+)-xxxxxxx\r?\n` → "Fortinet VPN/firewall sshd". |
| Cisco IOS-XR | `SSH-1.99-Cisco-2.0` (v1+v2); presumably `SSH-2.0-Cisco-2.0` when v2-only | P / U | Cisco Community log ("unable to ssh from XR router to ubuntu server"); `show ssh` prints `Cisco-2.0`. Matches the same nmap Cisco regex (→ "IOS"), so version `2.0` vs `1.25` is the only hint. XR 7.x may use OpenSSH (U). |
| Cisco ASA | `SSH-2.0-Cisco-1.25`; older `SSH-1.99-Cisco-1.25` | P | ASA `debug ssh` shows `SSH0: Exchanging versions - SSH-2.0-Cisco-1.25` (Cisco Community "what is Cisco-1.25", "ASA SSH not connecting with cipher error"). Same as IOS. 9.17.1+ has a new Cisco SSH stack (cisco-sa-asa-ssh-keybypass-cr5xPUSf); banner change U. |
| Cisco C9800 (IOS-XE) | `SSH-2.0-Cisco-1.25` | U | Same IOS-XE SSH stack assumed. |
| Cisco AireOS WLC | `SSH-2.0-CISCO_WLC` | **V** | NMAP `match ssh m\|^SSH-([\d.]+)-CISCO_WLC\r\n\| p/Cisco Wireless LAN Controller sshd/` and `^SSH-2\.0-CISCO_WLC\n`; netmiko autodetect `cisco_wlc` uses `_autodetect_remote_version` with pattern `CISCO_WLC` (https://github.com/ktbyers/netmiko/blob/develop/netmiko/ssh_autodetect.py). Unique. |
| Cisco SB (SG300/SG350/CBS) | not confirmed; one report of `OpenSSH_7.3p1` from CBS350 | P (weak) | Cisco Community "SSH access to CBS350 ... not PoSh"; may be misread. Older SB firmware may be an embedded stack (U). |
| Cisco FTD / FXOS | `SSH-2.0-OpenSSH_<ver>` | U | Linux-based; not discriminating. |

Other Cisco-ish banners in NMAP (V): `^SSH-([\d.]+)-IPSSH-([\d.]+)` (Cisco/3com IPSSHd), `^SSH-1\.5-X` (Cisco VPN 3000), `^SSH-([\d.]+)-1\.00\r\n` (Cisco IP phone), `Could not load host key. Closing connection...` (misconfigured Cisco switch, no RSA key). Also MikroTik `^SSH-([\d.]+)-ROSSSH` and Mocana `^SSH-2\.0-Mocana SSH` (embedded devices).

## Practical guidance for Hopline
- Banner is decisive only for **AireOS** (`CISCO_WLC`) and **FortiOS** (`FortiSSH_` / random token). `Cisco-1.25` means "Cisco proprietary stack" (IOS, IOS-XE, ASA, 9800); `Cisco-2.0` suggests IOS-XR.
- `OpenSSH_*` covers NX-OS, EOS, Junos, PAN-OS, FTD/FXOS and possibly SB: fall through to prompt shape and the first `show version` line.
- Second-stage signals (see per-platform files):
  - XR: prompt `RP/0/RP0/CPU0:host#`; `show version` → `Cisco IOS XR Software, Version`.
  - ASA: `Cisco Adaptive Security Appliance Software Version`.
  - FTD: bare `> ` prompt; `show version` contains `Cisco Firepower` (netmiko autodetect).
  - AireOS: `(Cisco Controller)` + second `User:` prompt; `show sysinfo` → `Product Name..... Cisco Controller`.
  - SB: ANSI escapes, second `User Name:` prompt; `show version` → `SW version` or `Active-image: flash://system/images/`.
  - 9800: IOS-XE `show version` with `C9800` model/image.
- Banners can be changed by admins on some platforms (e.g. OpenSSH `VersionAddendum`) and are spoofable; never base guard *permissions* on them, only on the classifier's default profile.
