# Signing, notarization and the update feed

Decision D6: the signing pipeline is built and driven entirely by CI secrets. With no secrets, every build is unsigned (macOS ad-hoc signed), nothing fails, and the release carries SHA-256 sums. Add a secret and the next tagged build is signed. No code change is needed.

- The logic is in `apps/desktop/electron-builder.config.cjs`, which reads the environment, and in `.github/workflows/release.yml`, which maps secrets to the environment.
- Set the secrets as **environment secrets of the `release` environment** (GitHub › Settings › Environments › release), not as repository secrets: see [Protect the signing secrets](#protect-the-signing-secrets) for the exact steps.

## What to obtain, by platform

| Platform | Credentials or service | Build behavior without credentials |
| --- | --- | --- |
| Windows | An approved SignPath project or an Azure Artifact Signing Public Trust certificate profile | Unsigned installer. Windows identifies its publisher as unknown. |
| macOS | An Apple Developer Program membership, Developer ID Application certificate and notarization credentials | Ad-hoc signature for local testing. |
| Linux | A GPG release key | SHA-256 checksums accompany the packages. |
| Crash reports | A Sentry project or a self-hosted GlitchTip endpoint | A user or team policy can configure an endpoint. |

Windows and macOS signing are independent. Each signing service requires the maintainer to enroll and supply its own credentials.

## Windows

Use one of the two options. If both sets of secrets exist, Azure is used.

### Option A: SignPath Foundation (recommended for an OSS project)

1. Apply at <https://signpath.org/apply>. The project must be public with an OSI license; Hopline is Apache-2.0 (D2). The Foundation reviews the project, its open-source distribution and its build process. Publishing the installers alone does not establish eligibility. [Foundation conditions](https://signpath.org/terms)
2. In SignPath, create:
   - a project (slug, e.g. `hopline`);
   - a signing policy (e.g. `release-signing`);
   - an artifact configuration for a single PE file. Use "Portable Executable" (the hook sends one `.exe` at a time).
3. Create a CI user and copy its API token.
4. Set these secrets:

   | Secret | Value |
   | --- | --- |
   | `SIGNPATH_API_TOKEN` | The CI user's API token |
   | `SIGNPATH_ORGANIZATION_ID` | Your organization id (a GUID) |
   | `SIGNPATH_PROJECT_SLUG` | `hopline` |
   | `SIGNPATH_POLICY_SLUG` | `release-signing` |
   | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Optional. Leave it unset to use the project's default |
   | `SIGNPATH_PUBLISHER` | **Required.** The code signing certificate's subject CN, exactly as SignPath shows it (e.g. `SignPath Foundation`). The updater checks every downloaded installer against it |

How it works: electron-builder calls `apps/desktop/scripts/signpath-sign.cjs` for every file it signs (`hopline.exe`, the uninstaller, the installer). The hook submits the file through SignPath's REST API, waits for it (up to 15 minutes, for a manual approval), and writes the signed file back. Signing happens before `latest.yml` is written, so the update feed's hash matches the signed installer. The hook sends its API token only to the API's own origin: a status or download link pointing elsewhere is refused.

Why `SIGNPATH_PUBLISHER` is required (Phase 6–8 review, H1): electron-updater verifies a downloaded installer's Authenticode signature only against `publisherName` in the app's `resources/app-update.yml`. With a custom sign hook electron-builder cannot read the publisher from a certificate, so without this secret the file would have no `publisherName` and every update would install without a signature check. The config refuses to build in that case, and the release workflow fails a signed Windows build whose `app-update.yml` lacks `publisherName`. To find the CN: open a SignPath-signed `.exe` › Properties › Digital Signatures › Details › View Certificate › Subject `CN=`.

If SignPath Foundation requires its GitHub Action with origin verification instead of the REST API:
1. Sign the installer with `signpath/github-action-submit-signing-request` after `package (windows)`.
2. Run `node scripts/release/cli.mjs refresh <dir>`. It rewrites the sha512 and size in `latest.yml` for every changed file. Without this step, updates fail their checksum.
3. Still set `SIGNPATH_PUBLISHER` for the package build, even with the other `SIGNPATH_*` secrets unset: the config then writes `publisherName` into `app-update.yml` without signing. Without it the installed app is notify-only and never installs an update itself.

### Option B: Azure Artifact Signing (formerly Trusted Signing)

1. Check the eligible locations for your individual or organization identity. Create an Artifact Signing account in Azure, complete identity validation, then create a Public Trust certificate profile. [Microsoft setup and eligibility](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
2. Create an app registration (service principal) and give it the "Artifact Signing Certificate Profile Signer" role scoped to that certificate profile.
3. Set these secrets:

   | Secret | Value |
   | --- | --- |
   | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | The service principal |
   | `AZURE_SIGN_ENDPOINT` | E.g. `https://weu.codesigning.azure.net` (your account's region) |
   | `AZURE_SIGN_ACCOUNT` | The account name |
   | `AZURE_SIGN_PROFILE` | The certificate profile name |
   | `AZURE_SIGN_PUBLISHER` | The publisher name exactly as in the certificate (the CN) |

electron-builder signs through `azureSignOptions`, also before `latest.yml` is written.

## macOS: Developer ID, hardened runtime, notarization

**Local test build.** On a Mac with Xcode and its command-line tools, Node 24.11 or newer, and npm 11, run the following from the repository root.

```sh
npm ci
npm run dist:mac -w @hopline/desktop
```

The existing configuration writes separate DMG and ZIP files for Apple Silicon and Intel under `apps/desktop/release/`. With no signing credentials the app uses an ad-hoc signature for local testing. The ZIP files also supply the macOS updater. A hosted macOS runner or a Mac you control can produce these artifacts.

**Distributable build.** Use a Developer ID Application certificate and its private key, plus credentials to submit the build to Apple's notary service. Verify the Gatekeeper assessment, stapled ticket, and the packaged app's `--smoke` run before publishing. Test each architecture on compatible hardware or, for Intel on Apple Silicon, under Rosetta. The GitHub path also needs an enabled Release workflow and an available macOS runner. [Apple Developer ID](https://developer.apple.com/developer-id/) · [Electron signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing)


1. Join the Apple Developer Program as an individual or organization.
2. In Xcode or on developer.apple.com, create a **Developer ID Application** certificate. Export it with its private key as a `.p12` file with a password.
3. For notarization, either:
   - create an App Store Connect API key (Users and Access › Integrations › Keys, "Developer" role), which is recommended; or
   - create an app-specific password for your Apple ID.
4. Set these secrets:

   | Secret | Value |
   | --- | --- |
   | `MAC_CSC_LINK` | The `.p12`, base64 encoded (`base64 -i cert.p12`) |
   | `MAC_CSC_KEY_PASSWORD` | Its password |
   | `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | The `.p8` key, base64 encoded, with its key id and issuer id (recommended) |
   | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | The alternative to the API key |

With a certificate, the build uses the hardened runtime with `apps/desktop/build/entitlements.mac.plist` and is notarized when the notarization secrets exist. One run on the Apple Silicon runner builds arm64 and x64, so there is one `latest-mac.yml` with both.

**Entitlements.**
- `allow-jit` is for V8.
- The network-client, network-server (local port forwards), serial and USB entitlements only take effect inside the App Sandbox. Hopline does not enable the sandbox: it reads `~/.ssh`, writes logs anywhere and opens serial ports. They are listed so that a future Mac App Store build keeps working.
- Native modules are signed with the same Developer ID, so library validation stays on.

**Unsigned builds.**
- They are ad-hoc signed, so Apple Silicon does not report the app as damaged.
- Squirrel.Mac only installs an update signed by the same Developer ID, so an unsigned build checks for updates and links to the release page instead of downloading. `updateMode()` in `src/main/privacy.ts` checks this with `codesign`.

## Linux: GPG

1. Create a release key, for example `gpg --quick-gen-key "Hopline releases <you@example.org>" ed25519 sign 2y`.
2. Export it: `gpg --armor --export-secret-keys <fingerprint>`.
3. Set these secrets:

   | Secret | Value |
   | --- | --- |
   | `GPG_PRIVATE_KEY` | The armored secret key |
   | `GPG_PASSPHRASE` | Its passphrase (empty if none) |

4. Publish the public key's fingerprint in the README.

The release job:
- writes `SHA256SUMS.txt` and a `.sha256` next to each file;
- runs `scripts/release/gpg-sign.sh`, which creates `SHA256SUMS.txt.asc` plus one `.asc` per AppImage, deb and rpm, and exports `hopline-release-key.asc`.

The key is imported into a throwaway keyring and never touches the runner's keyring.

Users verify with:

```sh
gpg --import hopline-release-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Crash reports (D7)

1. Create a Sentry project (platform "Node.js") or a GlitchTip project and copy its DSN (`https://<public key>@<host>/<project id>`).
2. Set it as the `HOPLINE_SENTRY_DSN` secret. The build bakes it in through `electron.vite.config.ts`.

Reports stay **off** until a user turns them on, and they are scrubbed before they leave (`src/main/crash/scrub.ts`). The DSN's public key is not a secret: anyone can read it from the app. Sentry's "Allowed domains" and rate limits are the protection against abuse. Turn on **Data scrubbing** and **IP address scrubbing** in the Sentry project too. That is defence in depth, since Hopline already sends neither.

A user (Settings › Updates & privacy) or a team policy (`crashReportDsn`) can point reports elsewhere, for example to a self-hosted GlitchTip. A policy can also forbid crash reports (`disableCrashReports`).

### Native crash dumps (local files)

**A native dump is a copy of a Hopline process's memory.** It cannot be scrubbed: it can hold terminal output, commands, host names, a typed password, a decrypted credential or the vault's data key. So (Phase 6–8 review, M2):
- Crashpad only starts once the user has turned crash reports on (it is never started for a user who has not opted in), and it never uploads anything itself (`uploadToServer: false`). Each dump is sent only from Settings › Updates & privacy, after its own confirmation that names the destination.
- Dumps live in the app's own profile (`userData/Crashpad`); that folder is created owner-only (0700) and dump files are made 0600 on macOS and Linux. On Windows it is under the user's own `%APPDATA%`.
- **Turning crash reports off deletes every dump**, and so does a team policy with `disableCrashReports`. Crashpad cannot be stopped once it runs, so dumps written later in that run are deleted at quit or at the next start.
- **Dumps older than 7 days are deleted** at startup, at quit and whenever the setting changes (`DUMP_RETENTION_DAYS` in `src/main/crash/service.ts`). Seven days is long enough to send a dump a developer asks for, and short enough that a profile copy or backup rarely carries one.
- Settings has **Delete all** next to the list.
- Each report and each dump sent adds a metadata-only row to "What left this machine" (destination host, size, HTTP status, never the content).

## Which builds install updates

Auto-install happens only where the downloaded update's signature is checked before it runs (Phase 6–8 review, M1). Everything else is **notify-only**: Hopline says a new version exists and links to its release page, and never downloads or installs it.

| Build | Updates |
| --- | --- |
| Windows, signed, with `publisherName` in `app-update.yml` (Azure, or SignPath with `SIGNPATH_PUBLISHER`) | Download in the background, install at quit. electron-updater checks the installer's Authenticode publisher |
| Windows, unsigned (no signing secrets) | Notify-only |
| macOS, Developer ID signed | Download in the background, install at quit. Squirrel.Mac checks the same Developer ID |
| macOS, ad-hoc (no Developer ID) | Notify-only |
| Linux AppImage, deb, rpm | Notify-only. electron-updater never checks an AppImage signature (the GPG `.asc` files are for people), and deb/rpm would need a root prompt |

The rule is in `src/main/update/mode.ts`. Before signing secrets exist, update integrity would rest only on HTTPS plus whoever can publish a release; notify-only keeps that from becoming silent code execution on every install.

## Protect the signing secrets

The `package` and `release` jobs run in the GitHub Environment **`release`**, and only for tags `v*`. Put every signing, notarization, GPG and crash DSN secret there, not at repository level: GitHub then hands them only to jobs it has allowed to deploy to `release`, and its deployment rule (not the workflow file, which a branch can edit) decides that. Dispatching the workflow on a branch runs the tests only. Owner steps, once:

1. GitHub › the repository › **Settings › Environments › New environment**, name it `release`.
2. **Deployment branches and tags**: choose **Selected branches and tags** › **Add deployment branch or tag rule** › Ref type **Tag**, pattern `v*`. Remove any branch rule.
3. **Required reviewers**: where the repository plan supports this rule, select @manuutr as the reviewer. Leave **Prevent self-review** off so the sole owner can approve their own tagged run. On a private plan without environment reviewers, the owner-only tag ruleset, tag deployment policy and manual draft publication still apply.
4. Optional: **Wait timer** 0, and leave "Allow administrators to bypass" unticked.
5. **Environment secrets** › **Add environment secret**, one by one: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), the `AZURE_*` or `SIGNPATH_*` set (with `SIGNPATH_PUBLISHER`), `GPG_PRIVATE_KEY`, `GPG_PASSPHRASE`, `HOPLINE_SENTRY_DSN`.
6. **Settings › Secrets and variables › Actions › Repository secrets**: delete the same names there, so nothing outside the environment can read them.
7. **Settings › Rules › Rulesets › New tag ruleset**: target `v*` and restrict creation, updates and deletion. The bypass list contains only the owner, @manuutr.
8. Keep `HOPLINE_RELEASES_OWNER` / `HOPLINE_RELEASES_REPO` as repository variables; they are not secret.

Actions in `release.yml` are pinned by commit SHA (the tag is in a comment); update both together.

## Update feed

The desktop and installer read release information from `manuutr/hopline-terminal`. Stable builds use `latest*.yml` and beta builds use `beta*.yml`. Published releases can be read anonymously. Draft releases are visible to maintainers only.

Older private builds have a different feed embedded in the application. To migrate, download the public installer, verify its checksum and install it once. Future builds use the feed embedded at build time. Maintainers can override the default with the `HOPLINE_RELEASES_OWNER` and `HOPLINE_RELEASES_REPO` variables.
