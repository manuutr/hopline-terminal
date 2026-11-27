import { releaseInventory } from '../db/legacy-lab'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import { writePrivateFile } from '../private-file'
import type { KeyImportInfo, NetBoxSource, SessionImportOutcome, SessionImportPlan } from '@shared/types'
import type { FetchLike } from '@hopline/importers'
import type { AuditLog } from '../db/audit'
import type { Repo } from '../db/repo'
import type { SettingsService } from '../settings'
import type { ScrollbackStore } from '../store/scrollback'
import { importOpenSshKnownHosts } from '../knownhosts-import'
import { openFile, readHeader, sealFile } from '../backup/format'
import type { FolderSync } from '../backup/sync'
import { applyPayload, buildPayload, counts, parsePayload, preview, type Payload } from '../backup/transfer'
import { linkSourceOf, NetBoxStore, normalizeUrl } from '../importer/netbox'
import { isInsecureEndpoint } from '@shared/ollama'
import { applyImport, buildPlan, csvInfo, csvMapping, planView, type StagedImport } from '../importer/plan'
import { readSource, remapCsv, type FileSource } from '../importer/read'
import { isLocked } from '../vault/datakey'
import type { ScryptParams } from '../vault/kdf'
import { inspectKey, MAX_KEY_BYTES } from '../vault/keys'
import { isPpk, ppkInfo, ppkToOpenSsh } from '@hopline/transports/src/ppk.ts'
import type { UnlockBroker } from '../vault/unlock'
import type { Vault } from '../vault/vault'
import * as S from './schemas'
import { trustedSender } from './sender'

export { setTrustedPage, trustedSender } from './sender'

/**
 * Native pickers and confirmations. Paths only ever come from these (main's own dialogs), never
 * from a renderer argument. Tests and e2e replace them.
 */
export interface Pickers {
  openKeyFile(): Promise<string | null>
  saveExport(defaultName: string): Promise<string | null>
  openExport(): Promise<string | null>
  pickDir(): Promise<string | null>
  /** A main-side confirmation the renderer can't answer for the user (exporting secrets). */
  confirm(message: string, detail: string, ok: string): Promise<boolean>
  /** Session import: a file (with filters) or a folder (SecureCRT's Sessions). */
  openImport(opts: { title: string; dir: boolean; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null>
  /** Where "~/.ssh/config" is on this machine. */
  sshConfigPath(): string
}

export interface Services {
  repo: Repo
  settings: SettingsService
  audit: AuditLog
  scrollback: ScrollbackStore
  vault: Vault
  unlock: UnlockBroker
  sync: FolderSync
  pickers: Pickers
  /** KDF for export files (tests use cheap params). */
  kdf?: ScryptParams
  /** The saved NetBox source and its token (built from the vault when omitted). */
  netbox?: NetBoxStore
  /** HTTP for NetBox when `netbox` is omitted (tests mock it). */
  fetch?: FetchLike
  /**
   * e2e in dev builds only: skip the native dialogs that confirm weakening the vault (session-only,
   * auto-lock off, keychain reset). The master-password check itself still runs.
   */
  skipVaultConfirm?: boolean
  developmentLab?: boolean
}

/** Picker settings per import source. */
const IMPORT_PICK: Record<FileSource, { title: string; filters: { name: string; extensions: string[] }[] }> = {
  securecrt: { title: 'Choose a SecureCRT XML export', filters: [{ name: 'SecureCRT export', extensions: ['xml'] }, { name: 'All files', extensions: ['*'] }] },
  mobaxterm: { title: 'Choose a MobaXterm sessions file', filters: [{ name: 'MobaXterm sessions', extensions: ['mxtsessions', 'ini'] }, { name: 'All files', extensions: ['*'] }] },
  putty: { title: 'Choose a PuTTY registry export', filters: [{ name: 'Registry export', extensions: ['reg'] }, { name: 'All files', extensions: ['*'] }] },
  'ssh-config': { title: 'Choose an OpenSSH config file', filters: [] },
  csv: { title: 'Choose a CSV file', filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }, { name: 'All files', extensions: ['*'] }] }
}

export type Handler = { schema: { parse: (x: unknown) => unknown }; fn: (arg: never, e: IpcMainInvokeEvent) => unknown }

/** A handler entry for a channel map (validated by `schema`, then `fn`). */
export const handler = <T>(schema: { parse: (x: unknown) => T }, fn: (arg: T, e: IpcMainInvokeEvent) => unknown): Handler => ({ schema, fn: fn as Handler['fn'] })

/** Register every handler of a channel map. */
export function registerAll(map: Record<string, Handler>): void {
  for (const [channel, { schema, fn }] of Object.entries(map)) handle(channel, schema, fn as (a: unknown, e: IpcMainInvokeEvent) => unknown)
}

/** Register a handler whose first argument is validated by `schema`. */
export function handle<T>(channel: string, schema: { parse: (x: unknown) => T }, fn: (arg: T, e: IpcMainInvokeEvent) => unknown): void {
  ipcMain.handle(channel, (e, arg: unknown) => {
    if (!trustedSender(e)) throw new Error(`${channel}: refused, not from Hopline's own page`)
    return fn(schema.parse(arg), e)
  })
}

const none = { parse: (): undefined => undefined }
/** How long picked or decrypted things wait in main for the next step. Kept short: some hold secrets. */
const TTL = {
  /** A picked private key's text. */
  key: 2 * 60_000,
  /** A picked export file, and its decrypted payload once the passphrase is in. */
  import: 5 * 60_000,
  dir: 10 * 60_000,
  /** A session-import review (may hold a typed NetBox token); restarted by every re-plan. */
  review: 20 * 60_000
}

/** Short-lived values that stay in main behind an opaque token (picked key files, decrypted imports, folders). */
class Staging<T> {
  private m = new Map<string, { v: T; t: ReturnType<typeof setTimeout> }>()
  constructor(private readonly ttl: number) {}
  put(v: T): string {
    const token = randomUUID()
    this.m.set(token, { v, t: this.timer(token) })
    return token
  }
  private timer(token: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => this.m.delete(token), this.ttl)
    t.unref?.()
    return t
  }
  /** Still in use (a review being worked on): restart its expiry. */
  touch(token: string): void {
    const e = this.m.get(token)
    if (!e) return
    clearTimeout(e.t)
    e.t = this.timer(token)
  }
  get(token: string): T {
    const e = this.m.get(token)
    if (!e) throw new Error('That selection expired. Pick the file again.')
    return e.v
  }
  set(token: string, v: T): void {
    const e = this.m.get(token)
    if (e) e.v = v
  }
  take(token: string): T {
    const v = this.get(token)
    this.drop(token)
    return v
  }
  drop(token: string): void {
    const e = this.m.get(token)
    if (e) clearTimeout(e.t)
    this.m.delete(token)
  }
  /** Drop every entry `which` selects (all by default). */
  clear(which: (v: T) => boolean = () => true): void {
    for (const [token, e] of this.m) if (which(e.v)) this.drop(token)
  }
}

interface PendingImport {
  file: string
  createdAt: number
  buf: Buffer | null
  payload: Payload | null
  /** Set for a folder-sync file: marks it as seen once applied. */
  syncHash?: string
}

/** Every core IPC handler, by channel. Exported so tests can assert exactly what each one returns. */
export function coreHandlers(svc: Services): Record<string, Handler> {
  const { repo, settings, audit, scrollback, vault, unlock, sync, pickers } = svc
  const keys = new Staging<{ text: string; info: KeyImportInfo }>(TTL.key)
  const imports = new Staging<PendingImport>(TTL.import)
  const dirs = new Staging<string>(TTL.dir)
  const staged = new Staging<StagedImport>(TTL.review)
  // Locking drops what main holds in clear for a pending step: key text, decrypted import
  // payloads, typed NetBox tokens. The user picks or types them again after unlocking.
  vault.on('change', (info: { locked: boolean }) => {
    if (!info.locked) return
    keys.clear()
    imports.clear((p) => !!p.payload)
    staged.clear((st) => !!st.netbox?.token)
  })
  const netbox = svc.netbox ?? new NetBoxStore(repo, vault.key, svc.fetch)
  const stage = (st: StagedImport, opts = { targetFolderId: null as string | null, keepFolders: true }): SessionImportPlan => {
    const token = staged.put(st)
    return view(token, st, opts)
  }
  const view = (token: string, st: StagedImport, opts: { targetFolderId: string | null; keepFolders: boolean }): SessionImportPlan => ({
    ...planView(repo, st, buildPlan(repo, st, opts), token),
    ...(st.csvText !== undefined ? { csv: csvInfo(st) } : {})
  })
  /** The saved token is in the vault: ask the user to unlock it first (they may decline). */
  const vaultOpen = async () => {
    if (vault.info().locked) await unlock.request()
    if (vault.info().locked) throw new Error('Unlock the vault to use the saved NetBox token')
  }
  /**
   * P8 D-L3: the API token goes in an Authorization header, so a remote plain-http server sees it in
   * clear. Main asks once per server (a native dialog the renderer can't answer) and remembers it.
   */
  const httpAck = async (raw: string) => {
    const url = normalizeUrl(raw)
    if (!isInsecureEndpoint(url) || netbox.httpAcked(url)) return
    const ok = await pickers.confirm(
      'Send the NetBox API token over plain http?',
      `${url} is not https and not on this machine: the API token and the device list cross the network unencrypted, and anyone on the path can read them.`,
      'Send over http'
    )
    if (!ok) throw new Error('Not fetched: the server uses plain http. Use an https:// URL, or agree to send the token unencrypted.')
    netbox.ackHttp(url)
  }
  const fetchNetBox = async (req: { url: string; flavor: 'netbox' | 'nautobot'; filter: string; token?: string }, resync: boolean): Promise<SessionImportPlan> => {
    await httpAck(req.url)
    await vaultOpen()
    const prev = netbox.source()
    const { url, result, pending } = await netbox.fetch(req).catch((e: unknown) => {
      // A partial pull must never look like deletions: the importer refuses it; say so plainly.
      if (e instanceof Error && /incomplete/i.test(e.message)) throw new Error(`${e.message}. Nothing was changed: try again once NetBox returns every device.`)
      throw e
    })
    // Import links are per server, not per filter: devices outside another filter are not "gone".
    const otherScope = !!prev && linkSourceOf(prev.url) === linkSourceOf(url) && prev.filter.trim() !== req.filter.trim()
    const noGone = !otherScope ? undefined : 'The filter differs from the saved source, so sessions missing from this list are not offered for removal.'
    return stage({ source: 'netbox', label: url, result, linkSource: linkSourceOf(url), netbox: pending, resync, noGone }, netbox.placement(url) ?? { targetFolderId: null, keepFolders: true })
  }
  const h = <T>(schema: { parse: (x: unknown) => T }, fn: (arg: T, e: IpcMainInvokeEvent) => unknown): Handler => ({ schema, fn: fn as Handler['fn'] })

  /**
   * P8 C-L1: a stored password or key only goes to an address the user agreed to. The renderer picks
   * host, port and credential, so main asks (natively, where the renderer can't answer) before a
   * credential is bound to a destination no saved session uses it with yet. Exempt: credentials
   * with no secret to leak ("prompt", "agent"), and a credential created or given a new secret in
   * this run, for its first binding (the renderer typed or the user just picked that secret).
   * Declined: the session is saved without the credential.
   */
  const fresh = new Set<string>()
  const destOf = (s: { protocol: string; host: string; port: number }) => `${s.protocol}|${s.host.trim().toLowerCase()}|${s.port}`
  const credentialNeedsOk = (credentialId: string, dest: string): boolean => {
    const c = repo.getCredential(credentialId)
    if (!c || c.kind === 'prompt' || c.kind === 'agent') return false
    if (repo.listSessions().some((x) => x.credentialId === credentialId && destOf(x) === dest)) return false
    if (fresh.delete(credentialId)) return false
    return true
  }
  const okCredential = (credentialId: string, where: string, count = 1): Promise<boolean> => {
    const name = repo.getCredential(credentialId)?.name ?? 'this credential'
    return pickers.confirm(
      `Use the saved credential "${name}" with ${where}?`,
      `Its password or key will be sent to ${count === 1 ? 'that address' : `${count} addresses`} when ${count === 1 ? 'the session connects' : 'those sessions connect'}. Hopline asks because "${name}" has not been used there before. Cancel saves ${count === 1 ? 'the session' : 'them'} without it.`,
      'Use credential'
    )
  }
  const guardSession = async (s: S.SessionInputValue): Promise<S.SessionInputValue> => {
    const prev = s.id ? repo.getSession(s.id) : undefined
    let out = s
    if (s.credentialId && credentialNeedsOk(s.credentialId, destOf(s)) && !(await okCredential(s.credentialId, `${s.host}:${s.port}`))) out = { ...out, credentialId: null }
    const fwd = s.protocol === 'ssh' && !!s.options.ssh?.agentForward
    if (fwd && !(prev?.protocol === 'ssh' && prev.options.ssh?.agentForward)) {
      const ok = await pickers.confirm(
        `Forward your SSH agent to ${s.host}?`,
        'While the session is connected, that device can use every key loaded in your SSH agent to sign in to other hosts as you. Cancel saves the session without agent forwarding.',
        'Forward agent'
      )
      if (!ok) out = { ...out, options: { ...out.options, ssh: { ...out.options.ssh, agentForward: false } } }
    }
    return out
  }
  const guardBulk = async (ids: string[], patch: S.SessionPatchValue): Promise<S.SessionPatchValue> => {
    if (!patch.credentialId) return patch
    const moved = ids.map((id) => repo.getSession(id)).filter((x) => !!x && credentialNeedsOk(patch.credentialId!, destOf(x)))
    if (moved.length === 0 || (await okCredential(patch.credentialId, moved.length === 1 ? `${moved[0]!.host}:${moved[0]!.port}` : `${moved.length} sessions`, moved.length))) return patch
    const { credentialId: _c, ...rest } = patch
    return rest
  }

  const vaultConfirm = (message: string, detail: string, ok: string): Promise<boolean> => (svc.skipVaultConfirm ? Promise.resolve(true) : pickers.confirm(message, detail, ok))
  /** Scrollback is kept only when it can be decrypted after a restart. */
  const persistentStorage = () => vault.info().persistent && !vault.info().locked

  return {
    // Scrollback: honors the setting; silently off when secrets can't persist or the vault is locked.
    'scrollback:save': h(S.ScrollbackSave, async ({ sessionId, data }) => {
      if (!settings.get().termRestoreScrollback || !persistentStorage()) return
      // Unsaved quick-connect sessions leave no history on disk.
      if (!repo.getSession(sessionId)) return
      await scrollback.save(sessionId, data).catch((e) => {
        if (!isLocked(e)) throw e
      })
    }),
    'scrollback:load': h(S.Id, async (sessionId) => (settings.get().termRestoreScrollback ? scrollback.load(sessionId) : null)),
    'scrollback:clear': h(S.OptionalId, (sessionId) => scrollback.clear(sessionId)),
    'knownHosts:list': h(none, () => repo.listHostKeys()),
    'knownHosts:remove': h(S.HostPort, ({ host, port }) => repo.removeHostKeys(host, port)),
    'knownHosts:import': h(none, () => importOpenSshKnownHosts(repo)),
    'sessions:list': h(none, () => {
      if (svc.developmentLab) return { folders: repo.listFolders(), sessions: repo.listSessions() }
      const { folders, sessions } = releaseInventory(repo)
      return { folders, sessions }
    }),
    'sessions:save': h(S.SessionInput, async (s) => repo.saveSession(await guardSession(s))),
    'sessions:remove': h(S.Id, async (id) => {
      repo.removeSession(id)
      // A deleted session leaves no history behind.
      await scrollback.clear(id)
    }),
    'sessions:removeMany': h(S.RemoveMany, async (items) => {
      repo.removeMany(items)
      for (const id of items.sessionIds) await scrollback.clear(id).catch(() => {})
    }),
    'sessions:saveFolder': h(S.FolderInput, (f) => repo.saveFolder(f)),
    'sessions:removeFolder': h(S.Id, (id) => repo.removeFolder(id)),
    'sessions:move': h(S.Move, ({ sessionId, folderId }) => repo.moveSession(sessionId, folderId)),
    'sessions:moveMany': h(S.MoveMany, ({ items, folderId }) => repo.moveMany(items, folderId)),
    'sessions:bulkUpdate': h(S.BulkUpdate, async ({ ids, patch }) => repo.bulkUpdate(ids, await guardBulk(ids, patch))),

    // ---------------------------------------------------------------- credentials (metadata out, secrets in)
    'credentials:list': h(none, () => {
      const credentials = repo.listCredentials()
      if (svc.developmentLab) return credentials
      const { hiddenCredentials } = releaseInventory(repo)
      return credentials.filter((c) => !hiddenCredentials.has(c.id))
    }),
    'credentials:save': h(S.CredentialInput, async ({ keyToken, ...c }) => {
      if (keyToken) {
        if (c.kind !== 'key') throw new Error('A key file only fits a private-key profile')
        let { text } = keys.get(keyToken)
        let passphrase = c.passphrase
        // Encrypted PPK v3 keys use Argon2, which takes seconds in Electron's pure-JS fallback and would
        // stall the session host on every connect. With the passphrase in hand, store the key once as
        // OpenSSH: it is still encrypted at rest by the vault's data key.
        if (passphrase && isPpk(text) && ppkInfo(text).version === 3 && ppkInfo(text).encrypted) {
          try {
            text = ppkToOpenSsh(text, passphrase)
            passphrase = ''
          } catch (e) {
            // A key file Hopline refuses (e.g. Argon2 parameters over the cap) says why, not "wrong passphrase".
            if (e instanceof Error && e.name === 'PpkError') throw e
            throw new Error('Wrong passphrase for this key')
          }
        }
        // Re-inspect with the passphrase: a wrong one is reported now, not at connect time.
        const key = inspectKey(text, passphrase || undefined)
        const saved = await repo.saveCredential({ ...c, passphrase, secret: text, key })
        keys.drop(keyToken)
        fresh.add(saved.id)
        return saved
      }
      const saved = await repo.saveCredential(c)
      // A new credential, or one whose password the renderer just set: its first binding needs no confirmation.
      if (!c.id || (c.kind === 'password' && c.secret)) fresh.add(saved.id)
      return saved
    }),
    'credentials:replacePasswords': h(S.ReplacePasswords, ({ ids, password }) => repo.replacePasswords(ids, password)),
    'credentials:remove': h(S.Id, (id) => repo.removeCredential(id)),
    'credentials:importKey': h(none, async (): Promise<KeyImportInfo | null> => {
      const path = await pickers.openKeyFile()
      if (!path) return null
      if ((await stat(path)).size > MAX_KEY_BYTES) throw new Error('That file is too large to be a private key')
      const text = await readFile(path, 'utf8')
      const parsed = inspectKey(text)
      const info: KeyImportInfo = { token: '', file: basename(path), ...parsed }
      info.token = keys.put({ text, info })
      return { ...info }
    }),

    // ---------------------------------------------------------------- vault
    'vault:status': h(none, () => vault.info()),
    'vault:unlock': h(S.Password, (pw) => vault.unlock(pw)),
    'vault:lock': h(none, () => vault.lock()),
    // Weakening the vault is confirmed by main, after the master password (if any) is verified.
    'vault:setMode': h(S.VaultSetMode, (r) =>
      vault.setMode(r.mode, {
        password: r.password,
        current: r.current,
        confirm:
          r.mode === 'session' && vault.info().mode !== 'session'
            ? () =>
                vaultConfirm(
                  'Keep secrets for this session only?',
                  'Saved passwords, private keys, passphrases, the API key and the NetBox token stay in memory only and are gone for good when Hopline quits. Sessions and settings are kept.',
                  'Session only'
                )
            : undefined
      })
    ),
    'vault:changePassword': h(S.ChangePassword, ({ current, next }) => vault.changePassword(current, next)),
    'vault:setAutoLock': h(S.AutoLock, ({ minutes, current }) =>
      vault.setAutoLock(minutes, {
        current,
        confirm: () =>
          vaultConfirm(
            'Turn auto-lock off?',
            'The vault will stay unlocked until you lock it, quit, or the machine sleeps. Anyone at this computer can then connect with your saved passwords and keys.',
            'Turn auto-lock off'
          )
      })
    ),
    'vault:retryKeychain': h(none, () => vault.retryKeychain()),
    'vault:resetToMaster': h(S.Password, (password) =>
      vault.resetToMaster(password, () =>
        vaultConfirm(
          'Start over with a master password?',
          'Everything the OS keychain protected is lost: saved passwords, private keys and passphrases, the API key, the NetBox token, the sync passphrase and saved terminal history. Sessions, folders, settings and known hosts are kept.',
          'Start over'
        )
      )
    ),
    'vault:touch': h(none, () => vault.touch()),
    'vault:skipUnlock': h(none, () => unlock.skip()),

    // ---------------------------------------------------------------- export / import
    'data:export': h(S.ExportRequest, async ({ passphrase, includeSecrets }) => {
      if (
        includeSecrets &&
        !(await pickers.confirm(
          'Include passwords and private keys?',
          'Anyone with this file and its passphrase can read every stored password, private key and passphrase. Keep it somewhere safe.',
          'Include secrets'
        ))
      )
        return null
      const day = new Date().toISOString().slice(0, 10)
      const path = await pickers.saveExport(`hopline-${day}.hopline`)
      if (!path) return null
      const payload = await buildPayload(repo, includeSecrets)
      // 0o600 also when it replaces an existing file (a tmp file renamed over it).
      await writePrivateFile(path, await sealFile(payload, passphrase, svc.kdf))
      const c = counts(payload)
      audit.append({
        sessionId: null,
        sessionName: '(all sessions)',
        host: '',
        source: 'user',
        command: 'export sessions and settings',
        kind: 'export',
        decision: 'executed',
        reason: `${includeSecrets ? 'exported with passwords and private keys (encrypted with the export passphrase)' : 'exported without secrets'} to ${path}: ${JSON.stringify(c)}`,
        approver: includeSecrets ? userInfo().username : null,
        durationMs: null,
        bytes: null,
        redactions: null
      })
      return { file: path, counts: c }
    }),
    'data:pickImport': h(none, async () => {
      const path = await pickers.openExport()
      if (!path) return null
      const buf = await readFile(path)
      const { header } = readHeader(buf)
      const token = imports.put({ file: path, createdAt: header.createdAt, buf, payload: null })
      return { token, file: path, createdAt: header.createdAt }
    }),
    'data:previewImport': h(S.ImportPreviewRequest, async ({ token, passphrase }) => {
      const p = imports.get(token)
      if (!p.buf) throw new Error('Nothing to decrypt')
      const payload = parsePayload((await openFile(p.buf, passphrase)).payload)
      imports.set(token, { ...p, payload })
      return preview(repo, payload, { token, file: p.file, createdAt: p.createdAt })
    }),
    'data:applyImport': h(S.ImportApply, async ({ token, mode }) => {
      const p = imports.get(token)
      if (!p.payload) throw new Error('Enter the passphrase first')
      // P8 D-L5: an older sync file than the newest seen here may be a rollback someone copied back.
      const newest = p.syncHash ? sync.olderThanNewest(p.createdAt) : null
      if (
        newest &&
        !(await pickers.confirm(
          'Import an older sync file?',
          `This file was written ${new Date(p.createdAt).toISOString()}, before the newest one this machine has written or imported (${new Date(newest).toISOString()}). Someone with access to the sync folder may have put an old copy back: importing it can bring back old hosts, passwords and settings. Import it only if you expect it (for example, another machine's clock is behind).`,
          'Import anyway'
        ))
      )
        throw new Error('Not imported: the sync file is older than the newest one seen here.')
      // A folder-sync file applies tombstones (deletions from the other machine); a picked file doesn't.
      const result = await applyPayload(repo, p.payload, mode, { sync: !!p.syncHash })
      imports.drop(token)
      if (p.syncHash) sync.imported(p.syncHash, p.payload, p.createdAt)
      return result
    }),
    'data:cancelImport': h(S.Token, (token) => imports.drop(token)),

    // ---------------------------------------------------------------- folder sync
    'sync:status': h(none, () => sync.status()),
    'sync:pickDir': h(none, async () => {
      const dir = await pickers.pickDir()
      return dir ? { dirToken: dirs.put(dir), dir } : null
    }),
    'sync:enable': h(S.SyncEnable, async ({ dirToken, passphrase, includeSecrets }) => {
      const dir = dirs.get(dirToken)
      if (
        includeSecrets &&
        !(await pickers.confirm(
          'Sync passwords and private keys?',
          `Every stored secret will be written, encrypted with your sync passphrase, to ${dir}. Anyone with that folder and the passphrase can read them.`,
          'Sync secrets'
        ))
      )
        return sync.status()
      const s = await sync.enable(dir, passphrase, includeSecrets)
      dirs.drop(dirToken)
      return s
    }),
    'sync:disable': h(none, () => sync.disable()),
    'sync:syncNow': h(none, async () => {
      await sync.write(true)
      return sync.status()
    }),
    'sync:previewIncoming': h(none, async () => {
      const { payload, hash, createdAt, file } = await sync.readIncoming()
      const token = imports.put({ file, createdAt, buf: null, payload, syncHash: hash })
      return preview(repo, payload, { token, file, createdAt }, { sync: true })
    }),

    // ---------------------------------------------------------------- session import (other tools, NetBox)
    'importer:pick': h(S.ImportPick, async ({ source, mode }): Promise<SessionImportPlan | null> => {
      const dir = source === 'securecrt' && mode === 'dir'
      const path =
        source === 'ssh-config' && mode === 'default'
          ? pickers.sshConfigPath()
          : await pickers.openImport(dir ? { title: 'Choose the SecureCRT Sessions folder', dir: true } : { ...IMPORT_PICK[source], dir: false })
      if (!path) return null
      const read = await readSource(source, path, dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') throw new Error(`${path} does not exist`)
        throw e
      })
      return stage({ ...read, resync: false })
    }),
    'importer:fetchNetBox': h(S.NetBoxFetch, (req) => fetchNetBox(req, false)),
    'importer:resyncNetBox': h(none, async () => {
      const src = netbox.source()
      if (!src) throw new Error('No NetBox source is set up yet: import from NetBox first')
      return fetchNetBox({ url: src.url, flavor: src.flavor, filter: src.filter }, true)
    }),
    'importer:plan': h(S.ImportPlanRequest, ({ token, csv, ...opts }) => {
      const st = staged.get(token)
      staged.touch(token)
      if (csv && st.csvText !== undefined) {
        const mapping = csvMapping(csv.mapping, st.csvText)
        const next: StagedImport = { ...st, result: remapCsv(st.csvText, mapping, csv.hasHeader), csv: { mapping, hasHeader: csv.hasHeader } }
        staged.set(token, next)
        return view(token, next, opts)
      }
      return view(token, st, opts)
    }),
    'importer:apply': h(S.ImportApplyRequest, async ({ token, ...req }): Promise<SessionImportOutcome> => {
      const st = staged.get(token)
      // Encrypted before anything is written: a locked vault fails here, not halfway.
      const sealed = st.netbox?.token ? await netbox.seal(st.netbox.token) : undefined
      const { removedIds, ...out } = applyImport(repo, st, req)
      staged.drop(token)
      if (st.netbox) netbox.commit(st.netbox, sealed, { targetFolderId: req.targetFolderId, keepFolders: req.keepFolders })
      // A removed session leaves no history behind.
      for (const id of removedIds) await scrollback.clear(id).catch(() => {})
      return out
    }),
    'importer:cancel': h(S.Token, (token) => staged.drop(token)),
    'importer:netBoxSource': h(none, (): NetBoxSource | null => netbox.source()),
    'importer:forgetNetBox': h(none, () => netbox.forget()),

    'settings:get': h(none, () => settings.get()),
    'settings:update': h(S.SettingsPatch, (p) => settings.update(p)),
    'settings:setApiKey': h(S.ApiKey, (k) => typeof k === 'object' && k !== null ? settings.setApiKey(k.key, k.provider) : settings.setApiKey(k)),

    'audit:list': h(S.Limit, (n) => audit.list(n))
  }
}

export function registerCoreIpc(svc: Services): void {
  registerAll(coreHandlers(svc))
}
