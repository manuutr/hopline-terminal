import { app } from 'electron'
import { decode } from './packets/decode'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `hopline --smoke`: load the native modules the way the app does, print one line each, and exit
 * (0: all loaded). For release checks of a packaged build (RELEASING.md, release.yml), which can
 * no longer use `ELECTRON_RUN_AS_NODE` once the RunAsNode fuse is off.
 *
 * Touches no user data: it runs before the single-instance lock, the protocol registration and
 * normal application startup, opens only an in-memory database, and points userData at a throwaway folder that is
 * removed again. It never opens a window, a port or a connection.
 */
export function isSmoke(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--smoke')
}

export async function runSmoke(): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'hopline-smoke-'))
  app.setPath('userData', scratch)
  app.setPath('crashDumps', join(scratch, 'Crashpad'))
  let failed = 0
  const step = async (name: string, f: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      const detail = await f()
      process.stdout.write(`smoke ok   ${name}${detail ? ` (${String(detail)})` : ''}\n`)
    } catch (e) {
      failed++
      process.stdout.write(`smoke FAIL ${name}: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  if (app.isPackaged) await step('production inventory', () => {
    const root = app.getAppPath()
    if (__HOPLINE_DEV_LAB__ || ['node_modules/@hopline/simulator', 'packages/simulator'].some((path) => existsSync(join(root, path)))) {
      throw new Error('The build contains the development simulator')
    }
  })
  await step('better-sqlite3', async () => {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    db.close()
    return `sqlite ${row.v}`
  })
  await step('serialport', async () => {
    const { SerialPort } = await import('serialport')
    const ports = await (SerialPort.binding as { list: () => Promise<unknown[]> }).list()
    return `${ports.length} port(s)`
  })
  await step('ssh2', async () => {
    const ssh2 = await import('ssh2')
    return typeof ssh2.Client === 'function' ? 'client' : 'no client'
  })
  await step('packet decoder', async () => {
    await app.whenReady()
    // A saved Ethernet PCAP with a single UDP frame exercises the packaged WASM and data.
    const capture = Buffer.from('d4c3b2a1020004000000000000000000ffff00000100000000000000000000002a0000002a00000000000000000000000000000008004500001c0000000040110000c0000201c00002020035003500080000', 'hex')
    const result = await decode(capture, { filter: 'udp' }, new AbortController().signal)
    if (result.matched !== 1) throw new Error('Expected one matching UDP frame')
  })
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // best effort
  }
  process.stdout.write(failed ? `smoke: ${failed} failed\n` : 'smoke: ok\n')
  return failed ? 1 : 0
}
