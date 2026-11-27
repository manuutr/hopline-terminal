import { describe, expect, it } from 'vitest'
import { fingerprint, PLATFORM_IDS, probeCommand, resolve } from '../src'

/** Verbatim excerpts of the version transcripts in docs/research/cli-*.md. */
const SHOW_VERSION = {
  iosxe: `core-sw1#show version
Cisco IOS XE Software, Version 17.09.04a
Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2023 by Cisco Systems, Inc.`,
  // cli-cisco-ios.md: classic IOS first line [unverified, from memory there].
  ios: `Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport`,
  nxos: `leaf1# show version
Cisco Nexus Operating System (NX-OS) Software
TAC support: http://www.cisco.com/tac
Copyright (C) 2002-2023, Cisco and/or its affiliates.`,
  eos: `dist-eos1#show version
Arista DCS-7050SX3-48YC8
Hardware version: 11.01
Serial number: JPE19470123

Software image version: 4.31.2F
Architecture: x86_64`,
  junos: `netops@edge-r1> show version
Hostname: edge-r1
Model: vmx
Junos: 22.4R3.25
JUNOS OS Kernel 64-bit  [20231115.f0321c3_builder_stable_12_224]`,
  panos: `family: vm
model: PA-VM
serial: 007954000123456
sw-version: 11.1.6
app-version: 8930-9310`,
  fortios: `fgt-edge1 # get system status
Version: FortiGate-VM64 v7.4.4,build2662,240514 (GA.F)
First GA patch build date: 230509`
} as const

describe('fingerprint', () => {
  it.each([
    ['iosxe', '17.09.04a', undefined],
    ['ios', '15.2(7)E8', undefined],
    ['nxos', undefined, undefined],
    ['eos', '4.31.2F', 'DCS-7050SX3-48YC8'],
    ['junos', '22.4R3.25', 'vmx'],
    ['panos', '11.1.6', 'PA-VM'],
    ['fortios', '7.4.4', 'FortiGate-VM64']
  ] as const)('version text identifies %s', (platform, version, model) => {
    const fp = fingerprint({ showVersion: SHOW_VERSION[platform] })
    expect(fp.platform).toBe(platform)
    expect(fp.confidence).toBeGreaterThan(0.9)
    if (version) expect(fp.version).toBe(version)
    if (model) expect(fp.model).toBe(model)
    expect(fp.evidence.length).toBeGreaterThan(0)
  })

  it('IOS-XE text that mentions "Cisco IOS Software" is still IOS-XE', () => {
    const fp = fingerprint({ showVersion: SHOW_VERSION.iosxe })
    expect(fp.candidates.find((c) => c.platform === 'ios')?.score ?? 0).toBeLessThan(0.5)
  })

  it('weak evidence stays unknown', () => {
    expect(fingerprint({}).platform).toBe('unknown')
    expect(fingerprint({ prompt: 'core-sw1#' }).platform).toBe('unknown')
    expect(fingerprint({ sshServerVersion: 'SSH-2.0-OpenSSH_8.9' }).platform).toBe('unknown')
    // A Cisco SSH server could be IOS or IOS-XE: only the version text tells them apart.
    const cisco = fingerprint({ sshServerVersion: 'SSH-2.0-Cisco-1.25', prompt: 'core-sw1#' })
    expect(cisco.platform).toBe('unknown')
    expect(cisco.candidates.map((c) => c.platform)).toEqual(expect.arrayContaining(['ios', 'iosxe']))
    // user@host> is Junos or PAN-OS.
    expect(fingerprint({ prompt: 'netops@edge-r1> ' }).platform).toBe('unknown')
  })

  it('specific prompt and SSH shapes decide', () => {
    expect(fingerprint({ prompt: 'fgt-edge1 # ', sshServerVersion: 'SSH-2.0-FortiSSH_7.4' }).platform).toBe('fortios')
    expect(fingerprint({ prompt: 'admin@PA-3220(active)> ' }).platform).toBe('panos')
    expect(fingerprint({ banner: '--- JUNOS 22.4R3.25 built 2023-12-06 10:45:30 UTC' }).platform).toBe('junos')
  })

  it('version evidence beats a conflicting prompt guess', () => {
    expect(fingerprint({ prompt: 'netops@edge-r1> ', showVersion: SHOW_VERSION.junos }).platform).toBe('junos')
  })
})

describe('probeCommand', () => {
  it('with no evidence, the probe covers every platform it can and lists the rest', () => {
    const p = probeCommand()
    expect(p.command).toBe('show version')
    expect([...p.covers, ...p.others].sort()).toEqual([...PLATFORM_IDS].sort())
    for (const c of p.covers) expect(resolve(c, 'exec', p.command).risk).toBe('read')
    expect(p.command).not.toContain('|')
  })

  it('Cisco SSH string: show version covers ios and iosxe', () => {
    const p = probeCommand({ sshServerVersion: 'SSH-2.0-Cisco-1.25' })
    expect(p.command).toBe('show version')
    expect(p.covers).toEqual(expect.arrayContaining(['ios', 'iosxe']))
  })

  it('user@host prompt: one probe for Junos or PAN-OS, the other listed', () => {
    const p = probeCommand({ prompt: 'netops@edge-r1> ' })
    expect([...p.covers, ...p.others].sort()).toEqual(['junos', 'panos'])
    for (const c of p.covers) expect(resolve(c, 'exec', p.command).risk).toBe('read')
  })
})

describe('fingerprint: Cisco tier 1', () => {
  it.each([
    // docs/research/cli-cisco-iosxr.md §8 (ntc-templates raw sample)
    ['iosxr', 'Wed Mar 14 12:31:28.607 UTC\n\nCisco IOS XR Software, Version 6.1.4\nCopyright (c) 2013-2016 by Cisco Systems, Inc.\ncisco NCS-5500 () processor', '6.1.4'],
    ['asa', 'Cisco Adaptive Security Appliance Software Version 9.16(4)\nFirepower Extensible Operating System Version 2.10(1.179)\nHardware:   ASA5516, 8192 MB RAM', '9.16(4)'],
    ['c9800', 'Cisco IOS XE Software, Version 17.09.04a\nCisco IOS Software [Cupertino], C9800 Software (C9800_IOSXE-K9), Version 17.9.4a', '17.09.04a'],
    ['aireos', "Manufacturer's Name.............................. Cisco Systems Inc.\nProduct Name..................................... Cisco Controller\nProduct Version.................................. 8.10.151.0", '8.10.151.0'],
    ['ftd', 'Model                     : Cisco Firepower 2110 Threat Defense (77) Version 7.0.1 (Build 84)', '7.0.1']
  ] as const)('%s', (platform, showVersion, version) => {
    const fp = fingerprint({ showVersion })
    expect(fp.platform).toBe(platform)
    expect(fp.version).toBe(version)
  })

  it('the IOS-XR prompt alone identifies IOS-XR', () => expect(fingerprint({ prompt: 'RP/0/RP0/CPU0:pe1#' }).platform).toBe('iosxr'))
  it('the AireOS prompt alone identifies AireOS', () => expect(fingerprint({ prompt: '(Cisco Controller) >' }).platform).toBe('aireos'))
  it('C9800 version text is not plain IOS-XE', () => {
    const fp = fingerprint({ showVersion: 'Cisco IOS XE Software, Version 17.09.04a\nC9800-40-K9' })
    expect(fp.candidates.find((c) => c.platform === 'iosxe')?.score ?? 0).toBeLessThan(0.5)
  })
})

describe('fingerprint: tier 2', () => {
  it('Huawei VRP version text', () => {
    const fp = fingerprint({ showVersion: 'Huawei Versatile Routing Platform Software\nVRP (R) software, Version 8.180 (CE6800 V200R005C10SPC607B607)\nCopyright (C) 2012-2018 Huawei Technologies Co., Ltd.\nHUAWEI CE6857-48S6CQ-EI uptime is 10 days' })
    expect(fp.platform).toBe('vrp')
    expect(fp.version).toBe('8.180')
  })
  it('Huawei user-view prompt and SSH string', () => expect(fingerprint({ prompt: '<HUAWEI>', sshServerVersion: 'SSH-2.0-HUAWEI-1.5' }).platform).toBe('vrp'))
  it('AOS-CX version text', () => expect(fingerprint({ showVersion: '-----------------------------------------------------------------------------\nArubaOS-CX\n(c) Copyright 2017-2024 Hewlett Packard Enterprise Development LP\n-----------------------------------------------------------------------------\nVersion      : FL.10.13.1000' }).platform).toBe('aoscx'))
})
