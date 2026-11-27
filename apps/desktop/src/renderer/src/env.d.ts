/// <reference types="vite/client" />
import type { HoplineApi } from '@shared/types'

declare global {
  /** App version, injected at build time (electron.vite.config.ts). */
  const __APP_VERSION__: string
  interface Window {
    hopline: HoplineApi
  }
}
export {}
