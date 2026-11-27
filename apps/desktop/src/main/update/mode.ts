import type { UpdateMode } from '@shared/privacy'

/**
 * Whether this install may install an update itself (`auto`) or only say one exists (`notify`).
 * Pure, so the rule is tested without Electron (privacy.ts feeds it the real facts).
 *
 * The rule (docs/SIGNING.md › "Which builds install updates"): **auto-install only when the
 * downloaded file's signature is checked before it runs.**
 * - Windows (NSIS): electron-updater checks the installer's Authenticode signature against
 *   `publisherName` in `resources/app-update.yml`. A build signed without one, or not signed at
 *   all, would accept any installer whose sha512 matches the feed, so it is notify-only.
 * - macOS: Squirrel.Mac checks the update is signed by the same Developer ID; an ad-hoc build
 *   cannot install one.
 * - Linux: electron-updater never checks an AppImage signature (the GPG `.asc` files are for
 *   people), so every Linux build is notify-only; deb and rpm would also need a root prompt.
 */
export interface UpdateModeFacts {
  platform: NodeJS.Platform
  /** macOS: signed with a Developer ID (checked lazily: it runs codesign). */
  macSigned: () => boolean
  /** Windows: the baked app-update.yml names the certificate's publisher. */
  winPublisher: () => boolean
  /** e2e only (dev builds): pretend the build can verify updates. */
  e2eAuto?: boolean
}

export function decideUpdateMode(f: UpdateModeFacts): UpdateMode {
  if (f.e2eAuto) return 'auto'
  if (f.platform === 'win32') return f.winPublisher() ? 'auto' : 'notify'
  if (f.platform === 'darwin') return f.macSigned() ? 'auto' : 'notify'
  return 'notify'
}

/** `publisherName:` in app-update.yml (a list or a scalar), with at least one non-empty value. */
export function hasPublisherName(appUpdateYml: string): boolean {
  const m = /^publisherName:[ \t]*(.*)$/m.exec(appUpdateYml)
  if (!m) return false
  if (m[1]!.trim() && m[1]!.trim() !== '[]' && m[1]!.trim() !== 'null') return true
  // A YAML list on the following lines: "  - CN".
  const rest = appUpdateYml.slice(m.index + m[0].length).split(/\r?\n/).slice(1)
  for (const line of rest) {
    if (/^\s+-\s*\S/.test(line)) return true
    if (/^\S/.test(line)) break
  }
  return false
}
