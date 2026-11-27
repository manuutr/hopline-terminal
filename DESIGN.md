# Hopline workspace design

Hopline is an Electron desktop terminal for network engineers. The working surface is xterm.js 6 with WebGL and a DOM fallback. React and Zustand own the session tree, workspace splits and docked assistant. Tailwind maps CSS custom properties to renderer utilities. Radix, cmdk, Sonner and resizable panels supply the existing interaction primitives. Inter and JetBrains Mono ship locally.

## Design decisions and phase order

1. **Foundation.** Keep Hopline’s signal teal for focus and selection. Use five quiet elevation steps, solid readable text and translucent shadows. Offer dark, light, system and high contrast. Use 4 px spacing, 4/6/8/12 px radii, tabular numerals and 16 px line icons. Standardize feedback, navigation and large surfaces at 120, 200 and 320 ms. OS and application reduced motion take priority. [Geist colors](https://vercel.com/geist/colors) · [Tailwind durations](https://tailwindcss.com/docs/transition-duration)
2. **Terminal output.** Keep the device transcript selectable. Give wide device output its own horizontal viewport. Keep raw output available alongside semantic colors. Put timestamp, copy, rerun, attachment and error actions on the associated command. Mark restored history at its buffer position. Keep the reader’s position during incoming output. [Warp blocks](https://docs.warp.dev/terminal/blocks)
3. **Liveness.** Derive state, activity, timing and alerts from transport events. Give each connection state a distinct shape. Keep retries and urgent syslog lines local to the affected pane. Show an unavailable RTT when no measurement exists. [Upstash metrics](https://upstash.com/docs/redis/howto/metrics-and-charts)
4. **Workspace.** Preserve device names and their distinguishing suffixes. Use a moving selection rail, vendor pills and matched text in the sidebar. Surface recency, onboarding progress and drop positions where they help choose a device. Keep a mounted terminal across splits, moves and tab changes. Snap dividers to useful proportions. [Zed workspace](https://zed.dev/features) · [Linear search](https://linear.app/docs/search)
5. **Commands.** Search commands, sessions, command history and settings together. Keep group names and shortcuts visible. Use one menu surface, keyboard highlight and focus-return pattern. Quick Connect recalls endpoints and reflects the result of the connection. [Raycast action panel](https://manual.raycast.com/action-panel)
6. **Assistant.** Derive suggestions from the focused transcript. Keep the scope, attached lines and read-only state visible beside the composer. Stream text in place and keep configuration proposals in the existing explicit approval flow. [Warp block actions](https://docs.warp.dev/terminal/blocks)
7. **Feedback.** Make the focused connection, platform, encoding, measured latency, model and permissions inspectable from the status bar. Bind retry and edit to the failed device. Keep toast stacks bounded, loading placeholders delayed and empty-state actions local. [Geist colors](https://vercel.com/geist/colors)
8. **Performance and access.** Measure spawn to a usable palette on the same machine before and after. Exercise 100,000 lines and ten concurrent sessions, inspect frame timing, check all themes, keyboard focus and reduced motion. Use the simulator and isolated Electron profiles for screenshots.

## Review evidence

Capture interactions against isolated development fixtures. The user guide keeps the images used in its walkthroughs. [Capture instructions](docs/contributing/development.md#screenshots-and-the-demo)

## Microinteractions in 1.0

A single teal indicator travels between device tabs, leaving a soft edge beneath the selected tab. Segmented choices use the same movement. Switch thumbs briefly compress on press, a narrow band crosses loading rows, and notification icons settle as the toast arrives. Swiping a notification dismisses it. The indicator moves with a 200 ms transform, and reduced motion shows the destination immediately. These are original Hopline controls informed by the motion study. [Guanmo’s UI Moments reference](https://x.com/guanmo_ai/status/2125922208421978615)
