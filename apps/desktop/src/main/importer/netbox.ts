import { fetchNetBox, type FetchLike, type ImportResult } from '@hopline/importers'
import type { NetBoxFetchRequest, NetBoxSource } from '@shared/types'
import type { Repo, SecretCipher } from '../db/repo'

/** Settings keys. The source config lives outside `prefs` (which is exported); the token is AES-GCM under the data key. */
const CONFIG = 'import_netbox'
const TOKEN = 'import_netbox_token_dek'
const TOKEN_AAD = 'setting:netbox_token'
/** The one plain-http (non-loopback) server the user agreed to send the token to (P8 D-L3). */
const HTTP_ACK = 'import_netbox_http_ack'
/** Whole fetch (every page): long enough for big estates, short enough that a hung server is reported. */
const FETCH_TIMEOUT_MS = 120_000

type Stored = Omit<NetBoxSource, 'hasToken'>

/** A fetched source, saved only once its import is applied (a cancelled preview changes nothing). */
export interface PendingNetBox {
  url: string
  flavor: 'netbox' | 'nautobot'
  filter: string
  /** A newly typed token (it worked). Undefined: the saved one was used. Main memory only. */
  token?: string
}

/** Normalized base URL: http(s) only, no trailing slash or /api. Throws a readable error. */
export function normalizeUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error(`Not a valid URL: ${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The NetBox URL must start with http:// or https://')
  if (u.username || u.password) throw new Error('Put the API token in the token field, not in the URL')
  return (u.origin + u.pathname).replace(/\/+$/, '').replace(/\/api$/i, '')
}

/** Import links are per server: the same device id on another NetBox is another device. */
export const linkSourceOf = (url: string): string => `netbox:${normalizeUrl(url)}`

/**
 * The saved NetBox/Nautobot source and its API token. The token is only ever decrypted here, sent
 * only to the source's own origin (fetchNetBox enforces that), and never returned over IPC.
 */
export class NetBoxStore {
  constructor(
    private readonly repo: Repo,
    private readonly cipher: SecretCipher,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
  ) {}

  private stored(): Stored | null {
    const raw = this.repo.getSetting(CONFIG)
    if (!raw) return null
    try {
      return JSON.parse(raw) as Stored
    } catch {
      return null
    }
  }

  source(): NetBoxSource | null {
    const s = this.stored()
    return s ? { ...s, hasToken: !!this.repo.getSetting(TOKEN) } : null
  }

  private save(s: Stored): void {
    this.repo.setSetting(CONFIG, JSON.stringify(s))
  }

  async token(): Promise<string | undefined> {
    const enc = this.repo.getSetting(TOKEN)
    return enc ? (await this.cipher.decrypt(Buffer.from(enc, 'base64'), TOKEN_AAD)).toString('utf8') : undefined
  }

  /** Encrypt a token for `commit` (before the import's transaction, which can't await). */
  async seal(token: string): Promise<string> {
    return (await this.cipher.encrypt(Buffer.from(token, 'utf8'), TOKEN_AAD)).toString('base64')
  }

  /**
   * Fetch every device. A token typed in is used (and saved by `commit` once the import is
   * applied); without one the saved token is used, only for the same server. Nothing is saved here.
   */
  async fetch(req: NetBoxFetchRequest): Promise<{ url: string; result: ImportResult; pending: PendingNetBox }> {
    const url = normalizeUrl(req.url)
    const prev = this.stored()
    let token = req.token?.trim()
    if (!token) {
      if (!prev || normalizeUrl(prev.url) !== url) throw new Error('Enter an API token for this server')
      token = await this.token()
      if (!token) throw new Error('No API token is saved: enter one')
    }
    const result = await fetchNetBox(
      { url, token, filter: req.filter.trim() || undefined, flavor: req.flavor, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      this.fetchImpl
    )
    return { url, result, pending: { url, flavor: req.flavor, filter: req.filter.trim(), ...(req.token?.trim() ? { token } : {}) } }
  }

  /** Where a re-sync of this server goes by default (the last apply's choice), or null for another server. */
  placement(url: string): { targetFolderId: string | null; keepFolders: boolean } | null {
    const s = this.stored()
    return s && normalizeUrl(s.url) === url ? { targetFolderId: s.targetFolderId, keepFolders: s.keepFolders } : null
  }

  /** After an apply: save the source, where it went and (sealed) a newly typed token, for the next re-sync. */
  commit(p: PendingNetBox, sealedToken: string | undefined, opts: { targetFolderId: string | null; keepFolders: boolean }, at = Date.now()): void {
    const prev = this.stored()
    // Another server: links to the old one's devices no longer mean anything.
    if (prev && normalizeUrl(prev.url) !== p.url) this.repo.clearImportLinks(linkSourceOf(prev.url))
    if (sealedToken) this.repo.setSetting(TOKEN, sealedToken)
    this.save({ url: p.url, flavor: p.flavor, filter: p.filter, ...opts, lastSyncAt: at })
  }

  /** The user agreed to send the token to this plain-http server (normalized URL). */
  httpAcked(url: string): boolean {
    return this.repo.getSetting(HTTP_ACK) === url
  }
  ackHttp(url: string): void {
    this.repo.setSetting(HTTP_ACK, url)
  }

  forget(): void {
    this.repo.setSetting(HTTP_ACK, null)
    const s = this.stored()
    if (s) this.repo.clearImportLinks(linkSourceOf(s.url))
    this.repo.setSetting(CONFIG, null)
    this.repo.setSetting(TOKEN, null)
  }

  /** Session-only vault start: a token saved last run is under a key that no longer exists. */
  dropEphemeralToken(): void {
    this.repo.setSetting(TOKEN, null)
  }
}
