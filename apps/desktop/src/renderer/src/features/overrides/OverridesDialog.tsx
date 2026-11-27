import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { resolveOverrides, type HostOverrides, type OverrideKey } from '@shared/ux'
import type { Settings } from '@shared/types'
import { Button, cn, Dialog, Input, Segmented, Select } from '../../design'
import { notifyError } from '../../lib/connect'
import { openSettings } from '../../lib/settings-nav'
import { useUi } from '../../store'
import { Toggle } from '../settings/parts'
import { allTermThemes } from '../terminal/theme'
import { ThemeOptions } from '../themes/ThemeOptions'
import { useThemes } from '../themes/store'
import { useOverrides } from './store'

/** Which session or folder the dialog edits (null: closed). */
export const useOverridesDialog = create<{ target: { scope: 'session' | 'folder'; id: string } | null }>(() => ({ target: null }))

export const openOverrides = (scope: 'session' | 'folder', id: string): void => useOverridesDialog.setState({ target: { scope, id } })

type Def = { key: OverrideKey; label: string; group: 'Terminal' | 'Connection'; settingsKey: string }
const DEFS: Def[] = [
  { key: 'termTheme', label: 'Theme', group: 'Terminal', settingsKey: 'termTheme' },
  { key: 'termFontFamily', label: 'Font', group: 'Terminal', settingsKey: 'termFontFamily' },
  { key: 'termFontSize', label: 'Font size', group: 'Terminal', settingsKey: 'termFontSize' },
  { key: 'termLineHeight', label: 'Line height', group: 'Terminal', settingsKey: 'termFontSize' },
  { key: 'termCursorStyle', label: 'Cursor', group: 'Terminal', settingsKey: 'termCursorStyle' },
  { key: 'termHighlight', label: 'Output highlighting', group: 'Terminal', settingsKey: 'termHighlight' },
  { key: 'termAutocomplete', label: 'Autocomplete', group: 'Terminal', settingsKey: 'termAutocomplete' },
  { key: 'keepAliveSec', label: 'Keep-alive', group: 'Connection', settingsKey: 'keepAliveSec' },
  { key: 'autoReconnect', label: 'Auto-reconnect', group: 'Connection', settingsKey: 'autoReconnect' },
  { key: 'logToFile', label: 'Log to file', group: 'Connection', settingsKey: 'logDir' }
]

type Values = Required<HostOverrides>

const show = (k: OverrideKey, v: unknown, themes: { id: string; label: string }[]): string => {
  if (typeof v === 'boolean') return v ? 'On' : 'Off'
  if (k === 'termTheme') return themes.find((t) => t.id === v)?.label ?? String(v)
  if (k === 'termFontFamily') return (v as string) || 'JetBrains Mono (bundled)'
  if (k === 'keepAliveSec') return v === 0 ? 'Off' : `${v} s`
  if (k === 'termFontSize') return `${v} px`
  if (k === 'termCursorStyle') return String(v)[0]!.toUpperCase() + String(v).slice(1)
  return String(v)
}

/**
 * Per-host overrides for one session or folder: each setting either inherits (from the folders
 * above, or the global Settings) or is set here. A folder's values apply to everything below it.
 * Applied at once to open terminals; keep-alive, auto-reconnect and logging on the next connect.
 */
export function OverridesDialog(): React.JSX.Element | null {
  const target = useOverridesDialog((s) => s.target)
  const { sessions, folders, settings } = useUi()
  const store = useOverrides((s) => s.store)
  const custom = useThemes((s) => s.list)
  const [draft, setDraft] = useState<HostOverrides>({})

  const session = target?.scope === 'session' ? sessions.find((s) => s.id === target.id) : undefined
  const folder = target?.scope === 'folder' ? folders.find((f) => f.id === target.id) : undefined
  useEffect(() => {
    if (!target) return
    setDraft({ ...(target.scope === 'session' ? store.sessions[target.id] : store.folders[target.id]) })
    // Load once per open; later store changes are this dialog's own saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  if (!target || !settings || (!session && !folder)) return null
  const close = () => useOverridesDialog.setState({ target: null })
  const name = session?.name ?? folder!.name
  const themes = allTermThemes(custom)
  const inherited = resolveOverrides(store, folders, session ? { session } : { session: null, folderId: folder!.id }, { inheritedOnly: true })
  // The value a setting has without an override here: a parent folder's, else the global one.
  const base = (k: OverrideKey): unknown => (k in inherited.values ? (inherited.values as Record<string, unknown>)[k] : k === 'logToFile' ? (session?.logToFile ?? false) : settings[k as keyof Settings])
  const from = (k: OverrideKey): string => {
    const o = inherited.origin[k]
    if (o) return `from ${o.name}`
    return k === 'logToFile' ? (session ? 'this session' : 'off') : 'Settings'
  }
  const on = (k: OverrideKey) => k in draft
  const toggle = (k: OverrideKey, v: boolean) => {
    const next = { ...draft }
    if (v) (next as Record<string, unknown>)[k] = base(k)
    else delete next[k]
    setDraft(next)
  }
  const put = <K extends OverrideKey>(k: K, v: Values[K]) => setDraft({ ...draft, [k]: v })
  // A session's own logging switch lives in the session dialog; here only folders can add logging.
  const defs = DEFS.filter((d) => !(session && d.key === 'logToFile'))

  const control = (k: OverrideKey): React.ReactNode => {
    const v = (draft as Record<string, unknown>)[k]
    switch (k) {
      case 'termTheme':
        return (
          <Select value={v as string} onChange={(e) => put('termTheme', e.target.value)} aria-label="Theme override">
            <ThemeOptions custom={custom} />
          </Select>
        )
      case 'termFontFamily':
        return <Input value={v as string} onChange={(e) => put('termFontFamily', e.target.value)} placeholder="JetBrains Mono (bundled)" aria-label="Font override" />
      case 'termFontSize':
        return <Input type="number" min={8} max={32} step={0.5} value={v as number} onChange={(e) => put('termFontSize', Math.min(32, Math.max(8, Number(e.target.value))))} className="w-20" aria-label="Font size override" />
      case 'termLineHeight':
        return <Input type="number" min={1} max={2} step={0.05} value={v as number} onChange={(e) => put('termLineHeight', Math.min(2, Math.max(1, Number(e.target.value))))} className="w-20" aria-label="Line height override" />
      case 'keepAliveSec':
        return <Input type="number" min={0} max={3600} value={v as number} onChange={(e) => put('keepAliveSec', Math.min(3600, Math.max(0, Math.round(Number(e.target.value)))))} className="w-20" aria-label="Keep-alive override" />
      case 'termCursorStyle':
        return (
          <Segmented
            label="Cursor override"
            value={v as Values['termCursorStyle']}
            onChange={(c) => put('termCursorStyle', c)}
            items={[
              { value: 'bar', label: 'Bar' },
              { value: 'block', label: 'Block' },
              { value: 'underline', label: 'Underline' }
            ]}
          />
        )
      default:
        return <Toggle label={`${DEFS.find((d) => d.key === k)!.label} override`} checked={!!v} onChange={(b) => put(k as 'termHighlight', b)} />
    }
  }

  const save = async () => {
    try {
      await useOverrides.getState().set(target.scope, target.id, draft)
      close()
    } catch (e) {
      notifyError('Could not save the overrides', e)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={`Overrides for ${name}`}
      description={folder ? 'Set here, a value applies to every session in this folder and its subfolders, unless one sets its own.' : 'Set here, a value applies to this session only.'}
      className="w-[min(600px,94vw)]"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" disabled={!Object.keys(draft).length} onClick={() => setDraft({})}>
            Inherit all
          </Button>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div data-overrides={target.scope} className="-mx-1">
        {(['Terminal', 'Connection'] as const).map((g) => (
          <section key={g} className="pb-2">
            <h3 className="grid grid-cols-[136px_40px_minmax(0,1fr)] gap-x-3 px-1 pb-1 pt-1 text-xs font-medium text-fg-muted">
              <span>{g}</span>
              {g === 'Terminal' && <span className="whitespace-nowrap text-2xs font-normal text-fg-subtle">Set here</span>}
            </h3>
            {defs
              .filter((d) => d.group === g)
              .map((d) => (
                <div key={d.key} data-override={d.key} className="grid min-h-8 grid-cols-[136px_40px_minmax(0,1fr)] items-center gap-x-3 rounded px-1 py-0.5 hover:bg-hover">
                  <span className={cn('truncate text-sm', on(d.key) ? 'text-fg' : 'text-fg-muted')}>{d.label}</span>
                  <Toggle label={`Override ${d.label.toLowerCase()}`} checked={on(d.key)} onChange={(v) => toggle(d.key, v)} />
                  <div className="flex min-w-0 items-center gap-2">
                    {on(d.key) ? (
                      control(d.key)
                    ) : (
                      <span className="truncate text-xs text-fg-subtle" data-inherited>
                        {show(d.key, base(d.key), themes)} <span>· {from(d.key)}</span>
                      </span>
                    )}
                  </div>
                </div>
              ))}
          </section>
        ))}
        <p className="px-1 pt-1 text-2xs text-fg-subtle">
          Terminal settings apply to open tabs at once; connection settings on the next connect. Global values:{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => (close(), openSettings('terminal'))}>
            Settings
          </button>
          .
        </p>
      </div>
    </Dialog>
  )
}
