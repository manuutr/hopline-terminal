import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { decideUpdateMode, hasPublisherName } from '../src/main/update/mode'

/** Phase 6–8 review: distribution (H1, M1, M3, M5). */

const require = createRequire(import.meta.url)
const root = join(__dirname, '..')
const CONFIG = join(root, 'electron-builder.config.cjs')

const SIGNPATH = { SIGNPATH_API_TOKEN: 't', SIGNPATH_ORGANIZATION_ID: 'o', SIGNPATH_PROJECT_SLUG: 'p', SIGNPATH_POLICY_SLUG: 'pol' }
const saved = { ...process.env }

function loadConfig(env: Record<string, string>): Record<string, unknown> {
  for (const k of Object.keys(process.env)) if (/^(SIGNPATH_|AZURE_|CSC_|APPLE_)/.test(k)) delete process.env[k]
  Object.assign(process.env, env)
  delete require.cache[require.resolve(CONFIG)]
  return require(CONFIG) as Record<string, unknown>
}

afterEach(() => {
  process.env = { ...saved }
  delete require.cache[require.resolve(CONFIG)]
})

it('uses the configured GitHub feed for release downloads', () => {
  const feed = loadConfig({ HOPLINE_RELEASES_OWNER: 'network-tools', HOPLINE_RELEASES_REPO: 'desktop-releases' })
  expect(feed['publish']).toMatchObject([{ provider: 'github', owner: 'network-tools', repo: 'desktop-releases' }])
  expect(() => loadConfig({ HOPLINE_RELEASES_OWNER: 'bad/path' })).toThrow(/GitHub names/)
})

describe('H1: SignPath-signed Windows builds name the publisher', () => {
  it('sets signtoolOptions.publisherName from SIGNPATH_PUBLISHER', () => {
    const c = loadConfig({ ...SIGNPATH, SIGNPATH_PUBLISHER: 'Hopline Contributors' })
    const win = c['win'] as { signtoolOptions?: { publisherName?: string[]; sign?: string } }
    expect(win.signtoolOptions?.sign).toBe('./scripts/signpath-sign.cjs')
    expect(win.signtoolOptions?.publisherName).toEqual(['Hopline Contributors'])
  })
  it('refuses to build when SignPath is configured without a publisher', () => {
    expect(() => loadConfig(SIGNPATH)).toThrow(/SIGNPATH_PUBLISHER/)
    expect(() => loadConfig({ ...SIGNPATH, SIGNPATH_PUBLISHER: '  ' })).toThrow(/SIGNPATH_PUBLISHER/)
  })
  it('Azure keeps its publisher; no secrets means unsigned and no error', () => {
    const az = loadConfig({ AZURE_TENANT_ID: 'a', AZURE_CLIENT_ID: 'b', AZURE_CLIENT_SECRET: 'c', AZURE_SIGN_ENDPOINT: 'd', AZURE_SIGN_ACCOUNT: 'e', AZURE_SIGN_PROFILE: 'f', AZURE_SIGN_PUBLISHER: 'Pub' })
    expect((az['win'] as { azureSignOptions?: { publisherName?: string } }).azureSignOptions?.publisherName).toBe('Pub')
    const none = loadConfig({})
    expect((none['win'] as Record<string, unknown>)['signtoolOptions']).toBeUndefined()
    // Signed afterwards by the SignPath GitHub Action: the publisher still reaches app-update.yml.
    const later = loadConfig({ SIGNPATH_PUBLISHER: 'Hopline Contributors' })
    expect(later['win']).toMatchObject({ signtoolOptions: { publisherName: ['Hopline Contributors'] } })
    expect((later['win'] as { signtoolOptions: { sign?: string } }).signtoolOptions.sign).toBeUndefined()
  })
  it('the release workflow passes SIGNPATH_PUBLISHER and fails a signed build without publisherName', () => {
    const wf = readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8')
    expect(wf).toContain("SIGNPATH_PUBLISHER: ${{ runner.os == 'Windows' && secrets.SIGNPATH_PUBLISHER || '' }}")
    expect(wf).toMatch(/HOPLINE_WIN_SIGNED[\s\S]*grep -q '\^publisherName:' release\/win-unpacked\/resources\/app-update\.yml/)
  })
})

describe('M1: auto-install only where the update is verified', () => {
  const facts = { macSigned: () => false, winPublisher: () => false }
  it('unsigned Windows, every Linux build and unsigned macOS are notify-only', () => {
    expect(decideUpdateMode({ ...facts, platform: 'win32' })).toBe('notify')
    expect(decideUpdateMode({ ...facts, platform: 'linux' })).toBe('notify')
    expect(decideUpdateMode({ ...facts, platform: 'darwin' })).toBe('notify')
  })
  it('signed Windows with a publisher and signed macOS install themselves', () => {
    expect(decideUpdateMode({ ...facts, platform: 'win32', winPublisher: () => true })).toBe('auto')
    expect(decideUpdateMode({ ...facts, platform: 'darwin', macSigned: () => true })).toBe('auto')
    // Even a "signed" Linux build: electron-updater never checks an AppImage signature.
    expect(decideUpdateMode({ platform: 'linux', macSigned: () => true, winPublisher: () => true })).toBe('notify')
  })
  it('reads publisherName from app-update.yml as electron-builder writes it', () => {
    expect(hasPublisherName('owner: x\nrepo: y\nprovider: github\npublisherName:\n  - Hopline Contributors\nupdaterCacheDirName: hopline-updater\n')).toBe(true)
    expect(hasPublisherName('publisherName: Hopline\n')).toBe(true)
    expect(hasPublisherName('owner: x\nrepo: y\nprovider: github\nupdaterCacheDirName: hopline-updater\n')).toBe(false)
    expect(hasPublisherName('publisherName:\nowner: x\n')).toBe(false)
    expect(hasPublisherName('publisherName: []\n')).toBe(false)
  })
})

describe('M3: Electron fuses', () => {
  const fuses = require(join(root, 'scripts/fuses.cjs')) as {
    (ctx: unknown): Promise<void>
    fuseValues: (p: string) => Record<string, boolean>
    fuseConfig: (p: string) => Record<string | number, unknown>
  }
  it('the builder config flips them in afterPack', () => {
    expect(loadConfig({})['afterPack']).toBe('./scripts/fuses.cjs')
  })
  it.each(['linux', 'win32', 'darwin'])('%s: RunAsNode, NODE_OPTIONS and --inspect off; asar-only and cookie encryption on', (p) => {
    const c = fuses.fuseConfig(p)
    expect(c['version']).toBe(FuseVersion.V1)
    expect(c[FuseV1Options.RunAsNode]).toBe(false)
    expect(c[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(c[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(c[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
    expect(c[FuseV1Options.EnableCookieEncryption]).toBe(true)
    // Asar integrity is checked by Electron on macOS and Windows only.
    expect(c[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(p === 'linux' ? undefined : true)
  })
  it('the afterPack hook hands that config to electron-builder', async () => {
    let got: unknown
    const ctx = { electronPlatformName: 'win32', packager: { addElectronFuses: async (_c: unknown, f: unknown) => void (got = f) } }
    await fuses(ctx)
    expect(got).toEqual(fuses.fuseConfig('win32'))
  })
  it('the release workflow checks the packaged fuses and smokes with --smoke, not ELECTRON_RUN_AS_NODE', () => {
    const wf = readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8')
    expect(wf).toContain('node scripts/check-fuses.mjs release/linux-unpacked/hopline linux')
    expect(wf).toContain('node scripts/check-fuses.mjs release/win-unpacked/hopline.exe win32')
    expect(wf).toContain('--smoke')
    expect(wf).not.toContain('ELECTRON_RUN_AS_NODE')
    const releasing = readFileSync(join(root, '../../RELEASING.md'), 'utf8')
    expect(releasing).not.toMatch(/ELECTRON_RUN_AS_NODE=1/)
    expect(readFileSync(join(root, '../../scripts/win-local-build.cmd'), 'utf8')).toContain('--smoke')
  })
  it('a packaged build ignores ELECTRON_RENDERER_URL and the e2e close shortcut', () => {
    const src = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    expect(src).toMatch(/const devUrl = app\.isPackaged \? undefined : process\.env\['ELECTRON_RENDERER_URL'\]/)
    expect(src).not.toMatch(/if \(process\.env\['ELECTRON_RENDERER_URL'\]\)/)
    expect(src).toContain("if (n > 0 && !(process.env['HOPLINE_E2E'] && !app.isPackaged)) {")
  })
})

describe('M5: signing secrets only reach tag builds', () => {
  const wf = readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8')
  it('package and release run only on tags, in the protected "release" environment', () => {
    for (const name of ['package', 'release']) {
      const j = wf.slice(wf.indexOf(`\n  ${name}:\n`))
      const head = j.slice(0, j.indexOf('steps:'))
      expect(head, name).toContain("if: startsWith(github.ref, 'refs/tags/v')")
      expect(head, name).toContain('environment: release')
    }
    expect(wf.slice(wf.indexOf('\n  test:\n'), wf.indexOf('\n  package:\n'))).not.toContain('secrets.')
  })
  it('checks the owner, reviewed source and version before signing, and creates a new draft', () => {
    const source = wf.slice(wf.indexOf('\n  release-source:\n'), wf.indexOf('\n  package:\n'))
    expect(source).toContain('github.actor == github.repository_owner && github.triggering_actor == github.repository_owner')
    expect(source).toContain('git merge-base --is-ancestor "$commit" refs/remotes/origin/main')
    expect(source).toContain('[[ "$TAG" == "v$version" ]]')
    expect(wf).toContain('needs: [test, release-source]')
    expect(wf).toContain('gh release create "$TAG" --draft --verify-tag')
    expect(wf).not.toMatch(/gh release (?:upload|edit)|--clobber/)
  })
  it('every action is pinned by commit SHA', () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThan(4)
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/)
  })
})

describe('M3: the benchmark-only unfused build can never be a release', () => {
  const { unfusedBench } = require(join(root, 'scripts/fuses.cjs')) as { unfusedBench: (env: Record<string, string | undefined>) => boolean }
  it('is off by default, on only when asked locally, and refused in CI or with signing credentials', () => {
    expect(unfusedBench({})).toBe(false)
    expect(unfusedBench({ HOPLINE_UNFUSED_BENCH_BUILD: '1' })).toBe(true)
    expect(() => unfusedBench({ HOPLINE_UNFUSED_BENCH_BUILD: '1', CI: 'true' })).toThrow()
    expect(() => unfusedBench({ HOPLINE_UNFUSED_BENCH_BUILD: '1', GITHUB_ACTIONS: 'true' })).toThrow()
    expect(() => unfusedBench({ HOPLINE_UNFUSED_BENCH_BUILD: '1', CSC_LINK: 'x' })).toThrow()
    expect(() => unfusedBench({ HOPLINE_UNFUSED_BENCH_BUILD: '1', SIGNPATH_API_TOKEN: 't' })).toThrow()
  })
  it('the release workflow and the dist scripts never set it', () => {
    expect(readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8')).not.toContain('HOPLINE_UNFUSED_BENCH_BUILD')
    expect(readFileSync(join(root, 'package.json'), 'utf8')).not.toContain('HOPLINE_UNFUSED_BENCH_BUILD')
  })
})

describe('Phase 8 M6/M7: no install scripts where the release signs; CI is read-only and SHA-pinned', () => {
  const release = readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8')
  const ci = readFileSync(join(root, '../../.github/workflows/ci.yml'), 'utf8')
  it('M6: the package job installs with --ignore-scripts', () => {
    const pkg = release.slice(release.indexOf('\n  package:\n'), release.indexOf('\n  release:\n'))
    const installs = [...pkg.matchAll(/run:\s*(npm (?:ci|install)\b.*)/g)].map((m) => m[1]!)
    expect(installs).toEqual(['npm ci --ignore-scripts'])
  })
  it('M7: ci.yml has a read-only token and SHA-pinned actions (tag in a comment)', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m)
    const uses = [...ci.matchAll(/uses:\s*(\S+)(.*)/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/)
      expect(rest, ref).toMatch(/# v\d/)
    }
  })
  it('E3/E6/E9: app.asar leaves out workspace sources, host keys and unused native build files', () => {
    const files = (require(CONFIG) as { files: string[] }).files
    const pkg = require(join(root, 'package.json'))
    expect(pkg.dependencies).not.toHaveProperty('@hopline/simulator')
    expect(pkg.devDependencies).toHaveProperty('@hopline/simulator')
    for (const g of ['!**/node_modules/@hopline/**', '!**/packages/simulator/**', '!**/lab_host_key*', '!**/host_key*', '!**/node_modules/ssh2/lib/protocol/crypto/build/**']) expect(files).toContain(g)
  })
  it('E7: no checkout persists the token', () => {
    for (const wf of [release, ci]) {
      const n = (wf.match(/uses: actions\/checkout@/g) ?? []).length
      expect((wf.match(/persist-credentials: false/g) ?? []).length).toBe(n)
    }
  })
})

describe('Phase 8 E4: third-party notices ship with the app', () => {
  it('electron-builder writes them before packing and ships them as a resource', () => {
    const c = loadConfig({})
    expect(c.beforePack).toBe('./scripts/notices.cjs')
    expect(c.extraResources).toEqual(expect.arrayContaining([{ from: 'out/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' }]))
  })
  it('they cover main and renderer packages with their licence text, and the ntc-templates NOTICE', () => {
    const n = require(join(root, 'scripts/notices.cjs')) as { notices: () => { text: string; count: number }; RENDERER: string[] }
    const { text, count } = n.notices()
    expect(count).toBeGreaterThan(50)
    for (const pkg of ['react', 'monaco-editor', '@xterm/xterm', 'ssh2', 'better-sqlite3', 'zod', '@fontsource-variable/inter'])
      expect(text.split('\n').some((l) => l.startsWith(`${pkg} `)), pkg).toBe(true)
    expect(text).toMatch(/ntc-templates .*NOTICE/)
    expect(text).toMatch(/Permission is hereby granted/) // the MIT text, not only its name
    expect(text).toMatch(/SIL OPEN FONT LICENSE/i)
    expect(text).not.toMatch(/^@hopline\//m)
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    for (const r of n.RENDERER) expect(pkg.devDependencies[r], r).toBeDefined()
  })
})
