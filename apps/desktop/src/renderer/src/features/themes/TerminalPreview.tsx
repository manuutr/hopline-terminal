import { hexToOklch, searchL } from '@shared/oklch'
import { contrast } from '@shared/theme-file'
import type { Settings } from '@shared/types'
import type { TermColors } from '@shared/ux'
import { terminalTheme, TERM_MIN_CONTRAST } from '../terminal/theme'

export function TermPreview({ s, colors }: { s: Pick<Settings, 'termTheme' | 'termFontFamily' | 'termFontSize' | 'termLineHeight' | 'termCursorStyle'>; colors?: TermColors }): React.JSX.Element {
  const t = colors ?? terminalTheme(s.termTheme)
  const font = [s.termFontFamily.trim(), '"JetBrains Mono Variable"', 'monospace'].filter(Boolean).join(', ')
  // xterm enforces minimum text contrast. Keep preview text readable and the colour strip literal.
  const ink = (color: string) => {
    if (contrast(color, t.background) >= TERM_MIN_CONTRAST) return color
    const { L, C, h } = hexToOklch(color)
    const lighter = contrast('#ffffff', t.background) > contrast('#000000', t.background)
    return searchL(L, C, h, [t.background], TERM_MIN_CONTRAST, lighter ? 1 : -1)
  }
  const token = (text: string, color = t.foreground) => <span style={{ color: ink(color) }}>{text}</span>
  return (
    <div data-term-preview tabIndex={0} className="w-full overflow-x-auto overflow-y-hidden whitespace-pre rounded-md border border-line px-3 py-2" style={{ background: t.background, fontFamily: font, fontSize: s.termFontSize, lineHeight: s.termLineHeight }}>
      <div>{token('core-sw1# show interfaces description')}</div>
      <div>{token('Interface  Status  Protocol  Description')}</div>
      <div>{token('Gi1/0/1', t.blue)}    {token('up', t.green)}      {token('up', t.green)}        {token('Branch uplink')}</div>
      <div>{token('Gi1/0/2', t.blue)}    {token('down', t.red)}    {token('down', t.red)}      {token('Spare')}</div>
      <div className="whitespace-pre-wrap">{token('%LINK-3-UPDOWN: Interface Gi1/0/2, changed state to down', t.yellow)}</div>
      <div>{token('core-sw1#')}{token(s.termCursorStyle === 'block' ? '█' : s.termCursorStyle === 'underline' ? '_' : '▏', t.cursor)}</div>
    </div>
  )
}

/** The Settings preview in a theme's own colours, with its 16 ANSI colours underneath. */
export function ThemePreview({ term, font, label }: { term: TermColors; font: Settings; label?: string }): React.JSX.Element {
  return (
    <div data-theme-preview role="group" aria-label={label ? `Preview of ${label}` : 'Theme preview'} className="space-y-px">
      <TermPreview s={font} colors={term} />
      <div className="flex gap-px">
        {ANSI.map((k) => (
          <span key={k} title={`${k} ${term[k]}`} className="h-2 flex-1 first:rounded-bl-[3px] last:rounded-br-[3px]" style={{ background: term[k] }} />
        ))}
      </div>
    </div>
  )
}

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
