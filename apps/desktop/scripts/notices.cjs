// Phase 8 E4: THIRD_PARTY_NOTICES.txt for what the app ships. Run by electron-builder (beforePack)
// and shipped through extraResources; `node scripts/notices.cjs` writes it by hand.
//
// It covers the main-process dependencies (they also carry their own LICENSE inside app.asar) and
// the renderer packages Vite inlines into out/renderer (devDependencies to npm, but they ship as JS),
// with every transitive dependency, plus the ntc-templates NOTICE (Apache-2.0 §4(d)) that the
// parsers bundle compiles in. A package without a licence file gets its declared licence line.

const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const app = join(__dirname, '..')
const root = join(app, '../..')

// devDependencies that end up in the renderer bundle (build tools, types and test tools do not).
const RENDERER = [
  '@fontsource-variable/geist',
  '@fontsource-variable/inter',
  '@fontsource-variable/jetbrains-mono',
  '@xterm/addon-fit',
  '@xterm/addon-search',
  '@xterm/addon-serialize',
  '@xterm/addon-web-links',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'class-variance-authority',
  'clsx',
  'cmdk',
  'lucide-react',
  'monaco-editor',
  'radix-ui',
  'react',
  'react-dom',
  'react-resizable-panels',
  'sonner',
  'tailwind-merge',
  'zustand'
]

function pkgDir(name, from) {
  for (let d = from; ; d = dirname(d)) {
    const c = join(d, 'node_modules', name)
    if (existsSync(join(c, 'package.json'))) return c
    if (dirname(d) === d) return null
  }
}

function collect() {
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  const seen = new Map()
  const queue = [...Object.keys(pkg.dependencies ?? {}), ...RENDERER].map((n) => [n, app])
  while (queue.length) {
    const [name, from] = queue.shift()
    const dir = pkgDir(name, from)
    if (!dir || seen.has(dir)) continue
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    seen.set(dir, p)
    for (const d of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) queue.push([d, dir])
  }
  return [...seen.entries()]
    .filter(([dir, p]) => !String(p.name).startsWith('@hopline/') && !dir.startsWith(join(root, 'packages')))
    .map(([dir, p]) => ({ dir, p }))
    .sort((a, b) => (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0))
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i

function notices() {
  const out = [
    'Hopline third-party notices',
    '',
    'Hopline includes the software listed below. Each entry gives the package, its version, its',
    'declared licence and the licence text it ships with.',
    ''
  ]
  const tpl = join(root, 'packages/parsers/templates')
  for (const f of ['NOTICE', 'LICENSE'])
    if (existsSync(join(tpl, f))) out.push('='.repeat(78), `ntc-templates (TextFSM templates, compiled into the app): ${f}`, '', readFileSync(join(tpl, f), 'utf8').trim(), '')
  const pkgs = collect()
  for (const { dir, p } of pkgs) {
    const licence = typeof p.license === 'string' ? p.license : (p.license?.type ?? 'see package')
    out.push('='.repeat(78), `${p.name} ${p.version} (${licence})`, '')
    if (p.name === '@goodtools/wiregasm') out.push('Decoder source and build instructions: https://github.com/good-tools/wiregasm/tree/' + p.gitHead, '')
    const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f))
    if (!files.length) out.push(`Licensed under ${licence}. ${p.homepage ?? p.repository?.url ?? ''}`.trim(), '')
    for (const f of files) out.push(readFileSync(join(dir, f), 'utf8').trim(), '')
  }
  return { text: out.join('\n') + '\n', count: pkgs.length }
}

function write(target = join(app, 'out/THIRD_PARTY_NOTICES.txt')) {
  const { text, count } = notices()
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  return { target, count }
}

// electron-builder hook (beforePack), shaped like fuses.cjs: the module is the hook.
async function beforePack() {
  // Guard direct electron-builder invocations as well as the dist scripts.
  for (const part of ['main', 'preload', 'renderer']) {
    const dir = join(app, 'out', part)
    for (const file of readdirSync(dir, { recursive: true })) {
      if (!/\.(?:js|cjs|mjs)$/.test(file)) continue
      if (/lab:start|Open the simulator lab|HOPLINE_SEED_PORTS|lab_host_key/.test(readFileSync(join(dir, file), 'utf8'))) {
        throw new Error('Development simulator found in ' + file + '. Run the production build before packaging.')
      }
    }
  }
  write()
}
module.exports = beforePack
Object.assign(module.exports, { RENDERER, collect, notices, write })

if (require.main === module) {
  const { target, count } = write(process.argv[2])
  console.log(`wrote ${target}: ${count} packages`)
}
