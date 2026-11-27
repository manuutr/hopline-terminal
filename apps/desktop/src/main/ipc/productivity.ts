import { SESSION_PLATFORMS } from '@hopline/guard'
import { z } from 'zod'
import type { ProductivityStore } from '../productivity/store'
import { KeymapSchema, SnippetScopeSchema } from '../productivity/store'
import type { SnippetService } from '../productivity/snippets'
import { MAX_CONCURRENCY, MAX_TARGETS, type MultiService } from '../productivity/multi'
import { parserAvailable } from '../productivity/parsers'
import { handler as h, registerAll, type Handler } from '.'

const none = { parse: (): undefined => undefined }
const id = z.string().min(1).max(64)

/** Keymap (Settings → Keyboard). Exported by channel for the IPC contract test. */
export function keymapHandlers(store: ProductivityStore): Record<string, Handler> {
  return {
    'keymap:get': h(none, () => store.keymap()),
    'keymap:set': h(KeymapSchema, (km) => store.setKeymap(km))
  }
}

export const SnippetInputSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(80),
    body: z.string().min(1).max(4000),
    mode: z.enum(['insert', 'run']),
    scope: SnippetScopeSchema,
    platforms: z.array(z.enum(SESSION_PLATFORMS)).max(40),
    onBar: z.boolean()
  })
  .strict()

/** Variable values: short, single-line (fillSnippet checks them again before anything is classified). */
const Vars = z.record(z.string().min(1).max(32).regex(/^[A-Za-z_][\w-]*$/), z.string().max(128)).refine((v) => Object.keys(v).length <= 20, 'too many variables')
const Prepare = z.object({ snippetId: id, tabId: id, vars: Vars }).strict()
const Run = z.object({ planId: id, approve: z.boolean(), ack: z.string().max(255).optional() }).strict()

/** A tab is shown in the asking window (background connections have none, so they never are). */
export type Owns = (tabId: string, sender: object) => boolean

const mine = (owns: Owns, tabId: string, sender: object) => {
  if (!owns(tabId, sender)) throw new Error('The tab is closed')
}

/** Snippets and the button bar. Only tabs of the asking window, and its own previews. */
export function snippetHandlers(store: ProductivityStore, snippets: SnippetService, owns: Owns): Record<string, Handler> {
  return {
    'snippets:list': h(none, () => store.snippets()),
    'snippets:save': h(SnippetInputSchema, (s) => store.saveSnippet(s)),
    'snippets:remove': h(id, (sid) => store.removeSnippet(sid)),
    'snippets:reorder': h(z.array(id).max(1000), (ids) => store.reorder(ids)),
    'snippets:prepare': h(Prepare, (req, e) => (mine(owns, req.tabId, e.sender), snippets.prepare(req, e.sender))),
    'snippets:run': h(Run, (req, e) => snippets.run(req, e.sender, (tabId) => owns(tabId, e.sender))),
    'snippets:insert': h(Prepare, (req, e) => (mine(owns, req.tabId, e.sender), snippets.insert(req)))
  }
}

const ids = z.array(z.string().min(1).max(128)).max(500)
const Targets = z.object({ tabs: ids.optional(), sessions: ids.optional(), folders: ids.optional(), tags: ids.optional() }).strict()
const Preview = z.object({ mode: z.enum(['send', 'run']), targets: Targets, command: z.string().min(1).max(4000), perPlatform: z.boolean().optional() }).strict()
const Start = z.object({ previewId: id, confirmConfig: z.boolean(), concurrency: z.number().int().min(1).max(MAX_CONCURRENCY) }).strict()

/** Send-to-many and multi-device runs; the asking window owns its previews and runs. */
export function multiHandlers(multi: MultiService): Record<string, Handler> {
  return {
    'multi:info': h(none, () => ({ parser: parserAvailable(), maxTargets: MAX_TARGETS, maxConcurrency: MAX_CONCURRENCY })),
    'multi:resolve': h(Targets, (t, e) => multi.resolve(t, e.sender)),
    'multi:preview': h(Preview, (req, e) => multi.preview(req, e.sender)),
    'multi:start': h(Start, (req, e) => multi.start(req, e.sender)),
    'multi:cancel': h(id, (runId, e) => multi.cancel(runId, e.sender)),
    // The user left a preview without starting it: a configuration preview is audited as declined.
    'multi:decline': h(id, (previewId, e) => multi.decline(previewId, e.sender))
  }
}

export function registerProductivityIpc(map: Record<string, Handler>): void {
  registerAll(map)
}
