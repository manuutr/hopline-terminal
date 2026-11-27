// electron-vite: `?asset` imports resolve to the file's path at runtime (copied into out/).
declare module '*?asset' {
  const path: string
  export default path
}

/** Compiled out of production main, preload and renderer bundles. */
declare const __HOPLINE_DEV_LAB__: boolean
