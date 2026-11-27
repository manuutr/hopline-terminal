# Adding a vendor platform

A platform is a device CLI Hopline understands well enough to classify commands, find prompts, detect the device and enter configuration safely. The 15 platforms today are listed in `PLATFORM_IDS` (`packages/cli-model/src/types.ts`). Huawei VRP is the most recent and the smallest complete example; read it alongside this page.

Work in this order. Each step has tests that fail until the next ones are done, which is the point: a platform that is half there must not be selectable.

## 0. Research first

Write `docs/research/cli-<vendor>-<os>.md` the way the others are written: prompts in each mode, the pager and how to answer it, error strings, how configuration is entered, committed and left, help (`?`) and completion behaviour, the commands that destroy or reboot, and transcripts in fenced blocks. Mark everything you could not check on real gear `[unverified]`. These transcripts become the simulator's golden tests.

## 1. The model: `packages/cli-model`

1. **Id.** Add the id to `PLATFORM_IDS` in `src/types.ts` (add a `PromptStyle` if the prompt shape is new).
2. **Profile.** Add a `PlatformProfile` in `src/profiles.ts` (or `profiles-cisco.ts` / `profiles-tier2.ts`): label, vendor, modes with their prompt regexes and levels, the pager, error patterns, the line-clear key, `configInheritsExec` if configuration mode also runs exec commands, and the `fingerprint` signals (SSH version string, banner, prompt and `show version` patterns; shared ones are in `src/fingerprints.ts`).
3. **Command trees.** Add `src/trees/<id>.ts` and register it in `src/trees/index.ts`. Entries use the DSL in `src/dsl.ts`:
   - `R(spec)` read, `C(spec)` config, `D(spec)` disruptive, `B(spec, help, { reason })` blocked, `N(...)` a container.
   - Specs use `{a|b}` alternatives, `[optional]`, `<param>` and `...` (any further words).
   - **Only list a command as `R` if it is read-only in every form**, including every argument `...` allows. If one form writes (a `to-file`, a `clear`, a `save`), carve it out with a more specific `C`, `D` or `B` entry.
   - **The deny-list** is the `B` entries of the exec tree: reboot, erase, format, delete, file copy and move, image install and upgrade, licence changes, shells and nested `telnet`/`ssh`, and anything that replaces the whole configuration. Copy the shape of `BLOCKED_HEADS` in `trees/ios.ts` or the head list in `trees/vrp.ts`.
   - The `pipe` tree holds the output filters. Only read-only filters; redirects and file writes are `B`.
   - Anything the tree does not know is refused, so a missing read is an annoyance, a wrong read is a security bug.
4. **Configuration wrapper.** Add an entry to `CONFIG_SESSIONS` in `src/config-session.ts`: how to enter and leave configuration, how to commit on two-stage platforms, and the patterns that say a commit failed.
5. **Safety net (optional).** If the platform has a timed rollback or checkpoint (commit confirmed, a session timer, a checkpoint, an archive), add a `SafetyNetSpec` to `SAFETY_NETS` in `src/safety-net.ts`. Every line is a fixed template; the only variables are the `hopline-<8 hex>` name, an integer of minutes in `NET_MINUTES`, and device-reported file names that match a strict regex. The session host accepts a `net` line only when it matches one of these templates, so keep them exact. Without an entry, the proposal's own rollback lines are the undo.
6. **Detection.** `src/identify.ts` scores the profile's fingerprint signals; `src/detect.ts` finds the mode from the prompt (add a `case` there if the prompt needs special handling). Detection decides which tree the guard uses, so a false positive is dangerous: prefer "unknown" over a guess.
7. **The rest:** `BACKUP_COMMANDS` in `src/backup.ts` (the read that shows the running configuration), and `src/equivalents.ts` (the platform's version of common reads, used by fleet investigations).

Tests: `packages/cli-model/test/` runs every platform through `PLATFORM_IDS`. Add cases for your platform in `resolve.test.ts` (reads, configs, blocked heads, abbreviations that could expand to a blocked command), `identify.test.ts` and `detect.test.ts` (real banners and prompts from your research), `config-session.test.ts`, and `safety-net.test.ts` if you added a net.

## 2. The guard: `packages/guard`

- Add the label and vendor to `PLATFORM_LABELS` and `PLATFORM_VENDORS` in `src/platforms.ts`. `test/platforms.test.ts` checks they match the profile.
- If the platform has secret formats the redactor does not know (`src/redact.ts`), add patterns and corpus cases in `test/redact-corpus.test.ts`. A secret that reaches a model is a security bug.
- Add attack lines to the red-team corpus (`test/redteam/corpus.ts`): abbreviations, pipes, separators and wrappers that must stay blocked.

## 3. The simulator: `packages/simulator`

Every platform must have a simulated device, so e2e, evals and the user's lab exercise it.

1. **Personality.** Add `src/vendors/<id>/` implementing `Personality` (`src/core/personality.ts`): prompts, parsing with `core/tree.ts`, errors, `?` help, Tab completion, control keys, the pager, confirm prompts and unsolicited log lines. Render output from the device state (`src/state.ts`), never canned text, so scenarios change what every command shows. Register the factory in `src/vendors/index.ts`.
2. **Device.** Add `src/devices/<id>.ts` (a default device: hostname, interfaces, neighbours, routes) and register it in `src/devices/index.ts`. Add the id to `SimPlatform`.
3. **Golden transcripts.** Add fixtures under `test/golden/<id>/`, lifted verbatim from your research doc, and list them in the manifest. `test/golden.test.ts` replays them and diffs the transcript.
4. **Unit tests:** `test/<id>.test.ts` for prompts, modes, the pager, confirms and errors.
5. **Scenarios.** Make the fault scenarios in `src/scenarios/` render on the new platform where the feature exists (BGP, OSPF, interfaces, ACLs), and add the platform to the topology in `src/topology.ts` if it fits.

## 4. Parsers: `packages/parsers`

- Map the platform to its ntc-templates platform name(s) in `src/platforms.ts` (for example `vrp: ['huawei_vrp']`).
- If ntc-templates has templates for it, they are already bundled; `test/simulator.test.ts` parses the simulator's output for each mapped command, so the simulated output must match what the templates expect.

## 5. The app: `apps/desktop`

- `src/renderer/src/lib/platforms.tsx`: the short label in the status bar and the platform picker.
- `src/shared/cli.ts`: prompt-hostname binding rules if the prompt carries more than the hostname or a factory default name.
- `src/shared/policy-deny.ts`: `CONFIG_DUMPS`, the commands that print the whole configuration, so a team policy that blocks `show running-config` also blocks the platform's other ways to print it.
- `packages/importers/src/platform.ts`: names other tools and inventories use for the platform (NetBox slugs, SecureCRT and CSV values).

App tests that sweep every platform: `test/p4fx-routing-sweep.test.ts` (every runnable line of every tree, full and abbreviated, routed the same way by main and the session host), `test/executor-platforms.test.ts` (the executor against the simulated device), `test/autocomplete.test.ts`, `test/config-apply.test.ts` (a change applied and rolled back on the simulator), and the eval baseline if you add catalogue cases in `test/eval/catalogue.ts`.

## Checklist

- [ ] Research doc with transcripts
- [ ] `PLATFORM_IDS`, profile, trees with the deny-list and pipe tree, `CONFIG_SESSIONS`, optional `SAFETY_NETS`
- [ ] Fingerprint signals, detect; backup command; equivalents
- [ ] Guard labels; redaction patterns; red-team lines
- [ ] Simulator personality, device, golden transcripts, unit tests, scenarios
- [ ] Parser platform mapping
- [ ] App label, binding rules, `CONFIG_DUMPS`, importer names
- [ ] `npm run typecheck`, `npm test`, `npm run e2e` green
- [ ] The user guide's platform lists ([connections](../guide/connections.md), [autocomplete](../guide/autocomplete.md)) and the README updated
