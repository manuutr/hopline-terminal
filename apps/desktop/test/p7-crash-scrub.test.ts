import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Event } from '@sentry/core'
import { NO_LOCKS, type PolicyLocks } from '@shared/policy'
import { parseDsn } from '@shared/privacy'
import type { Settings } from '@shared/types'
import { appRelative, MAX_MESSAGE, scrubEvent, scrubText } from '../src/main/crash/scrub'
import { CrashReporting, MAX_EVENTS_PER_RUN, type CrashDeps } from '../src/main/crash/service'

/**
 * D7: crash reports leave the machine scrubbed. Canary values stand in for everything that must
 * never be in a report (the user's hosts, names, terminal output, commands, keys), are planted in
 * every field an error can carry, and the bytes the transport would send are searched for them.
 */

// The user's own values (what Repo lists): session names and hosts with no recognisable shape.
const SESSION = 'zebra-core'
const DOTLESS_HOST = 'brumbyswitch'
const FQDN = 'core-sw1.dc2.acme-corp.net'
const USER = 'netadmin_kowalski'
const FOLDER = 'Warsaw DC'
const OS_USER = 'alicew'
const MACHINE = 'ALICE-LAPTOP'
const API_KEY = 'sk-ant-api03-CANARYKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-AAAA'
const VAULT_KEY_HEX = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0'
const VAULT_KEY_B64 = 'n459bFtKOSgXBvXk08KxoJ+OfWxbSjkoFwb15NPCsaA='
const PASSWORD = 'Hunter2!Canary'
const COMMUNITY = 'c0mmun1tyCanary'
const NETBOX = '0123456789abcdef0123456789abcdef01234567'
const known = [SESSION, DOTLESS_HOST, FQDN, USER, FOLDER, OS_USER, MACHINE]

const CANARIES = [
  SESSION,
  DOTLESS_HOST,
  FQDN,
  'acme-corp',
  USER,
  FOLDER,
  OS_USER,
  MACHINE,
  API_KEY,
  'CANARYKEY',
  VAULT_KEY_HEX,
  VAULT_KEY_B64,
  '9f 8e 7d 6c',
  PASSWORD,
  COMMUNITY,
  NETBOX,
  '10.20.30.40',
  '2001:db8:85a3::8a2e:370:7334',
  'fe80::1%eth0',
  '00:1a:2b:3c:4d:5e',
  '001a.2b3c.4d5e',
  'GigabitEthernet1/0/24',
  'show running-config',
  'interface Vlan10',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
  '$1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
  'C:\\Users\\alicew',
  '/home/alicew',
  '/Users/alicew',
  'edgertr7canary',
  'alicew@example.org',
  'ops-bot:hunter@'
]

const ctx = { known }
const leaks = (text: string) => CANARIES.filter((c) => text.toLowerCase().includes(c.toLowerCase()))

describe('scrubText: nasty fixtures', () => {
  const cases: [string, string][] = [
    ['ipv4 + port + prefix', `connect ECONNREFUSED 10.20.30.40:22 (route 10.20.30.40/24)`],
    ['ipv6 and scoped link-local', `EHOSTUNREACH 2001:db8:85a3::8a2e:370:7334 via fe80::1%eth0`],
    ['MAC both notations', `arp mismatch 00:1a:2b:3c:4d:5e vs 001a.2b3c.4d5e`],
    ['fqdn', `getaddrinfo ENOTFOUND ${FQDN}`],
    ['dotless host and session name', `Session ${SESSION} to ${DOTLESS_HOST} closed`],
    ['username in user@host', `auth failed for ${USER}@${DOTLESS_HOST}`],
    ['folder name with a space', `cannot move into ${FOLDER}`],
    ['prompt + command', `${'core-sw1'}#show running-config | include ${COMMUNITY}`],
    ['config-mode prompt', `R1(config-if)# interface Vlan10`],
    ['multi-line terminal output', `Timed out waiting for prompt\nGigabitEthernet1/0/24 is up\nsnmp-server community ${COMMUNITY} RO\n`],
    ['quoted command', `command "show running-config" timed out after 30s`],
    ['api key', `401 from Anthropic for key ${API_KEY}`],
    ['vault key hex', `bad tag for ${VAULT_KEY_HEX}`],
    ['vault key base64', `bad key ${VAULT_KEY_B64}`],
    ['vault key as Buffer', `unexpected <Buffer 9f 8e 7d 6c 5b 4a 39 28 17 06 f5 e4 d3 c2 b1 a0 ... 16 more bytes>`],
    ['vault key as byte list', `key: [159,142,125,108,91,74,57,40,23,6,245,228,211,194,177,160]`],
    ['vault key as colon hex', `fingerprint 9f:8e:7d:6c:5b:4a:39:28:17:06:f5:e4`],
    ['enable secret', `invalid line: enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0`],
    ['password keyword', `login failed, password ${PASSWORD} rejected`],
    ['password key=value', `prompt reply password=${PASSWORD}`],
    ['netbox token', `NetBox said 403 for Token ${NETBOX}`],
    ['pem key', `could not parse -----BEGIN OPENSSH PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END OPENSSH PRIVATE KEY----- here`],
    ['windows user path', `EPERM: open 'C:\\Users\\alicew\\Documents\\Hopline\\logs\\${SESSION}.log'`],
    ['posix home path', `ENOENT: no such file or directory, open '/home/alicew/Documents/Hopline/logs/core.log'`],
    ['mac home path', `EACCES /Users/alicew/Library/Application Support/Hopline/hopline.db`],
    ['email', `notify alicew@example.org failed`],
    ['url with credentials', `proxy http://ops-bot:hunter@proxy.acme-corp.net:3128 refused`],
    ['interface name', `no such interface GigabitEthernet1/0/24`],
    ['machine name', `${MACHINE} is offline`],
    // Hosts Hopline has no record of (a typo in quick connect, a jump host's own name): no shape, no list entry.
    ['unknown dotless host after ENOTFOUND', 'getaddrinfo ENOTFOUND edgertr7canary'],
    ['unknown dotless host after EAI_AGAIN', 'getaddrinfo EAI_AGAIN edgertr7canary'],
    ['unknown host after "connect to"', 'Timed out while trying to connect to edgertr7canary after 20s'],
    ['unknown host after "ssh to"', 'ssh to edgertr7canary: handshake failed']
  ]
  for (const [name, input] of cases)
    it(name, () => {
      const out = scrubText(input, ctx)
      expect(leaks(out), out).toEqual([])
      expect(out).not.toMatch(/[\r\n]/)
    })

  it('keeps what makes a report useful', () => {
    expect(scrubText("Cannot read properties of undefined (reading 'map')", ctx)).toBe("Cannot read properties of undefined (reading 'map')")
    expect(scrubText('x is not a function', ctx)).toBe('x is not a function')
    expect(scrubText('ERR_UPDATER_INVALID_VERSION', ctx)).toBe('ERR_UPDATER_INVALID_VERSION')
    expect(scrubText('Object.keys is not a function', ctx)).toBe('Object.keys is not a function')
    expect(scrubText('Unexpected token < in JSON at position 0', ctx)).toBe('Unexpected token < in JSON at position 0')
    expect(scrubText('connect ECONNREFUSED 10.1.1.1:22', ctx)).toBe('connect ECONNREFUSED <ip>')
    // A code-looking name under a real TLD is still a host.
    expect(scrubText('this.acme.com refused', ctx)).toBe('<host> refused')
  })

  it('caps the length and does not throw on odd input', () => {
    expect(scrubText('a '.repeat(5000), ctx).length).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(scrubText(undefined, ctx)).toBe('')
    expect(scrubText({ toString: () => `obj ${SESSION}` }, ctx)).toBe('obj <redacted>')
  })

  it('known values match whole words only, case-insensitively', () => {
    expect(scrubText('ZEBRA-CORE went away', ctx)).toBe('<redacted> went away')
    expect(scrubText('score', { known: ['core'] })).toBe('score')
  })
})

describe('appRelative: frame paths lose the user part', () => {
  it.each([
    ['/opt/Hopline/resources/app.asar/out/main/index.js', 'app.asar/out/main/index.js'],
    ['C:\\Users\\alicew\\AppData\\Local\\Programs\\Hopline\\resources\\app.asar\\out\\main\\index.js', 'app.asar/out/main/index.js'],
    ['/home/alicew/code/hopline/apps/desktop/out/main/index.js', 'out/main/index.js'],
    ['/home/alicew/code/hopline/node_modules/ssh2/lib/client.js', 'node_modules/ssh2/lib/client.js'],
    ['file:///home/alicew/x/out/renderer/assets/index-abc.js', 'out/renderer/assets/index-abc.js'],
    ['node:internal/process/task_queues', 'node:internal/process/task_queues'],
    ['/home/alicew/secret-project/tool.js', 'tool.js'],
    [`/home/alicew/logs/${SESSION}.log`, '<file>']
  ])('%s', (input, out) => expect(appRelative(input)).toBe(out))
})

describe('scrubEvent: an allow-list, not a deny-list', () => {
  const nasty = (): Event => ({
    event_id: 'abc',
    level: 'error',
    release: 'hopline@0.7.0',
    environment: 'production',
    server_name: MACHINE,
    user: { id: OS_USER, username: OS_USER, ip_address: '10.20.30.40' },
    breadcrumbs: [{ category: 'console', message: `core-sw1#show running-config\nsnmp-server community ${COMMUNITY} RO` }],
    extra: { apiKey: API_KEY, vault: VAULT_KEY_HEX },
    contexts: { device: { name: MACHINE }, culture: { timezone: 'Europe/Warsaw' }, app: { app_name: SESSION } },
    request: { url: `https://${FQDN}/api`, headers: { authorization: `Bearer ${NETBOX}` } },
    modules: { [`/home/${OS_USER}/x`]: '1' },
    fingerprint: [SESSION],
    transaction: SESSION,
    tags: { process: 'main', host: FQDN, session: SESSION, kind: 'exception', os: 'linux' },
    exception: {
      values: [
        {
          type: 'Error',
          value: `connect ETIMEDOUT 10.20.30.40:22 (${SESSION})`,
          mechanism: { type: 'hopline.exception', handled: false, data: { host: FQDN } },
          stacktrace: {
            frames: [
              {
                filename: `/home/${OS_USER}/hopline/apps/desktop/out/main/index.js`,
                abs_path: `/home/${OS_USER}/hopline/apps/desktop/out/main/index.js`,
                function: 'SessionHostClient.open',
                lineno: 10,
                colno: 5,
                context_line: `const pw = '${PASSWORD}'`,
                pre_context: [API_KEY],
                vars: { password: PASSWORD, host: FQDN }
              },
              { filename: `C:\\Users\\${OS_USER}\\AppData\\Local\\hopline\\${SESSION}.js`, function: `eval at ${SESSION}`, lineno: 1 }
            ]
          }
        }
      ]
    }
  })

  it('keeps type, scrubbed message, frames and allow-listed tags; drops the rest', () => {
    const out = scrubEvent(nasty(), ctx)!
    expect(out).toBeTruthy()
    expect(Object.keys(out).sort()).toEqual(['environment', 'event_id', 'exception', 'level', 'platform', 'release', 'tags'])
    expect(out.tags).toEqual({ process: 'main', kind: 'exception', os: 'linux' })
    const ex = out.exception!.values![0]!
    expect(ex.type).toBe('Error')
    expect(ex.value).toBe('connect ETIMEDOUT <ip> (<redacted>)')
    expect(ex.mechanism).toEqual({ type: 'hopline.exception', handled: false })
    expect(ex.stacktrace!.frames![0]).toEqual({ filename: 'out/main/index.js', function: 'SessionHostClient.open', lineno: 10, colno: 5, in_app: true })
    expect(ex.stacktrace!.frames![1]!.filename).toBe('<file>')
    expect(leaks(JSON.stringify(out))).toEqual([])
  })

  it('drops an event with nothing to report, and one that cannot be read', () => {
    expect(scrubEvent({ breadcrumbs: [{ message: SESSION }] }, ctx)).toBeNull()
    const bad = { exception: { values: [{ get type(): string { throw new Error('boom') } }] } } as unknown as Event
    expect(scrubEvent(bad, ctx)).toBeNull()
  })
})

// ------------------------------------------------------------------ the whole pipeline

const settings = (over: Partial<Settings> = {}) => ({ crashReports: true, crashReportDsn: 'http://abcdef0123456789@127.0.0.1:1/42', updateChannel: 'stable', ...over }) as Settings

function reporter(over: Partial<CrashDeps> = {}, s: Partial<Settings> = {}, locks: PolicyLocks = NO_LOCKS) {
  const sent: { url: string; body: string }[] = []
  const dumps = mkdtempSync(join(tmpdir(), 'hopline-dumps-'))
  const deps: CrashDeps = {
    settings: () => settings(s),
    locks: () => locks,
    known: () => known,
    version: '0.7.0',
    builtInDsn: '',
    fetch: async (url, init) => {
      sent.push({ url, body: typeof init.body === 'string' ? init.body : init.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : '[form]' })
      return { status: 200, headers: { get: () => null } }
    },
    dumpsDir: () => dumps,
    confirm: async () => true,
    platform: 'linux',
    arch: 'x64',
    electron: '45.4.1',
    ...over
  }
  return { r: new CrashReporting(deps), sent, dumps }
}

describe('CrashReporting: what reaches the transport', () => {
  it('is fully off by default: no client, nothing sent', async () => {
    const { r, sent } = reporter({}, { crashReports: false })
    r.apply()
    expect(r.capture(new Error(`boom ${SESSION}`), 'main', 'exception')).toBeNull()
    expect((await r.sendTest()).ok).toBe(false)
    expect(sent).toEqual([])
    expect(r.status().enabled).toBe(false)
  })

  it('the team policy keeps it off even when the user opted in', async () => {
    const { r, sent } = reporter({}, {}, { ...NO_LOCKS, crashReportsDisabled: true })
    r.apply()
    expect(r.capture(new Error('boom'), 'main', 'exception')).toBeNull()
    expect(sent).toEqual([])
    expect(r.status()).toMatchObject({ enabled: false, managed: true })
  })

  it('no canary survives into the envelope bytes, whatever the error carries', async () => {
    const { r, sent } = reporter()
    r.apply()
    const e = Object.assign(new Error(`connect ECONNREFUSED 10.20.30.40:22 ${SESSION} ${API_KEY}`), {
      address: '10.20.30.40',
      hostname: FQDN,
      path: `/home/${OS_USER}/x`,
      username: USER,
      password: PASSWORD,
      key: Buffer.from(VAULT_KEY_HEX, 'hex'),
      cause: new Error(`inner ${COMMUNITY} ${VAULT_KEY_B64}`)
    })
    e.stack = `Error: ${e.message}\n    at open (/home/${OS_USER}/hopline/out/main/index.js:10:5)\n    at ${SESSION} (C:\\Users\\${OS_USER}\\${FOLDER}\\x.js:1:1)`
    r.capture(e, 'main', 'exception')
    r.captureRenderer({ name: 'TypeError', message: `bad output from ${DOTLESS_HOST}#show running-config\n${'GigabitEthernet1/0/24 up\n'.repeat(5)}`, stack: `TypeError: x\n    at render (file:///home/${OS_USER}/out/renderer/index.js:3:4)` }, 'exception')
    r.processGone('Utility', 'crashed', 139)
    const test = await r.sendTest()
    expect(test.ok).toBe(true)
    const bytes = sent.map((s) => s.body).join('\n')
    expect(sent.length).toBe(4)
    expect(leaks(bytes)).toEqual([])
    // Still useful: the error class, the app-relative frame, the process that died.
    expect(bytes).toContain('ECONNREFUSED')
    expect(bytes).toContain('out/main/index.js')
    expect(bytes).toContain('process gone: session-host (crashed, exit code 139)')
    expect(bytes).toContain('HoplineTestCrash')
    // Nothing that names the machine or the person.
    expect(bytes).not.toMatch(/server_name|"user"|breadcrumbs|"extra"/)
    expect(sent[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:1\/api\/42\/envelope\/\?.*sentry_key=abcdef0123456789/)
  })

  it('sends one report per distinct error, and at most MAX_EVENTS_PER_RUN', async () => {
    const { r, sent } = reporter()
    r.apply()
    for (let i = 0; i < 3; i++) r.capture(new Error(`same at 10.0.0.${i}`), 'main', 'exception')
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 10; i++) r.capture(new Error(`distinct${i}`), 'main', 'exception')
    await r.close()
    expect(sent.length).toBe(MAX_EVENTS_PER_RUN)
  })

  it('a DSN with a secret key, or plain http to another machine, is refused', () => {
    expect(parseDsn('https://abcdef0123456789@o1.ingest.sentry.io/42')).toMatchObject({ host: 'o1.ingest.sentry.io', projectId: '42' })
    expect(parseDsn('https://abcdef0123456789:secretsecret@o1.ingest.sentry.io/42')).toBeNull()
    expect(parseDsn('http://abcdef0123456789@sentry.lan/42')).toBeNull()
    expect(parseDsn('https://abcdef0123456789@glitchtip.acme.net/sub/7')).toMatchObject({ path: 'sub', projectId: '7' })
    expect(parseDsn('https://abcdef0123456789@sentry.io/notanumber')).toBeNull()
  })

  it('the policy DSN wins over the user one, which wins over the built-in one', () => {
    const pol = { ...NO_LOCKS, crashReportDsn: 'https://aaaaaaaaaaaaaaaa@policy.example/1' }
    expect(reporter({ builtInDsn: 'https://bbbbbbbbbbbbbbbb@builtin.example/3' }, {}, pol).r.status()).toMatchObject({ dsnSource: 'policy', target: 'policy.example / 1' })
    expect(reporter({ builtInDsn: 'https://bbbbbbbbbbbbbbbb@builtin.example/3' }, { crashReportDsn: '' }).r.status()).toMatchObject({ dsnSource: 'built-in' })
    expect(reporter({}, { crashReportDsn: '' }).r.status()).toMatchObject({ dsnSource: null, enabled: false })
  })
})

describe('native crash dumps: only one at a time, only after a confirmation', () => {
  it('lists dumps, sends one only when confirmed, and deletes it afterwards', async () => {
    let answer = false
    const { r, sent, dumps } = reporter({ confirm: async () => answer })
    mkdirSync(join(dumps, 'pending'), { recursive: true })
    const file = join(dumps, 'pending', '1f2e3d4c-aaaa-bbbb-cccc-1234567890ab.dmp')
    writeFileSync(file, Buffer.from('MDMP fake dump'))
    r.apply()
    expect(r.status().dumps.map((d) => d.id)).toEqual(['1f2e3d4c-aaaa-bbbb-cccc-1234567890ab'])
    expect(await r.sendDump('1f2e3d4c-aaaa-bbbb-cccc-1234567890ab')).toEqual({ ok: false, reason: 'cancelled' })
    expect(sent).toEqual([])
    answer = true
    expect(await r.sendDump('1f2e3d4c-aaaa-bbbb-cccc-1234567890ab')).toEqual({ ok: true })
    expect(sent[0]!.url).toBe('http://127.0.0.1:1/api/42/minidump/?sentry_key=abcdef0123456789')
    expect(existsSync(file)).toBe(false)
  })

  it('refuses ids that are not plain names, and sends nothing while reports are off', async () => {
    const { r, sent } = reporter({}, { crashReports: false })
    expect(await r.sendDump('../../etc/passwd')).toEqual({ ok: false, reason: 'off' })
    const on = reporter()
    expect(await on.r.sendDump('../../etc/passwd')).toEqual({ ok: false, reason: 'missing' })
    expect(on.r.deleteDump('../x')).toBe(false)
    expect(sent).toEqual([])
  })
})
