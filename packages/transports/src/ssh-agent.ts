/**
 * SSH agent discovery per OS. Returns a value ssh2 understands as `agent`: a Unix socket path,
 * a Windows named pipe, or the literal 'pageant' (ssh2@1.17.0 only; removed on ssh2 master).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
// Only macOS/Linux paths are joined here, so use POSIX separators even when this runs elsewhere (tests).
import { posix } from 'node:path'

export type AgentSource = 'SSH_AUTH_SOCK' | 'launchctl' | '1password' | 'openssh-pipe' | 'pageant'

export interface AgentCandidate {
  path: string
  source: AgentSource
}

export const WINDOWS_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'
export const ONEPASSWORD_MAC_SOCK = 'Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock'
export const ONEPASSWORD_LINUX_SOCK = '.1password/agent.sock'

export interface AgentEnv {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  /** macOS: `launchctl getenv SSH_AUTH_SOCK`, for apps launched from the Dock (no shell env). */
  launchctlSock?: () => Promise<string | undefined>
}

function launchctlSock(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('launchctl', ['getenv', 'SSH_AUTH_SOCK'], { timeout: 1500 }, (err, stdout) => {
      const v = String(stdout ?? '').trim()
      resolve(err || !v ? undefined : v)
    })
  })
}

/** Candidate agents in preference order; only ones that appear to exist are returned. */
export async function agentCandidates(o: AgentEnv = {}): Promise<AgentCandidate[]> {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  const home = o.home ?? homedir()
  const exists = o.exists ?? existsSync
  const out: AgentCandidate[] = []
  const sock = env['SSH_AUTH_SOCK']
  if (sock) out.push({ path: sock, source: 'SSH_AUTH_SOCK' })
  if (platform === 'win32') {
    // Win32-OpenSSH's agent service; 1Password serves the same pipe (and then that service must be off).
    if (exists(WINDOWS_OPENSSH_PIPE)) out.push({ path: WINDOWS_OPENSSH_PIPE, source: 'openssh-pipe' })
    out.push({ path: 'pageant', source: 'pageant' })
    return out
  }
  if (platform === 'darwin') {
    if (!sock) {
      const l = await (o.launchctlSock ?? launchctlSock)()
      if (l && exists(l)) out.push({ path: l, source: 'launchctl' })
    }
    const op = posix.join(home, ONEPASSWORD_MAC_SOCK)
    if (exists(op)) out.push({ path: op, source: '1password' })
    return out
  }
  const op = posix.join(home, ONEPASSWORD_LINUX_SOCK)
  if (exists(op)) out.push({ path: op, source: '1password' })
  return out
}

/** The agent to use when the profile doesn't name one. */
export async function detectAgent(o: AgentEnv = {}): Promise<AgentCandidate | undefined> {
  return (await agentCandidates(o))[0]
}
