import { cleanTerminalText } from './cli'
import { rootsFor } from './files'

export interface ScpDirectoryEntry { name: string; folder: boolean; size: number }

export const supportsScpDirectory = (platform: string) => ['ios', 'iosxe', 'c9800'].includes(platform)

/** IOS supplies the index on a separate SSH exec channel. SCP itself has no readdir. */
export function directoryCommand(platform: string, path: string): string {
  const root = rootsFor(platform).find((r) => path.startsWith(r))
  const parts = root ? path.slice(root.length).split('/').filter(Boolean) : []
  if (!supportsScpDirectory(platform) || !root || path.length > 1024 || parts.some((s) => !/^[a-z\d_.-]+$/i.test(s) || s === '.' || s === '..')) {
    throw new Error('This directory cannot be listed. Enter a full file path to preview or download it.')
  }
  return 'dir ' + path
}

export function parseScpDirectory(raw: string): ScpDirectoryEntry[] {
  const text = cleanTerminalText(raw)
  if (!/^\s*Directory of /im.test(text)) throw new Error('The device did not return a directory listing. You can still use a full file path.')
  const entries: ScpDirectoryEntry[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*\d+\s+([d-][rwx-]{3})\s+(\d+)\s+\w{3}\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:\s+[+-]\d{2}:\d{2})?\s+(.+?)\s*$/.exec(line)
    if (!m) {
      if (/^\s*\d+\s+[d-][rwx-]/.test(line)) throw new Error('Unrecognised directory format. Use the full path to open a file.')
      continue
    }
    const name = m[3]!
    if (!/[/:\\]/.test(name) && name !== '.' && name !== '..') entries.push({ name, folder: m[1]![0] === 'd', size: Number(m[2]) })
  }
  return entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name))
}
