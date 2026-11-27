/**
 * Serial port enumeration with friendly names for common USB-serial chips and console cables,
 * plus polling-based replug detection (there is no cross-platform hot-plug event).
 */
import type { SerialBinding, SerialPortInfo } from './serial'

export interface SerialPortEntry {
  path: string
  label: string
  manufacturer?: string
  /** Lowercase 4-hex, e.g. `0403`. */
  vendorId?: string
  /** Lowercase 4-hex, e.g. `6001`. */
  productId?: string
  serialNumber?: string
  isUsb: boolean
}

interface VendorEntry {
  name: string
  products?: Record<string, string>
}

/**
 * USB vendor/product ids (lowercase hex) of chips found in console cables. Arista and Juniper ship
 * generic FTDI/Prolific/Silicon Labs cables with no ids of their own, so those are recognised by
 * the manufacturer string instead (see MANUFACTURER_HINTS).
 */
export const USB_SERIAL_IDS: Record<string, VendorEntry> = {
  '0403': {
    name: 'FTDI',
    products: { '6001': 'FT232R', '6010': 'FT2232', '6011': 'FT4232', '6014': 'FT232H', '6015': 'FT-X' }
  },
  '067b': {
    name: 'Prolific',
    products: { '2303': 'PL2303', '23a3': 'PL2303GC', '23b3': 'PL2303GB', '23c3': 'PL2303GT', '23d3': 'PL2303GL', '23e3': 'PL2303GE', '23f3': 'PL2303GS' }
  },
  '10c4': { name: 'Silicon Labs', products: { ea60: 'CP210x', ea70: 'CP2105', ea71: 'CP2108' } },
  '1a86': { name: 'WCH', products: { '7523': 'CH340', '7522': 'CH340K', '5523': 'CH341', '55d4': 'CH9102', '55d3': 'CH343' } },
  '05a6': { name: 'Cisco', products: { '0001': 'USB console' } }
}

/** Manufacturer substrings (lowercase) that identify the console cable/device vendor. */
const MANUFACTURER_HINTS: [needle: string, label: string][] = [
  ['cisco', 'Cisco USB console'],
  ['juniper', 'Juniper console cable'],
  ['arista', 'Arista console cable']
]

function normId(id: string | undefined): string | undefined {
  if (!id) return undefined
  const hex = id.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{1,4}$/.test(hex)) return undefined
  return hex.padStart(4, '0')
}

function shortPath(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return path
  return path.replace(/^\/dev\//, '')
}

/** Friendly chip/cable name for a port, or undefined for an unrecognised one. */
export function friendlyName(vendorId: string | undefined, productId: string | undefined, manufacturer: string | undefined): string | undefined {
  const m = manufacturer?.toLowerCase() ?? ''
  for (const [needle, label] of MANUFACTURER_HINTS) if (m.includes(needle)) return label
  const vid = normId(vendorId)
  const pid = normId(productId)
  const vendor = vid ? USB_SERIAL_IDS[vid] : undefined
  if (!vendor) return undefined
  if (vid === '05a6') return 'Cisco USB console'
  const product = pid ? vendor.products?.[pid] : undefined
  return product ? `${vendor.name} ${product}` : `${vendor.name} USB-serial`
}

function looksUsb(p: SerialPortInfo): boolean {
  if (p.vendorId || p.productId) return true
  if (p.pnpId && /usb/i.test(p.pnpId)) return true
  return /ttyUSB|ttyACM|usbserial|usbmodem|SLAB_USB|wchusbserial/i.test(p.path)
}

/**
 * Pure: turns raw binding `list()` output into labelled, de-duplicated, sorted entries.
 * On macOS the binding reports the dial-in `/dev/tty.*` nodes; we use the call-out `/dev/cu.*`
 * twin, which opens without waiting for carrier detect.
 */
export function labelSerialPorts(ports: SerialPortInfo[], platform: NodeJS.Platform = process.platform): SerialPortEntry[] {
  const byPath = new Map<string, SerialPortEntry>()
  for (const p of ports) {
    const path = platform === 'darwin' ? p.path.replace(/^\/dev\/tty\./, '/dev/cu.') : p.path
    const vendorId = normId(p.vendorId)
    const productId = normId(p.productId)
    const manufacturer = p.manufacturer?.trim() || undefined
    const name = friendlyName(vendorId, productId, manufacturer) ?? manufacturer ?? 'Serial port'
    const entry: SerialPortEntry = { path, label: `${name} (${shortPath(path, platform)})`, isUsb: looksUsb(p) }
    if (manufacturer) entry.manufacturer = manufacturer
    if (vendorId) entry.vendorId = vendorId
    if (productId) entry.productId = productId
    const serialNumber = p.serialNumber?.trim()
    if (serialNumber) entry.serialNumber = serialNumber
    const prev = byPath.get(path)
    // A cu/tty pair collapses into one entry; keep the one with more metadata.
    if (!prev || (!prev.vendorId && entry.vendorId)) byPath.set(path, entry)
  }
  return [...byPath.values()].sort((a, b) => Number(b.isUsb) - Number(a.isUsb) || a.path.localeCompare(b.path, undefined, { numeric: true }))
}

async function resolveBinding(binding?: SerialBinding): Promise<SerialBinding> {
  if (binding) return binding
  const { SerialPort } = await import('serialport')
  return SerialPort.binding as SerialBinding
}

export interface ListOptions {
  /** Injected for tests; defaults to the native binding from `serialport`. */
  binding?: SerialBinding
  platform?: NodeJS.Platform
}

export async function listSerialPorts(opts: ListOptions = {}): Promise<SerialPortEntry[]> {
  const binding = await resolveBinding(opts.binding)
  return labelSerialPorts(await binding.list(), opts.platform)
}

/**
 * Polls `listSerialPorts()` every `intervalMs` and calls `onChange` with the full list whenever the
 * set of ports changes (and once with the initial list). Returns a function that stops polling.
 * Poll only while a port picker is open or a session waits for its adapter to come back.
 */
export function watchSerialPorts(
  onChange: (ports: SerialPortEntry[]) => void,
  intervalMs = 2000,
  opts: ListOptions & { onError?: (err: unknown) => void } = {}
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: string | undefined

  const tick = async (): Promise<void> => {
    try {
      const ports = await listSerialPorts(opts)
      const sig = JSON.stringify(ports.map(p => [p.path, p.serialNumber ?? '', p.vendorId ?? '', p.productId ?? '']))
      if (!stopped && sig !== last) {
        last = sig
        onChange(ports)
      }
    } catch (err) {
      opts.onError?.(err)
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs)
      timer.unref?.()
    }
  }
  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
