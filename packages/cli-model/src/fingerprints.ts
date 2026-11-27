import type { FingerprintSignal } from './types'

/**
 * Fingerprint signals per platform family (docs/research/cli-*.md, cli-fingerprints.md).
 * Weights: version text ~0.95 (decisive), a vendor-specific SSH string or banner ~0.6, a
 * vendor-specific prompt shape ~0.5, shared shapes (`host#`, plain OpenSSH) 0.1-0.2, which on
 * their own never reach the decision threshold.
 */

const CISCO_PROMPT = /^[\w.\-/:]+(?:\([\w.\-/: ]+\))?[>#] ?$/
const ciscoSsh: FingerprintSignal = { kind: 'sshServerVersion', re: /^SSH-[\d.]+-Cisco-/i, weight: 0.5, note: 'Cisco SSH server (IOS, IOS-XE, ASA)' }
const ciscoPrompt: FingerprintSignal = { kind: 'prompt', re: CISCO_PROMPT, weight: 0.15, note: 'Cisco-style prompt (host# / host>)' }
const openSsh: FingerprintSignal = { kind: 'sshServerVersion', re: /^SSH-[\d.]+-OpenSSH/i, weight: 0.1, note: 'OpenSSH server (many vendors)' }

export const FP = {
  ios: [
    {
      kind: 'showVersion',
      re: /^Cisco IOS Software,/m,
      unless: /IOS[ -]XE|IOS XR/i,
      weight: 0.95,
      version: /Version ([\w.()]+)/,
      model: /^cisco (\S+) /m,
      note: '"Cisco IOS Software," without IOS XE'
    },
    ciscoSsh,
    ciscoPrompt
  ],
  iosxe: [
    {
      kind: 'showVersion',
      re: /^Cisco IOS XE Software|IOS-XE software|\(CAT9K_IOSXE\)/m,
      unless: /C9800|Catalyst 9800|Cisco IOS XR/,
      weight: 0.95,
      version: /Cisco IOS XE Software, Version (\S+)/,
      model: /^cisco (\S+) /m,
      note: '"Cisco IOS XE Software"'
    },
    ciscoSsh,
    ciscoPrompt
  ],
  nxos: [
    { kind: 'showVersion', re: /Cisco Nexus Operating System \(NX-OS\) Software/, weight: 0.95, version: /NXOS: version (\S+)|system:\s+version (\S+)/, model: /cisco (Nexus\S* \S+)/, note: '"Cisco Nexus Operating System"' },
    { kind: 'prompt', re: /^[\w.\-/:]+%[\w.\-]+(?:\([^)]*\))?# ?$/, weight: 0.6, note: 'NX-OS routing-context prompt (host%vrf#)' },
    { kind: 'sshServerVersion', re: /^SSH-[\d.]+-OpenSSH_\S+ FIPS/, weight: 0.35, note: 'OpenSSH FIPS (nmap tags it as NX-OS)' },
    ciscoPrompt,
    openSsh
  ],
  eos: [
    { kind: 'showVersion', re: /^Arista \S+|^Software image version: \d/m, weight: 0.95, version: /Software image version: (\S+)/, model: /^Arista (\S+)/m, note: '"Arista <model>" / "Software image version"' },
    { kind: 'prompt', re: /^[\w.\-/:]+\((?:s\d|vrf:[\w-]+)\)[^#>]*[>#] ?$/, weight: 0.5, note: 'EOS supervisor or vrf prompt decoration' },
    ciscoPrompt,
    openSsh
  ],
  junos: [
    { kind: 'showVersion', re: /^Junos: \S+|^JUNOS (?:OS |Software Release|Base OS)/m, weight: 0.95, version: /^Junos: (\S+)/m, model: /^Model: (\S+)/m, note: '"Junos:" / "JUNOS" package lines' },
    { kind: 'banner', re: /--- JUNOS \S+ built/, weight: 0.8, version: /--- JUNOS (\S+) built/, note: 'Junos login banner' },
    { kind: 'prompt', re: /^(?:\{[^}]+\}\s*)?[\w.\-]+@[\w.\-]+(?::[\w-]+)?[>#] ?$/, weight: 0.4, note: 'user@host> prompt (Junos or PAN-OS)' },
    { kind: 'prompt', re: /\[edit(?: [^\]]*)?\]/, weight: 0.4, note: '[edit] banner (Junos or PAN-OS)' },
    { kind: 'sshServerVersion', re: /^SSH-[\d.]+-OpenSSH\S* FreeBSD/i, weight: 0.4, note: 'OpenSSH on FreeBSD [unverified for current Junos]' },
    openSsh
  ],
  panos: [
    { kind: 'showVersion', re: /^sw-version: \S+/m, weight: 0.95, version: /^sw-version: (\S+)/m, model: /^model: (\S+)/m, note: '"sw-version:" (show system info)' },
    { kind: 'prompt', re: /^[\w.\-]+@PA-[\w.\-]+(?:\([a-z-]+\))?[>#] ?$/i, weight: 0.5, note: 'admin@PA-xxxx> prompt' },
    { kind: 'prompt', re: /^[\w.\-]+@[\w.\-]+(?:\((?:active|passive|suspended|non-functional|initial)[\w-]*\))[>#] ?$/, weight: 0.6, note: 'HA state in the prompt' },
    { kind: 'prompt', re: /^[\w.\-]+@[\w.\-]+[>#] ?$/, weight: 0.3, note: 'user@host> prompt (Junos or PAN-OS)' },
    { kind: 'prompt', re: /\[edit(?: [^\]]*)?\]/, weight: 0.4, note: '[edit] banner (Junos or PAN-OS)' },
    openSsh
  ],
  fortios: [
    { kind: 'showVersion', re: /^Version: Forti(?:Gate|WiFi|OS)[\w-]* v\S+/m, weight: 0.95, version: /^Version: \S+ v([\d.]+)/m, model: /^Version: (Forti\S+)/m, note: '"Version: FortiGate-…" (get system status)' },
    { kind: 'sshServerVersion', re: /^SSH-[\d.]+-FortiSSH/i, weight: 0.7, note: 'FortiSSH server [unverified]' },
    { kind: 'prompt', re: /^[\w.\-]+ (?:\([^)]+\) )?[#$] ?$/, weight: 0.5, note: '"host # " prompt with a space before #' }
  ]
} satisfies Record<string, readonly FingerprintSignal[]>

/** Cisco platforms beyond IOS/IOS-XE/NX-OS (docs/research/cli-cisco-*.md, cli-fingerprints.md). */
export const FP_CISCO = {
  iosxr: [
    { kind: 'showVersion', re: /Cisco IOS XR Software/, weight: 0.95, version: /Cisco IOS XR Software, Version (\S+)/, model: /^cisco (\S+) /m, note: '"Cisco IOS XR Software"' },
    { kind: 'prompt', re: /^(?:RP|LC)\/\d+\/\w+\/CPU\d+:/, weight: 0.8, note: 'RP/0/RP0/CPU0:host# prompt' },
    { kind: 'sshServerVersion', re: /^SSH-[\d.]+-Cisco-2\.0/, weight: 0.3, note: 'Cisco-2.0 SSH stack suggests IOS-XR (cli-fingerprints.md)' },
    ciscoSsh
  ],
  asa: [
    { kind: 'showVersion', re: /Cisco Adaptive Security Appliance Software Version/, weight: 0.95, version: /Appliance Software Version (\S+)/, model: /^Hardware:\s+([\w-]+)/m, note: '"Cisco Adaptive Security Appliance Software"' },
    { kind: 'prompt', re: /^[\w.\-]+\/[\w.\-]+(?:\([\w-]+\))?[>#] ?$/, weight: 0.3, note: 'host/context# prompt (multiple-context ASA)' },
    ciscoSsh,
    ciscoPrompt
  ],
  c9800: [
    { kind: 'showVersion', re: /C9800|Catalyst 9800/, weight: 0.97, version: /Cisco IOS XE Software, Version (\S+)/, model: /\b(C9800-[\w-]+)/, note: 'IOS-XE on a Catalyst 9800 controller' },
    ciscoSsh,
    ciscoPrompt
  ],
  ciscosb: [
    { kind: 'showVersion', re: /^SW version\s+[\d.]+|^Active-image: |image_tesla|Cisco Business|\bCBS\d{3}|\bSG\d{3}/m, weight: 0.9, version: /^(?:SW version|Version:)\s+([\d.]+)/m, note: 'Small Business firmware lines [unverified]' },
    ciscoPrompt
  ],
  aireos: [
    { kind: 'showVersion', re: /Product Name\.+ Cisco Controller|Manufacturer's Name\.+ Cisco Systems/, weight: 0.95, version: /Product Version\.+ (\S+)/, note: 'show sysinfo of an AireOS controller' },
    { kind: 'prompt', re: /^\(Cisco Controller\) (?:config[\w -]*)?>/, weight: 0.8, note: '(Cisco Controller) > prompt' },
    { kind: 'prompt', re: /^\([\w.\-]+\) (?:config[\w -]*)?> ?$/, weight: 0.6, note: '(host) > prompt' },
    { kind: 'sshServerVersion', re: /^SSH-[\d.]+-CISCO_WLC/, weight: 0.8, note: 'SSH-2.0-CISCO_WLC (nmap, netmiko autodetect)' },
    { kind: 'banner', re: /^User: ?$/m, weight: 0.3, note: 'AireOS asks "User:" after SSH auth' }
  ],
  ftd: [
    { kind: 'showVersion', re: /Cisco Firepower Threat Defense|Threat Defense \(\d+\) Version|Cisco Secure Firewall Threat Defense/, weight: 0.95, version: /Version (\d[\w.()-]*)/, model: /Model\s+: (.+?) \(/, note: '"Firepower Threat Defense" model line' },
    { kind: 'prompt', re: /^> ?$/, weight: 0.4, note: 'bare > prompt' }
  ]
} satisfies Record<string, readonly FingerprintSignal[]>
