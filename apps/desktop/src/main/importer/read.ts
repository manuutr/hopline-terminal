import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { decodeText, importCsv, importMobaXterm, importPutty, importSecureCrt, importSshConfig, type CsvImportResult, type CsvMapping, type ImportResult } from '@hopline/importers'
import type { SessionImportSource } from '@shared/types'

/** Same cap as the importers' own (32 MB of text), checked on bytes before decoding. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024
/** A SecureCRT Sessions tree: enough for very large estates, small enough not to stall main. */
const MAX_TREE_FILES = 20_000
const MAX_TREE_BYTES = 128 * 1024 * 1024
const MAX_DEPTH = 24

export type FileSource = Exclude<SessionImportSource, 'netbox'>

/** What a picker returned, read into memory. CSV keeps its text so it can be re-mapped. */
export interface ReadSource {
  source: SessionImportSource
  label: string
  /** CSV: may say `headerless` (row 1 read as data). */
  result: ImportResult | CsvImportResult
  csvText?: string
}

async function readText(path: string): Promise<string> {
  const st = await stat(path)
  if (!st.isFile()) throw new Error(`${basename(path)} is not a file`)
  if (st.size > MAX_FILE_BYTES) throw new Error(`${basename(path)} is too large to import (${Math.round(st.size / 1048576)} MB)`)
  return decodeText(await readFile(path))
}

/**
 * Every `.ini` and `.xml` below a SecureCRT folder, with paths the importer understands: relative to
 * the picked folder, prefixed with "Sessions/" when the picked folder is the Sessions folder itself
 * (so its subfolders become folders, not the folder's own name). Symlinks are not followed.
 */
export async function readSecureCrtTree(dir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  let bytes = 0
  const prefix = basename(dir).toLowerCase() === 'sessions' ? 'Sessions/' : ''
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    const entries = await readdir(d, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        await walk(p, depth + 1)
        continue
      }
      if (!e.isFile() || !/\.(ini|xml)$/i.test(e.name)) continue
      if (out.length >= MAX_TREE_FILES) throw new Error(`More than ${MAX_TREE_FILES} files in that folder: pick the SecureCRT Sessions folder itself`)
      const size = (await lstat(p)).size
      bytes += size
      if (size > MAX_FILE_BYTES || bytes > MAX_TREE_BYTES) throw new Error('That folder is too large to import: pick the SecureCRT Sessions folder itself')
      out.push({ path: prefix + relative(dir, p).split(sep).join('/'), text: decodeText(await readFile(p)) })
    }
  }
  await walk(dir, 0)
  return out
}

/** Read and parse one picked file or folder. */
export async function readSource(source: FileSource, path: string, isDir: boolean): Promise<ReadSource> {
  const home = homedir()
  const label = home && (path === home || path.startsWith(home + sep)) ? '~' + path.slice(home.length) : path
  switch (source) {
    case 'securecrt': {
      const files = isDir ? await readSecureCrtTree(path) : [{ path: basename(path), text: await readText(path) }]
      if (!files.length) throw new Error('No SecureCRT session files (.ini) in that folder. Pick the Config/Sessions folder or an XML export.')
      return { source, label, result: importSecureCrt(files) }
    }
    case 'mobaxterm':
      return { source, label, result: importMobaXterm(await readText(path)) }
    case 'putty':
      return { source, label, result: importPutty(await readText(path)) }
    case 'ssh-config':
      return { source, label, result: importSshConfig(await readText(path)) }
    case 'csv': {
      const text = await readText(path)
      return { source, label, result: importCsv(text), csvText: text }
    }
  }
}

/** Re-run the CSV importer with a column mapping (0-based indexes). */
export function remapCsv(text: string, mapping: CsvMapping, hasHeader: boolean): CsvImportResult {
  return importCsv(text, mapping, { hasHeader })
}
