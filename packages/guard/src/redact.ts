/**
 * Redact secrets from device output before it reaches the LLM (or anything outside main).
 *
 * One ruleset, one place: `REDACT_RULES` is the table every redaction path applies (the model's
 * input, agent and fleet tool results, the backups view, the audit log, crash reports). Each rule
 * names the capture group that holds the secret; only that span is replaced, so the keyword, the
 * type token and the non-secret context around it (IPs, host names, user names) stay readable:
 * `password 7 <redacted>`, `pre-shared-key address 203.0.113.5 key <redacted>`.
 *
 * Over-redaction is acceptable; leaking a secret is not. A span that is already `<redacted>` is
 * left alone and not counted, so `redact(redact(x))` equals `redact(x)` and the count is the
 * number of secrets actually removed.
 *
 * Order matters: vendor ciphertext blobs and well-known token shapes are replaced first, wherever
 * they appear, because they can contain `;`, `{`, `#` or `=` that would end a keyword rule's value
 * early. Specific rules (a secret behind qualifier words: `pre-shared-key address <ip> key X`) run
 * before the generic keyword rule, and the generic rule refuses a qualifier word as its value, so a
 * form nobody taught it is a miss, never "the wrong word redacted and counted".
 *
 * Every pattern is linear: no nested quantifiers over overlapping classes, token runs are bounded,
 * and separators are `[ \t]` (a keyword never takes its value from the next line). Input is
 * device-controlled; the tests feed 1 MB adversarial lines to every rule.
 */

export const REDACTED = '<redacted>'

/**
 * Bumped whenever the ruleset changes what it redacts. Stored data that was redacted with an older
 * version (the audit log) is redacted again on startup.
 */
export const REDACT_RULESET_VERSION = 3

export interface RedactRule {
  /** Stable id (tests and docs refer to it). */
  id: string
  description: string
  /** A global regex. Its `secret` group(s) are replaced; everything else in the match is kept. */
  re?: RegExp
  /** Capture group(s) holding the secret; 0 is the whole match. */
  secret?: number | readonly number[]
  /** Text the secret span becomes (default `<redacted>`). */
  replacement?: string
  /** Cheap pre-check: the rule is skipped when this does not match (performance only). */
  gate?: RegExp
  /** A stateful matcher instead of `re` (multi-line context). */
  apply?: (text: string) => RedactResult
}

export interface RedactResult {
  text: string
  /** Number of secrets replaced (for the audit log). */
  count: number
}

/**
 * Encryption type / algorithm / qualifier tokens that sit between a keyword and its secret:
 * `password 7 X`, `set-key ascii 8 X`, `authentication-key 1 md5 X`, `password irreversible-cipher X`,
 * `set password ENC X`, `enable password level 15 X`, `pre-shared-key local 0 X`,
 * `key-string password X` (IOS-XR), `key plaintext X` (AOS-CX), `failover key hex X` (ASA).
 */
const TYPE = String.raw`(?:\d{1,2}|level[ \t]+\d{1,2}|md5|sha\d*|sha-?\d+|hmac-sha-?\d*|hmac-md5|aes\d*|aes-\d+|des\d*|3des|ascii|ascii-text|hex|unencrypted|encrypted|hidden|plain-text|plaintext|text|cleartext|clear|cipher|ciphertext|irreversible-cipher|simple|enc|key|local|remote|password)`
/**
 * Up to six type tokens, taken atomically (`(?=(…))\N` is the JS spelling of an atomic group): the
 * engine never gives a type word back to the value, so `password irreversible-cipher <redacted>`
 * is left alone instead of the type word being "redacted" while the real value survives.
 */
const types = (group: number) => String.raw`(?=((?:${TYPE}[ \t]+){0,6}))` + '\\' + group
/** Not a value: already redacted (bare or quoted), or an `=`/`:` (a key=value form, its own rule). */
const NOT_DONE = String.raw`(?!["']?<redacted>)(?![=:])`
/**
 * Words that sit between a keyword and its secret but are not the secret. The generic keyword rule
 * refuses them as a value; the specific rules below skip over them to the real secret.
 */
const QUAL = String.raw`(?!(?:address|hostname|manager|operator|port-access|user-name|inside|outside|set|add|remove|print|edit|export|ipv4|ipv6)(?:[ \t]|$))`
/** A secret value: quoted string or a single token (bounded). */
const VAL = String.raw`(?:"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s;{]{1,4096})`

/**
 * Secret-bearing keywords (regex source each). Exported so the crash scrubber reuses the same list
 * (apps/desktop crash/scrub.ts). `\s+` inside a keyword is kept (the scrubber's tests turn the source
 * back into text); the keyword rule itself takes its value with `[ \t]+`, never from the next line.
 */
export const SECRET_KEYWORDS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'shared-secret',
  'shared-key',
  'secret-key',
  'key-string',
  'authentication-key',
  'message-digest-key',
  'pre-shared-key',
  'encrypted-password',
  'simple-password',
  'plain-text-password-value',
  'password-encrypt',
  'phash',
  // `wpa2-psk` (a RouterOS value) is not the keyword: only a `psk` that starts a word.
  '(?<![\\w-])psk(?!\\s+set-key\\b)',
  'wpa-psk',
  'set-key',
  'psksecret',
  'psk-secret',
  'key\\s+(?:0|6|7)',
  'server-key',
  'tacacs-server\\s+key',
  'radius-server\\s+key',
  'tacacs\\s+key',
  'isakmp\\s+key',
  'failover\\s+key',
  'wpa-personal\\s+key',
  '(?:auth|priv)-pass[\\w-]*',
  '[a-z]+-pwd',
  '(?:authentication|privacy)-mode(?=\\s+(?:md5|sha|aes|des|3des|hmac))',
  'community-string',
  'apikey',
  'api-key',
  'private-key',
  'token(?=[ \\t]+[^\\s:]{8,})'
]

/** Keys of `key=value`, `key: value` and `"key":"value"` pairs whose value is a secret. */
const KV_KEYS = String.raw`(?:password|passwd|passphrase|secret|psk|pre-shared-key|preshared-key|shared-key|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|auth[-_]?key|authentication-key|client[-_]?secret|credentials?)`
/** A key=value value: quoted, or a token up to a separator. An unclosed quote takes the token. */
const KV_VAL = String.raw`(?:"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|[^\s,;&"'}\]<>]{1,4096}|["'][^\s"']{1,4096})`

const R = (id: string, description: string, re: RegExp, secret: number | readonly number[], extra: Partial<RedactRule> = {}): RedactRule => ({
  id,
  description,
  re: new RegExp(re.source, re.flags.includes('d') ? re.flags : re.flags + 'd'),
  secret,
  ...extra
})

// Every complete or truncated PEM/PPK form below needs one of these case-sensitive markers.
const KEY_BLOCK_MARKER = /PRIVATE KEY-----|Private-(?:Lines|MAC):/

export const REDACT_RULES: readonly RedactRule[] = [
  // ---- private keys (multi-line)
  R(
    'fortios-private-key-cut',
    'FortiOS `set private-key "…` cut off before its closing quote (output cap, a sliced tail): everything after the keyword is key material.',
    /(\bset\s+private-key\s+)("[^"]*)$/gi,
    2,
    { gate: /private-key/i }
  ),
  R('pem-private-key', 'PEM private key block: the body between BEGIN and END.', /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----((?:(?!-----BEGIN )[\s\S])*?)-----END \1PRIVATE KEY-----/g, 2, {
    replacement: ` ${REDACTED} `,
    gate: KEY_BLOCK_MARKER
  }),
  R(
    'pem-private-key-unterminated',
    'A PEM BEGIN line whose END never arrived (the output cap cut it off): redacted to the next BEGIN line or the end of the text.',
    /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----((?:(?!-----END )[\s\S])*?)(?=-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    2,
    { replacement: ` ${REDACTED}`, gate: KEY_BLOCK_MARKER }
  ),
  R(
    'ppk-private',
    'PuTTY .ppk (v2 and v3): everything from `Private-Lines: N` on is key material or its MAC.',
    /^([ \t]*Private-Lines:)([ \t]*\d+[\s\S]*)$/gm,
    2,
    { replacement: ` ${REDACTED}`, gate: KEY_BLOCK_MARKER }
  ),
  R('ppk-mac', 'A .ppk tail whose Private-Lines header was cut off: the MAC line.', /^([ \t]*Private-MAC:)(?![ \t]*<redacted>)([^\n]*)/gm, 2, {
    replacement: ` ${REDACTED}`,
    gate: KEY_BLOCK_MARKER
  }),
  {
    id: 'headless-key-body',
    description: 'A key body whose BEGIN line (PEM) or Private-Lines header (.ppk) was cut off: the run of body lines before the END / Private-MAC line.',
    gate: KEY_BLOCK_MARKER,
    apply: (t) => redactHeadless(t)
  },
  R(
    'xml-secret-element',
    'PAN-OS (and other) XML secret elements (`<phash>`, `<bind-password>`, `<private-key>`…), whatever the value looks like; a value cut off before its closing tag runs to the end of the text.',
    /(<(phash|password|passwd|passphrase|private-key|key|secret|shared-secret|pre-shared-key|auth-password|priv-password|authpwd|privpwd|community|community-string|api-key|apikey|psk|token|bind-password|bind-pw|auth-key|authentication-key|secret-key)(?:\s[^<>]{0,1024})?>)(?!<redacted>)([^<]+)/gi,
    3,
    { gate: /</ }
  ),
  // ---- ciphertext blobs and token shapes, wherever they appear
  R('vrp-cipher', 'Huawei VRP cipher text `%^%#…%^%#` and the older `%@%@…%@%@` (any printable character inside).', /%\^%#[^\n]*?%\^%#|%@%@[^\n]*?%@%@/g, 0, { gate: /%\^%#|%@%@/ }),
  R('vrp-irreversible', 'Huawei irreversible cipher (`$1a$…`, `$1c$…`): punctuation-heavy, runs to the next space.', /\$1[a-d]\$\S+/g, 0, { gate: /\$1[a-d]\$/ }),
  R('fortios-enc', 'FortiOS encrypted values: `set password ENC <base64>`.', /(\bENC\s+)([A-Za-z0-9+/=]{4,})/g, 2, { gate: /ENC/ }),
  R('aoscx-panos-ciphertext', 'AOS-CX ciphertext (base64 starting AQB) and PAN-OS encrypted values (`-AQ==…`).', /\bAQB[A-Za-z0-9+/=]{8,}|-AQ==[A-Za-z0-9+/=]*/g, 0, { gate: /AQB|-AQ==/ }),
  R('crypt-hash', 'Unix crypt hashes (`$1$`, `$5$`, `$6$`, `$9$` Junos/Cisco type 9, `$8$`, scrypt `$14$`…).', /\$(?:1|2[aby]?|5|6|7|8|9|10|14|y|sha512|pbkdf2-sha256)\$[^\s"';<]+/g, 0, { gate: /\$/ }),
  R(
    'api-token',
    'Well-known API token shapes: Anthropic `sk-ant-…`, OpenAI-style `sk-…`, Google `AIza…` and `AQ.…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox?-…`, AWS access key ids `AKIA…`/`ASIA…`, JWTs.',
    /\bsk-ant-[A-Za-z0-9_-]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{35,}|\bAQ\.[A-Za-z0-9_-]{32,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    0,
    { gate: /sk-|AIza|AQ\.|gh[pousr]_|github_pat_|xox|AKIA|ASIA|eyJ/ }
  ),
  R(
    'url-userinfo',
    'Credentials in a URL: `scp://user:pw@host`, `ftp://`, `tftp://`, `sftp://`, `http(s)://`, any scheme. The user name and host stay.',
    /(\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s:@/"'<>]{0,128}:)([^\s@/"'<>]{1,256})(?=@)/gi,
    2,
    { gate: /:\/\// }
  ),
  // ---- HTTP headers and command-line flags
  R(
    'http-authorization',
    '`Authorization: Bearer|Basic|Token|Digest <value>` (header, curl -H, JSON).',
    /(\bauthorization["']?[ \t]*[:=][ \t]*["']?)(?=((?:(?:bearer|basic|token|bot|digest|negotiate)[ \t]+)?))\2(?!<redacted>)([^\s"']{1,4096})/gi,
    3,
    { gate: /authorization/i }
  ),
  R('bearer-token', 'A bare `Bearer <token>`.', /(\bbearer[ \t]+)(?!<redacted>)([A-Za-z0-9._~+/=-]{8,4096})/gi, 2, { gate: /bearer/i }),
  R('curl-user', '`curl -u user:password` / `--user user:password`: the password.', /(\bcurl\b(?:[ \t]+\S{1,512}){0,16}?[ \t]+(?:-u[ \t]*|--user[ \t=]?)["']?[^\s:"']{1,128}:)(?!<redacted>)([^\s"']{1,256})/gi, 2, {
    gate: /curl/i
  }),
  R('mysql-password-flag', '`mysql -pSECRET` (and mysqldump, mysqladmin, mariadb).', /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b(?:[ \t]+\S{1,256}){0,16}?[ \t]+-p)(?!<redacted>)([^\s-]\S{0,255})/gi, 2, {
    gate: /mysql|mariadb/i
  }),
  R('sshpass', '`sshpass -p SECRET`.', /(\bsshpass[ \t]+(?:-[a-oq-zA-Z]\S{0,64}[ \t]+){0,4}-p[ \t]*)(?!<redacted>)(\S{1,256})/gi, 2, { gate: /sshpass/i }),
  // ---- generic key=value / key: value / "key":"value"
  R(
    'key-value',
    'Generic `password=x`, `PASSWORD=x`, `secret: x`, `"password":"x"`, `aws_secret_access_key = x`, RouterOS `wpa2-pre-shared-key=x`.',
    new RegExp(String.raw`(?<![A-Za-z0-9])(${KV_KEYS}(?:[_.-][A-Za-z0-9]{1,24}){0,3}["']?[ \t]*[:=][ \t]*)(?!["']?<redacted>)(${KV_VAL})`, 'gi'),
    2,
    { gate: /[:=]/ }
  ),
  {
    id: 'routeros-snmp-community',
    description: 'RouterOS `/snmp community` section: `name=` is the community string.',
    apply: (t) => redactRouterosSnmp(t)
  },
  // ---- specific forms: the secret sits behind qualifier words
  R(
    'ios-keyring-psk',
    'IOS keyring `pre-shared-key address <ip> [<mask>] key X` / `hostname <fqdn> key X`.',
    new RegExp(String.raw`(\bpre-shared-key[ \t]+(?:address|hostname|ipv6)[ \t]+\S{1,255}(?:[ \t]+(?!key\b)\S{1,64})?[ \t]+key[ \t]+)${types(2)}${NOT_DONE}(${VAL})`, 'gi'),
    3,
    { gate: /pre-shared-key/i }
  ),
  R(
    'aaa-server-host-key',
    '`tacacs-server|radius-server host <h> [options] key [type] X` (IOS, NX-OS, EOS, AOS-CX `key plaintext`, ProCurve quoted).',
    new RegExp(String.raw`(\b(?:tacacs|radius)(?:-server)?[ \t]+host[ \t]+\S{1,255}(?:[ \t]+(?!key\b)\S{1,64}){0,12}?[ \t]+key[ \t]+)${types(2)}${NOT_DONE}(${VAL})`, 'gi'),
    3,
    { gate: /host/i }
  ),
  R(
    'procurve-password',
    'ProCurve `password manager|operator [user-name U] plaintext|sha1 X`.',
    new RegExp(String.raw`(\bpassword[ \t]+(?:manager|operator|port-access)[ \t]+(?:user-name[ \t]+\S{1,128}[ \t]+)?(?:plaintext|sha1|sha-?256)[ \t]+)${NOT_DONE}(${VAL})`, 'gi'),
    2,
    { gate: /password/i }
  ),
  R('panos-api-key', 'PAN-OS `request license api-key set key X`.', new RegExp(String.raw`(\bapi-key[ \t]+set[ \t]+key[ \t]+)${NOT_DONE}(${VAL})`, 'gi'), 2, { gate: /api-key/i }),
  R(
    'fhrp-auth',
    'HSRP / VRRP / GLBP `<n> authentication [text] X` (not `md5`, which takes key-string or key-chain).',
    new RegExp(String.raw`(\b(?:standby|vrrp|glbp)(?:[ \t]+\d{1,5})?(?:[ \t]+peer)?[ \t]+authentication[ \t]+(?:text[ \t]+)?)(?!(?:md5|key-chain|key-string|text|ah)\b)${NOT_DONE}(${VAL})`, 'gi'),
    2,
    { gate: /authentication/i }
  ),
  R(
    'auth-text',
    '`authentication text X` (RIP, VRRP, HSRP, NX-OS), `ip nhrp authentication X`.',
    new RegExp(String.raw`(\b(?:authentication[ \t]+text|nhrp[ \t]+authentication)[ \t]+)${NOT_DONE}(${VAL})`, 'gi'),
    2,
    { gate: /authentication/i }
  ),
  R(
    'ospfv3-ipsec-key',
    'OSPFv3 `authentication ipsec spi N md5|sha1 [type] KEY`.',
    new RegExp(String.raw`(\bauthentication[ \t]+ipsec[ \t]+spi[ \t]+\d{1,10}[ \t]+(?:md5|sha1)[ \t]+(?:\d[ \t]+)?)${NOT_DONE}(${VAL})`, 'gi'),
    2,
    { gate: /ipsec/i }
  ),
  R(
    'fortios-set-key',
    'FortiOS `set key X`, `set md5-keys N X`, `set <x>-pwd X`, `set secret X` at the start of a line.',
    new RegExp(String.raw`^([ \t]*set[ \t]+(?:key|secret|md5-keys?|[\w-]{1,32}-pwd|server-key)[ \t]+)${types(2)}${NOT_DONE}(${VAL})`, 'gim'),
    3,
    { gate: /set/i }
  ),
  R(
    'aireos-mgmtuser',
    'AireOS `config mgmtuser|netuser add <user> <password> …` and `config mgmtuser password <user> <password>`.',
    /(\bconfig[ \t]+(?:mgmtuser|netuser)[ \t]+(?:add|password)[ \t]+\S{1,128}[ \t]+)(?!<redacted>)(\S{1,256})/gi,
    2,
    { gate: /config/i }
  ),
  R('aireos-snmp-community', 'AireOS `config snmp community create|delete X`.', /(\bconfig[ \t]+snmp[ \t]+community[ \t]+(?:create|delete)[ \t]+)(?!<redacted>)(\S{1,256})/gi, 2, { gate: /snmp/i }),
  R(
    'aireos-snmp-v3user',
    'AireOS `config snmp v3user create <u> <ro|rw> <auth> <priv> AUTHKEY PRIVKEY`.',
    /(\bconfig[ \t]+snmp[ \t]+v3user[ \t]+create[ \t]+\S{1,128}[ \t]+\S{1,16}[ \t]+\S{1,16}[ \t]+\S{1,16}[ \t]+)(?!<redacted>)(\S{1,256})(?:([ \t]+)(?!<redacted>)(\S{1,256}))?/gi,
    [2, 4],
    { gate: /v3user/i }
  ),
  R(
    'aireos-radius',
    'AireOS `config radius|tacacs auth|acct add <idx> <ip> <port> ascii|hex <secret>`.',
    /(\bconfig\s+(?:radius|tacacs)\s+(?:auth|acct|athr)\s+add\s+\d+\s+\S+\s+\d+\s+(?:ascii|hex)\s+)(?!<redacted>)(\S+)/gi,
    2,
    { gate: /config/i }
  ),
  // ---- the generic keyword rule
  R(
    'keyword-secret',
    'A secret-bearing keyword (`SECRET_KEYWORDS`), optional type tokens, then the value. Refuses qualifier words and `=`/`:` as the value.',
    new RegExp(String.raw`(?<!\bconfig[ \t]+(?:mgmtuser|netuser)[ \t]+)(\b(?:${SECRET_KEYWORDS.join('|')})[ \t]+)` + types(2) + QUAL + NOT_DONE + `(${VAL})`, 'gi'),
    3
  ),
  R(
    'server-key-line',
    'TACACS/RADIUS `key <value>` lines inside server blocks (`  key 7 0822455D0A16`); not `key 1` under a key chain (a key id).',
    new RegExp(String.raw`^([ \t]*key[ \t]+)${types(2)}(?!chain\b|config-key\b|\d+(?:[ \t]|$))${NOT_DONE}(${VAL})`, 'gim'),
    3,
    { gate: /key/i }
  ),
  // ---- SNMP
  R('snmp-community', 'IOS / NX-OS / EOS `snmp-server community X`.', new RegExp(String.raw`(\bsnmp-server[ \t]+community[ \t]+)${NOT_DONE}(${VAL})`, 'gi'), 2, { gate: /snmp/i }),
  R(
    'snmp-host-community',
    '`snmp-server host <ip> [traps|informs] [vrf x] [version 1|2c|3 auth|noauth|priv] <community-or-user>`; ASA `snmp-server host <if> <ip> [community] X`.',
    /(\bsnmp-server[ \t]+host[ \t]+\S{1,255}[ \t]+)(?=((?:\d{1,3}(?:\.\d{1,3}){3}[ \t]+)?(?:(?:traps|informs|vrf[ \t]+\S{1,64}|use-vrf[ \t]+\S{1,64}|filter-vrf[ \t]+\S{1,64})[ \t]+){0,3}(?:version[ \t]+(?:1|2c|3(?:[ \t]+(?:auth|noauth|priv))?)[ \t]+)?(?:community[ \t]+)?))\2(?!<redacted>|version\b|traps\b|informs\b|vrf\b|use-vrf\b|filter-vrf\b|auth\b|noauth\b|priv\b|community\b|poll\b|udp-port\b)(\S{1,4096})/gi,
    3,
    { gate: /snmp/i }
  ),
  R(
    'vrp-snmp-community',
    'Huawei `snmp-agent community read|write [cipher|simple] <community>`.',
    /(\bsnmp-agent\s+community\s+(?:read|write)\s+)(?=((?:(?:cipher|simple)\s+)?))\2(?!<redacted>)(\S+)/gi,
    3,
    { gate: /snmp-agent/i }
  ),
  R(
    'snmp-community-set',
    'Junos `set snmp community X`, VyOS `set service snmp community \'X\'`.',
    new RegExp(String.raw`(\b(?:set[ \t]+(?:service[ \t]+)?)snmp[ \t]+community[ \t]+)${NOT_DONE}(${VAL})`, 'gi'),
    2,
    { gate: /snmp/i }
  ),
  R('junos-snmp-community', 'Junos hierarchical `community X {`.', /^(\s*(?:set\s+snmp\s+)?community\s+)("?)(?!<redacted>)([^\s;{"]+)\2/gm, 3, { gate: /community/i }),
  R(
    'snmpv3-auth',
    'SNMPv3 `auth|priv md5|sha|aes|des X` (IOS, NX-OS, EOS).',
    /(\b(?:auth|priv)\s+(?:md5|sha-?\d*|aes(?:-?\s*\d+)?|des|3des)\s+)(?!<redacted>|\d+\s)(\S+)/gi,
    2,
    { gate: /auth|priv/i }
  ),
  R(
    'snmpv3-priv-bare',
    'NX-OS `snmp-server user u auth md5 X priv [aes-128] Y`: priv without an algorithm.',
    /(\bauth\s+(?:md5|sha\S*)\s+\S+\s+priv\s+(?:aes-128\s+)?)(?!<redacted>|(?:aes|des|3des)[\w-]*(?:\s|$))(\S+)/gi,
    2,
    { gate: /priv/i }
  )
]

/** Apply one regex rule: only the secret span(s) of each match change. */
function applyRegex(text: string, rule: RedactRule): RedactResult {
  const re = rule.re!
  const groups = typeof rule.secret === 'number' ? [rule.secret] : (rule.secret ?? [0])
  const rep = rule.replacement ?? REDACTED
  re.lastIndex = 0
  let out = ''
  let last = 0
  let count = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    for (const g of groups) {
      const span = m.indices?.[g]
      if (!span || span[1] <= span[0] || span[0] < last) continue
      const value = m[g]!
      if (value === rep) continue
      if (value.includes(REDACTED) && (value.trim() === REDACTED || value.replace(/^["']|["']$/g, '') === REDACTED)) continue
      out += text.slice(last, span[0]) + rep
      last = span[1]
      count++
    }
  }
  return count ? { text: out + text.slice(last), count } : { text, count: 0 }
}

export function redact(input: string): RedactResult {
  let count = 0
  let text = input
  let missingGate: RegExp | undefined
  for (const rule of REDACT_RULES) {
    // Consecutive rules with a shared gate can reuse a miss until another rule runs.
    if (rule.gate && (rule.gate === missingGate || !rule.gate.test(text))) {
      missingGate = rule.gate
      continue
    }
    missingGate = undefined
    const r = rule.apply ? rule.apply(text) : applyRegex(text, rule)
    text = r.text
    count += r.count
  }
  return { text, count }
}

/** The line after a key body: a PEM END line, or a PuTTY .ppk `Private-MAC:` line. */
const END_LINE = /^[ \t]*(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|Private-MAC:)/
/** A PEM body line (base64) or a PEM header (`Proc-Type: 4,ENCRYPTED`, `DEK-Info: …`). */
const BODY_LINE = /^[ \t]*(?:[A-Za-z0-9+/=]+|[A-Za-z-]+: \S[^\n]*)[ \t"]*\r?$/

/**
 * An END line (or a .ppk `Private-MAC:` line) with no BEGIN before it: the text was cut inside a key (a tail kept by a slice). The
 * run of body lines right before the END line is redacted, back to where the run starts. Linear:
 * each line is looked at once going forward and at most once going back.
 */
function redactHeadless(input: string): RedactResult {
  if (!(input.includes('-----END ') && input.includes('PRIVATE KEY-----')) && !input.includes('Private-MAC:')) return { text: input, count: 0 }
  const lines = input.split('\n')
  let count = 0
  let floor = 0
  for (let i = 0; i < lines.length; i++) {
    if (!END_LINE.test(lines[i]!)) continue
    let j = i
    while (j > floor && BODY_LINE.test(lines[j - 1]!)) j--
    if (j < i) {
      lines.splice(j, i - j, REDACTED)
      count++
      i = j + 1
    }
    floor = i + 1
  }
  return { text: lines.join('\n'), count }
}

const ROS_SECTION = /^[ \t]*\//
const ROS_SNMP = /^[ \t]*\/snmp[ \t]+community\b/i
const ROS_NAME = /(\bname=)(?!["']?<redacted>)("[^"\n]{0,4096}"|[^\s"]{1,4096})/gi

/**
 * RouterOS export: a `/snmp community` section header, then `set|add … name=X` lines; the name is
 * the community string. A line starting with `/` opens a new section. Linear, one pass over lines.
 */
function redactRouterosSnmp(input: string): RedactResult {
  if (!/\/snmp[ \t]+community/i.test(input)) return { text: input, count: 0 }
  const lines = input.split('\n')
  let count = 0
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (ROS_SECTION.test(line)) inSection = ROS_SNMP.test(line)
    if (!inSection) continue
    lines[i] = line.replace(ROS_NAME, (_m, k: string) => {
      count++
      return k + REDACTED
    })
  }
  return { text: count ? lines.join('\n') : input, count }
}
