import { Check } from 'lucide-react'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Settings } from '@shared/types'
import type { CustomTheme } from '@shared/ux'
import { cn, Segmented } from '../../design'
import { getTheme } from '../../design/theme'
import { allTermThemes, isLightBg, terminalTheme } from '../terminal/theme'
import { ThemePreview } from './TerminalPreview'

const FILTERS = [{ value: 'all', label: 'All' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] as const

function subscribeTheme(update: () => void): () => void {
  window.addEventListener('hopline:theme', update)
  return () => window.removeEventListener('hopline:theme', update)
}

export function PaletteBrowser({ form, custom, onSelect }: { form: Settings; custom: readonly CustomTheme[]; onSelect(id: string): void }): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | 'dark' | 'light'>('all')
  const list = useRef<HTMLDivElement>(null)
  const tone = useSyncExternalStore(subscribeTheme, getTheme)
  const themes = allTermThemes(custom)
  const selected = themes.find((t) => t.id === form.termTheme) ?? themes[0]!
  const automatic = terminalTheme('auto')
  const term = selected.colors ?? automatic
  const mode = selected.colors ? (isLightBg(term.background) ? 'Light' : 'Dark') : `Follows app · ${tone}`
  const visible = themes.filter((t) => filter === 'all' || (t.colors && isLightBg(t.colors.background) === (filter === 'light')))
    .sort((a, b) => Number(!!a.colors) - Number(!!b.colors) || a.label.localeCompare(b.label))

  // Keep the saved choice in view when Settings reopens, without moving focus or the outer panel.
  useLayoutEffect(() => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>('[data-selected="true"]')
    if (!box) return
    if (!row) {
      box.scrollTop = 0
      return
    }
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop
    if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight
  }, [filter, selected.id])

  return (
    <div data-setting-key="themeLibrary" className="@container pt-1">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Segmented label="Filter terminal palettes" value={filter} onChange={setFilter} items={FILTERS} />
        <span className="text-xs tabular-nums text-fg-muted">{visible.length} palettes</span>
      </div>
      <div className="grid min-w-0 gap-3 @[560px]:grid-cols-[minmax(12rem,0.9fr)_minmax(0,1.6fr)]">
        <div ref={list} role="radiogroup" aria-label="Terminal palettes" className="relative max-h-44 min-w-0 overflow-auto rounded-md border border-line bg-surface p-1">
          {visible.map((t) => {
            const color = t.colors ?? automatic
            const checked = t.id === selected.id
            return (
              <label key={t.id} data-selected={checked} className={cn('relative flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent', checked && 'bg-active')}>
                <input type="radio" name="terminal-palette" className="absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0" checked={checked} onChange={() => onSelect(t.id)} />
                <span aria-hidden="true" style={{ backgroundColor: color.background }} className="flex shrink-0 items-center gap-0.5 rounded-sm border border-line-strong px-1 py-1">
                  {(['red', 'green', 'blue'] as const).map((k) => <span key={k} className="h-2 w-1.5 rounded-[1px]" style={{ backgroundColor: color[k] }} />)}
                </span>
                <span className="min-w-0 flex-1 truncate" title={t.label}>{t.colors ? t.label : 'Hopline Terminal'}</span>
                {checked && <Check aria-hidden className="size-3.5 shrink-0 text-accent" />}
              </label>
            )
          })}
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <span className="break-words text-sm font-medium text-fg">{selected.colors ? selected.label : 'Hopline Terminal'}</span>
            <span className="text-xs text-fg-muted">{mode}</span>
          </div>
          <div key={selected.id} className="animate-workspace-in"><ThemePreview term={term} font={form} label={selected.label} /></div>
        </div>
      </div>
    </div>
  )
}
