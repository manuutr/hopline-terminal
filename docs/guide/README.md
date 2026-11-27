# Hopline Terminal user guide

Hopline Terminal is a desktop SSH, Telnet and serial client for network engineers, with an AI assistant that can investigate on its own and can only change a device after you approve the exact lines. This guide describes version 0.8. Each page stands on its own.

Shortcuts are written with **Mod**: Ctrl+Shift on Windows and Linux, ⌘ on macOS. `Mod+K` is Ctrl+Shift+K on Windows and Linux and ⌘K on macOS. Plain `Ctrl+<letter>` always goes to the device.

## Start here

1. [Getting started](getting-started.md): install, the first-run screens, privacy choices, connecting a device and a two-firewall incident walkthrough.
2. [Connections](connections.md): SSH (jump hosts, agent forwarding, keys, passwords, MFA, host keys), Telnet, serial, port forwarding, SFTP and SCP.
3. [Sessions](sessions.md): the session tree, folders and tags, quick connect, importing from other tools, credential profiles, encrypted export and sync, per-host overrides.

## Working in the terminal

4. [Terminal](terminal.md): tabs, splits, find, logging, scrollback, themes and fonts, the keymap, command blocks.
5. [Productivity](productivity.md): the command palette, snippets and the button bar, send to many devices, multi-device runs, config backups and diffs, parsed tables.
6. [Autocomplete](autocomplete.md): ghost text and command help from each platform's command model.

[Packet capture](packet-capture.md) covers chat attachments, offline packet decoding, IOS XE collection, SFTP/SCP transfer, Wireshark display filters and AI-assisted frame analysis.

## The assistant

7. [AI assistant](ai-assistant.md): providers (Anthropic, OpenAI, Gemini, Ollama), the side panel and `@ai`, read-only investigation, explaining output, proposals and approval, safety nets and rollback, suggest mode, budgets, the egress log.
8. [Fleet investigations](fleet.md): one question across several devices, the scope, topology, `@device` mentions.
9. [Safety and audit](safety-and-audit.md): the classifier, the deny-list, read-only mode, the audit log, timeouts and caps, what never leaves the machine.
10. [Team policy](team-policy.md): fixing safety settings for every user of a machine.

## Worked examples

Follow multi-device routing and change-control investigations in the [screenshot gallery](../examples/).

## Reference

11. [Settings reference](settings-reference.md): every setting, its default and its deep link.
12. [Keyboard shortcuts](keyboard-shortcuts.md): every default shortcut on each OS.
13. [Accessibility](accessibility.md): screen reader mode, the buffer view, keyboard-only use.
14. [Troubleshooting and FAQ](troubleshooting.md).
15. [Application and context menus](menus.md).
16. [Privacy](privacy.md): what Hopline Terminal sends, when, and where it is recorded.

## Elsewhere

- [Architecture](../ARCHITECTURE.md), for how the processes and the guard fit together.
- [Security policy](../../SECURITY.md), to report a vulnerability.
- [Contributing](../../CONTRIBUTING.md).
- [Changelog](../../CHANGELOG.md).
