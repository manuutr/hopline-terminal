/**
 * Every setting the user can find, as data: where it lives (tab and section), what it is called
 * and what else people might type to find it. It drives Settings search, `openSettings(key)` (every
 * "change this" link in the app), the `hopline://settings/<section>/<key>` deep links, and which
 * keys a session or folder may override.
 *
 * Pure (no DOM, no React), shared by main (deep-link validation) and the renderer.
 * test/settings-registry.test.ts checks that every `<Row k="…">` in the settings sources is listed
 * here and every listed row exists, so the search can't drift from the dialog.
 */

/** Left-nav tabs of the Settings dialog. */
export type SettingsTab = 'general' | 'assistant' | 'connections' | 'terminal' | 'themes' | 'keyboard' | 'credentials' | 'security' | 'privacy' | 'data'

export const SETTINGS_TABS: readonly [SettingsTab, string][] = [
  ['general', 'Workspace'],
  ['assistant', 'Assistant'],
  ['connections', 'Connections'],
  ['terminal', 'Terminal'],
  ['themes', 'Themes and fonts'],
  ['keyboard', 'Keyboard'],
  ['credentials', 'Credentials'],
  ['security', 'Security'],
  ['privacy', 'Updates & privacy'],
  ['data', 'Sync & export']
]

/** Sections, the second path part of a deep link. Each belongs to one tab. */
export const SETTINGS_SECTIONS = {
  assistant: { tab: 'assistant', title: 'Assistant' },
  connections: { tab: 'connections', title: 'Connections' },
  logging: { tab: 'connections', title: 'Logging' },
  terminal: { tab: 'terminal', title: 'Terminal' },
  appearance: { tab: 'general', title: 'Appearance' },
  notifications: { tab: 'general', title: 'Notifications' },
  themes: { tab: 'themes', title: 'Themes and fonts' },
  keyboard: { tab: 'keyboard', title: 'Keyboard' },
  credentials: { tab: 'credentials', title: 'Credentials' },
  security: { tab: 'security', title: 'Security' },
  updates: { tab: 'privacy', title: 'Updates' },
  crash: { tab: 'privacy', title: 'Crash reports' },
  data: { tab: 'data', title: 'Sync & export' }
} as const satisfies Record<string, { tab: SettingsTab; title: string }>

export type SettingsSection = keyof typeof SETTINGS_SECTIONS

export interface SettingDef {
  /** A Settings field name where there is one, otherwise a stable id for the row. */
  key: string
  section: SettingsSection
  label: string
  /** Extra words search matches on (synonyms, the old name, the SecureCRT/PuTTY term). */
  keywords?: string
}

/** The rows, in dialog order. Keys are stable: deep links and `openSettings` calls name them. */
export const SETTINGS: readonly SettingDef[] = [
  // Assistant
  { key: 'aiProvider', section: 'assistant', label: 'Provider', keywords: 'ai anthropic openai gemini chatgpt github copilot subscription sign in ollama local model llm' },
  { key: 'apiKey', section: 'assistant', label: 'API key', keywords: 'anthropic openai gemini key token claude' },
  { key: 'aiModel', section: 'assistant', label: 'Model', keywords: 'claude opus sonnet haiku openai gpt gemini ollama' },
  { key: 'ollamaEndpoint', section: 'assistant', label: 'Ollama server', keywords: 'endpoint url local air-gapped' },
  { key: 'aiConnection', section: 'assistant', label: 'Connection', keywords: 'test connection assistant' },
  { key: 'aiReadOnly', section: 'assistant', label: 'Read-only mode', keywords: 'safety changes config write allow' },
  { key: 'aiRunTokenBudget', section: 'assistant', label: 'Run budget', keywords: 'tokens cost limit' },
  { key: 'egressLog', section: 'assistant', label: 'Log what leaves', keywords: 'egress privacy what left this machine' },
  { key: 'commandTimeoutMs', section: 'assistant', label: 'Command timeout', keywords: 'agent seconds wait' },
  { key: 'outputCapBytes', section: 'assistant', label: 'Output cap', keywords: 'agent size limit kb' },
  // Connections
  { key: 'keepAliveSec', section: 'connections', label: 'Keep-alive', keywords: 'ssh keepalive idle timeout anti-idle' },
  { key: 'filesOnConnect', section: 'connections', label: 'Open Files on SSH connect', keywords: 'sftp scp files browser moba connect automatically' },
  { key: 'autoReconnect', section: 'connections', label: 'Auto-reconnect', keywords: 'retry drop reconnect backoff' },
  { key: 'knownHosts', section: 'connections', label: 'Known hosts', keywords: 'host keys fingerprint tofu ssh' },
  // Connections → Logging
  { key: 'logDir', section: 'logging', label: 'Log folder', keywords: 'session log directory path' },
  { key: 'logTemplate', section: 'logging', label: 'Log file name', keywords: 'template tokens pattern' },
  { key: 'logTimestamps', section: 'logging', label: 'Timestamp each line', keywords: 'time prefix log' },
  { key: 'logRotateDaily', section: 'logging', label: 'New log file daily', keywords: 'rotate midnight log' },
  // Terminal
  { key: 'termTheme', section: 'terminal', label: 'Theme', keywords: 'terminal colours colors palette scheme' },
  { key: 'reduceMotion', section: 'appearance', label: 'Reduce motion', keywords: 'accessibility animations transitions' },
  { key: 'termSmoothCaret', section: 'terminal', label: 'Smooth caret movement', keywords: 'cursor bar motion' },
  { key: 'termLigatures', section: 'terminal', label: 'Font ligatures', keywords: 'joined glyphs operators' },
  { key: 'termFontFamily', section: 'terminal', label: 'Font', keywords: 'typeface monospace family' },
  { key: 'termFontSize', section: 'terminal', label: 'Size and spacing', keywords: 'font size line height zoom' },
  { key: 'termCursorStyle', section: 'terminal', label: 'Cursor', keywords: 'caret blink block bar underline' },
  { key: 'termRestoreScrollback', section: 'terminal', label: 'Restore history', keywords: 'scrollback saved history reconnect' },
  { key: 'termScrollback', section: 'terminal', label: 'Scrollback', keywords: 'lines buffer history memory' },
  { key: 'termHighlight', section: 'terminal', label: 'Output highlighting', keywords: 'colour color syntax highlight' },
  { key: 'termScreenReader', section: 'terminal', label: 'Screen reader mode', keywords: 'accessibility a11y screen reader nvda jaws voiceover orca narrator announce blind' },
  { key: 'termAutocomplete', section: 'terminal', label: 'Autocomplete', keywords: 'ghost text completion hints suggestions' },
  // Workspace → Appearance
  { key: 'theme', section: 'appearance', label: 'Theme', keywords: 'dark light app ui mode' },
  { key: 'buttonBar', section: 'appearance', label: 'Button bar', keywords: 'snippets buttons toolbar' },
  { key: 'workspaceTour', section: 'appearance', label: 'Workspace tour', keywords: 'walkthrough help onboarding learn start' },
  { key: 'gettingStarted', section: 'appearance', label: 'Getting started', keywords: 'onboarding checklist first run' },
  { key: 'panelSizes', section: 'appearance', label: 'Panel sizes', keywords: 'divider resize sidebar width layout splitter reset keyboard accessibility' },
  // Workspace → Notifications
  { key: 'notifyApprovals', section: 'notifications', label: 'Approvals waiting', keywords: 'desktop notification alert approve proposal' },
  { key: 'notifyDisconnects', section: 'notifications', label: 'Unexpected disconnects', keywords: 'desktop notification alert dropped connection lost' },
  // Themes and fonts
  { key: 'themeLibrary', section: 'themes', label: 'Terminal palettes', keywords: 'browse preset theme dark light colours colors preview' },
  { key: 'themeGenerator', section: 'themes', label: 'Theme generator', keywords: 'oklch custom colours colors accent create' },
  { key: 'themeImport', section: 'themes', label: 'Import and export', keywords: 'itermcolors iterm2 json share theme' },
  { key: 'fontPreview', section: 'themes', label: 'Font preview', keywords: 'ligatures nerd font glyphs powerline' },
  // Keyboard
  { key: 'keymap', section: 'keyboard', label: 'Shortcuts', keywords: 'keybindings keymap hotkeys rebind' },
  // Credentials
  { key: 'credentials', section: 'credentials', label: 'Credential profiles', keywords: 'passwords keys username login' },
  // Security
  { key: 'vaultMode', section: 'security', label: 'Protection', keywords: 'vault keychain master password session-only' },
  { key: 'masterPassword', section: 'security', label: 'Master password', keywords: 'vault change password' },
  { key: 'autoLock', section: 'security', label: 'Auto-lock', keywords: 'vault idle lock minutes' },
  // Sync & export
  { key: 'configBackups', section: 'data', label: 'Config backups', keywords: 'running-config history diff schedule' },
  { key: 'exportFile', section: 'data', label: 'Export', keywords: 'backup file passphrase' },
  { key: 'importFile', section: 'data', label: 'Import from a file', keywords: 'restore hopline file' },
  { key: 'folderSync', section: 'data', label: 'Folder sync', keywords: 'sync dropbox git onedrive machines' },
  { key: 'importSessions', section: 'data', label: 'Sessions from other tools', keywords: 'import securecrt mobaxterm putty ssh_config csv' },
  { key: 'netbox', section: 'data', label: 'NetBox / Nautobot', keywords: 'source of truth inventory import sync' },
  { key: 'updateAutoCheck', section: 'updates', label: 'Automatic update checks', keywords: 'update upgrade new version auto check github' },
  { key: 'updateChannel', section: 'updates', label: 'Update channel', keywords: 'beta stable release channel' },
  { key: 'crashReports', section: 'crash', label: 'Send crash reports', keywords: 'crash report sentry telemetry privacy error' },
  { key: 'crashReportDsn', section: 'crash', label: 'Crash report server', keywords: 'dsn sentry glitchtip self-hosted' }
]

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]))

export const settingDef = (key: string): SettingDef | undefined => BY_KEY.get(key)

export const isSection = (s: string): s is SettingsSection => Object.hasOwn(SETTINGS_SECTIONS, s)

export const tabOfSection = (s: SettingsSection): SettingsTab => SETTINGS_SECTIONS[s].tab

/** Where a target lands: a tab, and maybe a row. */
export interface SettingsTarget {
  tab: SettingsTab
  section?: SettingsSection
  key?: string
}

/**
 * Resolve what `openSettings` was given: a setting key ("keepAliveSec"), a section
 * ("notifications"), a tab ("security"), or "section/key". Unknown targets open Workspace.
 */
export function resolveTarget(target: string | undefined): SettingsTarget {
  if (!target) return { tab: 'general' }
  const [a, b] = target.split('/')
  if (b !== undefined && a && isSection(a)) {
    const def = settingDef(b)
    return def && def.section === a ? { tab: tabOfSection(a), section: a, key: b } : { tab: tabOfSection(a), section: a }
  }
  const def = settingDef(target)
  if (def) return { tab: tabOfSection(def.section), section: def.section, key: def.key }
  if (isSection(target)) return { tab: tabOfSection(target), section: target }
  const tab = SETTINGS_TABS.find(([id]) => id === target)
  return { tab: tab ? tab[0] : 'general' }
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

export interface SettingHit {
  def: SettingDef
  /** Higher is better: label prefix > label word > section > keyword. */
  score: number
}

/**
 * Search every setting. Each word of the query must match the label, the section title or the
 * keywords; results are ordered by how well the label matches, then dialog order.
 */
export function searchSettings(query: string, extra: readonly SettingDef[] = []): SettingHit[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hits: SettingHit[] = []
  ;[...SETTINGS, ...extra].forEach((def, i) => {
    const label = norm(def.label)
    const section = norm(SETTINGS_SECTIONS[def.section].title)
    const keywords = norm(`${def.keywords ?? ''} ${def.key}`)
    let score = 0
    for (const w of words) {
      if (label.startsWith(w)) score += 8
      else if (label.split(/[\s/-]+/).some((x) => x.startsWith(w))) score += 6
      else if (label.includes(w)) score += 4
      else if (section.includes(w)) score += 2
      else if (keywords.includes(w)) score += 1
      else return
    }
    hits.push({ def, score: score * 1000 - i })
  })
  return hits.sort((a, b) => b.score - a.score)
}

/** `hopline://settings/<section>/<key>`: what a deep link asks for, or null if it is not one we accept. */
export type DeepLink = { kind: 'settings'; section?: SettingsSection; key?: string }

/**
 * Parse a `hopline://` URL from the OS. The URL is untrusted (any web page can launch one), so it
 * only ever navigates: settings sections and keys must be in the registry, nothing else is read.
 */
export function parseDeepLink(url: string): DeepLink | null {
  if (typeof url !== 'string' || url.length > 200) return null
  const m = /^hopline:\/\/settings(?:\/([a-z]{1,20})(?:\/([A-Za-z0-9]{1,40}))?)?\/?$/.exec(url.trim())
  if (!m) return null
  const [, section, key] = m
  if (!section) return { kind: 'settings' }
  if (!isSection(section)) return null
  if (!key) return { kind: 'settings', section }
  const def = settingDef(key)
  return def && def.section === section ? { kind: 'settings', section, key } : { kind: 'settings', section }
}
