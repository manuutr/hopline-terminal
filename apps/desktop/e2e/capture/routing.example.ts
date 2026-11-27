import { expect, test } from '@playwright/test'
import { applyPeerScenario, applyScenario, makeDevice } from '../../../../packages/simulator/src/index.ts'
import { MOD, termTextOf } from '../fixtures'
import { setTheme } from './narrow'
import { captureBgpInvestigation } from './bgp-fleet'
import { command, connect, picture, withDevices } from './example-session'

test('localize a BGP authentication failure to the peering transport', async () => {
  const core = makeDevice('ios')
  const edge = makeDevice('junos')
  applyScenario(core, 'bgp-auth-mismatch', { neighbor: '10.0.0.6' })
  applyPeerScenario(edge, 'bgp-auth-mismatch', { neighbor: '10.0.0.5' })
  await withDevices('Transit peering', [
    { name: 'Campus core', platform: 'iosxe', device: core },
    { name: 'Transit edge', platform: 'junos', device: edge }
  ], async page => {
    const snap = (name: string, height: number) => picture(page, 'bgp-peer-auth', name, height)
    await connect(page, 'Campus core', /core-sw1#\s*$/)
    await command(page, 'show ip bgp summary', /10\.0\.0\.6[^\n]*(?:Idle|Active)[\s\S]*core-sw1#\s*$/i)
    await snap('01-neighbor-state', 660)
    await command(page, 'show ip interface brief | include GigabitEthernet1/0/1', /GigabitEthernet1\/0\/1\s+10\.0\.0\.5\s+\S+\s+\S+\s+up\s+up[\s\S]*core-sw1#\s*$/i)
    await snap('02-link-state', 705)
    await command(page, 'show logging | include BADAUTH', /Invalid MD5 digest from 10\.0\.0\.6\(179\)[\s\S]*core-sw1#\s*$/)
    await snap('03-local-tcp-log', 805)
    await connect(page, 'Transit edge', /edge-r1>\s*$/)
    await command(page, 'show bgp summary', /10\.0\.0\.5[^\n]*(?:Idle|Active)[\s\S]*edge-r1>\s*$/i)
    await snap('04-remote-neighbor', 490)
    await command(page, 'show log messages | match tcp_auth_ok', /10\.0\.0\.5:179 wrong MD5 digest[\s\S]*edge-r1>\s*$/)
    await snap('05-remote-tcp-log', 650)
    await page.keyboard.press(MOD + '+Alt+F')
    const search = page.getByRole('dialog', { name: 'Find in all tabs' })
    await search.getByRole('textbox').fill('MD5 digest')
    const coreHit = search.getByRole('option').filter({ hasText: /Invalid MD5 digest from 10\.0\.0\.6/ }).first()
    const edgeHit = search.getByRole('option').filter({ hasText: /10\.0\.0\.5:179 wrong MD5 digest/ }).first()
    await expect(coreHit).toBeVisible()
    await expect(edgeHit).toBeVisible()
    await picture(page, 'bgp-peer-auth', '06-search-both-sessions', undefined, search)
    await coreHit.click()
    await expect(page.getByRole('tab', { name: /Campus core/ })).toHaveAttribute('aria-selected', 'true')
    await captureBgpInvestigation(page)
  })
})

test('compare OSPF exchange state and interface MTUs on both ends of a link', async () => {
  const core = makeDevice('ios')
  const edge = makeDevice('junos')
  applyScenario(core, 'ospf-mtu-mismatch', { neighbor: '10.0.0.6' })
  applyPeerScenario(edge, 'ospf-mtu-mismatch', { neighbor: '10.0.0.5' })
  await withDevices('Backbone area 0', [
    { name: 'Core router', platform: 'iosxe', device: core },
    { name: 'Edge router', platform: 'junos', device: edge }
  ], async page => {
    await setTheme(page, 'light')
    const snap = (name: string, height: number) => picture(page, 'ospf-mtu', name, height)
    await connect(page, 'Core router', /core-sw1#\s*$/)
    await command(page, 'show ip ospf neighbor', /EXSTART[\s\S]*core-sw1#\s*$/i)
    await snap('01-adjacency', 385)
    await command(page, 'show logging | include OSPF', /Too many retransmissions[\s\S]*core-sw1#\s*$/i)
    await snap('02-adjacency-log', 460)
    await command(page, 'show interfaces GigabitEthernet1/0/1 | include MTU', /MTU 1500 bytes[\s\S]*core-sw1#\s*$/)
    await snap('03-core-mtu', 565)
    await page.keyboard.press(MOD + '+D')
    const launcher = page.locator('[data-launcher] input')
    await launcher.fill('Edge router')
    await launcher.press('Enter')
    await expect.poll(termTextOf(page)).toMatch(/edge-r1>\s*$/)
    await command(page, 'show ospf neighbor', /10\.0\.0\.5\s+ge-0\/0\/1\.0\s+ExStart[\s\S]*edge-r1>\s*$/i)
    await snap('04-edge-adjacency', 640)
    await command(page, 'show interfaces ge-0/0/1 | match MTU', /Protocol inet, MTU: 9086[\s\S]*edge-r1>\s*$/)
    await snap('05-edge-mtu', 690)
  })
})
