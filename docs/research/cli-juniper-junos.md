# Juniper Junos OS CLI reference for Hopline

> **Scope:** Junos OS on MX, EX, QFX and SRX, aimed at 21.x through 23.x. Junos OS Evolved differences are noted briefly in sections 1, 6 and 10.
>
> **Caveat on versions:** the vendor pages fetched this session are mostly the *current* CLI User Guide and CLI Reference, which show 24.x output. Some legacy pages cover 12.x–13.x. The ntc-templates captures are from 13.x–19.x. Column layouts have been stable across these releases, but there is no single source for exactly 21–23.
>
> **Researched:** 2026-11.
>
> **Note on URLs:** every `www.juniper.net/documentation/us/en/...` URL now returns a 301 redirect to `networkingdocs.hpe.com/documentation/us/en/...`. URLs below are the host that actually served the content.
>
> **Confidence legend:**
> - **[S1]...[S30]** (and S17b, S-route-summary, S-alarms, S-uptime) mean verified on that fetched vendor page; each tag is a link to the URL listed under Sources.
> - **[Nx]** means a secondary source: an ntc-templates raw capture or a mailing-list post.
> - **[unverified, from memory]** means not seen in any source this session.
>
> **Sample values:** all values in samples are invented for the Hopline lab topology below. Layouts are copied from the cited source.

**Lab topology used in every sample (consistent with the IOS fixture core-sw1):**

| Device | Role | Key facts |
|---|---|---|
| `edge-r1` (vMX, Junos 22.4R3.25) | edge router | user `netops`; AS 65000; router-id / lo0.0 10.255.0.2/32 |
| `edge-r1` ge-0/0/1.0 | link to core-sw1 | 10.0.0.6/30; eBGP + OSPF area 0 to core-sw1 Gi1/0/1 10.0.0.5 (AS 65001, router-id 10.255.0.1) |
| `edge-r1` ge-0/0/0.0 | transit uplink | 203.0.113.2/30; eBGP to transit 203.0.113.1, AS 64500 (session down, `Active`) |
| `edge-r1` ge-0/0/2 | spare | admin down |
| `edge-r1` fxp0.0 | management | 192.168.100.11/24 in `mgmt_junos` |
| `acc-ex1` (EX2300-48P, 2-member Virtual Chassis) | switch-only samples | VLANs USERS (10), PRINTERS (20), WIFI (30); uplink ae0 |
| `srx-fw1` (SRX1500 chassis cluster, node0 primary) | cluster samples only | |

---

## 1. Prompts

### 1.1 Mode prompts

| Mode | Prompt / banner | Source |
|---|---|---|
| Operational | `netops@edge-r1> ` (format `user@host>`) | "The default CLI prompt is `user@host>`." [S4] |
| Configuration, top level | `[edit]` banner line, then `netops@edge-r1# ` | [S1] |
| Configuration, sub-hierarchy | `[edit interfaces ge-0/0/1 unit 0]`, then `netops@edge-r1# ` | `[edit security zones security-zone myzone]` example in [S1] |
| `configure private` | banner shown as `[edit]` or `[edit private]` [unverified]; the docs only mention "the [edit private] configuration mode" | [S3] |
| Root on the shell | `root@edge-r1:~ # ` (FreeBSD csh), then `cli` gives `root@edge-r1> ` | [unverified, from memory]. [S1] shows `% cli` then `user@host>`. |
| Logical system | `user@host:LSYS1> ` | seen in a `show log` example in [S23] |

Junos uses **no `(config-if)`-style sub-mode prompt**. The prompt character only changes `>` to `#`. The hierarchy level is shown in a separate **banner line** printed above every config-mode prompt.

Operational mode to configuration mode, verbatim from [S1]:

```
user@host> configure 
Entering configuration mode

[edit]
user@host# 
```

Moving into a sub-hierarchy with `edit`, verbatim from [S1]:

```
[edit]
user@host# edit security zones security-zone myzone
[edit security zones security-zone myzone]
user@host#
```

Applied to the lab topology:

```
netops@edge-r1> configure
Entering configuration mode

[edit]
netops@edge-r1# edit interfaces ge-0/0/1 unit 0

[edit interfaces ge-0/0/1 unit 0]
netops@edge-r1# top

[edit]
netops@edge-r1#
```

Notes on this transcript:
- **Blank line before the banner:** a real device prints an empty line before each `[edit ...]` banner [unverified, from memory]. The doc transcripts are inconsistent: [S1]'s `configure` example has the blank line, but its `edit` example does not.
- **Capitalization drifts across vendor pages.** [S1] and [S7] print "Entering configuration mode". The rollback example in [S1] prints "entering configuration mode". For exit, [S8] prints "exiting configuration mode" and [S1] prints "Exiting configuration mode". Real devices print "Entering configuration mode" and "Exiting configuration mode" [unverified, from memory]. A regex should be case-insensitive.

### 1.2 Multi-context banners

Junos prints the redundancy or membership state as a `{...}` line **above** the prompt (and above `[edit]` in config mode).

| Context | Banner | Evidence |
|---|---|---|
| SRX chassis cluster | `{primary:node0}` / `{secondary:node1}` | `{primary:node0}` then `user@host> show chassis cluster interfaces`, and `{primary:node0}` then `user@host# show chassis cluster status` [S30] |
| EX/QFX Virtual Chassis or a single EX/QFX (non-VC EX also prints it) | `{master:0}` (and `{backup:1}` on the backup RE/member [unverified, from memory]) | Secondary only: ntc captures end with an empty line then `{master:0}` [N1][N3][N4]. The juniper-nsp post shows `{master:0}` directly before `root>` [N5]. |
| Dual-RE MX/PTX with GRES | `{master}` / `{backup}` | `<banner>{master}</banner>` in an XML `rpc-reply` in [S5]. The CLI form is [unverified, from memory]. |

Example (secondary layout, values invented):

```
{master:0}
netops@acc-ex1> show ethernet-switching table
...

{master:0}
netops@acc-ex1> configure
Entering configuration mode

{master:0}[edit]
netops@acc-ex1#
```

On the combined form `{master:0}[edit]` in config mode: the search summary for the SRX cluster page mentioned "{primary:node0}[edit]", but I could not confirm it in the saved page text [unverified].

### 1.3 Hostnames

- **Dots and dashes:** the prompt uses `system host-name` verbatim. Dashes are kept (`edge-r1`). Whether a host-name containing dots is shown in full or cut at the first dot is [unverified, from memory]. The common practice is a short `host-name` plus a separate `domain-name`, so the prompt rarely contains dots.
- **Override:** `set cli prompt "<string>"` changes the prompt. The change is "not persistent across CLI sessions" [S4].
- **Prompt-detection regex suggestion:** `^(\{[a-z]+(:[\w]+)?\}\r?\n)?(\[edit[^\]]*\]\r?\n)?[\w.@-]+(:[\w-]+)?[>#] ?$`. Because the banner lines precede the prompt line, Hopline should treat the `{...}` line and the `[edit ...]` line as **prompt decoration, not command output**.

### 1.4 Junos OS Evolved

The prompt, banners and modes are the same as on Junos OS [unverified, from memory]. Evolved runs on Linux, so `start shell` drops to bash rather than csh [unverified, from memory].

---

## 2. Paging

**Pager string:** `---(more)---`, three dashes on each side and no surrounding spaces [S5][S10]. When the CLI knows the total output size, it inserts a percentage. With configuration breadcrumbs enabled, the hierarchy path is appended. [S4] shows both forms verbatim:

```
---(more 18%)-----------------------------------------------------
---(more 18%)---[groups main interfaces fe-4/1/2 unit 0 family inet address 64.12.137.187/27 vrrp-group 1]---
```

The first line is 66 characters, so the trailing dashes appear to pad the line to a fixed width. The padding rule is [unverified]. A suggested detection regex is `---\(more( \d+%)?\)---`. Do **not** anchor it at end of line.

**Default length:** 24 lines. Width defaults to 80 and can be 0 or 40–1024 [S4].

### 2.1 Keys at the `---(more)---` prompt

Verbatim from [S10] ("Table 1: Keyboard Shortcuts at the ---(more)--- Prompt"). Oddities in the original are kept and marked *sic*.

| Keys | Action |
|---|---|
| Enter, Return, k, Ctrl+m, Ctrl+n, down arrow | Scroll down one line |
| Tab, d, Ctrl+d, Ctrl+x | Scroll down one-half screen |
| Space, Ctrl+f | Scroll down one whole screen |
| Ctrl+e or g | Scroll down to the bottom of the output |
| n (or no-more) | Display the output all at once |
| j, Ctrl-h, Ctrl-p, up arrow | Scroll up one line |
| u, Ctrl-u | Scroll up one-half screen |
| b, Ctrl-b | Scroll up one whole screen |
| Ctrl-a or g | "Scroll up to the bottom of the output" (*sic*: `g` is listed twice, and "bottom" presumably means top) |
| /string | Search forward |
| ?string | Search backward |
| n | Repeat previous search (*sic*: `n` is also listed as "no-more") |
| m or M | Find text (prompts for a string), like `\| match` |
| e or E | Find, ignoring a string, like `\| except` |
| Ctrl-C, q, Q, Ctrl-k | Interrupt the display of output |
| H | Hold at the more prompt after all output, like `\| hold` |
| c or C | Clear match conditions and show the full output |
| Ctrl-l | Redraw |
| s or S | Save output to a file (prompts for a filename) |

[S4] adds that pressing **h** shows all options ("navigation, searching, and saving"). That key is not in the [S10] table.

Note that `k` scrolls *down* and `j` scrolls *up* in this table, the reverse of vi. That is what the vendor table says. Treat it as verbatim, not as a verified real-device behavior.

### 2.2 Disabling paging

| Scope | Command | Source |
|---|---|---|
| One command | `show configuration \| no-more` | [S5] |
| Session | `set cli screen-length 0` ("disables the use of 'one screen at a time' output") | [S4] |
| Session width | `set cli screen-width 0` (0 is allowed) | [S4] |
| Persistent | No login-class or user statement for screen-length was found. Automation tools issue `set cli screen-length 0` at every login. | [unverified, from memory] |

### 2.3 Pager erase behavior

Whether Junos erases the `---(more)---` text after a keypress (with CR plus spaces, or with backspaces) is **[unverified, from memory]**. My recollection is that the line is overwritten (`\r`, then blanks, then `\r`) and the next output starts on the same row. Hopline's terminal should strip the pattern from captured output whichever way it is erased.

---

## 3. Help and completion

### 3.1 `?` after a space: list options

The format is the literal header `Possible completions:`, then one entry per line: keyword padded to about 21 columns, then the help text. The header lines below are verbatim from [S6] and [S1]:

```
user@host> clear ? 
Possible completions:
arp 	      Clear address-resolution information
bgp          Clear BGP information
...
user@host> clear
```

After the list, the CLI **re-displays the prompt and the typed text** ("lists the available commands and options and then re-displays the command names and options you typed") [S6].

Special markers [S1][S5]:
- `<[Enter]>` with "Execute this command": the command is complete as typed.
- `<name>`: a user-supplied value, for example `<name>               Name of RIP neighbor`.
- `>` prefix (config mode): a container you can `edit` into.
- `|` with "Pipe through a command".

Config-mode example, verbatim from [S1]:

```
user@host# edit security zones ?
Possible completions:
   <[Enter]>                Execute this command 
> functional-zone      Functional zone 
> security-zone          Security zones   
|                                  Pipe through a command 
[edit]
```

Value completions (policy names, interfaces) use the same layout, with a `<policy_name>` placeholder row first [S8].

### 3.2 `?` inside a word: prefix completion

Verbatim from [S6]:

```
user@host> c?
Possible completions:
clear      Clear information in the system
configure  Manipulate software configuration information
user@host> c
```

### 3.3 Space and Tab completion

- **Both keys complete.** "To complete a command or option that you have partially typed, press Tab or Space. If the partially typed letters begin a string that uniquely identifies a command, the complete command name appears. Otherwise, a prompt indicates that you have entered an ambiguous command" [S6].
- **Filenames, interface names and usernames complete with Tab only.** "Pressing Spacebar does not work" for them [S12].
- **Space completion is optional:** `set cli complete-on-space (on | off)`, default on [S12].

**Consequence for Hopline (important):** with complete-on-space on, the device echoes *more characters than were typed*. Typing `sh` then space echoes `show `. Hopline's echo or ghost-text logic must not assume byte-for-byte echo. The engine could send `set cli complete-on-space off` on agent sessions.

Ambiguous completion with Space, verbatim from [S14] and [S13]:

```
user@host> sh<Space>ow i<Space>
'i' is ambiguous.
Possible completions:
igmp                   Show information about IGMP
interface              Show interface information
isis                   Show information about IS-IS

user@host> show in<Space>terfaces
```

The same message on a 21.x EX after Enter, with caret and banner, from [N5] (secondary):

```
root> show sy
             ^
'sy' is ambiguous.
Possible completions:
  synchronous-ethernet  Show synchronous ethernet related information
  system               Show system information
{master:0}
root>
```

### 3.4 Abbreviation

Any unique prefix of a keyword is accepted on Enter, as in `sh int te` for `show interfaces terse` [unverified, from memory; [S12] documents only Tab/Space completion of unique prefixes]. Exact matches win. Abbreviations do **not** apply to user values such as interface names; `ge-0/0/1` must be typed in full or Tab-completed [unverified, from memory].

Top-level operational keywords are listed in two fetched `?` outputs, and abbreviation conflicts follow from them:
- [S1] (root@ variant): `clear configure diagnose file help monitor mtrace ping quit request restart set show ...`
- [S6]: `clear configure file help mtrace monitor ping quit request restart set show ssh start telnet test traceroute`

### 3.5 Error formats

The caret line is aligned to **absolute screen columns, counting the prompt**. Measured from the two available samples:
- [S2] `user@host# set protocols ospf area` puts `^` at column 32. The token `area` spans columns 30–33.
- [N5] `root> show sy` puts `^` at column 13. The token `sy` spans columns 11–12, so the caret sits one column past its end.

Both samples put the caret at or near the **end of the last token**, measured from column 0 of the prompt line. The vendor HTML may have lost a space. The rule for an invalid *middle* token (caret under that token's first character) is [unverified, from memory].

| Situation | Exact output | Source |
|---|---|---|
| Missing required argument | caret line, then `syntax error, expecting <identifier>` (no trailing period on the doc page) | [S2] |
| Bad statement (wildcard example) | `syntax error.` | [S2] |
| Ambiguous token | caret line, then `'sy' is ambiguous.` then `Possible completions:` and the candidates | [S14][N5] |
| Invalid keyword under a known command (`show foo`) | caret line, then `syntax error, expecting <command>: foo` | [unverified, from memory]. A search snippet of a Juniper community thread quoted `syntax error, expecting <command>: analyzer`, but the page redirected and could not be fetched. |
| Invalid keyword, older form | `syntax error, expecting <command>.` | **[unverified]**: not found in any fetched source |
| Unknown first word (`foo`, or `ping` typed in config mode) | caret line, then `unknown command.` | [unverified, from memory]. [N6] says only that typing `ping` in config mode is "an unknown command". |
| `error: unknown command` | **no source found**. Junos does use an `error: ` prefix for runtime errors, for example `error: tee failed: file /home/user/test.txt could not be opened` [S5] and `error: access has been revoked.` [S7]. | [unverified] |
| Missing mandatory statement | `Warning: missing mandatory statement: 'mode'` | [S6] |
| Wildcard on an empty hierarchy | `warning: statement not found` | [S2] |
| Commit-time error | `[edit edit-path]`, then `'offending-statement;'`, then the message. Example: `keyword 'echo-reply' unrecognized`. Full failure ends `error: configuration check-out failed`. | [S3] |

Unlike IOS, Junos has **no `% Incomplete command.`**. A command that is incomplete on Enter gets `syntax error, expecting <...>` with a caret, and running a container-only operational command shows the completions [unverified, from memory].

Recommended simulator transcript for `show foo` on edge-r1 (marked unverified):

```
netops@edge-r1> show foo
                     ^
syntax error, expecting <command>: foo

netops@edge-r1>
```

---

## 4. Control characters

Emacs-style editing, verbatim from [S11] ("They are the same as those used in Emacs"):

| Key | Action |
|---|---|
| Ctrl+b / Ctrl+f | back / forward one character |
| Esc+b or Alt+b / Esc+f or Alt+f | back / forward one word |
| Ctrl+a / Ctrl+e | start / end of line |
| Ctrl+h, Delete, Backspace | delete the character before the cursor |
| Ctrl+d | delete the character at the cursor |
| Ctrl+k | delete to end of line |
| **Ctrl+u or Ctrl+x** | delete the whole line |
| **Ctrl+w**, Esc+Backspace, Alt+Backspace | delete the word before the cursor |
| Esc+d or Alt+d | delete the word after the cursor |
| Ctrl+y | yank (paste) the last deleted text |
| Ctrl+l | redraw the current line |
| Ctrl+p / Ctrl+n | history back / forward |
| **Ctrl+r** | reverse incremental history search |
| Esc+/ | expand the typed text to the most recent history word with that prefix |
| Esc+. or Alt+. | cycle through recently entered words |
| Esc+number sequence | repeat a sequence 1–9 times |

The following keys are platform-specific, and none of them is in a fetched table:
- **Ctrl+C** interrupts a running command: an endless `ping` (which prints its statistics), `monitor`, or the pager (Ctrl-C at `---(more)---` is in [S10]). At an empty prompt it cancels the line. It does **not** leave configuration mode [unverified, from memory].
- **Ctrl+Z** has no IOS-style "end" meaning. Junos has no `end` command; use `top` and then `exit`, or `exit configuration-mode` [unverified, from memory].
- **Ctrl+D** at an empty operational prompt may log out (csh/FreeBSD heritage) [unverified, from memory]. It also ends `load ... terminal` input: "[Type ^D at a new line to end input]" [S9].
- **Ctrl-Shift-6** is not used. There is no break-sequence concept; Ctrl+C serves that role.

---

## 5. Config model

### 5.1 Concepts

- **Candidate and active.** Configuration mode edits a *candidate* configuration. `commit` validates it (`commit check`) and activates it [S3]. There is no separate startup-config: the committed configuration is persistent. **`commit` is the save-to-startup equivalent.** The candidate file is `/var/rundb/juniper.db` [S3].
- **Three ways to enter** [S7]:
  - `configure`: a shared candidate. Other users' uncommitted changes get committed along with yours.
  - `configure exclusive`: locks the candidate. Others can edit but not commit.
  - `configure private`: a private copy. The first commit wins. Use `update` to merge in others' changes.
  - Up to 32 concurrent configuration users [S7]. On a chassis cluster, plain `configure` enters private mode [S7].
- **Rollback history.** `rollback 0` is the active configuration; `rollback N` loads revision N into the candidate. Bare `rollback` prints `load complete` [S1]. The retention limit (49 previous plus the active) is [unverified, from memory].

### 5.2 Verbatim transcripts

Entering configuration mode when someone else is editing [S8]:

```
user@host> configure 
Entering configuration mode
Users currently editing the configuration:
  root terminal d0 (pid 4137) on since 2008-04-09 23:03:07 PDT, idle 7w6d 08:22
  [edit]
The configuration has been changed but not committed

[edit]
user@host# 
```

`configure exclusive` with a discard on quit [S7]:

```
user@host> configure exclusive 
warning: uncommitted changes will be discarded on exit
Entering configuration mode
[edit]
user@host# set system host-name cool 
[edit]
user@host# quit 
The configuration has been changed but not committed
warning: Auto rollback on exiting 'configure exclusive'
Discard uncommitted changes? [yes,no]yes 
warning: discarding uncommitted changes
load complete
Exiting configuration mode
```

The `warning: uncommitted changes will be discarded on exit` line is documented for **`configure exclusive`**. For `configure private` the same warning is [unverified, from memory].

`commit`, `commit check` and `commit confirmed` [S3]:

```
[edit]
user@host# commit
commit complete

[edit]
user@host# commit check 
configuration check succeeds

[edit]
user@host# commit confirmed 
commit confirmed will be automatically rolled back in 10 minutes unless confirmed
commit complete
#commit confirmed will be rolled back in 10 minutes
[edit]
user@host#
```

- **`commit confirmed N`** takes N in minutes; the default is 10. Confirm with `commit` or `commit check` before the timer expires [S3]. The range 1–65535 is [unverified]; it appeared only in a search summary.
- **The countdown banner** `# commit confirmed will be rolled back in N minutes` repeats above subsequent prompts [S3][S7].
- **On timeout,** a broadcast message goes to all logged-in users [S3]. The broadcast text itself was not shown. An exclusive session then gets `Commit was not confirmed; automatic rollback complete.` and later `error: access has been revoked.` [S7].
- **Pending rollback** is visible in `show system commit`: `0   2022-05-06 06:33:42 PDT by root via cli commit confirmed, rollback in 10mins` [S27].

Other commit forms [S3]:
- `commit comment "text"` (up to 512 characters).
- `commit and-quit` prints `commit complete`, then `Exiting configuration mode` [S1].
- `commit at "18:00:00"` or `commit at reboot`. `show system commit` then shows `commit requested by root via cli at ...` [S27].
- `commit synchronize` copies the commit to both REs or both cluster nodes.
- `commit prepare` / `commit activate`.
- `commit | display detail`.
- Since 24.2R1, `force-commit-log` can make commit comments mandatory.

### 5.3 Exit with uncommitted changes

Verbatim from [S8] and [S15]:

```
[edit]
user@host# exit
The configuration has been changed but not committed
Exit with uncommitted changes? [yes,no] (yes) 
Exiting configuration mode
user@host> 
```

```
[edit]
user@host# exit configuration-mode
The configuration has been changed but not committed
Exiting configuration mode
user@host> 
```

- **`exit configuration-mode` warns but does not prompt** ("useful when you are using scripts") [S8].
- **`exit` from a sub-level** goes up one level and does not leave config mode. Only `exit` at `[edit]` leaves [S1]. [S1] also says: "You must navigate to the top of the hierarchy using the up or top commands before you can exit configuration mode."
- **The confirm prompt `[yes,no] (yes)`** defaults to **yes**. The reboot prompt `[yes,no] (no)` defaults to **no**. Typing `yes` or `no` in full is accepted. Whether `y` alone is accepted is [unverified, from memory].

### 5.4 Compare, load and rollback

`show | compare` (config mode) or `show configuration | compare rollback N` (operational mode) [S5]:

```
user@host> show configuration system | compare rollback 9
[edit system]
+ host-name device;
+ backup-router 192.168.71.254;
- ports {
-     console log-out-on-disconnect;
- }
```

The format is the `[edit path]` header, then `+` for statements only in the candidate, `-` for statements only in the comparison, and a space for unchanged context [S5].

`load (factory-default | merge | override | patch | replace | set | update) terminal <relative> <json>` [S9]:
- **`override`** replaces the whole candidate.
- **`merge`** combines the input into the candidate.
- **`replace`** acts on `replace:` tags.
- **`patch`** applies `show | compare` output.
- **`set`** runs set commands line by line.

Verbatim from [S9]:

```
[edit system]
user@host# load replace terminal relative
[Type ^D at a new line to end input]
replace: static-host-mapping {
    bob sysid 0123.456.789bc;
}
load complete
```

Typical change flow on edge-r1 (values invented):

```
netops@edge-r1> configure
Entering configuration mode

[edit]
netops@edge-r1# set interfaces ge-0/0/2 description SPARE

[edit]
netops@edge-r1# show | compare
[edit interfaces ge-0/0/2]
+   description SPARE;

[edit]
netops@edge-r1# commit confirmed 5 comment "spare desc"
commit confirmed will be automatically rolled back in 5 minutes unless confirmed
commit complete

# commit confirmed will be rolled back in 5 minutes
[edit]
netops@edge-r1# commit
commit complete

[edit]
netops@edge-r1# exit
Exiting configuration mode

netops@edge-r1>
```

`status` (config mode) lists the other editors and their `[edit ...]` levels, with `exclusive [edit]` for a lock holder [S2].

---

## 6. Show commands

### 6.1 Most-used troubleshooting commands

| # | Command | Purpose | Notes |
|---|---|---|---|
| 1 | `show interfaces terse` | One line per IFD/IFL with admin, link, proto and address | Filter with `show interfaces terse ge-*`. See 6.2.1. |
| 2 | `show interfaces ge-0/0/1` | Detail for one IFD and its units | `extensive` adds errors and counters |
| 3 | `show interfaces descriptions` | Interface descriptions | |
| 4 | `show interfaces diagnostics optics ge-0/0/1` | Optical DOM levels | |
| 5 | `show bgp summary` | BGP peers, state, prefixes | See 6.2.2 |
| 6 | `show bgp neighbor 10.0.0.5` | BGP neighbor detail | header `Peer: 10.255.7.250+179 AS 65010   Local: 10.255.7.248+63740 AS 65010` [S17b] |
| 7 | `show route receive-protocol bgp 10.0.0.5` | Adj-RIB-in from a peer | |
| 8 | `show route advertising-protocol bgp 10.0.0.5` | Adj-RIB-out to a peer | |
| 9 | `show ospf neighbor` | OSPF adjacencies | See 6.2.3 |
| 10 | `show ospf interface` | OSPF interfaces, DR/BDR | |
| 11 | `show ospf database` | LSDB | |
| 12 | `show route` | RIB; `show route 10.0.0.0/30 exact`, `show route table inet.0 terse` | See 6.2.4 |
| 13 | `show route summary` | Per-table and per-protocol counts | starts `Autonomous system number:` then `Router ID:` [S-route-summary] |
| 14 | `show route forwarding-table destination X` | FIB entry | |
| 15 | `show arp no-resolve` | ARP table without DNS lookups | See 6.2.5 |
| 16 | `show ipv6 neighbors` | IPv6 ND table | |
| 17 | `show ethernet-switching table` | MAC table on EX/QFX (ELS) | See 6.2.6. On MX use `show bridge mac-table`. |
| 18 | `show vlans` | VLANs on EX/QFX | On MX use `show bridge domain`. |
| 19 | `show lldp neighbors` | LLDP neighbors | See 6.2.7. Junos has no CDP. |
| 20 | `show lacp interfaces` | LAG member state | |
| 21 | `show version` | Model and Junos version | See 6.2.8 |
| 22 | `show chassis hardware` | Inventory and serials | |
| 23 | `show chassis alarms` / `show system alarms` | Active alarms; idle output is `No alarms are currently active` | [S-alarms] |
| 24 | `show chassis routing-engine` | RE CPU, memory, uptime | |
| 25 | `show chassis environment` / `show chassis fpc pic-status` | Environmentals, line cards | |
| 26 | `show system uptime` | Boot and last-config times | starts `Current time:` [S-uptime] |
| 27 | `show system users` | Logged-in users | |
| 28 | `show system commit` | Commit history; pending confirmed rollback | [S27] |
| 29 | `show system storage` | Disk usage | |
| 30 | `show system processes extensive` | Like `top` | |
| 31 | `show log messages` | Main syslog file | See 6.2.9. Bare `show log` lists the files [S23]. |
| 32 | `show configuration` / `show configuration \| display set` | Committed configuration | See 6.2.10 |
| 33 | `show firewall` / `show firewall filter NAME` | Filter counters | |
| 34 | `show bfd session` | BFD state | |
| 35 | `show virtual-chassis` | VC members and roles (EX/QFX) | [S25] |
| 36 | `show chassis cluster status` | SRX HA redundancy groups | [S26] |
| 37 | `show security flow session summary` | SRX session table | |
| 38 | `show security zones terse` / `show security policies` | SRX zones and policies | |
| 39 | `ping 10.0.0.5 count 5 rapid` | Reachability | **Without `count` it runs until Ctrl+C** (the guard already enforces this). |
| 40 | `traceroute 10.0.0.5 no-resolve` | Path | |

### 6.2 Sample output (top 10)

Each block notes where its layout came from. All values are invented for the lab topology.

#### 6.2.1 `show interfaces terse`

Layout: header line verbatim from [S16].
- Columns start at 0 (Interface), 24 (Admin), 30 (Link), 35 (Proto) and 44 (Local).
- The Remote column starts at 66. For /32 local addresses `-->` sits at column 64.
- A second address or family on the same unit repeats on a continuation line, with Proto at column 35 and Local at 44.
- A real MX lists many more pseudo-interfaces than shown here.

```
netops@edge-r1> show interfaces terse
Interface               Admin Link Proto    Local                 Remote
ge-0/0/0                up    up
ge-0/0/0.0              up    up   inet     203.0.113.2/30
ge-0/0/1                up    up
ge-0/0/1.0              up    up   inet     10.0.0.6/30
                                   multiservice
ge-0/0/2                down  down
dsc                     up    up
fxp0                    up    up
fxp0.0                  up    up   inet     192.168.100.11/24
gre                     up    up
ipip                    up    up
lo0                     up    up
lo0.0                   up    up   inet     10.255.0.2          --> 0/0
lo0.16385               up    up   inet
lsi                     up    up
mtun                    up    up
pimd                    up    up
pime                    up    up
tap                     up    up

netops@edge-r1>
```

(The `multiservice` continuation line is illustrative of the continuation format [unverified, from memory].)

#### 6.2.2 `show bgp summary`

Layout: the "Received/Accepted/Damped" variant from [S17], which is the second form on that page; the older form has a narrower Peer column and `Received/Damped`. Columns:
- Peer is left-aligned in 16 characters, and AS is right-aligned to end at column 27.
- InPkt and OutPkt are 11 wide, OutQ and Flaps 8 wide, Last Up/Dwn 12 wide.
- Then a space and the State, or the `table: a/r/acc/damp` lines on the following line for established peers.

The `Threading mode: BGP I/O` first line comes from a newer capture [N2]. The `Default eBGP mode` line is [unverified, from memory, 20.x+]. Down peers show the state name (`Active`, `Connect`, `Idle`) instead of counts.

```
netops@edge-r1> show bgp summary
Threading mode: BGP I/O
Default eBGP mode: advertise - accept, receive - accept
Groups: 2 Peers: 2 Down peers: 1
Table          Tot Paths  Act Paths Suppressed    History Damp State    Pending
inet.0
                       3          3          0          0          0          0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.0.0.5              65001       5321       5307       0       1  3d 4:12:55 Establ
  inet.0: 3/3/3/0
203.0.113.1           64500          0          0       0       0  3d 4:13:40 Active

netops@edge-r1>
```

#### 6.2.3 `show ospf neighbor`

Layout: header verbatim from [N1] (secondary); [S18] has the same columns.
- Columns start at 0 (Address), 17 (Interface), 40 (State) and 50 (ID).
- Pri is right-aligned to column 70, Dead right-aligned to column 76.
- The [S18] `brief` example shows a slightly different header indent (`  Address         Intf ...`), so match loosely.

```
netops@edge-r1> show ospf neighbor
Address          Interface              State     ID               Pri  Dead
10.0.0.5         ge-0/0/1.0             Full      10.255.0.1         1    34

netops@edge-r1>
```

#### 6.2.4 `show route`

Layout from [S19]:
- The table header is `inet.0: N destinations, N routes (N active, 0 holddown, 0 hidden)`, then `+ = Active Route, - = Last Active, * = Both`, then a blank line.
- The prefix is padded to 19 columns, then `*[Proto/Pref] age, metric/localpref`.
- The next-hop line has 20 spaces, then `>  to X via IFL` (two spaces after `>` in current releases).
- The AS path line is indented 22 spaces.
- The `Local via` form for Local routes is [unverified, from memory].

```
netops@edge-r1> show route

inet.0: 7 destinations, 7 routes (7 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

0.0.0.0/0          *[BGP/170] 3d 04:12:50, localpref 100
                      AS path: 65001 I, validation-state: unverified
                    >  to 10.0.0.5 via ge-0/0/1.0
10.0.0.4/30        *[Direct/0] 3d 04:13:40
                    >  via ge-0/0/1.0
10.0.0.6/32        *[Local/0] 3d 04:13:40
                       Local via ge-0/0/1.0
10.255.0.1/32      *[OSPF/10] 3d 04:12:58, metric 1
                    >  to 10.0.0.5 via ge-0/0/1.0
10.255.0.2/32      *[Direct/0] 3d 04:13:41
                    >  via lo0.0
203.0.113.0/30     *[Direct/0] 3d 04:13:40
                    >  via ge-0/0/0.0
203.0.113.2/32     *[Local/0] 3d 04:13:40
                       Local via ge-0/0/0.0

netops@edge-r1>
```

#### 6.2.5 `show arp no-resolve`

Layout: the IRB variant header from [S20].
- Columns start at 0 (MAC Address), 18 (Address), 34 (Interface) and 59 (Flags).
- Output ends with `Total entries: N`.
- [S20] also shows a narrower variant (`Interface     Flags`), and Interface can carry `[ifl]` suffixes on IRB.

```
netops@edge-r1> show arp no-resolve
MAC Address       Address         Interface                Flags
00:0c:29:5e:a1:47 10.0.0.5        ge-0/0/1.0               none
00:00:5e:00:01:0a 192.168.100.1   fxp0.0                   none
2c:6b:f5:10:44:01 203.0.113.1     ge-0/0/0.0               none
Total entries: 3

netops@edge-r1>
```

#### 6.2.6 `show ethernet-switching table` (EX/QFX ELS; acc-ex1)

Layout: verbatim headers from [S24], the QFX page; [N3] shows the same on EX, with `{master:0}`.
- The 4-space-indented table has columns at 4 (Vlan name), 24 (MAC address), 44 (MAC flags), 58 (Age `-`) and 62 (Logical interface).
- Newer releases add `NH Index` and `RTR ID` columns and `C - Control MAC` in the legend [N3].

```
{master:0}
netops@acc-ex1> show ethernet-switching table

MAC flags (S - static MAC, D - dynamic MAC, L - locally learned, P - Persistent static
           SE - statistics enabled, NM - non configured MAC, R - remote PE MAC, O - ovsdb MAC)


Ethernet switching table : 4 entries, 4 learned
Routing instance : default-switch
    Vlan                MAC                 MAC         Age    Logical
    name                address             flags              interface
    USERS               00:50:56:a1:10:21   D             -   ge-0/0/5.0
    USERS               00:50:56:a1:10:22   D             -   ge-1/0/5.0
    PRINTERS            3c:2a:f4:07:88:19   D             -   ge-0/0/12.0
    WIFI                d8:b3:70:1e:42:9c   D             -   ae0.0

{master:0}
netops@acc-ex1>
```

#### 6.2.7 `show lldp neighbors`

Layout: the second header variant from [S21].
- Columns start at 0 (Local Interface), 19 (Parent Interface), 39 (Chassis Id), 59 (Port info) and 78 (System Name).
- [S21] shows a blank line after the command and before the header.
- Port info carries the remote port ID or description. For a Cisco neighbor it is typically `Gi1/0/1` [unverified].

```
netops@edge-r1> show lldp neighbors

Local Interface    Parent Interface    Chassis Id          Port info          System Name
fxp0               -                   00:1b:54:aa:10:00   Gi0/12             oob-sw1
ge-0/0/1           -                   00:0c:29:5e:a1:00   Gi1/0/1            core-sw1

netops@edge-r1>
```

#### 6.2.8 `show version`

Layout from [S22], which shows MX480 on 24.4.
- The first lines are `Hostname:`, `Model:`, `Junos:` (MX480 also prints `Family: junos`), then package lines `JUNOS ... [build]`.
- On VC and clusters, output is grouped under `fpc0:` / `node0:` headers followed by a dashed line [N4].
- Junos OS Evolved prints a `Junos: <ver>-EVO` style line and different package lines [unverified, from memory].

```
netops@edge-r1> show version
Hostname: edge-r1
Model: vmx
Junos: 22.4R3.25
JUNOS OS Kernel 64-bit  [20231115.f0321c3_builder_stable_12_224]
JUNOS OS libs [20231115.f0321c3_builder_stable_12_224]
JUNOS OS runtime [20231115.f0321c3_builder_stable_12_224]
JUNOS OS time zone information [20231115.f0321c3_builder_stable_12_224]
JUNOS network stack and utilities [20231206.104530_builder_junos_224_r3]
JUNOS libs [20231206.104530_builder_junos_224_r3]
JUNOS modules [20231206.104530_builder_junos_224_r3]
JUNOS mx modules [20231206.104530_builder_junos_224_r3]
JUNOS daemons [20231206.104530_builder_junos_224_r3]
JUNOS mx daemons [20231206.104530_builder_junos_224_r3]

netops@edge-r1>
```

#### 6.2.9 `show log messages`

Line format [unverified, from memory]:
- `Mmm dd hh:mm:ss  host process[pid]: TAG: text`, with **two spaces** between time and host in the local file.
- The tags (`BGP_NEIGHBOR_STATE_CHANGED`, `UI_COMMIT`, `UI_DBASE_LOGIN_EVENT`, `SNMP_TRAP_LINK_DOWN`) are real Junos syslog tags, but the exact message texts are from memory.
- Use `show log messages | last 20` for recent entries [S5]. `| last` is screen-length bound.

```
netops@edge-r1> show log messages | last 6
Nov 24 09:10:02  edge-r1 mib2d[6120]: SNMP_TRAP_LINK_DOWN: ifIndex 528, ifAdminStatus down(2), ifOperStatus down(2), ifName ge-0/0/2
Nov 24 09:11:47  edge-r1 rpd[5123]: BGP_NEIGHBOR_STATE_CHANGED: BGP peer 203.0.113.1 (External AS 64500) changed state from Established to Idle (event HoldTime) (instance master)
Nov 24 09:12:15  edge-r1 sshd[7701]: Accepted publickey for netops from 192.168.100.50 port 51522 ssh2
Nov 24 09:12:31  edge-r1 mgd[7703]: UI_DBASE_LOGIN_EVENT: User 'netops' entering configuration mode
Nov 24 09:14:05  edge-r1 mgd[7703]: UI_COMMIT: User 'netops' requested 'commit' operation (comment: spare desc)
Nov 24 09:14:09  edge-r1 mgd[7703]: UI_DBASE_LOGOUT_EVENT: User 'netops' exiting configuration mode

netops@edge-r1>
```

#### 6.2.10 `show configuration | display set` (excerpt)

Format: one `set` line per leaf. A `set version` line comes first. Inactive statements appear as `deactivate ...` lines. All of this is [unverified, from memory], but the format is simple and stable.

```
netops@edge-r1> show configuration | display set | no-more
set version 22.4R3.25
set system host-name edge-r1
set system root-authentication encrypted-password "$6$REDACTED"
set system login user netops class super-user
set system services ssh
set system management-instance
set interfaces ge-0/0/0 description TRANSIT-A
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 description core-sw1:Gi1/0/1
set interfaces ge-0/0/1 unit 0 family inet address 10.0.0.6/30
set interfaces ge-0/0/2 disable
set interfaces fxp0 unit 0 family inet address 192.168.100.11/24
set interfaces lo0 unit 0 family inet address 10.255.0.2/32
set routing-options router-id 10.255.0.2
set routing-options autonomous-system 65000
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface lo0.0 passive
set protocols bgp group CORE type external
set protocols bgp group CORE peer-as 65001
set protocols bgp group CORE neighbor 10.0.0.5
set protocols bgp group TRANSIT type external
set protocols bgp group TRANSIT export TRANSIT-OUT
set protocols bgp group TRANSIT peer-as 64500
set protocols bgp group TRANSIT neighbor 203.0.113.1
set policy-options prefix-list OUR-AGG 198.51.100.0/24
set policy-options policy-statement TRANSIT-OUT term AGG from prefix-list OUR-AGG
set policy-options policy-statement TRANSIT-OUT term AGG then accept
set policy-options policy-statement TRANSIT-OUT term REST then reject

netops@edge-r1>
```

The hierarchical form `show configuration interfaces ge-0/0/1` uses braces and `;` with 4-space indentation, as shown throughout [S1] and [S5].

### 6.3 SRX cluster sample (srx-fw1)

Layout verbatim from [S26]:

```
{primary:node0}
netops@srx-fw1> show chassis cluster status

Monitor Failure codes:
    CS  Cold Sync monitoring        FL  Fabric Connection monitoring
    GR  GRES monitoring             HW  Hardware monitoring
    IF  Interface monitoring        IP  IP monitoring
    LB  Loopback monitoring         MB  Mbuf monitoring
    NH  Nexthop monitoring          NP  NPC monitoring
    SP  SPU monitoring              SM  Schedule monitoring
    CF  Config Sync monitoring

Cluster ID: 1
Node   Priority Status         Preempt Manual   Monitor-failures

Redundancy group: 0 , Failover count: 1
node0  200      primary        no      no       None
node1  100      secondary      no      no       None

{primary:node0}
netops@srx-fw1>
```

---

## 7. Dangerous commands

### 7.1 Inventory

| Category | Commands | Notes |
|---|---|---|
| Reboot/halt | `request system reboot` (prompts `Reboot the system ? [yes,no] (no)` [S28]); `request system halt`; `request system power-off`; options `both-routing-engines`, `all-members`, `node`, `at`, `in` | Default answer is **no** |
| Wipe | `request system zeroize` prints `warning: System will be rebooted and may not boot without configuration` and `Erase all data, including configuration and log files?... [yes,no] (no)` [S29] | Unrecoverable |
| Software | `request system software add/delete/rollback/validate`, `request system snapshot`, `request vmhost ...` | `validate` is harmless; the others are not |
| RE/HA switchover | `request chassis routing-engine master switch`, `request chassis cluster failover redundancy-group N node M`, `request virtual-chassis ...` | |
| Process restarts | `restart routing` (rpd: drops every protocol), `restart chassis-control`, `restart interface-control`, ... | Abbreviation `restart r` and `res r` both reach it |
| Shell escapes | `start shell` (csh/sh; then `cli`), `start shell user root`, `request system ...` scripts, `op <script>`, `file` ops | `start shell` is a full Unix shell |
| File ops | `file delete`, `file copy`, `file rename`, `file archive`, `request system storage cleanup` | `file show` and `file list` are read-only but share the head |
| Clear (traffic-affecting) | `clear bgp neighbor` (**no argument resets ALL peers**), `clear ospf neighbor`, `clear arp`, `clear ethernet-switching table`, `clear security flow session all` (SRX), `clear system commit` (cancels a scheduled commit) | `clear interfaces statistics` and `clear log` are lower risk |
| Clock and CLI | `set date ...` (op mode, changes the system clock), `set chassis display message` | `set cli ...` is session-local and safe |
| Monitoring that never ends | `monitor traffic interface ...` (tcpdump), `monitor interface`, `monitor start file` (writes) | Need Ctrl+C |
| Pipes | `\| save`, `\| append`, `\| tee` (write files) [S5]; `\| request message` [S5]; `\| refresh` (repeats forever) [S5]; **`\| hold` (keeps the pager open after the last screen)** [S5][S10] | `hold` is currently allowed by the guard: a bug |
| Config mode | `delete` at `[edit]` (deletes the whole configuration after a confirm prompt [unverified, from memory]), `delete protocols bgp`, `load override` / `load factory-default`, `rollback N` + `commit`, `deactivate interfaces ge-0/0/1`, `set interfaces ge-0/0/1 disable`, `wildcard delete`, `replace pattern`, `commit` and `commit synchronize` themselves | The guard sees only the first word |
| Locking | `configure exclusive` (others cannot commit; uncommitted changes are discarded on exit [S7]) | Should require approval |

### 7.2 PlatformRules proposal

```ts
const junos: PlatformRules = {
  // 'help' is read-only (help topic/reference/apropos/tip).
  read: ['show', 'ping', 'traceroute', 'help'],
  blocked: [
    'request', 'restart', 'start', 'file', 'op', 'test',
    'telnet', 'ssh', 'ftp', 'save', 'load',
    'diagnose', // present in the [S1] top-level ? list
  ],
  // 'diagnose' moved to blocked. 'edit' is valid in op mode as an alias of configure [S1].
  other: ['clear', 'configure', 'edit', 'exit', 'monitor', 'quit', 'set', 'mtrace',
          'commit', 'rollback', 'delete', 'deactivate', 'activate', 'top', 'up', 'status',
          'compare', 'update', 'annotate', 'copy', 'rename', 'insert', 'replace', 'wildcard',
          'protect', 'unprotect'],          // config-mode verbs, so they resolve as "known config"
  blockedPairs: [
    ['configure', 'private'],   // existing
    ['configure', 'exclusive'], // new: locks out other users
    ['clear', 'system'],        // existing (clear system commit / login sessions)
    ['clear', 'bgp'],           // new: clear bgp neighbor (all peers if no arg)
    ['clear', 'ospf'],          // new: drops adjacencies
    ['clear', 'security'],      // new (SRX): clear security flow session all
    ['clear', 'ethernet-switching'],
    ['monitor', 'traffic'],     // new: never terminates
    ['monitor', 'start'],       // new: writes files
    ['set', 'date'],            // new: changes system clock
    ['set', 'chassis'],         // new: op-mode set chassis ...
  ],
  pipesAllowed: ['match', 'except', 'count', 'no-more', 'display', 'find', 'last', 'trim', 'resolve', 'compare'],
  pipesBlocked: ['save', 'append', 'tee', 'refresh', 'request', 'hold'], // 'hold' moved here
  execFromConfig: 'run'
}
```

Notes:
- **`rollback` and `commit`** need no pair: listing them in `other` already classifies them as `config` (approval required).
- **`| resolve` is in the allow-list** but triggers DNS lookups from the device. That is acceptable, but slow.

### 7.3 What the shape cannot express

1. **3+ token commands.** It cannot block `request system zeroize` but allow `request system software validate`. It cannot block `clear bgp neighbor` but allow `clear bgp neighbor 10.0.0.5 soft-inbound`. Nor can it block `show system ... | save` variants beyond pipes, or `file delete` while allowing `file show`/`file list`. The whole `file` head stays blocked.
2. **Arguments.** It cannot see that `clear bgp neighbor` *without* an address is the dangerous form. It cannot see `restart routing` versus `restart routing gracefully`, or whether `ping` has `count` (that case is special-cased in `classify.ts`).
3. **Mode awareness.** The same first word means different things in each mode. `show` is harmless in both. `delete`, `set`, `load` and `rollback` are config-mode only. `set` in op mode is mostly `set cli`, but `set date` changes the clock. The rules have no notion of the current mode or edit path, so `delete` at `[edit]` cannot be told apart from `delete interfaces ge-0/0/2 description`.
4. **`commit` effects.** Any config verb is harmless until `commit`. A policy of "agent may stage, human must commit" needs a `commit`-specific rule (classify `commit` and `commit confirmed` separately).
5. **Quoted pipes.** `| match "ge-0/0/1|ge-0/0/2"` is split on the inner `|` by `classify.ts` (`command.split('|')`), so a legitimate regex alternation is classified as a pipe named `ge-0/0/2"` and blocked.

### 7.4 Abbreviation traps

These come from the top-level vocab in [S1] and [S6]:
- `r` and `re` are ambiguous between `request` and `restart`. Both are blocked, so the guard is fine. On the device itself, `re` returns `'re' is ambiguous.` `req` is `request`; `res` is `restart`.
- `s` is ambiguous (`set show ssh start`). `st` is unique for **start**, so `st sh` becomes `start shell`. `sh` is unique for `show`. `ss` is `ssh`.
- `t` covers `telnet`, `test` and `traceroute`. `te` is still ambiguous (telnet/test). `tr` is `traceroute`.
- `c` covers `clear` and `configure`. `cl b n` is `clear bgp neighbor`. `co`/`conf` is `configure`, and `conf ex` is `configure exclusive`.
- `m` covers `monitor` and `mtrace`. `mo t` is `monitor traffic` (never ends).
- `f` is unique for `file`, so `f d` becomes `file delete`.
- In config mode, `de` covers `delete` and `deactivate`, and `rol` is `rollback`. A bare `del` at `[edit]` is a whole-config delete.

---

## 8. Live-value sources

All Junos operational commands accept `| display xml` and `| display json`. Configuration accepts `| display set`, `| display json` and `| display xml`. Prefer JSON over screen-scraping. Over NETCONF, the RPC name is `| display xml rpc` [unverified, from memory, but long-standing].

| Value | Command to parse | Field / regex hint | Structured alternative |
|---|---|---|---|
| Interfaces (IFD and IFL) | `show interfaces terse` | `^(\S+)\s+(up\|down)\s+(up\|down)(?:\s+(\S+)\s+(\S+))?` and continuation lines `^\s{35}(\S+)\s+(\S+)` | `show interfaces terse \| display json` (`interface-information.physical-interface[].name`, `logical-interface[]`) |
| Interface descriptions | `show interfaces descriptions` | `^(\S+)\s+(up\|down)\s+(up\|down)\s+(.*)$` | `show configuration interfaces \| display set \| match description` |
| L3 addresses | `show interfaces terse` (Local column) | `inet\s+(\d+\.\d+\.\d+\.\d+/\d+)` | `show configuration interfaces \| display set \| match "family inet address"` |
| VLANs (EX/QFX) | `show vlans` | name / tag / interfaces table | `show configuration vlans \| display set` ⇒ `set vlans (\S+) vlan-id (\d+)` |
| Bridge domains (MX) | `show bridge domain` | | `show configuration bridge-domains \| display set` |
| Routing instances (VRFs) | `show route instance` | `^(\S+)\s+(forwarding\|vrf\|virtual-router\|evpn\|...)` | `show configuration routing-instances \| display set \| match instance-type` |
| BGP neighbors | `show bgp summary` | peer rows `^(\d+\.\d+\.\d+\.\d+\|[0-9a-f:]+)\s+(\d+)\s+` | `show bgp neighbor \| display json` or `show configuration protocols bgp \| display set \| match neighbor` ⇒ `set protocols bgp group (\S+) neighbor (\S+)` |
| BGP groups | `show bgp group brief` | `Group Type: (\S+)` | config `display set` as above |
| OSPF neighbors / interfaces | `show ospf neighbor`, `show ospf interface` | columns per 6.2.3 | `\| display json` |
| Policy statements | `show policy` (op) | names | `show configuration policy-options \| display set \| match policy-statement` ⇒ `policy-statement (\S+)` |
| Prefix lists | | | `show configuration policy-options \| display set \| match prefix-list` ⇒ `prefix-list (\S+)` |
| Firewall filters | `show firewall` | `^Filter: (\S+)` | `show configuration firewall \| display set` ⇒ `filter (\S+) term (\S+)` |
| SRX zones | `show security zones terse` | `^(\S+)\s+(Security\|Functional)` | `show configuration security zones \| display set` ⇒ `security-zone (\S+)` |
| SRX policies | `show security policies` | `From zone: (\S+), To zone: (\S+)` / `Policy: (\S+),` | `show configuration security policies \| display set` |
| SRX address-book | | | `show configuration security address-book \| display set` ⇒ `address (\S+) (\S+)` |
| LAGs | `show lacp interfaces` | `^Aggregated interface: (ae\d+)` | `show interfaces terse ae*` |
| Users (Tab completion) | `show system users` | | `show configuration system login \| display set \| match user` |
| Config hierarchy (for config-mode completion) | the device's own `?` lists, see 3.1 | `^\s*>?\s*(\S+)\s{2,}(.*)$` after `Possible completions:` | `show configuration \| display set` turned into a tree |
| Commit history | `show system commit` | `^(\d+)\s+(\S+ \S+ \S+) by (\S+) via (\S+)(?: (.*))?` [S27] | `\| display json` |
| VC members | `show virtual-chassis` | `^(\d+) \(FPC \d+\)\s+(\S+)` [S25] | `\| display json` |

---

## 9. Interface naming

**General form:** `type-fpc/pic/port[:channel].unit`, for example `ge-0/0/1.0` and `xe-0/0/51:0.0`; the channelized form appears in [N3]. Interface names are **not abbreviated** by the CLI. Users type them in full, use Tab completion, or use wildcards such as `ge-*` and `ge-0/0/[1-3]` in show commands and with `wildcard` in config [S5][S2]. Hopline's `Gi1/0/1`-style short forms do not exist on Junos.

| Kind | Pattern | Regex |
|---|---|---|
| Physical Ethernet (IFD) | `fe-` (100M), `ge-` (1G), `xe-` (10G), `et-` (25/40/100/400G), `mge-` (multi-rate) | `^(fe\|ge\|xe\|et\|mge)-\d+/\d+/\d+(:\d+)?$` |
| Logical unit (IFL) | IFD plus `.unit` (`.0` default; VLAN sub-ifs `.100`) | `^[a-z]+-\d+/\d+/\d+(:\d+)?\.\d+$` |
| Aggregated Ethernet | `ae0`, `ae0.0` | `^ae\d+(\.\d+)?$` |
| Loopback | `lo0`, `lo0.0` (`lo0.16385` is internal) | `^lo0(\.\d+)?$` |
| IRB / SVI | `irb.100` (ELS, MX). Legacy EX uses `vlan.100`. | `^(irb\|vlan)\.\d+$` |
| Management | `fxp0` (MX/SRX/PTX), `me0` (EX), `em0`/`em1` (QFX; also internal on others), `vme` (VC management) | `^(fxp\|em\|me)\d+(\.\d+)?$\|^vme(\.\d+)?$` |
| SRX cluster | `reth0` (redundant Ethernet), `fab0`/`fab1` (fabric), `fxp1` (control) [S16] | `^(reth\|fab)\d+(\.\d+)?$` |
| Tunnels | `gr-0/0/0` (GRE), `ip-0/0/0` (IP-IP), `lt-0/0/0` (logical tunnel), `st0.1` (SRX IPsec), `vt-` | `^(gr\|ip\|lt\|vt)-\d+/\d+/\d+(\.\d+)?$\|^st0\.\d+$` |
| VC ports | `vcp-255/1/0` [S25] | `^vcp-\d+/\d+/\d+$` |
| Internal/pseudo | `dsc`, `gre`, `ipip`, `lsi`, `mtun`, `pimd`, `pime`, `tap`, `jsrv`, `pp0`, `demux0` | treat as noise in completion lists |

A single regex for the completion engine:
`\b(?:(?:fe|ge|xe|et|mge|gr|ip|lt|vt)-\d+/\d+/\d+(?::\d+)?|ae\d+|lo0|irb|vlan|reth\d+|fab\d+|fxp\d|em\d|me\d|st0|vcp-\d+/\d+/\d+)(?:\.\d+)?\b`

---

## 10. Simulator and guard fit

### 10.1 Delta: current simulator versus a real Junos device

| Area | Simulator today (`shell.ts` / `engine.ts`) | Real Junos | Change |
|---|---|---|---|
| Platforms | only `ios` and `eos` fixtures (`state.ts`) | — | Add a `junos` fixture for edge-r1 per this document, plus optional `acc-ex1` (EX VC) and `srx-fw1` (cluster). |
| Operational prompt | `${h}#` | `user@host> ` with the login user | The prompt needs the username. `promptText()` must know the session user. |
| Config prompt | `${h}(config)#`, `(config-if)#` ... | `[edit <path>]` banner line, then `user@host# ` | Model the mode as `{ mode: 'operational' \| 'configuration', editPath: string[] }` and print the banner before every prompt. |
| Banners | none | `{master:0}` / `{primary:node0}` line above the prompt | Add an optional `banner` to the fixture. |
| Pager | `' --More-- '`; any key other than space/enter quits; erased with backspaces | `---(more)---` / `---(more NN%)---`; space = page, Enter = line, q/Ctrl-C = quit, plus the [S10] table (Tab = half page, `/` search, `n` no-more, `G`/`g` end) | Make `MORE` per-platform. At minimum support space, Enter, q, Q, Ctrl-C, n (no-more) and Tab/d (half page). Leave the pager on unknown keys instead of quitting. |
| Invalid input | `% Invalid input detected at '^' marker.` | caret line plus `syntax error, expecting <command>: foo` (unverified) or `unknown command.` (first word) | Per-platform error renderer. Caret column = prompt length + token offset (same rule as now). |
| Ambiguous | `% Ambiguous command:  "<line>"` | caret line, `'sy' is ambiguous.`, `Possible completions:` and the list | Reuse `help()` output for the list. |
| Incomplete | `% Incomplete command.` | caret line plus `syntax error, expecting <identifier>` | |
| `?` help | IOS-style list | `Possible completions:` header; `<[Enter]>            Execute this command`; `>` container markers in config; `\|                    Pipe through a command` | Add the header and the `<[Enter]>` and `\|` rows. |
| Space completion | Tab only | Space **and** Tab complete keywords (unless `set cli complete-on-space off`); Tab only for values | Optionally complete on space in junos mode, so Hopline's echo handling is exercised. |
| Ctrl-C | prints `^C` and **returns to exec** | cancels the line and stays in config mode [unverified] | Do not change mode on Ctrl-C in junos. |
| Ctrl-Z | prints `^Z` and returns to exec | no "end" meaning [unverified] | Ignore it in junos. |
| Ctrl-U | clears the line | the same (also Ctrl-X); Ctrl-W deletes a word [S11] | Add Ctrl-W and Ctrl-X. |
| Exec from config | `do` | `run` | `execFromConfig` is already `run` in the guard. Mirror that in the simulator. |
| Leaving config | `exit`/`end` | `exit` goes up one level; at `[edit]` it prompts `Exit with uncommitted changes? [yes,no] (yes)` when the candidate is dirty; `exit configuration-mode`, `quit`, `top`, `up`, `commit and-quit` | Track a `dirty` candidate flag. |
| Confirm prompts | `[confirm]` (Enter = yes) | `[yes,no] (no)` for reboot/zeroize, `[yes,no] (yes)` for exit; the user types the word | Per-platform confirm renderer. Accept `yes`/`no` and Enter for the default. |
| Config apply | immediate (`write memory` to save) | candidate plus `commit` (`commit complete`), `commit check` (`configuration check succeeds`), `commit confirmed N`, `rollback N` (`load complete`), `show \| compare` | Keep a candidate copy of the fixture state. `commit` swaps it in. `show \| compare` diffs `display set` lines. |
| Pipes | include/exclude/begin/section/count/grep/no-more/json/match/except | `match`, `except`, `count` (`Count: N lines`) [unverified wording], `last`, `find`, `trim`, `no-more`, `display set\|json\|xml`, `compare`, `resolve`, `hold`, `save` | Map `match`/`except`/`count`/`no-more`/`last`/`find`/`display json` for junos, and refuse IOS-only names with a syntax error. |
| Show commands | IOS/EOS set | §6.1 list | Implement the 6.2 samples first: `show interfaces terse`, `show bgp summary`, `show ospf neighbor`, `show route`, `show arp no-resolve`, `show lldp neighbors`, `show version`, `show log messages`, `show configuration [\| display set]`, `show system commit`. |
| Blank line before prompt | none | an empty line after command output, before the banner/prompt (seen in the [N1]/[N3] captures as an empty line, then `{master:0}`) | Emit `\r\n` after output in junos. |
| Login banner | `*** Hopline simulator ...` | optional `--- JUNOS 22.4R3.25 Kernel 64-bit ...` line, then the prompt [unverified, from memory; [S1] shows `---JUNOS 17.2B1.8 built 2018-05-09 23:41:29 UTC`] | Print `--- JUNOS <ver> built <date>` at login. |

### 10.2 Recommended Mode names

The current `Mode` union (`'exec'|'config'|'config-if'|'config-router'|'config-vlan'`) is IOS-shaped. For Junos:
- Use **`'operational'`** (`>`) and **`'configuration'`** (`#`).
- Add a separate `editPath: string[]` (for example `['interfaces','ge-0/0/1','unit','0']`) for the banner, for relative `set`/`show`, and for completion context.
- If the union must stay shared, map `exec` to operational and `config` to configuration, and do not use `config-if` / `config-router` / `config-vlan` for junos. Instead derive the context from `editPath[0]` (`interfaces`, `protocols`, `vlans`, `routing-instances`, `policy-options`, `firewall`, `security`).

Command specs then need `modes: ['operational']` or `['configuration']`. Config-mode `show` is a candidate-config viewer, and `run <op-cmd>` re-dispatches to the operational specs.

### 10.3 Guard deltas (summary)

1. Move `hold` from `pipesAllowed` to `pipesBlocked`: it keeps the pager open [S5][S10].
2. Add `diagnose` (from the [S1] top-level `?` list) to `blocked`, and `help` to `read`.
3. The guard lists `op`, `save`, `load`, `ftp`, `edit` and `exit` as top-level keywords, but none of them appears in either fetched top-level `?` list ([S1], [S6]). `edit` is documented as a synonym for `configure` [S1]. The others are harmless as deny/other entries but may not exist in 21–23 operational mode [unverified]. `ssh`, `start`, `telnet`, `test` and `traceroute` are confirmed by [S6].
4. New blocked pairs: `configure exclusive`, `clear bgp`, `clear ospf`, `clear security`, `monitor traffic`, `monitor start`, `set date` (see 7.2).
5. Add the config-mode verbs to `other`, so that `commit`, `rollback`, `delete` and the rest classify as known config, not unknown.
6. Fix the quoted-pipe split in `classify.ts` for `| match "a|b"`.
7. Sessions opened for the agent should start with `set cli screen-length 0`, `set cli screen-width 0` and `set cli complete-on-space off` [S4][S12]. That removes pager handling and echo surprises.

### 10.4 Junos OS Evolved notes

All [unverified, from memory] unless cited:
- The CLI, prompts, pager, commit model and error strings are the same as Junos OS.
- `start shell` gives a Linux bash.
- Process names differ: many daemons are split into apps, and `show system processes` output differs.
- `request system software add` takes `-evo.iso` images. `show version` includes `-EVO` in the version.
- Interface naming is the same (`et-0/0/0`, `re0:mgmt-0` for management on PTX/ACX Evolved, instead of `fxp0`).
- The Evolved CLI guide exists as a separate PDF: `www.juniper.net/documentation/us/en/software/junos/cli-evo/cli-evo.pdf`. It appeared in search results but was **not fetched**, so this is not a citation.

---

## Sources

Vendor pages, fetched this session. The `www.juniper.net/documentation/us/en/...` links redirected to `networkingdocs.hpe.com`, shown here as served.

- [S1] Getting started (CLI quick tour): https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/getting-started.html
- [S2] Modifying the configuration: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/modifying-configuration.html
- [S3] Commit the configuration: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/junos-configuration-commit.html
- [S4] CLI environment settings: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/cli-environment-settings.html
- [S5] Filtering operational command output: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/filtering-operational-command.html
- [S6] Online help in the CLI: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/online-help.html
- [S7] Overview of the configure command: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/configure-command.html
- [S8] CLI configuration mode overview: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/cli-configuration.html
- [S9] Loading configuration files: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/junos-config-files-loading.html
- [S10] Manage output at the ---(more)--- prompt: https://www.juniper.net/documentation/en_US/junos/topics/reference/general/junos-output-managing-with-more-prompt.html
- [S11] Keyboard sequences (Junos 13.1): https://juniper.net/documentation/en_US/junos13.1/topics/concept/junos-cli-configuration-mode-navigation-modification-overview.html
- [S12] Using the CLI (Junos Security 10.0; command completion, `set cli complete-on-space`): https://juniper.net/documentation/software/junos-security/junos-security10.0/junos-security-admin-guide/using-cli-section.html
- [S13] Operational mode commands monitoring (ambiguous example): https://juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-operational-mode-commands-monitoring.html
- [S14] CLI command completion example (Junos 12.2): https://juniper.net/documentation/en_US/junos12.2/topics/example/junos-cli-command-completion-using.html
- [S15] Entering and exiting configuration mode (Junos 13.1): https://juniper.net/documentation/en_US/junos13.1/topics/task/configuration/junos-cli-configuration-mode-entering-exiting.html
- [S16] show interfaces terse: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-interfaces-terse.html
- [S17] show bgp summary: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-bgp-summary.html
- [S17b] show bgp neighbor (the `Peer: ... Local: ...` header): https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-bgp-neighbor.html
- [S18] show (ospf | ospf3) neighbor: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-ospf-ospf3-neighbor.html
- [S19] show route: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-route.html
- [S-route-summary] show route summary: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-route-summary.html
- [S20] show arp: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-arp.html
- [S21] show lldp neighbors: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-lldp-neighbors.html
- [S22] show version (Junos OS): https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-version.html
- [S23] show log: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-log.html
- [S24] show ethernet-switching table (QFX Series): https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-ethernet-switching-table-qfx-series.html
- [S25] show virtual-chassis: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-virtual-chassis.html
- [S26] show chassis cluster status: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-chassis-cluster-status.html
- [S27] show system commit: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-system-commit.html
- [S28] request system reboot: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/request-system-reboot.html
- [S29] request system zeroize: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/request-system-zeroize.html
- [S-alarms] show chassis alarms: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-chassis-alarms.html
- [S-uptime] show system uptime: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-system-uptime.html
- [S30] Configure chassis cluster (SRX; `{primary:node0}` transcripts): https://www.juniper.net/documentation/us/en/software/junos/chassis-cluster-security-devices/topics/topic-map/security-chassis-cluster-verification.html

Secondary sources, fetched this session:

- [N1] ntc-templates capture, show ospf neighbor (ends with `{master:0}`): https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_ospf_neighbor/juniper_junos_show_ospf_neighbor.raw
- [N2] ntc-templates capture, show bgp summary (`Threading mode: BGP I/O`): https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_bgp_summary/show_bgp_summary.raw
- [N3] ntc-templates captures, show ethernet-switching table: https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_ethernet-switching_table/juniper_junos_show_ethernet-switching_table.raw and https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_ethernet-switching_table/juniper_junos_show_ethernet-switching_table1.raw
- [N4] ntc-templates captures, show version (EX VC, SRX cluster, MX): https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_version/juniper_junos_show_version_ex.raw, https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_version/juniper_junos_show_version_srx_cluster.raw and https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_version/juniper_junos_show_version.raw
- [N5] juniper-nsp mailing list, 2023-07 (`'sy' is ambiguous.` with caret and `{master:0}` on 21.x EX): https://puck.nether.net/pipermail/juniper-nsp/2023-July/039166.html
- [N6] Global Knowledge, "Juniper's wonderful CLI" (`ping` in config mode is an unknown command; use `run`): https://www.globalknowledge.com/en-us/resources/articles/junipers-wonderful-command-line-interface-cli

[S1]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/getting-started.html
[S2]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/modifying-configuration.html
[S3]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/junos-configuration-commit.html
[S4]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/cli-environment-settings.html
[S5]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/filtering-operational-command.html
[S6]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/online-help.html
[S7]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/configure-command.html
[S8]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/cli-configuration.html
[S9]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli/topics/topic-map/junos-config-files-loading.html
[S10]: https://www.juniper.net/documentation/en_US/junos/topics/reference/general/junos-output-managing-with-more-prompt.html
[S11]: https://juniper.net/documentation/en_US/junos13.1/topics/concept/junos-cli-configuration-mode-navigation-modification-overview.html
[S12]: https://juniper.net/documentation/software/junos-security/junos-security10.0/junos-security-admin-guide/using-cli-section.html
[S13]: https://juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-operational-mode-commands-monitoring.html
[S14]: https://juniper.net/documentation/en_US/junos12.2/topics/example/junos-cli-command-completion-using.html
[S15]: https://juniper.net/documentation/en_US/junos13.1/topics/task/configuration/junos-cli-configuration-mode-entering-exiting.html
[S16]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-interfaces-terse.html
[S17]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-bgp-summary.html
[S18]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-ospf-ospf3-neighbor.html
[S19]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-route.html
[S-route-summary]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-route-summary.html
[S20]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-arp.html
[S21]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-lldp-neighbors.html
[S22]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-version.html
[S23]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-log.html
[S24]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-ethernet-switching-table-qfx-series.html
[S25]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-virtual-chassis.html
[S26]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-chassis-cluster-status.html
[S27]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-system-commit.html
[S28]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/request-system-reboot.html
[S29]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/request-system-zeroize.html
[S-alarms]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-chassis-alarms.html
[S-uptime]: https://networkingdocs.hpe.com/documentation/us/en/software/junos/cli-reference/topics/ref/command/show-system-uptime.html
[N3]: https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_ethernet-switching_table/juniper_junos_show_ethernet-switching_table.raw
[N4]: https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/juniper_junos/show_version/juniper_junos_show_version_ex.raw,
[N6]: https://www.globalknowledge.com/en-us/resources/articles/junipers-wonderful-command-line-interface-cli
