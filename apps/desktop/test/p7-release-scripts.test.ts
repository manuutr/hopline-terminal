import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { checksums, refreshFeeds, stage } from '../../../scripts/release/lib.mjs'

const ROOT = join(__dirname, '../../..')

/** A release folder like electron-builder leaves it. */
function release() {
  const dir = mkdtempSync(join(tmpdir(), 'hopline-rel-'))
  writeFileSync(join(dir, 'Hopline-0.7.0-linux-x86_64.AppImage'), 'appimage v1')
  writeFileSync(join(dir, 'Hopline-0.7.0-win-x64.exe'), 'installer v1')
  const sha = (s: string) => createHash('sha512').update(s).digest('base64')
  writeFileSync(
    join(dir, 'latest-linux.yml'),
    `version: 0.7.0\nfiles:\n  - url: Hopline-0.7.0-linux-x86_64.AppImage\n    sha512: ${sha('appimage v1')}\n    size: 11\n    blockMapSize: 1234\npath: Hopline-0.7.0-linux-x86_64.AppImage\nsha512: ${sha('appimage v1')}\nreleaseDate: '2026-11-25T00:00:00.000Z'\n`
  )
  writeFileSync(
    join(dir, 'latest.yml'),
    `version: 0.7.0\nfiles:\n  - url: Hopline-0.7.0-win-x64.exe\n    sha512: ${sha('installer v1')}\n    size: 12\npath: Hopline-0.7.0-win-x64.exe\nsha512: ${sha('installer v1')}\nreleaseDate: '2026-11-25T00:00:00.000Z'\n`
  )
  return { dir, sha }
}

describe('release scripts', () => {
  it('stage: sets the rollout share in every feed; 100 means everyone (key removed); bad values refused', () => {
    const { dir } = release()
    expect(stage(dir, 10)).toEqual(['latest-linux.yml', 'latest.yml'])
    expect(readFileSync(join(dir, 'latest.yml'), 'utf8')).toMatch(/\nstagingPercentage: 10\n$/)
    stage(dir, 0)
    expect(readFileSync(join(dir, 'latest.yml'), 'utf8').match(/stagingPercentage/g)).toHaveLength(1)
    expect(readFileSync(join(dir, 'latest.yml'), 'utf8')).toContain('stagingPercentage: 0')
    stage(dir, 100)
    expect(readFileSync(join(dir, 'latest.yml'), 'utf8')).not.toContain('stagingPercentage')
    for (const bad of [-1, 101, 2.5, 'abc']) expect(() => stage(dir, bad)).toThrow(/0-100/)
  })

  it('refresh: a file signed after the build gets its new sha512 and size; the stale block map is dropped', async () => {
    const { dir, sha } = release()
    writeFileSync(join(dir, 'Hopline-0.7.0-win-x64.exe'), 'installer v1 + Authenticode signature')
    const changed = await refreshFeeds(dir)
    expect(changed).toEqual(['latest.yml: Hopline-0.7.0-win-x64.exe', 'latest.yml: Hopline-0.7.0-win-x64.exe'])
    const yml = readFileSync(join(dir, 'latest.yml'), 'utf8')
    expect(yml.match(new RegExp(sha('installer v1 + Authenticode signature').replace(/[+/]/g, '\\$&'), 'g'))).toHaveLength(2)
    expect(yml).toContain(`    size: ${'installer v1 + Authenticode signature'.length}`)
    expect(yml).not.toContain(sha('installer v1'))
    // Untouched files keep their entries; the block map size goes (it no longer matches anything signed).
    const linux = readFileSync(join(dir, 'latest-linux.yml'), 'utf8')
    expect(linux).toContain(sha('appimage v1'))
    expect(linux).not.toContain('blockMapSize')
  })

  it('sums: one .sha256 per artifact in sha256sum format, and SHA256SUMS.txt that sha256sum -c accepts', async () => {
    const { dir } = release()
    const rows = await checksums(dir)
    expect(rows).toHaveLength(2)
    expect(readFileSync(join(dir, 'Hopline-0.7.0-win-x64.exe.sha256'), 'utf8')).toBe(`${createHash('sha256').update('installer v1').digest('hex')}  Hopline-0.7.0-win-x64.exe\n`)
    if (process.platform === 'linux') expect(execFileSync('sha256sum', ['-c', 'SHA256SUMS.txt'], { cwd: dir, encoding: 'utf8' })).toMatch(/AppImage: OK[\s\S]*exe: OK/)
  })

  it.runIf(process.platform === 'linux' && spawnSync('gpg', ['--version']).status === 0)('gpg-sign: no key is a no-op; with a key every Linux package and the sums get a verifiable .asc', async () => {
    const { dir } = release()
    await checksums(dir)
    const env = { ...process.env, GPG_PRIVATE_KEY: '', GPG_PASSPHRASE: '' }
    expect(execFileSync('bash', [join(ROOT, 'scripts/release/gpg-sign.sh'), dir], { env, encoding: 'utf8' })).toMatch(/not GPG-signed/)
    expect(existsSync(join(dir, 'SHA256SUMS.txt.asc'))).toBe(false)
    // A throwaway key in a throwaway keyring.
    const home = mkdtempSync(join(tmpdir(), 'hopline-gpg-'))
    const g = { ...process.env, GNUPGHOME: home }
    execFileSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'Hopline Test <test@example.invalid>', 'ed25519', 'sign', '1d'], { env: g, stdio: 'ignore' })
    const key = execFileSync('gpg', ['--batch', '--armor', '--export-secret-keys'], { env: g, encoding: 'utf8' })
    const out = execFileSync('bash', [join(ROOT, 'scripts/release/gpg-sign.sh'), dir], { env: { ...env, GPG_PRIVATE_KEY: key }, encoding: 'utf8' })
    expect(out).toMatch(/signed SHA256SUMS\.txt/)
    expect(out).toMatch(/signed Hopline-0\.7\.0-linux-x86_64\.AppImage/)
    expect(existsSync(join(dir, 'Hopline-0.7.0-win-x64.exe.asc'))).toBe(false)
    // Anyone with the exported public key can verify.
    const verifier = mkdtempSync(join(tmpdir(), 'hopline-gpg-v-'))
    const v = { ...process.env, GNUPGHOME: verifier }
    execFileSync('gpg', ['--batch', '--import', join(dir, 'hopline-release-key.asc')], { env: v, stdio: 'ignore' })
    expect(spawnSync('gpg', ['--batch', '--verify', join(dir, 'SHA256SUMS.txt.asc'), join(dir, 'SHA256SUMS.txt')], { env: v }).status).toBe(0)
    writeFileSync(join(dir, 'SHA256SUMS.txt'), 'tampered\n')
    expect(spawnSync('gpg', ['--batch', '--verify', join(dir, 'SHA256SUMS.txt.asc'), join(dir, 'SHA256SUMS.txt')], { env: v }).status).not.toBe(0)
  })
})
