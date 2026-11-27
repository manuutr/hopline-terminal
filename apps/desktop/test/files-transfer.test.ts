/**
 * File transfers end to end without Electron: main's TransferService and ForwardService, the
 * session host's TabFiles, and the simulator, wired by an in-process stand-in for the host process
 * (messages hop through setImmediate, like they would through the utilityProcess port).
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { Forwards, SshTransport } from '@hopline/transports'
import { deviceFs, startSim, type RunningSim } from '../../../packages/simulator/src/index.ts'
import type { AuditEntry } from '../src/main/db/audit'
import { TransferService, type FilesHost } from '../src/main/files/service'
import { ForwardService } from '../src/main/files/forwards'
import { childPath, safeLocalName } from '../src/main/files/paths'
import { TabFiles } from '../src/session-host/files'
import type { HostToMain, MainToHost } from '@shared/host-protocol'
import type { QueueResult, TransferEvent, TransferItem } from '@shared/files'
import type { Session } from '@shared/types'
import { FilesSchemas } from '../src/main/ipc/files'

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, dialog: {}, ipcMain: { handle: () => {}, on: () => {} }, nativeImage: {}, shell: {} }))

const root = mkdtempSync(join(tmpdir(), 'hopline-files-'))
const sims: RunningSim[] = []
afterAll(async () => {
  await Promise.all(sims.map((s) => s.close()))
  rmSync(root, { recursive: true, force: true })
})

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function fakeWc(events: TransferEvent[]): WebContents {
  return { isDestroyed: () => false, send: (ch: string, e: TransferEvent) => ch === 'transfer:event' && events.push(e) } as unknown as WebContents
}

async function connect(port: number): Promise<SshTransport> {
  const t = new SshTransport({
    host: '127.0.0.1',
    port,
    username: 'admin',
    auth: { type: 'password', password: 'admin' },
    keepAliveSec: 0,
    size: { cols: 80, rows: 24 },
    verifyHostKey: () => 'accept',
    prompter: { keyboardInteractive: async (r) => r.prompts.map(() => 'admin'), secret: async () => 'admin' }
  })
  t.on('data', () => {})
  await t.connect()
  return t
}

/** One tab on one simulated device, with main's services on top. */
/** Read-only mode as TransferService sees it (fix-round Low 5). */
let readOnlyNow = false

async function setup(platform: 'eos' | 'ios', sim: Parameters<typeof startSim>[0]['files']) {
  const s = await startSim({ device: platform, port: 0, files: sim, forwarding: true })
  sims.push(s)
  let link: SshTransport | null = await connect(s.port)
  const listeners = new Set<(m: HostToMain) => void>()
  const toMain = (m: HostToMain) => setImmediate(() => listeners.forEach((fn) => fn(m)))
  const files = new TabFiles({ ssh: () => link }, toMain)
  const fw = new Forwards()
  await fw.attach(link)
  const session = { id: 's1', name: `${platform}-lab`, host: '127.0.0.1', port: s.port, protocol: 'ssh', platform: platform === 'ios' ? 'ios' : 'eos', options: {} } as unknown as Session
  const events: TransferEvent[] = []
  const wc = fakeWc(events)
  const other = fakeWc([])
  const host: FilesHost = {
    owned: (tabId, sender) => (tabId === 'tab1' && (!sender || sender === wc) ? { session, wc } : undefined),
    request: <T,>(build: (id: number) => MainToHost) =>
      new Promise<T>((resolve, reject) => {
        const m = build(1)
        setImmediate(() => {
          const run = async (): Promise<unknown> => {
            if (m.t === 'files') {
              if (m.op.op === 'scp-directory') return files.listDirectory(m.op.path, m.op.platform, {})
              if (m.op.op === 'preview') return files.preview(m.op.path, m.op.platform)
              return m.op.op === 'open' ? files.open() : files.op(m.op)
            }
            if (m.t === 'xfer') return files.xfer(m.spec)
            if (m.t === 'fwd') {
              const op = m.op
              if (op.op === 'start') return fw.start(op.spec)
              if (op.op === 'stop') return fw.stop(op.fid)
              if (op.op === 'remove') return fw.remove(op.fid)
              return fw.list()
            }
            throw new Error(`unexpected ${m.t}`)
          }
          run().then((v) => resolve(v as T), reject)
        })
      }),
    send: (m) =>
      setImmediate(() => {
        if (m.t === 'xfer-data') files.data(m.xferId, m.d)
        else if (m.t === 'xfer-end') files.end(m.xferId)
        else if (m.t === 'xfer-ack') files.ack(m.xferId, m.n)
        else if (m.t === 'xfer-cancel') files.cancel(m.xferId)
      }),
    onHostMessage: (fn) => (listeners.add(fn), () => listeners.delete(fn))
  }
  const audit: AuditEntry[] = []
  const dl = mkdtempSync(join(root, 'dl-'))
  const svc = new TransferService({ host, audit: { append: (e) => audit.push(e) }, pickDir: async () => dl, readOnly: () => readOnlyNow })
  const fwd = new ForwardService(host, { append: (e) => audit.push(e) })
  fw.on('change', (list) => toMain({ t: 'fwd-state', tabId: 'tab1', forwards: list }))
  const finished = (id: string) =>
    new Promise<TransferItem>((resolve) => {
      const check = () => {
        const it = svc.list(wc).find((x) => x.id === id)
        if (it && ['done', 'error', 'cancelled'].includes(it.state)) return resolve(it)
        setTimeout(check, 10)
      }
      check()
    })
  const last = () => svc.list(wc).at(-1)!
  return {
    sim: s,
    svc,
    fwd,
    wc,
    other,
    audit,
    dl,
    events,
    files,
    fw,
    finished,
    last,
    relink: async () => {
      link?.end()
      link = await connect(s.port)
    },
    drop: () => {
      link?.end()
    },
    close: () => {
      link?.end()
      void fw.dispose()
    }
  }
}

describe('local file names from the device are made safe', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['flash:c2900.bin', 'c2900.bin'],
    ['..\\..\\Windows\\win.ini', 'win.ini'],
    ['/abs/path/x.cfg', 'x.cfg'],
    ['..', 'download'],
    ['.', 'download'],
    ['', 'download'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['com1', '_com1'],
    ['a\u0007b\u001bc', 'a_b_c'],
    ['evil‮txt.exe', 'evil_txt.exe'],
    ['trailing. . ', 'trailing'],
    ['a<b>c:d"e|f?g*h', 'a_b_c_d_e_f_g_h'],
    ['C:evil.txt', 'evil.txt']
  ])('%j → %j', (remote, local) => {
    expect(safeLocalName(remote)).toBe(local)
  })

  it('caps the length and keeps the extension', () => {
    const n = safeLocalName('x'.repeat(400) + '.bin')
    expect(n.length).toBeLessThanOrEqual(180)
    expect(n.endsWith('.bin')).toBe(true)
  })

  it('caps the length in UTF-8 bytes without splitting a character, then trims again (review lows 11, 12)', () => {
    const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
    for (const unit of ['é', '日本', '😀', '👩‍👩‍👧‍👦', 'é']) {
      const n = safeLocalName(unit.repeat(200) + '.cfg')
      expect(bytes(n), unit).toBeLessThanOrEqual(180)
      expect(n.endsWith('.cfg')).toBe(true)
      const stem = n.slice(0, -4)
      // Whole graphemes only: no lone surrogate, no half emoji sequence, no stray combining mark.
      expect(stem.replaceAll(unit.normalize('NFC'), ''), unit).toBe('')
      expect(/[\uD800-\uDFFF]/u.test(n)).toBe(false)
    }
    // A cut that lands on spaces or dots leaves none at the end.
    const n = safeLocalName('a'.repeat(170) + ' . . . . . . . . . . . . . . . . . .x.bin')
    expect(n).toBe('a'.repeat(170) + '.bin')
    expect(safeLocalName('b'.repeat(175) + '. . . . . . . . .')).toBe('b'.repeat(175))
  })

  it.each([['CON .txt'], ['con..txt'], ['NUL .tar.gz'], ['lpt1 . .cfg'], ['AUX ']])('%j is a reserved name (review low 12)', (remote) => {
    expect(safeLocalName(remote).startsWith('_')).toBe(true)
  })

  it('commits a download without hard links by an exclusive copy, never over a file that appeared (review low 9)', async () => {
    const { commitPart } = await import('../src/main/files/paths')
    const { promises } = await import('node:fs')
    const d = mkdtempSync(join(root, 'nolink-'))
    const spy = vi.spyOn(promises, 'link').mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }))
    const rename = vi.spyOn(promises, 'rename')
    try {
      writeFileSync(join(d, 'p1'), 'one')
      expect(await commitPart(d, join(d, 'p1'), 'cfg.txt', false)).toBe('cfg.txt')
      expect(readFileSync(join(d, 'cfg.txt'), 'utf8')).toBe('one')
      expect(existsSync(join(d, 'p1'))).toBe(false)
      // The name is taken (a symlink planted there included): the next free name, the link untouched.
      writeFileSync(join(d, 'secret'), 'keep')
      symlinkSync(join(d, 'secret'), join(d, 'x.txt'))
      writeFileSync(join(d, 'p2'), 'two')
      expect(await commitPart(d, join(d, 'p2'), 'x.txt', false)).toBe('x (2).txt')
      expect(readFileSync(join(d, 'secret'), 'utf8')).toBe('keep')
      expect(readFileSync(join(d, 'x (2).txt'), 'utf8')).toBe('two')
      expect(rename).not.toHaveBeenCalled()
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      rename.mockRestore()
    }
  })

  it('childPath refuses anything but a direct child', () => {
    expect(() => childPath('/tmp/d', '../x')).toThrow()
    expect(() => childPath('/tmp/d', 'a/b')).toThrow()
    expect(() => childPath('/tmp/d', '..')).toThrow()
    expect(childPath('/tmp/d', 'ok.txt')).toBe(join('/tmp/d', 'ok.txt'))
  })
})

describe('SFTP transfers (EOS-like device)', () => {
  it('uploads with a hash and a verify command, downloads back, audits both', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      const info = await t.svc.open('tab1', t.wc)
      expect(info.mode).toBe('sftp')
      expect(info.home).toBe('/mnt/flash')
      expect(info.roots).toContain('/mnt/flash/')
      const data = randomBytes(3 * 1024 * 1024 + 123)
      const src = join(root, 'EOS-4.31.swi')
      writeFileSync(src, data)
      const q = await t.svc.upload('tab1', t.wc, [src], { remoteDir: '/mnt/flash' }, 'ask')
      expect(q).toEqual({ queued: 1, conflicts: [], skipped: [] })
      const up = await t.finished(t.last().id)
      expect(up.state).toBe('done')
      expect(up.md5).toBe(md5(data))
      expect(up.sha256).toBe(sha(data))
      expect(up.verify).toBe('verify /md5 flash:EOS-4.31.swi')
      expect(deviceFs(t.sim.device).files.get('/mnt/flash/EOS-4.31.swi')!.data.equals(data)).toBe(true)
      // Progress was reported along the way, not just at the end.
      expect(t.events.filter((e) => e.kind === "item" && e.item.id === up.id && e.item.state === "running").length).toBeGreaterThanOrEqual(1)

      const d = await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/EOS-4.31.swi' }], 'ask')
      expect(d!.queued).toBe(1)
      const down = await t.finished(t.last().id)
      expect(down.state).toBe('done')
      expect(down.sha256).toBe(sha(data))
      expect(readFileSync(join(t.dl, 'EOS-4.31.swi')).equals(data)).toBe(true)
      expect(readdirSync(t.dl).some((n) => n.endsWith('.hopline-part'))).toBe(false)
      // Drag-out (and reveal) only hand a finished download's path to the window that owns it.
      expect(t.svc.localPath(t.wc, down.id)).toBe(join(t.dl, 'EOS-4.31.swi'))
      expect(t.svc.localPath(t.other, down.id)).toBeUndefined()
      expect(t.svc.localPath(t.wc, up.id)).toBeUndefined()

      const rows = t.audit.filter((a) => a.source === 'transfer')
      expect(rows.map((r) => [r.command, r.kind, r.decision, r.bytes])).toEqual([
        ['sftp put /mnt/flash/EOS-4.31.swi', 'upload', 'executed', data.length],
        ['sftp get /mnt/flash/EOS-4.31.swi', 'download', 'executed', data.length]
      ])
      expect(rows[0]!.reason).toContain(`sha256 ${sha(data)} md5 ${md5(data)}`)
    } finally {
      t.close()
    }
  })

  it('fix-round Low 5: an upload queued before read-only mode was turned on is refused when it starts', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await t.svc.open('tab1', t.wc)
      const src = join(root, 'ro-late.bin')
      writeFileSync(src, 'abcd')
      await t.svc.upload('tab1', t.wc, [src], { remoteDir: '/mnt/flash' }, 'overwrite')
      expect((await t.finished(t.last().id)).state).toBe('done')
      const asked = await t.svc.upload('tab1', t.wc, [src], { remoteDir: '/mnt/flash' }, 'ask')
      expect(asked.conflicts).toHaveLength(1)
      readOnlyNow = true
      await t.svc.resolve(t.wc, asked.conflicts[0]!.token, 'overwrite')
      const it2 = await t.finished(t.last().id)
      expect(it2.state).toBe('error')
      expect(it2.error).toMatch(/read-only mode is on/)
      expect(t.audit.filter((r) => r.source === 'transfer' && r.decision === 'refused').at(-1)).toMatchObject({ kind: 'upload', reason: expect.stringMatching(/read-only mode is on/) })
    } finally {
      readOnlyNow = false
      t.close()
    }
  })

  it('never overwrites a local file silently: ask, rename, skip, overwrite', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await t.svc.open('tab1', t.wc)
      writeFileSync(join(t.dl, 'startup-config'), 'MINE')
      const asked = (await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/startup-config' }], 'ask'))!
      expect(asked.queued).toBe(0)
      expect(asked.conflicts).toHaveLength(1)
      expect(asked.conflicts[0]!.existing!.size).toBe(4)
      const renamed = await t.svc.resolve(t.wc, asked.conflicts[0]!.token, 'rename')
      expect(renamed.queued).toBe(1)
      expect((await t.finished(t.last().id)).localName).toBe('startup-config (2)')
      expect(readFileSync(join(t.dl, 'startup-config'), 'utf8')).toBe('MINE')
      expect(readFileSync(join(t.dl, 'startup-config (2)'), 'utf8')).toMatch(/^hostname /)
      // A token answers once, and only for the window that was asked.
      await expect(t.svc.resolve(t.wc, asked.conflicts[0]!.token, 'overwrite')).rejects.toThrow(/expired/)
      const again = (await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/startup-config' }], 'ask'))!
      await expect(t.svc.resolve(t.other, again.conflicts[0]!.token, 'overwrite')).rejects.toThrow()

      const skipped = (await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/startup-config' }], 'skip'))!
      expect(skipped.skipped).toEqual([{ name: 'startup-config', reason: 'already in the download folder' }])
      await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/startup-config' }], 'overwrite')
      await t.finished(t.last().id)
      expect(readFileSync(join(t.dl, 'startup-config'), 'utf8')).toMatch(/^hostname /)
    } finally {
      t.close()
    }
  })

  it('replaces a symlink at the target name instead of writing through it', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await t.svc.open('tab1', t.wc)
      const outside = join(root, 'outside.txt')
      writeFileSync(outside, 'PRECIOUS')
      symlinkSync(outside, join(t.dl, 'tech-support.txt'))
      const q = (await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/tech-support.txt' }], 'ask'))!
      expect(q.conflicts).toHaveLength(1)
      await t.svc.resolve(t.wc, q.conflicts[0]!.token, 'overwrite')
      await t.finished(t.last().id)
      expect(readFileSync(outside, 'utf8')).toBe('PRECIOUS')
      expect(readFileSync(join(t.dl, 'tech-support.txt'), 'utf8')).toMatch(/show tech-support/)

      // An upload source that is a link is refused, not followed.
      symlinkSync(outside, join(root, 'link.bin'))
      const up = await t.svc.upload('tab1', t.wc, [join(root, 'link.bin')], { remoteDir: '/mnt/flash' }, 'ask')
      expect(up.skipped[0]!.reason).toMatch(/symbolic link/)
    } finally {
      t.close()
    }
  })

  it('a hostile remote name lands inside the download folder', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await t.svc.open('tab1', t.wc)
      deviceFs(t.sim.device).files.set('/mnt/flash/CON', { data: Buffer.from('x'), mode: 0o100644, mtime: 0 })
      await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/CON' }], 'ask')
      expect((await t.finished(t.last().id)).localName).toBe('_CON')
      expect(existsSync(join(t.dl, '_CON'))).toBe(true)
    } finally {
      t.close()
    }
  })

  it('a dropped connection fails the download; retry resumes from the part file', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await t.svc.open('tab1', t.wc)
      const data = randomBytes(12 * 1024 * 1024)
      deviceFs(t.sim.device, 64 * 1024 * 1024).files.set('/mnt/flash/big.bin', { data, mode: 0o100644, mtime: 0 })
      await t.svc.download('tab1', t.wc, [{ path: '/mnt/flash/big.bin' }], 'ask')
      const id = t.last().id
      // Drop the link once some bytes are on disk.
      await new Promise<void>((r) => {
        const tick = () => {
          const x = t.svc.list(t.wc).find((x) => x.id === id)!
          return x.done > 1024 * 1024 || x.state !== 'running' && x.state !== 'queued' ? r() : setTimeout(tick, 5)
        }
        tick()
      })
      t.drop()
      const failed = await t.finished(id)
      expect(failed.state).toBe('error')
      expect(readdirSync(t.dl)).toContain('big.bin.hopline-part')
      await t.relink()
      await t.svc.open('tab1', t.wc)
      await t.svc.retry(t.wc, id)
      const done = await t.finished(id)
      expect(done.state).toBe('done')
      expect(done.resumedFrom).toBeGreaterThan(0)
      expect(done.sha256).toBe(sha(data))
      expect(readFileSync(join(t.dl, 'big.bin')).equals(data)).toBe(true)
      expect(t.audit.filter((a) => a.command === 'sftp get /mnt/flash/big.bin').map((a) => a.decision)).toEqual(['error', 'executed'])
    } finally {
      t.close()
    }
  })

  it('cancel stops a running upload and removes nothing local', async () => {
    const t = await setup('eos', { sftp: true, capacity: 256 * 1024 * 1024 })
    try {
      await t.svc.open('tab1', t.wc)
      const src = join(root, 'cancel.bin')
      writeFileSync(src, randomBytes(40 * 1024 * 1024))
      await t.svc.upload('tab1', t.wc, [src], { remoteDir: '/mnt/flash' }, 'overwrite')
      const id = t.last().id
      await new Promise<void>((r) => {
        const tick = () => (t.svc.list(t.wc).find((x) => x.id === id)!.done > 0 ? r() : setTimeout(tick, 5))
        tick()
      })
      t.svc.cancel(t.wc, id)
      const it = await t.finished(id)
      expect(it.state).toBe('cancelled')
      expect(existsSync(src)).toBe(true)
      expect(t.audit.at(-1)!.decision).toBe('cancelled')
    } finally {
      t.close()
    }
  })

  it('only the window that owns the tab can use it', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await expect(t.svc.open('tab1', t.other)).rejects.toThrow(/not open/)
      await expect(t.svc.download('tab1', t.other, [{ path: '/mnt/flash/x' }], 'ask')).rejects.toThrow(/not open/)
      await t.svc.open('tab1', t.wc)
      await t.svc.op('tab1', t.wc, { op: 'mkdir', path: '/mnt/flash/new' })
      expect(t.audit.at(-1)).toMatchObject({ source: 'transfer', command: 'sftp mkdir /mnt/flash/new', kind: 'mkdir', decision: 'executed' })
    } finally {
      t.close()
    }
  })
})

describe('SCP fallback (IOS: no SFTP)', () => {
  it('detects SCP mode, uploads an image to flash: with a verify command, downloads show tech', async () => {
    const t = await setup('ios', {})
    try {
      const info = await t.svc.open('tab1', t.wc)
      expect(info.mode).toBe('scp')
      expect(info.reason).toMatch(/no SFTP/)
      expect(info.home).toBe('flash:')
      const img = randomBytes(1024 * 1024)
      const src = join(root, 'c2900-universalk9-mz.SPA.157-3.M8.bin')
      writeFileSync(src, img)
      // SCP can't check for an existing file: "ask" asks.
      const asked: QueueResult = await t.svc.upload('tab1', t.wc, [src], { remotePath: 'flash:c2900.bin' }, 'ask')
      expect(asked.conflicts[0]!.existing).toBeUndefined()
      await t.svc.resolve(t.wc, asked.conflicts[0]!.token, 'overwrite')
      const up = await t.finished(t.last().id)
      expect(up.state).toBe('done')
      expect(up.protocol).toBe('scp')
      expect(up.verify).toBe(`verify /md5 flash:c2900.bin ${md5(img)}`)
      expect(deviceFs(t.sim.device).files.get('/flash/c2900.bin')!.data.equals(img)).toBe(true)
      // S1 (fix-round review): IOS reads the path itself, so a name that needs quoting is refused up front.
      const quoted = await t.svc.upload('tab1', t.wc, [src], { remotePath: 'flash:my image.bin' }, 'overwrite')
      expect(quoted.queued).toBe(0)
      expect(quoted.skipped[0]!.reason).toMatch(/reads the path itself/)
      expect(deviceFs(t.sim.device).files.has("/flash/'my image.bin'")).toBe(false)

      await t.svc.download('tab1', t.wc, [{ path: 'flash:tech-support.txt' }], 'ask')
      const down = await t.finished(t.last().id)
      expect(down.state).toBe('done')
      expect(readFileSync(join(t.dl, 'tech-support.txt'), 'utf8')).toMatch(/show tech-support/)

      await t.svc.download('tab1', t.wc, [{ path: 'flash:missing.bin' }], 'ask')
      const bad = await t.finished(t.last().id)
      expect(bad.state).toBe('error')
      expect(bad.error).toMatch(/%Error opening flash:missing.bin \(No such file or directory\).*filesystem prefix/)
      expect(readdirSync(t.dl).some((n) => n.includes('missing'))).toBe(false)
      expect(t.audit.at(-1)).toMatchObject({ command: 'scp get flash:missing.bin', decision: 'error' })
      // Browsing needs SFTP.
      await expect(t.svc.op('tab1', t.wc, { op: 'list', path: 'flash:' })).rejects.toThrow(/no SFTP/)
    } finally {
      t.close()
    }
  })
})

describe('forwards on a background connection (review M4)', () => {
  it('a forward that starts without a window is audited and stopped', async () => {
    const listeners = new Set<(m: HostToMain) => void>()
    const requests: MainToHost[] = []
    const session = { id: 's9', name: 'bg-dev', host: '10.0.0.9', options: {} } as unknown as Session
    const host: FilesHost = {
      owned: () => undefined,
      background: (tabId) => (tabId === 'bg-1' ? session : undefined),
      request: <T,>(build: (id: number) => MainToHost) => (requests.push(build(1)), Promise.resolve(undefined as T)),
      send: () => {},
      onHostMessage: (fn) => (listeners.add(fn), () => listeners.delete(fn))
    }
    const audit: AuditEntry[] = []
    new ForwardService(host, { append: (e) => audit.push(e) })
    const f = { spec: { id: 'x', kind: 'D' as const, bindHost: '127.0.0.1', bindPort: 1080 }, state: 'listening' as const, boundPort: 1080, active: 0, total: 0, bytesIn: 0, bytesOut: 0 }
    for (const fn of listeners) fn({ t: 'fwd-state', tabId: 'bg-1', forwards: [f] })
    // The same state again is not audited twice. A tab main cannot place is audited and stopped too (fix-round A2).
    for (const fn of listeners) fn({ t: 'fwd-state', tabId: 'bg-1', forwards: [f] })
    for (const fn of listeners) fn({ t: 'fwd-state', tabId: 'nope', forwards: [f] })
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({ source: 'forward', sessionId: 's9', decision: 'error', reason: expect.stringMatching(/background connection/) })
    expect(audit[1]).toMatchObject({ source: 'forward', sessionId: null, sessionName: '(unknown tab nope)', decision: 'error' })
    expect(requests).toEqual([
      { t: 'fwd', id: 1, tabId: 'bg-1', op: { op: 'stop', fid: 'x' } },
      { t: 'fwd', id: 1, tabId: 'nope', op: { op: 'stop', fid: 'x' } }
    ])
  })
})

describe('forwards through main', () => {
  it('adds a live forward, audits it, reports status to the owner', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      const st = await t.fwd.add('tab1', t.wc, { kind: 'D', bindHost: '127.0.0.1', bindPort: 0 })
      expect(st.state).toBe('listening')
      expect(st.saved).toBe(false)
      const list = await t.fwd.list('tab1', t.wc)
      expect(list).toHaveLength(1)
      expect(t.audit.at(-1)).toMatchObject({ source: 'forward', kind: 'D', decision: 'executed' })
      await t.fwd.stop('tab1', t.wc, st.spec.id)
      expect((await t.fwd.list('tab1', t.wc))[0]!.state).toBe('stopped')
      await t.fwd.remove('tab1', t.wc, st.spec.id)
      expect(await t.fwd.list('tab1', t.wc)).toEqual([])
      await expect(t.fwd.list('tab1', t.other)).rejects.toThrow(/not open/)
    } finally {
      t.close()
    }
  })

  it('audits a forward live-added once, and one the host started on connect (saved) as automatic', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      await t.fwd.add('tab1', t.wc, { kind: 'D', bindHost: '127.0.0.1', bindPort: 0 })
      // As HostTab does for a saved forward when the session connects: no request from main.
      await t.fw.start({ id: 'saved1', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: 9 })
      await new Promise((r) => setTimeout(r, 400))
      const rows = t.audit.filter((a) => a.source === 'forward')
      expect(rows.filter((r) => r.kind === 'D')).toHaveLength(1)
      const auto = rows.filter((r) => r.kind === 'L')
      expect(auto).toHaveLength(1)
      expect(auto[0]).toMatchObject({ decision: 'executed', command: expect.stringMatching(/^forward L 127\.0\.0\.1:\d+ → 127\.0\.0\.1:9$/), reason: expect.stringMatching(/^started on connect/) })
      // A later reconnect (waiting → listening) is not audited again.
      t.fw.detach()
      await new Promise((r) => setTimeout(r, 300))
      await t.fw.attach(await connect(t.sim.port))
      await new Promise((r) => setTimeout(r, 400))
      expect(t.audit.filter((a) => a.source === 'forward' && a.kind === 'L')).toHaveLength(1)
    } finally {
      t.close()
    }
  })
})

describe('IPC shapes for transfers and forwards', () => {
  it('rejects bad payloads', () => {
    expect(() => FilesSchemas.op.parse({ tabId: 't', op: { op: 'list', path: 'flash:\nreload' } })).toThrow()
    expect(() => FilesSchemas.op.parse({ tabId: 't', op: { op: 'list', path: '/x', extra: 1 } })).toThrow()
    expect(() => FilesSchemas.download.parse({ tabId: 't', items: [], policy: 'ask' })).toThrow()
    expect(() => FilesSchemas.download.parse({ tabId: 't', items: [{ path: '/x' }], policy: 'clobber' })).toThrow()
    expect(() => FilesSchemas.pickUpload.parse({ tabId: 't', policy: 'ask', localPath: '/etc/passwd' })).toThrow()
    expect(() => FilesSchemas.forwardAdd.parse({ tabId: 't', spec: { kind: 'L', bindHost: '127.0.0.1', bindPort: 8080 } })).toThrow()
    expect(() => FilesSchemas.forwardAdd.parse({ tabId: 't', spec: { kind: 'L', bindHost: '127.0.0.1 ', bindPort: 70000, destHost: 'x', destPort: 1 } })).toThrow()
    expect(() => FilesSchemas.resolve.parse({ token: 'not-a-uuid', choice: 'overwrite' })).toThrow()
    expect(FilesSchemas.forwardAdd.parse({ tabId: 't', spec: { kind: 'D', bindHost: '127.0.0.1', bindPort: 1080 } }).spec.kind).toBe('D')
  })
})

describe('read-only file previews on the existing SSH connection', () => {
  it.each(['ios', 'eos'] as const)('reads %s text and masks secrets, with no local copy', async (platform) => {
    const t = await setup(platform, { sftp: platform === 'eos' })
    try {
      const fs = deviceFs(t.sim.device)
      const path = platform === 'ios' ? 'flash:sample.txt' : '/mnt/flash/sample.txt'
      const file = (data: Buffer) => fs.files.set(fs.home + '/sample.txt', { data, mode: 0o100644, mtime: 0 })
      file(Buffer.from('hostname demo\nsnmp-server community PREVIEW_CANARY RO\n'))
      if (platform === 'ios') {
        expect(await t.svc.listScpDirectory('tab1', t.wc, 'flash:')).toContainEqual(expect.objectContaining({ name: 'sample.txt', folder: false }))
        await expect(t.files.listDirectory('flash:', 'ios', { all: ['dir'] })).rejects.toThrow(/policy|blocked/i)
        await expect(t.svc.listScpDirectory('tab1', t.other, 'flash:')).rejects.toThrow(/not open/)
      }
      const preview = await t.svc.preview('tab1', t.wc, path)
      expect(preview).toMatchObject({ kind: 'text', text: expect.stringContaining('hostname demo'), redactions: 1 })
      expect(JSON.stringify(preview)).not.toContain('PREVIEW_CANARY')
      file(Buffer.from([0, 1, 2]))
      expect(await t.svc.preview('tab1', t.wc, path)).toEqual({ kind: 'binary', bytes: 3 })
      file(Buffer.alloc(300000))
      expect(await t.svc.preview('tab1', t.wc, path)).toEqual({ kind: 'large', bytes: 300000 })
      await expect(t.svc.preview('tab1', t.other, path)).rejects.toThrow(/not open/)
      expect(t.svc.list(t.wc)).toEqual([])
    } finally { t.close() }
  })
})

describe('packet capture downloads', () => {
  it('downloads over SFTP into the chosen folder and binds the digest to the owning window', async () => {
    const t = await setup('eos', { sftp: true })
    try {
      const data = Buffer.from('synthetic capture transfer')
      const remote = '/mnt/flash/incident.pcapng'
      deviceFs(t.sim.device).files.set(remote, { data, mode: 0o100600, mtime: 0 })
      await expect(t.svc.receiveCapture('tab1', t.other, remote, new AbortController().signal, () => {})).rejects.toThrow(/not open/)
      const capture = await t.svc.receiveCapture('tab1', t.wc, remote, new AbortController().signal, () => {})
      expect(capture).toMatchObject({ name: 'incident.pcapng', sha256: sha(data) })
      expect(readFileSync(capture!.path)).toEqual(data)
      expect(t.svc.captureDownload(t.wc, t.last().id)?.sha256).toBe(sha(data))
      expect(t.svc.captureDownload(t.other, t.last().id)).toBeUndefined()
    } finally { t.close() }
  })
})
