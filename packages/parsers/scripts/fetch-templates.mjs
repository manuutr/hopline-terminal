#!/usr/bin/env node
/**
 * Dev-time only: refresh the bundled ntc-templates subset. Never runs at build or run time.
 *
 *   node packages/parsers/scripts/fetch-templates.mjs                 # shallow-fetch the pinned commit
 *   node packages/parsers/scripts/fetch-templates.mjs /path/to/ntc-templates   # use a local checkout
 *
 * Copies the CURATED templates (pristine, never edited) to packages/parsers/templates/, their test
 * fixtures (raw + yml) to packages/parsers/test/fixtures/<platform>/<command>/, writes the index
 * rows of every mapped ntc platform (all rows, bundled or not, in original order: a command must
 * still match the template ntc would pick, and is reported as unsupported when that template is
 * not bundled), and generates src/index.generated.ts (index rows) and src/templates.generated.ts (texts) so nothing reads the filesystem at runtime.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NTC_REPO = 'https://github.com/networktocode/ntc-templates.git'
export const NTC_COMMIT = '06fa33389fbcca31cd59aac5fd5cb2ce5c900939'

/** ntc platforms whose index rows are kept (the ones PLATFORM_MAP in src/platforms.ts uses). */
const PLATFORMS = ['cisco_ios', 'cisco_nxos', 'cisco_xr', 'cisco_asa', 'cisco_wlc_ssh', 'cisco_s300', 'cisco_ftd', 'arista_eos', 'juniper_junos', 'paloalto_panos', 'fortinet', 'aruba_aoscx', 'huawei_vrp', 'mikrotik_routeros']

/** The curated set: the commands network engineers run most, Cisco first. Names without `.textfsm`. */
const CURATED = {
  cisco_ios: [
    'show_version', 'show_inventory', 'show_clock', 'show_users', 'show_logging', 'show_processes_cpu', 'show_processes_memory_sorted', 'show_redundancy', 'show_platform', 'show_license', 'show_boot', 'show_file_systems', 'dir',
    'show_interfaces', 'show_interfaces_status', 'show_interfaces_status_err-disabled', 'show_interfaces_description', 'show_interfaces_switchport', 'show_interface_transceiver', 'show_interface_link',
    'show_ip_interface_brief', 'show_ip_interface', 'show_ipv6_interface_brief', 'show_ip_vrf_interfaces', 'show_vrf', 'show_vrf_detail',
    'show_cdp_neighbors', 'show_cdp_neighbors_detail', 'show_lldp_neighbors', 'show_lldp_neighbors_detail',
    'show_vlan', 'show_vlans', 'show_vtp_status', 'show_mac-address-table', 'show_spanning-tree', 'show_spanning-tree_root', 'show_etherchannel_summary', 'show_port-security_interface_interface', 'show_power_inline', 'show_environment_temperature', 'show_power_supplies',
    'show_ip_arp', 'show_arp', 'show_ipv6_neighbors', 'show_ip_route', 'show_ip_route_summary', 'show_ipv6_route', 'show_ip_cef', 'show_adjacency',
    'show_ip_bgp', 'show_ip_bgp_summary', 'show_ip_bgp_neighbors', 'show_ip_bgp_vpnv4_all_neighbors', 'show_ip_ospf_neighbor', 'show_ip_ospf_neighbor_detail', 'show_ip_ospf_interface_brief', 'show_ip_ospf_database', 'show_ip_eigrp_neighbors', 'show_ip_eigrp_topology', 'show_isis_neighbors', 'show_bfd_neighbors_details',
    'show_standby', 'show_standby_brief', 'show_vrrp_all', 'show_vrrp_brief', 'show_ip_mroute',
    'show_access-list', 'show_ip_access-lists', 'show_ipv6_access-lists', 'show_ip_prefix-list', 'show_route-map', 'show_object-group', 'show_policy-map', 'show_ip_nat_translations',
    'show_ip_dhcp_binding', 'show_ip_dhcp_snooping_binding', 'show_ip_source_binding', 'show_ip_device_tracking_all', 'show_authentication_sessions', 'show_access-session', 'show_dot1x_all',
    'show_mpls_interfaces', 'show_mpls_l2transport_vc', 'show_dmvpn', 'show_crypto_session_detail', 'show_snmp_community', 'show_tacacs', 'show_hosts_summary', 'show_archive',
    'show_ap_summary', 'show_ap_cdp_neighbors', 'show_wireless_tag_policy_summary', 'ping', 'traceroute'
  ],
  cisco_nxos: [
    'show_version', 'show_inventory', 'show_module', 'show_clock', 'show_hostname', 'show_feature', 'show_environment', 'show_environment_temperature', 'show_processes_cpu', 'show_license_usage', 'show_vdc', 'dir',
    'show_interface', 'show_interface_brief', 'show_interface_status', 'show_interface_status_err-disabled', 'show_interface_description', 'show_interface_switchport', 'show_interface_transceiver',
    'show_ip_interface', 'show_ip_interface_brief', 'show_ip_interface_vrf_all', 'show_ipv6_interface_brief', 'show_vrf', 'show_vrf_interface',
    'show_cdp_neighbors', 'show_cdp_neighbors_detail', 'show_lldp_neighbors_detail',
    'show_vlan', 'show_mac_address-table', 'show_spanning-tree_root', 'show_port-channel_summary', 'show_vpc', 'show_fex',
    'show_ip_arp', 'show_ip_arp_detail', 'show_ip_route', 'show_ip_bgp', 'show_ip_bgp_summary', 'show_ip_bgp_summary_vrf', 'show_ip_bgp_neighbors', 'show_ip_ospf_neighbor', 'show_ip_ospf_interface_brief', 'show_ip_ospf_database', 'show_ip_eigrp_neighbors', 'show_bfd_neighbors', 'show_hsrp_all',
    'show_access-lists', 'show_route-map', 'show_nve_peers', 'show_nve_vni'
  ],
  cisco_xr: [
    'show_version', 'show_version_brief', 'admin_show_inventory', 'show_redundancy_summary', 'show_install_active', 'show_processes_cpu', 'show_configuration_commit_list', 'dir',
    'show_interfaces', 'show_interface_brief', 'show_interfaces_description', 'show_interfaces_summary', 'show_ip_interface_brief', 'show_ipv4_interface', 'show_ipv4_vrf_all_interface_brief', 'show_vrf_all_detail',
    'show_cdp_neighbors_detail', 'show_lldp_neighbors', 'show_lldp_neighbors_detail', 'show_arp', 'show_ipv6_neighbors', 'show_ip_route',
    'show_bgp', 'show_bgp_neighbors', 'show_bgp_instance_all_summary', 'show_bgp_vrf_all_ipv4_unicast_summary', 'show_ip_bgp_summary', 'show_ospf_neighbor', 'show_ospf_vrf_all_neighbor', 'show_isis_neighbors', 'show_mpls_ldp_neighbor_brief', 'show_bfd_sessions', 'show_hsrp', 'ping'
  ],
  cisco_asa: [
    'show_version', 'show_inventory', 'show_failover', 'show_cpu_usage_detailed', 'show_resource_usage', 'show_logging', 'show_license_all', 'dir',
    'show_interface', 'show_interface_ip_brief', 'show_interface_detail', 'show_port-channel_summary', 'show_arp', 'show_route', 'show_ospf_neighbor', 'show_bgp_summary',
    'show_access-list', 'show_access-list_brief', 'show_nat', 'show_xlate', 'show_name', 'show_object-group_network', 'show_asp_drop',
    'show_crypto_ipsec_sa', 'show_crypto_ikev1_sa_detail', 'show_vpn-sessiondb', 'show_vpn-sessiondb_anyconnect', 'show_vpn-sessiondb_detail_l2l', 'ping'
  ],
  cisco_wlc_ssh: [
    'show_sysinfo', 'show_inventory', 'show_time', 'show_boot', 'show_ap_summary', 'show_ap_config_general', 'show_ap_image_all', 'show_wlan_sum', 'show_client_detail', 'show_interface_summary', 'show_interface_detailed_id', 'show_port_summary', 'show_cdp_neighbors_detail', 'show_redundancy_summary', 'show_mobility_sum', 'show_radius_summary', 'show_tacacs_summary', 'show_exclusionlist', 'show_flexconnect_group_summary', 'show_rf-profile_summary'
  ],
  cisco_s300: ['show_version', 'show_system', 'show_interfaces_status', 'show_interfaces_description', 'show_interfaces_switchport', 'show_ip_interface', 'show_lldp_neighbors', 'show_mac_address-table', 'show_vlan'],
  cisco_ftd: ['show_vpn-sessiondb_anyconnect'],
  arista_eos: [
    'show_version', 'show_inventory', 'show_module', 'show_clock', 'show_hostname', 'show_reload_cause', 'show_processes_top_once', 'show_environment_temperature', 'show_environment_power', 'show_environment_cooling', 'show_boot-config', 'dir',
    'show_interfaces', 'show_interfaces_status', 'show_interfaces_description', 'show_interfaces_transceiver', 'show_ip_interface_brief', 'show_vrf',
    'show_lldp_neighbors', 'show_lldp_neighbors_detail', 'show_vlan', 'show_mac_address-table', 'show_port-channel_summary', 'show_mlag',
    'show_ip_arp', 'show_ip_route', 'show_ip_bgp', 'show_ip_bgp_summary', 'show_ipv6_bgp_summary', 'show_ip_ospf_neighbor', 'show_ip_ospf_interface_brief', 'show_isis_neighbors',
    'show_ip_access-lists', 'show_snmp_community'
  ],
  juniper_junos: [
    'show_version', 'show_chassis_hardware', 'show_chassis_firmware', 'show_system_uptime', 'show_system_processes_summary', 'show_chassis_cluster_status', 'show_chassis_cluster_interfaces',
    'show_interfaces', 'show_lldp_neighbors', 'show_lacp_interfaces', 'show_vlans', 'show_ethernet-switching_table', 'show_ethernet-switching_interfaces',
    'show_arp_no-resolve', 'show_route_summary', 'show_bgp_summary', 'show_ospf_neighbor', 'show_isis_adjacency', 'show_rsvp_interface'
  ],
  paloalto_panos: ['show_system_info', 'show_interface_all', 'show_interface_logical', 'show_interface_hardware', 'show_arp_all', 'show_mac_all', 'show_routing_route', 'show_routing_protocol_bgp_summary', 'show_high-availability_all', 'show_lldp_neighbors_all', 'show_jobs_all', 'show_counter_global', 'show_running_security-policy', 'show_running_nat-policy'],
  fortinet: ['get_system_status', 'get_system_interface', 'get_system_interface_physical', 'get_system_arp', 'get_system_ha_status', 'get_router_info_routing-table_all', 'get_router_info_bgp_summary', 'get_router_info_bgp_neighbors', 'get_router_info_ospf_status', 'get_hardware_nic', 'execute_dhcp_lease-list'],
  aruba_aoscx: ['show_system', 'show_module', 'show_interface', 'show_vlan', 'show_vrf', 'show_mac-address-table', 'show_arp_all-vrfs', 'show_ip_route_all-vrfs', 'show_bgp_all-vrfs_all_summary', 'show_lldp_neighbors-info_detail', 'show_ntp_associations', 'show_vsf_detail'],
  huawei_vrp: ['display_version', 'display_device', 'display_interface', 'display_interface_brief', 'display_interface_description', 'display_ip_vpn-instance', 'display_arp_all', 'display_mac-address', 'display_lldp_neighbor', 'display_eth-trunk', 'display_port_vlan', 'display_vlan_brief', 'display_bgp_peer', 'display_isis_peer', 'display_ntp_status', 'display_acl_all', 'display_ip_routing-table_verbose'],
  mikrotik_routeros: ['system_resource_print', 'system_identity_print', 'system_routerboard_print', 'system_clock_print', 'interface_print_brief', 'interface_print_detail', 'ip_address_print', 'ip_arp_print', 'ip_route_print_detail', 'ip_neighbor_print_detail', 'routing_ospf_neighbor_print', 'routing_bgp_peer_print_status', 'user_active_print']
}

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')

function checkout(arg) {
  if (arg) return { dir: resolve(arg), cleanup: () => {} }
  const tmp = mkdtempSync(join(tmpdir(), 'ntc-templates-'))
  execFileSync('git', ['init', '-q', tmp])
  execFileSync('git', ['-C', tmp, 'remote', 'add', 'origin', NTC_REPO])
  execFileSync('git', ['-C', tmp, 'fetch', '-q', '--depth', '1', 'origin', NTC_COMMIT])
  execFileSync('git', ['-C', tmp, 'checkout', '-q', 'FETCH_HEAD'])
  return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function main() {
  const { dir, cleanup } = checkout(process.argv[2])
  try {
    try {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim()
      if (head !== NTC_COMMIT) console.warn(`warning: checkout is at ${head}, pinned commit is ${NTC_COMMIT}`)
    } catch {
      console.warn('warning: not a git checkout; cannot verify the pinned commit')
    }
    const tdir = join(dir, 'ntc_templates', 'templates')
    const outT = join(pkg, 'templates')
    const outF = join(pkg, 'test', 'fixtures')
    rmSync(outT, { recursive: true, force: true })
    rmSync(outF, { recursive: true, force: true })
    mkdirSync(outT, { recursive: true })
    mkdirSync(outF, { recursive: true })

    const bundled = {}
    let fixtures = 0
    for (const [plat, names] of Object.entries(CURATED)) {
      for (const name of names) {
        const file = `${plat}_${name}.textfsm`
        const src = join(tdir, file)
        if (!existsSync(src)) throw new Error(`curated template missing upstream: ${file}`)
        bundled[file] = readFileSync(src, 'utf8')
        cpSync(src, join(outT, file))
        const fx = join(dir, 'tests', plat, name)
        if (existsSync(fx)) {
          for (const f of readdirSync(fx)) {
            if (!/\.(raw|yml)$/.test(f)) continue
            mkdirSync(join(outF, plat, name), { recursive: true })
            cpSync(join(fx, f), join(outF, plat, name, f))
            if (f.endsWith('.raw')) fixtures++
          }
        } else console.warn(`no fixtures for ${file}`)
      }
    }

    // Index rows of the mapped platforms, in order. Same reading as textfsm's CsvToTable: '#' lines
    // are comments, fields are comma-separated and stripped, rows with the wrong field count dropped.
    const lines = readFileSync(join(tdir, 'index'), 'utf8').split('\n')
    let header = null
    const rows = []
    for (const line of lines) {
      if (!header) {
        const h = line.split('#')[0].trim()
        if (h) header = h.split(',').map((s) => s.trim())
        continue
      }
      if (line.startsWith('#')) continue
      const f = line.split(',').map((s) => s.trim())
      if (f.length !== header.length) continue
      const row = Object.fromEntries(header.map((k, i) => [k, f[i]]))
      // The Platform column is a regex (`cisco_(asa|ftd)`), matched like Python re.match.
      const plat = new RegExp(`^(?:${row.Platform})`)
      if (!PLATFORMS.some((p) => plat.test(p))) continue
      rows.push([row.Template, row.Hostname, row.Platform, row.Command])
    }
    writeFileSync(join(outT, 'index'), `# Generated by scripts/fetch-templates.mjs from ntc-templates ${NTC_COMMIT}.\n# All rows of the mapped platforms (bundled or not), in upstream order.\nTemplate, Hostname, Platform, Command\n\n${rows.map((r) => r.join(', ')).join('\n')}\n`)

    cpSync(join(dir, 'LICENSE'), join(pkg, 'templates', 'LICENSE'))
    writeFileSync(
      join(pkg, 'templates', 'NOTICE'),
      `The TextFSM templates and test fixtures in this package are from ntc-templates\n(${NTC_REPO.replace(/\.git$/, '')}), commit ${NTC_COMMIT}.\n\nCopyright 2015 Jason Edelman <jason@networktocode.com>, Network to Code, LLC, and contributors.\nLicensed under the Apache License, Version 2.0 (see LICENSE in this directory).\n\nThe templates are bundled unmodified. A curated subset is included; see scripts/fetch-templates.mjs.\n`
    )

    const head = `// GENERATED by scripts/fetch-templates.mjs from ntc-templates ${NTC_COMMIT}. Do not edit.
// Templates: Apache-2.0, (c) Network to Code, LLC and contributors (see templates/NOTICE).
/* eslint-disable */
`
    const genIndex = `${head}
export const NTC_COMMIT = ${JSON.stringify(NTC_COMMIT)}

/** Index rows (Template, Hostname, Platform, Command) of the mapped platforms, upstream order. */
export const INDEX_ROWS: readonly (readonly [string, string, string, string])[] = ${JSON.stringify(rows)}

/** File names of the bundled templates (texts are in templates.generated.ts). */
export const BUNDLED: ReadonlySet<string> = new Set(${JSON.stringify(Object.keys(bundled))})
`
    const gen = `${head}
/** Bundled template texts by file name. Import only where parsing runs (e.g. a worker). */
export const TEMPLATES: Readonly<Record<string, string>> = ${JSON.stringify(bundled, null, 0)}
`
    writeFileSync(join(pkg, 'src', 'index.generated.ts'), genIndex)
    writeFileSync(join(pkg, 'src', 'templates.generated.ts'), gen)
    rmSync(join(pkg, 'src', 'bundled.generated.ts'), { force: true })
    console.log(`bundled ${Object.keys(bundled).length} templates, ${fixtures} fixtures, ${rows.length} index rows; generated ${Math.round(gen.length / 1024)} + ${Math.round(genIndex.length / 1024)} KB`)
  } finally {
    cleanup()
  }
}

main()
