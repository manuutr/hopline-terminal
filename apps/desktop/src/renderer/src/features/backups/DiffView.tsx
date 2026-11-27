import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor/editor'
import { getTheme } from '../../design/theme'
import type { LineChange } from './changes'

type MonacoModule = typeof import('./monaco')

let loading: Promise<MonacoModule> | null = null
/** The Monaco chunk, loaded once on the first diff (not at startup). */
export const loadMonaco = (): Promise<MonacoModule> => (loading ??= import('./monaco'))

export interface DiffHandle {
  go(dir: 'next' | 'previous'): void
  reveal(line: number, side: 'modified' | 'original'): void
}

export interface DiffSide {
  text: string
  platform: string
}

/** Monaco's diff editor over two config texts: read-only, stanza folding and sticky headers. */
export const DiffView = forwardRef<DiffHandle, { original: DiffSide; modified: DiffSide; sideBySide: boolean; collapseUnchanged: boolean; onChanges: (c: LineChange[]) => void }>(function DiffView(
  { original, modified, sideBySide, collapseUnchanged, onChanges },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const mod = useRef<MonacoModule | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onChangesRef = useRef(onChanges)
  onChangesRef.current = onChanges

  useImperativeHandle(ref, () => ({
    go: (dir) => editor.current?.goToDiff(dir),
    reveal: (line, side) => {
      const e = side === 'modified' ? editor.current?.getModifiedEditor() : editor.current?.getOriginalEditor()
      e?.revealLineInCenter(line)
      e?.setPosition({ lineNumber: line, column: 1 })
      e?.focus()
    }
  }))

  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    loadMonaco()
      .then((m) => {
        if (disposed || !host.current) return
        mod.current = m
        const theme = () => (getTheme() !== 'light' ? 'hopline-dark' : 'hopline-light')
        const d = m.monaco.editor.createDiffEditor(host.current, {
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          theme: theme(),
          renderSideBySide: sideBySide,
          useInlineViewWhenSpaceIsLimited: false,
          minimap: { enabled: false },
          fontFamily: 'JetBrains Mono Variable, ui-monospace, monospace',
          fontSize: 12.5,
          lineHeight: 19,
          scrollBeyondLastLine: false,
          stickyScroll: { enabled: true, defaultModel: 'foldingProviderModel', maxLineCount: 4 },
          folding: true,
          renderOverviewRuler: false,
          ignoreTrimWhitespace: false,
          renderIndicators: true,
          hideUnchangedRegions: { enabled: collapseUnchanged, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
          diffAlgorithm: 'advanced',
          contextmenu: false,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
        })
        editor.current = d
        const sub = d.onDidUpdateDiff(() => onChangesRef.current((d.getLineChanges() ?? []) as LineChange[]))
        const onTheme = () => m.monaco.editor.setTheme(theme())
        window.addEventListener('hopline:theme', onTheme)
        off = () => {
          sub.dispose()
          window.removeEventListener('hopline:theme', onTheme)
        }
        setReady(true)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      disposed = true
      off?.()
      const d = editor.current
      const models = d?.getModel()
      d?.dispose()
      models?.original.dispose()
      models?.modified.dispose()
      editor.current = null
    }
    // Created once; options and models are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const d = editor.current
    const m = mod.current
    if (!ready || !d || !m) return
    const prev = d.getModel()
    d.setModel({ original: m.makeModel(original.text, original.platform), modified: m.makeModel(modified.text, modified.platform) })
    prev?.original.dispose()
    prev?.modified.dispose()
  }, [ready, original.text, original.platform, modified.text, modified.platform])

  useEffect(() => {
    editor.current?.updateOptions({ renderSideBySide: sideBySide, hideUnchangedRegions: { enabled: collapseUnchanged } })
  }, [ready, sideBySide, collapseUnchanged])

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={host} data-testid="backup-diff" className="absolute inset-0" />
      {!ready && !error && <div className="absolute inset-0 flex items-center justify-center text-xs text-fg-subtle">Loading the diff viewer…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center text-xs text-danger">Could not load the diff viewer: {error}</div>}
    </div>
  )
})
