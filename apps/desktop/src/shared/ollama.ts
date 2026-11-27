/**
 * Ollama endpoint rules shared by main (enforcement) and the renderer (labels and warnings).
 * Pure functions, no Node APIs.
 */

/** The URL, if it is http(s) without credentials; null otherwise. */
export function parseEndpoint(endpoint: string): URL | null {
  try {
    const u = new URL(endpoint.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u
  } catch {
    return null
  }
}

/**
 * The URL, if it is an http(s) origin without credentials; null otherwise. Origin only (review L2):
 * no path other than "/", no query, no fragment, so `http://h/admin/delete?x=` cannot turn the
 * model-list and connect checks into requests for other paths on an internal host. Used for the
 * user's Ollama server everywhere a request is made (the team policy's allow-list keeps its own
 * parsing and compares origins).
 */
export function parseOrigin(endpoint: string): URL | null {
  const e = endpoint.trim()
  const u = parseEndpoint(e)
  if (!u) return null
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || /[?#]/.test(e)) return null
  return u
}

/** Loopback only (localhost, 127.0.0.0/8, ::1): device output stays on this machine. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const u = parseEndpoint(endpoint)
  if (!u) return false
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h)
}

/**
 * A remote server over plain http: device output would cross the network unencrypted. Using it
 * needs an explicit acknowledgement bound to this exact endpoint string.
 */
export function isInsecureEndpoint(endpoint: string): boolean {
  const u = parseEndpoint(endpoint)
  return !!u && u.protocol === 'http:' && !isLoopbackEndpoint(endpoint)
}

/** An API path on the endpoint's origin, joined with the URL parser (never by string concatenation). */
export function endpointUrl(endpoint: string, path: string): string | null {
  const u = parseOrigin(endpoint)
  return u ? new URL(path, u.origin).toString() : null
}

/** The acknowledgement counts only for the endpoint it was given for. */
export const insecureAcked = (endpoint: string, ack: string | undefined | null): boolean => !!ack && ack.trim() === endpoint.trim()

/** "Ollama · gpu-box:11434": the server the model runs on, never just "local". */
export function ollamaHostLabel(endpoint: string): string {
  const u = parseEndpoint(endpoint)
  return u ? `Ollama · ${u.host}` : 'Ollama'
}

export const INSECURE_ENDPOINT_WARNING = 'Traffic to this server is not encrypted; device output will be sent there.'

/**
 * What the user typed, as an endpoint: trimmed, and `http://` added when no scheme was given
 * (`localhost:11434`, `gpu-box:11434`), which `new URL` would otherwise read as a scheme.
 */
export function normalizeEndpoint(endpoint: string): string {
  const e = endpoint.trim()
  if (!e || /^[a-z][a-z0-9+.-]*:\/\//i.test(e)) return e
  return `http://${e}`
}
