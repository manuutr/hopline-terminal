/** OSC 7 carries a working directory. Only accept an absolute path on this connection. */
export function remoteDirectory(uri: string, host: string): string | null {
  if (uri.length > 4096 || /[\\?#\s]/.test(uri)) return null
  const report = /^file:\/\/([^/]*)(\/.*)$/i.exec(uri)
  if (!report) return null
  try {
    const bare = (s: string) => s.toLowerCase().replace(/^\[|\]$/g, '')
    if (report[1] && bare(report[1]) !== bare(host)) return null
    const path = decodeURIComponent(new URL(uri).pathname)
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(path)) return null
    return path
  } catch { return null }
}
