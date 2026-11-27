# Accessibility

Hopline aims at WCAG 2.2 AA. This page says what is supported, how to use it, and how it is tested. Shortcuts use **Mod** for Ctrl+Shift on Windows and Linux and ⌘ on macOS (see Settings → Keyboard), except where a key is written in full.

## Screen readers

### Screen reader mode

Turn it on in **Settings → Terminal → Screen reader mode**, or run **Turn on screen reader mode** from the command palette (Mod+K, then type `>screen reader`).

When the operating system reports a screen reader (NVDA, JAWS, Narrator, VoiceOver or Orca, through Electron's `accessibilitySupportEnabled`), Hopline offers the mode once with a "Screen reader detected" notice. It never turns the mode on by itself. Your answer is remembered, and the setting can be changed at any time.

With the mode on:

- The terminal exposes its rows to assistive technology (xterm's screen reader mode), so you can read the screen with your reader's review commands.
- New output from the **active tab** is read aloud through one polite live region. The reader speaks it when it is idle and does not interrupt you.
- Announcements are throttled to **at most one a second**. A command's whole answer, plus the prompt that follows it, is read as one announcement.
- Output of more than 8 lines or 500 characters is **summarised** instead of read in full, for example "1,204 lines of output. Last: interface Gi1/0/48 core-sw1#". Use the buffer view to read it.
- What you type is not echoed back by Hopline (your reader already echoes keys). The prompt line is spoken only together with new output.
- Background tabs are silent. Switch tabs to hear one.

xterm's own live region (assertive and unthrottled) is muted, so nothing is announced twice.

### Accessible buffer view

Press **Mod+Alt+B**, or run **Open terminal text (accessible buffer view)** from the palette. The scrollback of the active tab opens as plain text in a read-only text area. Screen readers read a text area line by line, word by word and character by character, which a terminal canvas cannot offer.

| Key | Action |
|---|---|
| Arrows, Page Up/Down, Ctrl+Home/End | Move through the text (it opens at the end, on the latest output) |
| Alt+Up / Alt+Down | Jump to the previous or next command. The prompt line is selected and the status line says "Command 3 of 7: show version" |
| Shift+arrows | Select a range |
| Ctrl+C (⌘C) | Copy the selection |
| **Copy command output** button | Copy the output of the command at the cursor, without its prompt line |
| Find field, Enter / Shift+Enter | Next or previous match, with "2 of 14" in the status line |
| Esc | Close. The keyboard goes back to the terminal |

**Redaction.** Copying from the buffer view follows the same terms as copying from the terminal: the same text, through the same clipboard path. Today the terminal copies the text exactly as the device printed it and the screen shows it. The buffer view shows nothing the terminal does not. Secrets that a device never echoes, such as typed passwords, are not in either. If terminal copy ever gains redaction, the buffer view uses it too because it shares the path. Text sent to the assistant is still redacted in main before any provider sees it.

The view is a snapshot taken when it opens. Close and reopen it to see newer output.

## Keyboard

Everything can be done without a mouse.

- **Command palette (Mod+K).** Every action is listed, including the ones that have no shortcut. Settings → Keyboard rebinds keys, and the shortcut sheet (Mod+/) lists them.
- **Moving between areas: F6 / Shift+F6.** Focus cycles through the tab bar, the session sidebar (when open), the terminal, the files panel (when open) and the assistant (when open). The terminal keeps **Tab** for the device's command completion, so F6 is how the keyboard leaves the terminal and comes back to it. Mod+B and Mod+I open the sidebar and the assistant.
- **Tabs.** In the tab bar, Left/Right move between tabs, Enter or Space activates one, and **Delete** closes the focused tab (with the usual confirmation). Mod+W closes the active pane from anywhere.
- **Dialogs.** Focus moves into a dialog when it opens and stays inside it. Esc closes it, and focus returns to where it was. If that element is gone, as with a dialog opened from the palette, focus goes to the terminal of the focused pane. Focus never lands on the page body.
- **Lists.** Trees, listboxes and tab lists use one Tab stop and arrow keys (roving focus).
- **Device @-mentions.** Typing `@` after `@ai ` in the terminal, or in the assistant's composer, opens a list of saved sessions. Up/Down choose, Tab or Enter insert the name, and Esc closes the list without leaving the line or the composer. When the typed text is already a whole name, Enter sends the question. The composer marks the list with `aria-autocomplete` and `aria-activedescendant`. In the terminal the list is visual only: the name is typed into the line, so a screen reader reads it as typed text. The fleet view that opens puts the focus on its start button, or on the first fix when a mention needs one. A held Enter does not start the run.
- **Window buttons** (minimise, maximise, close on Windows and Linux) are mouse-only. Use the OS shortcuts (Alt+F4, Super+arrows).

### Resizable dividers

Each divider is a focusable separator: the session sidebar, the assistant, the files panel, the dividers between split panes, and the fleet view's answer column. Each one has a name ("Resize session sidebar") and reports its position as `aria-valuenow`, which is the size of the area before it, in percent.

| Key | Action |
|---|---|
| Left/Right (Up/Down for a horizontal divider) | Move the divider 16 px |
| Shift + arrow | Move it 96 px |
| Home / End | Move it to its start or end. A collapsible panel at that end collapses: Home on the sidebar's divider, End on the assistant's and the files panel's |
| Enter | Collapse or restore the divider's panel (sidebar, assistant, files) |

A collapsed panel's divider stays in the Tab order, so the keyboard can bring the panel back. Sizes are remembered per machine: side panel widths and heights in local storage, and split pane sizes in the layout. Settings → Appearance → Panel sizes puts the side panels back to their defaults.

## Visual

- **Contrast.** All text is at least 4.5:1 against what it is drawn on, in dark, light and high contrast. That covers hovered, selected and accent- or status-tinted rows, disabled controls (shown in `fg-subtle`, never faded with opacity), and buttons at rest, hovered and pressed. The terminal raises any cell below 4.5:1 in every theme (xterm `minimumContrastRatio`). That covers dim (SGR 2) text, colours a device chooses, selected text, and custom or imported themes. The theme generator searches every text and ANSI colour to 4.5:1 and shows the result as AA rows.
- **Focus.** Every interactive element shows focus. Most use a 2 px ring in the accent colour. Fields use an accent border or underline. Rows in lists use an inset accent edge. The terminal shows its focused cursor.
- **Targets.** Small controls have a 24 × 24 px target even when the drawn mark is smaller.
- **Motion.** The system motion preference and the Reduce motion setting in Appearance both turn off animations and transitions.
- **Colour is never the only signal.** Risk labels are words, the focused pane has an edge and a corner notch, and status dots have text labels.

## How it is tested

| Test | What it checks |
|---|---|
| `apps/desktop/e2e/a11y-axe.spec.ts` | axe-core (`@axe-core/playwright`, WCAG 2.0–2.2 A/AA plus best practices) in dark, light and high contrast. Surfaces include the empty state, palette, each settings section, session dialog, known hosts, audit log, connected tab, sidebar, splits, files, backups, multi-run, AI setup, empty and with a proposal, egress dialog, fleet scope and run, the buffer view, the first-run steps (privacy, import, add host, connect), the getting started checklist, settings search (with and without matches), the folder and session overrides dialogs, connection details, Quick Connect history and completed assistant code. Serious and critical findings fail the test. Results are written to `test-results/axe-report.jsonl`. |
| `apps/desktop/e2e/a11y-keyboard.spec.ts` | A Tab walk of the window, palette, settings, session dialog and audit log. Every stop must show a visible indicator, focus must never be on the body, it must stay inside dialogs and return after them. Also checks F6/Shift+F6 and Delete on a tab. |
| `apps/desktop/e2e/a11y-dividers.spec.ts` | Arrows, Shift+arrows, Home/End and Enter on the sidebar, assistant, pane and files dividers, and that sizes survive a reload or a zoom. |
| `apps/desktop/e2e/a11y-screen-reader.spec.ts` | The offer (with a faked screen reader, `HOPLINE_E2E_SCREEN_READER=1`, dev builds only), polite and throttled announcements, the flood summary, the muted xterm live region, and the buffer view (jump, find, copying a range and a block, focus return). |
| `apps/desktop/test/a11y-contrast.test.ts` and `design-tokens.test.ts` | Every text/background token pair, including composited states, and that no text in the renderer is faded with opacity or an alpha modifier on a text token. |
| `apps/desktop/test/a11y-announce.test.ts`, `divider.test.ts` | The announcement throttle and summary, buffer text mapping, and the divider key model. |

### axe allow-list

`apps/desktop/e2e/support/axe.ts` holds the allow-list. Each entry is scoped to one rule on one part of the page, never a rule turned off everywhere. **It is empty today:** no serious or critical finding needed an exception. The xterm canvas does not trigger any rule, because axe does not read canvas pixels. Contrast inside the terminal is enforced by `minimumContrastRatio` instead, and checked by the unit tests.

Moderate findings were fixed with landmarks and a heading, except two that stay as moderate (they do not fail the run):

- `region` on the sidebar and assistant dividers. A window splitter sits between two landmarks by nature, and moving it into one of them would make it part of that panel.
- `heading-order` in the assistant's setup form (an `h3` under the window's `h1`).

## Known gaps

- **Monaco diff (backups).** axe passes, but Monaco's own screen reader support (its accessible diff viewer, F7) has not been tuned or tested with a real reader.
- **Real screen readers.** Testing is automated: axe, a faked OS signal and live-region recording. NVDA, VoiceOver and Orca still need a manual pass.
- **Background tabs** are never announced. A busy background session is only noticed when you switch to it, or through the tab's status dot and its text label.
- **The window buttons** are mouse-only, as described under Keyboard.
