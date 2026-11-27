export type Theme = 'dark' | 'light' | 'contrast'
/** What the user picked: a theme, or 'system' to follow the OS. */
export type ThemePref = Theme | 'system'

const KEY = 'hopline.theme'

const media = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null)
const resolve = (p: ThemePref): Theme => (p === 'system' ? (media()?.matches ? 'light' : 'dark') : p)

/** The user's choice (dark, light or system). */
export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'system' || v === 'contrast' ? v : 'dark'
}

/** The theme on screen now ('system' resolved). */
export function getTheme(): Theme {
  return resolve(getThemePref())
}

let following: (() => void) | null = null

export const reducedMotion = (): boolean =>
  (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduce-motion')) ||
  (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

/** CSS minification may serialize 200ms as .2s. Web Animations expects milliseconds. */
export function layoutMotionOptions(element: HTMLElement, easing: '--ease-spring' | '--ease-out'): KeyframeAnimationOptions {
  const css = getComputedStyle(element)
  const duration = css.getPropertyValue('--dur-base').trim()
  const ms = parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000)
  return { id: 'hopline-layout', duration: ms, easing: css.getPropertyValue(easing).trim() }
}

/** CSS follows the media query live. Finish any in-flight Web Animations layout effect as well. */
function finishLayoutMotion(): void {
  for (const animation of document.getAnimations?.() ?? []) {
    if (animation.id === 'hopline-layout') animation.finish()
  }
}

if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    if (e.matches) finishLayoutMotion()
  })
}

export function applyMotion(reduce: boolean): void {
  document.documentElement.toggleAttribute('data-reduce-motion', reduce)
  localStorage.setItem('hopline.reduceMotion', String(reduce))
  if (reduce) finishLayoutMotion()
}

export function applyTheme(pref: ThemePref, animate = true): void {
  localStorage.setItem(KEY, pref)
  const theme = resolve(pref)
  const root = document.documentElement
  const paint = () => {
    root.classList.toggle('dark', theme !== 'light')
    root.classList.toggle('contrast', theme === 'contrast')
    root.dataset.theme = theme
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark'
    window.dispatchEvent(new CustomEvent('hopline:theme', { detail: theme }))
  }
  if (animate && root.dataset.theme && root.dataset.theme !== theme && !reducedMotion() && document.startViewTransition) {
    document.startViewTransition(paint)
  } else paint()
  // 'system': follow the OS when it switches (a scheduled dark mode at dusk).
  following?.()
  following = null
  const m = media()
  if (pref === 'system' && m) {
    const on = () => applyTheme('system')
    m.addEventListener('change', on)
    following = () => m.removeEventListener('change', on)
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}

/** Read a CSS custom property (used to theme xterm from the same tokens). */
export function cssVar(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  // The CSS minifier shortens hex colors. Terminal palettes use six-digit RGB.
  return /^#[a-f0-9]{3}$/i.test(value) ? '#' + Array.from(value.slice(1), (digit) => digit + digit).join('') : value
}
