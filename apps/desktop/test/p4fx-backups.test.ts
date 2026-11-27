import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { bindingHostname, configHostnames, sameHost, unbindablePrompt } from '@shared/cli'
import { AuditLog } from '../src/main/db/audit'
import { openDb } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { BackupService, deviceIdentity } from '../src/main/backups/service'
import { BackupStore } from '../src/main/backups/store'
import { backupHandlers } from '../src/main/ipc/backups'
import { DataKey } from '../src/main/vault/datakey'
import type { AgentTab } from '../src/main/host/client'

/** Phase 4 fix-round review, backups (B1–B8, A2 backups:remove). */

const key = () => {
  let sealed: Buffer | null = null
  return new DataKey({ load: () => sealed, save: (b) => void (sealed = b), seal: async (p) => Buffer.from(p), unseal: async (b) => Buffer.from(b) })
}

function rig(platform: Session['platform'], protocol: Session['protocol'] = 'ssh') {
  const db = openDb(':memory:')
  const repo = new Repo(db)
  const audit = new AuditLog(db)
  const store = new BackupStore(db, key(), Date.now, audit)
  const s = repo.saveSession({ name: 'dev', folderId: null, host: '10.0.0.1', port: 22, protocol, platform, username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} } as never)
  return { db, repo, audit, store, s }
}

const settings = () => ({ commandTimeoutMs: 10_000, outputCapBytes: 512 * 1024 })

/**
 * A device reached on one tab (and, if `bg`, over a background connection): `state.shown` is the
 * prompt hostname the executor reports it ran at, `state.config` what the backup command prints.
 */
function device(r: ReturnType<typeof rig>, state: { shown: string; config: string; bgShown?: string; bgConfig?: string }, opts: { tab?: boolean; bg?: boolean } = { tab: true }) {
  const tab = { tabId: 'tab-1', session: r.s } as unknown as AgentTab
  const bgTab = { tabId: 'bg-1', session: r.s } as unknown as AgentTab
  const used: string[] = []
  const svc = new BackupService({
    host: {
      exec: async (t) => {
        used.push(t.tabId)
        const bg = t.tabId === 'bg-1'
        const out = bg ? (state.bgConfig ?? state.config) : state.config
        return { status: 'ok', output: out, durationMs: 1, bytes: out.length, hostname: bg ? (state.bgShown ?? state.shown) : state.shown }
      },
      // B7: never asked; the hostname comes with the exec result.
      prompt: async () => {
        throw new Error('prompt() must not be called when exec reports the hostname')
      },
      tabsOf: () => (opts.tab ? [tab] : []),
      ...(opts.bg ? { openBackground: async () => bgTab, close: () => {} } : {})
    },
    repo: r.repo,
    audit: r.audit,
    settings,
    store: r.store
  })
  return { svc, used }
}

const ASA = (h: string) => `: Saved\n:\nASA Version 9.18\n!\nhostname ${h}\nenable password ***** encrypted\n!\ninterface Gi0/0\n nameif outside\n!\n: end`
const PANOS = (h: string) => `config {\n  devices {\n    localhost.localdomain {\n      deviceconfig {\n        system {\n          hostname ${h};\n          ip-address 10.0.0.1;\n        }\n      }\n    }\n  }\n}`
const PANOS_XML = (h: string) => `<config version="10.2.0">\n  <devices>\n    <entry name="localhost.localdomain">\n      <deviceconfig>\n        <system>\n          <hostname>${h}</hostname>\n        </system>\n      </deviceconfig>\n    </entry>\n  </devices>\n</config>`
const AIREOS = (h: string) => `config sysname ${h}\nconfig country US\nconfig network telnet disable\nconfig wlan create 1 corp corp`
const SRX = (a: string, b: string) => `set version 21.4R3\nset groups node0 system host-name ${a}\nset groups node1 system host-name ${b}\nset apply-groups "\${node}"\nset system root-authentication encrypted-password "$6$x"`
const VRP = (h: string) => `#\nsysname ${h}\n#\ninterface GigabitEthernet0/0/1\n description up\n#\nreturn`
const FTD = (h: string) => `: Saved\nNGFW Version 7.2\n!\nhostname ${h}\n!\ninterface Gi0/0\n!\n: end`

describe('B1: ASA failover keeps the backup binding', () => {
  it('bindingHostname keeps the text before the first "/" on ASA only', () => {
    expect(bindingHostname('asa', 'fw/pri/act')).toBe('fw')
    expect(bindingHostname('asa', 'fw/sec/act')).toBe('fw')
    expect(bindingHostname('iosxe', 'a/b')).toBe('a/b')
    // The disruptive confirmation is unchanged: it still compares the whole prompt hostname.
    expect(sameHost('fw/pri/act', 'fw/sec/act')).toBe(false)
  })
  it('a failover (fw/pri/act → fw/sec/act) is the same device on the tab path', async () => {
    const r = rig('asa')
    const st = { shown: 'fw/pri/act', config: ASA('fw') }
    const { svc } = device(r, st)
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
    expect(r.store.lastHostname(r.s.id)).toBe('fw')
    st.shown = 'fw/sec/act'
    st.config = ASA('fw') + '\n!'
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
  })
  it('a version stored before the fix with the whole prompt (fw/pri/act) still binds after failover', async () => {
    const r = rig('asa')
    await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'asa', text: ASA('fw'), trigger: 'manual', command: 'show running-config', hostname: 'fw/pri/act' })
    const { svc } = device(r, { shown: 'fw/sec/act', config: ASA('fw') + '\n!' })
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
  })
  it('another ASA (vpn/pri/act) is still refused', async () => {
    const r = rig('asa')
    await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'asa', text: ASA('fw'), trigger: 'manual', command: 'show running-config', hostname: 'fw' })
    const { svc } = device(r, { shown: 'vpn/pri/act', config: ASA('vpn') })
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'skipped', renamed: { from: 'fw', to: 'vpn' } })
  })
})

describe('B2: renames are parsed on PAN-OS, AireOS and SRX', () => {
  it('configHostnames reads every form without trailing punctuation', () => {
    expect(configHostnames(PANOS('PA-VM'))).toEqual(['PA-VM'])
    expect(configHostnames(PANOS_XML('PA-VM'))).toEqual(['PA-VM'])
    expect(configHostnames(AIREOS('wlc-2'))).toEqual(['wlc-2'])
    expect(configHostnames(SRX('srx-a', 'srx-b'))).toEqual(['srx-a', 'srx-b'])
    expect(configHostnames('system {\n    host-name edge1;\n}')).toEqual(['edge1'])
    expect(configHostnames('set system host-name "edge 1"')).toEqual([])
  })
  it('PAN-OS (brace and XML): a background rename the config shows is accepted', async () => {
    for (const cfg of [PANOS, PANOS_XML]) {
      const r = rig('panos')
      await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'panos', text: cfg('PA-OLD'), trigger: 'manual', command: 'show config running', hostname: 'PA-OLD' })
      const { svc } = device(r, { shown: 'PA-VM', config: cfg('PA-VM') }, { bg: true })
      expect((await svc.take([r.s.id], 'scheduled'))[0]).toMatchObject({ outcome: 'saved' })
      expect(r.store.lastHostname(r.s.id)).toBe('PA-VM')
    }
  })
  it('AireOS `config sysname` rename over a background connection is accepted', async () => {
    const r = rig('aireos')
    await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'aireos', text: AIREOS('wlc-1'), trigger: 'manual', command: 'show run-config commands', hostname: 'wlc-1' })
    const { svc } = device(r, { shown: 'wlc-2', config: AIREOS('wlc-2') }, { bg: true })
    expect((await svc.take([r.s.id], 'scheduled'))[0]).toMatchObject({ outcome: 'saved' })
  })
  it('SRX chassis cluster: node1 after a failover is the same device, also on a tab', async () => {
    const r = rig('junos')
    await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'junos', text: SRX('srx-a', 'srx-b'), trigger: 'manual', command: 'show configuration | display set', hostname: 'srx-a' })
    const { svc } = device(r, { shown: 'srx-b', config: SRX('srx-a', 'srx-b') + '\nset system ntp server 10.0.0.9' })
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
  })
})

describe('B3: an explicit, audited "device renamed: accept <new>"', () => {
  it('a Telnet session (no background connection) recovers from a rename only by the user accepting it', async () => {
    const r = rig('iosxe', 'telnet')
    await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'iosxe', text: 'hostname old\n!\ninterface Gi1\nend', trigger: 'manual', command: 'show running-config', hostname: 'old' })
    const st = { shown: 'new', config: 'hostname new\n!\ninterface Gi1\nend' }
    const { svc } = device(r, st)
    const [refused] = await svc.take([r.s.id])
    expect(refused).toMatchObject({ outcome: 'skipped', renamed: { from: 'old', to: 'new' } })
    // Accepting a name the device does not show changes nothing.
    expect(await svc.acceptRename(r.s.id, 'other')).toMatchObject({ outcome: 'skipped' })
    expect(r.audit.list(50).filter((a) => a.kind === 'binding')).toHaveLength(0)
    const ok = await svc.acceptRename(r.s.id, 'NEW')
    expect(ok).toMatchObject({ outcome: 'saved' })
    expect(r.store.lastHostname(r.s.id)).toBe('new')
    const row = r.audit.list(50).find((a) => a.kind === 'binding')!
    expect(row).toMatchObject({ source: 'backup', decision: 'executed', command: 'device renamed: accept new', approver: expect.any(String) })
    expect(row.reason).toMatch(/from "old" to "new"/)
    // Later backups are bound to the new name.
    st.config += '\n!'
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
  })
  it('the IPC channel takes a session and a non-empty hostname, and passes the asking window', async () => {
    let got: unknown[] = []
    const h = backupHandlers({ service: { acceptRename: async (...a: unknown[]) => ((got = a), { sessionId: 's', sessionName: 'x', outcome: 'saved' }) } as never, store: {} as never, saveFile: async () => null, confirm: async () => false })
    const sender = {}
    await h['backups:acceptRename']!.fn(h['backups:acceptRename']!.schema.parse({ sessionId: 's1', hostname: ' new ' }) as never, { sender } as never)
    expect(got).toEqual(['s1', 'new', sender])
    expect(() => h['backups:acceptRename']!.schema.parse({ sessionId: 's1', hostname: '  ' })).toThrow()
    expect(() => h['backups:acceptRename']!.schema.parse({ sessionId: 's1', hostname: 'x', from: 'y' })).toThrow()
  })
})

describe('B7: the binding uses the hostname exec ran at', () => {
  it('a hop between a prompt check and the command cannot slip through: prompt() is never consulted', async () => {
    const r = rig('iosxe')
    await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'iosxe', text: 'hostname core\n!\nx\nend', trigger: 'manual', command: 'show running-config', hostname: 'core' })
    // The fake's prompt() throws: the service must use exec's own hostname, which shows the hop.
    const { svc } = device(r, { shown: 'other', config: 'hostname core\n!\nx\nend' })
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/prompt shows "other"/) })
  })
})

describe('B8: prompts that cannot bind use the hostname the configuration sets', () => {
  it('unbindablePrompt: empty (FTD) and factory names (VRP HUAWEI, AireOS Cisco Controller)', () => {
    expect(unbindablePrompt('ftd', '')).toBe(true)
    expect(unbindablePrompt('vrp', 'HUAWEI')).toBe(true)
    expect(unbindablePrompt('aireos', 'Cisco Controller')).toBe(true)
    expect(unbindablePrompt('vrp', 'agg-1')).toBe(false)
    expect(deviceIdentity('ftd', '', FTD('ftd-1'))).toBe('ftd-1')
    expect(deviceIdentity('vrp', 'HUAWEI', VRP('agg-1'))).toBe('agg-1')
    expect(deviceIdentity('aireos', 'Cisco Controller', AIREOS('wlc-1'))).toBe('wlc-1')
  })
  it('FTD: bound to the configured hostname; another FTD (same empty prompt) is refused on the tab', async () => {
    const r = rig('ftd')
    const st = { shown: '', config: FTD('ftd-1') }
    const { svc } = device(r, st)
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
    expect(r.store.lastHostname(r.s.id)).toBe('ftd-1')
    st.config = FTD('ftd-2')
    expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'skipped', renamed: { from: 'ftd-1', to: 'ftd-2' } })
  })
  it('VRP and AireOS with factory prompts: bound to sysname, a hop to another default-prompt device is refused', async () => {
    for (const [platform, shown, cfg] of [
      ['vrp', 'HUAWEI', VRP],
      ['aireos', 'Cisco Controller', AIREOS]
    ] as const) {
      const r = rig(platform)
      const st = { shown, config: cfg('site-a') }
      const { svc } = device(r, st)
      expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'saved' })
      expect(r.store.lastHostname(r.s.id)).toBe('site-a')
      st.config = cfg('site-b')
      expect((await svc.take([r.s.id]))[0]).toMatchObject({ outcome: 'skipped' })
    }
  })
})

describe('A2: backups:remove is audited', () => {
  it('deleting a version writes an audit row with the user as approver', async () => {
    const r = rig('iosxe')
    const { version } = await r.store.add({ sessionId: r.s.id, sessionName: 'dev', platform: 'iosxe', text: 'hostname a\n!\nx\nend', trigger: 'manual', command: 'show running-config', hostname: 'a' })
    const h = backupHandlers({ service: {} as never, store: r.store, audit: r.audit, saveFile: async () => null, confirm: async () => false })
    await h['backups:remove']!.fn(version.id as never, { sender: {} } as never)
    expect(r.store.list(r.s.id)).toHaveLength(0)
    expect(r.audit.list(10).find((a) => a.kind === 'delete')).toMatchObject({ source: 'backup', decision: 'executed', command: `delete config version ${version.id.slice(0, 8)}`, approver: expect.any(String) })
  })
})
