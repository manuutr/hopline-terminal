import type { PlatformId } from './types'

/**
 * The read-only command that prints a platform's whole running configuration, for config backups.
 * Every entry must classify as `read` with @hopline/guard (packages/guard/test/backup.test.ts).
 *
 * - Junos: `display set` gives one line per statement, which diffs far better than the brace tree.
 * - PAN-OS: the running config as XML (`format set` is not on every release).
 * - FortiOS: `show` prints the non-default configuration (`show full-configuration` is many MB).
 * - AireOS: `show run-config commands` is the CLI form (`show run-config` is a long report).
 */
export const BACKUP_COMMANDS: Readonly<Record<PlatformId, string>> = {
  ios: 'show running-config',
  iosxe: 'show running-config',
  nxos: 'show running-config',
  iosxr: 'show running-config',
  asa: 'show running-config',
  c9800: 'show running-config',
  aireos: 'show run-config commands',
  ciscosb: 'show running-config',
  ftd: 'show running-config',
  eos: 'show running-config',
  junos: 'show configuration | display set',
  panos: 'show config running',
  fortios: 'show',
  aoscx: 'show running-config',
  vrp: 'display current-configuration'
}
