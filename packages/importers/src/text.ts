/**
 * Decode an import file's bytes. PuTTY's regedit exports are UTF-16LE with a BOM,
 * SecureCRT writes UTF-8 (often with a BOM) and MobaXterm writes Windows-1252.
 * Order: BOM, then strict UTF-8, then Windows-1252.
 */
export function decodeText(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2))
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3))
  // UTF-16LE without a BOM: ASCII text with every other byte zero.
  if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return new TextDecoder('utf-16le').decode(b)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return new TextDecoder('windows-1252').decode(b)
  }
}

export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

export const splitLines = (s: string) => stripBom(s).split(/\r\n|\r|\n/)

/** Hard limit for any one input, so a hostile file can't stall the renderer. */
export const MAX_INPUT_CHARS = 32 * 1024 * 1024

export function checkSize(text: string, what: string) {
  if (text.length > MAX_INPUT_CHARS) throw new Error(`${what} is too large to import (${Math.round(text.length / 1048576)} MB)`)
}

/**
 * Look up an input-derived key in a constant table. Plain `table[key]` finds
 * inherited members too: "constructor" or "__proto__" would return Object or
 * its prototype, which `structuredClone` (and so IPC) can't copy.
 */
export const lookup = <V>(table: Readonly<Record<string, V>>, key: string): V | undefined => (Object.hasOwn(table, key) ? table[key] : undefined)
