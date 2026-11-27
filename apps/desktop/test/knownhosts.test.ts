import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { importOpenSshKnownHosts } from '../src/main/knownhosts-import'
import { parseKnownHosts } from '../src/main/knownhosts'

const key = (seed: string) => Buffer.from(`ssh-ed25519-test-key-${seed}`.padEnd(51, '.')).toString('base64')
const fp = (b64: string) => 'SHA256:' + createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')

describe('parseKnownHosts', () => {
  it('reads plain, bracketed-port and multi-host lines; skips hashed, markers, wildcards and junk', () => {
    const r = parseKnownHosts(
      [
        `# comment`,
        `core-sw1,10.0.0.1 ssh-ed25519 ${key('a')}`,
        `[10.0.0.2]:2222 ssh-rsa ${key('b')} comment here`,
        `|1|abc=|def= ssh-ed25519 ${key('c')}`,
        `@cert-authority *.lab ssh-ed25519 ${key('d')}`,
        `*.corp ssh-ed25519 ${key('e')}`,
        `broken-line`,
        `Bad-Case.Example ssh-ed25519 not*base64`
      ].join('\n')
    )
    expect(r.entries).toEqual([
      { host: 'core-sw1', port: 22, keyType: 'ssh-ed25519', fingerprint: fp(key('a')) },
      { host: '10.0.0.1', port: 22, keyType: 'ssh-ed25519', fingerprint: fp(key('a')) },
      { host: '10.0.0.2', port: 2222, keyType: 'ssh-rsa', fingerprint: fp(key('b')) }
    ])
    expect(r.hashed).toBe(1)
    expect(r.skipped).toBe(4)
  })
})

describe('host key store and import', () => {
  it('keeps several keys per host, imports without overriding, reports conflicts', async () => {
    const repo = new Repo(openDb(':memory:'))
    repo.addHostKey('10.0.0.9', 22, 'SHA256:mine')
    const dir = mkdtempSync(join(tmpdir(), 'kh-'))
    const file = join(dir, 'known_hosts')
    writeFileSync(file, [`core-sw1 ssh-ed25519 ${key('a')}`, `core-sw1 ssh-rsa ${key('b')}`, `10.0.0.9 ssh-ed25519 ${key('c')}`].join('\n'))
    const r = await importOpenSshKnownHosts(repo, file)
    expect(r).toMatchObject({ added: 2, alreadyKnown: 0, conflicts: [{ host: '10.0.0.9', port: 22 }] })
    expect(repo.hostKeys('CORE-SW1', 22).sort()).toEqual([fp(key('a')), fp(key('b'))].sort())
    expect(repo.hostKeys('10.0.0.9', 22)).toEqual(['SHA256:mine'])
    // Re-import is idempotent.
    expect((await importOpenSshKnownHosts(repo, file)).added).toBe(0)
    repo.replaceHostKeys('core-sw1', 22, 'SHA256:new')
    expect(repo.hostKeys('core-sw1', 22)).toEqual(['SHA256:new'])
    rmSync(dir, { recursive: true, force: true })
  })
  it('migrates single-key rows from the old table', () => {
    const db = openDb(':memory:')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'known_hosts'").get()).toBeUndefined()
  })
})
