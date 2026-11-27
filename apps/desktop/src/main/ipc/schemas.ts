import { PROVIDERS, CLOUD_PROVIDERS, ACCOUNT_PROVIDERS } from '@shared/providers'
import { SESSION_PLATFORMS } from '@hopline/guard'
import { z } from 'zod'
import { parseOrigin } from '@shared/ollama'
import { parseDsn } from '@shared/privacy'
import { SESSION_COLORS } from '@shared/types'

/** Every IPC payload from the renderer is validated here before main acts on it. */
const id = z.string().min(1).max(64)
const name = z.string().trim().min(1).max(120)
const tag = z.string().trim().min(1).max(40).regex(/^[^\s,]+$/, 'no spaces or commas')
const tags = z.array(tag).max(32)
const color = z.enum(SESSION_COLORS).nullable()
const ids = z.array(id).min(1).max(5000)

const serialSettings = z
  .object({
    baudRate: z.number().int().min(50).max(4_000_000),
    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
    parity: z.enum(['none', 'even', 'odd', 'mark', 'space']),
    stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
    flow: z.enum(['none', 'rtscts', 'xonxoff']),
    breakMs: z.number().int().min(10).max(10_000)
  })

/** A saved port forward (shared/files.ts ForwardSpec). */
const fwdHost = z
  .string()
  .trim()
  .max(255)
  .refine((v) => !/[\s/\\]/.test(v), 'invalid address')
const forwardSpec = z
  .object({
    id: z.string().min(1).max(80),
    kind: z.enum(['L', 'R', 'D']),
    bindHost: fwdHost,
    bindPort: z.number().int().min(0).max(65535),
    destHost: fwdHost.optional(),
    destPort: z.number().int().min(1).max(65535).optional(),
    autoStart: z.boolean().optional(),
    label: z.string().max(80).optional()
  })
  .strict()
  .refine((f) => f.kind === 'D' || (!!f.destHost && !!f.destPort), 'L and R forwards need a destination')

/**
 * A session's fields. Not strict on its own: export and sync files (ImportPayload) are parsed with
 * it, and a file written by another version may carry fields this one doesn't know.
 */
export const SessionFields = z.object({
  id: id.optional(),
  name,
  folderId: id.nullable(),
  host: z.string().trim().min(1).max(255),
  // Serial sessions keep the device path in `host` and use port 0.
  port: z.number().int().min(0).max(65535),
  protocol: z.enum(['ssh', 'telnet', 'raw', 'serial']),
  platform: z.enum(SESSION_PLATFORMS),
  username: z.string().max(120),
  credentialId: id.nullable(),
  logToFile: z.boolean(),
  notes: z.string().max(4000),
  options: z
    .object({
      serial: serialSettings.optional(),
      ssh: z
        .object({
          jump: z.array(id).max(8).optional(),
          useAgent: z.boolean().optional(),
          agentForward: z.boolean().optional(),
          legacyAlgorithms: z.boolean().optional(),
          forwards: z.array(forwardSpec).max(32).optional()
        })
        .optional()
    })
    .default({}),
  tags: tags.optional(),
  color: color.optional(),
  favorite: z.boolean().optional()
})
/**
 * `sessions:save` (P8 I1): strict. The session editor sends back the Session it was opened with, so
 * the read-only fields main itself fills in are accepted and dropped; any other key is refused.
 */
export const SessionInput = SessionFields.extend({ lastConnectedAt: z.unknown().optional(), ephemeral: z.unknown().optional(), detected: z.unknown().optional() })
  .strict()
  .transform(({ lastConnectedAt: _l, ephemeral: _e, detected: _d, ...s }) => s)

export type SessionInputValue = z.output<typeof SessionInput>
export const SessionPatch = z
  .object({
    folderId: id.nullable(),
    platform: z.enum(SESSION_PLATFORMS),
    username: z.string().max(120),
    credentialId: id.nullable(),
    color,
    favorite: z.boolean(),
    addTags: tags,
    removeTags: tags
  })
  .partial()
  .strict()
export const BulkUpdate = z.object({ ids, patch: SessionPatch }).strict()
export type SessionPatchValue = z.output<typeof SessionPatch>
export const MoveMany = z
  .object({
    items: z.object({ sessionIds: z.array(id).max(5000), folderIds: z.array(id).max(5000) }).strict(),
    folderId: id.nullable()
  })
  .strict()
/**
 * Quick connect: only what the quick-connect box can express. No credential, jump host, logging,
 * notes or SSH options: a renderer can't use an unsaved session to reach a stored secret or a file.
 */
export const QuickConnectInput = z
  .object({
    name,
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(0).max(65535),
    protocol: z.enum(['ssh', 'telnet', 'raw', 'serial']),
    platform: z.enum(SESSION_PLATFORMS),
    username: z.string().max(120),
    options: z.object({ serial: serialSettings.strict().optional() }).strict().default({})
  })
  .strict()
export const RemoveMany = z.object({ sessionIds: z.array(id).max(5000), folderIds: z.array(id).max(5000) }).strict()
export const SetPlatform = z.object({ id: z.string().min(1).max(80), platform: z.enum(SESSION_PLATFORMS) }).strict()
export const SaveEphemeral = z.object({ id, patch: z.object({ name, folderId: id.nullable() }).strict() }).strict()

export const FolderInput = z.object({ id: id.optional(), name, parentId: id.nullable() }).strict()

const credentialKind = z.enum(['password', 'key', 'agent', 'prompt'])

export const ReplacePasswords = z.strictObject({
  ids: z.array(id).min(1).max(200),
  password: z.string().min(1).max(65_536)
})

export const CredentialInput = z.object({
  id: id.optional(),
  name,
  username: z.string().max(120),
  kind: credentialKind,
  secret: z.string().max(65_536).optional(),
  passphrase: z.string().max(1024).optional(),
  keyToken: z.string().uuid().optional()
}).strict()

export const AccountRequest = z.strictObject({ provider: z.enum(ACCOUNT_PROVIDERS), action: z.enum(['start', 'status', 'cancel', 'disconnect']) })
export const AiProvider = z.enum(PROVIDERS)
/** An Ollama server: an http(s) origin only (no path, query or fragment: review L2), no credentials. */
export const Endpoint = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((u) => parseOrigin(u) !== null, 'must be an http(s) origin (scheme, host and port) without credentials, path or query')
export const OllamaModelName = z.string().trim().min(1).max(200).regex(/^[\w.:/@-]+$/, 'letters, digits and . : / @ - _ only')
export const AiTestRequest = z
  .object({
    provider: AiProvider,
    model: z.string().trim().min(1).max(200),
    key: z.string().trim().min(1).max(512).optional(),
    endpoint: Endpoint.optional(),
    insecureAck: z.boolean().optional()
  })
  .strict()

export const SettingsPatch = z
  .object({
    theme: z.enum(['dark', 'light', 'system', 'contrast']),
    reduceMotion: z.boolean(),
    termSmoothCaret: z.boolean(),
    termLigatures: z.boolean(),
    aiReadOnly: z.boolean(),
    aiProvider: AiProvider,
    openaiModel: z.string().trim().min(1).max(200),
    geminiModel: z.string().trim().min(1).max(200),
    aiModel: z.string().min(1).max(100),
    ollamaEndpoint: Endpoint,
    ollamaModel: OllamaModelName.or(z.literal('')),
    ollamaInsecureAck: Endpoint.or(z.literal('')),
    aiIntroDismissed: z.boolean(),
    // 5k is the policy's own floor (policy.ts); settings.ts clamps a user's budget up to MIN_RUN_TOKEN_BUDGET.
    aiRunTokenBudget: z.number().int().min(5_000).max(4_000_000),
    egressLog: z.boolean(),
    commandTimeoutMs: z.number().int().min(1000).max(300_000),
    outputCapBytes: z.number().int().min(4096).max(16 * 1024 * 1024),
    logDir: z.string().min(1).max(1024),
    keepAliveSec: z.number().int().min(0).max(3600),
    filesOnConnect: z.boolean(),
    autoReconnect: z.boolean(),
    termHighlight: z.boolean(),
    termAutocomplete: z.boolean(),
    termFontFamily: z.string().max(200).regex(/^[\w\s"',.-]*$/, 'letters, spaces, quotes and commas only'),
    termFontSize: z.number().min(8).max(32),
    termLineHeight: z.number().min(1).max(2),
    termCursorStyle: z.enum(['bar', 'block', 'underline']),
    termCursorBlink: z.boolean(),
    termScrollback: z.number().int().min(500).max(200_000),
    termTheme: z.string().regex(/^[a-z0-9-]{1,40}$/),
    termRestoreScrollback: z.boolean(),
    termScreenReader: z.boolean(),
    a11yOfferAnswered: z.boolean(),
    notifyApprovals: z.boolean(),
    notifyDisconnects: z.boolean(),
    updateAutoCheck: z.boolean(),
    updateChannel: z.enum(['stable', 'beta']),
    crashReports: z.boolean(),
    crashReportDsn: z
      .string()
      .max(300)
      .refine((v) => v === '' || !!parseDsn(v), 'must be a Sentry DSN: https://<public key>@<host>/<project id>'),
    privacyReviewed: z.boolean(),
    logTemplate: z.string().min(1).max(200),
    logTimestamps: z.boolean(),
    logRotateDaily: z.boolean()
  })
  .partial()
  .strict()

export const Dims = z.object({ cols: z.number().int().min(10).max(1000), rows: z.number().int().min(2).max(500) })
export const Id = id
export const AgentRequest = z.object({
  tabId: id,
  prompt: z.string().trim().min(1).max(8000),
  selection: z.string().max(200_000).optional()
}).strict()
export const Move = z.object({ sessionId: id, folderId: id.nullable() }).strict()
const KeyValue = z.string().trim().min(1).max(512).nullable()
export const ApiKey = z.union([KeyValue, z.strictObject({ provider: z.enum(CLOUD_PROVIDERS), key: KeyValue })])
export const Limit = z.number().int().min(1).max(5000).optional()
export const TermOpen = z.object({
  tabId: z.string().uuid(),
  sessionId: id,
  cols: z.number().int().min(10).max(1000),
  rows: z.number().int().min(2).max(500),
  password: z.string().max(1024).optional()
}).strict()
export const PromptAnswer = z.object({
  id,
  value: z.union([z.boolean(), z.string().max(4096), z.array(z.string().max(4096)).max(20), z.null()])
}).strict()
export const ScrollbackSave = z.object({ sessionId: id, data: z.string().max(16 * 1024 * 1024) }).strict()
export const OptionalId = id.optional()
export const HostPort = z.object({ host: z.string().min(1).max(255), port: z.number().int().min(0).max(65535) }).strict()
export const TermReconnect = z.object({ tabId: id, password: z.string().max(1024).optional() }).strict()
export const Decide = z.object({ proposalId: id, approve: z.boolean(), ack: z.string().max(255).optional(), lines: z.array(z.number().int().min(0).max(49)).max(50).optional() }).strict()
/** Confirm or roll back an applied change (Proposals v2). */
export const ChangeAction = z.object({ proposalId: id, action: z.enum(['confirm', 'rollback']) }).strict()

// ------------------------------------------------------------------ vault
const masterPassword = z.string().min(1).max(1024)
export const Password = masterPassword
export const VaultSetMode = z.object({ mode: z.enum(['keychain', 'master', 'session']), password: masterPassword.optional(), current: masterPassword.optional() }).strict()
export const ChangePassword = z.object({ current: masterPassword, next: masterPassword }).strict()
export const Minutes = z.number().int().min(0).max(24 * 60)
export const AutoLock = z.object({ minutes: Minutes, current: masterPassword.optional() }).strict()

// ------------------------------------------------------------------ export / import / sync
export const ExportRequest = z.object({ passphrase: z.string().min(8).max(1024), includeSecrets: z.boolean() }).strict()
export const ImportPreviewRequest = z.object({ token: z.string().uuid(), passphrase: z.string().min(1).max(1024) }).strict()
export const ImportApply = z.object({ token: z.string().uuid(), mode: z.enum(['merge', 'replace']) }).strict()
export const Token = z.string().uuid()
export const SyncEnable = z.object({ dirToken: z.string().uuid(), passphrase: z.string().min(8).max(1024), includeSecrets: z.boolean() }).strict()

// ------------------------------------------------------------------ session import
export const ImportPick = z.object({
  source: z.enum(['securecrt', 'mobaxterm', 'putty', 'ssh-config', 'csv']),
  mode: z.enum(['file', 'dir', 'default']).default('file')
}).strict()
const csvField = z.enum(['name', 'host', 'port', 'protocol', 'username', 'folder', 'platform', 'tags', 'notes', 'baud'])
export const ImportPlanRequest = z.object({
  token: z.string().uuid(),
  targetFolderId: id.nullable(),
  keepFolders: z.boolean(),
  csv: z.object({ mapping: z.partialRecord(csvField, z.number().int().min(0).max(500)), hasHeader: z.boolean() }).strict().optional()
}).strict()
export const ImportApplyRequest = z.object({
  token: z.string().uuid(),
  targetFolderId: id.nullable(),
  keepFolders: z.boolean(),
  rows: z.array(z.number().int().min(0)).max(100_000),
  remove: z.array(id).max(100_000),
  platforms: z.record(z.string().regex(/^[0-9]+$/), z.enum(SESSION_PLATFORMS))
}).strict()
export const NetBoxFetch = z.object({
  url: z.string().trim().min(1).max(2048),
  flavor: z.enum(['netbox', 'nautobot']),
  filter: z.string().max(2000),
  token: z.string().trim().max(512).optional()
}).strict()

const stamp = z.number().int().min(0).optional()

/** An export file is untrusted input: every record is validated like an IPC payload. */
export const ImportPayload = z.object({
  format: z.literal('hopline-data'),
  version: z.literal(1),
  exportedAt: z.number(),
  includesSecrets: z.boolean(),
  // updatedAt (ms): when the item last changed on the writing machine; folder sync compares it
  // with tombstones. Missing in files from before 0.3.
  folders: z.array(z.object({ id, name, parentId: id.nullable(), sort: z.number().int().default(0), updatedAt: stamp })).max(50_000),
  sessions: z.array(SessionFields.extend({ id, updatedAt: stamp })).max(100_000),
  credentials: z
    .array(
      z.object({
        id,
        name,
        username: z.string().max(120),
        kind: credentialKind,
        keyType: z.string().max(100).nullable().default(null),
        keyFingerprint: z.string().max(200).nullable().default(null),
        keyEncrypted: z.boolean().default(false),
        secret: z.string().max(65_536).optional(),
        passphrase: z.string().max(1024).optional(),
        updatedAt: stamp
      })
    )
    .max(10_000),
  tombstones: z
    .array(z.object({ type: z.enum(['session', 'folder', 'credential']), id, deletedAt: z.number().int().min(0) }))
    .max(200_000)
    .default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  knownHosts: z
    .array(
      z.object({
        host: z.string().min(1).max(255),
        port: z.number().int().min(0).max(65535),
        fingerprint: z.string().min(1).max(200),
        keyType: z.string().max(100).default(''),
        source: z.enum(['tofu', 'import', 'user']).default('import'),
        addedAt: z.number().default(0)
      })
    )
    .max(200_000)
})
