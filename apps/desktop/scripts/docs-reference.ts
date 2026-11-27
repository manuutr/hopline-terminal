/**
 * Generates the two reference pages of the user guide from the code:
 *
 * - docs/guide/settings-reference.md from the settings registry (src/shared/settings-registry.ts)
 *   and the hints on each Settings row (`<Row k="…" hint="…">`);
 * - docs/guide/keyboard-shortcuts.md from the default keys declared in the renderer's action lists.
 *
 * Only the block between `<!-- generated:<name> -->` and `<!-- /generated:<name> -->` is written;
 * the prose around it is hand-written. test/docs-reference.test.ts fails when a page is out of date,
 * when the registry gains a setting this file has no text for, or when an action's keys can't be read.
 *
 *   node apps/desktop/scripts/docs-reference.ts          # rewrite both pages
 *   node apps/desktop/scripts/docs-reference.ts --check  # exit 1 if either is out of date
 *
 * Pure Node (no Electron, no DOM): the action lists import React and the stores, so they are read
 * as source text, the same way test/default-keys.test.ts checks them.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS, SETTINGS_SECTIONS, SETTINGS_TABS, type SettingsSection } from '../src/shared/settings-registry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DESKTOP = join(HERE, '..')
export const REPO = join(DESKTOP, '../..')
const RENDERER = join(DESKTOP, 'src/renderer/src')
export const SETTINGS_PAGE = join(REPO, 'docs/guide/settings-reference.md')
export const SHORTCUTS_PAGE = join(REPO, 'docs/guide/keyboard-shortcuts.md')

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(f) ? [p] : []
  })

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const code = (s: string) => '`' + s + '`'

// ---------------------------------------------------------------- settings

/**
 * Defaults, as the app ships them (src/main/settings.ts DEFAULTS, vault.ts, run-budget.ts). Rows
 * that are actions or lists rather than values have none.
 */
const DEFAULTS: Record<string, string> = {
  aiProvider: 'Anthropic',
  aiModel: '`claude-opus-5-5` (Claude Opus 5.5)',
  ollamaEndpoint: '`http://127.0.0.1:11434`',
  aiReadOnly: 'On',
  aiRunTokenBudget: '200,000 tokens',
  egressLog: 'On',
  commandTimeoutMs: '30 s',
  outputCapBytes: '512 KB',
  keepAliveSec: '30 s',
  filesOnConnect: 'Off',
  autoReconnect: 'On',
  logDir: '`Documents/Hopline/logs`',
  logTemplate: '`%S_%Y-%M-%D_%h-%m-%s.log`',
  logTimestamps: 'Off',
  logRotateDaily: 'On',
  termTheme: 'Hopline Terminal (follows the app theme)',
  termFontFamily: 'Bundled JetBrains Mono',
  termFontSize: '13 px, line height 1.2',
  termCursorStyle: 'Bar, blinking',
  termRestoreScrollback: 'On',
  termScrollback: '20,000 lines',
  termHighlight: 'On',
  termScreenReader: 'Off',
  termAutocomplete: 'On',
  theme: 'Dark',
  buttonBar: 'Hidden',
  gettingStarted: 'Shown until closed',
  notifyApprovals: 'On',
  notifyDisconnects: 'On',
  vaultMode: 'OS keychain; without a keyring, session only until you set a master password',
  autoLock: '15 min',
  updateAutoCheck: 'On',
  updateChannel: 'Stable',
  crashReports: 'Off',
  crashReportDsn: 'The release\'s built-in DSN, if any'
}

/** Text for rows whose Settings hint is missing or computed at run time. */
const DESCRIPTIONS: Record<string, string> = {
  workspaceTour: 'Take a four-stop tour of saved sessions, the terminal, workspace chat and packet captures.',
  aiModel: 'Choose a Claude model, enter an OpenAI or Gemini model ID, or select a model from your Ollama server.',
  aiRunTokenBudget: 'Tokens one question may use, all model turns together (output counts 5×). The run is told to finish at the limit. A team policy can set a lower maximum.',
  termFontSize: 'Font size and line height of the terminal.',
  termCursorStyle: 'Block, bar or underline, and whether it blinks. Reduced motion stops the blink.',
  termScreenReader: 'Reads new output of the active tab through your screen reader, at most once a second, and summarises long output. Mod+Alt+B opens the scrollback as plain text.',
  theme: 'Dark or light app theme. The terminal follows it unless you pick a terminal theme.',
  themeLibrary: 'Browse built-in and saved terminal palettes, filter by dark or light, and preview device output before saving.',
  themeGenerator: 'Build a terminal theme from a base and an accent colour (OKLCH). Lightness is tuned until every colour passes WCAG AA.',
  keymap: 'Rebind any app shortcut. Keys the device needs (Ctrl+letter, Tab, Alt+letter and others) are refused. See [Keyboard shortcuts](keyboard-shortcuts.md).',
  credentials: 'Saved usernames with a password, a private key, the SSH agent, or ask every time. Secrets stay in main and are never shown again.',
  vaultMode: 'How the data key that encrypts every secret is protected: OS keychain, master password, or session only (forgotten at quit).',
  autoLock: 'Lock the vault after this many idle minutes (0 turns it off). Locking also happens when the screen locks.',
  folderSync: 'Keep sessions in step across machines through a folder you choose (Dropbox, a Git checkout). Secrets only if you opt in.',
  netbox: 'Pull devices from NetBox or Nautobot, then re-sync whenever it changes. The token is kept in the vault.',
  crashReportDsn: 'Where crash reports go when you turn them on: the release\'s built-in DSN, your own Sentry or GlitchTip DSN, or the team policy\'s.',
  updateAutoCheck: 'Check GitHub Releases every six hours. GitHub sees your IP address and which version you download.',
  exportFile: 'Export folders, sessions, credential profiles, portable settings and known hosts to one encrypted `.hopline` file (scrypt + AES-256-GCM). Secrets only on explicit opt-in. There is no recovery without the passphrase.',
  configBackups: 'Running-config history per device, diffs and schedules. Opens Config backups. Not part of the export file.'
}

/** Static `hint="…"` strings on `<Row k="…">`, first one wins (some keys have two rows). */
export function rowHints(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of sourceFiles(RENDERER)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<Row\s+k="([^"]+)"[^>]*?\shint="([^"]*)"/g)) if (!out.has(m[1]!)) out.set(m[1]!, m[2]!)
  }
  return out
}

/** Settings rows with no text: the registry gained a key that neither a hint nor DESCRIPTIONS covers. */
export function undocumentedSettings(): string[] {
  const hints = rowHints()
  return SETTINGS.filter((s) => !DESCRIPTIONS[s.key] && !hints.get(s.key)).map((s) => s.key)
}

export function renderSettings(): string {
  const missing = undocumentedSettings()
  if (missing.length) throw new Error(`No description for settings: ${missing.join(', ')}. Add a hint to the Row or an entry in DESCRIPTIONS (apps/desktop/scripts/docs-reference.ts).`)
  const hints = rowHints()
  const lines: string[] = []
  for (const [tab, tabTitle] of SETTINGS_TABS) {
    const sections = (Object.keys(SETTINGS_SECTIONS) as SettingsSection[]).filter((s) => SETTINGS_SECTIONS[s].tab === tab)
    for (const section of sections) {
      const rows = SETTINGS.filter((s) => s.section === section)
      if (!rows.length) continue
      const title = SETTINGS_SECTIONS[section].title
      lines.push(`### ${tabTitle === title ? title : `${tabTitle} › ${title}`}`, '')
      lines.push('| Setting | What it does | Default | Key and deep link |', '| --- | --- | --- | --- |')
      for (const s of rows) {
        const what = DESCRIPTIONS[s.key] ?? hints.get(s.key)!
        lines.push(`| **${cell(s.label)}** | ${cell(what)} | ${cell(DEFAULTS[s.key] ?? '—')} | ${code(s.key)}<br>${code(`hopline://settings/${section}/${s.key}`)} |`)
      }
      lines.push('')
    }
  }
  lines.push(`${SETTINGS.length} settings in ${Object.keys(SETTINGS_SECTIONS).length} sections.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- shortcuts

export interface ShortcutDecl {
  id: string
  title: string
  category: string
  /** Default keys on Windows and Linux, and on macOS (they differ only for computed keys). */
  keys: string[]
  macKeys: string[]
  extra: string[]
  fixed: boolean
  file: string
}

/** Titles of actions whose title is computed (it names the current state). */
const TITLE_OVERRIDES: Record<string, string> = {
  'tab.reopen': 'Reopen closed tab',
  'terminal.highlight': 'Turn output highlighting on or off',
  'ai.readOnly': 'Turn read-only mode on or off',
  'files.toggle': 'Files (SFTP/SCP): open or close the panel',
  'view.buttonBar': 'Show or hide the button bar',
  'fleet.investigate': 'Investigate across devices…',
  'a11y.screenReader': 'Turn screen reader mode on or off'
}

/** Keys given by an expression rather than a literal: [Windows/Linux, macOS]. */
const KEY_EXPRESSIONS: Record<string, [string[], string[]]> = {
  // features/multi/actions.ts multiRunKeys(): ⌘M stays Minimize on macOS.
  'multiRunKeys()': [['Mod+M'], ['Mod+Shift+M']],
  // features/menu/actions.ts
  'fullScreenKeys()': [['F11'], ['Ctrl+Meta+F']],
  'zoomOutKeys()': [['Mod+Alt+-'], ['Mod+-']],
  'findNextKeys()': [[], ['Mod+G']],
  'findPrevKeys()': [[], ['Mod+Shift+G']]
}

/** Categories assigned outside the object literal (features/actions/external.ts). */
const FILE_CATEGORY: Record<string, string> = {
  'features/blocks/actions.ts': 'Terminal',
  'features/backups/actions.ts': 'Automation'
}

/** The object literal around `at`, by brace matching that skips strings and template literals. */
function objectAround(src: string, at: number): string | null {
  let depth = 0
  let start = -1
  for (let i = at; i >= 0; i--) {
    const c = src[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
  }
  if (start < 0) return null
  depth = 0
  let quote: string | null = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return null
}

/** The object's own text with nested `{…}` and `(…)` bodies blanked, so only top-level fields remain. */
function topLevel(obj: string): string {
  let out = ''
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i]!
    if (quote) {
      if (depth <= 1) out += c
      if (c === '\\') {
        if (depth <= 1) out += obj[i + 1] ?? ''
        i++
      } else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    if (c === '{') depth++
    if (depth <= 1) out += c
    if (c === '}') depth--
  }
  return out
}

const str = (field: string, top: string): string | undefined => new RegExp(`\\b${field}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(top)?.[1]?.replace(/\\'/g, "'")

/** Every action in the renderer that declares default keys. */
export function shortcutDecls(): ShortcutDecl[] {
  const out: ShortcutDecl[] = []
  for (const f of sourceFiles(RENDERER)) {
    const rel = relative(RENDERER, f).split('\\').join('/')
    if (rel === 'lib/actions.ts') continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\bid:\s*'([a-z0-9]+\.[A-Za-z0-9.]+)'/g)) {
      const obj = objectAround(src, m.index!)
      if (!obj) continue
      const top = topLevel(obj)
      const keysArr = /\bkeys:\s*\[([^\]]*)\]/.exec(top)
      const keysStr = str('keys', top)
      const keysExpr = /\bkeys:\s*([A-Za-z_]\w*\(\))/.exec(top)?.[1]
      if (!keysArr && !keysStr && !keysExpr) continue
      let keys: string[]
      let macKeys: string[]
      if (keysExpr) {
        const known = KEY_EXPRESSIONS[keysExpr]
        if (!known) throw new Error(`${rel}: action ${m[1]} takes its keys from ${keysExpr}; add it to KEY_EXPRESSIONS in apps/desktop/scripts/docs-reference.ts`)
        ;[keys, macKeys] = known
      } else {
        keys = keysArr ? [...keysArr[1]!.matchAll(/'([^']+)'/g)].map((k) => k[1]!) : [keysStr!]
        macKeys = keys
      }
      if (!keys.length) continue
      const title = TITLE_OVERRIDES[m[1]!] ?? str('title', top)
      if (!title) throw new Error(`${rel}: action ${m[1]} has a computed title; add it to TITLE_OVERRIDES in apps/desktop/scripts/docs-reference.ts`)
      const category = str('category', top) ?? FILE_CATEGORY[rel]
      if (!category) throw new Error(`${rel}: action ${m[1]} has no category`)
      const extraBlock = /\bextraKeys:\s*\[([^\]]*)\]/.exec(obj)?.[1] ?? ''
      const extra = [...extraBlock.matchAll(/combo:\s*'([^']+)'/g)].map((k) => k[1]!)
      out.push({ id: m[1]!, title, category, keys, macKeys, extra, fixed: /\bfixed:\s*true/.test(top), file: rel })
    }
  }
  // Actions made by a factory (template-literal ids and keys): listed by hand, and checked against
  // the source so a new or changed factory fails here instead of going missing from the page.
  const templated = sourceFiles(RENDERER)
    .filter((f) => !f.endsWith(join('lib', 'actions.ts')))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bkeys:\s*\[\s*(`[^\]]*)\]/g)].map((m) => m[1]!.replace(/\s+/g, '')))
  const known = TEMPLATED.map((t) => t.source)
  const unknown = templated.filter((t) => !known.includes(t))
  if (unknown.length || templated.length !== known.length)
    throw new Error(`Action keys built from templates changed (${templated.join(' ; ')}); update TEMPLATED in apps/desktop/scripts/docs-reference.ts`)
  out.push(...TEMPLATED.map((t) => t.decl))
  const seen = new Set<string>()
  return out.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
}

/** features/actions/builtin.ts `focus()` and `gotoTab()`: the key arrays as written there, and the rows they make. */
const TEMPLATED: { source: string; decl: ShortcutDecl }[] = [
  {
    source: '`Ctrl+Alt+${key}`,`Mod+Alt+${key}`',
    decl: { id: 'pane.focus.*', title: 'Focus the pane to the left, right, above or below', category: 'Tabs and panes', keys: ['Ctrl+Alt+Arrows', 'Mod+Alt+Arrows'], macKeys: ['Ctrl+Alt+Arrows', 'Mod+Alt+Arrows'], extra: [], fixed: false, file: 'features/actions/builtin.ts' }
  },
  {
    source: '`Alt+${n}`,`Meta+${n}`',
    decl: { id: 'tab.goto.*', title: 'Go to tab 1 to 8; 9 goes to the last tab', category: 'Tabs and panes', keys: ['Alt+1…9', 'Meta+1…9'], macKeys: ['Alt+1…9', 'Meta+1…9'], extra: [], fixed: true, file: 'features/actions/builtin.ts' }
  }
]

const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Arrows: '←/→/↑/↓' }
const NAMES: Record<string, string> = { PageUp: 'PgUp', PageDown: 'PgDn', Escape: 'Esc' }

/** "Mod+Alt+B" as it reads on each OS. Mod is Ctrl+Shift on Windows and Linux, ⌘ on macOS. */
export function keyLabel(combo: string, mac: boolean): string {
  const parts = combo.split('+')
  const key = parts.at(-1) || '+'
  const mods = parts.slice(0, -1)
  const k = ARROWS[key] ?? NAMES[key] ?? key
  if (mac) {
    const sym: Record<string, string> = { Mod: '⌘', Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta']
    return [...new Set(mods)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((x) => sym[x] ?? x).join('') + k
  }
  const expanded = [...new Set(mods.flatMap((x) => (x === 'Mod' ? ['Ctrl', 'Shift'] : [x])))]
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta']
  return [...expanded.sort((a, b) => order.indexOf(a) - order.indexOf(b)), k].join('+')
}

const CATEGORY_ORDER = ['Sessions', 'Tabs and panes', 'Terminal', 'Automation', 'Assistant', 'View', 'App']

export function renderShortcuts(): string {
  const decls = shortcutDecls()
  const lines: string[] = []
  for (const cat of CATEGORY_ORDER) {
    const rows = decls.filter((d) => d.category === cat)
    if (!rows.length) continue
    lines.push(`### ${cat}`, '', '| Action | Windows and Linux | macOS | Rebindable | Action id |', '| --- | --- | --- | --- | --- |')
    for (const d of rows) {
      const win = [...d.keys.map((k) => keyLabel(k, false)), ...d.extra.map((k) => `${keyLabel(k, false)} (outside the terminal)`)]
      const mac = [...d.macKeys.map((k) => keyLabel(k, true)), ...d.extra.map((k) => `${keyLabel(k, true)} (outside the terminal)`)]
      lines.push(`| ${cell(d.title)} | ${win.map(code).join(', ')} | ${mac.map(code).join(', ')} | ${d.fixed ? 'No' : 'Yes'} | ${code(d.id)} |`)
    }
    lines.push('')
  }
  const unknown = decls.filter((d) => !CATEGORY_ORDER.includes(d.category))
  if (unknown.length) throw new Error(`Unknown action categories: ${unknown.map((d) => `${d.id} (${d.category})`).join(', ')}`)
  lines.push(`${decls.length} actions have a default shortcut. Every other action is in the command palette and can be given one in Settings › Keyboard.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- pages

/** Replace the generated block `name` in `page` with `body`. */
export function withBlock(page: string, name: string, body: string): string {
  const open = `<!-- generated:${name} -->`
  const close = `<!-- /generated:${name} -->`
  const a = page.indexOf(open)
  const b = page.indexOf(close)
  if (a < 0 || b < a) throw new Error(`missing ${open} … ${close}`)
  return `${page.slice(0, a + open.length)}\n<!-- Generated by apps/desktop/scripts/docs-reference.ts. Do not edit by hand. -->\n\n${body}\n\n${page.slice(b)}`
}

export const PAGES: [string, string, () => string][] = [
  [SETTINGS_PAGE, 'settings', renderSettings],
  [SHORTCUTS_PAGE, 'shortcuts', renderShortcuts]
]

/** Pages whose generated block differs from what the code says now. */
export function stalePages(): string[] {
  return PAGES.filter(([file, name, render]) => readFileSync(file, 'utf8') !== withBlock(readFileSync(file, 'utf8'), name, render())).map(([file]) => relative(REPO, file))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = stalePages()
    if (stale.length) {
      console.error(`Out of date: ${stale.join(', ')}. Run: node apps/desktop/scripts/docs-reference.ts`)
      process.exit(1)
    }
    console.log('Reference pages are up to date.')
  } else {
    for (const [file, name, render] of PAGES) writeFileSync(file, withBlock(readFileSync(file, 'utf8'), name, render()))
    console.log('Wrote docs/guide/settings-reference.md and docs/guide/keyboard-shortcuts.md')
  }
}
