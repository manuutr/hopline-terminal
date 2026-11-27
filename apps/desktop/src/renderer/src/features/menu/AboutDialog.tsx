import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { AppInfo } from '@shared/types'
import { Button, Dialog } from '../../design'
import { writeClipboard } from '../../lib/clipboard'
import { toast } from '../../lib/notify'

export const useAbout = create<{ open: boolean }>(() => ({ open: false }))

const ROWS: [keyof AppInfo, string][] = [
  ['version', 'Version'],
  ['electron', 'Electron'],
  ['chrome', 'Chromium'],
  ['node', 'Node.js'],
  ['v8', 'V8'],
  ['os', 'OS'],
  ['license', 'Licence']
]

/** The text "Copy version info" puts on the clipboard (bug reports). */
export const versionText = (i: AppInfo): string => ROWS.map(([k, l]) => `${l}: ${i[k]}`).join('\n')

/** Help › About (and the macOS app menu's About): an in-app dialog, not the OS panel. */
export function AboutDialog(): React.JSX.Element {
  const open = useAbout((s) => s.open)
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    if (open && !info) void window.hopline.app.info().then(setInfo)
  }, [open, info])
  const close = () => useAbout.setState({ open: false })
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="About Hopline Terminal"
      description="SSH, Telnet and serial client for network engineers."
      className="w-[min(420px,92vw)]"
      footer={
        <>
          <Button
            variant="ghost"
            disabled={!info}
            onClick={() => {
              if (!info) return
              void writeClipboard(versionText(info)).then(() => toast.success('Version info copied'))
            }}
          >
            Copy version info
          </Button>
          <Button variant="secondary" onClick={close} data-autofocus>
            Close
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 text-sm" data-about>
        {ROWS.map(([k, label]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{label}</dt>
            <dd className="min-w-0 truncate font-mono text-xs leading-5 text-fg">{info ? info[k] : '…'}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}
