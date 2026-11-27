import type { SessionColor } from '@shared/types'

/**
 * Session accent and tag chip colors. Literal class names so Tailwind sees them. The accent stays
 * a thin marker (tab stripe, tree glyph): status colors keep their meaning, and the one brand
 * accent stays for focus and selection.
 */
export const COLOR_CLASS: Record<SessionColor, { bar: string; text: string; chip: string; label: string }> = {
  red: { bar: 'bg-red-500', text: 'text-red-500 dark:text-red-400', chip: 'bg-red-500/12 text-red-700 dark:text-red-300', label: 'Red' },
  orange: { bar: 'bg-orange-500', text: 'text-orange-500 dark:text-orange-400', chip: 'bg-orange-500/12 text-orange-700 dark:text-orange-300', label: 'Orange' },
  yellow: { bar: 'bg-yellow-500', text: 'text-yellow-600 dark:text-yellow-400', chip: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300', label: 'Yellow' },
  green: { bar: 'bg-green-500', text: 'text-green-600 dark:text-green-400', chip: 'bg-green-500/12 text-green-700 dark:text-green-300', label: 'Green' },
  teal: { bar: 'bg-teal-500', text: 'text-teal-600 dark:text-teal-400', chip: 'bg-teal-500/12 text-teal-700 dark:text-teal-300', label: 'Teal' },
  blue: { bar: 'bg-blue-500', text: 'text-blue-500 dark:text-blue-400', chip: 'bg-blue-500/12 text-blue-700 dark:text-blue-300', label: 'Blue' },
  purple: { bar: 'bg-violet-500', text: 'text-violet-500 dark:text-violet-400', chip: 'bg-violet-500/12 text-violet-700 dark:text-violet-300', label: 'Purple' },
  pink: { bar: 'bg-pink-500', text: 'text-pink-500 dark:text-pink-400', chip: 'bg-pink-500/12 text-pink-700 dark:text-pink-300', label: 'Pink' }
}
