# Competitor research: terminal clients for network engineers

Research date: 2026-11-24. Products covered: **SecureCRT** (VanDyke), **MobaXterm** (Mobatek), **Termius**, **Tabby**, **Royal TS / Royal TSX** (Royal Apps).

Purpose: decide what Hopline v1 must do so a network engineer can switch from SecureCRT or MobaXterm on day one. The appendices give enough detail to build session importers.

## 0. Method, evidence tiers, and limitations

How confident each claim is:

- **[V] Vendor:** official docs, feature pages, pricing pages or changelogs.
- **[F] Real file:** a configuration file produced by the real product, found in public GitHub repos.
- **[3P] Third party:** open-source importer code, reverse-engineering notes or security-tool docs. Useful, but may be wrong.
- **[U] User report:** a forum, review or community comment. Anecdotal.
- **?** means I could not confirm it either way. It does **not** mean "no".

Limitations:

- **Reddit:** reddit.com is blocked to the research tooling. I read one r/networking thread in full through its Internet Archive copy: "What terminal do you use?", January 2025, about 110 comments ([archived copy](http://web.archive.org/web/20250328021745/https://www.reddit.com/r/networking/comments/1ibwkny/what_terminal_do_you_use/)). I could not read other r/networking or r/ccna threads, and no claim in this document is attributed to a Reddit thread I did not read.
- **Other user evidence:** Hacker News comments, G2/Capterra/Trustpilot summaries, the Tabby GitHub issue tracker, and Royal Apps community posts.
- **The v1 ranking (section 5)** is my judgment, built from feature evidence plus that limited user evidence.
- **Prices** are list prices from vendor pages as fetched on 2026-11-24.

---

## 1. Product snapshots

### SecureCRT (VanDyke). The incumbent to beat.

- **Version:** current is 9.7.4 (2026-11-03). 9.7 shipped 2025-12-09. The 9.7 betas (Aug–Nov 2025) added Session Manager *Snapshots* (saved sets of sessions and their layouts), multi-select in Active Sessions, drag-and-drop SFTP, SFTP tabs opened from SSH2 sessions, pause/resume logging, XML-import conflict resolution, new KEX algorithms (dh group15/17-sha512) and a separate OpenSSH-certificate key location (for Teleport). [V] [history.txt](https://www.vandyke.com/products/securecrt/history.txt)
- **Platforms:** Windows, macOS, Linux. Python 3 scripting is stated for Ubuntu Linux. RDP is Windows-only. [V] [product page](https://www.vandyke.com/products/securecrt/index.html)
- **Protocols:** SSH2, SSH1, Telnet, Telnet/TLS, Serial, RLogin, Raw, TAPI, RDP (Windows). [V] Emulations: VT100/102/220, TN3270, ANSI, SCO ANSI, Wyse 50/60, Xterm, Linux console. [V]
- **Productivity:** tabs and tab groups (tiled vertically or horizontally), a Command Manager (dockable folders of saved commands that are shared with the button bar), a button bar, keyword highlighting (words, phrases, substrings or regex), and a script recorder that writes VBScript or Python. [V] [product page](https://www.vandyke.com/products/securecrt/index.html)
- **Scripting:** Python 3, VBScript, JScript, PerlScript. The non-Python engines are ActiveX-based, so they are effectively Windows-only. That is an inference; VanDyke only explicitly says Python 3 is supported on Ubuntu.
- **File transfer:** SFTP tab, Xmodem, Ymodem, Zmodem, Kermit, and a built-in TFTP server. SCP, FTP(S) and WebDAV/S3 come through the companion product SecureFX. [V]
- **Security:** FIPS 140-2 mode, X.509 smart cards (PIV/CAC), OpenSSH certificates, GSSAPI. [V], and [F] for the GSSAPI options in a real session file.
- **Pricing** (fetched 2026-11-24) [V] [pricing](https://www.vandyke.com/pricing/):
  - New license, 1 user: **$119** with 1 year of updates, or **$190** with 3 years.
  - Bundle with SecureFX: $129 / $206.
  - Upgrades: $48 (1 yr) / $119 (3 yr).
  - Volume tiers down to $140 per seat (3 yr, 25–49 seats).
  - The license appears to be perpetual, with a time-boxed update entitlement. This is inferred from VanDyke's upgrade-after-expiry model ([updates](https://vandyke.com/support/updates.html)). Verify before quoting.
- **Sync:** I found no built-in cloud sync, but I did not check exhaustively. Everything lives in a file-based config folder (one `.ini` per session) that can be relocated, so file-sync tools are the obvious route. **?** I found no VanDyke tip on Dropbox/OneDrive sync.

### MobaXterm (Mobatek). The Windows Swiss-army knife.

- **Platform:** Windows only. No official macOS or Linux build.
  - [U] "My only gripe with it is that it's not available on Mac" (r/networking thread above).
  - [V] The features page refers only to Windows PCs ([features](https://mobaxterm.mobatek.net/features.html)).
- **Session types:** SSH, Telnet, Rlogin/Rsh, XDMCP, RDP, VNC, FTP, SFTP, Serial, File, Shell, Browser, Mosh, AWS S3, WSL. The type ID list comes from importer code [3P]; the main types are also on the vendor page [V]. It includes a built-in X11 server [V].
- **Networking features:** SSH gateway (jump host) for SSH, Telnet, RDP and VNC; a graphical SSH tunnel manager; multi-execution (type into many sessions at once); a macro recorder; terminal syntax highlighting with a built-in Cisco profile (index 20 in the session format); an SFTP side-browser that opens automatically; and embedded TFTP/NFS/cron daemons. [V] [features](https://mobaxterm.mobatek.net/features.html), plus [3P] for the Cisco profile from the gist in Appendix C.
- **Recent changes** (per secondary sources, e.g. [warp2search](https://www.warp2search.net/story/mobaxterm-254-released)) [U/3P]:
  - 25.0: newer PuTTY engine.
  - 25.1: SSH proxy via netcat/socat or port forwarding.
  - 25.4: Windows SSH agent support, faster SFTP.
  - 26.6 Preview (2026-10-08): 64-bit RDP engine, per the vendor preview page ([preview](https://mobaxterm.mobatek.net/preview.html)) [V].
- **Pricing** (fetched 2026-11-24) [V] [download](https://mobaxterm.mobatek.net/download.html):
  - Home Edition is free, capped at **12 sessions, 2 SSH tunnels, 4 macros**, and 360 seconds of TFTP/NFS daemon run time.
  - Professional is **$69 or €49 per user**, with lifetime right to use and 12 months of updates.
- **Sync:** no cloud sync. Sessions live in `MobaXterm.ini`, exported as `.mxtsessions` or `.mobaconf`. Saved passwords are protected by a master password. [V]/[3P]

### Termius. Cross-platform, cloud-vault, subscription.

- **Platforms:** Windows, macOS, Linux, iOS, Android. [V] [pricing](https://termius.com/pricing)
- **Protocols:** SSH, Mosh, Telnet, Serial, SFTP, local terminal. [V] [docs](https://docs.termius.com/llms-full.txt)
- **Serial:** baud, data bits, stop bits, parity and flow control on desktop and mobile. Recommends Redpark cables on mobile. Has a known blank-terminal issue in the Microsoft Store build. [V] [serial](https://termius.com/documentation/connect-via-serial)
- **SSH:** host chains (jump hosts, which groups can inherit), HTTP/SOCKS5 proxies, its own SSH agent with agent forwarding, local/remote/dynamic port forwarding, and keyboard-interactive auth (fixed repeatedly in the changelog). **X11 forwarding is not documented**, so treat it as ?. [V]
- **Terminal productivity:**
  - Workspaces with split view and **broadcast input** to all terminals in the workspace.
  - Snippets that can run on multiple hosts.
  - Autocomplete from snippets, history and paths, plus AI command generation (needs an account).
  - Built-in keyword highlighting for Error/Warning/Info and similar, on by default since 7.50.0.
  - An "AI widget" on mobile, and integration that auto-starts CLI coding agents (Claude Code, Gemini) on connect.
  - [V] All from the changelog in [docs](https://docs.termius.com/llms-full.txt).
- **Session logs:** by default **only one recent log per host**, replaced at the next connection, unless you bookmark it. Logs can sync and be shared depending on plan. Mosh is not logged. [V] That is weak compared with SecureCRT's per-session auto-log files.
- **Imports:** `~/.ssh/config` (`ProxyJump` becomes a host chain; `ProxyCommand` is ignored), CSV template, PuTTY (`.reg`), MobaXterm (`.mobaconf` / `.mxtsessions`, including encrypted ones with a passphrase), and SecureCRT **XML export**. The SecureCRT importer was later improved to bring in keys, passwords, port forwards, groups and snippets. [V]
- **Pricing** (fetched 2026-11-24) [V] [pricing](https://termius.com/pricing):
  - Starter: free, local vault.
  - Pro: **$10/month** billed annually, personal cloud vault and sync.
  - Team: $20/seat/month.
  - Business: $30/seat/month.
  - Enterprise: custom, with SAML SSO.
- **Serial pricing conflict:** the changelog for 10.1.0 says "Proxy, Agent Forwarding, Host chains, and Serial connections are now available for free" [V]. A January 2025 Reddit comment said "you just have to have a subscription for serial use" [U]. The gating changed over time.
- **Sync:** end-to-end encrypted vaults (personal, team, custom). Losing the encryption password is unrecoverable. [V]

### Tabby. Open source, Electron, the closest architectural analogue to Hopline.

- **Basics:** MIT licence. Windows, macOS, Linux, plus a web app. Latest release v1.0.238 (2026-10-07). [V] [GitHub](https://github.com/Eugeny/tabby)
- **SSH:** connection manager, jump hosts, agent forwarding (Pageant and Windows OpenSSH agent), X11 (`tabby-ssh/src/session/x11.ts`), port forwarding UI, a keyboard-interactive auth panel, and login scripts. [V] from the README and source tree.
  - The SSH stack appears to be **russh**, going by issue #10780, "russh SFTP upload fails under zlib compression". [3P]
- **Serial profile options:** `baudrate`, `databits` (5–8), `stopbits` (1/1.5/2), `parity`, `rtscts`, `xon`, plus hex input/output and auto-reconnect. **Send Break: ?** [V] [tabby-serial/src/api.ts](https://github.com/Eugeny/tabby/blob/master/tabby-serial/src/api.ts)
- **Terminal:** nested split panes, and "Focus all panes at once (broadcast)" / "Focus all tabs at once (broadcast)" hotkeys (`tabby-terminal/src/hotkeys.ts`). Zmodem is supported, and there is a desktop SFTP panel. Profile groups exist (`editProfileGroupModal`). There is an encrypted vault for secrets. [V]
- **Importers:** OpenSSH config only (`tabby-electron/src/sshImporters.ts`: `OpenSSHImporter`, `StaticFileImporter`). There is no SecureCRT or MobaXterm import. [V]
- **Sync:** through the community sync-config plugin (Gist/Gitee). [V]
- **Gaps visible in its issue tracker** [U] ([issues sorted by upvotes](https://github.com/Eugeny/tabby/issues)):
  - Keyword highlighting (#632, open, 31 upvotes)
  - Drag tabs to a new window (#581, 54 upvotes)
  - Mosh (#593, 50 upvotes)
  - Slow SFTP (#8972)
  - 100% CPU (#7909)
  - Auth regressions between versions (#10347)
  - Double paste (#11706, #11710)
  - I found no session-log-to-file module in Tabby's source tree (a file-name grep, not a code review). A community save-output plugin exists [V].

### Royal TS (Windows) / Royal TSX (macOS). A connection manager first, a terminal second.

- **Terminal engines:**
  - Royal TS on Windows uses Rebex.net and PuTTY for SSH/Telnet, and has had serial (RS-232) since 2.1.1 (blog seen via search summary). [V] [win features](https://www.royalapps.com/ts/win/features), [serial blog](https://royalapps.com/blog/new-feature-rs232-serial-port-communication-for-terminal-connection)
  - Royal TSX on macOS: "SSH and Telnet based on iTerm2". **Serial on macOS: ?** [V] [mac features](https://www.royalapps.com/ts/mac/features)
- **Strengths:**
  - Credential objects with folder inheritance.
  - Credentials pulled from 1Password, LastPass or KeePass.
  - Shared documents synced through a file share or Dropbox.
  - Secure Gateway, which needs Royal Server.
  - Key Sequence Tasks, which send keystrokes to one or more connections.
  - Command Tasks, with ping and traceroute built in.
  - Dynamic Folders, which build the connection tree from scripts and are a source-of-truth integration such as NetBox.
  - RoyalJSON import.
  - Covers RDP, VNC, VMware and Hyper-V.
  - All [V].
- **Pricing** (fetched 2026-11-24) [V]: Lite is free, up to 10 connections, 10 credentials and 1 document. Single User is **€49**, with no subscription.
- **Gap example** [U]: a 2021 request for "Send Break" in Royal TSX Terminal (for Cisco ROMMON) got no reply. The user switches to SecureCRT for that task. [community](https://community.royalapps.com/t/submit-break-to-terminal/1402)

Also mentioned by users but out of scope: Devolutions Remote Desktop Manager, SuperPuTTY, mRemoteNG, TeraTerm, and Windows Terminal + WSL.

---

## 2. Feature matrix

Key: Y = yes, N = no, P = partial or limited, ? = unconfirmed. Evidence tiers are in section 1 and the appendices.

| Feature | SecureCRT 9.7 | MobaXterm 25/26 | Termius | Tabby 1.0.23x | Royal TS / TSX |
|---|---|---|---|---|---|
| **Platforms** | Win / mac / Linux | Win only | Win / mac / Linux / iOS / Android | Win / mac / Linux / web | Win (TS) / mac (TSX) / mobile |
| **Licence model** | Perpetual(?) + 1 or 3 yr updates | Free Home (capped) / Pro perpetual | Freemium subscription | Free, MIT | Free Lite (capped) / perpetual |
| **List price, 1 user** | $119 (1 yr) / $190 (3 yr) | $69 / €49 | $10/mo (Pro, annual) | $0 | €49 |
| **Folder tree** | Y (multi-level) | Y (`SubRep` paths) | Groups (not folders) + tags | Profile groups | Y (folders + documents) |
| **Tags / labels** | N(?) | N | Y | N(?) | P (custom fields) |
| **Shared credential objects** | Y (Credentials manager, `Credential Title`) | Y (master-password store) | Y (Keychain identities) | P (vault) | Y (with inheritance, external vaults) |
| **Cloud / team sync** | N(?) (file-based config folder) | N | Y (E2E vault, team vaults) | P (plugin) | P (shared document on file share) |
| **Import from SecureCRT** | n/a | ? | Y (XML) | N | ? |
| **Import from MobaXterm** | ? | n/a | Y | N | ? (community request) |
| **Import from ssh_config / PuTTY / CSV** | P (Text Import Wizard CSV, scripts for PuTTY) | P (CSV) | Y / Y / Y | Y / N / N | P (RoyalJSON, Dynamic Folders) |
| **SSH2 password / pubkey** | Y | Y | Y | Y | Y |
| **Keyboard-interactive / MFA** | Y | Y(?) | Y | Y | Y(?) |
| **Smart card / PIV, GSSAPI** | Y / Y | ? / ? | ? / ? | N(?) / ? | ? |
| **OpenSSH certificates** | Y | Y (cert field) | Y | ? | ? |
| **Jump host / ProxyJump** | Y (session as firewall, `Session:` ref) | Y (gateway list, multi-hop) | Y (host chains) | Y | Y (Secure Gateway; needs Royal Server) |
| **Agent forwarding** | Y | Y | Y | Y | ? |
| **X11 forwarding** | Y (needs external X server) | Y (built-in X server) | ? | Y | ? |
| **Port forwarding L / R / D** | Y / Y / Y | Y(?) (tunnel manager) | Y / Y / Y | Y | P (gateway) |
| **Legacy algorithm control (KEX / cipher / MAC lists)** | Y (per session) | Y (per session) | ? | ? | ? |
| **Telnet** | Y (+ Telnet/TLS) | Y | Y | Y | Y |
| **Serial: baud / data / parity / stop** | Y | Y | Y | Y | Y (Win) / ? (mac) |
| **Serial: flow control** | Y (DSR, DTR, CTS, RTS, XON) | Y(?) | Y | Y (RTS/CTS, XON) | ? |
| **Serial: Send Break** | Y (`Serial Break Length`) | ? | ? | ? | N on TSX (2021 request) |
| **Mosh** | N | Y | Y | N (#593) | N(?) |
| **RDP / VNC (note only)** | RDP Win only / N | Y / Y | N / N | N(?) / N(?) (RDP requested, #5854) | Y / Y |
| **Emulation breadth** | VT100/220, Xterm, ANSI, Wyse, TN3270... | xterm (PuTTY engine) | xterm | xterm/VT220 | xterm (iTerm2 / Rebex) |
| **Large configurable scrollback** | Y (per session) | Y (default 360000) | ? | Y(?) | ? |
| **Auto session logging to file** | Y (tokens, per-line prefix, midnight rollover) | Y (log folder per session) | P (one log per host, cloud) | N(?) (plugin) | ? |
| **Keyword highlighting (custom regex)** | Y (Keyword Sets, regex) | P (preset Cisco/Unix/... profiles + custom) | P (built-in keyword list) | N (#632) | ? |
| **Button bar** | Y | P (macros toolbar) | N(?) (snippets panel) | P (quick-cmds plugin) | P (tasks) |
| **Snippets / command library** | Y (Command Manager) | Y (macros) | Y (snippets, multi-host) | P (plugin) | Y (Key Sequence Tasks) |
| **Send to all / multi-exec** | Y (Command window: all, tab group, visible; locked sessions excluded) | Y (MultiExec) | Y (workspace broadcast) | Y (broadcast panes / tabs) | Y (Key Sequence to many) |
| **Tabs + tiling / split panes** | Y (tab groups, tiling) | Y (split, detach) | Y (split workspaces) | Y (nested splits) | Y(?) |
| **Saved layouts / workspaces** | Y (Snapshots, 9.7) | ? | Y (workspace templates) | P (restores tabs) | Y (documents) |
| **Logon actions (expect/send)** | Y (Logon Actions / login script) | P (remote command / macro) | P (startup snippets) | Y (login scripts) | P (tasks) |
| **Scripting** | Y (Python 3, VBScript, JScript, Perl) | P (macros, shell) | N(?) | P (plugins, JS) | P(?) (scripts via tasks / Dynamic Folders) |
| **Paste safety / line delay** | Y (`Line Send Delay`, `Character Send Delay`) | Y (paste delay setting) | ? | P (bracketed paste) | ? |
| **SFTP browser** | Y (tab; full browser in SecureFX) | Y (auto side panel) | Y (dual pane) | Y (panel) | Y (file transfer connection) |
| **SCP** | via SecureFX | Y | ? | ? | Y |
| **Xmodem / Ymodem / Zmodem / Kermit** | Y / Y / Y / Y | ? / ? / ? / ? | N(?) | Zmodem only | ? |
| **Built-in TFTP server** | Y | Y (capped in Home) | N | N | N |
| **AI features** | N | N | Y (command generation, AI widget, CLI-agent integration) | P (plugins / MCP) | N |

---

## 3. Deep dives by area

### 3.1 Session management

- **SecureCRT** stores **one `.ini` file per session** in `Config/Sessions/`. Folders are subdirectories, and the order within a folder is kept in `__FolderData__.ini` [F]. Other management features:
  - **Default.ini** is the template for new sessions. "Change ALL sessions" pushes a Default change to every session ([logging tip](https://vandyke.com/support/tips/configure-automated-logging-in-securecrt.html)) [V].
  - **Credentials** are named objects that sessions reference through `Credential Title` [3P], so one password change fixes many sessions [V].
  - **Bulk creation:** the Text Import Wizard (9.2+) creates sessions from CSV with these fields: Hostname (required), Folder, Session Name, Username, Password, Credentials, Protocol, Emulation, Description. It does not handle Serial, TAPI or Local Shell ([wizard](https://vandyke.com/support/tips/import-securecrt-sessions-from-csv-or-text-file-data-using-text-import-wizard.html)) [V].
  - **Import script:** `ImportArbitraryDataFromFileToSecureCRTSessions` adds `port` and `protocol` columns ([import tip](https://vandyke.com/support/tips/importsessions.html)) [V].
  - **Source of truth:** users do this with scripts. [U] "Do you have any way to programmatically keep your session tree up to date with a source of truth like Netbox?" The answer pointed to that VanDyke import script.
  - **Export:** Tools > Export Settings writes XML (Appendix B).
- **MobaXterm** keeps sessions in `MobaXterm.ini` under `[Bookmarks]` and `[Bookmarks_N]` sections, and exports `.mxtsessions` (Appendix C). [U] One engineer generates `.mxtsessions` from Nautobot with the bastion pre-filled as the SSH gateway.
- **Termius** uses Vault > Groups (which inherit settings, including jump chains) > Hosts, with tags and labels. Groups are explicitly not folders. [V]
- **Royal TS** uses Documents > Folders > Connections, with credential and property inheritance and Dynamic Folders driven by scripts. [V]
- **Hopline implication:** v1 needs four things:
  - a folder tree, plus tags
  - inherited defaults (folder-level username, jump host, credential)
  - named credential profiles
  - a scripted or API way to sync the tree from NetBox/Nautobot or CSV. This gap is called out by users of every tool.

### 3.2 Protocols

- **SSH must-haves seen across products:**
  - password, keyboard-interactive (RADIUS/TACACS+ OTP prompts), publickey, agent
  - jump host chains
  - local, remote and dynamic forwards
  - agent forwarding
  - X11
  - keepalive (SecureCRT: `Idle NO-OP Check` / `Idle NO-OP Timeout` [F])
  - per-session **algorithm lists** (SecureCRT `Key Exchange Algorithms`, `Cipher List`, `MAC List` [F]; MobaXterm group-1 indices 28–30 [3P])
- **Why algorithm lists matter (my judgment, not sourced):** old IOS, ASA and ProCurve devices often need legacy KEX/ciphers that modern defaults (including ssh2's) disable. SecureCRT users rarely see this problem because the lists are editable per session.
- **SecureCRT jump hosts:** a session's `Firewall Name` can be `Session:<path>`, which uses another saved session as the jump host [3P, consistent across 3 importers and the Voltius XML sample]. VanDyke also documents two other approaches (tips seen via search summaries, not read in full):
  - a dynamic-forward "Master" session used as a SOCKS firewall ([socksproxy tip](https://vandyke.com/support/tips/socksproxy.html))
  - Logon Actions that `ssh` onward when the jump host forbids forwarding ([logon actions tip](https://www.vandyke.com/support/tips/use-logon-actions-to-connect-to-secondary-host-behind-a-jumphost-gateway.html))
- **Telnet** is still needed for labs (GNS3/EVE-NG consoles are Telnet ports), terminal servers and legacy gear. SecureCRT exposes Telnet options per session: `Send SGA`, `Will LFLOW`, `Enable NAWS`, `Force Char Mode`, `Server Requires Bare CR` [F].
- **Serial** is the day-one console use case. The fields that matter are:
  - port, baud, data bits, parity, stop bits
  - flow control (SecureCRT separates `DSR Flow`, `DTR Flow Control`, `CTS Flow`, `RTS Flow Control` and `XON Flow` [F])
  - **break length / Send Break**, used for ROMMON and password recovery. SecureCRT has `Serial Break Length` (0x64 = 100, presumably ms) [F]. The Royal TSX gap thread [U] shows how much this matters.
  - logging that starts as soon as the port opens (SecureCRT starts the log "after the COM port opens") [V]
- **RDP/VNC (note only):** MobaXterm and Royal cover them. SecureCRT has RDP on Windows only. Termius and Tabby have neither. Users who want one tool for everything go to RDM, Royal or MobaXterm [U].

### 3.3 Terminal features

- **Logging is the most-cited daily feature** [U]:
  - "I auto log every session (SSH, Telnet, and Serial/Console)"
  - MobaXterm "logs all your terminal sessions to a local folder by default. That's saved me when I've botched something"
- **SecureCRT log tokens** [V] ([tip](https://vandyke.com/support/tips/configure-automated-logging-in-securecrt.html)):

  | Token | Meaning |
  |---|---|
  | `%H` | hostname |
  | `%S` | session name |
  | `%Y` | 4-digit year |
  | `%y` | 2-digit year |
  | `%M` | month |
  | `%D` | day |
  | `%P` | port |
  | `%h` / `%m` / `%s` | hour / minute / second |
  | `%t` | milliseconds |
  | `%F` | folder path under Sessions |
  | `%%` | literal % |
  | `%envvar%` | environment variable |

- **SecureCRT log options:** "Custom Log Message Each Line" accepts the same tokens, e.g. `[%Y-%M-%D %h:%m:%s.%t]`, for a timestamp on each line. The real `.ini` keys are `Log Filename` (a `V2` variant may exist in newer builds, **?**), `Start Log Upon Connect`, `Custom Log Message Connect`, `Custom Log Message Disconnect`, `Custom Log Message Each Line`, `Log Only Custom`, `Log Mode` (append or overwrite, inferred), `Raw Log`, `New Log File At Midnight`, and `Generate Unique Log File Name When File In Use` [F].
- **Keyword highlighting** is a strong SecureCRT loyalty driver [U]:
  - "I have the CiscoWords.ini which helps colorize different words to help me troubleshoot"
  - "Writing regex for SecureCRT's keyword highlighting sort of became a hobby", with community sets at [feralpacket/securecrt-keyword-highlighting](https://github.com/feralpacket/securecrt-keyword-highlighting)
  - VanDyke publishes a script to import keyword `.ini` files ([import keyword ini](https://www.vandyke.com/support/scripting/scripting-examples/import-keyword-highlighting-ini-files.html))
  - Session keys are `S:"Keyword Set"` and `D:"Highlighting Style"` [F]
  - MobaXterm ships preset highlighting profiles, including "Cisco" [3P]. Termius has a fixed built-in list [V]. Tabby lacks it entirely (#632).
- **Send to many:**
  - SecureCRT's Command window (formerly the "chat window"): "right-click in the Command window and choose Send Commands to All Sessions", and "Commands are not sent to locked sessions, which makes it possible to send commands to a subset". Tiled sessions have been supported since 7.0 ([tip](https://www.vandyke.com/support/tips/chatsendcom.html)) [V].
  - Targeting a tab group or the visible sessions is described in VanDyke's scripting examples (search snippet only; [command window automation](https://www.vandyke.com/support/scripting/scripting-examples/command-window-automation.html)).
  - Users praise multi-session input and warn about it [U]: "mobaxterm, mult-exec is absolutely priceless." Another commenter: "I use it too often to push config to 150+ devices simultaniously. Handle with care, though". The product that reply refers to is unclear, because the archive lost the reply nesting.
  - The `Show Chat Window` session key exists [F].
  - **For Hopline:** the AI safety layer should treat broadcast as a high-risk action, with an explicit target list and confirmation.
- **Paste pacing:** [U] A commenter said a vendor recommended a client "primarily because you could give it a timing parameter to control the time between commands when just pasting a string of commands". Which product the reply refers to is unclear in the archived thread, which lost the reply nesting. SecureCRT's keys for this are `Line Send Delay` and `Character Send Delay` [F]. Network CLIs, especially over serial or slow AAA, are widely known to drop characters on fast pastes.
- **Button bar:** [U] "Programmable buttons for commands, keyword highlighting, session management, logging, issue commands to multiple sessions" was one team's list of reasons for SecureCRT. The keys are `User Button Bar` and `User Button Bar Name` [F].
- **Emulation details network engineers notice:** VT100 line drawing, 80/132 column switching (`Enable 80-132 Column Switching` [F]), Backspace/Delete mapping (`Map Backspace`, `Map Delete` [F]), answerback, and "Translate Incoming CR To CRLF" [F]. [U] An HN commenter: "SecureCRT was the only windows client I could find that renders [ACS line drawing] all correctly." ([HN](https://news.ycombinator.com/item?id=9369663))
- **Tabs and tiling:** SecureCRT has tab groups and tiling, plus 9.7 Snapshots [V]. MobaXterm's split screen is "game changing" for one user [U]. A paste bug after reconnect was reported for MobaXterm [U]. A separate "out of memory" crash report in the same thread cannot be tied to a product, because the reply nesting was lost.

### 3.4 File transfer

- **Firmware and recovery workflows** need **Xmodem over serial** (ROMMON images) and a **TFTP server** (IOS `copy tftp:`). SecureCRT has both (Xmodem/Ymodem/Zmodem/Kermit, and `Start Tftp Server` [F]). MobaXterm has TFTP, capped at 360 s in Home [V].
- **SFTP and SCP** are needed for config and log pulls. SecureCRT 9.7 added drag-and-drop SFTP [V]. Termius has a dual-pane SFTP browser with remote edit [V]. Tabby's SFTP is reported slow (#8972) [U].
- **Zmodem** (`rz`/`sz`) is supported in SecureCRT and Tabby. In SecureCRT it is configurable through `ZModem Receive Command=rz\r`, `Disable ZModem` and related keys [F].

### 3.5 Productivity

- **SecureCRT Command Manager:** a dockable command library with folders and a filter, which can feed the button bar [V].
- **MobaXterm macros:** recorded keystrokes; Home is capped at 4 [V].
- **Termius snippets:** run on many hosts; can be AI-generated [V].
- **Royal Key Sequence Tasks:** send keystrokes to many connections [V].
- **Tab completion and command assist:**
  - No incumbent understands device CLIs. Termius autocomplete uses history, snippets and paths, not device grammar [V].
  - [U] One engineer replaced SecureCRT with WSL + fzf to fuzzy-find hosts faster: "I can now use the fuzzy finder to SSH to switches dad quicker than I ever could in SecureCRT." (verbatim, typo included)
  - **Quick, fuzzy host search is a must-have.**
- **"Maps":** topology/network-map features were **not checked**. None showed up in the feature pages I read. SecureCRT's "maps" are **keymaps** (`Keymap Name`, `Keymap v2` [F]). Keymaps and topology views are both whitespace Hopline could own; topology is not table stakes.

### 3.6 Sync and teams

- **Termius** is the only one with real E2E-encrypted cloud and team sync [V].
- **Royal** shares document files over a file share or cloud folder, with credentials referenced by name so personal secrets stay out of shared files [V].
- **SecureCRT and MobaXterm** appear to have file-based configs only (not exhaustively checked).
- [U] One engineer moved to RDM because it "supports direct Secret Server integration which is mandatory ... (our passwords rotate every 24 hours)". **External secret-store integration** (CyberArk, Secret Server, 1Password, Vault) is a real enterprise requirement.

---

## 4. What users love, what they miss, why they switch

What users love:

- **SecureCRT:** reliability at scale, logging, keyword highlighting, the button bar, send-to-many, jump host support and good support staff. All [U]:
  - "I manage about 3000 switches and 1000 routers with it"
  - "It's 1000% worth the licensing costs"
  - "Once you go SecureCRT you never go back"
- **MobaXterm:** all-in-one (RDP, X11, SFTP), default logging, MultiExec, split screen [U].
- **Termius:** cross-platform with cloud sync [U]: "Switched to Termius about year ago ... multi-platform with cloud sync."
- **Royal and RDM:** one tool for RDP and SSH, plus credential vault integration [U].

Top complaints and gaps:

1. **SecureCRT price.**
   - [U] "SecureCRT is awesome but it's crazy expensive" ([HN 2026](https://news.ycombinator.com/item?id=47466197))
   - [U] "great terminal emulator, sadly greatly expensive" ([HN 2025](https://news.ycombinator.com/item?id=45362237))
   - [U] A CDW reviewer called the price very high for organisation-wide use (seen in a search snippet, not read in full)
   - Two HN posts in 2025–2026 explicitly discuss building a SecureCRT clone. The demand is visible.
2. **SecureCRT's dated UX and uneven platforms.**
   - [U] A G2 reviewer noted that some features, e.g. the notepad, exist on Windows but not on Mac (search snippet)
   - [U] A Mac user reported crashes
   - The ActiveX script engines are Windows-only (inference)
3. **MobaXterm is Windows-only** [U], and some engineers prefer a real local Linux environment (WSL) over its embedded Cygwin [U].
4. **Termius:**
   - Subscription and account friction: "account required" is the top negative on AlternativeTo [U] (search snippet; [AlternativeTo](https://alternativeto.net/software/serverauditor/about/)), and Termius's own FAQ on why an account is needed ([FAQ](https://docs.termius.com/help-center/faq/why-am-i-required-to-create-an-account))
   - Trustpilot reviewers report hosts disappearing around subscription expiry [U] (search snippet; [Trustpilot](https://ca.trustpilot.com/review/termius.com))
   - Weak logging (one log per host)
   - Historic paywalling of serial
5. **Tabby:** no keyword highlighting, apparently no built-in log-to-file, performance and CPU problems, auth regressions, slow SFTP [U] (GitHub issues).
6. **Royal TSX:** no Send Break for serial consoles [U].
7. **Everyone:** no source-of-truth sync (NetBox/Nautobot), so users write their own exporters [U]. No device-aware assistance.

Why they switch (observed in the thread):

- SecureCRT to RDM: secret-server integration, cross-platform.
- SecureCRT to WSL + fzf: speed and a native Linux toolchain.
- To Termius: sync and multi-platform.
- To MobaXterm: all-in-one.
- Staying on SecureCRT: logging, highlighting, scale, support.

---

## 5. Must-have for v1 (ranked by daily reliance)

This ranking is my judgment from sections 1–4. "Reliance" means a network engineer cannot do a normal day without it.

1. **Saved-session tree with folders, fuzzy quick-connect search and inherited defaults.**
   - The core of every incumbent, and the first thing a switcher's muscle memory hits. Users manage hundreds to thousands of devices [U].
   - Fuzzy search is the reason one engineer left SecureCRT.
2. **Robust SSH2.**
   - Auth: password, keyboard-interactive (TACACS+/RADIUS/OTP prompts), publickey, agent.
   - Per-session **KEX/cipher/MAC/host-key algorithm overrides**, including legacy ones.
   - Keepalives and auto-reconnect.
   - Legacy network gear breaks modern defaults. SecureCRT and MobaXterm expose these lists per session.
3. **Jump hosts / ProxyJump chains, configurable per folder.**
   - Most production networks are only reachable through bastions.
   - Every competitor has it, and users bake bastions into their generated session files [U].
4. **Serial console.**
   - Port enumeration with stable names, baud, data, parity and stop bits, flow control, **Send Break**, and reconnect on USB re-plug.
   - Console work is unavoidable (new installs, recovery, ROMMON). Royal TSX's missing Send Break pushes users back to SecureCRT [U].
5. **Automatic session logging.**
   - Filename tokens (`%S`, `%H`, `%Y-%M-%D`, etc.), per-line timestamps, start on connect (serial: on port open), new file at midnight, unique-name-if-in-use.
   - The most-praised safety net ("saved me when I've botched something") [U]. It is evidence for change tickets, and it is also the natural data source for Hopline's AI context.
6. **Importers for SecureCRT (Sessions folder + XML), MobaXterm (.mxtsessions/.mobaconf), PuTTY, OpenSSH config and CSV.**
   - Switching cost is the main moat. Termius invested in exactly these importers [V].
   - Appendices A–D give the formats.
7. **Telnet with proper option negotiation (NAWS, SGA, bare CR) and raw TCP.**
   - Lab consoles (GNS3/EVE-NG), terminal servers and legacy devices.
8. **Tabs, split/tiled panes and saved layouts.**
   - Comparing output side by side (two switches in a pair, before and after) is daily work. SecureCRT 9.7 just added Snapshots.
9. **Send to multiple sessions with explicit targeting.**
   - Targets: all, tab group, visible or selected, with per-session lock or exclude and a clear indicator.
   - Loved and feared in equal measure [U]. Hopline's safety-first stance can make this better than SecureCRT's: a preview of target hosts and a confirmation for config-mode commands.
10. **Keyword highlighting with regex and importable sets.**
    - Ships with a network preset: interface states, err-disabled, `%LINK-3-UPDOWN`, IPs/MACs, deny/permit.
    - Strong loyalty driver for SecureCRT [U]. Tabby's most-requested missing feature (#632). Importing SecureCRT keyword `.ini` files would win converts.
11. **Paste safety: line/character send delay, multi-line paste confirmation, bracketed paste where supported.**
    - Network CLIs drop characters, and pasting a config into the wrong session is a classic outage.
12. **Large, searchable scrollback with copy-on-select, configurable word delimiters, and correct VT100/xterm emulation.**
    - Line drawing, 80/132 switching, Backspace/Delete mapping.
    - "Show run" output is long, and engineers search it constantly. Emulation glitches are noticed immediately [U].
13. **Credential profiles stored in the OS keychain, plus a master password.**
    - Plan an external secret-store hook (1Password, Vault, Secret Server) soon after v1.
    - Shared credentials cut churn when passwords rotate. Secret-store integration is a stated reason to switch [U].
14. **Snippets / command library with a button bar.**
    - Per-folder or per-vendor sets.
    - SecureCRT's button bar and Command Manager are explicitly cited [U]. In Hopline this pairs naturally with AI-suggested commands that pass through the same safety gate.
15. **Logon actions (expect/send).**
    - Automate terminal-server hops, `enable`, `terminal length 0`.
    - Used to traverse jump hosts that forbid forwarding [V]. Removes repetitive steps on every connect.
16. **File transfer: SFTP browser, Xmodem/Zmodem over the terminal, and a built-in TFTP server.**
    - Ranked lower only because it is used weekly, not hourly. It is still required for firmware and recovery.
17. **Local, remote and dynamic port forwarding.** Needed to reach device web UIs and APIs through bastions. Every competitor has it.

Explicitly **not** v1: RDP/VNC, X11 (keep the option on the roadmap), Mosh, full scripting engines (Python API later; the AI agent covers part of the need), cloud team sync, and TN3270/Wyse emulation.

---

## Appendix A: SecureCRT Sessions folder (`.ini`) format

### A.1 Location and layout

| OS | Default config folder | Tier |
|---|---|---|
| Windows | `%APPDATA%\VanDyke\Config` | [3P] (multiple importers) |
| macOS | `~/Library/Application Support/VanDyke/SecureCRT/Config` | [3P] |
| Linux | `~/.vandyke/SecureCRT/Config` | [3P] |

- The config folder can be relocated in Global Options. Portable installs use e.g. `SecureCRTPortable/Data/Settings/VanDyke/Config/` [F].
- Sessions are in `Config/Sessions/`. Each `<name>.ini` is a session named after the file stem [F]. Each subdirectory is a folder [3P]; the real sample repo was flat, so I did not observe this directly.
- `Config/Sessions/Default.ini` is the default-session template. Skip it at the **root only**; a `Default.ini` in a subfolder is a real session named "Default" [3P].
- `__FolderData__.ini` in each folder stores ordering and UI state, and is not a session [F]:
  ```
  S:"Folder List"=
  S:"Session List"=Default:<session-a>:<session-b>:...:Serial-COM4:...:
  D:"Is Expanded"=00000001
  ```
  The lists are `:`-separated session/folder names, with a trailing `:`.
- `Config/SSH2.ini` holds global SSH2 options, including the global public key `Identity Filename V2` [3P].
- `Config/Credentials/`: **?** It probably holds credential objects, but I did not confirm the on-disk layout.
- Path variables can appear in values: `${VDS_CONFIG_PATH}`, `${VDS_USER_DATA_PATH}` (Documents), `${VDS_INSTALL_PATH}`, `${VDS_SSH_DATA_PATH}` [V] ([logging tip](https://vandyke.com/support/tips/configure-automated-logging-in-securecrt.html)).

### A.2 Line grammar

[F] From real files ([yiltoncent/secureCRT-config](https://github.com/yiltoncent/secureCRT-config/tree/master/Config/Sessions), [HyperSine README](https://github.com/HyperSine/how-does-SecureCRT-encrypt-password)); [V] for the typed prefixes ([VanDyke script](https://vandyke.com/support/scripting/scripting-examples/scripts/IterateOverAllSessionsRecursively_ConfFileOutputFormat.vbs.txt)).

- **Encoding:** UTF-8, with a BOM in recent versions. The BOM was observed on `__FolderData__.ini` [F].
- **Line form:** `<T>:"<Option Name>"=<value>`. The option name is the same string used by the scripting API `GetOption("<Option Name>")` [V].
- **Types:**

  | Type | Meaning | Example |
  |---|---|---|
  | `S` | string | `S:"Hostname"=10.0.0.1` |
  | `D` | 32-bit DWORD, **8 hex digits** | `D:"[SSH2] Port"=00000016` = 22 |
  | `B` | binary; the value is a byte count in hex, with bytes on following lines indented one space | `B:"Normal Font v2"=00000060` then ` f3 ff ff ff 00 ...` |
  | `Z` | multi-string list; the value is an item count in hex, with items on following lines indented one space | `Z:"Description"=00000002` then ` line one` / ` line two` |

- **Parser rules:**
  - Lines starting with a space are continuations of the preceding `B`/`Z`.
  - Ignore unknown keys.
  - **Localized builds write duplicate translated keys.** A Chinese-localised build wrote `S:"日志文件名"=` next to `S:"Log Filename"=`, and mixed forms like `D:"打印机Baud Rate"` [F]. Match exact English names only. Do not suffix-match `"Baud Rate"`, because `Printer Baud Rate` and the localized `打印机Baud Rate` also exist [F].

### A.3 Fields to import

| Purpose | Key (exact) | Type | Notes | Tier |
|---|---|---|---|---|
| Is a session | `Is Session` | D | 1 = session | [F] |
| Protocol | `Protocol Name` | S | `SSH2`, `SSH1`, `Telnet`, `Serial`, `RLogin`, `Raw`, `RDP`, `TAPI`, `Local Shell`, `Telnet/SSL` (seen in 3P code) | [F]/[V]/[3P] |
| Host | `Hostname` | S | | [F] |
| SSH2 port | `[SSH2] Port` | D | hex; SSH1 uses `[SSH1] Port` | [F]/[3P] |
| Telnet/Raw port | `Port` | D | e.g. `00000017` = 23 | [F] |
| Username | `Username` | S | | [F] |
| Description | `Description` | Z | multi-line notes | [F] |
| Emulation | `Emulation` | S | `VT100`, `Xterm`, `Linux`, `VT220`, `ANSI`, ... | [F] |
| Jump host / proxy | `Firewall Name` | S | `None`, a global firewall name, or `Session:<folder/session path>` for a jump-host session | [F] (`None`) / [3P] (`Session:`) |
| Shared credential | `Credential Title` | S | name of a Credentials object | [3P] |
| Auth order | `SSH2 Authentications V2` | S | e.g. `password,publickey,keyboard-interactive,gssapi` | [F] |
| Key file | `Identity Filename V2` (older: `Identity Filename`) | S | may end in `::rawkey`; may contain `${VDS_CONFIG_PATH}` or `${VDS_SSH_DATA_PATH}` | `Identity Filename` [F]; `V2` [3P] |
| Use global key | `Use Global Public Key` | D | 1 = use `SSH2.ini` key | [3P] |
| Saved password | `Password V2` (older: `Password`) | S | encrypted, prefixed `02:` or `03:`; `Session Password Saved`=1. A user's config passphrase (stored as a verifier in `Security` / `Passphrase` [3P]) is a separate input to decryption | [3P] (HyperSine) |
| Agent forwarding | `Enable Agent Forwarding` | D | only `2` observed in a real file (meaning **?**, possibly "use global"); 3P fixtures use 1 | [F]/[3P] |
| X11 | `Forward X11` | D | also `XServer Port`, `Enforce X11 Authentication`, `XAuthority File` | [F] |
| Local forwards | `Port Forward Table V2` | Z | entry syntax **not decoded** | [F] (key only) |
| Remote forwards | `Reverse Forward Table V2` | Z | entry syntax **not decoded** | [F] (key only) |
| Forward filters | `Port Forward Filter`, `Reverse Forward Filter` | S | e.g. `allow,127.0.0.0/255.0.0.0,0 deny,0.0.0.0/0.0.0.0,0` | [F] |
| Algorithms | `Key Exchange Algorithms`, `Cipher List`, `MAC List`, `Compression List` | S | comma lists, priority order | [F] |
| GSSAPI | `GSSAPI Method`, `GSSAPI Delegation`, `GSSAPI SPN` | S | | [F] |
| Keepalive | `Idle NO-OP Check`, `Idle NO-OP Timeout` | D | timeout in seconds (0x3c = 60, inferred) | [F] |
| Idle string | `Idle Check`, `Idle Timeout`, `Idle String` | D/D/S | | [F] |
| Auto reconnect | `Auto Reconnect` | D | | [F] |
| Serial port | `Com Port` | S | e.g. `COM4` on Windows. Linux writes `Linux Com Port` = `/dev/ttyUSB0`, and the other serial keys get the same prefix (see Appendix B) | [F] / [3P] |
| Baud | `Baud Rate` | D | `0001c200` = 115200 | [F] |
| Data bits | `Data Bits` | D | 8 | [F] |
| Parity | `Parity` | D | 0 = None; 1..4 = Odd, Even, Mark, Space per 3P importers | [F]/[3P] |
| Stop bits | `Stop Bits` | D | 0 = 1; 1 = 1.5; 2 = 2 per 3P importers | [F]/[3P] |
| Flow control | `DSR Flow`, `CTS Flow`, `XON Flow` | D | booleans | [F] |
| Flow control lines | `DTR Flow Control`, `RTS Flow Control` | D | 1 on a plain serial session, 2 on printer defaults. This looks like the Win32 DCB enum (0 disable, 1 enable, 2 handshake), but that is **inference** | [F] |
| Break | `Serial Break Length` | D | `00000064` = 100 (ms, inferred) | [F] |
| Telnet options | `Send SGA`, `Will LFLOW`, `Enable NAWS`, `Force Char Mode`, `Server Requires Bare CR`, `Enable NTLM Authentication` | D | | [F] |
| Logging | `Log Filename` (newer builds may use `Log Filename V2`, **?**), `Start Log Upon Connect`, `Log Mode`, `Raw Log`, `New Log File At Midnight`, `Custom Log Message Connect`, `Custom Log Message Disconnect`, `Custom Log Message Each Line`, `Log Only Custom`, `Generate Unique Log File Name When File In Use` | S/D | tokens in section 3.3 | [F] |
| Logon automation | `Use Login Script`, `Login Script V2`, `Use Script File`, `Script Filename` | D/S | Logon Actions expect/send pairs: key names **?** | [F] |
| Paste pacing | `Line Send Delay`, `Character Send Delay`, `Keyboard Char Send Delay` | D | ms (inferred) | [F] |
| Highlighting | `Keyword Set`, `Highlighting Style` | S/D | `<None>` when unset | [F] |
| Button bar | `User Button Bar`, `User Button Bar Name` | D/S | | [F] |
| Terminal | `Rows`, `Cols`, `Scrollback`, `Color Scheme`, `Keymap Name`, `Map Backspace`, `Map Delete`, `Translate Incoming CR To CRLF`, `Enable 80-132 Column Switching` | D/S | `Scrollback` 0x1f4 = 500 lines | [F] |
| Zmodem / Xmodem | `ZModem Receive Command`, `Disable ZModem`, `XModem Send Packet Size`, `Upload Directory`, `Download Directory` | S/D | | [F] |
| TFTP | `Start Tftp Server` | D | | [F] |

**Importer recommendations:**

- Read the whole Sessions tree recursively and preserve folder paths.
- Resolve `Firewall Name=Session:<path>` to a Hopline jump-host reference by path. Report unresolved ones.
- Map `Credential Title` to a Hopline credential profile placeholder.
- **Do not silently decrypt passwords.** Default to asking the user to re-enter them. Decryption of `02:` / `03:` blobs is technically possible (see HyperSine; its tool takes the config passphrase as an optional separate input). If offered at all, make it opt-in and explicit.
- Report skipped protocols (RDP, TAPI, Local Shell).

## Appendix B: SecureCRT XML export (Tools > Export Settings)

Evidence: the structure below is consistent across **three independent open-source importers** and their fixtures:

- [rty813/nexterm](https://github.com/rty813/nexterm/blob/main/src-tauri/src/importer_securecrt.rs)
- [tonhe/linecon](https://github.com/tonhe/linecon/blob/main/crates/linecon-config/src/import.rs)
- [VoltiusApp/voltius](https://github.com/VoltiusApp/voltius/blob/main/src/services/import-export/parsers/securecrt.ts)

The strongest sample is Voltius's fixture [`securecrt-export.xml`](https://github.com/VoltiusApp/voltius/blob/main/src/services/import-export/parsers/__fixtures__/securecrt-export.xml). It looks like a trimmed real export from **SecureCRT on Linux**: it has incidental keys such as `Sftp Terminal Session` and `Linux Printer Baud Rate`, a `Security`/`Passphrase` `03:` verifier, `${VDS_SSH_DATA_PATH}` key paths and `Firewall Name`=`Session:Prod/web`.

Termius also imports this file ([Termius docs](https://docs.termius.com/llms-full.txt)) [V]. **No sample is confirmed as an untouched user export**, so treat this as [3P] and validate against real Windows, macOS and Linux exports from SecureCRT 9.x before shipping.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Global Options"> ... </key>
  <key name="Credentials">
    <key name="lab login">
      <string name="Username">netops</string>
      <string name="Password V2">02:...</string>
    </key>
  </key>
  <key name="Sessions">
    <key name="Default"> ... </key>              <!-- template, skip -->
    <key name="Site">                             <!-- folder -->
      <dword name="Is Session">0</dword>
      <key name="sw3">                            <!-- session -->
        <dword name="Is Session">1</dword>
        <string name="Protocol Name">SSH2</string>
        <string name="Hostname">10.3.3.3</string>
        <dword name="[SSH2] Port">22</dword>       <!-- DECIMAL in XML -->
        <string name="Credential Title">lab login</string>
        <array name="Port Forward Table V2"><string>...</string></array>
        <binary name="Normal Font v2">00 ff ...</binary>
      </key>
    </key>
  </key>
</VanDyke>
```

- **Element types:** `<key name>` is a folder or session node. `<string>`, `<dword>` (decimal, unlike the hex in `.ini`), `<array>` of `<string>` (the `Z` lists) and `<binary>` (space-separated hex) carry values. Option names are identical to the `.ini` keys in A.3.
- **OS-prefixed serial keys:** in the Linux-looking sample, serial options are written as `Linux Com Port` (`/dev/ttyUSB0`), `Linux Baud Rate`, `Linux Parity`, `Linux Stop Bits`, `Linux Data Bits`, `Linux CTS Flow` and `Linux XON Flow`. The Windows real `.ini` files use unprefixed names. Voltius's code comment says the keys "carry the OS that wrote them". A `Mac ` prefix is plausible (a `Mac Normal Font v2` key appears in another fixture) but **?**. Match `<OS> <name>` as a whole key, never by suffix alone, because `Printer Baud Rate` collides.
- **Telling sessions from folders:** use `Is Session`=1, or fall back to "has `Protocol Name` / `Hostname` and no child `<key>`". Folders can carry inherited options such as `Protocol Name` [3P].
- **Nested keys:** one importer's fixture nests a `<key name="Connection">` inside a session. **?** Real exports may not do this, so flatten defensively.
- **Hygiene:** XML-escape names (`&amp;`). Apply the same size and depth limits you would use for untrusted input.

## Appendix C: MobaXterm `.mxtsessions` / `MobaXterm.ini` format

Sources:

- Primary reverse-engineering note, based on MobaXterm 23.6: [Ruzgfpegk gist](https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea) [3P]. A matching PHP library: [sessionator](https://github.com/Ruzgfpegk/sessionator).
- Real lines from public repos and security-tool docs [F]: [metasploit moba_xterm doc](https://github.com/rapid7/metasploit-framework/blob/master/documentation/modules/post/windows/gather/credentials/moba_xterm.md), [BarretRen/DotProfiles moba.mobaconf](https://github.com/BarretRen/DotProfiles), [Nomard/network-infra-obsidian-template](https://github.com/Nomard/network-infra-obsidian-template).
- Importers [3P]: [RustConn](https://github.com/totoshko88/RustConn/blob/main/rustconn-core/src/import/mobaxterm.rs), [xtermium](https://github.com/xtermium/xtermium/blob/main/src/formats/mobaxterm.rs).
- There is **no official spec**.

### C.1 File structure

- **Encoding:** Windows-1252, CRLF line endings, so non-Latin-1 characters are lost [3P].
- **What the files are:** `.mxtsessions` is the `Bookmarks*` sections of `MobaXterm.ini`. `.mobaconf` is a full settings export with the same section syntax; Termius accepts both [V].
- **Folders:**

  ```ini
  [Bookmarks]
  SubRep=
  ImgNum=42
  Session A=#109#0%host%22%user%...#MobaFont%10%...#0# #-1

  [Bookmarks_1]
  SubRep=Network\Core
  ImgNum=41
  core-sw1= #109#0%10.0.0.1%22%admin%...
  ```

  - `[Bookmarks]` is the root, with `SubRep` empty and `ImgNum=42`.
  - `[Bookmarks_N]` is a folder. N sets the display order, and `SubRep` is the path with `\` separators. `ImgNum` is the folder icon (41 = default) [3P].
  - A partial export starts with `SubRep=<selected folder>` [3P].
- **Session line:** `Name=<prefix>#<icon>#<group1>#<group2>#<start mode>#<comment>#<tab color>`.
  - The prefix is empty, a space or `; logout`; real files show both `COM10=#131#...` and `com (usb-serial)= #131#...` [F].
  - `#` separates groups. `%` separates fields within a group. `,` separates sub-fields (e.g. RGB triplets and the expert-settings string) [3P].
  - `<icon>` is a **display icon only**. Defaults: SSH 109, Telnet 98, Serial 131, RDP 91, VNC 128, SFTP 140 [3P]/[F].
  - **Key the session type on group-1 field 0, not the icon**, because users can change icons [3P].
  - Start mode: 0 tab, 1 detached, 2 maximised detached, 3 fullscreen. Tab colour: -1 for default, otherwise decimal RGB [3P].
- **Escapes inside fields** [3P]:

  | Character | Escape |
  |---|---|
  | `;` | `__PTVIRG__` |
  | `"` | `__DBLQUO__` |
  | `\|` | `__PIPE__` (also separates multi-value lists, e.g. gateway chains) |
  | `#` (in comments) | `__DIEZE__` |
  | `%` (in proxy commands) | `__PERCENT__` |
  | `C:` drive in paths | `_CurrentDrive_` (seen in a real log path) [F] |

### C.2 Session type IDs (group 1, field 0)

[3P] from RustConn's enum, with SSH, Telnet, RDP and Serial confirmed by real lines [F].

| ID | Type | ID | Type |
|---|---|---|---|
| 0 | SSH | 8 | Serial |
| 1 | Telnet | 9 | File (local folder) |
| 2 | Rsh / Rlogin | 10 | Shell (local) |
| 3 | XDMCP | 11 | Browser |
| 4 | RDP | 12 | Mosh |
| 5 | VNC | 13 | AWS S3 |
| 6 | FTP | 14 | WSL |
| 7 | SFTP | | |

### C.3 SSH (type 0) group 1 fields

Source: gist [3P]. Sample line: `#109#0%localhost%22%<default>%...`.

| Idx | Meaning | Default / values |
|---|---|---|
| 0 | type | 0 |
| 1 | host | required |
| 2 | port | 22 |
| 3 | username | empty |
| 4 | (unspecified) | |
| 5 | X11 forwarding | -1 on, 0 off |
| 6 | compression | -1 / 0 |
| 7 | remote command | escaped |
| 8 | SSH gateway host(s) | `__PIPE__`-separated chain |
| 9 | gateway port(s) | `__PIPE__`-separated |
| 10 | gateway user(s) | `__PIPE__`-separated |
| 11 | don't exit after command | flag |
| 12 | don't specify username | flag |
| 13 | remote environment | 0 = interactive shell |
| 14 | private key path | |
| 15 | gateway private key(s) | |
| 16–17 | file browser type / follow SSH path | |
| 19 | proxy type | 0 none, 1 SOCKS4, 2 SOCKS5, 3 HTTP, 4 Telnet, 5 local, 6 SSH forwarding, 7 SSH command |
| 20–22 | proxy host / port (1080) / login | |
| 23 | adapt locales | |
| 24–25 | SCP-over-SFTP flag / file protocol | 0 off, 1 SFTP, 2 SCP fast, 3 SCP normal |
| 26 | local / SSH proxy command | `__PERCENT__` escapes |
| 27 | SSH version | 0 auto, 1 v2, 2 v1 |
| 28–30 | KEX / host-key types / ciphers | ordered lists |
| 31–34 | disconnect on trivial auth / prefer known host keys / use SSH agent / **agent forwarding** | flags |
| 35–36 | certificate / host certificate | |
| 37 | filter KEX | |

**Group 2 (terminal), shared across terminal-type sessions** [3P]:

| Idx | Meaning | Default / values |
|---|---|---|
| 0 | font | `MobaFont` |
| 1 | size | 10 |
| 5 | charset | 15 = UTF-8 |
| 6–8 | fg / bg / cursor RGB | e.g. `236,236,236` |
| 9 | cursor type | |
| 10 | Backspace sends ^H | |
| 11 | **log output** | flag |
| 12 | **log folder** | real sample: `_CurrentDrive_:\Logs` [F] |
| 13 | terminal type | `xterm` |
| 16 | colour scheme | `_Std_Colors_0_` |
| 17–19 | fixed size settings | |
| 20 | **syntax highlighting** | 0 none, 1 standard, 2 Unix, 3 **Cisco**, 4 Perl, 5 SQL, 101+ custom |
| 22–23 | macro | |
| 24 | paste delay | 0–13 |
| 28 | expert settings | comma sub-string; sub-field 11 = scrollback lines, empty means 360000 |

### C.4 Telnet (type 1)

[3P] from two importers plus generator scripts. No vendor confirmation of fields beyond index 2.

- Layout: `#98#1%<host>%<port>%...`. Index 1 is host and index 2 is port (default 23).
- Template used by a GNS3 generator script (host and port filled in here): `#98#1%10.0.0.5%5000%%%2%%%%%0%0%%1080%%#MobaFont%10%...` ([generator](https://github.com/missaelcorm-iteso/ITESO-Ruteo-Avanzado-Practicas)).
- The remaining indices are undecoded. They likely include a gateway and proxy (index 13 = 1080 looks like a proxy port), but that is **?**.

### C.5 Serial (type 8): partly decoded

Real lines [F]:

```
COM10=#131#8%0%1115200%3%0%0%1%2%COM10  (USB-SERIAL CH340 (COM10))#JetBrains Mono%12%...
com (usb-serial)= #131#8%-2%1009600%3%0%0%1%2%COM3  (USB Serial Port (COM3))#MobaFont%10%...
#131#8%0%1009600%3%0%0%1%2%COM2  (... (COM2))#MobaFont%10%...
Serial (COM)=#131#8%1%1009600%3%0%0%1%0%COM3  (USB Serial Port (COM3))%0#0# #-1
```

The last line is from an importer test fixture, not a confirmed real export.

| Idx | Observed | Interpretation |
|---|---|---|
| 0 | `8` | type = Serial (sure) |
| 1 | `0`, `1`, `-2` | **unknown** |
| 2 | `1009600`, `1115200` | **encoded baud.** Consistent with `1000000 + baud` (9600 / 115200). That is a hypothesis from 3 samples; xtermium uses suffix matching instead |
| 3 | `3` | data bits, probably an index (3 → 8 bits). **?** |
| 4 | `0` | parity (0 = none)? **?** |
| 5 | `0` | stop bits (0 = 1)? **?** |
| 6 | `1` | **unknown** |
| 7 | `2` or `0` | flow control? **?** |
| 8 | `COM10  (USB-SERIAL CH340 (COM10))` | port: take the first token (`COM10`); the rest is the Windows device description |

RustConn's documented serial layout (port at index 1, plain baud at index 2) **does not match these real lines**, and termwright uses yet another layout. Do not copy either.

**Recommendation:** import the port and baud with the hypothesis above, show the user a confirmation screen for the serial settings, and log any unknown values. Before release, collect a few more real exports (115200/9600, with and without flow control, with odd parity) to finish decoding.

### C.6 Other sections and passwords

- `[PortForwarding]` (from an importer comment [3P], format **?**): `0000.Name=Local;user@host:22;dest:port;listen;?;key;bind;proxy;-1`.
- **Passwords and credentials** are not in `.mxtsessions` lines. They are stored encrypted with the master password, in registry keys for installed builds or `[Passwords]` / `[Credentials]` sections in the portable `.ini`. That location is [3P] and the details are **?**; Metasploit's module reads both ([doc](https://github.com/rapid7/metasploit-framework/blob/master/documentation/modules/post/windows/gather/credentials/moba_xterm.md)).
- Termius can import encrypted `.mobaconf` with the user's passphrase [V]. For Hopline v1, skip passwords and prompt instead.

## Appendix D: Other import sources (brief)

- **OpenSSH `~/.ssh/config`:** map `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump` (chain, comma-separated), `ProxyCommand`, `ForwardAgent`, `ForwardX11`, `LocalForward` / `RemoteForward` / `DynamicForward`, `ServerAliveInterval` / `ServerAliveCountMax`, `ConnectTimeout`, `KexAlgorithms` / `Ciphers` / `MACs` / `HostKeyAlgorithms`. This is the same property set Tabby's importer maps ([sshImporters.ts](https://github.com/Eugeny/tabby/blob/master/tabby-electron/src/sshImporters.ts)). Termius ignores `ProxyCommand` [V]; Hopline should at least warn.
- **PuTTY:** registry `HKCU\Software\SimonTatham\PuTTY\Sessions\<url-encoded name>` (well-known; not re-verified here). On non-Windows, Termius accepts a `.reg` export [V].
- **CSV:** mirror SecureCRT's Text Import Wizard columns (section 3.1) so engineers can reuse their existing NetBox/Nautobot exports.

---

## Sources (consolidated)

Vendor:
- SecureCRT: [product](https://www.vandyke.com/products/securecrt/index.html), [key features](https://vandyke.com/products/securecrt/key_features.html), [history](https://www.vandyke.com/products/securecrt/history.txt), [pricing](https://www.vandyke.com/pricing/), [updates](https://vandyke.com/support/updates.html), [logging tip](https://vandyke.com/support/tips/configure-automated-logging-in-securecrt.html), [command window tip](https://www.vandyke.com/support/tips/chatsendcom.html), [text import wizard](https://vandyke.com/support/tips/import-securecrt-sessions-from-csv-or-text-file-data-using-text-import-wizard.html), [import sessions](https://vandyke.com/support/tips/importsessions.html), [SOCKS jump](https://vandyke.com/support/tips/socksproxy.html), [logon actions jump](https://www.vandyke.com/support/tips/use-logon-actions-to-connect-to-secondary-host-behind-a-jumphost-gateway.html), [keyword ini import](https://www.vandyke.com/support/scripting/scripting-examples/import-keyword-highlighting-ini-files.html), [iterate-sessions script](https://vandyke.com/support/scripting/scripting-examples/scripts/IterateOverAllSessionsRecursively_ConfFileOutputFormat.vbs.txt)
- MobaXterm: [features](https://mobaxterm.mobatek.net/features.html), [download / editions](https://mobaxterm.mobatek.net/download.html), [preview](https://mobaxterm.mobatek.net/preview.html)
- Termius: [pricing](https://termius.com/pricing), [docs (full)](https://docs.termius.com/llms-full.txt), [serial](https://termius.com/documentation/connect-via-serial), [account FAQ](https://docs.termius.com/help-center/faq/why-am-i-required-to-create-an-account)
- Tabby: [repo](https://github.com/Eugeny/tabby), [issues](https://github.com/Eugeny/tabby/issues)
- Royal: [TSX features](https://www.royalapps.com/ts/mac/features), [TS features](https://www.royalapps.com/ts/win/features), [serial blog](https://royalapps.com/blog/new-feature-rs232-serial-port-communication-for-terminal-connection)

Real files and third party: listed inline in Appendices A–C.

Users:
- [r/networking "What terminal do you use?" (archived)](http://web.archive.org/web/20250328021745/https://www.reddit.com/r/networking/comments/1ibwkny/what_terminal_do_you_use/)
- HN: [1](https://news.ycombinator.com/item?id=47466197), [2](https://news.ycombinator.com/item?id=45362237), [3](https://news.ycombinator.com/item?id=9369663), [4](https://news.ycombinator.com/item?id=47209916)
- [Royal community: Send Break](https://community.royalapps.com/t/submit-break-to-terminal/1402)
- [Trustpilot Termius](https://ca.trustpilot.com/review/termius.com)
- [AlternativeTo Termius](https://alternativeto.net/software/serverauditor/about/)
- [G2 SecureCRT reviews](https://www.g2.com/products/securecrt/reviews)
