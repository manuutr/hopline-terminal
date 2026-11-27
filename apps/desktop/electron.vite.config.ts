import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import pkg from './package.json'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const releaseFeed = createRequire(__filename)('./scripts/release-feed.cjs')() as { owner: string; repo: string }
const releasesUrl = `https://github.com/${releaseFeed.owner}/${releaseFeed.repo}/releases`
const shared = { '@shared': resolve(__dirname, 'src/shared') }
/**
 * The benchmark's own build (bench/run.mjs, HOPLINE_UNFUSED_BENCH_BUILD=1): Playwright drives the
 * packaged app over --remote-debugging-port, which every other packaged build refuses (P8 I4).
 * scripts/fuses.cjs refuses the switch in CI or with signing credentials, so a release never has it.
 */
const benchBuild: boolean = (createRequire(__filename)('./scripts/fuses.cjs') as { unfusedBench: () => boolean }).unfusedBench()

/**
 * The dev server's CSP (`npm run dev` only, never a build): Vite's HMR needs a websocket, and the
 * React refresh preamble is an inline script. Builds keep the strict one from index.html (P8 M4).
 */
const DEV_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const devCsp: Plugin = {
  name: 'hopline-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/, `$1${DEV_CSP}"`)
}

export default defineConfig(({ command, mode }) => {
  const lab = { __HOPLINE_DEV_LAB__: command === 'serve' || mode === 'test' }
  return {
    main: {
      // Workspace packages are bundled (they ship TS source); real deps stay external.
      plugins: [externalizeDepsPlugin({ exclude: ['@hopline/guard', '@hopline/cli-model', '@hopline/importers', '@hopline/transports', '@hopline/parsers', '@hopline/simulator'] })],
      resolve: { alias: shared },
      // Crash reports (D7): the DSN built into a release, from the CI secret; '' leaves reports without a
      // destination until the user or the team policy sets one.
      define: { ...lab, __HOPLINE_RELEASES_URL__: JSON.stringify(releasesUrl), __HOPLINE_SENTRY_DSN__: JSON.stringify(process.env['HOPLINE_SENTRY_DSN'] ?? ''), __HOPLINE_BENCH_BUILD__: JSON.stringify(benchBuild) },
      // The session host is a second entry: a utilityProcess that owns all device connections.
      build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), 'session-host': resolve(__dirname, 'src/session-host/index.ts'), 'packet-decoder': resolve(__dirname, 'src/main/packets/decoder-process.ts') } } }
    },
    preload: {
      define: lab,
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: shared },
      build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react(), tailwindcss(), devCsp],
      // Shown in Settings; bumped per release (see RELEASING.md).
      define: { ...lab, __APP_VERSION__: JSON.stringify(pkg.version) },
      resolve: { alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') } }
    }
  }
})
