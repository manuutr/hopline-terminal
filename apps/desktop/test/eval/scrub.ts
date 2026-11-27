/**
 * The eval report with the API key (and anything key-shaped) removed, whatever an error message
 * carried. Every non-empty key is scrubbed, however short (review L6: keys under 8 characters were
 * kept). It works on string values, not on the serialised JSON, so a short key cannot break the
 * report's structure by matching a field name or a quote.
 */
export function scrubKeys<T>(value: T, keys: (string | undefined | null)[]): T {
  const ks = [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))].sort((a, b) => b.length - a.length)
  const clean = (s: string): string => {
    let out = s
    for (const k of ks) out = out.split(k).join('[REDACTED]')
    return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return clean(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), walk(x)]))
    return v
  }
  return walk(value) as T
}
