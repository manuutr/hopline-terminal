# Contributing to Hopline Terminal

A good contribution starts with a network question and the smallest example that answers it. If Hopline Terminal misses a table, share a synthetic command and a few rows with the original spacing. If it misclassifies a command, include the platform, CLI mode and the decision you expected. You can work entirely against the development simulator.

- **Improve what the assistant sees.** Parser fixtures and tests live in [packages/parsers](packages/parsers). Include the evidence a reader needs to distinguish two plausible causes.
- **Protect an identifier.** Add a synthetic hostname or customer description to the [network privacy tests](apps/desktop/test/network-privacy.test.ts) and check the [provider request tests](apps/desktop/test/egress.test.ts).
- **Teach Hopline Terminal a platform.** Start with one supported command and a captured shape of its output. [Platform walkthrough](docs/contributing/adding-a-platform.md)

Please replace customer names, internal domains, addresses, interface descriptions, and credentials before attaching logs, screenshots, or request exports to an issue.

## Submitting a pull request

Fork Hopline Terminal, create a topic branch in your fork, and open a pull request against `manuutr/hopline-terminal:main`. Include the problem, the change and the checks you ran.

GitHub requests review from **@manuutr** for every file, including workflows and ownership rules. Only the owner can merge into `main`. New commits invalidate earlier approvals. Permission to run a fork's CI lets that revision run its tests. The owner makes the merge decision separately. Version tags and GitHub releases are also the owner's responsibility.

## Quick start

Requires Node 24.11 or later (npm 11).

```sh
git clone https://github.com/manuutr/hopline-terminal.git
cd hopline-terminal
npm ci
npm run dev          # the app, with hot reload
```

In the development app, open the command palette (`Ctrl+Shift+K`, `⌘K` on macOS) and run **Open the simulator lab** to connect to local Cisco, Arista, Fortinet and Palo Alto simulators.

For a parser change, run the focused suite first.

```sh
npx vitest run packages/parsers
```

Before opening your pull request, run the repository checks.

```sh
npm run typecheck
npm test             # unit and integration tests
npm run e2e          # hidden Electron windows and isolated local fixtures
```

## The contributor guide

| Page | What it covers |
| --- | --- |
| [Architecture tour](docs/contributing/architecture.md) | Repository layout, the four processes and how a command travels |
| [Development](docs/contributing/development.md) | Setup per OS, `dev`, the simulator, tests, e2e, benchmarks, soak, evals |
| [Adding a vendor platform](docs/contributing/adding-a-platform.md) | cli-model tree and profile, simulator personality, parsers, safety net, tests |
| [Adding an IPC channel](docs/contributing/adding-an-ipc-channel.md) | Schemas, ownership checks, the preload, the shape tests |
| [Adding a setting](docs/contributing/adding-a-setting.md) | Types, defaults, schema, the Settings row, the registry and the docs |
| [Conventions](docs/contributing/conventions.md) | Code style, UI and copy rules, commits, pull requests, releases |

Project background · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PRD.md](docs/PRD.md), [docs/ROADMAP.md](docs/ROADMAP.md), [docs/design/VISUAL-DIRECTION.md](docs/design/VISUAL-DIRECTION.md).

## Security rules

Every change must keep these true. A pull request that weakens one is not merged, however useful it is. If you are unsure, ask in the pull request.

1. **The renderer is untrusted.** It never sees a secret, never decides whether a command may run, and can only ask main. Main validates every IPC payload with a strict zod schema and checks that the asking window owns the tab it names.
2. **Every command Hopline Terminal sends for the user is classified in main** by `@hopline/guard` for the session's platform, before anything else happens, and again by the session host from the signed verdict. That covers the assistant, fleet workers, snippets, send to many, multi-device runs, block re-runs, backups and the auto-detect probe. Never add a path that writes to a device without going through `GuardedRunner`, `DeviceTools`/`Proposals` or the safety-net flow.
3. **The deny-list lives in main and the session host.** It is part of each platform's tree in `@hopline/cli-model`. Nothing may override it: not an approval, a setting, a team policy or a test flag. A team policy can only add to it.
4. **Default-deny.** A command the tree does not know is not a read. An unknown platform refuses everything. When in doubt, block and explain.
5. **Secrets never reach the renderer or a model.** Credentials are decrypted only in main and travel renderer → main at most once (a typed password), never back. Every request to a model goes through `safeProvider` (redaction) and the egress log. Device output is redacted before it reaches a prompt, the window, a parser result shown to the user, or a crash report.
6. **Device text is untrusted data.** It reaches a model only inside the untrusted frame (`agent/untrusted.ts`), with escapes stripped. No tool may take a host, a path or a command that bypasses the guard. Mentions and scopes come from what the user typed, never from device output.
7. **Audit every AI action.** Every attempt to send a command for the user, executed or not (blocked, refused, rejected, timed out, cancelled), writes an audit row with its source. The audit table is append-only.
8. **Tests never take over the machine.** e2e runs hidden (`HOPLINE_HIDDEN`), with stubbed native dialogs, an in-memory clipboard and keychain, the simulator, and a local fake model. No test may open a real window on the user's desktop, touch the real clipboard or call a real model API.

To report a vulnerability, see [SECURITY.md](SECURITY.md). Don't open a public issue.

## Licence

Hopline Terminal is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree that your contributions are licensed under the same terms (section 5 of the licence).
