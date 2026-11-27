# Security policy

Hopline connects to network devices with your credentials and lets an AI model run commands on them. Its security model is designed so that neither a model, nor a device's output, nor a compromised window can change a device without your approval of the exact lines. If you find a way around that, we want to hear about it.

## Reporting a vulnerability

On the public repository, use GitHub’s private vulnerability reporting form. If you received access to a private copy, contact @manuutr through the private channel where access was arranged.

**[Report a vulnerability](https://github.com/manuutr/hopline-terminal/security/advisories/new)** (Security tab › Report a vulnerability)

Do not open a public issue, pull request or discussion for a security problem.

Include what you can of:

- the version (Settings shows it) and OS;
- what an attacker controls: a device's output, a crafted import or sync file, a model's answer, a local user, the network;
- steps to reproduce, ideally against the development simulator (`npm run sim` in a source checkout);
- what happens, and what you expected.

What to expect:

- an acknowledgement within 3 working days;
- an assessment, with a severity and whether we can reproduce it, within 10 working days;
- a fix released as a patch version, with credit in the changelog and the advisory if you want it. We will agree a disclosure date with you; the default is when the fix is released, and at most 90 days after the report.

## Opening the repository to public contributions

The repository owner keeps upstream write access and reviews contributions from forks. The branch and tag rules are available in **Settings → Rules → Rulesets**. GitHub applies a separate Actions policy to public forks. When switching visibility, the owner should verify these settings in the public repository:

- Under **Actions → General**, require workflow approval for **all external contributors**. Use GitHub-hosted runners for fork PRs. Keep the workflow token read-only by default and Actions PR approval disabled.
- Under **Advanced Security**, enable secret scanning, push protection and private vulnerability reporting. Check that the **Report a vulnerability** link above opens the private form.
- Under **Environments → release**, keep the tag-only `v*` deployment policy and add **@manuutr** as required reviewer. Keep signing keys in that environment.
- Check the active rules on `main` and `v*`, and review upstream collaborators, write-enabled deployment keys and installed apps before granting any publisher access.

## Checks you can run locally

From a checkout with Node and npm installed, run `npm audit` to check both application and build dependencies against the npm registry. To scan committed history with Gitleaks 8.30.1, run `gitleaks git --redact --log-opts=HEAD .`. The reviewed fingerprints in `.gitleaksignore` identify synthetic credentials in historical fixtures and matches on key parsing code. New commits are scanned independently. [Gitleaks release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)

The packet decoder embeds native library code compiled to WebAssembly. Check its Wireshark version against upstream security releases separately from npm audit. [Decoder provenance](third_party/wiregasm/README.md) · [Wireshark security advisories](https://www.wireshark.org/security/)

## Supported versions

The latest stable minor release receives security fixes. Include the affected release tag or source commit in your report.

| Version | Supported |
| --- | --- |
| 1.2.x | Yes |
| Earlier minors | No |

## In scope

Anything that breaks one of these promises:

1. **Nothing changes a device without approval.** The assistant, fleet workers, snippets, send to many, multi-device runs, block re-runs, backups and the auto-detect probe can only send what the guard classifies as read-only, unless you approve the exact configuration lines (and type the hostname for disruptive ones). The deny-list cannot be overridden.
2. **Enforcement is outside the window.** The packaged renderer runs under `app://hopline` with network connections and frames disabled. Main validates the sending frame. The renderer is sandboxed and untrusted. Main classifies every command and owns approvals, the audit log, credentials and host keys. The session host writes a Hopline-generated command only with an HMAC-signed verdict from main bound to that tab, command and device, and checks the deny-list again itself.
3. **Secrets never reach the model or the window.** Credentials are decrypted only in main. Device output is redacted before it reaches any prompt, the egress log or the window.
4. **Device text is data.** Device output reaches a model inside an untrusted frame that it cannot close, and no tool can bypass the guard, so injected instructions can at most ask for a command the guard refuses.
5. **Everything is audited.** Every command Hopline sends or refuses for you is in an append-only audit log. Commands and reasons are redacted before storage. A vault-derived HMAC allows correlation while the vault is unlocked. Every request to a model is in the egress log.
6. **Nothing leaves the machine unasked.** Only update checks (which you can turn off), assistant requests to the provider you chose, and crash reports you opted into.

Examples of what we want to hear about: a command the guard classifies as read-only that changes state on some platform; a way to get a configuration line, a deny-listed command or a net line past main or the session host; a redaction miss for a secret format; prompt injection that leads to anything other than a refused command; IPC payloads that main accepts but should not; path traversal in downloads, logs, imports or sync; an update that installs without its signature being checked on a build that claims to check it.

Out of scope: what you type into the terminal yourself (Hopline never filters it), attacks that need an already compromised OS account or a malicious team policy file written by an administrator, and denial of service by a device you connected to on purpose, unless it freezes the whole app.

## How it works

- [docs/ARCHITECTURE.md § 5 Security model](docs/ARCHITECTURE.md#5-security-model): processes, trust boundaries, guard enforcement points and the prompt-injection posture.
- [docs/guide/safety-and-audit.md](docs/guide/safety-and-audit.md): the classifier, read-only mode, the executor, redaction and the audit log, from the user's side.
- [docs/POLICY.md](docs/POLICY.md): the team policy file and how it fails closed.
- [docs/SIGNING.md](docs/SIGNING.md): code signing, the update feed and which builds install updates.
- [CONTRIBUTING.md › Security rules](CONTRIBUTING.md#security-rules): the rules every change must follow.
