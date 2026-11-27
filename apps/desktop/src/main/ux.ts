/**
 * Per-machine UX state (shared/ux.ts): onboarding, per-host overrides and custom themes, each under
 * its own settings-table key and validated on the way in. A malformed stored value reads as the
 * default rather than throwing (it was written by an older or a hand-edited build).
 */
import { z } from 'zod'
import { CHECKLIST_ITEMS, CUSTOM_PREFIX, ONBOARDING_DEFAULT, OVERRIDES_DEFAULT, TERM_COLOR_KEYS, UI_TOKEN_KEYS, type CustomTheme, type OnboardingState, type OverrideStore } from '@shared/ux'
import type { Repo } from './db/repo'

const Hex = z.string().regex(/^#[0-9a-f]{6}$/i)
const Id = z.string().min(1).max(64)

export const Onboarding = z
  .object({
    stepsDone: z.boolean(),
    done: z.partialRecord(z.enum(CHECKLIST_ITEMS), z.number().int().nonnegative()),
    checklistDismissed: z.boolean()
  })
  .strict()

export const HostOverridesSchema = z
  .object({
    termTheme: z.string().regex(/^[a-z0-9-]{1,40}$/),
    termFontFamily: z.string().max(200).regex(/^[\w\s"',.-]*$/),
    termFontSize: z.number().min(8).max(32),
    termLineHeight: z.number().min(1).max(2),
    termCursorStyle: z.enum(['bar', 'block', 'underline']),
    termHighlight: z.boolean(),
    termAutocomplete: z.boolean(),
    keepAliveSec: z.number().int().min(0).max(3600),
    autoReconnect: z.boolean(),
    logToFile: z.boolean()
  })
  .partial()
  .strict()

export const OverrideStoreSchema = z
  .object({
    folders: z.record(Id, HostOverridesSchema),
    sessions: z.record(Id, HostOverridesSchema)
  })
  .strict()

export const CustomThemeSchema = z
  .object({
    id: z.string().regex(new RegExp(`^${CUSTOM_PREFIX}[a-z0-9-]{1,32}$`)),
    label: z.string().trim().min(1).max(60),
    mode: z.enum(['dark', 'light']),
    source: z.object({ base: Hex, accent: Hex, chroma: z.number().min(0).max(0.4).optional() }).strict().optional(),
    term: z.object(Object.fromEntries(TERM_COLOR_KEYS.map((k) => [k, Hex])) as Record<(typeof TERM_COLOR_KEYS)[number], typeof Hex>).strict(),
    ui: z.partialRecord(z.enum(UI_TOKEN_KEYS), Hex).optional()
  })
  .strict()

export const CustomThemes = z.array(CustomThemeSchema).max(64)

const KEYS = { onboarding: 'ux.onboarding', overrides: 'ux.hostOverrides', themes: 'ux.customThemes' } as const

export class UxStore {
  constructor(private readonly repo: Pick<Repo, 'getSetting' | 'setSetting'>) {}

  private read<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
    const raw = this.repo.getSetting(key)
    if (!raw) return structuredClone(fallback)
    try {
      const r = schema.safeParse(JSON.parse(raw))
      return r.success ? r.data : structuredClone(fallback)
    } catch {
      return structuredClone(fallback)
    }
  }

  onboarding(): OnboardingState {
    return this.read(KEYS.onboarding, Onboarding, ONBOARDING_DEFAULT) as OnboardingState
  }
  setOnboarding(s: OnboardingState): OnboardingState {
    this.repo.setSetting(KEYS.onboarding, JSON.stringify(Onboarding.parse(s)))
    return this.onboarding()
  }

  overrides(): OverrideStore {
    return this.read(KEYS.overrides, OverrideStoreSchema, OVERRIDES_DEFAULT) as OverrideStore
  }
  setOverrides(s: OverrideStore): OverrideStore {
    this.repo.setSetting(KEYS.overrides, JSON.stringify(OverrideStoreSchema.parse(s)))
    return this.overrides()
  }

  themes(): CustomTheme[] {
    return this.read(KEYS.themes, CustomThemes, []) as CustomTheme[]
  }
  setThemes(list: CustomTheme[]): CustomTheme[] {
    const parsed = CustomThemes.parse(list)
    if (new Set(parsed.map((t) => t.id)).size !== parsed.length) throw new Error('Two themes have the same id')
    this.repo.setSetting(KEYS.themes, JSON.stringify(parsed))
    return this.themes()
  }
}
