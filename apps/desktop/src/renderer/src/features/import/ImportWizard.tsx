import { AppWindow, FileCode2, FolderTree, LoaderCircle, Network, RefreshCw, Sheet, SquareTerminal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { SessionImportPlan, SessionImportSource } from '@shared/types'
import { Button, cn, Dialog, Input, Label, Segmented } from '../../design'
import { fmtWhen } from '../../lib/when'
import { errorText } from '../settings/parts'
import { ReviewBody, ReviewFooter, useReview } from './ImportReview'
import { closeImport, resyncNetBox, showPlan, useImport } from './store'

const SOURCES: { id: SessionImportSource; name: string; hint: string; icon: ReactNode }[] = [
  { id: 'securecrt', name: 'SecureCRT', hint: 'Sessions folder or XML export', icon: <FolderTree /> },
  { id: 'mobaxterm', name: 'MobaXterm', hint: '.mxtsessions export', icon: <AppWindow /> },
  { id: 'putty', name: 'PuTTY', hint: 'Registry export (.reg)', icon: <SquareTerminal /> },
  { id: 'ssh-config', name: 'OpenSSH', hint: 'ssh_config', icon: <FileCode2 /> },
  { id: 'csv', name: 'CSV', hint: 'Spreadsheet or inventory export', icon: <Sheet /> },
  { id: 'netbox', name: 'NetBox / Nautobot', hint: 'Devices from the API', icon: <Network /> }
]

const Path = ({ children }: { children: ReactNode }) => <code className="break-all rounded-sm bg-active px-1 py-px font-mono text-2xs text-fg">{children}</code>

/** Paths, steps and caveats per source: shown next to the pick buttons. */
function SourceHelp({ source }: { source: SessionImportSource }): React.JSX.Element {
  const li = 'flex gap-2 [&>span:first-child]:w-16 [&>span:first-child]:shrink-0 [&>span:first-child]:text-fg-subtle'
  switch (source) {
    case 'securecrt':
      return (
        <ul className="space-y-1.5 text-xs text-fg-muted">
          <li className={li}><span>Windows</span><Path>%APPDATA%\VanDyke\Config\Sessions</Path></li>
          <li className={li}><span>macOS</span><Path>~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions</Path></li>
          <li className={li}><span>Linux</span><Path>~/.vandyke/SecureCRT/Config/Sessions</Path></li>
          <li className="pt-1 text-fg-subtle">Or export one file from Tools → Export Settings. Subfolders become folders; Firewall sessions become jump hosts.</li>
        </ul>
      )
    case 'mobaxterm':
      return <p className="text-xs text-fg-muted">In MobaXterm, right-click <span className="text-fg">User sessions</span> and choose <span className="text-fg">Export all sessions to file</span>. Bookmark folders become folders.</p>
    case 'putty':
      return (
        <div className="space-y-1.5 text-xs text-fg-muted">
          <p>Export the saved sessions from a Command Prompt:</p>
          <Path>reg export HKCU\Software\SimonTatham\PuTTY\Sessions putty.reg</Path>
        </div>
      )
    case 'ssh-config':
      return <p className="text-xs text-fg-muted">Every concrete <Path>Host</Path> becomes a session and <Path>ProxyJump</Path> becomes its jump host. Wildcard defaults are applied, <Path>Include</Path> is not followed, and <Path>Match exec</Path> or <Path>ProxyCommand</Path> are never run.</p>
    case 'csv':
      return <p className="text-xs text-fg-muted">Columns are recognised from the header (name, host or IP, port, protocol, username, folder, platform, tags, notes). You can map them by hand in the next step. Password columns are never imported.</p>
    case 'netbox':
      return <></>
  }
}

function NetBoxForm({ busy, run }: { busy: boolean; run: (f: () => Promise<SessionImportPlan | null>) => void }): React.JSX.Element {
  const saved = useImport((s) => s.netbox)
  const [flavor, setFlavor] = useState<'netbox' | 'nautobot'>(saved?.flavor ?? 'netbox')
  const [url, setUrl] = useState(saved?.url ?? '')
  const [token, setToken] = useState('')
  const [filter, setFilter] = useState(saved?.filter ?? '')
  useEffect(() => {
    if (!saved) return
    setFlavor(saved.flavor)
    setUrl(saved.url)
    setFilter(saved.filter)
  }, [saved])
  const sameServer = !!saved && url.trim().replace(/\/+$/, '').replace(/\/api$/i, '') === saved.url
  const canUseSaved = sameServer && saved.hasToken
  const fetchNow = () => run(() => window.hopline.importer.fetchNetBox({ url: url.trim(), flavor, filter, ...(token.trim() ? { token: token.trim() } : {}) }))
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim() && (token.trim() || canUseSaved)) fetchNow()
      }}
    >
      <Segmented
        label="API"
        value={flavor}
        onChange={setFlavor}
        items={[
          { value: 'netbox', label: 'NetBox' },
          { value: 'nautobot', label: 'Nautobot' }
        ]}
      />
      <div className="space-y-1">
        <Label htmlFor="nb-url">Server URL</Label>
        <Input id="nb-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://netbox.example.com" className="font-mono text-xs" autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="nb-token">API token</Label>
        <Input
          id="nb-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={canUseSaved ? 'Saved in your vault. Enter a new one to replace it.' : 'Read-only token'}
          autoComplete="off"
        />
        <p className="text-2xs text-fg-subtle">Stored in your vault and only ever sent to this server. A read-only token is enough.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="nb-filter">Filter</Label>
        <Input id="nb-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="site=ams1&status=active&role=core" className="font-mono text-xs" autoComplete="off" />
        <p className="text-2xs text-fg-subtle">Any {flavor === 'netbox' ? 'NetBox' : 'Nautobot'} device filter, as a query string. Empty: every device. Sites become folders.</p>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={busy || !url.trim() || !(token.trim() || canUseSaved)}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Network />} {busy ? 'Fetching…' : 'Fetch devices'}
        </Button>
        {saved && sameServer && saved.lastSyncAt && (
          <span className="text-2xs text-fg-subtle">Last synced {fmtWhen(saved.lastSyncAt)}</span>
        )}
      </div>
    </form>
  )
}

function SourceStep(): React.JSX.Element {
  const source = useImport((s) => s.source)
  const saved = useImport((s) => s.netbox)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [source])

  const run = (key: string) => (f: () => Promise<SessionImportPlan | null>) => {
    setBusy(key)
    setError(null)
    void f()
      .then((p) => p && showPlan(p))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null))
  }
  const pick = (mode: 'file' | 'dir' | 'default', key: string = mode) => run(key)(() => window.hopline.importer.pick(source as Exclude<SessionImportSource, 'netbox'>, mode))
  const spin = (key: string, icon: ReactNode) => (busy === key ? <LoaderCircle className="animate-spin" /> : icon)
  const meta = SOURCES.find((s) => s.id === source)!

  return (
    <div className="grid min-h-[360px] grid-cols-[200px_1fr] gap-5">
      <div role="radiogroup" aria-label="Import from" className="-ml-1 flex flex-col gap-0.5">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={source === s.id}
            onClick={() => useImport.setState({ source: s.id })}
            className={cn(
              'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
              source === s.id ? 'bg-accent-soft text-fg [&_svg]:text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg [&_svg]:text-fg-subtle'
            )}
          >
            {s.icon}
            <span className="min-w-0">
              <span className="block truncate text-sm">{s.name}</span>
              <span className="block truncate text-2xs text-fg-subtle">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <div key={source} className="min-w-0 animate-fade-in border-l border-line pl-5">
        <h3 className="text-sm font-medium text-fg">{meta.name}</h3>
        <p className="mb-4 mt-0.5 text-xs text-fg-subtle">You review every session before anything is written. Passwords are never imported.</p>
        {source === 'netbox' ? (
          <NetBoxForm busy={!!busy} run={run('netbox')} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {source === 'securecrt' && (
                <>
                  <Button variant="primary" disabled={!!busy} onClick={() => pick('dir')}>
                    {spin('dir', <FolderTree />)} Choose Sessions folder…
                  </Button>
                  <Button disabled={!!busy} onClick={() => pick('file')}>
                    {spin('file', <FileCode2 />)} Choose XML export…
                  </Button>
                </>
              )}
              {source === 'ssh-config' && (
                <>
                  <Button variant="primary" disabled={!!busy} onClick={() => pick('default')}>
                    {spin('default', <FileCode2 />)} Import ~/.ssh/config
                  </Button>
                  <Button disabled={!!busy} onClick={() => pick('file')}>
                    {spin('file', null)} Choose another file…
                  </Button>
                </>
              )}
              {(source === 'mobaxterm' || source === 'putty' || source === 'csv') && (
                <Button variant="primary" disabled={!!busy} onClick={() => pick('file')}>
                  {spin('file', meta.icon)} Choose file…
                </Button>
              )}
            </div>
            <SourceHelp source={source} />
          </div>
        )}
        {error && (
          <p role="alert" className="mt-4 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        {source === 'netbox' && saved && (
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0 text-xs">
              <div className="text-fg">Saved source</div>
              <div className="truncate font-mono text-2xs text-fg-subtle">
                {saved.url}
                {saved.filter ? `?${saved.filter}` : ''}
              </div>
            </div>
            <Button size="sm" disabled={!!busy || !saved.hasToken} onClick={() => void resyncNetBox()}>
              <RefreshCw /> Re-sync
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** "Import sessions…": pick a source, review the diff, apply. */
export function ImportWizard(): React.JSX.Element {
  const { open, step, plan } = useImport()
  const preview = step === 'preview' && plan
  const review = useReview(preview ? plan : null)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && closeImport()}
      title={preview ? (plan.resync ? 'Re-sync from NetBox' : 'Review import') : 'Import sessions'}
      description={preview ? plan.label : 'From another terminal, an ssh_config, a spreadsheet or your source of truth.'}
      className="w-[min(920px,95vw)]"
      footer={preview ? <ReviewFooter review={review} /> : <Button variant="ghost" onClick={closeImport}>Cancel</Button>}
    >
      {preview ? <ReviewBody review={review} /> : <SourceStep />}
    </Dialog>
  )
}
