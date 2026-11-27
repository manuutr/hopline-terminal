# Troubleshooting and FAQ

## Installing and starting

**Windows says "Windows protected your PC".** The build is not code-signed yet. Check the file's SHA-256 against `SHA256SUMS.txt`, then choose More info › Run anyway. See [Getting started › Unsigned builds](getting-started.md#unsigned-builds).

**macOS says Hopline can't be opened.** Same cause. On macOS 15 and later: try to open it once, then System Settings › Privacy & Security › Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Hopline.app`. On earlier versions: right-click › Open. If connections to your devices fail on macOS 15 or later, allow Hopline under System Settings › Privacy & Security › Local Network.

**The AppImage does nothing.** Make it executable (`chmod +x Hopline-*.AppImage`). If it complains about FUSE, install `libfuse2` (Debian, Ubuntu) or `fuse-libs` (Fedora), or run it with `--appimage-extract-and-run`.

**Settings says "Could not check" for updates.** Hopline could not read the release feed (offline, a proxy, or the release repository is not reachable). Nothing else is affected. Linux packages and unsigned builds never install updates themselves; they link to the release page.

**The window looks wrong under WSL.** Hopline uses software rendering by default to avoid WSLg rendering artefacts. Set `HOPLINE_GPU=1` to enable WebGL for terminals and GPU compositing. In this mode Chromium draws the surrounding UI tiles on the CPU.

## Passwords and the vault

**Hopline keeps asking for passwords, or says the vault is session-only.** There is no OS keyring (common on WSL and minimal Linux desktops), so secrets can't be kept across restarts. Set a master password in Settings › Security. Hopline never falls back to storing secrets in plain text. For the assistant, you can also set `ANTHROPIC_API_KEY` in the environment.

**The vault is locked.** It locks after the auto-lock delay (15 minutes by default), on sleep and when the screen locks. Open sessions keep running; the next connect that needs a secret asks for the master password. Settings › Security › Auto-lock changes the delay (0 turns it off).

**I forgot the master password.** It can't be recovered: the secrets it protects are gone. Sessions, folders and settings are not encrypted with it and stay. Re-enter the passwords.

## Connecting

**"Host key changed".** The device presented a different key from the one you trusted. That is expected after a device is replaced or re-keyed, and is also what an interception looks like. Check the fingerprint with the device's owner before choosing Replace key and connect.

**An old IOS device refuses the SSH connection (no matching key exchange or cipher).** Make sure **Allow legacy algorithms** is ticked on the session's SSH tab (it is on by default).

**"Permission denied" on a serial port (Linux).** Add yourself to the serial group, then log out and back in: `sudo usermod -aG dialout $USER` (Debian, Ubuntu, Fedora) or `sudo usermod -aG uucp $USER` (Arch). On macOS, use `/dev/cu.*`.

**The session drops and reconnects.** Auto-reconnect is on by default. Lower the keep-alive (Settings › Connections, or per host with overrides) if a firewall drops idle sessions. Hopline does not reconnect after an authentication or host-key error, or after you type `exit`.

**A port forward does not start by itself.** Saved forwards that bind to anything other than loopback (`0.0.0.0`, a LAN address) never start on their own. Start them from the tab menu › Port forwarding.

## The assistant

**"Platform unknown — AI commands blocked".** Auto-detect could not identify the device, so every command Hopline would send is refused. Click **Set platform** in the status bar, or set it in the session dialog.

**The assistant says a command was blocked.** The guard refused it: it is on the deny-list, it is not provably read-only, or a team policy blocks it. The reason is in the panel and in the audit log. See [Safety and audit](safety-and-audit.md#the-classifier).

**The assistant can investigate but never proposes a change.** Read-only mode is on (the default). Turn it off from the status bar, the panel header, the palette or Settings. A team policy may lock it on; Settings then says "Managed by policy".

**"Another change is open on this device".** Only one change per device can be open. Confirm or roll back the first one (or close its tab) before the next.

**"State unknown — check the device".** Hopline could not read the device's state after a confirm or rollback, so it reports nothing it can't prove. Check the device yourself (for example `show system commit` on Junos or `show configuration sessions` on EOS). The change stays open with its undo.

**"The line may hold unsent text".** A command Hopline typed did not echo correctly and the line could not be shown empty. Clear the line yourself (Ctrl-U, Ctrl-C or Enter); Hopline types nothing on that tab until you do.

**A guarded command is refused because the session does not echo.** Type a letter at the prompt so Hopline can see the echo, or reconnect.

**Ollama: "Context too small".** The conversation does not fit the model's context window. Start a new conversation, or use a model with a larger window.

**Ollama: the panel shows "suggest mode".** The model has no tool calling, so it suggests commands for you to click instead of running them. Fleet investigations need a model with tool calling.

**Fleet: a device is excluded.** The view gives the reason: unknown platform, Telnet, a sign-in Hopline can't type in the background (no stored credential, or "ask every time"), or a duplicate name. Fix the session, or investigate that device from its own tab.

## FAQ

**Does Hopline send my configurations or sessions anywhere?** No, except what the assistant reads to answer your question (redacted, and recorded in What left this machine), and only to the provider you set up. See [Privacy](privacy.md).

**Can the assistant run `reload`, `write erase` or `configure replace`?** No. They are on the deny-list, which no approval or setting can override. Hopline uses `configure replace` itself only as the IOS-XE safety net's rollback, from a fixed template.

**Can I use Hopline without the assistant?** Yes. Without a provider nothing is sent to any model. A team policy with `"allowedProviders": []` turns it off for everyone.

**Does Ctrl+C copy?** No, it interrupts the device. Copy with `Mod+C` (Ctrl+Shift+C) or by selecting text.

**Where is my data?** In your profile: `~/.config/Hopline` on Linux, `~/Library/Application Support/Hopline` on macOS, `%APPDATA%\Hopline` on Windows. Session logs go to the log folder in Settings (`Documents/Hopline/logs` by default).

**How do I report a bug or a security problem?** Bugs: a GitHub issue. Security problems: privately, as described in [SECURITY.md](../../SECURITY.md).
