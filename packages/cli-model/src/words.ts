/** Word matching with the device's prefix rule (no dependencies: command trees import it). */

export type WordMatch = { word: string } | { ambiguous: string[] } | null

/**
 * Resolve a typed word against a vocabulary like the device does: an exact word wins, else the
 * single word it abbreviates; several candidates are ambiguous; none is null. Case-insensitive.
 */
export function matchWord(vocab: readonly string[], typed: string): WordMatch {
  const t = typed.toLowerCase()
  if (!t) return null
  if (vocab.includes(t)) return { word: t }
  const hits = vocab.filter((w) => w.startsWith(t))
  if (hits.length === 1) return { word: hits[0]! }
  return hits.length ? { ambiguous: hits } : null
}

/** True when the typed word is `word` or an abbreviation of it of at least `min` characters. */
export function abbreviates(word: string, typed: string, min = 1): boolean {
  const t = typed.toLowerCase()
  return t.length >= min && word.startsWith(t)
}
