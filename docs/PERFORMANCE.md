# Performance

How Hopline is measured, what it costs today, and the targets it is held to. Phase 8 (0.7.0) built
the benchmark suite and the soak test and fixed the worst offenders they found.

## Running it

```sh
npm run bench                      # build, package (linux dir), run every bench, report + compare
node bench/run.mjs --no-build --no-package   # reuse apps/desktop/out and release/linux-unpacked
node bench/run.mjs --grep latency  # one spec
node bench/run.mjs --label after   # results/<date>-after.json
npm run bench:compare -- [cur.json] [base.json] [--threshold 15]
SOAK_MINUTES=30 npm run soak       # soak test (default 30 min, 10 tabs)
```

Everything runs hidden and leaves the desktop alone:

- `HOPLINE_HIDDEN=1` puts the window off screen, unfocusable, with background throttling off, so
  frames still render at full rate. The packaged app honours it too, but only for window placement.
- `HOPLINE_E2E=1` (test mode) gives an in-memory clipboard and keychain. No native dialogs are ever
  opened: every prompt the suites hit is an in-app dialog.
- Each launch gets a throwaway profile. The packaged build ignores `HOPLINE_USER_DATA`, so the
  startup bench isolates it with `XDG_CONFIG_HOME`.
- The startup bench packages its own `--dir` build **without Electron fuses**
  (`HOPLINE_UNFUSED_BENCH_BUILD=1`, refused in CI and with signing credentials): Playwright attaches
  over `--inspect`, which the release fuses turn off (RELEASING.md › Smoke test and fuses). Never ship
  `release/*-unpacked` from `npm run bench`; the dist scripts rebuild it fused.
- The devices are the bundled simulator (IOS, EOS over SSH, and Telnet). Started with `bench: true`
  it has `bench flood <MB> [plain|ansi|debug]` and `bench lines <N> [kind]`, written in 64 KB
  slices that honour backpressure. It also has fault injection (`faults.drop()`, `stall(ms)` and
  `refuse(ms)`) for the soak.

Results go to `bench/results/<date>[-label].json` (git sha, machine, load average, every run) and to
a `.md` table with targets marked. `bench/baseline.json` is the reference: `compare.mjs` flags any
metric more than 15% worse than it and exits 1. Info-only metrics (cold parses, the stages inside
main, fill rates) are shown but never flagged.

### What each spec measures

| Spec | Method |
| --- | --- |
| startup | Packaged `release/linux-unpacked/hopline` and the dev build, 5 runs each. For each: a first launch on a fresh profile, then a returning launch. Times spawn → first paint (`ready-to-show`), → `hopline:ready` (settings loaded, first frame), → Ctrl+K palette visible. |
| throughput | One tab runs `bench flood`: plain 50 MB, ANSI-heavy 20 MB (256-colour, truecolour, bold/underline/inverse) and 20 MB of debug lines, each 3 times, on WebGL (`HOPLINE_GPU=1`) and DOM. Bytes/s counted in the page; a rAF recorder gives frame p50/p95/p99 and dropped frames; `longtask` and `long-animation-frame` observers give the long tasks. |
| scroll | Scrollback 110k, filled with `bench lines 100000`, then 400 frames of fling (60 lines per frame) and 400 random jumps. With `BENCH_SCROLL_TABS=10` the harness verifies ten live sessions, toggles the assistant and palette four times, and reports the first cycle separately. The WebGL first-cycle target is a 17 ms p95 frame interval. The benchmark also records the terminal’s graphics adapter and Chromium rasterization mode. |
| memory | Idle, then 20 tabs × `bench lines 10000 ansi`. RSS per process from `app.getAppMetrics()` (main, renderer, session host, GPU) plus the JS heap. Then the periodic scrollback save is fired on every tab, and the bench records the long tasks, worst frame, longest single task and main's event-loop delay. |
| latency | Capture-phase keydown → the echo parsed by xterm → the next frame painted, 40 keys. Split into recv (echo at the renderer) and parsed. Idle, and while another tab floods. |
| hot paths | Min of 15 runs: redaction of a 1 MB config, `cleanTerminalText` on 1 MB (ANSI and plain), TextFSM on simulator outputs (warm, cold first parse as info, a 4000-row table), guard classify µs per command (IOS and EOS). |
| selfcheck | The recorder sees a forced long task and rAF runs at ~16.7 ms (catches a throttled window). |

## Numbers

Linux under WSL2, i9-14900K (32 threads), 31 GB. This is a shared machine: load average 2–8 during
the runs. Baseline = `811f5da`: the suite on 0.7.0-dev with no fixes. After = `5f8d53c` (before the Phase 7 merge; startup rows also after it). Both are
the best of the repeated runs (see Noise).

| Metric | Target | Baseline | After |
| --- | --- | ---: | ---: |
| **Startup (packaged)** first launch → palette | ≤ 1500 ms | 452 ms | 458 ms → 545 ms ³ |
| returning → first paint | ≤ 1000 ms | 309 ms | 313 ms → 389 ms ³ |
| returning → palette | ≤ 1500 ms | 440 ms | 435 ms → 482 ms ³ |
| **Flood** WebGL plain | ≥ 20 MB/s | 54.9 MB/s | 55.8 MB/s |
| WebGL ANSI | ≥ 10 MB/s | 43.2 MB/s | 45.1 MB/s |
| WebGL debug | | 63.8 MB/s | 62.3 MB/s |
| DOM plain | ≥ 10 MB/s | 52.8 MB/s | 54.9 MB/s |
| DOM ANSI | | 34.6 MB/s | 34.0 MB/s |
| WebGL plain frame p95 / long tasks | ≤ 33.4 ms / 0 | 16.7 ms / 0 | 16.8 ms / 0 |
| WebGL ANSI frame p95 | ≤ 33.4 ms | 16.8 ms | 33.4 ms ¹ |
| **Scroll** 100k lines, fling p95 WebGL / DOM | ≤ 20 / 33.4 ms | 16.8 / 16.8 ms | 16.8 / 16.8 ms |
| jump p95 WebGL / DOM | ≤ 20 ms | 16.8 / 16.8 ms | 16.8 / 16.8 ms |
| **Latency** key → echo idle p50 WebGL | | 59.7 ms | **8.9 ms** |
| idle p95 WebGL / DOM | ≤ 50 ms | 61.0 / 61.1 ms | **26.3 / 27.5 ms** |
| another tab flooding p95 WebGL | ≤ 50 ms | 107 ms | **56.6 ms** (missed) |
| another tab flooding p95 DOM | | 108 ms | 79.5 ms |
| **Memory** 20 tabs × 10k lines total RSS | ≤ 1500 MB | 2293 MB | **1778 MB** (missed) |
| GPU process | | 610 MB | **290 MB** |
| renderer | | 1226 MB | 1043 MB |
| session host | ≤ 200 MB | 168 MB | 160 MB |
| main | | 206 MB | 203 MB |
| live WebGL contexts (20 tabs) | | 16, 4 lost | 1 |
| scrollback save of 20 tabs, longest task | | 803 ms ² | **118 ms** |
| worst frame | ≤ 50 ms | 100 ms | 117 ms (missed) |
| main event-loop delay | | 17.5 ms ² | 9.6 ms |
| **Hot paths** redact 1 MB | ≤ 50 ms | 7.2 ms | 8.0 ms |
| cleanTerminalText 1 MB ANSI | ≤ 50 ms | 15.9 ms | 17.5 ms |
| TextFSM `show interfaces` / 4000-row brief | | 0.47 / 3.0 ms | 0.45 / 3.3 ms |
| guard classify per command IOS / EOS | ≤ 50 µs | 2.4 / 2.1 µs | 2.6 / 2.6 µs |

¹ The ANSI flood finishes in ~0.5 s, about 30 frames, so two slow frames move p95 a whole frame.
An A/B on the same box minutes apart gave 16.8 to 50 ms on the baseline code as well. It is noise,
not a change.
² Measured on the baseline save path with the later bench method (8 s window and the extra
metrics), just before each fix landed.

³ After merging Phase 7 (`b8c577d`: electron-updater, Sentry, the first-run privacy screen,
crashpad), with the lazy updater fix below. Main reached `whenReady` about 50 ms later and the first
launch now shows the privacy screen, which the bench dismisses with Escape. Results:
`2026-11-25-startup-merged` (merge only) and `-startup-lazy`.

Full tables: `bench/results/2026-11-25-baseline.md`, `-noise.md` and `-after.md`.

### Redaction after 0.8.0

On the 1 MB config fixture, three runs at `df47ee9` took 11.45–11.57 ms. Sharing the private-key
marker check and avoiding string cleanup for ordinary secret values brought that to 9.88–10.34 ms on
the same machine. Both versions produced identical output and counted 7,467 replacements. The
benchmark takes the fastest of 15 warmed measurements in each run. [Hot-path benchmark](../bench/specs/hotpaths.bench.ts).

## Fixes (Phase 8)

| Fix | Before | After |
| --- | --- | --- |
| **TCP_NODELAY on SSH** (`packages/transports/src/ssh.ts`). ssh2 leaves Nagle on, so together with delayed ACKs every echo waited about 35 ms. A raw ssh2 round trip to the simulator is 0.3 ms. | key → echo p50 59.7 ms | 25.5 ms |
| **Host sends the first chunk after a quiet spell at once** (`session-host/tab.ts`). Output was always held up to 8 ms to coalesce; bursts still are. | echo at renderer 9.5 ms; on screen p50 25.5 ms | 2.7 ms; 8.9 ms (WebGL) |
| **WebGL only while a terminal is visible** (`TerminalView.tsx`). A hidden tab drops its WebGL renderer after 5 s and reloads it when shown. Before, the 17th tab cost the oldest one its context (Chromium's limit is 16) and every hidden tab kept a glyph atlas. | GPU 610 MB, total 2293 MB, 4 contexts lost | GPU 290 MB, total 1778 MB, none lost |
| **Async gzip for saved scrollback** (`main/store/scrollback.ts`). `gzipSync` of megabytes ran on main. | main loop delay max 17.5 ms | 7.6–12 ms |
| **Staggered scrollback saves** (`renderer/lib/save-queue.ts`). The 30 s saves of tabs opened together all fired in one task. Now there is one per idle period, and a tab that is receiving output is put off for up to 30 s. | longest task 803 ms | 118–128 ms |
| **electron-updater loaded on the first check** (`main/privacy.ts`). Phase 7 required it at startup. | main whenReady 244 / 238 ms | 226 / 212 ms (first / returning) |
| **Block detector race** (`renderer/lib/blocks.ts`). A key in the quiet window after a prompt was read as a redraw and the block was dropped. The view now tells the tracker what was sent; a re-check after xterm parses keeps the block when a line was entered since. Unit tests in `test/blocks-race.test.ts`; e2e in `e2e/blocks.spec.ts` types right after a prompt. | 4 of 7 race cases dropped a block | 0 |

Looked at and left alone, because they measured fine:

- IPC batching and xterm write coalescing: floods run at 45–64 MB/s with no long tasks, and flow
  control holds.
- Renderer re-renders during floods: no long animation frames.
- Startup: about 450–550 ms to an interactive palette, against 1.5 s. `@sentry/core` is still
  required at startup (about 27 ms in plain Node). Loading it only when crash reports are on is
  the next startup step.

## Targets missed

- **Latency while another tab floods** (p95 56.6 ms WebGL, 79.5 ms DOM, target 50). The flooding
  tab's parsing shares the renderer thread. The p50 (45 ms) is now under target. Next step: cap how
  much xterm parses per frame for background tabs.
- **Memory, 20 tabs × 10k lines** (1778 MB, target 1500). The renderer holds about 50 MB per tab
  for xterm buffers with ANSI attributes. Next step: a lower default scrollback for background
  tabs, or trimming hidden buffers.
- **Worst frame during a scrollback save** (117 ms, target 50). One save is one synchronous
  `SerializeAddon.serialize` of 5000 lines, about 60–120 ms. Next step: serialize in row ranges
  across idle periods, or only the rows added since the last save.

## Noise

On this shared box an unchanged rerun (`2026-11-25-noise`, same binaries) still moved some metrics
by 15–25%: startup paint and the debug floods. Interference only ever makes a run slower, so:

- `report.mjs` keeps the best run of the repeats (5 startup runs, 3 flood runs). The median is
  kept in the json.
- Hot paths take the minimum of 15 runs.
- `compare.mjs` has noise floors per unit (2 ms, 3 counts, 5 %, 25 MB, 1 MB/s, 1 µs) below which a
  change is never flagged.
- Each metric records `load1`. Compare results only from runs with similar load, and on a quiet
  machine where you can.

Treat a single flagged flood or startup metric as a reason to rerun, not as a regression. A metric
flagged in two runs is real.

## Soak

`bench/specs/soak.soak.ts` opens `SOAK_TABS` (default 10) tabs on the IOS and EOS simulators, with
keep-alive at 2 s, auto-reconnect on and a 2000-line scrollback, so history fills during warm-up
and later growth is a leak. It then cycles through these faults:

- drop every connection
- interface flap with `%LINK-3-UPDOWN` syslog
- an SSH disconnect
- a 3000-line ANSI burst on every tab
- a 15 s TCP stall (the keep-alive must notice it)
- tab churn: close one tab and open one
- a "reboot": drop, then refuse connections for 12 s

After every fault, every tab must be connected again within 60 s and answer Enter with a fresh
prompt. A tab that does not is stuck. Renderer or child-process crashes are recorded from main.
RSS is sampled after each cycle, and a linear fit after the first 20% must stay under 20 MB/h for
main, 40 MB/h for the renderer and 20 MB/h for the session host.

Result: 30.3 min, 10 tabs, after the Phase 7 merge (`1ca910b`), in `bench/results/soak-2026-11-25-30min.md`.

- **Passed.** No crashes and no stuck tabs.
- 103 fault cycles: drop × 13, flap × 25, disconnect × 13, burst × 13, stall × 13, churn × 13, reboot × 13.
- The renderer saw 910 reconnecting, 348 connected and 23 connecting state changes.

| Process | first MB | last MB | max MB | slope MB/h | limit |
| --- | ---: | ---: | ---: | ---: | ---: |
| main | 211.7 | 196.2 | 214.9 | −16.0 | 20 |
| renderer | 399.3 | 334.6 | 418.6 | −18.6 | 40 |
| session host | 126.4 | 134.7 | 152.6 | −3.7 | 20 |

The first full run found a bug in the harness, not the app. With a 2000-line scrollback the cursor's absolute row stops moving once the buffer is full, so every tab read as stuck. `answers()` now counts line feeds.

For 24 hours: `SOAK_MINUTES=1440 npm run soak` on a machine left alone (it is hidden, but keeps
one core busy in bursts). Results land in `bench/results/soak-<date>-1440min.{json,md}`. The
Playwright timeout scales with `SOAK_MINUTES`.
