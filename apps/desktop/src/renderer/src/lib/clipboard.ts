/**
 * The renderer's only way to the clipboard. In an e2e run (dev build, `hopline.testMode`) it is an
 * in-memory stand-in, so tests never read or overwrite the user's real clipboard (on WSLg it is
 * shared with Windows). Tests set and read it through `__hoplineTest.clipboard`.
 */
let mem: string | null = null
const testMode = (): boolean => !!(window as { hopline?: { testMode?: boolean } }).hopline?.testMode

export function readClipboard(): Promise<string> {
  if (testMode()) return Promise.resolve(mem ?? '')
  return navigator.clipboard.readText()
}

export function writeClipboard(text: string): Promise<void> {
  if (testMode()) {
    mem = text
    return Promise.resolve()
  }
  return navigator.clipboard.writeText(text)
}

/** e2e only: the stand-in clipboard. Absent outside test mode. */
export const testClipboard = {
  get: (): string => mem ?? '',
  set: (text: string): void => {
    if (testMode()) mem = text
  }
}
