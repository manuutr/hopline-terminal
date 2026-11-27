/**
 * A simulator that offers ONLY legacy algorithms. It must run under plain Node: Electron's
 * BoringSSL can't generate or sign with DSA keys, and it can't do the server half of group1.
 *
 * Usage: node packages/transports/scripts/legacy-sim.ts [both|kex|hostkey]
 *   both     diffie-hellman-group1-sha1 + ssh-dss (default)
 *   kex      diffie-hellman-group1-sha1 + ssh-ed25519 host key
 *   hostkey  diffie-hellman-group14-sha1 + ssh-dss host key
 * All modes use aes128-cbc/3des-cbc + hmac-sha1. Prints one JSON line `{"port": N}` once listening
 * and exits when stdin closes.
 */
import { generateEd25519, makeIosDevice, startSim } from '../../simulator/src/index.ts'
import { generateDsaHostKey } from '../test/fixtures/dsa.ts'

const mode = process.argv[2] ?? 'both'
const dss = mode !== 'kex'
const group1 = mode !== 'hostkey'

const sim = await startSim({
  device: makeIosDevice(),
  port: 0,
  hostKey: dss ? generateDsaHostKey() : generateEd25519().private,
  algorithms: {
    kex: [group1 ? 'diffie-hellman-group1-sha1' : 'diffie-hellman-group14-sha1'],
    serverHostKey: [dss ? 'ssh-dss' : 'ssh-ed25519'],
    cipher: ['aes128-cbc', '3des-cbc'],
    hmac: ['hmac-sha1']
  }
})
process.stdout.write(JSON.stringify({ port: sim.port, mode, node: process.versions.node }) + '\n')
process.stdin.resume()
process.stdin.on('end', () => void sim.close().then(() => process.exit(0)))
