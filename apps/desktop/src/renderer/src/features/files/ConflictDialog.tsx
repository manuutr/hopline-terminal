import { useRef, useState } from 'react'
import type { ConflictChoice } from '@shared/files'
import { Button, Dialog } from '../../design'
import { fmtWhen } from '../../lib/when'
import { answerConflict, formatBytes, useFiles } from './store'

const when = (s: number) => (s ? fmtWhen(s * 1000) : '')

/**
 * "x already exists": Keep both (default, Enter), Skip, Replace, or Resume a shorter copy (SFTP
 * uploads). Answers the queue one conflict at a time; "do the same for the rest" applies the
 * choice to every conflict still waiting.
 */
export function ConflictHost(): React.JSX.Element {
  const conflicts = useFiles((s) => s.conflicts)
  const c = conflicts[0]
  const [all, setAll] = useState(false)
  const keep = useRef<HTMLButtonElement>(null)
  const skip = useRef<HTMLButtonElement>(null)
  const answer = (choice: ConflictChoice) => {
    if (!c) return
    const rest = all ? conflicts.slice(1) : []
    void answerConflict(c, choice)
    // Resume only applies where it can; the rest of a batch gets the choice that always works.
    for (const r of rest) void answerConflict(r, choice === 'resume' && !r.canResume ? 'overwrite' : choice)
    setAll(false)
  }
  const where = c?.direction === 'download' ? 'in the download folder' : 'on the device'
  const unknown = c && !c.existing
  return (
    <Dialog
      open={!!c}
      onOpenChange={(o) => !o && answer('skip')}
      title={unknown ? `Copy to ${c?.name}?` : `${c?.name ?? ''} already exists`}
      variant="alert"
      className="w-[min(460px,92vw)]"
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        // Never the danger button: "Keep both" when the file is known to exist, else Skip (round 2).
        ;(keep.current ?? skip.current)?.focus()
      }}
      footer={
        <>
          <Button ref={skip} variant="secondary" onClick={() => answer('skip')}>
            Skip
          </Button>
          {c?.canResume && (
            <Button variant="secondary" onClick={() => answer('resume')}>
              Resume
            </Button>
          )}
          {!unknown && (
            <Button ref={keep} variant="secondary" onClick={() => answer('rename')}>
              Keep both
            </Button>
          )}
          <Button variant="danger" onClick={() => answer('overwrite')}>
            Replace
          </Button>
        </>
      }
    >
      {unknown ? (
        <p>SCP can’t check whether this file is already on the device. If it is, the device replaces it.</p>
      ) : (
        <p>
          A file with this name is already {where}. <span className="tabular-nums">{c?.existing ? `${formatBytes(c.existing.size)}${c.existing.mtime ? `, ${when(c.existing.mtime)}` : ''}` : ''}</span>
          {c?.incoming.size ? <span className="tabular-nums"> · the new one is {formatBytes(c.incoming.size)}</span> : null}.
          {c?.canResume && ' The copy there is shorter: Resume continues it.'}
        </p>
      )}
      {conflicts.length > 1 && (
        <label className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" className="accent-[var(--c-accent)]" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Do the same for the other {conflicts.length - 1}
        </label>
      )}
    </Dialog>
  )
}
