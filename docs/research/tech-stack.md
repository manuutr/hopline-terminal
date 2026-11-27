# Hopline tech-stack research (late 2026)

Status: research notes, 2026-11-24. Versions come from `npm view` on that date. Release dates are the
publish time of the stable version, not npm's `time.modified`, which nightly or beta builds keep bumping.
Items marked **[tested]** were checked locally against this repo's `node_modules` (Electron 45.4.1, ssh2 1.17.0).
Items marked **[unverified]** need confirmation before we rely on them.

> **Stack correction.** The brief says xterm.js 5.x, but `apps/desktop/package.json` already pins
> `@xterm/xterm ^6.0.0` plus 6.x-era addons. This document assumes xterm 6. In 6 the canvas renderer
> is gone, so the choice is WebGL with a DOM fallback.

## Version snapshot

| Package | Latest | Released | License | Notes |
|---|---|---|---|---|
| electron | 45.4.1 | 2026-11-19 | MIT | in repo |
| @xterm/xterm | 6.0.0 | 2025-12-22 | MIT | 6.1.0 betas are being published |
| ssh2 | 1.17.0 | 2025-08-20 | MIT | master has unreleased changes, including Pageant removal |
| ssh-config | 5.3.1 | 2026-11-20 | MIT | active |
| serialport / @serialport/bindings-cpp | 13.0.0 / 13.0.1 | 2024-12 | MIT | slow release cadence; repo pushed 2026-01 |
| keytar | 7.9.0 | 2022-02-17 | MIT | **repo archived 2022-12** |
| @napi-rs/keyring | 2.1.2 | 2026-10-19 | MIT | maintained keytar replacement |
| electron-builder / electron-updater | 26.18.0 / 6.8.11 | 2026-10-20 (both) | MIT | in repo |
| @electron-forge/cli | 8.0.1 | 2026-09-29 | MIT | alternative |
| @sentry/electron | 8.4.0 | 2026-11-10 | MIT | built on @sentry/* 11.10 |
| @playwright/test | 1.65.1 | 2026-11-13 | Apache-2.0 | `_electron` is still "experimental" |
| txtfsm | 0.2.1 | 2026-10-26 | Apache-2.0 | young TS port of TextFSM |
| ntc-templates (PyPI) | 9.4.0 | — | Apache-2.0 | verified from the repo LICENSE |
| monaco-editor / @monaco-editor/react | 0.58.0 / 4.7.0 | 2026-11-23 / 2025-02-13 | MIT | |
| react-diff-viewer-continued | 4.4.0 | 2026-07-14 | MIT | peers include React 19 |
| diff2html / diff (jsdiff) | 3.4.56 / 9.0.0 | 2026-01-31 / 2026-04-13 | MIT / BSD-3 | |
| @codemirror/merge | 6.12.3 | — | MIT | |
| ollama (JS) | 0.6.4 | 2026-09-29 | MIT | |
| @node-rs/argon2 / patch-package / node-scp | 2.2.2 / 8.0.1 / 1.0.0 | 2026-10 / 2025-09 / 2026-09 | MIT | used in fallbacks below |
| telnet-stream | 1.1.0 | 2021 | **AGPL-3.0** | do not use |

---

## 1. xterm.js 6 and addons

### Recommendation

| Addon | Version | Use? | Why |
|---|---|---|---|
| `addon-webgl` | 0.19.0 | **Yes**, default renderer | Fastest renderer. Fall back to DOM on context loss. |
| `addon-fit` | 0.11.0 | **Yes** | Resize to the pane, then send window-change to SSH, NAWS to Telnet. |
| `addon-search` | 0.16.0 | **Yes**, with decorations | 6.0 added a SearchLineCache and fixed matching across wrapped lines. |
| `addon-web-links` | 0.12.0 | **Yes** | Route opens through `shell.openExternal` with an http/https allowlist. |
| `addon-serialize` | 0.14.0 | **Yes**, for restoring scrollback | Labelled experimental. Supports `scrollback`, `range`, `excludeAltBuffer` and `serializeAsHTML`. |
| `addon-unicode11` | 0.9.0 | **Yes** | Correct widths for emoji and CJK in banners and descriptions. Requires `allowProposedApi`. |
| `addon-unicode-graphemes` | 0.4.0 | Not yet | The README still says experimental, with "non-standard behaviour". Revisit later. |
| `addon-clipboard` | 0.2.0 | **Yes**, with a write-only provider | Handles OSC 52. Never let the remote host *read* the clipboard. |
| `addon-progress` | 0.2.0 | Optional | OSC 9;4 progress. Maps well to the taskbar progress bar during SCP/SFTP. |
| `addon-image` | 0.9.0 | No, or behind a flag | SIXEL and iTerm IIP. Network gear doesn't emit them. Costs memory (`storageLimit` defaults to 128 MB). |
| `addon-ligatures` | 0.10.0 | No | Reads font files through Node `fs`, which a sandboxed renderer doesn't have. Ligatures also mislead in configs (`!=`, `->`). |
| `addon-attach` | 0.12.0 | No | WebSocket transport, which we don't use. |
| `addon-canvas` | 0.7.0 (2024) | **Remove** | The canvas renderer was removed in 6.0 (xterm.js #5105). |
| `@xterm/headless` | 6.0.0 | Yes, in main or tests | Parses output without a DOM. Useful for the AI agent's "screen" view and unit tests. |

**Breaking changes in 6.0 that we need to handle** (from the official release notes):
- `overviewRulerWidth` moved to `overviewRuler.width`.
- The scrollbar and viewport now come from VS Code's base/ platform code, so scroll behaviour differs.
- The Alt to Ctrl+Arrow hack was removed (#5346). Bind Alt+Left/Right ourselves if we want word jumps.
- `windowsMode` and `fastScrollModifier` were removed.
- New in 6.0: DEC mode 2026 synchronized output, `onWriteParsed`, `reflowCursorLine`, and PuTTY-style ED2 handling (`scrollOnEraseInDisplay`). The ED2 option matters because users coming from PuTTY expect cleared screens to land in scrollback.

```ts
const term = new Terminal({
  allowProposedApi: true,          // required by unicode11 and search decorations
  scrollback: 20_000,              // see sizing note below
  fontFamily: 'JetBrains Mono Variable, monospace',
  scrollOnEraseInDisplay: true,    // PuTTY-like: cleared screens are kept in scrollback
  minimumContrastRatio: 4.5,       // helps with vendor colour schemes
  screenReaderMode: settings.a11y.screenReader,
  overviewRuler: { width: 10 },    // required for search match marks
});
term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
const search = new SearchAddon({ highlightLimit: 2000 });
term.loadAddon(search);
search.findNext(q, { decorations: {
  matchBackground: '#5a4b00', matchOverviewRuler: '#d4a017',
  activeMatchBackground: '#d4a017', activeMatchColorOverviewRuler: '#ffcc00' } });
search.onDidChangeResults(({ resultIndex, resultCount }) => setCounter(resultIndex + 1, resultCount));

term.open(el);
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());   // drop to the DOM renderer; re-create on next focus
  term.loadAddon(webgl);
} catch { /* WebGL2 unavailable (RDP or VM): DOM renderer */ }

// OSC 52: allow writes, refuse reads (a remote host could otherwise exfiltrate the clipboard)
// ctor is (base64?: IBase64, provider?: IClipboardProvider); undefined means the built-in Base64
term.loadAddon(new ClipboardAddon(undefined, {
  readText: async () => '',
  writeText: async (_sel, text) => window.hopline.clipboard.write(text), // via IPC; optionally confirm
}));
```

**Fallback:** if WebGL2 isn't available, use the built-in DOM renderer. The only alternative to xterm.js is a heavier native terminal widget, which isn't an option in Electron. xterm.js is what VS Code, Tabby and Hyper use.

### Persistent scrollback (serialize)
- On tab close or app quit, call `serialize.serialize({ scrollback: 5000, excludeAltBuffer: true })` and store the result in SQLite (a `session_snapshots` table, compressed with zlib). On reopen, `term.write(snapshot)` before attaching the live stream, with a dim "restored" separator after it.
- Keep this separate from **session logging**: a raw byte log or an ANSI-stripped text log, appended in main. That log is the audit trail. Serialization is only a UI convenience.
- Gotchas: serializing 20k lines of 200 columns takes a noticeable fraction of a second, so cap it. Serialized output contains escape sequences, so treat it as sensitive (it holds what was on screen, possibly secrets) and store it inside the encrypted profile.

### Performance tuning for heavy output (`show tech-support` or debug floods)
1. **Renderer:** WebGL. The DOM renderer is about 3 to 10 times slower on floods. **[unverified]** We should measure this; see §9.
2. **Batch IPC:** never send one IPC message per SSH `data` event. In main, coalesce into frames (flush every 16 ms or at 64 KB, whichever comes first). Send `Uint8Array`, not strings, because `term.write` accepts bytes and decodes UTF-8 itself. Use a dedicated `MessagePort` per session.
3. **Flow control:** xterm parses roughly 5 to 35 MB/s, and its internal write buffer **drops data beyond about 50 MB**. ssh2 lives in main and xterm in the renderer, so use the guide's ACK pattern across IPC instead of `pty.pause()`:
   ```ts
   // renderer
   let unacked = 0;
   port.onmessage = ({ data }) => {               // data: Uint8Array frame
     term.write(data, () => {
       unacked += data.length;
       if (unacked > 64 * 1024) { port.postMessage({ ack: unacked }); unacked = 0; }
     });
   };
   // main (per session)
   const HIGH = 512 * 1024, LOW = 128 * 1024; let inflight = 0;
   function send(frame: Buffer) { inflight += frame.length; port.postMessage(frame); if (inflight > HIGH) channel.pause(); }
   port.on('message', ({ data }) => { inflight -= data.ack; if (inflight < LOW) channel.resume(); });
   ```
   Pausing the ssh2 `Channel` stops consuming the SSH window, so the server throttles through normal SSH flow control. The guide's rule of thumb: keep HIGH at 500 KB or below so Ctrl+C stays responsive. Test with `yes` or a big `show run` followed by Ctrl+C.
4. **Scrollback size:** each cell costs about 12 bytes (3 × Uint32). 200 columns × 20,000 lines is about 48 MB per tab. Default to 10k to 20k lines, let users raise it per profile, and rely on session logs for unlimited history.
5. **Hidden tabs:** keep writing (state must stay correct), but WebGL does nothing until visible. For more than 20 tabs, consider disposing the WebGL addon on background tabs, because browsers cap live WebGL contexts at around 16.
6. Use `smoothScrollDuration: 0` (the default). Turn off `screenReaderMode` unless the user opts in.

### Screen-reader mode
`screenReaderMode: true` keeps an accessibility tree and a live region in sync with the buffer, which NVDA, JAWS, VoiceOver and Orca announce. It costs CPU on floods. Expose it as a setting, and auto-suggest it when `app.accessibilitySupportEnabled` is true. 6.0 fixed character positions in the a11y tree (#4879). Pair it with keyboard-reachable search, copy mode and tab switching.

Sources: [xterm.js 6.0.0 release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0), [flow control guide](https://xtermjs.org/docs/guides/flowcontrol/), addon READMEs on unpkg ([webgl](https://unpkg.com/@xterm/addon-webgl/README.md), [image](https://unpkg.com/@xterm/addon-image/README.md), [clipboard](https://unpkg.com/@xterm/addon-clipboard/README.md), [serialize](https://unpkg.com/@xterm/addon-serialize/README.md), [ligatures](https://unpkg.com/@xterm/addon-ligatures/README.md), [unicode-graphemes](https://unpkg.com/@xterm/addon-unicode-graphemes/README.md)), `typings/xterm.d.ts` in 6.0.0.

---

## 2. SSH with ssh2 1.17

**Recommendation:** stay on `ssh2@1.17.0` (MIT, by mscdex), **pinned exactly**, and run it in the main process or a `utilityProcess`. It is the only mature pure-JS SSH2 client. The last release was 2025-08, and master still gets commits (2026-08). **Fallback:** spawn the system `ssh` through `node-pty` for edge cases ssh2 can't handle (FIDO keys, GSSAPI, exotic certificates).

### Critical gotchas found by testing in Electron 45 [tested]
Electron's Node uses **BoringSSL**, not OpenSSL. ssh2 *advertises* some algorithms that then fail inside Electron:

| Algorithm | Node 24.11 (OpenSSL 3) | Electron 45 (BoringSSL) | Impact |
|---|---|---|---|
| `diffie-hellman-group1-sha1` | ok | **fails**: `getDiffieHellman('modp2')` gives "Unknown DH group" | Old IOS 12.x, ASA, and some switches can't connect |
| `ssh-dss` host keys | ok | **fails**: DSA verify returns `UNSUPPORTED_ALGORITHM` | Very old gear that has only DSA host keys |
| `chacha20-poly1305@openssh.com` | ok | missing | ssh2's native `sshcrypto.node` is built for Node and fails to load in Electron ("did not self-register") |
| `group14-sha1`, group-exchange-sha1, `aes*-cbc`, `3des-cbc`, `hmac-sha1/md5`, `ssh-rsa` (SHA-1) | ok | ok | — |
| `blowfish-cbc`, `arcfour*` | missing | ok | Electron is actually better here |
| `cast128-cbc` | missing | missing | rare |

These results come from ssh2's own `SUPPORTED_*` lists plus direct `crypto` calls under `ELECTRON_RUN_AS_NODE=1`. We haven't yet run a full handshake against a real legacy device: add container fixtures (old OpenSSH or Dropbear builds) to CI.

Fixes:
- **group1:** an explicit 1024-bit Oakley Group 2 prime through `crypto.createDiffieHellman(prime, 2)` **works** in Electron [tested]. Patch ssh2's `lib/protocol/kex.js` with `patch-package` so `DHExchange('modp2', …)` uses the explicit prime instead of `createDiffieHellmanGroup`. This is a small, contained patch.
- **ssh-dss:** patch in a BigInt DSA verifier (about 30 lines: w = s⁻¹ mod q, then v = (g^u1·y^u2 mod p) mod q). That's enough because we only *verify* server signatures and never sign with DSA. Otherwise, show a clear "device offers only DSA host keys; generate an RSA key on the device" error. Don't count on system `ssh` as a fallback: OpenSSH 10.0 removed DSA entirely, so a current system ssh won't connect either.
- **chacha20:** run `electron-builder install-app-deps` or `@electron/rebuild` so `sshcrypto.node` and `cpu-features` are built against Electron's ABI. Otherwise chacha20 is silently dropped. Connections still work, because AES-GCM and AES-CTR are fine. **[unverified]** We haven't tested rebuilding it against Electron 45 (the binding uses `nan`).
- **Pageant:** removed on ssh2 master after the 1.17.0 tag (commit "lib,util: remove pageant support", issue #1006). It still works in 1.17.0 (`agent: 'pageant'`), which is another reason to pin 1.17.0. Long-term path: Pageant has served a named pipe since PuTTY 0.75. `pageant --openssh-config <file>` writes an `IdentityAgent` line with the pipe path, which we can parse and pass as `agent`.

### Legacy algorithms profile (per host, opt-in, with a warning badge)
```ts
// NOTE: group1-sha1 and ssh-dss fail in Electron unless ssh2 is patched (see table above)
const legacy = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'] },
  cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'] },
  serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
  hmac: { append: ['hmac-sha1', 'hmac-md5'] },
};
conn.connect({ host, username, algorithms: profile.legacy ? legacy : undefined, readyTimeout: 20_000, keepaliveInterval: 15_000 });
```
Map OpenSSH config `KexAlgorithms +x`, `HostKeyAlgorithms +x` and `Ciphers +x` to `append`, and `-x` to `remove`. Log the negotiated algorithms with `debug` or the `handshake` event, and show them in the session info panel.

### Jump hosts (ProxyJump chaining via `sock` and `forwardOut`)
```ts
import { Client, ConnectConfig } from 'ssh2';
type Hop = ConnectConfig & { host: string; port?: number };

async function connectChain(hops: Hop[], verify: (hop: Hop, key: Buffer) => Promise<boolean>): Promise<Client[]> {
  const clients: Client[] = [];
  let sock: NodeJS.ReadableStream | undefined;
  for (const [i, hop] of hops.entries()) {
    const c = new Client();
    await new Promise<void>((resolve, reject) => {
      c.once('ready', resolve).once('error', reject)
       .on('keyboard-interactive', kbdInteractiveHandler(hop)) // MFA per hop
       .connect({
         ...hop, sock: sock as any,                 // undefined for the first hop means a TCP socket
         hostVerifier: (key: Buffer, cb: (ok: boolean) => void) => { verify(hop, key).then(cb, () => cb(false)); },
       });
    });
    clients.push(c);
    const next = hops[i + 1];
    if (next) {
      sock = await new Promise((res, rej) =>
        c.forwardOut('127.0.0.1', 0, next.host, next.port ?? 22, (err, stream) => (err ? rej(err) : res(stream))));
    }
  }
  return clients; // the last one is the target; on teardown, end() in reverse order
}
```
- Verify the host key **per hop**, using the hop's *logical* hostname and port as the known_hosts key, not 127.0.0.1.
- If a bastion forbids `direct-tcpip` (`AllowTcpForwarding no`), fall back to `exec('nc %h %p')` or `ssh -W`, as in the ssh2 README example.
- Close the inner client first. The outer `end()` kills the tunnel stream.

### Agent auth and agent forwarding
```ts
function defaultAgent(): string | undefined {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'; // Win32-OpenSSH, also used by 1Password
  return process.env.SSH_AUTH_SOCK;
}
// 1Password: macOS ~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock ; Linux ~/.1password/agent.sock
conn.connect({ ..., agent: profile.agentPath ?? defaultAgent(), agentForward: profile.forwardAgent === true });
```
- On Windows, a pipe path makes `createAgent` choose `OpenSSHAgent` over the pipe. `'pageant'` chooses `PageantAgent` in 1.17 only.
- On Windows, 1Password serves the Win32-OpenSSH pipe, so it conflicts with the "OpenSSH Authentication Agent" service, and users have to disable that service. Detect this and explain it. **[unverified]** This comes from community reports, not 1Password's config page.
- Electron apps launched from the macOS Dock **don't inherit `SSH_AUTH_SOCK`** from shell rc files. Fall back to `launchctl getenv SSH_AUTH_SOCK`, and offer a picker that includes the 1Password path.
- Agent forwarding is a security risk on shared jump hosts. Off by default, per host, shown as a badge.
- Custom agents (for example keys in our own vault, or a "confirm each use" prompt) can extend `BaseAgent`.

### Keyboard-interactive and MFA
Set `tryKeyboard: true`, or better, a custom `authHandler` that orders the methods (publickey, then agent, then keyboard-interactive, then password). Handle `keyboard-interactive(name, instructions, lang, prompts, finish)` by showing a modal per round. The server can ask several rounds (password, then Duo or RSA token). Respect `prompts[i].echo`. Pre-fill a password prompt only when its text matches `/password/i` and the profile has a stored password. Never auto-answer OTP prompts.

### SFTP, SCP and port forwarding
- **SFTP:** `conn.sftp()` gives the full API. `fastGet`/`fastPut` use parallel reads (concurrency defaults to 64, chunkSize to 32 KB). Use streams for progress. `ssh2-sftp-client` 12.1.1 (Apache-2.0) is a promise wrapper, but the raw API is enough.
- **SCP:** ssh2 has **no SCP**. Many network OSes (IOS, NX-OS, ASA, Dropbear) support SCP but not the SFTP subsystem. Options: `node-scp` 1.0.0 (MIT, depends on ssh2), which claims SCP plus SFTP "even when the server has no SFTP". It's young, so audit it. Or implement the source and sink protocol over `exec('scp -t <path>')` / `exec('scp -f <path>')` ourselves (about 150 lines: `C0644 <size> <name>\n`, data, `\0`, then ack). **Recommendation:** try SFTP first, fall back to our own SCP for uploads (firmware, config). Show the device-side prerequisites (`ip scp server enable`).
- **Local (-L):** `net.createServer(sock => conn.forwardOut(sock.remoteAddress, sock.remotePort, dstHost, dstPort, (e, ch) => e ? sock.destroy() : sock.pipe(ch).pipe(sock)))`. Bind to 127.0.0.1 by default.
- **Remote (-R):** `conn.forwardIn(bindAddr, port, cb)`, then `conn.on('tcp connection', (info, accept) => { const ch = accept(); ... net.connect(localPort) ... })`.
- **Dynamic (-D, SOCKS5):** not built in. Write a small SOCKS5 CONNECT server (no-auth, IPv4, IPv6 and domain address types, about 80 lines) whose CONNECT handler calls `forwardOut`. The `socksv5` package exists, but its last release was 0.0.6 in 2015.

### known_hosts and OpenSSH config
- ssh2 only gives you `hostVerifier(key)`. Everything else is up to us. Implement a known_hosts reader and writer that supports:
  - plain entries, including `[host]:port`
  - **hashed** `|1|base64salt|base64hmac` entries, which are HMAC-SHA1 of the hostname
  - `@cert-authority` and `@revoked` markers
  - multiple keys per host
  ```ts
  const matchHashed = (entry: string, host: string) => { const [, , salt, hash] = entry.split('|');
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64') === hash; };
  ```
  Store our own trust in SQLite, keyed by host, port and key type, with a fingerprint (SHA256 base64, like OpenSSH). Read the user's `~/.ssh/known_hosts` as a secondary source, and only write to it if the user opts in. On a key mismatch, **block** and show both fingerprints. Don't offer an easy "accept".
- **ssh-config 5.3.1 (MIT)**: `SSHConfig.parse(text).compute(host, { ignoreCase: true, matchExec: false })`. **Always pass `matchExec: false`**, because otherwise `Match exec` runs shell commands from the config file. The README never mentions `Include`, so assume it isn't resolved and expand it ourselves (glob, `~`, relative to `~/.ssh`) before parsing. Map `ProxyJump` (comma-separated, `user@host:port`), `ProxyCommand` (support only the `ssh -W`/`nc` patterns and warn on others), `IdentityFile`, `IdentityAgent`, `User`, `Port`, `HostKeyAlgorithms`, `KexAlgorithms` and `ServerAliveInterval`.
- ssh2 1.17 does not support OpenSSH user or host *certificates*. **[unverified]** Check the issue tracker before promising it. The fallback is system ssh.

Sources: [ssh2 README](https://github.com/mscdex/ssh2/blob/master/README.md) (algorithms, agent, forwardOut and jump-host example), [SFTP.md](https://github.com/mscdex/ssh2/blob/master/SFTP.md), [ssh2 #1006 Pageant removal](https://github.com/mscdex/ssh2/issues/1006), [ssh-config README](https://unpkg.com/ssh-config@5.3.1/README.md), [1Password agent config](https://www.1password.dev/ssh/agent/config/), [PuTTY Pageant OpenSSH interop](https://putty.cs.utah.edu/wishlist/win-pageant-openssh-interop.html), [node-scp](https://www.npmjs.com/package/node-scp).

---

## 3. Telnet

**Recommendation:** write our own client-side Telnet layer, about 300 lines in `packages/telnet`, over `net.Socket`. The npm options don't fit:
- `telnet-stream` is **AGPL-3.0**. Don't use it in a proprietary app.
- `telnet-client` 2.2.14 (MIT) is an expect-style automation client, not a byte-transparent terminal transport.
- `telnet-socket` 0.2.6 (BSD-2) is oriented toward BBS servers.

**Fallback:** fork `telnet-socket` (permissive license) for its RFC tables.

### Implementation checklist
- Write the parser as a state machine with states DATA, IAC, WILL, WONT, DO, DONT, SB and SB_IAC. Unescape `IAC IAC` to 0xFF in data, and escape 0xFF on send. Strip `\r\0`, and map Enter to `\r\0` or `\r\n` per profile (some gear wants CR-LF, BSD-style servers want CR-NUL).
- Use the **Q method from RFC 1143** for option state, so we never loop on WILL/DO storms. Track `us` and `him` as NO, YES, WANTNO or WANTYES per option.
- Options to support:
  - **ECHO (1, RFC 857):** accept `WILL ECHO` from the server, so the server echoes. On `WONT ECHO`, enable local echo in the UI. This is how login prompts hide passwords.
  - **SGA (3, RFC 858):** accept both directions. This gives character-at-a-time mode.
  - **TTYPE (24, RFC 1091):** answer `SB TTYPE SEND` with `IS "XTERM-256COLOR"`. Cycle through a list (`XTERM-256COLOR`, `XTERM`, `VT100`) on repeated SENDs.
  - **NAWS (31, RFC 1073):** send `IAC SB NAWS w_hi w_lo h_hi h_lo IAC SE` after `DO NAWS` and on every fit resize. Bytes equal to 255 inside SB must be doubled.
  - **BINARY (0, RFC 856):** accept, for UTF-8.
  - **NEW-ENVIRON (39, RFC 1572):** refuse by default. It can leak `USER`.
  - **LINEMODE (34)**, TSPEED, XDISPLOC, AUTH and ENCRYPT: answer `WONT`/`DONT`.
- Initial offer: `IAC WILL NAWS`, `IAC WILL TTYPE`, `IAC DO SGA`, `IAC DO ECHO`. Some Cisco and terminal servers only negotiate after you send something, so also send them proactively.
- Terminal servers (Opengear, Lantronix, Cisco async lines on 2000+N ports) are mostly Telnet. Add a "raw TCP" mode with no IAC processing for ports that aren't really Telnet.
- Warn in the UI that Telnet is cleartext. Never auto-send stored passwords without a "this is cleartext" acknowledgement per host.

```ts
const IAC = 255, SB = 250, SE = 240, NAWS = 31;
function naws(cols: number, rows: number): Buffer {
  const b = [cols >> 8, cols & 255, rows >> 8, rows & 255].flatMap(x => (x === IAC ? [IAC, IAC] : [x]));
  return Buffer.from([IAC, SB, NAWS, ...b, IAC, SE]);
}
```

Sources: RFC 854, 855, 856, 857, 858, 1073, 1091, 1143 and 1572 (rfc-editor.org); [telnet-socket README](https://github.com/NuSkooler/telnet-socket); npm license metadata for telnet-stream and telnet-client.

---

## 4. Serial with `serialport` 13

**Recommendation:** `serialport@13` (MIT) running in **main or a utilityProcess**, never in the renderer. It ships N-API prebuilds in `@serialport/bindings-cpp` 13.0.1 for win32-x64, win32-ia32, win32-arm64, darwin-x64+arm64 (universal), linux-x64, linux-arm64 and linux-arm (glibc and musl). Because they're N-API, they are ABI-stable across Electron versions, so no Electron rebuild is needed. The project is maintained but releases are slow (last one 2024-12, repo pushed 2026-01). Pin it.

**Fallback:** Electron's built-in **Web Serial API**, using `session.on('select-serial-port')` plus `setPermissionCheckHandler`. It needs no native module and supports `setSignals({ break, dataTerminalReady, requestToSend })`, but flow control is only `none` or `hardware` (no XON/XOFF). Port metadata is weaker too.

```ts
import { SerialPort } from 'serialport';
const ports = await SerialPort.list(); // { path, manufacturer, serialNumber, vendorId, productId, pnpId, locationId }
const port = new SerialPort({ path: 'COM7', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
  rtscts: false, xon: false, xoff: false, hupcl: true, autoOpen: false });
port.open(err => ...);
// Break (Cisco ROMMON password recovery, Juniper): assert for ~300 ms, then release
async function sendBreak(ms = 300) {
  await new Promise<void>((r, j) => port.set({ brk: true }, e => (e ? j(e) : r())));
  await new Promise(r => setTimeout(r, ms));
  await new Promise<void>((r, j) => port.set({ brk: false }, e => (e ? j(e) : r())));
}
```
Gotchas:
- **Windows COM ports:** use the plain name (`COM10` works; the binding adds `\\.\`). `lock: false` is not supported on Windows. A port can be held by another app (PuTTY), so surface the "Access denied" error clearly.
- **USB-serial adapters:** match by `vendorId:productId`. FTDI is 0403, Prolific PL2303 is 067B, Silicon Labs CP210x is 10C4, WCH CH340 is 1A86. Show friendly names, and link to drivers for Prolific clones, which fail with "Code 10" on Windows 11. Re-scan on USB hot-plug. Poll `SerialPort.list()` every 2 s while the picker is open, because there is no cross-platform event.
- **Adapter unplug mid-session** emits `close` with `disconnected: true`. Offer auto-reconnect to the same `serialNumber`.
- **Flow control:** `rtscts` for hardware, `xon`/`xoff` for software. Most console ports are 9600 8N1 with no flow control. Juniper and Cisco are 9600, some Arista and Palo Alto are 9600 or 115200. Offer baud presets plus a "detect" helper that tries common rates and looks for printable output.
- **DTR/RTS:** some adapters reset devices on open (`hupcl`). Expose DTR and RTS toggles.
- **Linux:** the user must be in the `dialout` group (Debian/Ubuntu) or `uucp` (Arch). Detect EACCES and show the `usermod -aG` hint. Snap and Flatpak builds need extra permissions, which is another reason to prefer AppImage, deb or rpm.
- **macOS:** use `/dev/cu.*`, not `/dev/tty.*`, because tty waits for DCD. No entitlement is needed outside the Mac App Store sandbox.
- **Packaging:** electron-builder unpacks `.node` files from asar automatically. Verify `asarUnpack` covers `node_modules/@serialport/bindings-cpp/prebuilds/**`. If you run `install-app-deps` for other modules (better-sqlite3 and ssh2 need it), serialport is fine because the prebuilds are N-API.

Sources: [serialport install guide](https://serialport.io/docs/guide-installation), `@serialport/bindings-interface` typings (OpenOptions, SetOptions, PortInfo), and the `@serialport/bindings-cpp@13.0.1` tarball file list.

---

## 5. Secrets and keychain

**Recommendation:** keep **Electron `safeStorage`**, using the async API (which the repo already does in `apps/desktop/src/main/vault/index.ts`). Store the ciphertext in SQLite. Electron 45 **deprecates the sync API** (`encryptString`, `decryptString`, `isEncryptionAvailable`), and the docs say it **will be removed in Electron 46**.

**keytar:** last release 7.9.0 (2022-02). `atom/node-keytar` was **archived on 2022-12-12**. Don't use it.

**Fallback or alternative:** `@napi-rs/keyring` 2.1.2 (MIT, maintained, prebuilt N-API) for storing *individual* items in the OS keychain, for example a vault master key. `cross-keychain` 2.0.0 is newer and less proven.

Fixes needed in our vault:
- `decryptStringAsync` returns `{ result, shouldReEncrypt }`. When `shouldReEncrypt` is true (key rotation), re-encrypt and write the item back. The current code ignores it.
- **Linux without a keyring** (headless, i3/sway, WSLg, minimal distros): `getSelectedStorageBackend()` returns `basic_text`, meaning secrets are encrypted with a **hardcoded password**, which is effectively plaintext. The async API also has a Secret portal (Flatpak) and a fallback provider. **[unverified]** We haven't confirmed exactly which backend the async path selects, so test on a keyring-less VM. Policy:
  1. If the backend is `basic_text` (or unknown), **don't store secrets silently**. Offer to (a) keep secrets for this session only, or (b) set a **master password**: derive a key with `crypto.scrypt` (N=2^17, r=8, p=1) or Argon2id (`@node-rs/argon2`), encrypt items with AES-256-GCM, and lock after idle.
  2. Show the backend in Settings > Security.
- **macOS:** safeStorage depends on a valid code signature (see Electron's code-signing docs). Unsigned dev builds will show keychain prompts. The keychain item is bound to the signing identity, so changing the Team ID breaks decryption.
- **Windows:** DPAPI is per-user. Roaming profiles and a new machine mean secrets can't be decrypted. Make "export vault" use the master password, not DPAPI blobs.

Sources: [Electron safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage), [node-keytar README (archived)](https://github.com/atom/node-keytar), [Ray: replacing keytar with safeStorage](https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray), GitHub API (`archived: true`).

---

## 6. Auto-update

**Recommendation:** `electron-updater` 6.8.11 with electron-builder, publishing to **GitHub Releases** first. For more control and private beta channels, move to **S3 or Cloudflare R2 plus a CDN**, which electron-builder supports natively.

- **Windows:** only NSIS is supported for updates. **Differential updates** use blockmaps (`electronUpdaterCompatibility: ">=7"` gives blockmap v3), so a patch release downloads a few MB, not the full ~100 MB.
- **macOS:** needs the `zip` target next to `dmg`, because `latest-mac.yml` is generated from the zip. The app must be signed (Squirrel.Mac). The zip is also differential.
- **Linux:** AppImage self-updates (blockmap embedded). deb and rpm updates need `pkexec`/`sudo`, and are skipped for silent install-on-quit. rpm signature checks only happen with signed packages and `allowUnverifiedLinuxPackages: false`, which defaults to true. Linux updates are weak, so recommend AppImage for auto-update and deb/rpm through a package repo later.
- **Staged rollout:** edit `stagingPercentage: 10` in `latest.yml` after publishing, then raise it. electron-updater buckets users by a stable per-install ID. The docs site also describes **signed update manifests** (`sign-update-manifest`, `ERR_UPDATER_MANIFEST_SIGNATURE_INVALID`) and an `autoUpdater.crossOriginHeaders` setting. Neither exists in our installed 26.18 / 6.8.11 [tested by grepping `node_modules`]. Those pages describe v27, so revisit when we upgrade.
- **Windows signature check:** electron-updater verifies the new installer against `publisherName`. With Azure Artifact Signing, set it to the certificate subject's CN. A mismatch fails the update, which is a safety net but also a foot-gun when we change certificates.
- **Channels:** `autoUpdater.channel = 'beta'` together with `generateUpdatesFilesForAllChannels`. Build an **opt-out** in Settings, because enterprises will want `HOPLINE_DISABLE_UPDATES` or a policy file and a manual-download mode.

```ts
import { autoUpdater } from 'electron-updater';
autoUpdater.autoDownload = settings.updates.auto;
autoUpdater.allowPrerelease = settings.updates.channel === 'beta';
autoUpdater.on('update-downloaded', info => notifyRenderer('update-ready', info.version));
app.whenReady().then(() => setTimeout(() => autoUpdater.checkForUpdates().catch(log.warn), 10_000));
```
Never auto-restart while SSH sessions are open. Install on quit, or when the user clicks "restart" after a warning that lists the open sessions.

**Alternatives:**
- Electron's built-in `autoUpdater` with update.electronjs.org: free for public GitHub repos, but Squirrel.Windows only, not NSIS.
- Hazel or Nuts, self-hosted on Vercel. Thin, but less maintained.
- ToDesktop, a commercial service.

Stay with electron-updater.

Sources: [electron-builder auto-update](https://www.electron.build/docs/features/auto-update).

---

## 7. Packaging and code signing

### electron-builder vs Electron Forge
**Recommendation:** keep **electron-builder 26.18** (MIT), which is already configured. Reasons:
- It pairs with electron-vite, which builds `out/` while builder only packages.
- It has the strongest built-in updater (§6).
- It builds NSIS, dmg, zip, AppImage, deb and rpm from one config.
- Azure signing, notarization and blockmaps are built in.

Forge 8.0.1 (2026-09) is maintained by the Electron org and uses `@electron/osx-sign`, `@electron/notarize` and `@electron/windows-sign`. Electron's code-signing guide calls Forge the recommended tool on Windows. But Forge's updater story is Squirrel and update.electronjs.org, and switching would mean redoing packaging for little gain. **Fallback:** Forge with its Vite plugin, if builder stalls.

**Version gotcha:** the electron.build docs site already documents **v27** config. In v27, Azure moves to `win.sign: { type: 'azure' }`, and `hardenedRuntime`/`entitlements` move under `mac.sign`, while `notarize` stays on `mac`. Our installed 26.18 schema still uses `win.azureSignOptions` and `mac.hardenedRuntime` [tested against `app-builder-lib/scheme.json`]. Pin builder, and migrate deliberately.

### macOS (notarytool, hardened runtime, entitlements)
```jsonc
"mac": {
  "target": ["dmg", "zip"], "category": "public.app-category.developer-tools",
  "hardenedRuntime": true, "notarize": true,
  "entitlements": "build/entitlements.mac.plist",
  "extendInfo": { "NSLocalNetworkUsageDescription": "Hopline connects to network devices on your local network." }
}
```
- Notarization uses Apple's **notarytool** (altool is dead). In CI, use an App Store Connect **API key**: `APPLE_API_KEY` (path to the .p8, or its contents base64-encoded on one line), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. `APPLE_TEAM_ID` is ignored with API keys. Locally, use `APPLE_KEYCHAIN_PROFILE`.
- Entitlements: a custom plist **replaces** the defaults, so keep `com.apple.security.cs.allow-jit`. **Don't** add `allow-unsigned-executable-memory`. Add `disable-library-validation` only if we load native modules not signed by our team (electron-builder signs bundled `.node` files, so we shouldn't need it).
- **Local Network privacy** (macOS 15 and later): connecting to RFC 1918 or link-local devices triggers a permission prompt. Without `NSLocalNetworkUsageDescription`, connections can fail silently. This is critical for a network tool. **[unverified]** Check whether a Bonjour entry is also needed.
- Build a universal binary, or separate arm64 and x64 artifacts. Native modules (better-sqlite3, ssh2's sshcrypto) must be built for both. Simplest is separate arch builds, each on its own runner.

### Windows signing
- **Recommended: Azure Artifact Signing**, formerly *Trusted Signing*, renamed in 2026 with no functional change. It is cheap (about $10/month), keys stay in Microsoft's HSM, and it works in CI with an Entra app registration (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`).
  - **Eligibility:** Public Trust for *individuals* is limited to the US and Canada. Organizations need an identity validation that can take days. Free, trial and sponsored subscriptions are not supported.
  - Config in 26.18 (`WindowsAzureSigningConfiguration` in `scheme.json`): the required fields are `publisherName`, `endpoint`, `codeSigningAccountName` and `certificateProfileName`; `fileDigest`, `timestampDigest` and `timestampRfc3161` are optional. For example: `"win": { "azureSignOptions": { "publisherName": "<certificate subject CN>", "endpoint": "https://<region>.codesigning.azure.net", "codeSigningAccountName": "…", "certificateProfileName": "…" } }`. Copy `publisherName` exactly from the issued certificate's subject, because electron-updater compares it.
  - GitHub Action: `Azure/artifact-signing-action`, renamed from `trusted-signing-action`.
- **EV or OV certificates:** since 2023 the private keys must live in an HSM or token, so CI needs a cloud HSM (DigiCert KeyLocker, SSL.com eSigner, Google Cloud KMS) through `signtoolOptions` or a custom `sign` hook. **Since 2024, EV no longer gives instant SmartScreen reputation**; EV and OV both build reputation over downloads. Secondary sources agree on this, but there are outliers, so check Microsoft's docs. From **2026-03-01, certificates are valid for at most 460 days** (CA/B Forum ballot CSC-31), so plan yearly renewal. Azure rotates its short-lived certificates automatically.
- Sign everything: the app exe, the NSIS installer and uninstaller, and the `.node` binaries. Timestamp everything, so signatures survive certificate expiry.

### Linux
- **AppImage** for auto-update. **deb** and **rpm** for package managers. Set `"linux": { "target": ["AppImage", "deb", "rpm"], "category": "Network" }`.
- Gotchas:
  - Ubuntu 23.10 and later restrict unprivileged user namespaces through AppArmor, which can break Chromium's sandbox in AppImages. Ship an AppArmor profile in deb/rpm, and document the workaround for AppImage. Don't default to `--no-sandbox`.
  - Older AppImage runtimes need `libfuse2`, which isn't installed by default on Ubuntu 22.04 and later. **[unverified]** We haven't confirmed which runtime builder 26 uses.
  - deb/rpm installs should add a udev hint or post-install message about the `dialout` group for serial.
- Sign rpm (GPG) and set up a signed apt/yum repo later.

### CI with GitHub Actions
Native modules (better-sqlite3, ssh2 crypto) **can't be reliably cross-compiled**, so build each OS on its own runner:
```yaml
jobs:
  build:
    strategy: { matrix: { os: [windows-latest, macos-latest, macos-15-intel, ubuntu-22.04] } } # macos-latest is arm64 (macOS 26); macos-15-intel is x64; ubuntu-22.04 gives an older glibc baseline
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx electron-builder install-app-deps   # rebuild better-sqlite3 and ssh2 for Electron's ABI
      - run: npm run build -w @hopline/desktop
      - run: xvfb-run -a npx playwright test        # Linux; plain `npx playwright test` elsewhere
        if: runner.os == 'Linux'
      - run: npx electron-builder --publish onTagOrDraft
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY_B64 }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          CSC_LINK: ${{ secrets.MAC_CERT_P12_B64 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
```
Use GitHub OIDC federation to Azure, not a client secret, when possible. Publish as a **draft** release, smoke-test it, then promote. Pin action major versions.

Runner labels change: macOS 14 images were retired on 2026-11-02. As of now, x64 macOS is `macos-15-intel` or `macos-26-intel`, and arm64 is `macos-latest` (macOS 26). See [actions/runner-images](https://github.com/actions/runner-images).

Sources: [electron-builder notarization](https://www.electron.build/docs/features/code-signing/notarization), [mac signing](https://www.electron.build/docs/features/code-signing/code-signing-mac), [Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win), [Electron code signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Azure Artifact Signing](https://azure.microsoft.com/en-us/products/artifact-signing), [Artifact Signing quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart), [DigiCert on 460-day validity](https://www.digicert.com/blog/understanding-the-new-code-signing-certificate-validity-change), [Sectigo code signing FAQ](https://sectigo.com/signing-certificates/code-signing), [Azure/artifact-signing-action](https://github.com/Azure/artifact-signing-action).

---

## 8. Crash reporting (opt-in)

**Recommendation:** **`@sentry/electron` 8.4.0** (MIT, uses @sentry/* 11.10), self-hosted or SaaS, **initialised only after explicit consent**. It covers JS errors in main and renderer plus native minidumps. The default `SentryMinidump` integration uploads with full context; `ElectronMinidump` uses Electron's own uploader. **Fallback:** Electron's `crashReporter` alone, keeping minidumps local and uploading only on user action.

Design:
- **Consent:** first-run dialog with crash reports off by default and the choice stored in settings. Call `crashReporter.start()` early in main every launch with `uploadToServer: false`, so dumps are kept locally. Once started, it can't be stopped. Use `crashReporter.setUploadToServer(consent)`, and offer "send last crash report" from the dumps directory (`app.getPath('crashDumps')`). Sentry `init()` starts monitoring immediately, so only call it when consent is true. When the user opts in mid-session, init then, or apply it on the next launch.
- **Privacy scrubbing:** this matters a lot here, because terminal content can include configs, passwords and SNMP communities.
  - Never attach terminal buffers, session logs, hostnames or IPs, usernames, or AI prompts and responses.
  - Use `beforeSend` and `beforeBreadcrumb` (in main they apply to events from all processes) to strip IPv4 and IPv6 addresses, hostnames, file paths under the home directory, and anything matching `password|secret|community|key`.
  - Remove the **Console** and **Breadcrumbs** default integrations, because console logs can contain session data.
  - Set `dataCollection` to the minimum (v8 applies data-collection defaults that **include user identity**, so be explicit): `userInfo: false`, `cookies: false`, `httpHeaders: false`, `httpBodies: []`, `urlQueryParams: false`, `genAI: { inputs: false, outputs: false }`, and **`stackFrameVariables: false`**, because local variables can hold passwords. The 11.x core typings use `dataCollection`; there is no `sendDefaultPii`.
  - Don't use screenshots or Session Replay at all.
  - Use the `transportOptions` offline queue, with `maxAgeDays` kept short.
- Minidumps contain process memory, which **may include secrets on screen or in memory**. Tell users so in the consent text. A Sentry option to strip minidump memory isn't documented **[unverified]**.
- Use `electron-log` 5.4.4 for local logs, rotated, with a "Copy diagnostics" button that shows the user exactly what will be shared.

```ts
// main, early
crashReporter.start({ uploadToServer: false, compress: true });
if (settings.telemetry.crashReports) {
  Sentry.init({
    dsn, release: app.getVersion(),
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      genAI: { inputs: false, outputs: false }, stackFrameVariables: false },
    integrations: d => d.filter(i => !['Console', 'Breadcrumbs'].includes(i.name)),
    beforeSend: scrubEvent, beforeBreadcrumb: scrubCrumb,
  });
}
```

Sources: [Sentry Electron guide](https://docs.sentry.io/platforms/javascript/guides/electron/), [options](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/options/), [integrations](https://docs.sentry.io/platforms/javascript/guides/electron/configuration/integrations/), [Electron crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter).

---

## 9. E2E testing and benchmarking

**Recommendation:** **Playwright 1.65 `_electron`** (Apache-2.0). It's still labelled *experimental*, but it's stable in practice and supports Electron 21 and later. Use `@xterm/headless` and Vitest for parser and protocol unit tests. **Fallback:** WebdriverIO's `wdio-electron-service` 9.2.1 (last release 2025-10).

Patterns:
- **Test against fakes, not real gear:**
  - an in-process **ssh2 `Server`** fixture, configurable with keyboard-interactive, legacy algorithms and slow output
  - a scripted **Telnet** fixture (a `net` server that sends IAC sequences)
  - a **virtual serial** pair: `socat -d -d pty,raw,echo=0 pty,raw,echo=0` on Linux and macOS, com0com on Windows, or `@serialport/binding-mock` (10.2.2, 2022, old but simple)
- **Reading the xterm buffer:** in E2E builds only, built with `electron-vite build --mode e2e`, expose a read-only hook from the renderer. Use one build-time gate, so release bundles don't contain the hook at all. Don't use DOM scraping: WebGL renders to a canvas, so there's no text in the DOM.
```ts
// renderer (compiled in only when built with --mode e2e)
if (import.meta.env.MODE === 'e2e') (window as any).__hopline = { readBuffer: (id: string) => {
  const b = terms.get(id)!.buffer.active; const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)!.translateToString(true));
  return out.join('\n'); } };

// test
import { _electron as electron, expect, test } from '@playwright/test';
test('ssh login shows prompt', async () => {
  const app = await electron.launch({ args: ['out/main/index.js'] }); // out/ built with --mode e2e
  const win = await app.firstWindow();
  await win.getByRole('button', { name: 'Connect' }).click();
  await expect.poll(() => win.evaluate(() => (window as any).__hopline.readBuffer('s1'))).toContain('router1#');
  await win.keyboard.type('show version\r');   // xterm's hidden textarea receives the keys
  await app.close();
});
```
- Stub native dialogs with `app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp/x'] }) })`. Playwright doesn't intercept them.
- If launch hangs, make sure the `EnableNodeCliInspectArguments` fuse isn't disabled in E2E builds. Keep fuses strict in release builds, and test a separately built E2E variant.
- On Linux CI, run under `xvfb-run`. WebGL may fall back to software or DOM there, so test both renderers.

**Throughput benchmark:**
- An in-app hidden "bench" command streams N MB (for example a 100 MB `show tech` capture, plus random ANSI colour noise) from main through the real IPC path.
- Measure from first byte to the final `term.write` callback, and report MB/s, peak renderer memory, and dropped frames (`requestAnimationFrame` gaps).
- Run it in CI on fixed hardware, with a regression threshold of about 10%.
- Also measure Ctrl+C latency under flood: the time from keypress until output stops.
- The xterm.js repo's own benchmarks (`xterm-benchmark` 0.3.2 on npm, 2026-04) can cover parser-only numbers.

**Startup benchmark:**
- Add `performance.mark` and `process.hrtime` marks at main entry, `app.ready`, `BrowserWindow` `ready-to-show`, first paint (renderer `requestAnimationFrame` after mount) and first terminal interactive.
- Report them through IPC, then assert in Playwright, for example a cold start to interactive under 1.5 s on the CI baseline.
- Use `contentTracing` or `--trace-startup` to dig into regressions.
- Main-process `require` cost matters. Lazy-load ssh2, serialport and the AI SDK.

Sources: [Playwright Electron API](https://playwright.dev/docs/api/class-electron), [xterm.js flow control guide](https://xtermjs.org/docs/guides/flowcontrol/) (throughput figures).

---

## 10. TextFSM in Node

**Recommendation:** use **`txtfsm` 0.2.1** (Apache-2.0, TypeScript, ESM and CJS). It's an independent port that targets Google TextFSM 2.1.0 behaviour, supports `Filldown`, `Required`, `List`, `Key`, `Fillup`, all actions and `CliTable` index lookup, and its compatibility is tested against **ntc-templates**. Run it in main or a worker. Bundle **ntc-templates** (Apache-2.0, verified in the repo LICENSE; PyPI 9.4.0) as data, keeping their `NOTICE`/LICENSE in our third-party notices.

Gotchas:
- **Python regex vs JS regex.** ntc-templates are written for Python `re`. Watch for `(?P<name>…)`, `\Z`, inline flags like `(?i)` mid-pattern, possessive or atomic constructs, and Unicode class differences. txtfsm says Python-specific regex "may not be fully compatible".
  - Build a CI job that runs **every ntc-templates test fixture** (`tests/<platform>/<command>/*.raw` against `*.yml`) through txtfsm, and keep a denylist of templates that fail.
  - Fall back to Python for those templates.
- The project is young (created 2026-08, 0 stars, a single maintainer). Pin it, vendor it if needed, and contribute fixes upstream.
- **Fallback:** run real Python TextFSM 2.1.1 (Apache-2.0) and ntc-templates in a **sidecar**. Options include a bundled `python-build-standalone` interpreter (about 30 MB) or a PyInstaller-built `hopline-parse` binary that speaks JSON over stdio. This gives 100% fidelity, at the cost of size and signing more binaries (notarize the bundled interpreter too).
- Pyodide in a worker is possible but heavy (more than 10 MB of wasm, slow cold start). Not recommended.
- For the AI agent: have it call a `parse_output(command, platform)` tool that uses `CliTable` with ntc's `index` file, so it gets structured rows, not raw text. That's better for both safety and token use.

Sources: [txtfsm README](https://github.com/yuyosy/txtfsm), [ntc-templates LICENSE](https://github.com/networktocode/ntc-templates/blob/master/LICENSE), PyPI metadata for ntc-templates 9.4.0 and textfsm 2.1.1.

---

## 11. Diff viewers for config backups

**Recommendation:** use the **Monaco DiffEditor** (`monaco-editor` 0.58 with `@monaco-editor/react` 4.7, MIT, React 19 peer ok). It's virtualized, so 50k-line configs are fine. It has side-by-side and inline modes, `hideUnchangedRegions` (collapse unchanged context), a minimap, search, and we can write a simple Monarch grammar for Cisco/Junos syntax highlighting.

Gotchas:
- `@monaco-editor/react` loads Monaco **from a CDN by default**. Call `loader.config({ monaco })` with the locally bundled package, or it fails offline and violates our CSP.
- Configure the workers through Vite's `?worker` imports.
- Monaco adds a few MB to the renderer bundle. Lazy-load the diff view.
- `@monaco-editor/react` hasn't had a release since 2025-02, but it's a thin wrapper and Monaco itself is active.

**Fallbacks:**
- `react-diff-viewer-continued` 4.4.0 (MIT, React 19 ok) for a lightweight inline diff in the change-review dialog, for example "AI proposes these 6 lines". It's not virtualized, so keep it to small diffs.
- `diff2html` 3.4.56 (MIT) with `diff` 9.0.0 (BSD-3) for **HTML export and reports** (emailing a change record), and for rendering unified diffs we store.
- `@codemirror/merge` 6.12.3 (MIT) if we ever switch to CodeMirror 6. It's lighter than Monaco and has good collapse of unchanged lines.

**Network-specific pre-processing** matters more than which widget we pick:
- Normalize before diffing. Strip volatile lines with per-vendor rules: `! Last configuration change at…`, `! NVRAM config last updated`, `ntp clock-period`, Junos `## Last commit:`, uptime and timestamps, `Building configuration...`, and `Current configuration : N bytes`.
- Optionally mask secrets (`password 7 …`, `secret 5 …`, `snmp-server community …`, `pre-shared-key`) in the display, keeping a toggle that requires a vault unlock.
- Offer a hierarchical or semantic diff (by Cisco parent and child stanza, or Junos path) as a later feature. It avoids "moved block" noise.

Sources: npm metadata and peerDependencies for monaco-editor, @monaco-editor/react, react-diff-viewer-continued, @git-diff-view/react, diff2html, diff and @codemirror/merge (checked 2026-11-24); [@monaco-editor/react loader config](https://github.com/suren-atoyan/monaco-react#loader-config).

---

## 12. Ollama (local LLM) tool calling

**API:**
- `POST http://localhost:11434/api/chat` with `model`, `messages`, `tools` (OpenAI-style `{ type: 'function', function: { name, description, parameters: JSONSchema } }`), `stream`, and `think`.
- The response puts `message.tool_calls[]` on the assistant message, each with `function.name` and `function.arguments` as an **already-parsed object** (not a JSON string, unlike OpenAI) and an `index`.
- Send results back as `{ role: 'tool', tool_name, content }`.
- Parallel tool calls are supported: one `tool` message per call.
- When streaming, accumulate `thinking`, `content` and `tool_calls` across chunks, then append one assistant message.
- There is also an OpenAI-compatible endpoint at `/v1/chat/completions` if we want one code path with cloud providers.
- JS client: `ollama` 0.6.4 (MIT).

```ts
import { Ollama } from 'ollama';
const ollama = new Ollama({ host: settings.ai.ollamaUrl }); // default http://127.0.0.1:11434
const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }];
for (let turn = 0; turn < 8; turn++) {
  const res = await ollama.chat({ model, messages, tools: TOOL_SCHEMAS, stream: false, options: { temperature: 0.2, num_ctx: 32768 } });
  messages.push(res.message);
  if (!res.message.tool_calls?.length) break;
  for (const call of res.message.tool_calls) {
    const args = ToolArgs[call.function.name].safeParse(call.function.arguments); // zod: models do hallucinate args
    const result = args.success ? await guard.run(call.function.name, args.data) : { error: args.error.message };
    messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(result) });
  }
}
```

**Models.** These have the `tools` capability tag on ollama.com (checked 2026-11-24): `qwen3` and `qwen3.8` (27B, about 7.4M pulls, plus thinking and vision), `gpt-oss` (thinking and tools), `gemma4` (thinking, tools and vision), `nemotron-3.5-lightning` (30B MoE, 3B active), `mistral-small3.2`, `granite4` and `llama3.1`. Quality rankings come from blogs and disagree, so treat them as directional only. Broadly, the **Qwen3 family** (8B to 32B) and **gpt-oss:20b** are the most-cited reliable local tool callers. Gemma 3 did **not** support tools; Gemma 4 does.
- **Default suggestion:** `qwen3.8:27b` or `gpt-oss:20b` on machines with 24 GB or more of (V)RAM, and a Qwen3 8B-class model on 16 GB laptops.
- **Fallback:** if tool calling is flaky for a model, use structured outputs (`/api/chat` with `format` set to a JSON schema) and parse a single "action" object per turn, or route the agent to Claude via `@anthropic-ai/sdk`, which is already a dependency.
- Build a small **in-repo eval**: about 30 network tasks (e.g. "show interfaces with errors on r1"), scoring tool choice, argument validity and refusal of unsafe actions. Run it per model, rather than trusting blog tables.

Gotchas:
- Ollama's default context is small. Set `options.num_ctx` explicitly, because long `show` outputs silently truncate otherwise.
- Avoid heavy quantizations (Q2/Q3), which degrade tool-call reliability. Prefer Q4_K_M or better.
- Keep tool schemas flat. Models struggle with deeply nested JSON Schema.
- **Always validate arguments with zod and route every call through `@hopline/guard`.** Local models are more prone to malformed or unsafe calls than Claude.
- Treat device output as untrusted data in prompts (prompt injection through banners and descriptions is real).
- Bind the default URL to `127.0.0.1`. If the user points at a remote Ollama, warn that device output (configs) leaves the machine.

Sources: [Ollama tool calling docs](https://docs.ollama.com/capabilities/tool-calling), [ollama.com tools-capable models](https://ollama.com/search?c=tools), library pages for qwen3, qwen3.8, gpt-oss, gemma4, nemotron-3.5-lightning, mistral-small3.2, granite4 and llama3.1, [Docker local tool-calling evaluation](https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/) (directional).

---

## Open items to verify
1. Async `safeStorage` backend selection on a keyring-less Linux box (does it report `basic_text`?).
2. Whether ssh2 1.17 can do OpenSSH certificate auth.
3. Whether macOS Local Network privacy needs only `NSLocalNetworkUsageDescription` or also Bonjour keys, for TCP to RFC 1918 hosts.
4. Which AppImage runtime electron-builder 26 uses (the libfuse2 dependency).
5. Measure WebGL vs DOM throughput on our bench, and pick the default scrollback from the measured memory use.
6. Run txtfsm against the full ntc-templates test corpus and record the failing templates.
