/**
 * Guard reasons and device errors come from packages and main in lower case ("configuration
 * change", "port 8080 is already in use"), written to be embedded mid-sentence. Shown on their own
 * (a hint, a toast description, a row error) they start with a capital (round 2). Code-looking
 * starts are left alone: a quoted command, a path, a flag.
 */
export function sentence(s: string | undefined | null): string {
  if (!s) return ''
  const t = s.trim()
  if (!/^[a-z]/.test(t)) return t
  // "ip scp server enable" style commands quoted without quotes are rare at the start; keep words like "iOS" too.
  if (/^[a-z]+[A-Z]/.test(t)) return t
  return t[0]!.toUpperCase() + t.slice(1)
}
