/** An IPC error as a sentence fragment, without Electron's "Error invoking remote method …" prefix. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
}
