// Electron fuses for packaged builds (Phase 6–8 review, M3). Flipped in electron-builder's afterPack
// hook, which runs after the app is copied and before anything is signed, so the signature covers
// the flipped binary. RELEASING.md › "Fuses"; scripts/check-fuses.mjs reads them back.
//
// What they close: `ELECTRON_RUN_AS_NODE=1 Hopline -e …` (arbitrary JS under Hopline's signature and
// its macOS TCC / Local Network grants), NODE_OPTIONS=--require, `--inspect` on main (which holds
// the vault key), and loading app code from outside app.asar.
const { FuseV1Options, FuseVersion } = require('@electron/fuses')

/** The fuse values, by name; `platform` is electron-builder's electronPlatformName. */
function fuseValues(platform) {
  return {
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    // Electron checks app.asar against the hash electron-builder embeds on macOS and Windows only;
    // on Linux there is nothing to check against, so the fuse stays at its default there.
    ...(platform === 'darwin' || platform === 'mas' || platform === 'win32' ? { EnableEmbeddedAsarIntegrityValidation: true } : {}),
    OnlyLoadAppFromAsar: true,
    // The renderer is served from app://hopline (src/main/app-protocol.ts), so file:// pages get no
    // extra privileges: no fetching other local files (P8 M4).
    GrantFileProtocolExtraPrivileges: false
  }
}

/** The @electron/fuses config for flipFuses / packager.addElectronFuses. */
function fuseConfig(platform) {
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: platform === 'darwin' || platform === 'mas' }
  for (const [name, on] of Object.entries(fuseValues(platform))) config[FuseV1Options[name]] = on
  return config
}

/**
 * The benchmark's own `--dir` build (bench/run.mjs) drives the packaged app with Playwright, which
 * needs `--inspect`: it asks for an unfused build with HOPLINE_UNFUSED_BENCH_BUILD=1. Never in CI
 * and never with signing credentials, so a release can never be built that way.
 */
function unfusedBench(env = process.env) {
  if (env.HOPLINE_UNFUSED_BENCH_BUILD !== '1') return false
  const signing = Object.keys(env).some((k) => /^(CSC_LINK|CSC_NAME|AZURE_CLIENT_ID|SIGNPATH_API_TOKEN|APPLE_ID|APPLE_API_KEY)$/.test(k) && (env[k] ?? '').trim() !== '')
  if (env.CI || env.GITHUB_ACTIONS || signing) throw new Error('HOPLINE_UNFUSED_BENCH_BUILD is for local benchmark builds only (not in CI, not with signing credentials)')
  return true
}

async function afterPack(context) {
  if (unfusedBench()) {
    console.log('  • fuses NOT flipped: local benchmark build (HOPLINE_UNFUSED_BENCH_BUILD=1). Do not ship this build.')
    return
  }
  await context.packager.addElectronFuses(context, fuseConfig(context.electronPlatformName))
}

module.exports = afterPack
module.exports.fuseValues = fuseValues
module.exports.fuseConfig = fuseConfig
module.exports.unfusedBench = unfusedBench
