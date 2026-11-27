import { isIpv4 } from '@hopline/cli-model'
import type { ParsedTable } from '@shared/productivity'

interface DeviceTable { name: string; table: ParsedTable }
type Row = ParsedTable['rows'][number]
interface MergedTable {
  headers: string[]
  rows: Row[]
  devices: number
  source?: string
  limited?: boolean
  defaultPaths?: number
}

const FORTI = 'fortinet_get_router_info_routing-table_all.textfsm'
const PAN = 'paloalto_panos_show_routing_route.textfsm'
const isRouteTable = (template: string) => template === FORTI || template === PAN
const asNumber = (ip: string) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0)

/** Convert one device at a time. Names may repeat across sessions. Keep every equal
 * longest-prefix path independently in each routing context of this session. */
function routeRows({ name, table }: DeviceTable, address: number | undefined): Row[] {
  const forti = table.template === FORTI
  const column = (header: string) => table.headers.indexOf(header)
  const context = column(forti ? 'VRF' : 'VIRTUAL_ROUTER')
  const prefix = column(forti ? 'DESTINATION' : 'NETWORK')
  const flags = column(forti ? 'TYPE' : 'FLAGS')
  const hop = column(forti ? 'GATEWAY' : 'NEXTHOP_IP')
  const iface = column(forti ? 'INTERFACE' : 'NEXTHOP_IF')
  const length = column('PREFIX_LENGTH')
  const all: Row[] = []
  const best = new Map<string, { bits: number; paths: Row[] }>()
  for (const r of table.rows) {
    const scope = String(r[context] ?? '')
    const destination = forti ? String(r[prefix]) : `${r[prefix]}/${r[length]}`
    const row = [name, forti ? 'FortiOS' : 'PAN-OS', scope, destination, r[flags]!, r[hop]!, r[iface]!]
    if (address === undefined) {
      all.push(row)
      continue
    }
    if (!scope || (!forti && !String(r[flags]).includes('A'))) continue
    const match = /^([^/]+)\/(\d{1,2})$/.exec(destination)
    if (!match || !isIpv4(match[1]!)) continue
    const bits = Number(match[2])
    if (bits > 32 || (bits > 0 && (asNumber(match[1]!) >>> (32 - bits)) !== (address >>> (32 - bits)))) continue
    const current = best.get(scope)
    if (!current || bits > current.bits) best.set(scope, { bits, paths: [row] })
    else if (bits === current.bits) current.paths.push(row)
  }
  return address === undefined ? all : Array.from(best.values()).flatMap((v) => v.paths)
}

/** Match native table schemas unless the selection contains both firewall route formats. */
export function mergeTables(list: DeviceTable[], template: string, destination = ''): MergedTable | null {
  if (isRouteTable(template)) {
    const routes = list.filter(({ table }) => isRouteTable(table.template))
    if (new Set(routes.map(({ table }) => table.template)).size === 2) {
      const address = destination.trim()
      const numeric = address && isIpv4(address) ? asNumber(address) : undefined
      const rows = address && numeric === undefined ? [] : routes.flatMap((t) => routeRows(t, numeric))
      return {
        headers: ['Device', 'Platform', 'Routing context', 'Destination', 'Route flags', 'Next hop / peer', 'Interface'],
        rows, devices: routes.length, source: 'Firewall routing tables',
        defaultPaths: numeric === undefined ? undefined : rows.filter((r) => String(r[3]).endsWith('/0')).length,
        limited: routes.some(({ table }) => (table.totalRows ?? table.rows.length) > table.rows.length)
      }
    }
  }
  const same = list.filter((x) => x.table.template === template)
  if (!same.length) return null
  const headers = same[0]!.table.headers
  const fit = same.filter((x) => x.table.headers.join('\0') === headers.join('\0'))
  return { headers: ['Device', ...headers], rows: fit.flatMap((x) => x.table.rows.map((r) => [x.name, ...r])), devices: fit.length }
}
