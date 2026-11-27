/**
 * Smoke test: legacy SSH algorithms through SshTransport under REAL Electron (BoringSSL).
 *
 * The client (this script) runs under Electron. The legacy-only server runs in a plain `node` child
 * (scripts/legacy-sim.ts), because BoringSSL can't do the server half of group1 or DSA signing.
 *
 * Run (from the repo root):
 *   npm run smoke:legacy -w @hopline/transports            # Electron 45 (apps/desktop's binary)
 *   npm run smoke:legacy:node -w @hopline/transports       # plain Node, for comparison
 * or directly:
 *   cd apps/desktop && ELECTRON_RUN_AS_NODE=1 npx electron --experimental-transform-types \
 *     ../../packages/transports/scripts/legacy-smoke.ts
 *
 * `--experimental-transform-types` is needed because types.ts uses constructor parameter properties.
 * Set NODE=/path/to/node if the server child should use a specific Node binary.
 * It exits 0 only if every case connects through the shims and reaches the device prompt. It also
 * prints an *unshimmed* baseline (raw ssh2) to show what the shims fix. The baseline is
 * informational: it is expected to fail under Electron and pass under Node.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
import { legacyStats } from '../src/legacy/index.ts'
import { SshTransport } from '../src/ssh.ts'

type Mode = 'both' | 'kex' | 'hostkey'

const runtime = process.versions['electron'] ? `Electron ${process.versions['electron']} (Node ${process.versions.node}, BoringSSL)` : `Node ${process.versions.node} (OpenSSL ${process.versions.openssl})`
console.log(`legacy-smoke on ${runtime}`)

async function startServer(mode: Mode): Promise<{ port: number; child: ChildProcess }> {
  const script = fileURLToPath(new URL('./legacy-sim.ts', import.meta.url))
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(process.env['NODE'] ?? 'node', [script, mode], { stdio: ['pipe', 'pipe', 'inherit'], env })
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`legacy-sim exited with ${code}`)))
    createInterface({ input: child.stdout! }).once('line', resolve)
  })
  return { port: (JSON.parse(line) as { port: number }).port, child }
}

async function viaTransport(mode: Mode, port: number): Promise<string> {
  const before = { ...legacyStats }
  const notices: string[] = []
  let out = ''
  let hostKeyAlg = ''
  const t = new SshTransport({
    host: '127.0.0.1',
    port,
    username: 'admin',
    auth: { type: 'password', password: 'admin' },
    keepAliveSec: 0,
    size: { cols: 80, rows: 24 },
    readyTimeoutMs: 10_000,
    verifyHostKey: (k) => {
      hostKeyAlg = k.algorithm
      return 'accept'
    },
    prompter: { keyboardInteractive: async () => null, secret: async () => null }
  })
  t.on('notice', (n: string) => notices.push(n))
  t.on('data', (d: Buffer) => (out += d.toString('latin1')))
  await t.connect()
  const deadline = Date.now() + 5000
  while (!/core-sw1#$/.test(out)) {
    if (Date.now() > deadline) throw new Error('no device prompt')
    await new Promise((r) => setTimeout(r, 20))
  }
  t.end()
  const g1 = legacyStats.group1Exchanges - before.group1Exchanges
  const dss = legacyStats.dssVerifications - before.dssVerifications
  if (mode !== 'hostkey' && g1 !== 1) throw new Error('group1 shim did not run')
  if (mode !== 'kex' && dss !== 1) throw new Error('ssh-dss verifier did not run')
  const legacy = notices.filter((n) => n.startsWith('legacy algorithm')).map((n) => n.replace(/^legacy algorithm (\S+).*/, '$1'))
  return `host key ${hostKeyAlg}; negotiated legacy: ${legacy.join(', ')}; shim runs: group1=${g1} dss=${dss}`
}

/** Raw ssh2, no shims: what the app would get without packages/transports/src/legacy. */
function baseline(mode: Mode, port: number): Promise<string> {
  return new Promise((resolve) => {
    const c = new ssh2.Client()
    const done = (s: string) => {
      c.removeAllListeners()
      c.on('error', () => {})
      c.end()
      resolve(s)
    }
    c.on('ready', () => done('connected'))
    c.on('error', (e) => done(`FAILED: ${e.message}`))
    c.connect({
      host: '127.0.0.1',
      port,
      username: 'admin',
      password: 'admin',
      readyTimeout: 10_000,
      hostVerifier: () => true,
      algorithms: {
        kex: [mode === 'hostkey' ? 'diffie-hellman-group14-sha1' : 'diffie-hellman-group1-sha1'],
        serverHostKey: [mode === 'kex' ? 'ssh-ed25519' : 'ssh-dss'],
        cipher: ['aes128-cbc'],
        hmac: ['hmac-sha1']
      }
    })
  })
}

const modes = ['kex', 'hostkey', 'both'] as const
const labels: Record<Mode, string> = { kex: 'diffie-hellman-group1-sha1', hostkey: 'ssh-dss host key', both: 'group1 + ssh-dss' }
const servers = new Map<Mode, { port: number; child: ChildProcess }>()
let failed = 0
try {
  for (const mode of modes) servers.set(mode, await startServer(mode))
  // All baselines first: the ssh-dss verifier is installed process-wide on first SshTransport use.
  for (const mode of modes) console.log(`  ${labels[mode].padEnd(28)} unshimmed ssh2: ${await baseline(mode, servers.get(mode)!.port)}`)
  for (const mode of modes) {
    try {
      console.log(`  ${labels[mode].padEnd(28)} SshTransport:   OK (${await viaTransport(mode, servers.get(mode)!.port)})`)
    } catch (e) {
      failed++
      console.log(`  ${labels[mode].padEnd(28)} SshTransport:   FAILED: ${(e as Error).message}`)
    }
  }
} finally {
  for (const s of servers.values()) s.child.stdin!.end()
}
console.log(failed ? `${failed} case(s) FAILED` : 'all legacy cases OK')
process.exit(failed ? 1 : 0)
