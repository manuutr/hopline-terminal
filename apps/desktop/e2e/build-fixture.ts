import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json'

/** Fixtures own a separate Electron app. Packaging only ever consumes out/. */
export default function buildFixture(): () => void {
  const desktop = join(__dirname, '..')
  const builds = join(desktop, 'out-test')
  mkdirSync(builds, { recursive: true })
  const out = mkdtempSync(join(builds, 'run-'))
  const vite = join(require.resolve('electron-vite/package.json'), '../bin/electron-vite.js')
  execFileSync(process.execPath, [vite, 'build', '--mode', 'test', '--outDir', out], { cwd: desktop, stdio: 'inherit' })
  writeFileSync(join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'main/index.js' }))
  copyFileSync(join(desktop, 'dev-app-update.yml'), join(out, 'dev-app-update.yml'))
  process.env.HOPLINE_TEST_APP = out
  return () => rmSync(out, { recursive: true, force: true })
}
