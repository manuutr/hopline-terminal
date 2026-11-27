/**
 * Hopline platform ids (cli-model `PlatformId`, plus the simulator-only `routeros`) → the
 * ntc-templates platform directories whose templates apply, tried in order.
 */
export const PLATFORM_MAP: Readonly<Record<string, readonly string[]>> = {
  ios: ['cisco_ios'],
  // ntc keeps IOS-XE under cisco_ios (there is no cisco_xe directory).
  iosxe: ['cisco_ios'],
  nxos: ['cisco_nxos'],
  iosxr: ['cisco_xr'],
  asa: ['cisco_asa'],
  // Catalyst 9800 runs IOS-XE: cisco_ios has its wireless templates (show ap summary, ...).
  c9800: ['cisco_ios'],
  aireos: ['cisco_wlc_ssh'],
  ciscosb: ['cisco_s300'],
  // FTD's CLI is ASA's for most show commands; ntc has one FTD-specific template.
  ftd: ['cisco_ftd', 'cisco_asa'],
  eos: ['arista_eos'],
  junos: ['juniper_junos'],
  panos: ['paloalto_panos'],
  fortios: ['fortinet'],
  aoscx: ['aruba_aoscx'],
  vrp: ['huawei_vrp'],
  routeros: ['mikrotik_routeros']
}
