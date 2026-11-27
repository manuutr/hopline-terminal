# Team policy

An administrator can fix Hopline Terminal's safety settings for every user of a machine with a JSON policy file. Users cannot turn these settings off; Settings shows them as **Managed by policy**, with the policy's name and an optional message. The full reference is [docs/POLICY.md](../POLICY.md).

The policy is enforced in Hopline Terminal's main process and, for blocked commands, again in the session host. A modified window or a crafted IPC call cannot get around it.

## Where Hopline Terminal looks

The file is read once at start; restart Hopline Terminal after changing it.

| OS | Path |
| --- | --- |
| Linux | `/etc/hopline/policy.json` |
| macOS | `/Library/Application Support/Hopline/policy.json` |
| Windows | `C:\ProgramData\Hopline\policy.json` (the machine's Common AppData folder, read from the registry) |

A file at the admin location always wins. Otherwise the `HOPLINE_POLICY` environment variable can name a file. Make the file writable only by administrators.

## What it can set

| Key | Effect |
| --- | --- |
| `version` | Required, `1` |
| `name`, `message` | Shown in Settings next to "Managed by policy" |
| `readOnly` | `true` locks [read-only mode](safety-and-audit.md#read-only-mode) on |
| `blockedCommands` | Extra commands to refuse, for `all` platforms or per platform. They add to the built-in deny-list and never allow anything |
| `allowedProviders` | A list of allowed provider IDs. Choose from `anthropic`, `openai`, `gemini`, `ollama`, `chatgpt`, and `copilot`. An empty list turns off the assistant. |
| `allowedOllamaEndpoints` | The Ollama servers that may be used |
| `fleet.maxConcurrency`, `fleet.maxTokenBudget` | Caps for fleet investigations |
| `maxRunTokenBudget` | Cap for the assistant's per-question budget |
| `requireEgressLog` | The "what left this machine" log is always on, and a request that cannot be recorded is not sent |
| `disableUpdates`, `updateChannel` | Turn update checks off, or fix the channel |
| `disableCrashReports`, `crashReportDsn` | Forbid crash reports, or send them to your own server. A policy can never turn crash reports on for a user |

Blocked commands apply to everything Hopline Terminal sends for the user (the assistant, suggest mode, fleet workers, snippets, send to many, multi-device runs, config backups and the auto-detect probe), never to what the user types. Blocking one command that prints the configuration blocks the platform's other ways of printing it too (`show running-config`, `show startup-config`, `show configuration` …).

## Example

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

More examples, including an air-gapped setup and "no AI at all", are in [docs/POLICY.md › Examples](../POLICY.md#examples).

## Fails closed

If the file can't be read, isn't valid JSON, has an unknown or duplicate key, or a value out of range, Hopline Terminal treats the whole policy as hostile: read-only mode is locked on, every command Hopline Terminal would send for you is refused (what you type is unaffected), the assistant and fleet are off, update checks stop, crash reports can't be turned on, and a red banner names the file and the first problem. Fix the file and restart.

To check a policy, start Hopline Terminal with it in place (or with `HOPLINE_POLICY=/path/to/policy.json`) and open Settings › Assistant › Permissions and limits.
