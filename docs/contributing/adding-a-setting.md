# Adding a setting

Settings live in main (`SettingsService`, stored in SQLite) and reach the renderer through `settings:get` / `settings:update`. A setting is not finished until it can be found by search, opened by a link, and is documented; tests check each of these.

Follow an existing setting through the code. `termAutocomplete` is a good one:

```sh
grep -rn termAutocomplete apps/desktop/src
```

## Steps

1. **Type.** Add the field to `Settings` in `apps/desktop/src/shared/types.ts`, with a one-line doc comment. If main derives it and the renderer must not set it, add it to `DerivedSettings`.
2. **Default.** Add the default to `DEFAULTS` in `apps/desktop/src/main/settings.ts`. Pick the safe default: off for anything that sends data, weakens a check or changes a device.
3. **Schema.** Add the field to `SettingsPatch` in `apps/desktop/src/main/ipc/schemas.ts`, with bounds (`.int().min().max()`, an enum, `.max()` on strings). The schema is `.strict()`, so an unknown key is refused.
4. **The row.** Add a `<Row k="<key>" label="…" hint="…">` with its control in the Settings dialog (`apps/desktop/src/renderer/src/features/settings/`). The hint says what the setting does in one or two plain sentences, including the consequence ("Never sends a command of its own").
5. **The registry.** Add an entry to `SETTINGS` in `apps/desktop/src/shared/settings-registry.ts`: key, section, label (the same as the row), and keywords people might search for. This gives the setting search, `openSettings('<key>')` links and the `hopline://settings/<section>/<key>` deep link. `test/settings-registry.test.ts` fails if a row and the registry disagree.
6. **Use it** where it applies. Main reads `settings.get()`; the renderer reads it from the settings store. If main must react when it changes, hook `settings.onChange`.
7. **Optional, as they apply:**
   - **Per-host overrides:** add the key to `OVERRIDE_KEYS` in `src/shared/ux.ts`, the override schema in `src/main/ux.ts`, and the row list in `features/overrides/OverridesDialog.tsx`. Only for settings that make sense per session or folder.
   - **Export and sync:** add it to `PORTABLE_PREFS` in `src/main/backup/transfer.ts` if it is a personal preference that should follow the user to another machine. Never a path, a secret or a security setting.
   - **Team policy:** if an administrator should be able to fix it, add it to the policy schema and locks (`src/shared/policy.ts`, `src/main/policy/`) and document it in [docs/POLICY.md](../POLICY.md). Locked settings show **Managed by policy**.
   - **The palette:** a toggle people use often can get an action (`features/actions/`).
8. **Docs.** Run `npm run docs:reference` to regenerate [the settings reference](../guide/settings-reference.md). If the row's hint is computed, or the default is not obvious from the code, add an entry to `DESCRIPTIONS` or `DEFAULTS` in `apps/desktop/scripts/docs-reference.ts`. `test/docs-reference.test.ts` fails if any registry setting has no description or is missing from the page, or if the page is stale. Mention the setting in the guide page where the feature is described.

## Tests

- `test/settings-registry.test.ts` and `test/docs-reference.test.ts` (above).
- `test/ipc-shapes.test.ts` covers `settings:update` with the strict schema.
- Add a behaviour test for what the setting changes, and an e2e test if it is visible in the UI.
