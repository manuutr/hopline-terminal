import { describe, expect, it } from 'vitest'
import { fetchNetBox, NetBoxError, stripPrefixLength, type FetchLike } from '../src'
import { byName, expectNoneLost, warningsFor } from './helpers'

const TOKEN = '0123456789abcdef0123456789abcdef01234567'

/** Devices shaped like NetBox 4.x /api/dcim/devices/ results (trimmed). */
const dev = (id: number, name: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://netbox.example.com/api/dcim/devices/${id}/`,
  display: name ?? `Unnamed device (${id})`,
  name,
  device_type: { id: 3, model: 'C9300-48P', slug: 'c9300-48p' },
  role: { id: 1, name: 'Access Switch', slug: 'access-switch' },
  site: { id: 1, name: 'AMS1', slug: 'ams1' },
  status: { value: 'active', label: 'Active' },
  primary_ip: { id: id + 100, family: { value: 4 }, address: `10.0.0.${id}/24` },
  tags: [],
  ...extra
})

const PAGE1 = [
  dev(1, 'ams1-acc-01', { platform: { id: 1, name: 'Cisco IOS-XE', slug: 'cisco-ios-xe' }, tags: [{ id: 1, name: 'access', slug: 'access' }, { id: 2, name: 'pci', slug: 'pci' }] }),
  dev(2, 'ams1-core-01', { platform: { id: 2, name: 'NX-OS', slug: 'nxos' }, role: { id: 2, name: 'Core', slug: 'core' } }),
  dev(3, 'ams1-fw-01', { platform: { id: 3, name: 'VyOS', slug: 'vyos' } })
]
const PAGE2 = [
  dev(4, 'ams1-spare', { primary_ip: null }),
  dev(5, null),
  dev(6, 'fra1-edge-01', { site: { id: 2, name: 'FRA1' }, platform: { id: 4, name: 'Junos', slug: 'junos' }, primary_ip: { id: 9, address: '2001:db8::6/128' } }),
  dev(7, 'fra1-oob', { site: { id: 2, name: 'FRA1' }, platform: { id: 5, name: 'Arista', slug: 'arista-eos' } }),
  dev(8, 'fra1-mystery', { site: { id: 2, name: 'FRA1' }, platform: { id: 6, name: 'Something', slug: 'something-os' } })
]

interface Call {
  url: string
  headers: Record<string, string>
}

function mockNetBox(pages: unknown[][], opts: { nextBase?: string; failAt?: number; status?: number } = {}) {
  const calls: Call[] = []
  const total = pages.reduce((n, p) => n + p.length, 0)
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const u = new URL(url)
    const offset = Number(u.searchParams.get('offset') ?? 0)
    const idx = pages.findIndex((_, i) => pages.slice(0, i).reduce((n, p) => n + p.length, 0) === offset)
    if (opts.failAt !== undefined && calls.length === opts.failAt) return { ok: false, status: opts.status ?? 500, statusText: 'Server Error', json: async () => ({}) }
    if (init.headers.Authorization !== `Token ${TOKEN}` && init.headers.Authorization !== `Bearer nbt_${TOKEN}`) {
      return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ detail: 'Invalid token' }) }
    }
    const page = pages[idx] ?? []
    const nextOffset = offset + page.length
    const next = nextOffset < total ? `${opts.nextBase ?? 'https://netbox.example.com'}/api/dcim/devices/?limit=${u.searchParams.get('limit')}&offset=${nextOffset}` : null
    return { ok: true, status: 200, json: async () => ({ count: total, next, previous: null, results: page }) }
  }
  return { fetchImpl, calls }
}

describe('fetchNetBox', () => {
  it('pages through devices and maps name, IP, site, platform and tags', async () => {
    const { fetchImpl, calls } = mockNetBox([PAGE1, PAGE2])
    const r = await fetchNetBox({ url: 'https://netbox.example.com/', token: TOKEN, filter: { status: 'active', role: ['access-switch', 'core'] }, pageSize: 3 }, fetchImpl)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://netbox.example.com/api/dcim/devices/?limit=3&status=active&role=access-switch&role=core')
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Token ${TOKEN}`, Accept: 'application/json' })

    expectNoneLost(r, ['ams1-acc-01', 'ams1-core-01', 'ams1-fw-01', 'ams1-spare', 'Unnamed device (5)', 'fra1-edge-01', 'fra1-oob', 'fra1-mystery'])
    expect(byName(r, 'ams1-acc-01')).toMatchObject({
      host: '10.0.0.1',
      port: 22,
      protocol: 'ssh',
      folderPath: ['AMS1'],
      platform: 'iosxe',
      tags: ['access', 'pci'],
      source: { format: 'netbox', id: '1', ref: 'https://netbox.example.com/api/dcim/devices/1/' }
    })
    expect(byName(r, 'ams1-acc-01').notes).toBe('Role: Access Switch\nModel: C9300-48P')
    expect(byName(r, 'ams1-core-01').platform).toBe('nxos')
    expect(byName(r, 'fra1-edge-01')).toMatchObject({ host: '2001:db8::6', platform: 'junos', folderPath: ['FRA1'] })
    expect(byName(r, 'fra1-oob').platform).toBe('eos')
    expect(r.folders.map((f) => f.path)).toEqual([['AMS1'], ['FRA1']])
  })

  it('leaves unsupported or unknown platforms undetermined, tagged and warned', async () => {
    const { fetchImpl } = mockNetBox([PAGE1, PAGE2])
    const r = await fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN, pageSize: 3 }, fetchImpl)
    const fw = byName(r, 'ams1-fw-01')
    expect(fw.platform).toBeUndefined()
    expect(fw.tags).toContain('platform:vyos')
    expect(warningsFor(r, 'ams1-fw-01').join()).toMatch(/not supported yet/)
    expect(byName(r, 'fra1-mystery').platform).toBeUndefined()
    expect(warningsFor(r, 'fra1-mystery').join()).toMatch(/mapping table/)
  })

  it('warns about devices without a name or primary IP', async () => {
    const { fetchImpl } = mockNetBox([PAGE1, PAGE2])
    const r = await fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN, pageSize: 3 }, fetchImpl)
    expect(warningsFor(r, 'ams1-spare').join()).toMatch(/no primary IP/)
    expect(warningsFor(r, 'Unnamed device (5)').join()).toMatch(/no name/)
  })

  it('throws a typed auth error without leaking the token', async () => {
    const { fetchImpl } = mockNetBox([PAGE1])
    const err = await fetchNetBox({ url: 'https://netbox.example.com', token: 'wrong-token-value' }, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NetBoxError)
    expect((err as NetBoxError).status).toBe(403)
    expect((err as NetBoxError).kind).toBe('auth')
    expect((err as Error).message).not.toContain('wrong-token-value')
  })

  it('fails the whole pull when a later page errors, never returning a partial list', async () => {
    const { fetchImpl } = mockNetBox([PAGE1, PAGE2], { failAt: 2, status: 502 })
    await expect(fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN, pageSize: 3 }, fetchImpl)).rejects.toMatchObject({ status: 502, kind: 'http' })
  })

  it('keeps the token on the configured origin even if next points elsewhere', async () => {
    const { fetchImpl, calls } = mockNetBox([PAGE1, PAGE2], { nextBase: 'http://evil.example.org' })
    await fetchNetBox({ url: 'https://netbox.example.com/api', token: TOKEN, pageSize: 3 }, fetchImpl)
    expect(calls.map((c) => new URL(c.url).origin)).toEqual(['https://netbox.example.com', 'https://netbox.example.com'])
  })

  it('keeps the token on the configured origin when next has a //host path (reviewer repro)', async () => {
    const calls: { url: string; auth: string }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization! })
      const first = calls.length === 1
      return { ok: true, status: 200, json: async () => ({ count: 2, next: first ? 'https://nb.example.com//evil.example/api/dcim/devices/?offset=1' : null, results: [] }) }
    }
    // Two pages are fetched, both from nb.example.com; the empty pages then fall short of count.
    await expect(fetchNetBox({ url: 'https://nb.example.com', token: 'TOKEN123' }, fetchImpl)).rejects.toThrow(/Incomplete/)
    expect(calls).toHaveLength(2)
    for (const c of calls) expect(new URL(c.url).origin).toBe('https://nb.example.com')
    expect(new URL(calls[1]!.url).pathname).toBe('//evil.example/api/dcim/devices/')
    expect(new URL(calls[1]!.url).search).toBe('?offset=1')
  })

  it('throws a typed error on an invalid next link', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ count: 9, next: 'http://[bad', results: [] }) })
    await expect(fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN }, fetchImpl)).rejects.toMatchObject({ name: 'NetBoxError', kind: 'format' })
  })

  it('throws when the pages hold fewer devices than count, never returning a partial list', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ count: 5, next: null, results: PAGE1 }) })
    const err = await fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN }, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NetBoxError)
    expect(err).toMatchObject({ kind: 'format', message: expect.stringMatching(/reported 5 devices but returned 3/) })
  })

  it('stops at maxPages', async () => {
    const { fetchImpl } = mockNetBox([PAGE1, PAGE2])
    await expect(fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN, pageSize: 3, maxPages: 1 }, fetchImpl)).rejects.toThrow(/maxPages/)
  })

  it('uses Bearer for NetBox v2 tokens', async () => {
    const { fetchImpl, calls } = mockNetBox([PAGE1])
    await fetchNetBox({ url: 'https://netbox.example.com', token: `nbt_${TOKEN}` }, fetchImpl)
    expect(calls[0]!.headers.Authorization).toBe(`Bearer nbt_${TOKEN}`)
  })

  it('rejects non-API responses', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) })
    await expect(fetchNetBox({ url: 'https://netbox.example.com', token: TOKEN }, fetchImpl)).rejects.toMatchObject({ kind: 'format' })
  })

  it('reads Nautobot devices (depth=1, location, network_driver)', async () => {
    const nautobot = [
      {
        id: '5c3d0f6e-1b2a-4c3d-9e8f-0a1b2c3d4e5f',
        name: 'nyc-core-01',
        location: { id: 'l1', name: 'NYC' },
        platform: { id: 'p1', name: 'Cisco NX-OS', network_driver: 'cisco_nxos' },
        primary_ip4: { id: 'i1', address: '10.50.0.1/32' },
        primary_ip: null,
        tags: [{ id: 't1', name: 'core' }]
      }
    ]
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url)
      return { ok: true, status: 200, json: async () => ({ count: 1, next: null, results: nautobot }) }
    }
    const r = await fetchNetBox({ url: 'https://nautobot.example.com', token: TOKEN, flavor: 'nautobot' }, fetchImpl)
    expect(calls[0]).toContain('depth=1')
    expect(byName(r, 'nyc-core-01')).toMatchObject({ host: '10.50.0.1', folderPath: ['NYC'], platform: 'nxos', tags: ['core'] })
  })

  it('strips prefix lengths', () => {
    expect(stripPrefixLength('10.0.0.1/32')).toBe('10.0.0.1')
    expect(stripPrefixLength('2001:db8::1/64')).toBe('2001:db8::1')
  })
})
