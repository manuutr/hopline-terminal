/**
 * AI and parsing hot paths, in Node (no Electron): redaction and cleanTerminalText on 1 MB inputs,
 * TextFSM parse times on simulator output, and guard classification per command.
 */
import { test } from '@playwright/test'
import { classify, redact } from '../../packages/guard/src/index.ts'
import { parseOutput } from '../../packages/parsers/src/index.ts'
import { floodLine, makeDevice, Shell } from '../../packages/simulator/src/index.ts'
import { cleanTerminalText } from '../../apps/desktop/src/shared/cli.ts'
import { record } from '../lib'

/**
 * Best wall time of `fn` over `n` runs after `warm` warm-up runs. The minimum, not the median: on a
 * shared machine the noise only ever adds time, so the fastest run is the stable estimate.
 */
function time(fn: () => unknown, n = 15, warm = 3): number {
  for (let i = 0; i < warm; i++) fn()
  const xs: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    xs.push(performance.now() - t0)
  }
  return Math.min(...xs)
}

/** Output of `cmd` on a simulated device (no pager). */
async function sim(platform: string, cmd: string): Promise<string> {
  const d = makeDevice(platform as never)
  let out = ''
  const sh = new Shell(d, { write: (s) => (out += s), close: () => {} }, 0, {})
  sh.pageLength = 0
  sh.start()
  out = ''
  sh.input(cmd + '\r')
  await sh.idle()
  await new Promise((r) => setTimeout(r, 5))
  sh.detach()
  // Drop the echoed command line and the trailing prompt, like a block's output.
  return out.replace(/\r\n/g, '\n').split('\n').slice(1, -1).join('\n')
}

const MB = 1024 * 1024

test('redaction and cleanTerminalText on 1 MB', () => {
  const secrets = [
    'enable secret 9 $9$abcdefghijklmn$opqrstuvwxyz0123456789ABCDEFGHIJ',
    ' password 7 0822455D0A16544541',
    'snmp-server community s3cr3t-RO RO',
    'username netops privilege 15 secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0',
    ' key-string 7 104D000A0618',
    'tacacs-server key 7 060506324F41',
    'crypto isakmp key MyPreSharedKey address 10.0.0.1'
  ]
  let cfg = ''
  for (let i = 0; cfg.length < MB; i++) cfg += `interface GigabitEthernet1/0/${i % 48}\n description uplink ${i}\n ip address 10.${(i >> 8) & 255}.${i & 255}.1 255.255.255.0\n${secrets[i % secrets.length]}\n!\n`
  const ms = time(() => redact(cfg))
  record({ id: 'hot.redact_1mb_ms', value: ms, unit: 'ms', better: 'lower' })
  let ansi = ''
  for (let i = 0; ansi.length < MB; i++) ansi += floodLine('ansi', i) + (i % 50 === 0 ? 'abc\b\b\bxyz' : '')
  record({ id: 'hot.clean_terminal_text_1mb_ms', value: time(() => cleanTerminalText(ansi)), unit: 'ms', better: 'lower' })
  let plain = ''
  for (let i = 0; plain.length < MB; i++) plain += floodLine('plain', i)
  record({ id: 'hot.clean_terminal_text_plain_1mb_ms', value: time(() => cleanTerminalText(plain)), unit: 'ms', better: 'lower' })
})

test('TextFSM parse times', async () => {
  const cases: [string, string][] = [
    ['ios', 'show version'],
    ['ios', 'show ip interface brief'],
    ['ios', 'show interfaces'],
    ['ios', 'show ip route'],
    ['ios', 'show running-config'],
    ['eos', 'show interfaces status']
  ]
  for (const [p, cmd] of cases) {
    const text = await sim(p, cmd)
    const c0 = performance.now()
    const r = parseOutput(p, cmd, text)
    const cold = performance.now() - c0
    const id = `${p}_${cmd.replace(/\s+/g, '_')}`
    if (!r) {
      record({ id: `hot.textfsm.${id}_ms`, value: -1, unit: 'ms', better: 'lower', note: 'no template', info: true })
      continue
    }
    record({ id: `hot.textfsm.${id}_ms`, value: time(() => parseOutput(p, cmd, text), 15, 3), unit: 'ms', better: 'lower', note: `${text.length} chars, ${r.rows.length} rows` })
    record({ id: `hot.textfsm.${id}_cold_ms`, value: cold, unit: 'ms', better: 'lower', note: 'first parse: template compile included', info: true })
  }
  // A big table: 4,000 interfaces of `show ip interface brief`.
  const big = ['Interface                  IP-Address      OK? Method Status                Protocol']
  for (let i = 0; i < 4000; i++) big.push(`${`GigabitEthernet${i >> 6}/0/${i % 64}`.padEnd(27)}10.${(i >> 8) & 255}.${i & 255}.1${' '.repeat(6)}YES manual up                    up      `)
  const bigText = big.join('\n')
  record({ id: 'hot.textfsm.ios_show_ip_int_brief_4000_ms', value: time(() => parseOutput('ios', 'show ip interface brief', bigText), 7, 2), unit: 'ms', better: 'lower', note: `${bigText.length} chars` })
})

test('guard classify per command', () => {
  const cmds = [
    'show ip interface brief',
    'sh ip int br',
    'show running-config | include hostname',
    'show interfaces GigabitEthernet1/0/1',
    'show ip bgp summary',
    'show logging | begin %LINK',
    'configure terminal',
    'interface GigabitEthernet1/0/2',
    'clear ip bgp *',
    'reload',
    'write erase',
    'ping 10.0.0.1 repeat 5',
    'show version',
    'show mac address-table dynamic',
    'copy running-config startup-config'
  ]
  const n = 200
  const run = () => {
    for (let k = 0; k < n; k++) for (const c of cmds) classify(c, 'ios')
  }
  const ms = time(run, 15, 2)
  record({ id: 'hot.guard_classify_us_per_cmd', value: (ms * 1000) / (n * cmds.length), unit: 'µs', better: 'lower', note: `${cmds.length} commands × ${n}` })
  const eos = () => {
    for (let k = 0; k < n; k++) for (const c of cmds) classify(c, 'eos')
  }
  record({ id: 'hot.guard_classify_eos_us_per_cmd', value: (time(eos, 15, 2) * 1000) / (n * cmds.length), unit: 'µs', better: 'lower' })
})
