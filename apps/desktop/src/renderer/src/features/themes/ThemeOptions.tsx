import type { CustomTheme } from '@shared/ux'
import { isLightBg, TERM_THEMES } from '../terminal/theme'

const fixed = TERM_THEMES.filter((t) => t.colors)
const light = fixed.filter((t) => isLightBg(t.colors?.background))
const dark = fixed.filter((t) => !isLightBg(t.colors?.background))
const option = (t: { id: string; label: string }) => <option key={t.id} value={t.id}>{t.label}</option>

/** Shared by Terminal settings and per-host overrides. Keep the native select's type-ahead. */
export function ThemeOptions({ custom }: { custom: readonly CustomTheme[] }): React.JSX.Element {
  return <>
    {TERM_THEMES.filter((t) => !t.colors).map(option)}
    <optgroup label="Dark palettes">{dark.map(option)}</optgroup>
    <optgroup label="Light palettes">{light.map(option)}</optgroup>
    {custom.length > 0 && <optgroup label="Your palettes">{custom.map(option)}</optgroup>}
  </>
}
