// `@serialport/binding-mock` ships types, but its `exports` map hides them from
// `moduleResolution: "Bundler"` (TS7016). This declares the subset the tests use.
declare module '@serialport/binding-mock' {
  export interface CreatePortOptions {
    echo?: boolean
    record?: boolean
    readyData?: Buffer
    maxReadSize?: number
    manufacturer?: string
    vendorId?: string
    productId?: string
  }
  export interface MockPortBinding {
    isOpen: boolean
    lastWrite: Buffer | null
    readonly openOptions: {
      path: string
      baudRate: number
      dataBits: number
      stopBits: number
      parity: string
      rtscts: boolean
      xon: boolean
      xoff: boolean
      xany: boolean
      hupcl: boolean
      lock: boolean
    }
    emitData(data: Buffer | string): void
    read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }>
    write(buffer: Buffer): Promise<void>
    set(options: { brk?: boolean; cts?: boolean; dsr?: boolean; dtr?: boolean; rts?: boolean }): Promise<void>
    close(): Promise<void>
  }
  export const MockBinding: {
    list(): Promise<
      {
        path: string
        manufacturer: string | undefined
        serialNumber: string | undefined
        pnpId: string | undefined
        locationId: string | undefined
        productId: string | undefined
        vendorId: string | undefined
      }[]
    >
    open(options: { path: string; baudRate: number } & Record<string, unknown>): Promise<MockPortBinding>
    createPort(path: string, opt?: CreatePortOptions): void
    reset(): void
  }
}
