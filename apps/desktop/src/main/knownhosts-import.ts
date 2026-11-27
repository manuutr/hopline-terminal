import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { KnownHostsImport } from '@shared/types'
import type { Repo } from './db/repo'
import { parseKnownHosts } from './knownhosts'

/**
 * Merge the user's OpenSSH known_hosts into Hopline's trust store. Never overrides a key Hopline
 * already trusts for a host: a differing key is reported as a conflict instead.
 */
export async function importOpenSshKnownHosts(repo: Repo, file = join(homedir(), '.ssh', 'known_hosts')): Promise<KnownHostsImport> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new Error(`No known_hosts file at ${file}`)
  }
  const parsed = parseKnownHosts(text)
  const result: KnownHostsImport = { added: 0, alreadyKnown: 0, conflicts: [], hashed: parsed.hashed, skipped: parsed.skipped, file }
  // Keys Hopline trusted on its own before this import.
  const before = new Map<string, string[]>()
  for (const e of parsed.entries) {
    const k = `${e.host}:${e.port}`
    if (!before.has(k)) before.set(k, repo.hostKeys(e.host, e.port))
  }
  const conflicted = new Set<string>()
  for (const e of parsed.entries) {
    const k = `${e.host}:${e.port}`
    const mine = before.get(k)!
    if (mine.includes(e.fingerprint)) {
      result.alreadyKnown++
      continue
    }
    if (mine.length > 0) {
      if (!conflicted.has(k)) result.conflicts.push({ host: e.host, port: e.port })
      conflicted.add(k)
      continue
    }
    if (repo.addHostKey(e.host, e.port, e.fingerprint, 'import', e.keyType)) result.added++
    else result.alreadyKnown++
  }
  return result
}
