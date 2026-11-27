# AI assistant

Open **Assistant** to ask a networking question before connecting to a device. Try “Log into core and check interfaces.” In **Workspace**, Hopline can suggest matching saved devices, explain why each is relevant, and preview the question it will take to that device. Choose **Connect and ask** to open the session or **Ask** to use an existing connection.

The device conversation can collect read-only command output and explain what it found. You review the exact lines of any proposed configuration change. Each command it tries appears in the audit log. [Safety and audit](safety-and-audit.md)

Choose **Continue in workspace** under a device answer to bring the finding and completed commands into an editable follow-up. You can also drop a PCAP or PCAPNG into the assistant, ask about a frame, then bring that finding back to choose the next device. Switching conversations preserves your workspace thread for the window. [Packet capture guide](packet-capture.md)

## Providers

| Provider | Where prompts go | Models |
| --- | --- | --- |
| **Anthropic** | Anthropic's API (cloud) | Claude Opus 5.5 (default, `claude-opus-5-5`), Sonnet 5.5, Haiku 5.5 |
| **OpenAI** | `api.openai.com` | Defaults to `gpt-5.4-mini`. You can enter another Chat Completions model with function calling. |
| **Google Gemini** | `generativelanguage.googleapis.com` | Defaults to `gemini-4-hydrogen`. You can enter another Gemini API model with function calling. |
| **ChatGPT** | OpenAI through the official Codex CLI | Uses the account’s default model in suggest mode. |
| **GitHub Copilot** | GitHub through the official Copilot CLI | Uses the account’s default model in suggest mode. |
| **Ollama** | An Ollama server on this machine or one you choose | The models the server reports. The picker shows tool support (or suggest mode) and context size |

Set it up in the assistant panel's **Connect a model** form or in Settings › Assistant ([Getting started › Connect a model](getting-started.md#connect-a-model)). Under the panel header, the trust bar identifies the active cloud provider or Ollama host. Hover over it to see the model and destination. The provider dot shows whether the model answers; click it to check again.

The same guard, audit, timeouts, output caps and secret redaction apply to every provider. Hopline 1.1 also masks recognized device names and interface descriptions across chat and fleet requests. [Privacy coverage](privacy.md#assistant-requests)

- **Anthropic.** The key is kept in the vault and never reaches the window or a prompt. Hopline turns on the API's server-side refusal fallback: if the selected model declines a turn, the API may retry it on a fallback model; if no model answers, the panel shows the refusal.
- **OpenAI and Gemini.** Each answer appears when the model finishes its turn. Hopline sends tool results with the call IDs the provider issued. The token meter uses the provider’s reported usage.
- **Ollama.** The context window follows the model's own length (at least 8,192 tokens, at most 32k). A long conversation drops its oldest exchanges with a note to the model, and a request that still does not fit is refused before sending ("Context too small") rather than trimmed silently. Redirects are reported, never followed. A server that is not on this machine shows a warning; plain `http` to a remote server needs an acknowledgement for that address. Fleet investigations run one device at a time with Ollama by default.

### Using an existing subscription

1. Install the official Codex CLI for ChatGPT or Copilot CLI for GitHub Copilot. The setup panel links to the provider’s installer. The executable must be available to the desktop app. Hopline has been tested with Codex CLI 0.172.0 and Copilot CLI 1.0.117. [Codex CLI](https://developers.openai.com/codex/cli/) · [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
2. Open **Connect a model**, choose **ChatGPT** or **GitHub Copilot**, then select **Sign in**. Open the verification page, enter the displayed code, and approve access with an eligible account. In Settings, the same controls appear under **Assistant**. GitHub organizations and ChatGPT workspaces can limit access through their own policies.
3. Choose **Use ChatGPT** or **Use GitHub Copilot** in the assistant panel, or **Save** in Settings. Ask a question about selected output. In suggest mode you review and run individual commands in Hopline. Fleet investigations require a tool-calling API or Ollama model.
4. To remove the connection, open **Settings › Assistant**, select the account, and choose **Disconnect account**. To revoke the provider’s grant, use its account settings.

Hopline encrypts the CLI’s saved account files under the vault key. Each sign-in or question uses a private temporary profile that is removed when the client exits. A session-only vault forgets saved accounts on the next launch. The egress log shows the masked prompt handed to the client. The vendor controls the final network request. A team policy requiring an exact request log disables both account clients. [Team policy](../POLICY.md)

**Claude Pro or Max.** Hopline uses a Claude Console API key for Anthropic. Anthropic reserves direct Claude subscription sign-in for its own applications. [Anthropic credential policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

**OpenAI project credits.** Eligible ChatGPT Pro and Business owners can also claim API credits and choose **OpenAI** with a project key for tool calling and fleet runs. [Subscription credit eligibility](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

## Asking

- **The side panel:** `Mod+I`. Conversations read as a transcript ("You", "Assistant"), with each command the assistant ran shown as a monospace row. **New conversation** starts over. Each terminal has its own conversation and unsent draft, including split panes. Closing the terminal discards its draft.
- **`@ai` at the prompt:** type `@ai why is bgp to 10.0.0.2 down?` at the device prompt and press Enter. The line never reaches the device; the question goes to this tab's assistant. `@ai` is recognised after Ctrl-Z, arrows or leading spaces. Add `@device` mentions to ask about several devices at once: see [Fleet investigations](fleet.md).
- **Explain output:** select text in the terminal, right-click › **Explain this output**. Hopline sends whole lines (so a selection that starts after a secret's keyword is still redacted), with terminal escapes removed.
- **Ask your own question about output.** Choose **Attach command output** below the message box. It captures the command selected with prompt navigation, or the most recent completed command. Review the command name, type your question and choose **Send**. You can remove or replace the attachment before sending.
- **Ask about a block:** the command block toolbar's **Ask AI about this block**, or the terminal's right-click menu.

With no model connected, `@ai` and Explain open the panel at setup and keep the question; it is sent once a model is connected.

![The assistant investigating](img/ai-panel.png)

## Read-only investigation

The assistant has a small set of tools, all in Hopline's main process:

| Tool | What it does |
| --- | --- |
| `run_show_command` | Runs one read-only command on this tab's device. Optional local filter: last N lines, first N, grep (alternation, ignore case, invert, context lines) or a count. The device gets the plain command; Hopline filters the redacted output and the command row says so ("show logging · last 30 lines"). When a TextFSM template matches, the model also gets the parsed rows. |
| `propose_config_change` | Proposes a change: the lines, the rollback lines, read-only verify commands with what each should show, and an optional safety net and confirm window. Nothing runs until you approve. |
| `report_verification` | After a change, the model's verified or not-verified judgement of the verify output. It cannot confirm or roll back: only you can. |

The guard classifies every command for the session's platform before anything is typed (see [Safety and audit](safety-and-audit.md#the-classifier)). Reads run at once; anything else becomes a proposal or is refused. The executor only types at an idle prompt, checks the device's echo before pressing Enter, answers `--More--` with Space, and never changes your `terminal length`. While it runs a command your keyboard is locked, except for Ctrl-C, which cancels it.

Device output reaches the model redacted and inside an `untrusted` frame that device text cannot close, so a device banner or description that says "ignore previous instructions" is data, not an instruction. The model never gets a tool that could bypass the guard.

A run stops after 16 model turns, at most 8 tool calls per turn, and at its [token budget](#budgets).

## Proposals, diff and approval

With [read-only mode](safety-and-audit.md#read-only-mode) on (the default), proposals are refused. Turn it off from the status bar ("Read-only"), the panel header, the palette (**Turn read-only mode off**) or Settings. You still approve every change.

A proposal opens an approval card in the panel:

![An approval card](img/approval-card.png)

![The same card in the light theme](img/approval-card-light.png)

- **The lines**, each with its own checkbox. Lines under an interface or section are grouped with the line that enters it, and a ticked subset is checked again in main: a sub-mode line without its parent is refused.
- **The wrapper** the platform needs: `configure terminal` … `end` on Cisco and Arista, `configure private` … `commit and-quit` on Junos, `commit` on IOS-XR, `commit partial admin <user>` on PAN-OS, and so on, with what happens if a line fails.
- **The risk label**: Configuration (amber), or Disruptive (red) for lines that drop traffic or sessions, such as `shutdown` on an interface, `clear ip bgp *` or a change to a trunk's allowed VLAN list. Commands such as `reload` and `write erase` are not proposals at all: they are on the deny-list and never run.
- **The rollback plan**, the **verify commands** with what each should show, and the **safety net** that will be used.
- **Copied text:** a line that holds text the device printed recently is flagged with the command that printed it, so a device can't talk the model into proposing its own text unnoticed.

**Approve** arms after a short delay, so a stray Enter can't approve. A **Disruptive** change also needs the device's hostname typed: the solid red button stays disabled until it matches. Main checks the hostname and signs it into each line's verdict, and the session host checks it again against the prompt it sees.

When you approve, main runs the stored lines, not anything the window sends back: the window can only send the proposal's id and which lines are ticked. Execution stops at the first device error (`% Invalid input`, `syntax error`, `Command authorization failed` …), and the deny-list is checked again for every line. Each line is bound to the device's hostname, so a tab that has hopped to another device (a nested `ssh`) is refused.

Only one change can be open per device. A second proposal on the same session is refused until the first is confirmed, rolled back or closed.

## Safety nets and rollback

Hopline arms a platform safety net before applying, runs the verify commands after, and then you decide.

| Platform | Net | Confirm | Roll back |
| --- | --- | --- | --- |
| Junos | `commit confirmed N` | `commit` | `rollback 1` and commit; or wait N minutes and Junos rolls back by itself |
| EOS | `configure session` with `commit timer` | `configure session … commit` | `configure session … abort`; or wait for the timer |
| NX-OS | a `checkpoint` | delete the checkpoint | `rollback running-config checkpoint` |
| IOS-XE | an `archive` snapshot | nothing to run | `configure replace <archive> force` |
| Others | the proposal's rollback lines | nothing to run | the rollback lines, in the same wrapper |

N is the confirm window, 1 to 30 minutes (5 by default). The net's own lines are generated by Hopline from fixed templates, never by the model, and the session host accepts them only when they match those templates on the approved device. The assistant itself can never run `configure replace`, `archive`, `checkpoint`, `rollback` or `configure session`.

![After apply: verify output, Confirm and Roll back](img/safety-net.png)

After apply, the card shows the verify output next to the assistant's verified or not-verified judgement. Press **Confirm** or **Roll back**. On Junos and EOS the card counts down; if the window runs out, the device rolls itself back and Hopline detects and reports it.

Hopline reports only what the device shows. Before and after every confirm or rollback it reads the device's state. When it cannot tell, the card says **State unknown — check the device**, reports no success, and keeps the change open with its undo. A commit that timed out is never reported as "nothing was changed".

## Suggest mode

A local model without tool calling runs in **suggest mode** (a badge shows in the panel). The model proposes commands in fenced blocks; Hopline lists each one with the guard's verdict (read, config, disruptive or blocked), and nothing runs until you click it. A read runs through the guard, the signed verdict and the audit log with you as the approver. Configuration and disruptive commands open the usual approval card. **Continue with the output** hands the result back to the model.

![Suggest mode](img/suggest-mode.png)

Fleet investigations need a model with tool calling.

## Budgets

- **Per-run token budget** (Settings › Assistant › Run budget): 200,000 tokens by default, minimum 20,000, all model turns of one question together, with output counted 5×. A meter in the panel turns amber at 80%. At the limit the model is told to finish without running more commands.
- **Command timeout** (30 s) and **output cap** (512 KB) per command. Both are enforced with Ctrl-C on the device. Output sent to the model is cut to 40,000 characters, with a note saying so.
- A team policy can lower the maximum run budget.

## What left this machine

When request logging is enabled, Hopline records the masked request body for direct APIs and Ollama. The ChatGPT and Copilot entries show the input handed to the official client. Each entry includes the system prompt, the conversation and the tool results, with the provider, model, destination, tokens, time, session and run id. Headers and the API key are never recorded.

Open it from the arrow icon in the panel, Settings › Assistant, or the palette (**What left this machine**). Search it and export it as JSON Lines (the export file is owner-only and is itself audited). Searching payloads needs the vault unlocked.

![What left this machine](img/egress-log.png)

The log is encrypted with the vault's key and keeps at most 5,000 requests or 64 MB, removing the oldest first. It is on by default. You can turn it off, unless a team policy requires it; then a request that cannot be recorded is not sent. Connection tests appear as `check` rows. The health check and model discovery send no prompt and are not recorded.
