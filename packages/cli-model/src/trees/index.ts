import type { TreeSource } from '../dsl'
import type { ModeId, PlatformId } from '../types'
import { AIREOS_TREES } from './aireos'
import { AOSCX_TREES } from './aoscx'
import { VRP_TREES } from './vrp'
import { ASA_TREES } from './asa'
import { C9800_TREES, SB_TREES } from './cisco-extra'
import { EOS_TREES } from './eos'
import { FTD_TREES } from './ftd'
import { IOSXR_TREES } from './iosxr'
import { FORTIOS_TREES } from './fortios'
import { IOS_TREES } from './ios'
import { JUNOS_TREES } from './junos'
import { NXOS_TREES } from './nxos'
import { PANOS_TREES } from './panos'

/** Tree sources per platform and mode (`pipe` holds the output modifiers). Compiled lazily by the registry. */
export const TREES: Readonly<Record<PlatformId, Partial<Record<ModeId, TreeSource>>>> = {
  ios: IOS_TREES,
  iosxe: IOS_TREES,
  nxos: NXOS_TREES,
  iosxr: IOSXR_TREES,
  asa: ASA_TREES,
  c9800: C9800_TREES,
  aireos: AIREOS_TREES,
  ciscosb: SB_TREES,
  ftd: FTD_TREES,
  eos: EOS_TREES,
  junos: JUNOS_TREES,
  panos: PANOS_TREES,
  fortios: FORTIOS_TREES,
  aoscx: AOSCX_TREES,
  vrp: VRP_TREES
}
