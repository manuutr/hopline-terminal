import { useEffect, useMemo, useState } from 'react'
import { Download, Search, Trash2 } from 'lucide-react'
import { fmtWhen } from '../../lib/when'
import { toast } from '../../lib/notify'
import type { KnownHost } from '@shared/types'
import { Badge, Button, Dialog, EmptyState, Input, LoadError, Loading, useLoad } from '../../design'
import { notifyError } from '../../lib/connect'

export const openKnownHosts = (): void => void window.dispatchEvent(new Event('hopline:known-hosts'))

const SOURCE: Record<KnownHost['source'], string> = { tofu: 'first use', import: 'imported', user: 'approved' }

/** Trusted SSH host keys: search, forget, and import from OpenSSH. */
export function KnownHostsDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const list = useLoad(() => window.hopline.knownHosts.list(), [], false)
  const rows: KnownHost[] = list.data ?? []
  const load = list.reload
  useEffect(() => {
    const on = () => {
      setOpen(true)
      void load()
    }
    window.addEventListener('hopline:known-hosts', on)
    return () => window.removeEventListener('hopline:known-hosts', on)
  }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? rows.filter((r) => `${r.host}:${r.port} ${r.fingerprint}`.toLowerCase().includes(needle)) : rows
  }, [rows, q])

  // The row disappearing is the confirmation; the key is trusted again on the next connection.
  const forget = async (r: KnownHost) => {
    try {
      await window.hopline.knownHosts.remove(r.host, r.port)
    } catch (e) {
      notifyError(`Could not forget ${r.host}:${r.port}`, e)
    }
    void load()
  }

  const importSsh = async () => {
    try {
      const r = await window.hopline.knownHosts.importOpenSsh()
      const extra = [r.alreadyKnown && `${r.alreadyKnown} already known`, r.hashed && `${r.hashed} hashed (skipped)`, r.skipped && `${r.skipped} other lines skipped`].filter(Boolean)
      if (r.conflicts.length)
        toast.warning(`Imported ${r.added} keys; ${r.conflicts.length} host(s) differ from what Hopline Terminal trusts`, {
          description: `Left unchanged: ${r.conflicts.slice(0, 5).map((c) => `${c.host}:${c.port}`).join(', ')}${r.conflicts.length > 5 ? '…' : ''}`
        })
      else toast.success(`Imported ${r.added} host keys`, { description: extra.join(' · ') || r.file })
      void load()
    } catch (e) {
      notifyError('Import failed', e)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Known hosts"
      description="SSH host keys Hopline Terminal trusts. A device presenting any other key is stopped with a warning. Forget a host to trust its key again on the next connection."
      className="w-[min(760px,94vw)]"
      footer={
        <Button onClick={() => void importSsh()}>
          <Download className="size-3.5" /> Import ~/.ssh/known_hosts
        </Button>
      }
    >
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by host or fingerprint" className="pl-8" aria-label="Filter known hosts" />
      </div>
      {list.error ? (
        <LoadError what="known hosts" error={list.error} onRetry={() => void load()} />
      ) : list.loading && !list.data ? (
        <Loading what="known hosts" />
      ) : shown.length === 0 ? (
        <EmptyState action={rows.length ? <Button size="sm" onClick={() => setQ('')}>Clear filter</Button> : undefined} title={rows.length ? 'No matches' : 'No trusted hosts yet'} body={rows.length ? 'Try another filter.' : 'Keys are added the first time you connect to a device, or import them from OpenSSH.'} />
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-2xs text-fg-subtle">
            <tr>
              <th className="py-1.5 font-medium">Host</th>
              <th className="py-1.5 font-medium">Fingerprint</th>
              <th className="py-1.5 font-medium">Added</th>
              <th className="sr-only">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.host}:${r.port}:${r.fingerprint}`} className="group border-t border-line">
                <td className="py-1.5 pr-3 font-mono">
                  {r.host}
                  {r.port !== 22 && <span className="text-fg-subtle">:{r.port}</span>}
                </td>
                <td className="max-w-[300px] truncate py-1.5 pr-3 font-mono text-fg-muted" title={r.fingerprint}>
                  {r.keyType && <span className="mr-1.5 text-fg-subtle">{r.keyType.replace(/^ssh-|^ecdsa-sha2-/, '')}</span>}
                  {r.fingerprint.replace(/^SHA256:/, '')}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-fg-subtle">
                  {fmtWhen(r.addedAt)} <Badge>{SOURCE[r.source] ?? r.source}</Badge>
                </td>
                <td className="py-1.5 text-right">
                  <Button size="icon-sm" variant="ghost" aria-label={`Forget ${r.host}:${r.port}`} onClick={() => void forget(r)} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100">
                    <Trash2 className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  )
}
