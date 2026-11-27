import type { Session } from '@shared/types'
import { LAB_NOTE } from './index'
import type { Repo } from './repo'

const oldDefaults: Record<string, number> = { 'core-sw1': 2201, 'dist-eos1': 2202, 'core-sw1 (telnet)': 2301 }
const platforms: Record<string, string> = { 'core-sw1': 'iosxe', 'dist-eos1': 'eos', 'core-sw1 (telnet)': 'iosxe', 'fgt-edge1': 'fortios', fw1: 'panos' }
const vpnNote = 'VPN lab. Investigate why 10.100.0.10 cannot reach 10.20.0.50 across the site tunnel. Password: admin.'

function generatedSession(s: Session, manifest: { folderId?: string; sessions?: Record<string, string> } | null) {
  const vpn = s.platform === 'fortios' || s.platform === 'panos'
  const knownId = manifest?.folderId === s.folderId && manifest?.sessions?.[s.name] === s.id
  return (knownId || oldDefaults[s.name] === s.port) &&
    platforms[s.name] === s.platform && s.protocol === (s.name === 'core-sw1 (telnet)' ? 'telnet' : 'ssh') &&
    s.host === '127.0.0.1' && s.username === 'admin' && s.notes === (vpn ? vpnNote : LAB_NOTE) &&
    !s.favorite && !s.color && !s.logToFile && !Object.keys(s.options).length &&
    (vpn ? s.tags.length === 1 && s.tags[0] === 'vpn-lab' : !s.tags.length)
}

/** Hide generated inventory from older installations without modifying the user's database or exports. */
export function releaseInventory(repo: Pick<Repo, 'listSessions' | 'listFolders' | 'listCredentials' | 'getSetting'>) {
  const sessions = repo.listSessions()
  const folders = repo.listFolders()
  const labFolders = new Set(folders.filter((f) => f.parentId === null && f.name === 'Lab (simulator)').map((f) => f.id))
  const hiddenCredentials = new Set<string>()
  if (!labFolders.size) return { sessions, folders, hiddenCredentials }
  let manifest = null
  try { manifest = JSON.parse(repo.getSetting('ux.lab') ?? 'null') } catch { /* Older profiles have no manifest. */ }
  const generatedLogins = new Set(repo.listCredentials().filter((c) => c.name === 'Simulator admin' && c.username === 'admin' && c.kind === 'password').map((c) => c.id))
  const hiddenFolders = new Set<string>()
  const visible = sessions.filter((s) => {
    if (!s.folderId || !labFolders.has(s.folderId) || !generatedSession(s, manifest) || (s.credentialId && !generatedLogins.has(s.credentialId))) return true
    hiddenFolders.add(s.folderId)
    if (s.credentialId) hiddenCredentials.add(s.credentialId)
    return false
  })
  for (const s of visible) {
    if (s.folderId) hiddenFolders.delete(s.folderId)
    if (s.credentialId) hiddenCredentials.delete(s.credentialId)
  }
  for (const f of folders) if (f.parentId) hiddenFolders.delete(f.parentId)
  return { sessions: visible, folders: folders.filter((f) => !hiddenFolders.has(f.id)), hiddenCredentials }
}

/** Use the same inventory for saved-session lookups, folder targets and assistant suggestions. */
export function visibleDevices(repo: Repo, development: boolean) {
  const inventory = () => development
    ? { sessions: repo.listSessions(), folders: repo.listFolders() }
    : releaseInventory(repo)
  return {
    inventory,
    listSessions: () => development ? repo.listSessions() : inventory().sessions,
    listFolders: () => development ? repo.listFolders() : inventory().folders,
    getSession(id: string) {
      const session = repo.getSession(id)
      if (development || !session?.folderId || !Object.hasOwn(platforms, session.name)) return session
      return inventory().sessions.find((s) => s.id === id)
    },
    getCredential: (id: string) => repo.getCredential(id),
    hostKeys: (host: string, port: number) => repo.hostKeys(host, port)
  }
}
