import { useEffect, useState } from 'react'
import { remoteBase, type FilePreview } from '@shared/files'
import { isCaptureName } from '@shared/packets'
import { openTrace } from '../packets/store'
import { Button, Dialog } from '../../design'
import { cleanError, formatBytes } from './store'

export function FilePreviewDialog({ tabId, path, close }: { tabId: string; path: string; close(): void }): React.JSX.Element {
  const [result, setResult] = useState<FilePreview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.hopline.transfer.preview(tabId, path).then(
      (value) => { if (active) setResult(value) },
      (e) => { if (active) setError(cleanError(e)) }
    )
    return () => { active = false }
  }, [tabId, path])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }} title={`Preview ${remoteBase(path)}`} description={path}
      className="w-[min(56rem,92vw)]" footer={<><Button onClick={close}>Close</Button>{isCaptureName(path) &&
        <Button variant="primary" onClick={() => { close(); void openTrace({ kind: 'remote', tabId, path }) }}>Transfer and analyze</Button>}</>}>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : !result ? (
        <p role="status" className="text-sm text-fg-muted">Reading file…</p>
      ) : result.kind === 'text' ? (
        <>
          <p className="mb-2 text-xs text-fg-muted">{formatBytes(result.bytes)} · UTF-8{result.redactions > 0 && ' · Sensitive values masked'}</p>
          {result.text ? <pre aria-label="File contents" tabIndex={0} className="max-h-[55vh] select-text overflow-auto rounded border border-line bg-surface p-3 font-mono text-xs text-fg">{result.text}</pre> : <p className="text-sm text-fg-muted">Empty file.</p>}
        </>
      ) : <p role="status" className="text-sm text-fg-muted">{formatBytes(result.bytes)} · {result.kind === 'large' ? 'Preview supports files up to 256 KiB.' : 'This file contains binary data.'} Choose Download in Files to save it.</p>}
    </Dialog>
  )
}
