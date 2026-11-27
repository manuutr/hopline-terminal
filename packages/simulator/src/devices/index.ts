/** Device factories by platform. */
import type { Device, SimPlatform } from '../state.ts'
import { makeIosDevice } from './ios.ts'
import { makeEosDevice } from './eos.ts'
import { makeNxosDevice } from './nxos.ts'
import { makeJunosDevice } from './junos.ts'
import { makePanosDevice } from './panos.ts'
import { makeFortiosDevice } from './fortios.ts'
import { makeIosxrDevice } from './iosxr.ts'
import { makeAsaDevice } from './asa.ts'
import { makeAireosDevice } from './aireos.ts'
import { makeC9800Device } from './c9800.ts'
import { makeAoscxDevice } from './aoscx.ts'
import { makeVrpDevice } from './vrp.ts'
import { makeRouterosDevice } from './routeros.ts'

export type { SimPlatform }

const factories: Partial<Record<SimPlatform, (t?: number) => Device>> = {
  ios: makeIosDevice,
  eos: makeEosDevice
}
for (const [p, f] of [
  ['nxos', makeNxosDevice],
  ['junos', makeJunosDevice],
  ['panos', makePanosDevice],
  ['fortios', makeFortiosDevice],
  ['iosxr', makeIosxrDevice],
  ['asa', makeAsaDevice],
  ['aireos', makeAireosDevice],
  ['c9800', makeC9800Device],
  ['aoscx', makeAoscxDevice],
  ['vrp', makeVrpDevice],
  ['routeros', makeRouterosDevice]
] as const)
  if (f) factories[p] = f

export function registerDevice(p: SimPlatform, f: (t?: number) => Device): void {
  factories[p] = f
}

export function makeDevice(p: SimPlatform, t?: number): Device {
  const f = factories[p]
  if (!f) throw new Error(`simulator: no device factory for platform "${p}"`)
  return f(t)
}

export const platforms = (): SimPlatform[] => Object.keys(factories) as SimPlatform[]
