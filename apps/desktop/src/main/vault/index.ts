import { safeStorage } from 'electron'
import type { Keychain } from './vault'

/**
 * The OS keychain via Electron safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux). It only ever seals the 32-byte data key; secrets themselves are
 * encrypted under that key (see vault.ts). Decrypted values only ever live in the main process.
 */
function backend(): string {
  return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'win32' ? 'dpapi' : 'keychain'
}

export const osKeychain: Keychain = {
  backend,
  // Linux "basic_text" means a hard-coded key: as good as plain text, so it doesn't count.
  available: async () => (await safeStorage.isAsyncEncryptionAvailable()) && !['basic_text', 'unknown'].includes(backend()),
  seal: async (p) => safeStorage.encryptStringAsync(p.toString('base64')),
  unseal: async (b) => Buffer.from((await safeStorage.decryptStringAsync(b)).result, 'base64')
}

/**
 * e2e on machines without a keyring (CI, WSL): a stand-in keychain that "seals" nothing.
 * Dev builds only (main checks app.isPackaged), and only in throwaway test profiles.
 */
export const testKeychain: Keychain = {
  backend: () => 'e2e-memory',
  available: async () => true,
  seal: async (p) => Buffer.from(p),
  unseal: async (b) => Buffer.from(b)
}

/** e2e: a machine with no keychain at all (Linux without a keyring). Dev builds only, like testKeychain. */
export const noKeychain: Keychain = {
  backend: () => 'basic_text',
  available: async () => false,
  seal: async () => {
    throw new Error('No secure OS keychain on this machine')
  },
  unseal: async () => {
    throw new Error('No secure OS keychain on this machine')
  }
}

/** Pre-DEK secrets were sealed one by one with safeStorage: read them for the one-time migration. */
export async function legacyUnseal(blob: Buffer): Promise<string | undefined> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return undefined
  return (await safeStorage.decryptStringAsync(blob)).result
}
