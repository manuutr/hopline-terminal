import { compile, type TreeSource } from './dsl'
import { PROFILES } from './profiles'
import { TREES } from './trees'
import type { CommandNode, ModeId, PlatformId, PlatformProfile } from './types'

export interface PlatformModel {
  profile: PlatformProfile
  /** Modes that have their own command tree. */
  modes: readonly ModeId[]
  /** The compiled tree of one mode (undefined if the platform has none for it). */
  tree(mode: ModeId): CommandNode | undefined
  /** Roots searched for a line typed in `mode`: its own tree, then its fallbacks. */
  roots(mode: ModeId): CommandNode[]
  rootsWithModes(mode: ModeId): [ModeId, CommandNode][]
}

const cache = new Map<PlatformId, PlatformModel>()

function build(id: PlatformId): PlatformModel {
  const profile = PROFILES[id]
  const sources = TREES[id] as Partial<Record<ModeId, TreeSource>>
  const compiled = new Map<ModeId, CommandNode>()
  const tree = (mode: ModeId) => {
    let t = compiled.get(mode)
    if (!t && sources[mode]) {
      t = compile(sources[mode]!)
      compiled.set(mode, t)
    }
    return t
  }
  // Where the device runs exec commands typed in configuration mode (ASA, NX-OS, EOS, ...), a config
  // line is also resolved against the exec tree, so `reload` or `delete …` in a proposal keeps its
  // exec verdict (the most dangerous interpretation wins).
  const fallbackOf = (mode: ModeId): readonly ModeId[] => {
    const def = profile.modes.find((m) => m.id === mode)
    const own = def?.fallback ?? (mode === 'user' ? ['exec' as ModeId] : [])
    const inherits = profile.configInheritsExec && (def?.level === 'config' || def?.level === 'sub-config') && sources.exec
    return inherits && !own.includes('exec') ? [...own, 'exec'] : own
  }
  const rootsWithModes = (mode: ModeId): [ModeId, CommandNode][] => {
    const out: [ModeId, CommandNode][] = []
    const seen = new Set<ModeId>()
    const visit = (m: ModeId) => {
      if (seen.has(m)) return
      seen.add(m)
      const t = tree(m)
      if (t) out.push([m, t])
      for (const f of fallbackOf(m)) visit(f)
    }
    visit(mode)
    return out
  }
  return {
    profile,
    modes: Object.keys(sources) as ModeId[],
    tree,
    roots: (mode) => rootsWithModes(mode).map(([, n]) => n),
    rootsWithModes
  }
}

/** Lazily compiled model of one platform (trees compile on first use). */
export function getPlatform(id: PlatformId): PlatformModel {
  let m = cache.get(id)
  if (!m) {
    if (!PROFILES[id]) throw new Error(`unknown platform "${id}"`)
    m = build(id)
    cache.set(id, m)
  }
  return m
}
