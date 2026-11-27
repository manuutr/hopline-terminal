# Releasing Hopline

## Versioning

Git tags use `vX.Y.Z`. The GitHub release title is the version alone, for example `1.1.0`.

- Hopline 1.0.0 is the first stable release. Use a patch for compatible fixes, a minor version for compatible features and a major version for breaking changes. The 0.x tags preserve the development milestones.
- Work in progress carries the version in the desktop manifest, which Settings displays.
- Every package in the monorepo shares one version.

## Release access

@manuutr is the sole upstream writer. Contributors submit PRs from forks. Keep upstream write access and GitHub Apps with release-writing permissions limited to trusted publishers. GitHub gives users with write access the ability to publish releases, including for existing tags. The tag ruleset controls Git references.

## Cutting a release

1. Run `npm run typecheck`, `npm test` and `npm run e2e`. The desktop test runner builds a separate development fixture. Installers use the production bundle in `apps/desktop/out`. The packaging hook rejects an embedded simulator.
2. Move the Unreleased notes in `CHANGELOG.md` under the new version and date.
3. Bump every workspace:
   ```sh
   npm version 1.2.0 --workspaces --include-workspace-root --no-git-tag-version
   ```
4. Merge the version bump through a pull request. As @manuutr, fetch the updated `main` and create the version tag on the reviewed commit, for example `git tag -a v1.2.0 origin/main -m "1.2.0"` for desktop version 1.2.0. Push that specific tag. GitHub reserves creation, updates and deletion of `v*` tags for the owner.
5. With hosted runners and the `Release` workflow enabled, the owner’s tag starts a build. The workflow checks that the tagged commit belongs to `main` and matches the desktop package version. It then:
   - runs typecheck, unit tests and e2e on Linux, Windows and macOS;
   - packages on each OS (signed where the secrets exist, see [docs/SIGNING.md](docs/SIGNING.md));
   - writes one **draft** release with the installers, the update feeds (`latest*.yml`, `beta*.yml`), block maps, `SHA256SUMS.txt`, a `.sha256` per file and, with a GPG key, `.asc` signatures.

   As @manuutr, review the files and their checksums in the draft, then choose **Publish release**. A workflow rerun cannot replace an existing release. If an upload was interrupted, inspect the draft and add the missing verified assets before publishing.

   Local builds, when CI is not available:
   - Linux: `npm run dist:linux -w @hopline/desktop` produces `apps/desktop/release/Hopline-<version>-linux-x86_64.AppImage` plus `latest-linux.yml`. `dist:linux:all` adds deb and rpm (needs `rpmbuild`).
   - Windows: `npm run dist:win -w @hopline/desktop` (on Windows, or `scripts/win-local-build.cmd`).
   - macOS: `npm run dist:mac -w @hopline/desktop` (on macOS: arm64 and x64).
6. Start the next cycle: `npm version 1.3.0-dev.0 --workspaces --include-workspace-root --no-git-tag-version`.

## Staged rollout

electron-updater offers an update to the share of installs given by `stagingPercentage` in the feed files. Each install keeps a random id, so the same machines stay in or out.

1. Start small: run the `Release` workflow by hand (workflow_dispatch) **on the tag** (Run workflow › "Use workflow from" › Tags › `vX.Y.Z`) with `staging_percentage` set to, for example, 10. A tag push uses 100. Dispatched on a branch, the workflow only runs the tests: packaging and signing need a tag (the `release` environment, docs/SIGNING.md).
2. To widen it later, download the release's feed files and stamp them:
   ```sh
   node scripts/release/cli.mjs stage <dir> 50
   ```
   The feed files are `latest.yml`, `latest-mac.yml`, `latest-linux.yml` and `beta*.yml`.
3. Re-upload them with `gh release upload vX.Y.Z <dir>/*.yml --clobber`. 100 removes the key, so everyone gets the update.
4. To stop a bad rollout, stamp 0 and re-upload.

## Channels

- **Stable** reads `latest*.yml`.
- **Beta** reads `beta*.yml`. A version like `0.8.0-beta.1` is published as a prerelease. For a stable local release, provide the stable feeds under their beta filenames as well. electron-builder writes only the current channel for the GitHub provider.
- Hopline never downgrades. A user switching from beta to stable waits until stable passes their version.

## Updates never restart a session

- Downloaded updates install when Hopline quits.
- The status bar says "Update ready — restart when you're done". "Restart and install" in Settings is refused in main while any session is open.
- Only builds that verify the update before it runs install it themselves: signed Windows builds (with a publisher name in `app-update.yml`) and signed macOS builds. Every Linux package (AppImage, deb, rpm) and unsigned Windows and macOS builds are told about a new version and link to the release page. docs/SIGNING.md › "Which builds install updates".

## Packaging notes
- `better-sqlite3` and `serialport` ship N-API prebuilds that work in Node and Electron alike, so `npmRebuild` is off.
- `cpu-features` (an optional ssh2 speed-up) doesn't compile against Electron 45 and is left out; ssh2 works without it.
- The configuration is `apps/desktop/electron-builder.config.cjs`, a JS file so signing can depend on the environment. Every dist script passes `--publish never`: CI uploads the files itself.
- Signing (decision D6): CI secrets drive:
  - Windows: SignPath Foundation or Azure Artifact Signing;
  - macOS: Developer ID, hardened runtime and notarization;
  - Linux: SHA-256 sums and detached GPG signatures.

  Without credentials, builds are unsigned (macOS ad-hoc). What to obtain and which secrets to set: [docs/SIGNING.md](docs/SIGNING.md).
- If a file changes after electron-builder wrote the feeds (for example, signed by an external tool), run `node scripts/release/cli.mjs refresh <dir>` before uploading. Otherwise updates fail their sha512 check.
- Icons: edit `apps/desktop/build/icon.svg`, then run `npm run icons`, which regenerates png/ico/icns and the Linux set. Commit the outputs, so the Windows fallback needs no generation step.

### Smoke test and fuses
- Packaged builds flip Electron fuses in electron-builder's `afterPack` hook (`apps/desktop/scripts/fuses.cjs`), before signing:
  - off: `RunAsNode` (`ELECTRON_RUN_AS_NODE`), `EnableNodeOptionsEnvironmentVariable` (`NODE_OPTIONS`), `EnableNodeCliInspectArguments` (`--inspect`);
  - on: `OnlyLoadAppFromAsar`, `EnableCookieEncryption`, and `EnableEmbeddedAsarIntegrityValidation` on Windows and macOS (Electron does not check asar integrity on Linux).
- Check a build's fuses: `node apps/desktop/scripts/check-fuses.mjs <binary> <linux|win32|darwin>`. The binary is `release/linux-unpacked/hopline`, `release/win-unpacked/hopline.exe` or `release/mac*/Hopline.app`. For the AppImage itself: `./Hopline-*.AppImage --appimage-extract` and check `squashfs-root/hopline`.
- `ELECTRON_RUN_AS_NODE` no longer works on a packaged build, so the native-module smoke test is a hidden flag: `hopline --smoke` (on Linux without a display: `xvfb-run hopline --smoke`). It checks that the development simulator is absent, loads better-sqlite3, serialport and ssh2, and decodes one UDP frame with the bundled packet decoder. Each check prints a `smoke ok` line. It runs before the single-instance lock, the protocol registration and `ready`, with userData pointed at a throwaway folder, so it touches no user data and never opens a window or a connection. The release workflow runs both checks on every OS.

## Fallback: local builds when GitHub Actions can't run

Hopline used this process for v0.5.0 and the first stable release, v1.0.0, while hosted runners were unavailable. It produces native Windows and Linux packages. A macOS package requires a macOS runner.

1. Linux (WSL): `npm run build && npm run dist:linux -w @hopline/desktop` produces `apps/desktop/release/*.AppImage`.
2. Windows (from WSL, with Node and git installed on the Windows side):
   - `git bundle create /mnt/c/Users/<you>/hopline.bundle vX.Y.Z main`
   - `cmd.exe /c "%USERPROFILE%\path\to\scripts\win-local-build.cmd vX.Y.Z hopline.bundle"` (copy the script next to the bundle first)
   - Each run prints a new checkout location under the Windows temporary directory and the path to its verified installer. The script uses npm 11.6.2 and `--ignore-scripts`; electron-builder ships the N-API prebuilds for better-sqlite3 and serialport.
3. Smoke the Windows build: `win-local-build.cmd` ends with `win-unpacked\hopline.exe --smoke` and `check-fuses.mjs` (see "Smoke test and fuses" above). Exit code 0 means both passed; pipe through `| more` to see the lines, since `hopline.exe` is a GUI program.
4. Put the files in one folder:
   - the installers;
   - `latest*.yml` from each build. For a stable release, copy `latest.yml` to `beta.yml` and `latest-linux.yml` to `beta-linux.yml` if the builder omitted the beta feeds;
   - the `.blockmap` files.
5. Run `node scripts/release/cli.mjs sums <dir>` for `SHA256SUMS.txt` and the `.sha256` files.
6. With a release key, run `GPG_PRIVATE_KEY="$(gpg --armor --export-secret-keys <fpr>)" bash scripts/release/gpg-sign.sh <dir>`.
7. Create the release: `gh release create vX.Y.Z --verify-tag --title X.Y.Z --draft --notes-file notes.md <dir>/*`.
8. Review all uploaded assets before publishing. If a macOS build becomes available later, the owner can review and attach it manually.

## Runner availability

The 1.0.1, 1.1.0 and 1.2.0 Windows and Linux installers were built locally. When hosted CI or Release workflows are disabled, check the commit and tag locally and use the native package checks above. A pushed tag alone does not produce installers. Verify which platform assets actually exist before updating the download links.

For local Electron tests, use the platform setup and isolated fixtures in the [development guide](docs/contributing/development.md#tests).
