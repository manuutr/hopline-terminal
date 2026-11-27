// Untyped ssh2@1.17.0 internals used by the legacy shims and the "break" request. ssh2 is pinned
// exactly in package.json because these are not public API.
declare module 'ssh2/lib/protocol/constants.js' {
  const constants: {
    SUPPORTED_KEX: string[]
    SUPPORTED_SERVER_HOST_KEY: string[]
    SUPPORTED_CIPHER: string[]
    SUPPORTED_MAC: string[]
    DEFAULT_KEX: string[]
    DEFAULT_SERVER_HOST_KEY: string[]
    DEFAULT_CIPHER: string[]
    DEFAULT_MAC: string[]
  }
  export default constants
}

declare module 'ssh2/lib/protocol/utils.js' {
  const utils: {
    sendPacket(proto: unknown, packet: Buffer, bypass?: boolean): boolean
  }
  export default utils
}
