import { ArrowUp, File, Folder, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { remoteJoin, remoteParent } from '@shared/files'
import type { ScpDirectoryEntry } from '@shared/scp-directory'
import { Button } from '../../design'
import { cleanError, formatBytes } from './store'

export function ScpDirectory({ tabId, roots, pick }: { tabId: string; roots: string[]; pick(path: string): void }): React.JSX.Element {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<ScpDirectoryEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!path) return
    let active = true
    window.hopline.transfer.listScpDirectory(tabId, path).then(
      (value) => { if (active) setEntries(value) },
      (e) => { if (active) setError(cleanError(e)) }
    )
    return () => { active = false }
  }, [tabId, path])
  const go = (next: string) => {
    if (next === path) return
    setEntries(null)
    setError('')
    setPath(next)
  }
  return (
    <div className="mt-2 max-w-3xl">
      <Button size="sm" aria-expanded={!!path} onClick={() => go(path ? '' : roots[0]!)}><FolderOpen />{path ? 'Close directory' : 'Browse device directory'}</Button>
      {path && <div className="mt-2 rounded border border-line">
        <div className="flex items-center gap-2 border-b border-line p-1">
          <Button size="icon-sm" variant="ghost" aria-label="Parent directory" disabled={roots.includes(path)} onClick={() => go(remoteParent(path))}><ArrowUp /></Button>
          <select aria-label="Filesystem" className="rounded bg-surface p-1 text-xs text-fg" value={roots.find((r) => path.startsWith(r))} onChange={(e) => go(e.target.value)}>{roots.map((r) => <option key={r}>{r}</option>)}</select>
          <span className="truncate font-mono text-xs text-fg-muted">{path}</span>
        </div>
        {error ? <p role="alert" className="p-2 text-xs text-warn">{error} Use Source path below to open a file directly.</p> : entries?.length ? (
          <ul aria-label="Device directory" className="max-h-40 overflow-y-auto">{entries.map((e) => <li key={e.name}>
            <button className="flex min-h-7 w-full items-center gap-2 px-2 text-left text-sm hover:bg-hover focus-visible:bg-hover" onClick={() => {
              const target = remoteJoin(path, e.name)
              if (e.folder) go(target)
              else pick(target)
            }}>
              {e.folder ? <Folder className="size-3.5 text-accent" /> : <File className="size-3.5 text-fg-muted" />}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {!e.folder && <span className="text-xs text-fg-muted">{formatBytes(e.size)}</span>}
            </button>
          </li>)}</ul>
        ) : <p role="status" className="p-2 text-xs text-fg-muted">{entries ? 'Empty directory.' : 'Reading directory…'}</p>}
      </div>}
    </div>
  )
}
