# Team policy file

A team policy lets an administrator fix the safety settings of every Hopline install on a machine: read-only mode, extra blocked commands, which model providers may be used, fleet limits, budgets and the "what left this machine" log. Users cannot turn these off. Settings a policy fixes are shown as **Managed by policy** in the app.

The policy is enforced in Hopline's main process (and the session host for blocked commands), not in the window, so a modified window or a crafted IPC call cannot get around it.

## Where Hopline looks

The policy is read once when Hopline starts. Restart Hopline after changing it.

1. **The admin location for the OS.** When a file exists here, it is the policy, whatever the environment says.

   | OS | Path |
   | --- | --- |
   | Linux | `/etc/hopline/policy.json` |
   | macOS | `/Library/Application Support/Hopline/policy.json` |
   | Windows | `<ProgramData>\Hopline\policy.json`, where `<ProgramData>` is the machine's Common AppData folder read from the registry (HKLM), usually `C:\ProgramData\Hopline\policy.json`. The `ProgramData` environment variable is ignored, since a user can change it. |

   Make the file writable only by administrators (root / Administrators). Hopline only reads it. A symlink placed there is followed; a symlink whose target is missing counts as an invalid policy (it fails closed), not as no policy.
2. **`HOPLINE_POLICY`**, an environment variable holding a file path. Use it when the admin location is not practical (a managed environment, a test lab). If the variable is set but the file is missing or unreadable, Hopline **fails closed** (below).
3. Otherwise there is no policy and every setting is the user's.

The format is JSON (UTF-8, at most 256 KB). A UTF-8 byte-order mark (Notepad) and UTF-16 with a byte-order mark (PowerShell 5 `Out-File`) are accepted too. YAML is not accepted: one format means one parser and no ambiguity about types.

## Fails closed

If the file cannot be read, is not valid JSON or text, has an unknown key (a typo such as `readonly` is an error, not ignored), the same key twice in one object, a `__proto__`, `constructor` or `prototype` key, or a value out of range:

- read-only mode is on and cannot be turned off;
- Hopline sends no command at all: the assistant, snippets, send-to-many, multi-device runs, config backups and auto-detect are refused (`blocked by team policy (the policy file is invalid …)`), because the broken file may have meant to block some of them. What a user types into the terminal is not affected;
- the assistant and fleet investigations are off (no request is sent to any model; Ollama discovery is refused too);
- update checks stop and crash reports cannot be turned on: nothing leaves the machine on its own, in case the file was meant for an air-gapped network;
- a red banner across the window names the file and the first problem found.

Fix the file and restart Hopline.

## Keys

All keys except `version` are optional. Anything not set stays the user's choice.

| Key | Type | Effect |
| --- | --- | --- |
| `version` | `1` | Required. The format version. |
| `name` | string (1–80) | Shown in Settings next to "Managed by policy", e.g. `"ACME NetOps"`. |
| `message` | string (1–300) | A note shown in Settings › Assistant › Permissions and limits (who to ask, a link to your runbook). |
| `readOnly` | boolean | `true`: read-only mode is on for the assistant, snippets, send-to-many and multi-device runs, and file uploads are blocked. The user cannot turn it off. `false` or absent: the user decides. |
| `blockedCommands` | object | Extra commands to refuse, by platform. Keys: `all` or a platform id (`ios`, `iosxe`, `nxos`, `iosxr`, `asa`, `c9800`, `aireos`, `ciscosb`, `ftd`, `eos`, `junos`, `panos`, `fortios`, `aoscx`, `vrp`). Values: up to 200 patterns each (printable ASCII, up to 200 characters). See below. |
| `allowedProviders` | array of `"anthropic"`, `"openai"`, `"gemini"`, `"ollama"`, `"chatgpt"`, `"copilot"` | Only these providers can be connected, tested or used. `[]` allows none: the assistant panel says it is off by policy, and fleet investigations cannot start. Account clients also require a policy that permits client-side prompt logging in place of an exact wire log. |
| `allowedOllamaEndpoints` | array of URLs (1–50) | Ollama may only be used at these servers (compared by scheme, host and port), e.g. your own GPU box. |
| `fleet.maxConcurrency` | integer 1–8 | Upper limit for devices a fleet investigation works on at once. |
| `fleet.maxTokenBudget` | integer 20,000–4,000,000 | Upper limit for a fleet run's token budget. |
| `maxRunTokenBudget` | integer 5,000–4,000,000 | Upper limit for the per-question token budget in the assistant panel. A user's lower setting is kept. |
| `requireEgressLog` | boolean | `true`: the "what left this machine" log is always on, and a request that cannot be recorded is **not sent**. ChatGPT and Copilot sign-in are disabled because these local clients construct the final network request. |
| `disableUpdates` | boolean | `true`: Hopline never checks for updates; "Check now" is off too. Use it when updates are rolled out by your own software distribution. The update check is the only thing Hopline sends on its own (D8). |
| `updateChannel` | `"stable"` or `"beta"` | Fixes the update channel. |
| `disableCrashReports` | boolean | `true`: crash reports cannot be turned on. A policy can never turn them on for a user: they are always the user's opt-in. |
| `crashReportDsn` | Sentry DSN | Where crash reports go when a user opts in, e.g. your self-hosted GlitchTip (`https://<public key>@glitchtip.example.net/3`). A DSN with a secret key is refused. |

### Blocked commands

Blocked commands add to Hopline's built-in deny-list; they never allow something the guard refuses. They apply to everything Hopline sends for the user: the assistant (tool calls and suggest-mode clicks), fleet workers, snippets, send-to-many and multi-device runs, config backups and the auto-detect probe (checked against every platform the probe could be for). What a user types into the terminal themselves is not affected.

A pattern is a command prefix, matched word by word, case-insensitively:

- `"show running-config"` blocks `show running-config`, `show running-config interface Gi1/0/1` and the abbreviations the guard understands for the platform (`sh run`, `show run`).
- A pattern only matches whole words: `"show ip"` does not block `show ipv6 route`.
- `"all"` patterns apply to every platform; platform patterns are added to them.

**Configuration dumps.** A device can print its configuration with more than one command. When a pattern blocks a whole configuration dump (`show running-config`, `sh run`, `show configuration`, or a shorter prefix such as `show`), Hopline blocks every command in that platform's dump group too, so a model cannot read the configuration another way. A narrower pattern (`show running-config interface`) is not widened.

| Platform | Dump group |
| --- | --- |
| IOS, IOS-XE, C9800 | `show running-config`, `show startup-config`, `show configuration`, `show archive config …`, `show derived-config`, `more system:running-config`, `more nvram:startup-config` |
| IOS-XR | `show running-config`, `show configuration …` (running, commit changes, …), `show startup-config` |
| NX-OS | the Cisco group, `show checkpoint …`, `show diff rollback-patch …` |
| ASA | the Cisco group, `show configuration` |
| FTD, Cisco SB | `show running-config`, `show startup-config`, `show configuration` |
| EOS | the Cisco group, `show session-config` |
| Junos | `show configuration`, `show system rollback …`, `file show …` |
| PAN-OS | `show config running`, `candidate`, `pushed-template`, `pushed-shared-policy`, `merged`, `saved`, `audit` |
| FortiOS | `show full-configuration` |
| AOS-CX | `show running-config`, `show startup-config`, `show checkpoint …` |
| VRP | `display current-configuration`, `display saved-configuration`, `display configuration …` |
| AireOS | `show run-config`, `show running-config` |

Blocking any one member of a group blocks them all (blocking `show startup-config` also blocks `show running-config`): the policy errs on the side of blocking more. The refusal reads `blocked by team policy ("<pattern>": it prints the configuration)`.

The refusal is audited as `blocked by team policy ("<pattern>")`. The session host re-checks the same list before running anything, so a command signed in main is still refused there.

## Examples

Air-gapped network, updates through your own software distribution, nothing sent anywhere:

```json
{
  "version": 1,
  "name": "OT network",
  "disableUpdates": true,
  "disableCrashReports": true,
  "allowedProviders": ["ollama"],
  "allowedOllamaEndpoints": ["http://10.50.0.20:11434"]
}
```

Read-only for everyone, local models only, at one server:

```json
{
  "version": 1,
  "name": "ACME NetOps",
  "message": "Questions: #netops-tools. Changes go through the change board.",
  "readOnly": true,
  "allowedProviders": ["ollama"],
  "allowedOllamaEndpoints": ["http://gpu01.lab.acme.net:11434"],
  "requireEgressLog": true
}
```

Cloud allowed, with budgets and a few extra blocked commands:

```json
{
  "version": 1,
  "name": "Campus team",
  "allowedProviders": ["anthropic", "ollama"],
  "maxRunTokenBudget": 150000,
  "fleet": { "maxConcurrency": 4, "maxTokenBudget": 400000 },
  "blockedCommands": {
    "all": ["show tech-support"],
    "iosxe": ["show running-config", "show startup-config"],
    "nxos": ["show running-config"],
    "panos": ["show config running"]
  },
  "requireEgressLog": true
}
```

No AI at all, Hopline as a plain SSH client:

```json
{ "version": 1, "name": "Restricted jump host", "readOnly": true, "allowedProviders": [] }
```

## The "what left this machine" log

With the log on, direct API and Ollama requests are recorded before sending: the exact body after redaction (system prompt, conversation and tool results), the provider, model, destination, tokens, time, session and run id. Headers and the API key are never recorded. Not recorded: the connection test and health check (a fixed "ping" prompt and a model lookup, no device data). If the vault is locked when a request is made, the payload cannot be encrypted: with `requireEgressLog` the request is **not sent**; without it, it is sent and only the metadata row is kept. Payloads are compressed and encrypted with the vault's data key; the log keeps at most 5,000 requests or 64 MB, removing the oldest first. Open it from the arrow icon in the assistant panel, Settings › Assistant › Permissions and limits, or the command palette ("What left this machine"); it can be searched and exported as JSON Lines.

## Checking a policy

Start Hopline with the file in place (or with `HOPLINE_POLICY=/path/to/policy.json`). Settings › Assistant › Permissions and limits shows the policy's name and file; a mistake shows the red banner with the reason.
