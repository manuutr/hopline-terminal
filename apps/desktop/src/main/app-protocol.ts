/**
 * The renderer's own origin, `app://hopline` (P8 M4). Served from out/renderer by main, instead of
 * a `file://` page: a file page's 'self' matches every local file, and with
 * GrantFileProtocolExtraPrivileges (now fused off) it could fetch them. This handler serves only
 * the files under the renderer directory, read with fs (not through the file protocol), and every
 * response carries the CSP, so workers get it too.
 */
import { protocol } from 'electron'
import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'hopline'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX = `${APP_ORIGIN}/index.html`

/**
 * The renderer's Content Security Policy. Must equal the meta tag in src/renderer/index.html (a
 * test checks): the meta tag covers the page in every build, this header covers the page and the
 * workers served over app://. The dev server gets its own, looser one (electron.vite.config.ts).
 * - style-src 'unsafe-inline': xterm and Monaco inject <style> elements at run time.
 * - img-src/font-src data:: the build inlines a small font subset and the select arrow as data: URIs.
 * - worker-src 'self': the TextFSM and Monaco editor workers are same-origin URL workers (no blob:).
 * - connect-src 'none': the renderer never fetches; everything goes through the preload bridge.
 */
export const RENDERER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
}

/** Must run before `app` is ready: the scheme is standard (so 'self' and relative URLs work) and secure. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
}

/**
 * The file under `root` that an app:// URL names, or null. Only `app://hopline/<path>`; the path is
 * decoded once and must stay inside `root`. Encoded separators, backslashes, NUL and `..` segments
 * are refused outright, before any resolution.
 */
export function resolveAppPath(root: string, raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST || u.username || u.password || u.port) return null
  const enc = u.pathname
  if (/%2f|%5c|%00/i.test(enc) || enc.includes('\\')) return null
  let path: string
  try {
    path = decodeURIComponent(enc)
  } catch {
    return null
  }
  if (path.includes('\0') || path.includes('\\') || path.split('/').some((s) => s === '..' || s === '.')) return null
  if (path === '/' || path === '') path = '/index.html'
  const base = resolve(root)
  const full = resolve(base, '.' + path)
  return full.startsWith(base + sep) ? full : null
}

/** Serve the renderer directory over app://. Anything else is a 404; nothing is listed. */
export function serveApp(root: string): void {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  protocol.handle(APP_SCHEME, async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 })
    const file = resolveAppPath(root, req.url)
    if (!file) return notFound()
    try {
      // A symlink placed in the renderer directory can't point the handler outside it.
      const [real, base] = await Promise.all([realpath(file), realpath(root)])
      if (!real.startsWith(base + sep)) return notFound()
      const body = await readFile(real)
      return new Response(req.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': RENDERER_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache'
        }
      })
    } catch {
      return notFound()
    }
  })
}
