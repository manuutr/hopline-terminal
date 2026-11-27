# Development

## Setup

You need Node 24.11 or later and npm 11 (`packageManager` pins npm 11.6.2), and git. `better-sqlite3` and `serialport` ship N-API prebuilds that load in Node and Electron alike, so there is no native rebuild step and usually no compiler needed.

```sh
git clone https://github.com/manuutr/hopline-terminal.git
cd hopline-terminal
npm ci
```

The project npm configuration disables dependency install scripts. SQLite and serial bindings use their shipped prebuilds. The first desktop launch downloads the pinned Electron runtime. To fetch it ahead of time, run `node node_modules/electron/install.js` from the repository root.

The CI workflow defines checks for Ubuntu, Windows and macOS (`.github/workflows/ci.yml`).

### Linux

- Any recent distribution. For the keychain in development, a Secret Service provider (GNOME Keyring or KWallet) must be running; without one the vault is session-only until you set a master password, which is fine for development.
- e2e on a machine without a display: `xvfb-run --auto-servernum npm run e2e` (what CI does).
- Serial tests use a pseudo-terminal pair and need nothing extra. Using a real USB serial adapter needs membership of `dialout` (or `uucp` on Arch).
- WSLg uses software rendering by default. Set `HOPLINE_GPU=1` to run xterm with WebGL and GPU compositing. UI tiles are rasterized on the CPU in this mode.

### macOS

- git (the Xcode Command Line Tools provide it: `xcode-select --install`).
- The first `npm run dev` may ask for Local Network access on macOS 15 and later; the simulator runs on 127.0.0.1 and does not need it, real devices do.

### Windows

- Node from nodejs.org or `winget install OpenJS.NodeJS`. Use PowerShell or Git Bash.
- Use an x64 Node 24 installation for the Windows x64 build. Run `npm ci` at the repository root so the project npm configuration applies.

## Running the app

```sh
npm run dev
```

electron-vite builds main, preload and the session host, serves the renderer with hot reload, and starts Electron. Renderer changes reload in place; changes to main or the session host restart the app.

Development runs use a separate Hopline Development profile. To use a throwaway profile, set `HOPLINE_USER_DATA=/some/empty/folder` (ignored by packaged builds).

## The simulator

There are two ways to get devices:

- **In the development app:** the palette's **Open the simulator lab** starts the bundled lab in main: core-sw1 (IOS-XE, SSH and Telnet) and dist-eos1 (EOS), plus the FortiOS/PAN-OS VPN pair. Sign in with admin/admin. Nothing to install or start.
- **Standalone**, for other platforms and scenarios:

```sh
npm run sim                                                  # core-sw1 on 2201 (Telnet 2301), dist-eos1 on 2202 (Telnet 2302)
npm run sim -- --device junos,nxos --base 2210               # other platforms on sequential ports
npm run sim -- --scenario bgp-wrong-as                       # apply a fault scenario to every device
npm run sim -- topology                                      # the whole multi-vendor topology, with a port table
npm run sim -- list                                          # platforms and scenarios
```

The first run of a fresh development profile seeds a **Lab (simulator)** folder whose sessions point at the standalone default ports (2201, 2202, 2301).

### Capture the troubleshooting examples

Run `npm run docs:examples` on a desktop with Electron's system dependencies. Playwright opens the production bundle with disposable profiles, the synthetic DNS capture and loopback SSH devices. The BGP fleet investigation and change-review case also use a scripted local Ollama-compatible endpoint. The fleet capture checks that each router’s report quotes its own peer state and TCP authentication error. Each capture checks the device output or review state before writing a PNG to `docs/examples/`.

Read the cases alongside their screenshots in the [investigation index](../examples/). To refresh one case after building, pass its filename to `npx playwright test -c apps/desktop/e2e/capture/playwright.examples.config.ts`.

## Tests

```sh
npm run typecheck    # every package, the app and bench
npm test             # vitest over everything (vitest.config.mts); under a minute
npx vitest run packages/guard                  # one package
npx vitest run apps/desktop/test/executor.test.ts -t "echo"   # one file, one test name
```

The vitest suites are pure Node: they start simulators in-process, run main's services and the session host's tab code against them, and use the local fake model servers in `apps/desktop/test/fake-llm.ts`. They never open a window and never call a real API.

Tests that every change must keep green, and that tend to catch mistakes:

- `test/ipc-shapes.test.ts`: no IPC result ever carries a secret; strict inputs.
- `test/settings-registry.test.ts` and `test/docs-reference.test.ts`: every setting is in the registry, the Settings dialog and the generated guide page.
- `test/docs-links.test.ts`: every relative link and anchor in the Markdown docs resolves.
- `packages/cli-model/test/*` and `packages/guard/test/*`: classification of every platform's commands, including the deny-list and abbreviation expansion.
- `test/eval-baseline.test.ts`: the scripted eval baseline over the whole fault catalogue.

### End to end

```sh
npm run e2e                         # builds, then Playwright against an isolated build in apps/desktop/out-test
npm run e2e -w @hopline/desktop -- e2e/fleet.spec.ts          # one spec and its test fixture
npm run e2e -w @hopline/desktop -- -g "approval"              # by test name
```

e2e launches an isolated test build through `launchHopline` in `apps/desktop/e2e/fixtures.ts`, which sets:

- `HOPLINE_HIDDEN=1`: windows are never shown or focused. `HOPLINE_SHOW=1` shows them, for watching a run locally.
- `HOPLINE_E2E=1` (honoured by dev builds only): an in-memory keychain, an in-memory clipboard (`renderer/src/lib/clipboard.ts`), and Anthropic traffic sent to the test's local fake server. The fixture also replaces Electron's native dialogs and `shell.openExternal` with stubs before the first page loads.
- `HOPLINE_USER_DATA`: a fresh temporary profile per test.
- `HOPLINE_SEED_PORTS`: the seeded lab sessions point at the test's own simulators.
- `HOPLINE_POLICY=''`: no team policy from the machine leaks into a test.

Rules for e2e tests (reviewers check them):

- Never show a window, never read or write the real clipboard (use the fixture helpers), never open a native dialog (stub it through the e2e hooks), never call a real model API, never touch the network beyond 127.0.0.1.
- Use the `MOD` helper for shortcuts so the test runs on macOS too.
- Wait for an element or a state rather than a fixed delay.
- Locally there are no retries. CI retries once and reports the test as flaky; a flaky test is a bug.

### Documentation assets

- `npm run docs:examples` captures the [five worked examples](../examples/). The production desktop opens the sample PCAP and local SSH fixtures.
- `apps/desktop/e2e/capture/` also contains the operator-guide and design-review captures. Each uses its own Playwright configuration.
- `npm run docs:reference` regenerates the settings and shortcut reference.

### Benchmarks and soak

```sh
npm run bench                      # build, package a linux dir, run every bench, report and compare
node bench/run.mjs --grep latency  # one spec
npm run bench:compare              # compare the last results with bench/baseline.json
SOAK_MINUTES=30 npm run soak       # long run on the built app, hidden; writes bench/results/soak-*
```

Details, targets and the latest numbers are in [docs/PERFORMANCE.md](../PERFORMANCE.md). Commit `bench/results/<date>.json` and `.md` when a change moves the numbers.

### Evals

The scripted baseline runs in every `npm test` and is free. The live eval drives the real agents with a real model, so it **costs money** (or GPU time with Ollama) and only runs with an explicit opt-in:

```sh
HOPLINE_EVAL_LIVE=1 ANTHROPIC_API_KEY=… npm run eval
HOPLINE_EVAL_LIVE=1 HOPLINE_EVAL_CASES='^bgp-' HOPLINE_EVAL_MODE=single ANTHROPIC_API_KEY=… npm run eval
HOPLINE_EVAL_LIVE=1 HOPLINE_EVAL_PROVIDER=ollama HOPLINE_EVAL_OLLAMA_MODEL=qwen3:14b npm run eval
```

Without `HOPLINE_EVAL_LIVE=1` the live entry is skipped. Never put a live eval in CI or in a test that runs by default. Commit only the `eval/results/SUMMARY-*.md` file. Variables, grading and costs: [docs/EVALS.md](../EVALS.md).

## Building installers

```sh
npm run dist:linux -w @hopline/desktop       # AppImage
npm run dist:linux:all -w @hopline/desktop   # AppImage, deb and rpm
npm run dist:win -w @hopline/desktop         # NSIS installer (on Windows)
npm run dist:mac -w @hopline/desktop         # dmg and zip (on macOS)
```

Output goes to `apps/desktop/release/`. The release workflow can package a tag on enabled runners, and maintainers can also package it locally; see [RELEASING.md](../../RELEASING.md) and [SIGNING.md](../SIGNING.md).
