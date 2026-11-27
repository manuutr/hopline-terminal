import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Write a file only the user can read (0o600), also when it replaces an existing one: `writeFile`
 * with a mode keeps the old file's permissions on overwrite, so an export with secrets written over
 * a world-readable file stayed world-readable. A fresh tmp file is created exclusively next to the
 * target (O_EXCL, O_NOFOLLOW, 0o600), synced, then renamed over it. (Windows ignores the mode; the
 * file gets the folder's ACL.)
 */
export async function writePrivateFile(path: string, data: string | Buffer): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  try {
    try {
      await fh.writeFile(data)
      await fh.chmod(0o600).catch(() => {})
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}
