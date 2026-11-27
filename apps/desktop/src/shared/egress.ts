/**
 * "What left this machine" (Trust UX): one row per model request, as it was sent. Metadata is
 * listed; the payload (the redacted request body, never headers or the API key) is decrypted in
 * main only when a row is opened, searched or exported.
 */

/** `unknown`: the app stopped while the request was being sent (a crash or a quit): it may have left. */
export type EgressStatus = 'sending' | 'ok' | 'error' | 'cancelled' | 'unknown'

export interface EgressRow {
  id: number
  ts: number
  provider: 'anthropic' | 'ollama' | string
  model: string
  /** Where it went: "api.anthropic.com" or the Ollama host:port. */
  destination: string
  /** `agent` (chat), `fleet`, `suggest`; `check`: a connect check (Test connection, Connect; health checks are not logged). */
  source: string
  sessionName: string | null
  runId: string | null
  lane: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** Size of the request body as sent, in bytes. */
  bytes: number
  status: EgressStatus
  /** False when the payload could not be stored (vault locked) or was dropped. */
  hasPayload: boolean
  durationMs: number | null
  /** Times the request went on the wire (the Anthropic SDK retries a failed connection or a 429/5xx). Null: not counted (older rows). */
  attempts: number | null
}

export interface EgressDetail extends EgressRow {
  /** The request body as sent, pretty-printed JSON. */
  payload: string | null
}

export interface EgressQuery {
  /** Substring search over the payload and metadata (case-insensitive). */
  search?: string
  limit?: number
}

/** A search's rows; `payloadsSearched` false: the vault is locked, only the metadata was searched. */
export interface EgressSearch {
  rows: EgressRow[]
  payloadsSearched: boolean
}

export interface EgressStats {
  rows: number
  bytes: number
  maxBytes: number
  maxRows: number
}
