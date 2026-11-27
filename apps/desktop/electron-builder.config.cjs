// electron-builder configuration (Phase 7). A JS file, not package.json "build", so signing can
// depend on which CI secrets exist (decision D6, docs/SIGNING.md): with no credentials every build
// is unsigned and nothing here fails.
//
// Scripts pass `--config electron-builder.config.cjs` and `--publish never`: CI uploads the files
// itself (one release job: .github/workflows/release.yml).

const env = (k) => {
  const v = (process.env[k] ?? '').trim()
  return v === '' ? undefined : v
}
const all = (...ks) => ks.every((k) => env(k) !== undefined)

// macOS: a Developer ID certificate (CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME in a keychain).
const macSigned = all('CSC_LINK') || all('CSC_NAME')
const macNotarize = macSigned && (all('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') || all('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'))
// Windows, one of: Azure Artifact Signing (formerly Trusted Signing), or SignPath (REST, scripts/signpath-sign.cjs).
const azure = all('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER')
const signpath = !azure && all('SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG', 'SIGNPATH_POLICY_SLUG')
// The updater checks a downloaded installer's Authenticode signature only against `publisherName`
// in app-update.yml. SignPath signs through a custom hook, so electron-builder cannot read the
// publisher from a certificate: without SIGNPATH_PUBLISHER (the certificate's exact CN) every
// update would install unverified. Refuse to build rather than ship that.
if (signpath && !env('SIGNPATH_PUBLISHER')) {
  throw new Error('SignPath signing is configured but SIGNPATH_PUBLISHER is not set: set it to the code signing certificate\'s subject CN (docs/SIGNING.md › SignPath), or updates would install without a signature check.')
}

const winSigning = azure
  ? {
      azureSignOptions: {
        publisherName: env('AZURE_SIGN_PUBLISHER'),
        endpoint: env('AZURE_SIGN_ENDPOINT'),
        codeSigningAccountName: env('AZURE_SIGN_ACCOUNT'),
        certificateProfileName: env('AZURE_SIGN_PROFILE')
      }
    }
  : signpath
    ? { signtoolOptions: { sign: './scripts/signpath-sign.cjs', signingHashAlgorithms: ['sha256'], publisherName: [env('SIGNPATH_PUBLISHER')] } }
    : env('SIGNPATH_PUBLISHER')
      ? // Signed later by the SignPath GitHub Action (docs/SIGNING.md): the publisher still goes into app-update.yml.
        { signtoolOptions: { publisherName: [env('SIGNPATH_PUBLISHER')] } }
      : {}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.hopline.app',
  productName: 'Hopline Terminal',
  copyright: 'Copyright © Hopline contributors. Apache-2.0.',
  directories: { output: 'release', buildResources: 'build' },
  files: [
    'out/**/*',
    '!**/node_modules/@goodtools/wiregasm/dist/*.gz',
    '!**/node_modules/cpu-features/**',
    // Phase 8 E3: the workspace packages are bundled into out/ by electron-vite; their sources (and
    // a developer's simulator host key) must not ride along in app.asar.
    '!**/node_modules/@hopline/**',
    '!**/packages/simulator/**',
    '!**/lab_host_key*',
    '!**/host_key*',
    // E6: ssh2's optional binding is built for Node, never loads under Electron (JS crypto is used).
    '!**/node_modules/ssh2/lib/protocol/crypto/build/**',
    // E9: build inputs and prebuilds for platforms Hopline does not ship.
    '!**/node_modules/better-sqlite3/{deps,src}/**',
    '!**/node_modules/@serialport/bindings-cpp/prebuilds/android-*/**'
  ],
  artifactName: 'Hopline-Terminal-${version}-${os}-${arch}.${ext}',
  asarUnpack: ['**/*.node'],
  // Electron fuses (RunAsNode, NODE_OPTIONS, --inspect off; app only from app.asar, asar integrity
  // where Electron supports it, cookie encryption): flipped before signing. scripts/fuses.cjs.
  // Phase 8 E4: licence texts of everything the app ships, main and renderer (scripts/notices.cjs).
  beforePack: './scripts/notices.cjs',
  extraResources: [{ from: 'out/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' }],
  afterPack: './scripts/fuses.cjs',
  // better-sqlite3 and serialport ship N-API prebuilds for every target (RELEASING.md).
  npmRebuild: false,
  // Auto-update (electron-updater): writes app-update.yml into the app and latest*.yml next to the
  // installers. Stable releases also write beta*.yml, so the beta channel gets them too.
  // The repo is private: see docs/SIGNING.md › "Update feed" before the first public release.
  publish: [require('./scripts/release-feed.cjs')()],
  generateUpdatesFilesForAllChannels: true,

  win: {
    executableName: 'hopline',
    // x64 only: NsisUpdater serves one installer per feed, so arm64 would need a combined
    // (twice as large) installer or its own feed. Windows on Arm runs the x64 build.
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    ...winSigning
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    deleteAppDataOnUninstall: false
  },

  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    // Unsigned builds are ad-hoc signed, or Apple Silicon reports the app as damaged. Hardened
    // runtime and notarization only make sense with a real Developer ID.
    identity: macSigned ? undefined : '-',
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: !!macNotarize,
    // macOS 15+ asks before an app talks to devices on the local network (most of a network
    // engineer's sessions); this is the text of that prompt.
    extendInfo: {
      NSLocalNetworkUsageDescription: 'Hopline Terminal connects to routers, switches and other devices on your network over SSH, Telnet and port forwards.'
    }
  },
  dmg: { sign: false },

  linux: {
    // CI builds AppImage, deb and rpm (dist:linux:all); dist:linux stays AppImage-only for local builds.
    target: ['AppImage', 'deb', 'rpm'],
    category: 'Network',
    icon: 'build/icons',
    maintainer: 'Hopline contributors',
    vendor: 'Hopline contributors',
    synopsis: 'AI-native terminal for network engineers',
    description: 'SSH, Telnet and serial client for network engineers, with a safety-first AI assistant.',
    executableName: 'hopline',
    syncDesktopName: true,
    desktop: {
      entry: {
        Name: 'Hopline Terminal',
        GenericName: 'Network terminal',
        Comment: 'SSH, Telnet and serial client for network engineers',
        Categories: 'Network;RemoteAccess;',
        Keywords: 'ssh;telnet;serial;console;terminal;network;cisco;router;switch;'
      }
    }
  },
  deb: { packageCategory: 'net', priority: 'optional' },
  rpm: { packageCategory: 'Applications/Internet' }
}
