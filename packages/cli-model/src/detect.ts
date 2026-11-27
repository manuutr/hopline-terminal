import { PROFILES } from './profiles'
import type { DetectedMode, ModeId, PlatformId } from './types'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]/g

function lastLines(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  return clean.split('\n')
}

function subMode(platform: PlatformId, suffix: string): ModeId {
  for (const m of PROFILES[platform].modes) if (m.match?.test(suffix)) return m.id
  return 'config'
}

/**
 * Infer the CLI mode from the prompt. `text` is the tail of the terminal (or just the prompt
 * line); for Junos and PAN-OS the `[edit …]` banner line above the prompt gives the edit path.
 * Returns null when the last line is not a prompt (busy, paging, logging in).
 */
export function detectMode(platform: PlatformId, text: string): DetectedMode | null {
  const lines = lastLines(text)
  const last = lines.at(-1) ?? ''
  const above = lines.slice(-4, -1).reverse()
  const style = PROFILES[platform]?.promptStyle
  switch (style) {
    case 'cisco':
    case 'nxos': {
      const re = style === 'nxos' ? /^([\w.\-/:]+?)(?:%([\w.\-]+))?(?:\(([\w.\-/:, ]+)\))?(#)\s?(.*)$/ : /^([\w.\-/:]+?)((?:\([\w.\-/:, ]+\))*)([>#])\s?(.*)$/
      const m = re.exec(last)
      if (!m) return null
      let host: string
      let ctx: string | undefined
      // IOS-XR prefixes the node: RP/0/RP0/CPU0:host#
      const node = /^((?:RP|LC)\/\d+\/\w+\/CPU\d+):/.exec(m[1]!)
      let char: string
      let pending: string
      let routingCtx: string | undefined
      let banner: string | undefined
      if (style === 'nxos') {
        host = m[1]!
        routingCtx = m[2]
        ctx = m[3]
        char = m[4]!
        pending = m[5] ?? ''
      } else {
        host = m[1]!
        const groups = [...(m[2] ?? '').matchAll(/\(([^)]+)\)/g)].map((g) => g[1]!)
        // EOS: "(s1)" supervisor and "(vrf:X)" are decorations, not modes.
        const deco = groups.filter((g) => /^s\d$|^vrf:/.test(g))
        if (deco.length) banner = deco.join(' ')
        ctx = groups.find((g) => !deco.includes(g))
        char = m[3]!
        pending = m[4] ?? ''
      }
      if (node) host = host.slice(node[0].length)
      const prompt = last.slice(0, last.length - pending.length).trimEnd()
      if (ctx) {
        const mode = ctx === 'config' || ctx.startsWith('config-s') ? (ctx.startsWith('config-s-') && /-if-/.test(ctx) ? 'config-if' : 'config') : subMode(platform, ctx)
        return { mode, level: mode === 'config' ? 'config' : 'sub-config', hostname: host, prompt, pending, context: ctx, banner }
      }
      const mode: ModeId = char === '>' ? 'user' : 'exec'
      return { mode, level: char === '>' ? 'user' : 'exec', hostname: host, prompt, pending, context: routingCtx, banner }
    }
    case 'junos':
    case 'panos': {
      const re =
        style === 'junos'
          ? /^(?:\{([^}]+)\})?(?:\[edit(?: ([^\]]*))?\])?(?:([\w.\-]+)@)?([\w.\-]+)(?::([\w-]+))?([>#])\s?(.*)$/
          : /^(?:([\w.\-]+)@)([\w.\-]+?)(?:-(vsys\d+))?(?:\(([a-z-]+)\))?([>#])\s?(.*)$/
      const m = re.exec(last)
      if (!m) return null
      let editPath: string[] | undefined
      let banner: string | undefined
      let host: string
      let char: string
      let pending: string
      let context: string | undefined
      if (style === 'junos') {
        banner = m[1]
        host = m[4]!
        context = m[5]
        char = m[6]!
        pending = m[7] ?? ''
        if (m[2] !== undefined) editPath = m[2] ? m[2].split(' ') : []
      } else {
        host = m[2]!
        context = m[3]
        banner = m[4]
        char = m[5]!
        pending = m[6] ?? ''
      }
      for (const l of above) {
        const e = /^(?:\{([^}]+)\})?\[edit(?: ([^\]]*))?\]\s*$/.exec(l)
        if (e && editPath === undefined) {
          editPath = e[2] ? e[2].split(' ') : []
          banner ??= e[1]
          break
        }
        const b = /^\{([^}]+)\}\s*$/.exec(l)
        if (b) banner ??= b[1]
        if (l.trim()) break
      }
      const prompt = last.slice(0, last.length - pending.length).trimEnd()
      if (char === '#') return { mode: 'config', level: editPath?.length ? 'sub-config' : 'config', hostname: host, prompt, pending, editPath: editPath ?? [], banner, context }
      return { mode: 'exec', level: 'exec', hostname: host, prompt, pending, banner, context }
    }
    case 'fortios': {
      const m = /^([\w.\-]+) (?:\(([^)]+)\) )?([#$]) ?(.*)$/.exec(last)
      if (!m) return null
      const pending = m[4] ?? ''
      const prompt = last.slice(0, last.length - pending.length).trimEnd()
      if (m[2]) return { mode: 'config', level: 'sub-config', hostname: m[1]!, prompt, pending, context: m[2] }
      return { mode: 'exec', level: 'exec', hostname: m[1]!, prompt, pending, banner: m[3] === '$' ? 'restricted' : undefined }
    }
    case 'aireos': {
      // (Cisco Controller) >   (wlc1) config>   (wlc1) config wlan>
      const m = /^\(([^)]+)\) ((?:config(?: [\w-]+)*)?)>\s?(.*)$/.exec(last)
      if (!m) return null
      const pending = m[3] ?? ''
      const prompt = last.slice(0, last.length - pending.length).trimEnd()
      if (m[2]) return { mode: 'config', level: m[2].includes(' ') ? 'sub-config' : 'config', hostname: m[1]!, prompt, pending, context: m[2] }
      return { mode: 'exec', level: 'exec', hostname: m[1]!, prompt, pending }
    }
    case 'vrp': {
      // <host> user view; [host] system view; [host-GigabitEthernet0/0/1] sub-views; ~ and * mark
      // two-stage (commit) mode and uncommitted changes.
      const m = /^(?:<([\w.\-]+)>|\[(~?\*?)([\w.\-]+?)(?:-([\w./:-]+))?\])\s?(.*)$/.exec(last)
      if (!m) return null
      const pending = m[5] ?? ''
      const prompt = last.slice(0, last.length - pending.length).trimEnd()
      if (m[1]) return { mode: 'exec', level: 'exec', hostname: m[1], prompt, pending }
      const ctx = m[4]
      if (!ctx) return { mode: 'config', level: 'config', hostname: m[3]!, prompt, pending, banner: m[2] || undefined }
      return { mode: subMode(platform, ctx), level: 'sub-config', hostname: m[3]!, prompt, pending, context: ctx, banner: m[2] || undefined }
    }
    case 'bare': {
      // FTD restricted CLI: the prompt is just ">".
      const m = /^>\s?(.*)$/.exec(last)
      if (!m) return null
      return { mode: 'exec', level: 'exec', hostname: '', prompt: '>', pending: m[1] ?? '' }
    }
    default:
      return null
  }
}
