/**
 * Simulator CLI.
 *
 *   node src/cli.ts                         core-sw1 (IOS) on 2201/2301 and dist-eos1 (EOS) on 2202/2302
 *   node src/cli.ts --device junos,nxos     those lab devices on sequential ports from --base (2201)
 *   node src/cli.ts --scenario bgp-wrong-as apply scenario(s) to every started device
 *   node src/cli.ts topology [--base 2220]  the whole topology lab, with a port table
 *   node src/cli.ts list                    platforms and scenarios
 *
 * Environment: SIM_HOST (default 127.0.0.1); SIM_IOS_PORT / SIM_IOS_TELNET_PORT / SIM_EOS_PORT /
 * SIM_EOS_TELNET_PORT keep working for the default pair.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSim } from './server.ts'
import { startTelnetSim } from './telnet-server.ts'
import { makeDevice, platforms } from './devices/index.ts'
import { applyScenario, SCENARIOS } from './scenarios/index.ts'
import { buildLab, labPorts, portTable } from './topology.ts'
import type { Device, SimPlatform } from './state.ts'

const here = dirname(fileURLToPath(import.meta.url))
const hostKeyPath = join(here, '..', 'host_key')
const host = process.env['SIM_HOST'] ?? '127.0.0.1'
const log = (m: string): void => console.log(`[sim] ${m}`)

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const k = args.indexOf(`--${name}`)
  if (k >= 0) return args[k + 1]
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  return eq?.slice(name.length + 3)
}
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : undefined
const scenario = flag('scenario')

async function serve(device: Device, port: number, telnetPort: number): Promise<void> {
  if (scenario) applyScenario(device, scenario)
  await startSim({ device, port, host, hostKeyPath, log })
  await startTelnetSim({ device, port: telnetPort, host, log })
}

if (cmd === 'list') {
  console.log(`platforms: ${platforms().join(', ')}`)
  console.log('scenarios:')
  for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(20)}${s.title}`)
  process.exit(0)
} else if (cmd === 'topology') {
  const base = Number(flag('base') ?? 2220)
  const lab = buildLab()
  const ports = labPorts(lab, base)
  for (const p of ports) await serve(lab.device(p.name), p.ssh, p.telnet)
  console.log(portTable(ports, host))
  console.log('[sim] password: admin; telnet uses admin / admin. Ctrl-C to stop')
} else if (flag('device')) {
  const base = Number(flag('base') ?? 2201)
  const list = flag('device')!.split(',').map((s) => s.trim()) as SimPlatform[]
  for (const p of list) if (!platforms().includes(p)) throw new Error(`unknown platform ${p} (known: ${platforms().join(', ')})`)
  const rows = list.map((p, k) => ({ device: makeDevice(p), ssh: base + k, telnet: base + 100 + k }))
  for (const r of rows) await serve(r.device, r.ssh, r.telnet)
  console.log(portTable(rows.map((r) => ({ name: r.device.hostname, platform: r.device.platform, role: r.device.model, ssh: r.ssh, telnet: r.telnet })), host))
  console.log('[sim] Ctrl-C to stop')
} else {
  // Each device answers on SSH and Telnet with one shared state, so a change made over one shows on the other.
  const devices = [
    { device: makeDevice('ios'), port: Number(process.env['SIM_IOS_PORT'] ?? 2201), telnetPort: Number(process.env['SIM_IOS_TELNET_PORT'] ?? 2301) },
    { device: makeDevice('eos'), port: Number(process.env['SIM_EOS_PORT'] ?? 2202), telnetPort: Number(process.env['SIM_EOS_TELNET_PORT'] ?? 2302) }
  ]
  for (const { device, port, telnetPort } of devices) {
    await serve(device, port, telnetPort)
    const name = `${device.hostname.padEnd(10)} ${device.platform.toUpperCase().padEnd(4)}`
    console.log(`[sim] ${name} ssh admin@${host} -p ${port}   (password: admin)`)
    console.log(`[sim] ${name} telnet ${host} ${telnetPort}   (admin / admin)`)
  }
  console.log('[sim] Ctrl-C to stop')
}
