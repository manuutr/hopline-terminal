/**
 * Monaco, bundled (no CDN) and loaded lazily: only this chunk pulls it in, on the first diff.
 * Just the editor core plus the diff editor, folding, sticky scroll and find: no language
 * services, one editor worker (same origin, so the `script-src 'self'` CSP allows it).
 */
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/diffEditor/register'
import 'monaco-editor/features/folding/register'
import 'monaco-editor/features/stickyScroll/register'
import 'monaco-editor/features/find/register'
import 'monaco-editor/features/codicon/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { stanzas, stanzaStyle } from '@shared/config-text'

;(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() }

export const LANG = 'hopline-config'

/** The platform each model's text came from, for the stanza style (Junos braces vs `display set`, …). */
const platformOf = new WeakMap<monaco.editor.ITextModel, string>()

monaco.languages.register({ id: LANG })
monaco.languages.setMonarchTokensProvider(LANG, {
  tokenizer: {
    root: [
      [/^\s*[!#].*$/, 'comment'],
      [/^\s*(?:no\s+)?(?:interface|router|vlan|vrf|line|policy-map|class-map|route-map|ip access-list|ipv6 access-list|crypto|aaa|address-family|config|edit|set|delete)\b/, 'keyword'],
      [/<redacted>/, 'redacted'],
      [/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/, 'number'],
      [/"[^"]*"/, 'string'],
      [/[{};]/, 'delimiter']
    ]
  }
})
monaco.languages.registerFoldingRangeProvider(LANG, {
  provideFoldingRanges: (model) => {
    const lines = model.getLinesContent()
    const style = stanzaStyle(model.getValue(), platformOf.get(model))
    return stanzas(lines, style).map((s) => ({ start: s.start + 1, end: s.end + 1 }))
  }
})

const base = (dark: boolean): monaco.editor.IStandaloneThemeData => ({
  base: dark ? 'vs-dark' : 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: dark ? '808994' : '5f6875' },
    { token: 'keyword', foreground: dark ? '3dd6bd' : '087265', fontStyle: 'bold' },
    { token: 'number', foreground: dark ? 'f0b44c' : '865600' },
    { token: 'string', foreground: dark ? '9ad1ff' : '1f5fa8' },
    { token: 'redacted', foreground: dark ? 'f26b6f' : 'bb2d33', fontStyle: 'italic' }
  ],
  colors: dark
    ? {
        'editor.background': '#0a0c0f',
        'editor.foreground': '#e6e9ed',
        'editorLineNumber.foreground': '#5b636d',
        'editorLineNumber.activeForeground': '#9aa3ad',
        'editor.lineHighlightBackground': '#ffffff08',
        'editorStickyScroll.background': '#151a20',
        'editorStickyScrollHover.background': '#1b2028',
        'diffEditor.insertedLineBackground': '#4ad6851a',
        'diffEditor.insertedTextBackground': '#4ad68540',
        'diffEditor.removedLineBackground': '#f26b6f1a',
        'diffEditor.removedTextBackground': '#f26b6f40',
        'diffEditor.border': '#ffffff1f',
        'scrollbarSlider.background': '#ffffff1a'
      }
    : {
        'editor.background': '#ffffff',
        'editor.foreground': '#0f1419',
        'editorLineNumber.foreground': '#8a929c',
        'editor.lineHighlightBackground': '#0f141e08',
        'editorStickyScroll.background': '#f3f4f6',
        'diffEditor.insertedLineBackground': '#13733c14',
        'diffEditor.insertedTextBackground': '#13733c33',
        'diffEditor.removedLineBackground': '#bb2d3314',
        'diffEditor.removedTextBackground': '#bb2d3333',
        'diffEditor.border': '#0f141e29'
      }
})
monaco.editor.defineTheme('hopline-dark', base(true))
monaco.editor.defineTheme('hopline-light', base(false))

export function makeModel(text: string, platform: string): monaco.editor.ITextModel {
  const m = monaco.editor.createModel(text, LANG)
  platformOf.set(m, platform)
  return m
}

export { monaco }
