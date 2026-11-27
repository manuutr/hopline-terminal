/**
 * Local path safety for downloads. A remote name is hostile input: it may carry `..`, separators,
 * drive letters, device prefixes (`flash:`), Windows reserved names or control characters. Whatever
 * it says, the file lands directly in the folder the user chose, under a name that is valid on
 * every OS (Windows rules apply everywhere, so tests on Linux cover them), and never replaces an
 * existing file unless the user said so.
 */
import { constants, promises as fs } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i
/** Longest local name in UTF-8 bytes (filesystems count bytes, 255 on ext4/APFS; room is left for ` (2)` and the part suffix). */
const MAX_NAME_BYTES = 180
const MAX_EXT_BYTES = 20
/** Suffix of the file a download writes to until it completes. */
export const PART_SUFFIX = '.hopline-part'

/**
 * A safe local file name for a remote name. Only the last path component is used (any `/`, `\`
 * or device prefix such as `flash:` is dropped), then characters Windows forbids and control
 * characters become `_`, trailing dots and spaces go (again after shortening to MAX_NAME_BYTES
 * UTF-8 bytes, never mid-character), reserved device names (`CON`, `con .txt`, `LPT1.tar.gz`) get
 * a `_` prefix, and the result is never empty, `.` or `..`.
 */
export function safeLocalName(remote: string): string {
  // Last component across both separators; then drop a device/drive prefix ("flash:", "C:").
  let n = remote.split(/[\\/]/).filter(Boolean).pop() ?? ''
  n = n.replace(/^[A-Za-z0-9_-]*:/, '')
  // eslint-disable-next-line no-control-regex
  n = n.normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f<>:"|?*‪-‮⁦-⁩]/g, '_')
  n = trimEnd(n).replace(/^\s+/, '')
  // Shortened by UTF-8 bytes in whole graphemes; one byte stays free for the reserved-name prefix.
  if (bytes(n) > MAX_NAME_BYTES - 1) {
    const dot = extname(n)
    const ext = dot && dot !== n ? clipBytes(dot, MAX_EXT_BYTES) : ''
    const stem = trimEnd(clipBytes(dot ? n.slice(0, -dot.length) : n, MAX_NAME_BYTES - 1 - bytes(ext)))
    n = trimEnd(ext.length > 1 ? stem + ext : stem)
  }
  if (n === '' || /^\.+$/.test(n)) n = 'download'
  // Windows ignores trailing spaces and dots in a device name: `CON .txt` is CON.
  if (RESERVED.test(trimEnd(n.split('.')[0]!))) n = `_${n}`
  return n
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const trimEnd = (s: string) => s.replace(/[. ]+$/, '')
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The longest prefix of `s` in whole graphemes (never half a surrogate pair or an emoji sequence) within `max` UTF-8 bytes. */
export function clipBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(s)) {
    const b = bytes(segment)
    if (used + b > max) break
    out += segment
    used += b
  }
  return out
}

/** `name.ext` → `name (2).ext` */
export function numbered(name: string, n: number): string {
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  return `${stem} (${n})${ext && ext !== name ? ext : ''}`
}

/** `dir/name`, refusing anything that would not be a direct child of `dir`. */
export function childPath(dir: string, name: string): string {
  if (name !== basename(name) || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('unsafe file name')
  const p = join(dir, name)
  if (resolve(p) !== resolve(dir) + (resolve(dir).endsWith(sep) ? '' : sep) + name) throw new Error('unsafe file name')
  return p
}

/** lstat without following a symlink; undefined when nothing is there. */
export async function lstatMaybe(p: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.lstat(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** The first free `name`, `name (2)`, `name (3)`… in `dir` (also skipping in-progress part files). */
export async function freeName(dir: string, name: string, taken: Set<string> = new Set()): Promise<string> {
  for (let i = 1; i < 10_000; i++) {
    const n = i === 1 ? name : numbered(name, i)
    if (taken.has(n)) continue
    if (!(await lstatMaybe(childPath(dir, n))) && !(await lstatMaybe(childPath(dir, n + PART_SUFFIX)))) return n
  }
  throw new Error('No free file name in that folder')
}

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

/**
 * Open the part file a download writes to. New: exclusive create (fails if anything, a symlink
 * included, is already there). Resume: append to an existing regular file, never through a link.
 */
export async function openPart(path: string, resume: boolean, mode = 0o644): Promise<fs.FileHandle> {
  if (resume) {
    const st = await fs.lstat(path)
    if (!st.isFile()) throw new Error('The partial download is not a regular file')
    return fs.open(path, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW)
  }
  return fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode)
}

/**
 * Move a finished part file to its final name. Without `replace` this never clobbers: a hard link
 * fails if the name was taken meanwhile (then the next free name is used); filesystems without
 * hard links (FAT, some network shares) copy into an exclusively created target instead
 * (COPYFILE_EXCL fails if anything, a symlink included, is there), never a check-then-rename.
 * Returns the final name.
 */
export async function commitPart(dir: string, part: string, name: string, replace: boolean): Promise<string> {
  if (replace) {
    const target = childPath(dir, name)
    const st = await lstatMaybe(target)
    if (st && st.isDirectory()) throw new Error(`${name} is a folder`)
    // rename() replaces the directory entry itself: a symlink at `target` is replaced, not followed.
    await fs.rename(part, target)
    return name
  }
  let n = name
  for (let i = 0; i < 50; i++) {
    const target = childPath(dir, n)
    try {
      await fs.link(part, target)
      await fs.unlink(part)
      return n
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        n = await freeName(dir, name)
        continue
      }
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
        if (await copyExclusive(part, target)) {
          await fs.unlink(part)
          return n
        }
        n = await freeName(dir, name)
        continue
      }
      throw e
    }
  }
  throw new Error('Could not find a free name for the download')
}

/** Copy `from` to `to`, creating `to` exclusively; false when something is already there. */
export async function copyExclusive(from: string, to: string): Promise<boolean> {
  try {
    await fs.copyFile(from, to, constants.COPYFILE_EXCL)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

/** An upload source picked or dropped by the user: a regular file, not a link or a folder. */
export async function checkUploadSource(p: string): Promise<{ ok: true; size: number; name: string } | { ok: false; name: string; reason: string }> {
  const name = basename(p)
  const st = await lstatMaybe(p)
  if (!st) return { ok: false, name, reason: 'not found' }
  if (st.isSymbolicLink()) return { ok: false, name, reason: 'is a symbolic link; drop the file it points to' }
  if (st.isDirectory()) return { ok: false, name, reason: 'is a folder; only files can be uploaded' }
  if (!st.isFile()) return { ok: false, name, reason: 'is not a regular file' }
  return { ok: true, size: st.size, name }
}
