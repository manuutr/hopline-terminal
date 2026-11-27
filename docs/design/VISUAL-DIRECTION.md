# Visual direction (0.6)

Hopline is a terminal that network engineers keep open all day. The window should look like a well-made instrument: the terminal fills it, the chrome is quiet, and colour appears only when it means something. The reference for feel is a minimal, terminal-first window like Hyper. Nothing is copied from it: no name, logo, assets or layout measurements.

Tokens live in `apps/desktop/src/renderer/src/styles.css`. Components read only the semantic names (`bg-surface`, `text-fg-muted`, `border-line`), never raw hex. This document is the rulebook, and the CSS is the source of truth for values.

## Principles

1. **The terminal is the hero.** It runs edge to edge under the title bar, with no card, border or rounded corner around it. The only inset is 8 px of inner padding. Chrome is the same colour as the terminal, so the window reads as one surface.
2. **Chrome recedes.** The title bar holds the tabs. The sidebar is hidden while a tab is open and comes back with a shortcut. The status bar is 22 px of quiet text. Panels are separated by 1 px low-contrast lines or a single background step, never both.
3. **Colour means something.** There is one accent, a calm teal, for focus, selection and the active tab line. Red, amber and green mean danger, caution and healthy, and they are never used for decoration.
4. **Dense and aligned.** Rows are 28 to 32 px, labels align on one column, and every control has the same height (28 px). Information sits in rows, not in cards inside cards.
5. **Terse copy.** Copy is sentence case, says what happens, and has no marketing voice. For example: "No sessions. Press Ctrl+Shift+P to connect."
6. **Safety is never quiet.** Approve and reject, the typed hostname, risk labels, read-only state and "Platform unknown — AI commands blocked" stay the most prominent things on their surfaces. Restraint everywhere else is what makes them stand out.

## Tokens

### Colour

| Token | Dark | Light | Use |
|---|---|---|---|
| `canvas` / `term` | `#0d0e10` | `#fcfcfc` | Window, title bar, terminal, status bar |
| `surface` | `#121316` | `#f4f4f5` | Side panels (sessions, assistant), one step off the terminal |
| `raised` | `#1b1c20` | `#ffffff` | Inputs, code wells, hovered tabs |
| `overlay` | `#1d1e22` | `#ffffff` | Menus, palette, dialogs |
| `scrim` | black 50 % | ink 14 % | Behind modal dialogs and the palette |
| `fg` | `#e6e7ea` | `#17181b` | Primary text |
| `fg-muted` | `#a4a7ae` | `#4f535a` | Secondary text |
| `fg-subtle` | `#969aa3` | `#61656d` | Hints, metadata (still ≥ 4.5:1 on every surface, hovered, selected and accent-tinted rows included) |
| `line` | white 7 % | black 8 % | Hairlines |
| `accent` | `#5ec9b6` | `#0a6c60` | Focus, selection, active tab line, primary button |
| `ok` / `warn` / `danger` | `#62cb8c` / `#e3ad57` / `#f17a78` | `#17733f` / `#875700` / `#b42d33` | State only |

Every text token passes WCAG AA (4.5:1) on `canvas`, `surface` and `raised` in both themes. `apps/desktop/test/design-tokens.test.ts` enforces this.

### Type

- **UI:** Inter (bundled, `@fontsource-variable/inter`), so it renders the same on every OS. Use weights 400 and 500, and 600 only for dialog titles.
- **Mono:** JetBrains Mono (bundled), for the terminal, commands, hosts and code. It is never used as decoration for labels.
- **Scale:** 11 / 12 / 13 / 14 px (`text-2xs` / `xs` / `sm` / `base`). The UI body is 13 px. Dialog titles are 14 px semibold. There is no larger size.
- Section labels are sentence case at 12 px medium in `fg-muted`. Do not use uppercase or tracked-out labels.

### Spacing, size, radius

- Spacing uses a 4 px grid. Rows are 28 px dense or 32 px in lists. Controls are 28 px (`md`) or 24 px (`sm`).
- The title bar is 36 px and the status bar 22 px. The terminal's inner padding is 8 px.
- Radius is 4 px for controls, rows and menus (`rounded`, `rounded-md`) and 6 px for the palette and dialogs (`rounded-lg`). Nothing is larger: `rounded-xl` and `rounded-2xl` also resolve to 6 px.
- Shadows appear only on floating layers (menus, palette, dialogs): one neutral black shadow with an offset and blur, plus a 1 px line. There are no coloured shadows or glows.

### Motion

- Everything that moves takes 120 to 180 ms: fast is 120 ms, base 160 ms, slow 180 ms, with `cubic-bezier(0.2, 0, 0, 1)`. Exits take 120 ms, the short end of the range (0.7; they were 100 ms).
- Only panels, menus, the palette and dialogs animate. The terminal never animates. Hover colour changes may fade at 120 ms; nothing else moves.
- `prefers-reduced-motion` turns every animation and transition off: `none`, not a very short duration, and the terminal cursor stops blinking (`styles.css`, `terminal/theme.ts`). `e2e/motion.spec.ts` checks that opening the palette, a dialog, a menu and a panel runs no transition or animation. The Approve arming delay is a timer, so it still holds; only its progress bar stops drawing.

## Do and don't

| Do | Don't |
|---|---|
| Mark the active tab with fg text and a 2 px accent line on top | Use filled pills or coloured tab backgrounds |
| Give each tab a 6 px status dot; show the close × only on hover or keyboard focus | Put icons and badges on every tab |
| Show a session's colour as a short dash under its tab (bottom edge), never on the active marker | Tint whole tabs by session colour |
| Show a risk label as a small outlined word in its colour (`Badge` / `RiskLabel`) | Use big badges, filled pills or stacked badges |
| Keep safety surfaces loud: the approval card's danger/warn frame, the typed hostname, the read-only and "Platform unknown" indicators | Quieten safety UX along with everything else |
| Show AI messages as a transcript: a "You" or "Assistant" label, then text | Use chat bubbles, avatars or sparkles |
| Show commands as monospace rows | Put each command in its own card |
| Use one line icon set (lucide), 1.75 stroke, 14 px, only where it adds meaning | Use oversized icons, emoji, or icons in empty states |
| Write empty states as one line of text plus the shortcut | Use hero empty states with illustrations or centred marketing copy |
| Use settings with a left nav and aligned label/control rows | Use top tabs over a long scrolling form |
| Use 1 px hairlines or a background step | Use gradients, glassmorphism, neon or double borders |
| Put lists inside a dialog directly on the dialog, with hairline or row-hover rows. Only editors, terminals and output wells get a frame | Use boxed lists or a card per item inside a dialog |
| Size titled tabs to their label (min 96 px, max the plan's width) | Stretch a short tab to the maximum width |
| Use the `scrim` token behind modals (faint in light, deeper in dark) | Use a fixed black scrim, which turns the light theme grey |

## Terminal themes

- **Hopline** (default, follows the app theme) is tuned for `#0d0e10` and `#fcfcfc`. Every ANSI colour except black reaches at least 4.5:1 on its background. xterm's `minimumContrastRatio` covers dim text.
- **Graphite** is a softer, low-glare dark theme.
- The existing Midnight, Solarized Dark, Nord, Gruvbox Dark and Paper themes are kept. Their ids are stored in settings and must never be renamed.

## Window

- The window is frameless with tabs in the title bar.
  - **macOS:** native traffic lights (`titleBarStyle: 'hiddenInset'`), with the tab strip padded to clear them.
  - **Windows and Linux:** `frame: false` with Hopline's own minimise, maximise and close buttons at the right end of the title bar. Close calls `win.close()`, so the "Close N sessions?" confirmation still runs.
- Only empty title-bar space is a drag region. Tabs and buttons are `no-drag`.
