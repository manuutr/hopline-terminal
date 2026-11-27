# Architecture tour

A short map for contributors. The full design, with the reasons behind each decision, is [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Repository layout

```text
apps/desktop                 The Electron app (electron-vite, React 19, Tailwind 4, xterm.js)
  src/main                   Main process: IPC, settings, vault, SQLite, guard checks, agent, fleet, audit, updater
    agent/                   Single-device assistant: loop, device tools, proposals, safety-net changes, untrusted framing
    fleet/                   Fleet investigations: scope, topology, coordinator and workers, budgets, evidence ledger
    llm/                     Provider-neutral types, the Anthropic, OpenAI, Gemini and Ollama adapters, redaction (safe.ts), egress
    productivity/            GuardedRunner (snippets, send to many, multi-device runs), multi-device service
    host/                    SessionHostClient: spawns the session host, brokers credentials, host keys, signed verdicts
    ipc/                     One file per namespace; schemas.ts holds the shared zod schemas
    db/, vault/, egress/, backups/, policy/, update/, crash/ …
  src/session-host           Utility process: one HostTab per terminal (transport, flow control, logging,
                             reconnect), executor.ts (types one guarded command), line-editor.ts (echo check)
  src/preload                The typed window.hopline bridge (contextBridge, no ipcRenderer exposed)
  src/renderer               The UI: design system, features/*, lib/* (actions, keymap, autocomplete, blocks)
  src/shared                 Types and pure helpers shared by main, the session host and the renderer
  test/                      vitest: integration tests of main and the session host against the simulator
  e2e/                       Playwright against the built app (hidden), plus capture/ for screenshots and the demo
  scripts/                   Packaging hooks (fuses, signing) and docs-reference.ts (generated guide pages)
packages/guard               classify(command, platform): read / config / disruptive / blocked; the redactor
packages/cli-model           15 platform models: profiles, prompts, pagers, errors, command trees with the
                             deny-list, config wrappers, safety nets, fingerprints, per-platform equivalents
packages/transports          SSH (ssh2), Telnet (RFC 1143), raw TCP, serial (serialport), SFTP/SCP, port forwards
packages/simulator           Multi-vendor SSH/Telnet device simulator: shells, state, scenarios, topology lab
packages/parsers             TextFSM engine (TypeScript port) and 358 bundled ntc-templates
packages/importers           SecureCRT, MobaXterm, PuTTY, ssh_config, CSV and NetBox/Nautobot importers
bench/                       Performance benchmarks and the soak test (docs/PERFORMANCE.md)
eval/                        Live eval reports (only SUMMARY-*.md is tracked; docs/EVALS.md)
scripts/                     Icons, release tooling, demo encoding, PNG optimiser
docs/                        Product, architecture, policy, signing, the user guide and this guide
```

Packages are pure TypeScript with no Electron dependency. They are tested directly with vitest and imported by every process.

## Processes

```text
 ┌──────────────────────────────────┐
 │ Renderer (sandboxed, untrusted)  │  React UI, xterm.js, highlighting, autocomplete, @ai capture.
 │ contextIsolation, CSP, no nav    │  Never sees a secret. Can only ask.
 └──────┬─────────────────▲─────────┘
        │ window.hopline  │ events (redacted)          ┌───────────────────────────────┐
        │ (preload, typed)│                            │ Preload                       │
        ▼                 │                            │ contextBridge: typed functions│
 ┌──────────────────────────────────┐                  │ over ipcRenderer.invoke only  │
 │ Main (trusted broker, policy)    │                  └───────────────────────────────┘
 │ zod-validated IPC, window checks │
 │ guard + cli-model, approvals     │──── LLM requests (redacted, logged) ──▶ configured provider
 │ agent, fleet, vault, SQLite,     │
 │ audit, egress log, updater       │
 └──────┬─────────────────▲─────────┘
        │ control port:   │ results, state,
        │ open/close,     │ observations
        │ exec(cmd, signed verdict)
        ▼                 │
 ┌──────────────────────────────────┐      ┌───────────────────────────┐
 │ Session host (utilityProcess)    │◀────▶│ Devices: SSH, Telnet,     │
 │ transports, logging, reconnect,  │      │ raw TCP, serial           │
 │ executor; re-checks every verdict│      └───────────────────────────┘
 └──────────────────▲───────────────┘
                    │ MessagePort per tab: keystrokes down, output up (ack flow control)
                    └──────────────────────── renderer terminal
```

| Process | Trust | Owns |
| --- | --- | --- |
| Renderer | Untrusted | The UI. Talks to main through `window.hopline` and to its terminals through one `MessagePort` per tab |
| Preload | Bridge | Exposes typed functions; never `ipcRenderer` itself |
| Main | Trusted | IPC validation, settings, the vault (the only place secrets are decrypted), the database, the guard decision, approvals, the agent and fleet loops, model calls, the audit and egress logs, updates |
| Session host | Trusted, isolated | Every device connection, logging, keep-alive and reconnect, the executor. Restarted by main if it crashes |

### How a command the assistant wants travels

1. The model calls `run_show_command` in main (`agent/device-tools.ts`).
2. Main classifies it with `@hopline/guard` for the session's current platform. Blocked or not a read: refused (or turned into a proposal), audited, and the model is told why.
3. A read is signed: an HMAC verdict over the tab, command, kind, platform, hostnames, read-only flag, expiry and a nonce, with a key only main and the session host share.
4. The session host checks the verdict and classifies the command again in the mode its own prompt shows. Then the executor waits for an idle prompt, clears the line, types the command, checks the echo character by character, and only then presses Enter.
5. Output comes back to main, which strips escapes, redacts secrets, applies the local filter, caps it, frames it as untrusted and parses it with TextFSM before the model sees it. The window gets the same redacted text for the command row.
6. Every step writes an audit row.

A configuration change adds an approval in between: main stores the proposal's exact lines, the window can only send back the proposal id and which lines are ticked, and the safety net's own lines are generated by main from fixed templates (`packages/cli-model/src/safety-net.ts`) and carry a `net` mark the session host checks against those templates.

Commands a user types go straight from the renderer to the session host over the tab's port, tagged `origin: 'user'`, and are never filtered.

## Where to start reading

- The guard: `packages/guard/src/classify.ts`, then a tree such as `packages/cli-model/src/trees/ios.ts`.
- The assistant: `apps/desktop/src/main/agent/agent.ts` → `loop.ts` → `device-tools.ts` → `proposals.ts` → `changes.ts`.
- The executor: `apps/desktop/src/session-host/executor.ts` and `line-editor.ts`.
- IPC: `apps/desktop/src/main/ipc/index.ts` (the `h()` helper and `registerCoreIpc`) and `src/preload/index.ts`.
- The terminal: `apps/desktop/src/renderer/src/features/terminal/TerminalView.tsx`.
