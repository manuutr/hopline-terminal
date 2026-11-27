import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Keymap, Snippet, SnippetInput } from '@shared/productivity'
import { withoutReserved } from '@shared/keymap-rules'
import type { Repo } from '../db/repo'

/** Keymap and snippets are saved independently of general preferences. */
const KEYMAP = 'keymap'
const SNIPPETS = 'snippets'
export const MAX_SNIPPETS = 500
const MAC = process.platform === 'darwin'

const combo = z.string().min(1).max(40).regex(/^[\w+,./;'[\]\\`=-]+$/, 'not a key combo')
export const KeymapSchema = z.record(z.string().min(1).max(64).regex(/^[\w.-]+$/), z.array(combo).max(4)).refine((m) => Object.keys(m).length <= 300, 'too many entries')

const sid = z.string().min(1).max(64)
export const SnippetScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('folder'), id: sid }).strict(),
  z.object({ kind: z.literal('session'), id: sid }).strict()
])

export class ProductivityStore {
  constructor(private readonly repo: Pick<Repo, 'getSetting' | 'setSetting'>) {}

  keymap(): Keymap {
    const raw = this.repo.getSetting(KEYMAP)
    if (!raw) return {}
    const parsed = KeymapSchema.safeParse(JSON.parse(raw))
    // Reserved combos (Ctrl+C, Tab, Enter…) never come back from storage (review L10).
    return parsed.success ? withoutReserved(parsed.data, MAC) : {}
  }

  setKeymap(km: Keymap): Keymap {
    // Checked here too, not only in the editor: the renderer may be old, buggy or compromised.
    const clean = withoutReserved(km, MAC)
    this.repo.setSetting(KEYMAP, Object.keys(clean).length ? JSON.stringify(clean) : null)
    return this.keymap()
  }

  snippets(): Snippet[] {
    const raw = this.repo.getSetting(SNIPPETS)
    if (!raw) return []
    try {
      const list = JSON.parse(raw) as Snippet[]
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  snippet(id: string): Snippet | undefined {
    return this.snippets().find((s) => s.id === id)
  }

  private write(list: Snippet[]): void {
    this.repo.setSetting(SNIPPETS, JSON.stringify(list))
  }

  saveSnippet(input: SnippetInput): Snippet {
    const list = this.snippets()
    const i = input.id ? list.findIndex((s) => s.id === input.id) : -1
    if (i < 0 && list.length >= MAX_SNIPPETS) throw new Error(`At most ${MAX_SNIPPETS} snippets`)
    const s: Snippet = { ...input, id: i >= 0 ? list[i]!.id : randomUUID(), updatedAt: Date.now() }
    if (i >= 0) list[i] = s
    else list.push(s)
    this.write(list)
    return s
  }

  removeSnippet(id: string): void {
    this.write(this.snippets().filter((s) => s.id !== id))
  }

  /** New order (the button bar's): ids listed first in that order, the rest after. */
  reorder(ids: string[]): Snippet[] {
    const list = this.snippets()
    const pos = new Map(ids.map((id, i) => [id, i]))
    const sorted = [...list].sort((a, b) => (pos.get(a.id) ?? ids.length + list.indexOf(a)) - (pos.get(b.id) ?? ids.length + list.indexOf(b)))
    this.write(sorted)
    return sorted
  }
}
