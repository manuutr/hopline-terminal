# UX patterns for Hopline: Orca, Warp, Linear, Zed

Research date: 2026-11-24. Scope: layout, keyboard, AI surfaces, onboarding, settings, motion,
accessibility and density. This document records patterns and numbers only. No code or branding is
taken from the studied products.

**How to read the numbers**
- **Observed**: the value comes from a cited doc page or source file. Orca values come from its MIT repo at commit `c146a111` ([stablyai/orca][orca]).
- **Proposal**: a Hopline value with no source behind it. Treat it as a starting point and tune it.

**Hopline constraints that every recommendation must respect** (from `README.md` and
`apps/desktop/src/renderer/src/lib/keys.ts`)
- Plain `Ctrl+<letter>` always goes to the device. Cisco, Arista and Junos CLIs use `Ctrl+A/E/B/F/P/N/R/U/W/K/Z/C`.
- App shortcuts use `Ctrl+Shift+<key>` on Linux and Windows and `⌘` on macOS ("Mod").
- `Ctrl+Shift+6` must reach the device too. It is the Cisco escape/break sequence (`Ctrl+^`), so `Ctrl+Shift+<digit>` is off limits for app bindings.
- Already in the stack: `react-resizable-panels`, `cmdk`, `sonner`, Radix, xterm 6 with the WebGL and search addons.
- Existing bindings: palette `Ctrl+Shift+K`/`⌘K` (and `Ctrl+K` outside the terminal), find `Ctrl+Shift+F`, settings `Ctrl+Shift+,`/`⌘,`, tabs `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+PageUp/Down`, `Alt+1..9`.

---

## 1. Layout and panel systems

### 1.1 Split panes

**Orca (observed)**
- Splits nest without limit ("infinite splits"), and any tab can be dragged into a pane to split it ([README][orca-readme]).
- Split shortcuts on Linux: right `Mod+Shift+D`, down `Alt+Shift+D`. On macOS: `⌘D` and `⌘⇧D`.
- Close pane `Mod+W`, expand (zoom) pane `Mod+Shift+Enter`, next and previous pane `Mod+]` / `Mod+[` ([definitions-core-4][o-kb4], [definitions-core-3][o-kb3]).
- "Equalize pane sizes" is a command with no default binding. It is reached from the palette.
- Inactive panes render at 0.9 opacity, active at 1, with a 140 ms opacity transition. The divider is 3 px thick ([default-global-settings][o-defaults], [terminal-pane-opacity][o-opacity]).
- An unfocused split *group* renders at 0.95 opacity ([split-group-dim][o-dim]).
- Divider hit area: the grab zone reaches 7 px past each side of the thin seam ([main.css][o-css]).
- Divider hover highlight waits 200 ms, so crossing a seam with the pointer does not flash it. While dragging, the highlight shows at once with no transition.

**Orca drop zones** ([tab-drop-zone][o-drop])
- Tab dropped on a pane body: the outer 10% band on each edge splits. The centre merges the tab into the pane.
- Inside the edge band, the left and right thirds win, which favours horizontal splits.
- Pane-column edges: a 20% band on the left and right, and a 20% band at the top and bottom of the body.
- The 32 px tab strip is reserved for reordering and never triggers a vertical split.
- A new empty split shows a small searchable launcher listing what can open there (terminal, browser, markdown), with search ([SplitPaneLanding][o-landing]).

**Warp (observed)** ([split panes][w-split])
- Linux and Windows: split right `Ctrl+Shift+D`, down `Ctrl+Shift+E`; previous and next pane `Ctrl+Shift+{` / `}`.
- Directional focus `Ctrl+Alt+Arrow`, zoom `Ctrl+Shift+Enter`, close `Ctrl+Shift+W`.
- macOS: `⌘D`, `⌘⇧D`, `⌘[`/`⌘]`, `⌥⌘Arrow`, `⌘⇧Enter`.
- The active pane carries a small triangle in its top corner, so focus is not shown by colour alone.
- Dragging a pane header moves it within the tab. Dropping it on the tab bar moves it to another tab or makes a new tab.
- Right-click on a pane splits it in any direction.
- Options: "Dim inactive panes" and "Focus follows mouse" ([pane dimming][w-dim]).
- `Ctrl+Tab` can be set to cycle the most recent *session*, split panes included ([session navigation][w-sessions]).

**Zed (observed)** ([default-linux keymap][z-linux], [vim keymap][z-vim])
- Split: `ctrl-k <arrow>` (Linux) and `cmd-k <arrow>` (macOS). Focus: `ctrl-k ctrl-<arrow>`.
- Zoom pane: `shift-escape`.
- Vim mode: `ctrl-w h/j/k/l` focus, `ctrl-w v` and `ctrl-w s` split, `ctrl-w =` reset sizes, `ctrl-w q` close, `ctrl-w o` close the others.
- **Hopline cannot adopt these chords.** `Ctrl+K` and `Ctrl+W` are line-kill and word-delete on every network CLI.

**VS Code (observed)** ([accessibility][vsc-a11y]): `accessibility.dimUnfocused.opacity` defaults to 0.75 (range 0.2 to 1).

**Hopline spec (proposal)**
| Item | Value |
|---|---|
| Split right / down | `Ctrl+Shift+D` / `Ctrl+Shift+E` (Warp Linux parity); `⌘D` / `⌘⇧D` |
| Focus pane by direction | `Ctrl+Alt+Arrow`, with a `Ctrl+Shift+Alt+Arrow` fallback; `⌥⌘Arrow` on macOS |
| Next / previous pane | `Ctrl+Shift+]` / `Ctrl+Shift+[`; `⌘]` / `⌘[` |
| Zoom pane | `Ctrl+Shift+Enter`; `⌘⇧Enter`. Show a "zoomed" badge on the tab, as Warp's tab indicator does |
| Close pane | `Ctrl+Shift+W`; `⌘W`. Confirm only when the session is live and the device is in config mode |
| Divider | 1 px visible line, 8 px hit area (±3.5 px), hover colour after a 200 ms delay, none while dragging |
| Inactive pane | 0.85 opacity on the xterm container, 140 ms transition, 0 ms under reduced motion. Never dim below 0.75 |
| Active pane marker | 2 px teal top border on the pane header, plus a non-colour cue (header text weight or the triangle) |
| Drop zones | Edge band 20% of the pane per side, centre merges, tab strip reorders only. Live preview overlay: 30% teal fill at 12% opacity, 150 ms fade |
| Empty split | The "Connect to…" launcher from §4.2, never a blank black rectangle |
| Pane minimum | 20 columns × 5 rows. Refuse a split that would go below it and say why in a toast |

Warp's Linux binding `Ctrl+Alt+Arrow` collides with GNOME workspace switching.
Ship the fallback binding and detect the collision in onboarding.

### 1.2 Tab bars

**Orca (observed)** ([tab-strip-width-budget][o-tabw], [tab-strip-condense-plan][o-condense])
- Strip height is 32 px. Titled tabs grow to 300 px and shrink to an 80 px floor.
- Below 80 px, inactive tabs fold to 32 px icon-only tabs while the active tab keeps its title. The active tab is at least 104 px and at most 200 px in this condensed mode.
- When even icons do not fit, the tabs outside a sliding window around the active tab collapse into a 38 px "+N" chip. The window slides the minimum distance when you switch tabs, so the strip does not jump.
- Secondary controls drop out at set strip widths: new-tab button below 86 px, pane actions below 114 px, quick commands below 163 px.
- A hover card shows full tab details.
- Per-tab activity status set: active, working, monitoring, permission (needs you), failed, interrupted, unconfirmed, done, inactive ([worktree-status-rollup][o-status]). Working and permission can show a progress ring.
- Bindings ([definitions-core-2][o-kb2]): reopen closed `Mod+Shift+T`, move tab left and right, rename, select by index, `Ctrl+Tab` = previous recent (MRU). MRU versus sequential order is a setting.

**Warp (observed)**
- `Ctrl+1..8` jumps to a tab and `Ctrl+9` to the last tab ([tabs][w-tabs]). Double-click renames.
- Move a tab with `Ctrl+Shift+←/→` or by dragging. Reopen with `Ctrl+Alt+T` (Linux).
- Tabs and tab groups can be pinned to the front.
- Tab indicators mark a maximised pane, synchronised input and a non-zero exit code ([tabs behavior][w-tabsb]).
- The close button can sit on the left or the right.
- **Vertical tabs** replace the bar with a sidebar ([vertical tabs][w-vtabs]). Each row shows the directory, branch and agent status badge (in progress, done, errored, cancelled, blocked). An accent dot marks unread activity. Compact single-line mode is the default; expanded mode adds metadata. Hovering a row opens a detail card without moving focus.

**Linear (observed)** ([design refresh][l-refresh]): desktop tabs became compact and rounded,
no longer span the full width, and use smaller icons and text.

**Hopline spec (proposal)**
| Item | Value |
|---|---|
| Strip | 34 px tall. Tab 120–240 px titled, 80 px floor, then Orca-style icon fold (32 px) and a "+N" chip that opens a searchable list |
| Tab anatomy | 16 px status glyph, label (host name, falling back to user@host), 16 px close button shown on hover or for the active tab. 8 px horizontal padding |
| Status glyphs | connecting (spinner), live (none), unread output (6 px teal dot), bell (bell glyph), reconnecting (amber ring), disconnected (grey slash), auth failed (red ✕), **AI needs approval** (teal filled badge, the highest priority), **config mode** (amber "CFG" pill, from a prompt match on `(config`) |
| Priority when several apply | needs approval > auth failed > disconnected > config mode > bell > unread |
| Reorder | Drag with a 4 px movement threshold before the drag starts. `Ctrl+Shift+PageUp/PageDown` moves the tab |
| Pinning | Pinned tabs show the icon only (32 px), sit on the left, and `Ctrl+Shift+W` skips them. Toggle from the context menu or palette |
| Reopen closed | `Ctrl+Shift+Alt+T` / `⌘⇧T`, restoring the host, pane layout and scrollback snapshot |
| Index jump | Keep `Alt+1..9` with `9` = last. **Do not use `Ctrl+Shift+<digit>`**, because of `Ctrl+Shift+6` |
| Hover card | After 500 ms: host, IP, platform (IOS-XE/EOS/Junos), uptime of the session, last command, exit status |
| Colour | Never status by colour alone. Every state has a distinct glyph shape |

### 1.3 Sidebars and resizable panels

- **Orca (observed)**: the left sidebar animates its width over 200 ms with `ease` and collapses to 0 px with no border ([main.css][o-css]). `Mod+B` toggles the left sidebar and `Mod+L` the right ([definitions-core-1][o-kb1]).
- **Zed (observed)**: three docks (left, right, bottom). Linux: `ctrl-b`, `ctrl-alt-b`, `ctrl-j`. macOS: `cmd-b`, `cmd-alt-b` or `cmd-r`, `cmd-j` ([default-linux][z-linux]).
- **Linear (observed)**: the sidebar is "a few notches dimmer" so content wins. The stated principle is "Don't compete for attention you haven't earned" ([design refresh][l-refresh]).

**Hopline spec (proposal)**, using `react-resizable-panels`
| Panel | Default | Min | Max | Collapse | Toggle |
|---|---|---|---|---|---|
| Session tree | 248 px | 180 px | 420 px | snap closed below 140 px | `Ctrl+Shift+B` / `⌘B` |
| AI panel | 380 px | 320 px | 50% of the window | snap closed below 260 px | `Ctrl+Shift+L` / `⌘L` |
| Status bar | 24 px fixed | | | | |

- Store sizes in pixels, not percentages, so a window resize grows the terminal and not the side panels. Double-clicking a divider resets it to the default.
- Session tree rows are 28 px with 16 px indentation per level and a 14 px icon. Folders show a count. Live sessions show the same status glyph as their tab. The tree surface is one step dimmer than the terminal area, following Linear.
- Collapsing a panel moves focus to the terminal and announces "Assistant panel hidden".
- Toggle semantics (Superhuman rule): the first press opens and focuses the panel. A second press while the panel is focused returns focus to where it came from ([Superhuman][superhuman]).

---

## 2. Keyboard-first design

### 2.1 Command palette structure

**Observed**
- **Warp** ([command palette][w-palette]): one palette with type prefixes: `workflows:`/`w:`, `prompts:`/`p:`, `notebook:`/`n:`, `files:`, `actions:`, `sessions:`, `launch_configs:`. Filter buttons do the same thing as the prefixes.
- **Orca** ([palette-section-render-cap][o-cap]): results are grouped in sections. Each section renders 50 rows and expands 20 at a time. Filter chips narrow the result types. The palette restores focus to its opener when it closes.
- **Linear**: `Cmd/Ctrl+K` runs any command. It is contextual, offering the actions for the current view or selection, and it can open anchored to the element that invoked it ([contextual command menu][l-ctx], [navigating Linear][l-nav]).
- **Superhuman** ([command palette guide][superhuman]): one shortcut everywhere, pressed again to close and restore focus. Every command has a palette entry. Fuzzy matching with a threshold. Aliases shown in parentheses, for example "Mark Done (Archive)". Default ranking boosts, context boosts, recency. Each row shows its shortcut to teach it. The last visible row is cut off to hint at more.

**Hopline palette spec (proposal)**
| Item | Value |
|---|---|
| Size | 640 px wide (max calc(100vw − 48px)), top offset 12vh, results max-height min(440px, 60vh) |
| Rows | 36 px, 16 px icon, label, dimmed secondary text (host IP, folder), right-aligned `Kbd` shortcut |
| Prefixes | `>` commands, `@` hosts and sessions, `#` snippets and saved commands, `?` help and shortcuts, `!` assistant (ask). A placeholder lists them |
| Empty query sections | Recent sessions (5), Suggested for context (for example "Reconnect" when disconnected, "Exit config mode" when in config), Commands |
| Context | Commands receive `{activePane, session state, selection}`. Hide a command only when it cannot apply, and demote one that is unlikely |
| Aliases | "Disconnect (Close session)", "Open AI audit log (History)", "Read-only mode (Safe mode)" |
| Recency | Boost the 10 most recently used commands with an MRU decay |
| Close | `Esc` or the same shortcut again, restoring focus to the exact element, usually the xterm textarea |
| Performance | First paint under 50 ms (proposal). Render a capped list (50 per section, like Orca) instead of virtualising |

### 2.2 Session switcher

**Observed**
- **Orca** ([RecentTabSwitcher][o-recent]): hold `Ctrl` and press `Tab` repeatedly. An MRU overlay of about 360 px (22.5rem) appears at 12vh from the top, lists at most 18rem of rows, and commits on `Ctrl` keyup. `Ctrl+Tab` is allowed while the terminal has focus.
- **Zed**: `ctrl-tab` opens the tab switcher and `ctrl-p` the file finder ([default-linux][z-linux]).
- **Warp**: the session navigator searches by prompt, running command, last command and status text ("Running…", "Completed 10 minutes ago", "Empty Session") ([session navigation][w-sessions]).

**Hopline spec (proposal)**
- `Ctrl+Tab` / `Ctrl+Shift+Tab` (both platforms; the binding already exists): hold-to-cycle MRU across tabs *and* panes. The overlay appears only if `Ctrl` is held longer than 150 ms. A quick tap switches to the previous session with no flash.
- `Ctrl+Shift+P` / `⌘P`: "Go to session or host" opens the palette in `@` mode, fuzzy over open sessions first and then saved hosts. Each row shows a status glyph, `user@host`, the folder path and the time since last output. `Enter` focuses an open session or connects a saved host. `Alt+Enter` opens it in a split to the right.

### 2.3 Shortcut discoverability

**Observed**
- **Linear**: `?` opens a searchable shortcuts window ([changelog][l-shortcuts]). Navigation uses `G`-prefixed chords, for example `G` then `I` for Inbox ([navigating Linear][l-nav]).
- **Zed** ([key bindings][z-keys]): a status-bar indicator shows pending chord keystrokes, and hovering it lists the possible completions (also `alt-/`). A which-key popup has a configurable delay. The keymap editor (`ctrl-k ctrl-s`) shows a pencil on row hover, edits on `Enter` or double-click, and writes to `keymap.json`. Base keymap presets exist. A "key context view" debugs why a key did or did not fire.
- **Orca** ([keybinding types][o-kbtypes]): every action has search keywords and per-platform defaults. Flags say whether it may fire while the terminal or a text field has focus (`allowInTerminal`). A keybindings file has diagnostics and conflict detection.
- **Zed terminal context** ([default-linux][z-linux]): `ctrl-b/c/e/o/q/w/r` are explicitly forwarded to the shell (`SendKeystroke`) to override app bindings. This is the pattern Hopline already follows.

**Hopline spec (proposal)**
- Shortcut sheet on `Ctrl+Shift+/` / `⌘/` (a bare `?` is impossible because the terminal is always a text field). A searchable modal grouped by Sessions, Panes, Tabs, Terminal, Assistant and App.
- Every tooltip and menu item shows its `Kbd`. Tooltips open after 500 ms, and after 0 ms when moving between adjacent tooltips.
- An action registry, one source for the palette, menus, tooltips, the sheet and the settings keymap editor. Fields: `id, title, aliases[], keywords[], defaults{linux,win,mac}, scope: 'global'|'terminal'|'ui', passToDevice?: boolean`.
- **Device-reserved list** (never bindable): plain `Ctrl+<letter>`, `Ctrl+Shift+6` (`Ctrl+^`), `Ctrl+]` (telnet escape), `Ctrl+\`. The app's key handler must let these reach xterm even when a `Ctrl+Shift` binding with the same physical key exists. The keymap editor refuses them with a reason ("Cisco uses Ctrl+Shift+6 to break a running command"). `Ctrl+_` (`Ctrl+Shift+-`) is deliberately not reserved, because network CLIs rarely use it and §6 uses it for UI zoom out.
- Keymap editor in Settings: row = action, binding, scope, source (default or user). A conflict badge. A "reset" per row.

### 2.4 Focus management

- **One focus owner at a time**: terminal, tree, AI input, palette or dialog. The status bar shows the owner as text ("Terminal: core-sw1").
- A palette, dialog or menu that closes returns focus to the element that opened it (Orca, Superhuman).
- Focus-return targets are recorded at the time of opening, because the opener may unmount.
- `Esc` from the AI panel or tree returns focus to the last terminal. `Esc` *inside* the terminal always goes to the device.
- An approval card takes focus only if the user's focus is already in the AI panel. Otherwise it raises the tab badge and an `aria-live` announcement, and never steals keystrokes from a live terminal. This guards against typing `y` into a config prompt by accident.
- Zed builds "tab groups" (local tab-index scopes) into form UIs ([settings UI blog][z-settings]). Use Radix `FocusScope` per panel and roving tabindex in the tree and tab strip.

### 2.5 Vim-like navigation

- **Observed**: Zed terminal vi mode `ctrl-shift-space` (scrollback navigation), vim `ctrl-w` pane chords ([vim keymap][z-vim]), and Warp vim bindings for its input editor ([Warp vim][w-vim]).
- **Hopline (proposal)**, behind an opt-in "Vim navigation" setting:
  - **Scrollback copy mode**: `Ctrl+Shift+Space`. Then `h/j/k/l`, `w/b`, `gg/G`, `Ctrl+U/D` (allowed only because copy mode is modal and no key reaches the device while it is on), `/` and `?` search,
    `n/N`, `v`/`V` select, `y` yank, `Esc` exits. A 20 px "COPY" pill in the pane header shows the mode.
    Live output keeps arriving while the viewport stays still. Show "N new lines" and let `G` jump to them.
  - **Session tree** (when focused): `j/k` move, `h/l` collapse and expand, `Enter` connect, `/` filter, `o` open in a split, `x` disconnect.
  - **Pane focus leader**: `Ctrl+Shift+W` then `h/j/k/l`. Allowed only if close pane moves to `Ctrl+Shift+Q`. Leave it off by default.

---

## 3. AI surfaces

### 3.1 Blocks: command plus output as a unit

**Warp (observed)** ([block basics][w-blocks], [block actions][w-bactions], [block filtering][w-filter], [sticky header][w-sticky])
- Each command and its output form a block. Non-zero exits get a red background and a red sidebar.
- Select the latest block with `Ctrl+↑` (Linux), move with arrows, extend with `Shift+↑/↓`.
- Bookmark a block (`⌘B` on macOS, `Ctrl+Shift+B` on Windows). The scrollbar marks bookmarks, and hovering a mark shows the command plus the last 2 lines.
- Per-block filter with regex, case and invert options and N context lines (`Alt+Shift+F`). Filtering hides lines and never deletes them.
- When a block's output is cut off, a sticky header pins the command at the top. Clicking it scrolls to the start of the block.
- The block menu copies the command, the output or both. Blocks can be attached to the agent as context.

**Hopline spec (proposal)**. Network CLIs have no shell integration, so infer blocks from prompt detection
(`hostname#`, `hostname(config-if)#`, `user@host>`) and record them as xterm markers.
- Block gutter: a 3 px left rail. Neutral by default. Red when output matches error patterns (`% Invalid input`, `% Incomplete command`, `error:`), since devices give no exit code. Amber for config-mode commands.
- Select the previous or next block with `Ctrl+Shift+↑/↓` (plain `Ctrl+↑` would reach the device). The selection is a 1 px teal outline plus a 6% teal fill.
- Block actions (hover kebab or right-click): Copy command, Copy output, **Ask about this output** (exists today as "Explain this output"), Filter, **View as table** (§7.1), Bookmark.
- Sticky header: a 24 px bar showing `hostname# show ip bgp summary` with the time it ran. It is pinned while a block taller than the viewport is scrolled.
- Draw block decorations in the xterm overlay, never by rewriting buffer text.

### 3.2 Agent step timelines

**Observed**
- **Warp task lists** ([task lists][w-tasks]): statuses ● current, ✔ completed, ○ not started, ■ cancelled. A completion marker sits in the conversation after each step. A chip at the bottom right opens the list and collapses without interrupting the agent. A summary at the end explains skipped steps.
- **Warp prompt queueing** ([prompt queueing][w-queue]): follow-ups typed while the agent works go into a reorderable queue above the input. `Enter` on an empty input sends the next one. Shell commands are never queued.
- **Orca** ([main.css][o-css]): settled quiet turns fade their rows in 300 ms, then collapse the space in 280 ms.

**Hopline spec (proposal)**
- The assistant turn is a vertical timeline. Each step is a 28 px row: status glyph (○ ● ✓ ✕ ■ ⏸ awaiting approval), a verb phrase ("Ran `show ip bgp summary` on core-sw1"), the duration ("0.4 s") and a chevron.
- An expanded row shows the raw device output (monospace, max 240 px tall with internal scroll) and "Open in terminal", which jumps to that block in the scrollback.
- Read-only show commands run by the assistant render collapsed by default.
- Proposed, blocked and refused steps always render expanded, and each carries the guard's reason ("Blocked: `reload` is never allowed").
- Every step links to its row in the AI audit log.
- A device badge per step. In a multi-device run, group the steps under device headers.

### 3.3 Approval UIs

**Observed**
- **Warp** ([profiles and permissions][w-perms]): per-action autonomy levels (Agent decides, Always ask, Always allow, Never). Command allowlist and denylist as regexes, with the denylist taking precedence. "Run until completion" (`Ctrl+Shift+I`) auto-approves everything for one task, and by default even bypasses the denylist. Since 2025.11, approval before running commands is the default ([changelog][w-changelog]). The CLI approval card *replaces the input*: `Enter` confirms, `Esc` rejects, `E` edits or expands diffs ([Warp CLI][w-cli]).
- **Zed** ([tool permissions][z-perms]): Allow once / Deny once / "Always for <tool>" / "Always for <pattern>" (offered only when a safe pattern can be extracted). Precedence: built-in security rules > `always_deny` > `always_confirm` > `always_allow` > tool default > global default. Chained commands (`&&`) are split and each part is checked. Built-in rules block recursive deletion of root or home and cannot be overridden.
- **Orca** ([NativeChatApprovalCard][o-approval]): the first option is primary. The first `Tab` from the card reaches the default action, not Cancel. `Esc` cancels. Routine tool prompts render as quiet transcript rows, and high-stakes prompts keep the full card.

**Hopline approval card spec (proposal)**. Hopline's rule is that config changes run only after explicit approval of exact lines.
| Element | Spec |
|---|---|
| Placement | Docked above the AI input, replacing it while pending (Warp). The tab and tree row get the "needs approval" badge |
| Header | Device, platform, mode (`configure terminal`), risk level ("Changes routing", "Shuts an interface") |
| Body | The proposed lines as a diff against the running config (§7.2), **one checkbox per line**, all checked by default, with a rollback preview below |
| Actions | `Approve N lines` (primary), `Edit`, `Reject`. **No "always allow" for config.** "Always allow pattern" is offered only for read-only show commands |
| Keys (focus in card) | `Enter` approve, `Esc` reject, `E` edit, `Space` toggle the focused line, `↑/↓` move between lines |
| Safety | A 600 ms arming delay before `Enter` can approve, so a keypress already in flight cannot approve (proposal). The Approve button shows a 2 px progress underline during the delay. 0 ms animation under reduced motion, but the delay stays |
| No YOLO | No Warp-style "run until completion" for config mode. Denylist rules (`reload`, `write erase`, `format`, `crypto key zeroize`) cannot be overridden, like Zed's built-in rules |
| Chained input | Split multi-line or `;`-joined proposals and evaluate each line separately (Zed) |
| After approval | The card collapses into a timeline row: "Applied 3 of 4 lines on core-sw1 · approved by you · 14:02" |

### 3.4 Inline AI prompts

**Observed**
- **Warp** ([terminal and agent modes][w-modes]): the terminal mode stays clean, with a hint bar. Agent mode is a separate, visually distinct conversation view. Terminal blocks can be attached as context. Rich input opens with `Ctrl-G` ([rich input][w-rich]).
- **Zed** ([inline assistant][z-inline]): `ctrl-enter` opens the inline assistant in editors *and the terminal panel*. It uses the selection or the current line as context and can cycle between models' outputs.

**Hopline spec (proposal)**
- Keep `@ai <question>` at the prompt (exists today). Add `Ctrl+Shift+A` / `⌘⇧A` for "Ask about selection or last block". `Ctrl+Shift+Enter` is not used here because it is pane zoom. The shortcut opens a one-line, 40 px prompt docked to the bottom of the active pane, with the context chip "core-sw1 · last block (32 lines)".
- The answer streams into the AI panel, not over the terminal. Suggested commands appear as chips: `Insert` (types the text without Enter) or `Run` (only for show commands in read-only mode).
- Use a 24 px hint strip at the pane bottom only during the first 3 sessions: "Ctrl+Shift+A asks about the output above".

### 3.5 Diff review

**Observed**
- **Warp** ([code diffs][w-diffs]): `↑/↓` moves between hunks, `←/→` between files, `Enter` accepts, `R` refines with natural language, `E` edits, `Esc` exits. Nothing applies unless you accept.
- **Zed** ([agent panel][z-agent]): a changed-files accordion above the input. "Review Changes" (`ctrl-shift-r`) opens a multibuffer with keep or reject per hunk (`alt-y` keep, `ctrl-alt-z` reject, `shift-alt-y` / `shift-alt-z` all) ([default-linux][z-linux]).
- **Orca** ([README][orca-readme]): leave notes on exact changed lines and send them back to the agent as focused feedback.

The Hopline diff spec is in §7.2.

---

## 4. Onboarding, empty states, toasts, settings

### 4.1 Onboarding and first run

**Observed**
- **Orca** ([OnboardingFlow][o-onboard]): a stepped flow (agent, theme look, notifications, integrations). 4 px stepper bars with larger invisible hit areas, each with a tooltip. "Set up later" on every step except the required one. Skipping asks for confirmation. Inline terminal demos and a theme-look gallery.
- **Linear** ([first-time UX][l-ftux]): the intro teaches the command menu. It can be rerun from the palette ("welcome tutorial"). `?` lists every shortcut.

**Hopline spec (proposal)**: three steps, under 60 s, every step skippable.
1. **Look**: dark, light or system, plus terminal font size with a live preview of a fake `show ip int brief`. The theme picker from §4.5.
2. **First host**: import `~/.ssh/config`, a PuTTY or SecureCRT export, or CSV. Or "Try the lab" (the simulator folder). Or add a host manually.
3. **Assistant**: paste an API key or skip. Explain read-only mode in two lines, with a "What can it do?" link.

Finish on a connected session with a dismissible 3-item checklist in the empty AI panel:
"Open the palette (Ctrl+Shift+K)", "Ask about output (Ctrl+Shift+A)", "Split a pane (Ctrl+Shift+D)".
Rerun from the palette: "Welcome tour".

### 4.2 Empty states

| Surface | Content (proposal) |
|---|---|
| No tabs or empty split | The "Connect to…" launcher (pattern: Orca SplitPaneLanding): a search field with focus, recent hosts (5), "New host…", "Quick connect user@host". Shortcut hints at the bottom. Max width 520 px, centred, 30% from the top |
| Empty session tree | "No hosts yet" with Import ssh config, Add host, Try the lab. One sentence, no illustration |
| AI panel with no key | One sentence on what it does and why it is safe, a key field and a link to Settings → Assistant |
| AI panel, no conversation | Three example prompts scoped to the active device ("Why is BGP to … down?") |
| Search with no results | "No matches for 'xyz' in scrollback (5,000 lines)" with an option to search all panes |
| Audit log empty | "Nothing recorded yet. Every command the assistant runs or proposes appears here." |

### 4.3 Toasts and notifications

**Observed**
- **Warp** ([agent notifications][w-notif]): types are Complete, Request (needs input) and Error. A toast appears in the corner when the agent is in another tab. It auto-dismisses after "a few seconds", pauses on hover and jumps to the session on click. **At most 2 visible**, the oldest replaced. A mailbox panel (bell icon) has All, Unread and Errors filters and "Mark all as read".
- **Zed** ([agent panel][z-agent]): desktop notification and/or sound when the app is in the background and the agent is waiting or done.
- **Orca** (sonner, [osc52-clipboard-toast][o-osc52]): a close button on every toast. Durations: 8 s for undo-style notices, 12 s for errors, 30 s for an action that retries. Toast actions deep-link to the exact setting. Some warnings latch so they show once per session.

**Hopline spec (proposal)**, with `sonner`
| Kind | Duration | Example |
|---|---|---|
| Info | 4 s | "Copied 42 lines" |
| With action or undo | 8 s | "Session closed · Reopen" |
| Error | 12 s, or until dismissed if it blocks work | "Auth failed on dist-eos1 · Edit host" |
| Needs approval (other tab) | Persistent until handled, max 1 per device | "core-sw1: assistant wants to change 3 lines · Review" |
- Bottom right, max 3 visible, 360 px wide, 8 px gap. Hover and keyboard focus pause timers. `Esc` dismisses the focused toast.
- Never toast for something already visible in the focused pane. Background events go to the tab badge and a status-bar bell counter.
- Desktop notifications only when the window is not focused, and only for "needs approval" and "disconnected unexpectedly".
- Remote OSC 52 clipboard writes (a device writing the clipboard) need an opt-in toast, as in Orca.

### 4.4 Settings organization

**Observed**
- **Zed** ([settings UI blog][z-settings], [configuring Zed][z-config]): a separate window with a category list on the left and grouped controls on the right. Settings are searchable. User settings and project settings are separate scopes. The JSON file stays available as an escape hatch. A dedicated keymap editor.
- **Orca** ([settings-navigation-foundations][o-settings]): top groups Setup, Workflows, Interface (appearance, chat, input, notifications, shortcuts), Remote, Security, Advanced, Experimental. Sidebar search. Deep links to one setting highlight it with a 3 s fade (reduced motion: no animation).
- **Linear** ([settings pages changelog][l-settings]): settings are split into Account (personal settings, notifications, preferences), Features (workspace-level) and Your teams, plus an Administration section only admins see. Users can reorder and hide sidebar items and choose a count or a dot for unread notifications.
- **Warp** ([profiles and permissions][w-perms]): agent behaviour lives in named *profiles* ("Safe & cautious", "YOLO") with per-action autonomy.

**Hopline structure (proposal)**: modal sheet 880 × 640 px, left nav 200 px, search field at the top of the nav (`Ctrl+F` inside settings).
1. General: startup, updates, language
2. Appearance: theme, accent intensity, UI font size, density (compact 28 px rows / comfortable 32 px)
3. Terminal: font, size, line height, cursor, scrollback, bell, copy on select, minimum contrast, screen reader mode
4. Connections: SSH defaults, keep-alive, reconnect, jump hosts, known hosts, logging
5. Assistant: provider, model, key, read-only default, allowlist of show-command patterns, profiles
6. Safety and audit: denylist (built-ins shown locked), approval delay, audit log retention and export
7. Keyboard: keymap editor (§2.3)
8. Advanced: open the settings JSON, reset, diagnostics

- Each setting row: label, one-line description, control on the right, a "modified" dot with reset on hover.
- Every setting has a stable id, so palette entries, toasts and errors can deep-link with `settings:terminal.minimumContrast`.
- Per-host overrides (font size, encoding, keep-alive) live in the host editor and show "overrides global", like Zed's project scope.

### 4.5 Theme and font pickers

**Observed**
- **Zed**: theme selector `ctrl-k ctrl-t` ([default-linux][z-linux]). `theme.mode` is `system` by default, with separate light and dark themes. Defaults: `ui_font_size` 16, buffer 15, terminal line height 1.3 ("standard"; "comfortable" is 1.618), terminal scrollback 10,000, `terminal.minimum_contrast` 45 ([configuring Zed][z-config]).
- **Warp** ([themes][w-themes], [text and fonts][w-fonts]): the picker applies a theme live, ✓ saves and ✕ reverts. "Sync with OS" with a light and a dark slot. Text settings: family, weight, size, line height, enforce minimum contrast, ligatures.
- **Orca** ([default-global-settings][o-defaults]): terminal font 14, block cursor, blink on, scrollback 5,000 rows. When the theme swaps, all transitions are disabled so the palette changes in one frame ([main.css][o-css]).
- **Linear** ([redesign][l-redesign]): themes are generated from three inputs (base, accent, contrast) in LCH, down from 98 variables.

**Hopline spec (proposal)**
- Theme picker: a palette-style list (`>Theme`). `↑/↓` previews live in all panes, `Enter` keeps, `Esc` reverts. Light and dark slots when "Follow system" is on.
- Generate the theme from base, accent (teal) and contrast in OKLCH (Tailwind 4 uses OKLCH natively). Contrast 0–100 drives the border and muted-text steps.
- Font picker: monospace fonts only for the terminal (detect via a width check of `i` versus `M`), each previewed in its own face with `Gi1/0/1  10.0.0.1  up  up` and `0O 1lI` disambiguation.
- Defaults: terminal JetBrains Mono 13 px, line height 1.2, block cursor, blink on. UI Geist 13 px. Scrollback 10,000.
- Apply theme changes with transitions disabled (Orca), then call xterm `options.theme` once.

---

## 5. Motion

**Orca motion numbers (observed, [main.css][o-css])**
| What | Duration | Easing |
|---|---|---|
| Row hover background | 100–150 ms | `ease` |
| Small inline toast or chip | 120 ms opacity + 2 px translate | `ease` |
| Sidebar width | 200 ms | `ease` |
| Collapsible open / close | 200 ms / 180 ms | `ease-out` |
| Reveal and expand | 180 ms | `cubic-bezier(0.16, 1, 0.3, 1)` (expo-out) |
| Sheet in / out | 300 ms / 200 ms | expo-out / `cubic-bezier(0.7, 0, 0.84, 0)` (expo-in) |
| Inactive pane opacity | 140 ms | |
| Divider hover | after a 200 ms delay; none while dragging | |
| Attention glow (scroll to target) | 1.2–1.5 s | `ease-out` |
| Settings target highlight | 3 s fade | `ease-out` |

Reduced motion in Orca: spinners and pulses stop, transitions and animations drop to 0 ms, and animations in off-screen rows are paused.

**Hopline motion tokens (proposal)**
```
--dur-instant: 0ms;   --dur-fast: 120ms;  --dur-base: 180ms;  --dur-slow: 260ms;
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);   --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
--ease-std: cubic-bezier(0.2, 0, 0, 1);
```
| Element | Animation |
|---|---|
| Hover and press | background 120 ms `ease-std` |
| Palette, menus, popovers | in: 150 ms opacity + scale 0.98→1 `ease-out`; out: 100 ms opacity |
| Dialog and settings sheet | in 180 ms, out 120 ms |
| Toast | 180 ms slide 8 px + fade |
| Panel collapse | 180 ms width, but see the terminal rule below |
| Status glyph changes | 120 ms crossfade. The "needs approval" badge pulses twice (2 × 600 ms), then holds still |

**Must never animate**
- xterm content, cursor position, scroll position (`smoothScrollDuration: 0`) and font-size changes.
- Terminal resize. During a panel animation, keep the xterm canvas at its old size (`overflow: hidden`). Run `fit()` once on `transitionend`, or every 100 ms while a divider is dragged, so the PTY does not get a resize storm and the device does not redraw 30 times.
- Theme swaps (disable transitions globally for one frame).
- Anything in the approval card's diff body. Text must be readable the instant it appears.

**Reduced motion** (`prefers-reduced-motion: reduce`, plus an in-app override in Appearance)
- Every duration drops to 0 except opacity fades, which drop to 80 ms or less. Spinners become a static "…" glyph. The cursor stops blinking unless the user explicitly turned blink on. Attention pulses become a static ring.
- Keep functional delays (the 600 ms approval arming delay, the tooltip delay). Those are timing, not motion.

---

## 6. Accessibility in a terminal app

**Observed**
- **xterm.js** ([ITerminalOptions][xterm-opts]): `screenReaderMode` adds a DOM accessibility tree for NVDA and VoiceOver. `minimumContrastRatio` defaults to 1 (off). `cursorInactiveStyle` (`outline`, `block`, `bar`, `underline`, `none`). `smoothScrollDuration` 0 scrolls instantly.
- **Orca** ([terminal-contrast-correction][o-contrast], [global-settings-types][o-settypes]): automatic minimum contrast of 3 on dark backgrounds and 4.5 on light ones. A user override exists, and setting it to 1 disables correction for TUIs that rely on low contrast.
- **VS Code** ([accessibility][vsc-a11y]): Accessibility Help `Alt+F1` (Linux `Shift+Alt+F1`). **Accessible View** `Alt+F2` (Linux `Shift+Alt+F2`) shows the whole terminal buffer as readable text. Go to command `Ctrl+Shift+O` inside it. `Ctrl+M` toggles Tab trapping. `terminal.integrated.minimumContrastRatio` ranges 1–21. Unfocused views dim to 0.75 by default.
- **Warp** ([accessibility][w-a11y]): announces events through VoiceOver itself and supports keyboard block navigation. It says plainly that this is a work in progress.
- **Zed**: `terminal.minimum_contrast` 45 by default, described as the minimum for large fluent text ([configuring Zed][z-config]).

**Hopline spec (proposal)**
| Area | Spec |
|---|---|
| Screen reader mode | A setting with Auto (follows the OS), On and Off, plus a palette toggle. Sets `term.options.screenReaderMode` at runtime. Announce "Screen reader mode on" |
| Accessible buffer | `Shift+Alt+F2`: open the active pane's scrollback (last 2,000 lines) in a read-only, focusable text view with block headings, so `H` jumps by command under NVDA |
| Announcements | One polite `aria-live` region: "core-sw1 disconnected", "Assistant needs approval on core-sw1", "Command finished, 32 lines". Rate-limit to 1 per 2 s per session |
| Contrast | `minimumContrastRatio` 4.5 by default for the terminal, user-adjustable from 1 to 7. UI text 4.5:1, borders and focus 3:1 (WCAG 1.4.11) |
| Focus ring | 2 px teal outline, 2 px offset, `:focus-visible` only. Never clipped by `overflow: hidden` (use an inset ring inside scroll containers) |
| Pane focus | Active pane = header marker + `cursorInactiveStyle: 'outline'` in the other panes. Dimming is optional and never the only cue |
| Tab key | Tab always goes to the device while the terminal has focus. `Ctrl+Shift+M` toggles "Tab moves focus" for keyboard-only users, shown in the status bar |
| Keyboard reach | Every action reachable without a mouse. Tree, tabs and timeline use roving tabindex and arrow keys. Splits resizable via divider focus + arrow keys (10 px steps, 50 px with Shift) |
| Status | Every state glyph has an accessible name ("core-sw1, needs approval"). Never colour alone |
| Zoom | `Ctrl+=` / `Ctrl+-` cannot be used (devices need them), so use `Ctrl+Shift+=` / `Ctrl+Shift+-` for UI zoom, and terminal font size from the palette |

---

## 7. Information density

None of the four apps renders parsed network output. These patterns are **derived** from Warp block filtering
and actions, Warp and Zed hunk navigation, and Orca line comments.

### 7.1 Tables for parsed command output

Trigger: a block whose command matches a parser (`show ip int brief`, `show interfaces status`, `show ip bgp summary`,
`show lldp neighbors`, `show mac address-table`). The block shows a `Table` toggle. Raw output is always one key away.
| Item | Spec (proposal) |
|---|---|
| Placement | Inline, replacing the block output in an overlay above the xterm rows, or "Open in panel" (AI panel tab). The raw text stays in the scrollback |
| Toggle | `T` with the block selected, or the block menu. The choice is remembered per command type |
| Rows | 24 px compact, 28 px comfortable. Monospace for interface names, IPs, MACs and counters. `font-variant-numeric: tabular-nums` |
| Header | 28 px, sticky, sortable (click or `Enter` on a focused header). Sort shown with ▲▼ plus `aria-sort` |
| Alignment | Text left, numbers right, status centred |
| Status cells | Glyph + word: `● up`, `○ down`, `⊘ admin down`, in green, grey or red, with the word always shown |
| Filter | A field above the table (Warp's filter: plain or regex, invert). Matches highlighted. "12 of 48 rows" |
| Actions | Row context menu: "Ask about this interface", "Run `show interface <x>`" (inserted, not sent), "Copy row". Table menu: Copy as CSV, Copy as Markdown |
| Diff since last run | When the same command ran earlier in the session, a "Changed since 14:02" chip highlights changed cells with an underline |
| Large output | Virtualise above 500 rows. Columns resizable, minimum 48 px |

### 7.2 Diff viewer for config backups and proposed changes

| Item | Spec (proposal) |
|---|---|
| Modes | Unified (default in the AI panel, narrower than 600 px) or side by side (in a pane or tab, 900 px or wider). Toggle with `D` while the diff has focus |
| Hierarchy | Network configs are indented trees. Each hunk shows its parent stanza as a sticky header (`interface GigabitEthernet1/0/2`, `router bgp 65001`), like Warp's sticky command header |
| Context | 3 unchanged lines around each hunk, folded runs shown as "⋯ 214 unchanged lines". Click or `Enter` to expand by 20 |
| Noise filter | Ignore by default and list in a "Hidden noise (4)" chip: `! Last configuration change at…`, `ntp clock-period`, certificate blobs, `Building configuration…`, trailing whitespace. Editable in Settings |
| Navigation | `]` / `[` or `↓` / `↑` next and previous hunk (Warp), `←` / `→` previous and next file or device, `Home` / `End` |
| Line colours | Added and removed lines use background tints at 12% opacity (teal-green and red) **plus** `+`/`−` gutter signs. Intraline changes use a 24% tint. Line numbers in the gutter are muted |
| Review actions | For proposals: per-line checkboxes (§3.3). For backups: "Restore these lines" generates a *proposal*, which then goes through the normal approval card |
| Comments | Select lines and press `C` to attach a note sent to the assistant ("why is this ACL removed?"). Pattern: Orca line notes |
| Header bar | Device, the two snapshots ("startup 2026-11-20 03:00 ↔ running now"), stats (+12 −4), mode toggle, noise chip |
| Density | 20 px line height at 12.5 px monospace. The same font as the terminal so the eye does not refocus |

---

## 8. Hopline recommendations (prioritized)

**P0: safety and core keyboard flow (build first)**
1. **Action registry with device-reserved keys** (§2.3). One registry feeds the palette, menus, tooltips, the shortcut sheet and the keymap editor.
   Hard-block plain `Ctrl+<letter>`, `Ctrl+Shift+6`, `Ctrl+]`, `Ctrl+\` (pattern: Zed terminal passthrough, Orca `allowInTerminal`).
2. **Approval card with per-line checkboxes, an arming delay and no "always allow" for config** (§3.3).
   Locked built-in denylist (Zed precedence model). Approval never steals focus from a live terminal (§2.4).
3. **Tab and tree status glyphs with a priority order** (§1.2), led by "needs approval" and "config mode". Not colour-only.
4. **Focus ownership and restoration** (§2.4). `Esc` semantics stay the same everywhere, except inside the terminal, where it goes to the device.
5. **Terminal never animates** (§5). Fit on `transitionend`, `smoothScrollDuration: 0`, transitions disabled during a theme swap.

**P1: layout and navigation**
6. **Splits** with `Ctrl+Shift+D/E`, directional focus, zoom `Ctrl+Shift+Enter`, an active-pane marker plus optional dimming (0.85),
   an 8 px divider hit area with a 200 ms hover delay, and a "Connect to…" launcher in empty splits (§1.1).
7. **Ctrl+Tab hold-to-cycle MRU** across tabs and panes, plus `Ctrl+Shift+P` / `⌘P` "Go to session or host" (§2.2).
8. **Palette prefixes and context** (`>`, `@`, `#`, `?`, `!`), shortcuts shown on every row, aliases, MRU boost, capped sections (§2.1).
9. **Tab strip condense plan**: titled down to 80 px, then icons, then a "+N" chip. Pinning, `Ctrl+Shift+PageUp/Down` reorder, reopen closed (§1.2).
10. **Pixel-based panel sizes** with snap-to-collapse thresholds and `Ctrl+Shift+B` / `Ctrl+Shift+L` toggles that focus on the first press (§1.3).

**P2: AI and density differentiators**
11. **Inferred command blocks** with prompt-based markers, an error rail, sticky command header, block select `Ctrl+Shift+↑/↓`, and block actions (§3.1).
12. **Step timeline** in the AI panel. Show commands collapsed, proposals and blocks expanded, each linked to the audit log (§3.2).
13. **Parsed-output tables** with a raw/table toggle and "changed since last run" (§7.1).
14. **Config diff viewer** with stanza sticky headers, a noise filter and hunk keys (§7.2), shared by approvals and backup comparison.
15. **Inline ask** `Ctrl+Shift+A` with selection or last-block context, and `Insert` / `Run` chips for show commands (§3.4).

**P3: polish and accessibility depth**
16. **Accessibility pack**: screen reader mode toggle, accessible buffer view `Shift+Alt+F2`, a rate-limited live region, minimum contrast 4.5,
    Tab-trap toggle, keyboard-resizable dividers (§6).
17. **Settings sheet** with search, stable ids and deep links (toast → exact setting, highlighted for 3 s), per-host overrides, a keymap editor (§4.4).
18. **Theme generation** from base, accent and contrast in OKLCH, with a live-preview picker (`Esc` reverts) and a monospace font preview (§4.5).
19. **Onboarding** in 3 skippable steps that ends connected, with a rerunnable "Welcome tour" and a 3-item checklist (§4.1).
20. **Notification discipline**: max 3 toasts, hover pause, the durations from §4.3, desktop notifications only for approval and an unexpected disconnect, and an opt-in for OSC 52 clipboard writes.

**Explicitly do not adopt**
- Warp's "Run until completion" auto-approve, and any "always allow" for configuration changes.
- Zed's `ctrl-k` and `ctrl-w` chords, and Linear's bare-letter `G` chords, while the terminal has focus.
- Warp's plain `Ctrl+↑/↓` block selection on Linux, because those keys belong to the device.
- Focus-follows-mouse as a default. It is risky with live config sessions.

---

## Sources

Orca (MIT, commit `c146a111bfc80cb048d96c0eb6253190404720c2`). Numbers and behaviours were read from the files, and no code was copied.

[orca]: https://github.com/stablyai/orca
[orca-readme]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/README.md
[o-css]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/assets/main.css
[o-defaults]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/settings/default-global-settings.ts
[o-settypes]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/settings/global-settings-types.ts
[o-opacity]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/terminal/appearance/terminal-pane-opacity.ts
[o-dim]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/tab-group/panel/split-group-dim.ts
[o-drop]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/tab-group/drag/tab-drop-zone.ts
[o-landing]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/tab-group/landing/SplitPaneLanding.tsx
[o-tabw]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/tab-bar/strip/tab-strip-width-budget.ts
[o-condense]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/tab-bar/strip/tab-strip-condense-plan.ts
[o-status]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/worktree/row-display/worktree-status-rollup.ts
[o-recent]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/tab-bar/recent-switcher/RecentTabSwitcher.tsx
[o-kb1]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/keybindings/definitions-core-1.ts
[o-kb2]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/keybindings/definitions-core-2.ts
[o-kb3]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/keybindings/definitions-core-3.ts
[o-kb4]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/keybindings/definitions-core-4.ts
[o-kbtypes]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/keybindings/types.ts
[o-cap]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/cmd-j/palette-section-render-cap.ts
[o-approval]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/native-chat/prompts/NativeChatApprovalCard.tsx
[o-onboard]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/onboarding/OnboardingFlow.tsx
[o-settings]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/settings/navigation/settings-navigation-foundations.ts
[o-osc52]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/renderer/src/components/terminal-pane/clipboard/osc52-clipboard-toast.ts
[o-contrast]: https://github.com/stablyai/orca/blob/c146a111bfc80cb048d96c0eb6253190404720c2/src/shared/terminal-themes/terminal-contrast-correction.ts

<!-- Warp -->
[w-split]: https://docs.warp.dev/terminal/windows/split-panes
[w-dim]: https://docs.warp.dev/terminal/appearance/pane-dimming/
[w-sessions]: https://docs.warp.dev/terminal/sessions/session-navigation/
[w-tabs]: https://docs.warp.dev/terminal/windows/tabs/
[w-tabsb]: https://docs.warp.dev/terminal/appearance/tabs-behavior/
[w-vtabs]: https://docs.warp.dev/terminal/windows/vertical-tabs/
[w-palette]: https://docs.warp.dev/terminal/command-palette/
[w-vim]: https://docs.warp.dev/terminal/editor/vim/
[w-blocks]: https://docs.warp.dev/terminal/blocks/block-basics
[w-bactions]: https://docs.warp.dev/terminal/blocks/block-actions/
[w-filter]: https://docs.warp.dev/terminal/blocks/block-filtering/
[w-sticky]: https://docs.warp.dev/terminal/blocks/sticky-command-header/
[w-tasks]: https://docs.warp.dev/agents/capabilities/task-lists/
[w-queue]: https://docs.warp.dev/agents/local-agents/interacting-with-agents/prompt-queueing/
[w-perms]: https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/
[w-changelog]: https://docs.warp.dev/changelog/2025/
[w-cli]: https://docs.warp.dev/agents/cli/reference.md
[w-modes]: https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/
[w-rich]: https://docs.warp.dev/agents/cli-agents/rich-input/
[w-diffs]: https://docs.warp.dev/agents/local-agents/code-diffs/
[w-notif]: https://docs.warp.dev/agents/capabilities/agent-notifications/
[w-themes]: https://docs.warp.dev/terminal/appearance/themes/
[w-fonts]: https://docs.warp.dev/terminal/appearance/text-fonts-cursor/
[w-a11y]: https://docs.warp.dev/terminal/more-features/accessibility/

<!-- Zed -->
[z-keys]: https://zed.dev/docs/key-bindings
[z-linux]: https://github.com/zed-industries/zed/blob/main/assets/keymaps/default-linux.json
[z-vim]: https://github.com/zed-industries/zed/blob/main/assets/keymaps/vim.json
[z-agent]: https://zed.dev/docs/ai/agent-panel
[z-perms]: https://zed.dev/docs/ai/tool-permissions
[z-inline]: https://zed.dev/docs/ai/inline-assistant
[z-config]: https://zed.dev/docs/configuring-zed
[z-settings]: https://zed.dev/blog/settings-ui

<!-- Linear -->
[l-redesign]: https://linear.app/now/how-we-redesigned-the-linear-ui
[l-refresh]: https://linear.app/now/behind-the-latest-design-refresh
[l-ctx]: https://linear.app/changelog/2019-10-07-contextual-command-menu
[l-nav]: https://linear.app/enablement/guide/navigating-linear
[l-shortcuts]: https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help
[l-ftux]: https://linear.app/changelog/2019-05-09-first-time-user-experience
[l-settings]: https://linear.app/changelog/2024-12-18-personalized-sidebar

<!-- Other -->
[xterm-opts]: https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
[vsc-a11y]: https://code.visualstudio.com/docs/configure/accessibility/accessibility
[superhuman]: https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/

Notes on sources
- Read through search-result summaries, not full page fetches: Linear's `[l-ctx]`, `[l-nav]`, `[l-shortcuts]` and `[l-settings]`, and Warp's `[w-changelog]` and `[w-cli]`. Third-party Linear shortcut lists disagree with each other, so no specific Linear letters are cited beyond `?` and `G`, `I`.
- Linear publishes no pixel values. Its entries here are principles only.
- Warp's toast timing is documented only as "a few seconds", so the Hopline durations in §4.3 are proposals.
- Zed keymap links point at `main`, which moves. The bindings were read on 2026-11-24.
