# Conventions

## Code

- **TypeScript everywhere**, `strict` with `noUncheckedIndexedAccess` (`tsconfig.base.json`). `npm run typecheck` must pass; no `any` where a type is knowable, no `@ts-ignore`.
- **ES modules.** The simulator and the scripts run directly under Node 24 (type stripping) and import with explicit `.ts` extensions; the other packages and the app use extensionless imports resolved by the bundler. Match the package you are in.
- **Formatting** follows the surrounding code: two spaces, single quotes, no semicolons, long lines rather than wrapped arguments. There is no formatter config; match the file you are in.
- **Pure where possible.** Logic that does not need Electron goes in a package or in `src/shared`, so it can be tested in Node. The renderer holds UI state, not decisions.
- **Comments explain why**, and cite the review finding or design section a rule comes from (`review M3`, `ARCHITECTURE §6.3`). Public functions get a one-line doc comment.
- **Errors** are messages a user can act on ("Add your Anthropic API key in Settings to use the assistant."), never stack traces in the UI, never a secret.
- **Tests** sit next to their kind: `packages/*/test`, `apps/desktop/test` (vitest), `apps/desktop/e2e` (Playwright). A bug fix comes with a test that failed before it.

## UI and copy

The direction is a quiet, terminal-first professional tool: the terminal is the product, chrome stays out of the way. Read [docs/design/VISUAL-DIRECTION.md](../design/VISUAL-DIRECTION.md) before changing the UI.

- Use the design tokens and components in `src/renderer/src/design/`; don't add colours, radii or shadows inline. Safety colours (approval cards, risk labels) are reserved for safety.
- No decorative gradients, glows, emoji or illustrations. Icons are Lucide, at the sizes the components use.
- Every action is reachable from the keyboard and the palette, every control has an accessible name, and nothing depends on colour alone ([docs/ACCESSIBILITY.md](../ACCESSIBILITY.md)). `e2e/a11y-*.spec.ts` runs axe on the main surfaces.
- Copy is plain and specific. Sentence case. Say what happens and what it costs ("Runs on 4 devices. Read-only."), not how great it is. Name buttons by what they do ("Replace key and connect", not "OK").
- A new setting needs a hint; a new action needs a palette title and, if it is common, a default shortcut that respects the keymap rules (no keys the device needs).

## Commits

- Small, focused commits that each build and pass tests.
- Subject in the form `type(scope): what changed`, imperative or descriptive, lower case, no trailing full stop. Types used in this repository: `feat`, `fix`, `perf`, `test`, `docs`, `refactor`, `chore`, `release`. Scope is the feature or package (`fleet`, `guard`, `settings`, `e2e`).
- The body says why, and what the reviewer should look at. Reference the backlog or review item if there is one.
- Commits that change safety behaviour (the guard, the deny-list, the executor, approvals, redaction, IPC schemas) say so in the subject or the first line of the body.

## Pull requests

- One topic per pull request. Describe the change, how you tested it, and screenshots for UI changes.
- CI must be green on all three OSes: typecheck, vitest, e2e.
- Changes to anything in [CONTRIBUTING.md › Security rules](../../CONTRIBUTING.md#security-rules) need a review focused on that rule.
- Update the docs in the same pull request: the user guide for anything a user sees, `CHANGELOG.md` under `[Unreleased]`, and [ARCHITECTURE.md](../ARCHITECTURE.md) for design changes. `npm test` checks the docs' relative links and the generated reference pages.

## Releases

Every workspace shares one version. Compatible fixes increment the patch version, compatible features increment the minor version and breaking changes increment the major version. The full process (changelog, version bump, tag, the release workflow, the draft release, staged rollout, signing) is in [RELEASING.md](../../RELEASING.md).
