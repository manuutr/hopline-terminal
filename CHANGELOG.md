# Changelog

## 1.2.1

- Renamed the desktop app to Hopline Terminal. Existing sessions, credentials, log directories and administrative policy paths carry forward.

## 1.2.0 · 2026-11-27

- Use OpenAI or Gemini API keys, or sign in with ChatGPT or GitHub Copilot, in addition to Ollama and Anthropic.
- Try packet filtering offline using the [two-frame DNS example](docs/examples/dns-failure/README.md). The bundled decoder includes the Wireshark 4.6.10 security fixes. The installer toolchain uses a patched version of minimatch.

- Settings now groups workspace, assistant, connection and terminal preferences on dedicated pages. Choose **Show tips** for field explanations. **Help → Workspace tour** introduces saved sessions, the terminal, chat and packet attachments.

- Ask the workspace assistant for help before connecting. It suggests saved devices, carries a diagnostic question into the session you select, and can bring device or packet findings back into a follow-up. Open connections now stay in the left sidebar.

- Exclude the simulator from production packages and hide legacy simulator bookmarks and their unused login in upgraded profiles, including session pickers and fleet lookups.

- Drop a PCAP or PCAPNG into the Assistant to discuss it without a live session. Hopline includes the offline decoder and can also collect and transfer captures from devices. The packet view includes Wireshark display filters, protocol counts, frame details and optional AI-assisted troubleshooting. [Packet capture guide](docs/guide/packet-capture.md)

## 1.1.0 · 2026-11-26

- AI requests replace recognized device names, management hosts, session tags and interface descriptions with temporary aliases. This includes chat, fleet investigations and replayed tool results. See the [privacy guide](docs/guide/privacy.md#assistant-requests) for examples and coverage.
- Update checks keep the rollout identifier on the device. Notifications open the GitHub release repository configured when the app was built.
- Quick Connect keeps keyboard focus when opened immediately after closing connection details. A dialog opened from the command palette responds to the first Escape. Screen readers announce the returning prompt when successive commands end at the same device.
- [Troubleshooting examples](docs/examples/) document routing evidence, change review and rollback in the desktop app.

## 1.0.1 · 2026-11-26

- Fresh installations open with an empty device inventory. The simulator runs in development and tests.
- Resize a terminal table from its top edge or a multi-device results window from its lower-right corner. Both remember their size and support keyboard resizing.
- Windows x64 installer, Linux x86-64 AppImage and Debian package.

## 1.0.0 · 2026-11-26

Hopline’s first stable release brought SSH, Telnet and serial sessions into a split-pane workspace. Engineers can parse command output, compare devices and investigate with an optional guarded assistant. Configuration proposals include the commands, rollback and verification.
