import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanForLog, expandTemplate, resolveLogPath, SessionLogger } from '../src/session-host/logger'

const ctx = { session: 'core sw/1', host: '10.0.0.1', port: 22, user: 'admin' }
const d = new Date(2026, 10, 24, 9, 5, 7, 42)
let dirs: string[] = []
const tmp = () => {
  const x = mkdtempSync(join(tmpdir(), 'hoplog-'))
  dirs.push(x)
  return x
}
afterEach(() => {
  for (const x of dirs) rmSync(x, { recursive: true, force: true })
  dirs = []
})

describe('log templates', () => {
  it('expands SecureCRT-style tokens and sanitizes names', () => {
    expect(expandTemplate('%S_%H_%P_%U_%Y-%M-%D_%h%m%s_%%_%Z.log', ctx, d)).toBe('core_sw_1_10.0.0.1_22_admin_2026-11-24_090507_%_%Z.log')
  })
  it('allows subfolders but never escapes the log folder', () => {
    const dir = '/logs'
    expect(resolveLogPath(dir, '%Y-%M/%S.log', ctx, d)).toBe(['', 'logs', '2026-11', 'core_sw_1.log'].join(sep))
    expect(resolveLogPath(dir, '../../etc/%S', ctx, d)).toBe(['', 'logs', 'etc', 'core_sw_1.log'].join(sep))
    expect(resolveLogPath(dir, '/etc/passwd', ctx, d)).toBe(['', 'logs', 'etc', 'passwd.log'].join(sep))
    expect(resolveLogPath(dir, '..', ctx, d)).toMatch(/core_sw_1_2026-11-24_09-05-07\.log$/)
  })
  it('strips escapes and applies backspaces', () => {
    expect(cleanForLog('\x1b[1mshow\x1b[0m ver\x08\x08\x08ver\r\n')).toBe('show ver\n')
  })
})

describe('SessionLogger', () => {
  it('timestamps each line, including lines split across chunks', async () => {
    const dir = tmp()
    const log = new SessionLogger({ dir, template: '%S.log', timestamps: true, rotateDaily: false }, ctx, () => d)
    log.write('line one\r\nline ')
    log.write('two\r\n')
    await log.close()
    const body = readFileSync(log.path, 'utf8').split('\n').slice(1).join('\n')
    expect(body).toBe('[09:05:07.042] line one\n[09:05:07.042] line two\n')
  })
  it('rotates to a new file when the date changes', async () => {
    const dir = tmp()
    let now = new Date(2026, 10, 24, 23, 59, 59)
    const log = new SessionLogger({ dir, template: '%S_%D.log', timestamps: false, rotateDaily: true }, ctx, () => now)
    log.write('before midnight\r\n')
    const first = log.path
    now = new Date(2026, 10, 25, 0, 0, 1)
    log.write('after midnight\r\n')
    await log.close()
    expect(log.path).not.toBe(first)
    expect(readdirSync(dir).sort()).toEqual(['core_sw_1_24.log', 'core_sw_1_25.log'])
    expect(readFileSync(first, 'utf8')).toMatch(/before midnight[\s\S]*continued in next file/)
    expect(readFileSync(log.path, 'utf8')).toMatch(/after midnight/)
  })
})

describe('log hardening (review #1, #2)', () => {
  it('never names a dot-file or a non-.log file', () => {
    expect(resolveLogPath('/home/u', '.bashrc', ctx, d)).toBe(['', 'home', 'u', '_bashrc.log'].join(sep))
    expect(resolveLogPath('/home/u', '.ssh/authorized_keys', ctx, d)).toBe(['', 'home', 'u', '_ssh', 'authorized_keys.log'].join(sep))
  })
  it('does not append to a file Hopline Terminal did not create', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'notes.log'), 'my own notes\n')
    const l = new SessionLogger({ dir, template: 'notes.log', timestamps: false, rotateDaily: false }, ctx, () => d)
    l.write('hello\n')
    await l.close()
    expect(readFileSync(join(dir, 'notes.log'), 'utf8')).toBe('my own notes\n')
    expect(l.path).toBe(join(dir, 'notes-1.log'))
    // A Hopline log is appended to as before.
    const l2 = new SessionLogger({ dir, template: 'notes.log', timestamps: false, rotateDaily: false }, ctx, () => d)
    await l2.close()
    expect(l2.path).toBe(join(dir, 'notes-1.log'))
  })
  it('strips newlines from header fields', async () => {
    const dir = tmp()
    const l = new SessionLogger({ dir, template: 'x.log', timestamps: false, rotateDaily: false }, { ...ctx, session: 'evil\ncurl x | sh\n' }, () => d)
    await l.close()
    expect(readFileSync(l.path, 'utf8').split('\n')[0]).toContain('evil curl x | sh')
  })
  it('throws on a folder it cannot create, and survives write errors', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'file'), '')
    expect(() => new SessionLogger({ dir: join(dir, 'file', 'sub'), template: 'x.log', timestamps: false, rotateDaily: false }, ctx)).toThrow()
    // A template naming an existing directory: the stream errors asynchronously, logging stops.
    mkdirSync(join(dir, 'taken.log'))
    chmodSync(join(dir, 'taken.log'), 0o500)
    const errors: Error[] = []
    const l = new SessionLogger({ dir, template: 'taken.log', timestamps: false, rotateDaily: false }, ctx, () => d, (e) => errors.push(e))
    l.write('x')
    await new Promise((r) => setTimeout(r, 50))
    l.write('after error')
    await l.close()
    expect(l.path).not.toBe(join(dir, 'taken.log'))
    expect(errors.length).toBeLessThanOrEqual(1)
  })
})
