import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Settings } from '@shared/types'
import { checkContrast, generateTheme, type ContrastCheck } from '@shared/oklch'
import { themeIdFor, type ThemeDraft } from '@shared/theme-file'
import type { CustomTheme, UiTokenKey } from '@shared/ux'
import { Badge, Button, cn, Input, Segmented } from '../../design'
import { askConfirm } from '../../lib/confirm'
import { notifyError } from '../../lib/connect'
import { toast } from '../../lib/notify'
import { Row, Section } from '../settings/parts'
import { ThemePreview } from './TerminalPreview'
import { PaletteBrowser } from './PaletteBrowser'
import { BUNDLED_FONT } from '../terminal/theme'
import { canvasRenderer, ligaturesIn, nerdGlyphsIn, LIGATURE_SEQUENCES, NERD_GLYPHS } from './font-check'
import { useThemes } from './store'

type Up = <K extends keyof Settings>(k: K, v: Settings[K]) => void
type FontSettings = Pick<Settings, 'termFontFamily' | 'termFontSize' | 'termLineHeight' | 'termCursorStyle'>

const HEX = /^#[0-9a-f]{6}$/i

/** A strip of the generated UI tokens: the chrome the theme would paint. */
function Swatches({ ui }: { ui: Partial<Record<UiTokenKey, string>> }): React.JSX.Element {
  const keys: UiTokenKey[] = ['canvas', 'surface', 'raised', 'fg', 'fg-muted', 'fg-subtle', 'accent']
  return (
    <div className="flex items-center gap-2" data-ui-swatches>
      {keys.map((k) =>
        ui[k] ? (
          <span key={k} className="flex items-center gap-1 text-2xs text-fg-subtle" title={`${k} ${ui[k]}`}>
            <span className="size-3 rounded-[3px] border border-line-strong" style={{ background: ui[k] }} />
            {k}
          </span>
        ) : null
      )}
    </div>
  )
}

/** The AA report: one summary line, the failures always listed, everything on request. */
function ContrastReport({ checks }: { checks: ContrastCheck[] }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const failed = checks.filter((c) => !c.pass)
  const shown = all ? checks : failed
  return (
    <div data-contrast-report className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        {failed.length ? <span className="text-danger">{failed.length} of {checks.length} pairs fail AA</span> : <span className="text-ok">All {checks.length} pairs pass AA</span>}
        <button type="button" className="text-2xs text-fg-subtle hover:text-fg" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Hide checks' : 'Show every check'}
        </button>
      </div>
      {shown.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 text-2xs" role="table" aria-label="Contrast checks">
          {shown.map((c) => (
            <div key={c.pair} role="row" data-contrast-row={c.pair} className="contents">
              <span role="cell" className="flex items-center gap-1.5 truncate text-fg-muted">
                <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: c.fg, boxShadow: `0 0 0 1px ${c.bg}` }} />
                {c.pair}
              </span>
              <span role="cell" className="text-right tabular-nums text-fg-muted">
                {c.ratio.toFixed(2)} / {c.min}
              </span>
              <span role="cell" className={c.pass ? 'text-ok' : 'text-danger'}>
                {c.pass ? 'pass' : 'fail'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A colour: the native picker and the hex it holds. */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    // A visible label: base and accent were told apart only by position (review P2).
    <span className="flex items-center gap-1.5" data-color-field={label}>
      <span className="text-2xs text-fg-subtle" aria-hidden>
        {label}
      </span>
      <input type="color" aria-label={`${label} colour`} value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-8 cursor-default rounded-md border border-line-input bg-surface p-0.5" />
      <Input
        aria-label={`${label} hex`}
        value={text}
        maxLength={7}
        onChange={(e) => {
          setText(e.target.value)
          if (HEX.test(e.target.value)) onChange(e.target.value.toLowerCase())
        }}
        className="w-[84px] font-mono text-xs"
      />
    </span>
  )
}

/** Ligatures and Nerd Font glyphs in the chosen font, checked by drawing them (font-check.ts). */
function FontPreview({ form }: { form: FontSettings }): React.JSX.Element {
  const family = [form.termFontFamily.trim(), BUNDLED_FONT].filter(Boolean).join(', ')
  const [res, setRes] = useState<{ lig: string[]; nerd: string[] } | null>(null)
  useEffect(() => {
    let live = true
    setRes(null)
    const sample = `${LIGATURE_SEQUENCES.join(' ')} ${NERD_GLYPHS.join(' ')}`
    // A family that is installed but not used yet loads on first use: wait for it, then draw.
    void document.fonts
      .load(`22px ${family}`, sample)
      .catch(() => [])
      .then(() => {
        if (!live) return
        const r = canvasRenderer()
        setRes({ lig: ligaturesIn(r, family), nerd: nerdGlyphsIn(r, family) })
      })
    return () => {
      live = false
    }
  }, [family])
  const word = (ok: boolean | undefined) => (ok === undefined ? <span className="text-fg-subtle">checking…</span> : ok ? <span className="text-ok">yes</span> : <span className="text-fg-muted">no</span>)
  return (
    <div className="space-y-1.5" data-font-preview>
      <div className="whitespace-pre rounded-md border border-line bg-term px-3 py-2 text-fg" style={{ fontFamily: `${family}, monospace`, fontSize: form.termFontSize, lineHeight: form.termLineHeight }}>
        <div>{LIGATURE_SEQUENCES.join('  ')}</div>
        {/* A glyph the font cannot draw is a muted dash, never a tofu box that reads as broken (review P2). */}
        <div data-nerd-row>
          {NERD_GLYPHS.map((g) => {
            const has = !!res?.nerd.includes(g)
            return (
              <span key={g} data-glyph={has ? 'ok' : 'missing'} className={has ? undefined : 'text-fg-subtle'}>
                {has ? g : '—'}
                {'  '}
              </span>
            )
          })}
          0O 1lI {'{}[]()'}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 text-xs text-fg-muted">
        <span data-check="ligatures">Ligatures: {word(res ? res.lig.length > 0 : undefined)}</span>
        <span data-check="nerd">Nerd Font glyphs: {word(res ? res.nerd.length === NERD_GLYPHS.length : undefined)}</span>
      </div>
      {res && res.lig.length > 0 && <p className="text-2xs text-fg-subtle">Ligatures show here, but the terminal draws them as separate characters (it has no ligature support), so command output stays exact.</p>}
      {res && res.nerd.length > 0 && res.nerd.length < NERD_GLYPHS.length && <p className="text-2xs text-fg-subtle">Some Nerd Font glyphs are missing: a patched font has all of them.</p>}
    </div>
  )
}

/**
 * Settings → Themes and fonts: the palette browser, theme generator, imports, exports and font preview. Part of the Settings form: "Use" sets termTheme, Save keeps it.
 *
 * Decision: custom themes colour the terminal. The UI tokens the generator derives are stored and
 * exported with the theme (and shown as swatches) but do not repaint the app chrome yet: the chrome
 * stays on the audited Hopline tokens, whose safety colours and contrast are tested.
 */
export function ThemesPanel({ form, up }: { form: Settings; up: Up }): React.JSX.Element {
  const themes = useThemes((s) => s.list)
  const [base, setBase] = useState('#16202b')
  const [accent, setAccent] = useState('#5ec9b6')
  const [mode, setMode] = useState<'dark' | 'light'>('dark')
  const [name, setName] = useState('My theme')
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState<ThemeDraft | null>(null)

  const gen = useMemo(() => generateTheme({ base, accent, mode }), [base, accent, mode])
  const checks = useMemo(() => checkContrast(gen), [gen])
  const draftChecks = useMemo(() => (draft ? checkContrast(draft.theme) : []), [draft])
  const ids = themes.map((t) => t.id)

  const save = async () => {
    const label = name.trim() || 'My theme'
    const theme: CustomTheme = { id: themeIdFor(label, ids), label, mode, source: { base, accent }, term: gen.term, ui: gen.ui }
    try {
      await useThemes.getState().save(theme)
      setSaved(theme.id)
    } catch (e) {
      notifyError('Could not save the theme', e)
    }
  }
  const importFile = async () => {
    try {
      const d = await window.hopline.ux.themes.import()
      if (d) setDraft(d)
    } catch (e) {
      notifyError('Could not import the theme', e)
    }
  }
  const keep = async () => {
    if (!draft) return
    try {
      const t = { ...draft.theme, id: themeIdFor(draft.theme.label, ids) }
      await useThemes.getState().save(t)
      setDraft(null)
    } catch (e) {
      notifyError('Could not keep the theme', e)
    }
  }
  const exportTheme = async (t: CustomTheme) => {
    try {
      if (await window.hopline.ux.themes.export(t)) toast.success(`Exported ${t.label}`)
    } catch (e) {
      notifyError('Could not export the theme', e)
    }
  }
  const remove = async (t: CustomTheme) => {
    if (!(await askConfirm(`Delete ${t.label}?`, form.termTheme === t.id ? 'The terminal uses it now and goes back to the Hopline theme.' : 'Export it first to keep a copy.', 'Delete'))) return
    // A deleted theme falls back to the Hopline theme (terminalTheme), even if this form is cancelled.
    if (form.termTheme === t.id) up('termTheme', 'auto')
    try {
      await useThemes.getState().remove(t.id)
    } catch (e) {
      notifyError('Could not delete the theme', e)
    }
  }
  const savedTheme = themes.find((t) => t.id === saved)

  return (
    <>
      <Section id="themes" title="Terminal palettes">
        <PaletteBrowser form={form} custom={themes} onSelect={(id) => up('termTheme', id)} />
      </Section>
      <Section title="Your themes">
        <Row k="themeImport" label="Import and export" hint="Preview a Hopline, iTerm2, MobaXterm (.ini) or Royal TS (.rtcp or .termcolors) palette.">
          <div>
            <Button onClick={() => void importFile()}>Import…</Button>
          </div>
        </Row>
        {draft && (
          <Row label={`Import: ${draft.theme.label}`}>
            <div className="space-y-1.5" data-import-draft>
              <ThemePreview term={draft.theme.term} font={form} label={draft.theme.label} />
              {draft.notes.map((n) => (
                <p key={n} className="text-2xs text-fg-subtle">
                  {n}
                </p>
              ))}
              <ContrastReport checks={draftChecks} />
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void keep()}>
                  Keep
                </Button>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              </div>
            </div>
          </Row>
        )}
        {themes.length === 0 ? (
          <p className="py-1 text-xs text-fg-subtle">No saved themes yet.</p>
        ) : (
          <div className="divide-y divide-line" role="list" aria-label="Your themes">
            {themes.map((t) => (
              <div key={t.id} role="listitem" data-custom-theme={t.id} className="flex h-8 items-center gap-2">
                <span className="flex h-3 w-10 shrink-0 overflow-hidden rounded-[3px] border border-line-strong">
                  {[t.term.background, t.term.red, t.term.green, t.term.blue, t.term.foreground].map((c, i) => (
                    <span key={i} className="flex-1" style={{ background: c }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.label}</span>
                <span className="text-2xs text-fg-subtle">{t.mode}</span>
                {form.termTheme === t.id && <Badge tone="accent">in use</Badge>}
                <Button size="sm" variant="ghost" disabled={form.termTheme === t.id} onClick={() => up('termTheme', t.id)} aria-label={`Use ${t.label} for the terminal`}>
                  Use
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void exportTheme(t)} aria-label={`Export ${t.label}`}>
                  Export…
                </Button>
                <Button size="sm" variant="ghost" className={cn('hover:text-danger')} onClick={() => void remove(t)} aria-label={`Delete ${t.label}`}>
                  Delete
                </Button>
              </div>
            ))}
          </div>
        )}
        <details className="group/generator mt-1">
          <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm text-fg hover:text-accent">
            <ChevronRight aria-hidden className="size-3.5 transition-transform duration-[var(--dur-fast)] group-open/generator:rotate-90 motion-reduce:transition-none" />
            Create a theme
          </summary>
          <Row k="themeGenerator" label="Base and accent" hint="Lightness is tuned until every colour passes WCAG AA.">
            <div className="flex flex-wrap items-center gap-3">
              <ColorField label="Base" value={base} onChange={setBase} />
              <ColorField label="Accent" value={accent} onChange={setAccent} />
              <Segmented
                label="Theme mode"
                value={mode}
                onChange={setMode}
                items={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' }
                ]}
              />
            </div>
          </Row>
          <Row label="Preview">
            <div className="space-y-1.5">
              <ThemePreview term={gen.term} font={form} label={name} />
              <Swatches ui={gen.ui} />
            </div>
          </Row>
          <Row label="Contrast">
            <ContrastReport checks={checks} />
          </Row>
          <Row label="Name">
            <div className="flex items-center gap-2">
              <Input aria-label="Theme name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="w-48" />
              <Button onClick={() => void save()}>Save theme</Button>
              {savedTheme && (
                <>
                  <span className="whitespace-nowrap text-2xs text-fg-subtle">Saved</span>
                  <Button size="sm" variant="ghost" disabled={form.termTheme === savedTheme.id} onClick={() => up('termTheme', savedTheme.id)}>
                    {form.termTheme === savedTheme.id ? 'Used for the terminal' : 'Use for the terminal'}
                  </Button>
                </>
              )}
            </div>
          </Row>
        </details>
      </Section>
      <Section title="Fonts">
        <Row k="fontPreview" label="Font preview" hint="Choose the font in Terminal. This preview checks its glyphs.">
          <FontPreview form={form} />
        </Row>
      </Section>
    </>
  )
}
