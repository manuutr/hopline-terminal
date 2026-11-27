/**
 * Scripted test devices and the executor's typing protocol: the executor sends the line-clear key,
 * then the command without Enter, waits for its echo, then sends Enter. Scripted devices answer whole
 * lines (`show clock\r`), so this adapter plays the line editor: it drops the clear key, echoes the
 * typed command at once, and hands the device the whole line when Enter comes. `sent` keeps listing
 * the logical writes (`show clock\r`, `' '`, `'\x03'`), as the scripts were written for.
 */
export type Typed = { echo: string } | { send: string; echoed: string } | null

export function typingAdapter(): (data: string) => Typed {
  let line = ''
  return (data) => {
    if (data === '\x15' || data === '\x05\x15') return null
    // A command is typed in one write; single keys (pager space, `q`, answers) pass through.
    if (!line && data.length > 1 && /^[\x20-\x7e]+$/.test(data)) {
      line = data
      return { echo: data }
    }
    if (data === '\r' && line) {
      const l = line
      line = ''
      return { send: `${l}\r`, echoed: l }
    }
    return { send: data, echoed: '' }
  }
}

/** The scripted reply without the echo the adapter already printed. */
export const withoutEcho = (out: string, echoed: string): string => (echoed && out.startsWith(echoed) ? out.slice(echoed.length) : out)
