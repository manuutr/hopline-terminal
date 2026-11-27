# Privacy

Hopline has no account and no analytics. These features can contact an external service.

| What | When | Default | Where it goes |
| --- | --- | --- | --- |
| **Update checks** | Every six hours, and when you press Check now | On | GitHub sees your IP address and the requested release. The 1.0.1 updater also sends a random per-install rollout ID. Hopline 1.1 keeps that ID local. |
| **Subscription sign-in** | When you start sign-in, the official client requests a device code and checks for approval | Off until you choose Sign in | OpenAI for ChatGPT or GitHub for Copilot |
| **Assistant requests** | When you configure or test a connection, or ask the assistant a question | Off until you set up a provider | Your selected cloud API, the signed-in ChatGPT or Copilot client, or the Ollama server you chose |
| **Crash reports** | Only after you turn them on | Off | The release's built-in Sentry or GlitchTip DSN, your own, or your team's |

The first-run screen ("Before you start") asks about update checks and crash reports before anything is sent, and you can change both any time in Settings › Updates & privacy. A [team policy](team-policy.md) can turn update checks and crash reports off for everyone, and an invalid policy turns them off too.

Connections to your devices, SFTP transfers and port forwards go where you point them, of course. Folder sync writes to a folder you chose; what happens to it next is up to the tool that syncs that folder.

## Assistant requests

After you configure a provider and ask a question, the main process masks recognized secrets before it builds the provider request. Hopline 1.1 also masks network labels in the same request.

When you ask which device to check, workspace chat matches your words against the saved inventory on this machine. The provider receives the relevant candidates’ temporary aliases, configured platforms and inferred roles. A request to list inventory includes the total number of saved sessions and up to 16 candidates. **Continue in workspace** puts a device or capture finding into your draft so you can review it before sending.

Hopline assigns temporary aliases to the saved session name, its management host and tags, and to hostnames or descriptions it recognizes in CLI prompts, configuration, neighbor detail (including LLDP port descriptions), PAN-OS interface comments, or interface tables. A connection label such as `branch-07` might become `device-1-a194ef`, and `Acme payroll uplink` might become `label-3-a194ef`. The same value gets the same alias across a chat or a fleet investigation. Clearing the chat or starting a new fleet investigation creates a fresh dictionary. The dictionary stays in main-process memory.

This applies to the question, selected lines, system context, tool output, and conversation history sent to any provider. The terminal and local session inventory retain their original labels. Hopline can resolve a fleet device alias only against sessions in the selected scope. Device commands containing a placeholder are refused.

With ChatGPT or GitHub Copilot, the local official client receives a masked prompt and sends its own network request. Hopline records that handoff when logging is enabled. The client runs in a private temporary profile. Hopline seals saved account files in the vault and removes the temporary profile after each run. [Sign-in and disconnect](ai-assistant.md#using-an-existing-subscription)

**What can still identify a network?** IP addresses other than recognized management hosts, route prefixes, MAC addresses, interface identifiers, VLAN and VRF values, timestamps, and free-form text can remain visible. A partial selection or an unfamiliar format can lose the context needed to recognize a sensitive label. Automatic masking supports a troubleshooting conversation. For data that must stay local, choose an on-device Ollama endpoint.

With request logging enabled, **What left this machine** shows the masked request body sent to a direct API or Ollama, or the prompt handed to the official subscription client. Entries identify the provider, model, destination, time, session and run, with token counts when available. Local log metadata still identifies the real session, so review an export before sharing it. Headers and the API key are never recorded. The log is encrypted on this machine with the vault's key, keeps at most 5,000 requests or 64 MB, and is on by default. [View and export the request log](ai-assistant.md#what-left-this-machine)

What a provider does with a request is governed by its own terms. To keep inference on this machine, choose a loopback Ollama endpoint and a model that runs locally.

## Crash reports

Crash reports are off by default. If you turn them on, each report is rebuilt from an allow-list before it is sent:

- **kept:** the error type, a scrubbed message and app-relative stack frames;
- **removed:** host names, IP and MAC addresses, user names, session and folder names, prompts and CLI lines, quoted values, file paths, keys and tokens;
- **never collected:** breadcrumbs, the machine name and user details.

**Send a test crash** sends a made-up error through the same pipeline; nothing crashes.

**Native crash dumps** are different: a dump is a copy of a Hopline process's memory and cannot be scrubbed. It can hold terminal output, commands, host names, a typed password or a decrypted credential. So:

- the native crash handler starts only after you turn crash reports on, and never uploads anything itself;
- each dump is sent only from Settings › Updates & privacy, after its own confirmation that names the destination and warns that a dump is raw memory;
- dumps are kept in an owner-only folder in your profile, deleted after 7 days, and all deleted when you turn crash reports off; **Delete all** removes them at once.

Every report and dump sent adds a metadata-only row to What left this machine (destination, size, status; never the content).

## Data on this machine

Hopline keeps its data in your user profile:

- the database: sessions, folders, credential profiles (secrets encrypted), settings, known hosts, the audit log, config backups and the egress log (both encrypted);
- encrypted scrollback for **Restore history**;
- session logs, only where you turned logging on, in the log folder you chose (plain text, as the device printed it).

Every secret is encrypted with one data key, protected by the OS keychain, a master password or nothing at all (session only). See [Sessions › The vault](sessions.md#the-vault). Uninstalling Hopline does not delete your profile.
