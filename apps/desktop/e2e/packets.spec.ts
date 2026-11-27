import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deviceFs, makeIosDevice, resolvePath, startSim } from '../../../packages/simulator/src/index.ts'
import { expect, MOD, showSessions, sizeWindow, stubDialogs, test, type Hopline } from './fixtures'

// Exercise the same two DNS frames readers download in the public walkthrough.
function dnsCapture(): Buffer {
  return readFileSync(join(__dirname, '../../../docs/examples/dns-failure/name-error.pcap'))
}

async function showPackets({ page }: Hopline) {
  await page.keyboard.press(MOD + '+K')
  const palette = page.getByRole('combobox', { name: 'Command palette' })
  await palette.fill('Packet capture')
  await palette.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Packet capture' })).toBeVisible()
}

test('capture workspace handles a cancelled picker and malformed files before contacting a model', async ({ hop }) => {
  await showPackets(hop)
  const open = hop.page.getByRole('button', { name: 'Open capture…' })
  await open.click()
  await expect(open).toBeEnabled()
  const path = join(hop.dir, 'bad.pcap')
  writeFileSync(path, 'Not a packet capture')
  await stubDialogs(hop.app, { open: path })
  await open.click()
  await expect(hop.page.getByRole('alert')).toContainText('PCAP or PCAPNG')
})

test('guarded IOS XE capture, SCP, frame inspection and a metadata-only AI request', async ({ hop }) => {
  const bytes = dnsCapture()
  const commands: string[] = []
  const device = makeIosDevice()
  const fs = deviceFs(device)
  const sim = await startSim({
    device, port: 0, files: { scp: true },
    extra: [(line, terminal) => {
      const match = /^(?:no )?monitor capture (H[a-f0-9]{7}) (.+)$/.exec(line)
      if (!match && !/^no monitor capture H[a-f0-9]{7}$/.test(line)) return false
      commands.push(line)
      if (match?.[2] === 'start') {
        fs.files.set(resolvePath(fs, 'flash:' + match[1] + '.pcap'), { data: bytes, mode: 0o600, mtime: 1700000000 })
      }
      if (match?.[2] === 'stop') return terminal.print('% Error: Capture ' + match[1] + ' is not active').then(() => true)
      return Promise.resolve(true)
    }]
  })
  try {
    const { page, app, llm } = hop
    await page.evaluate(async ({ port, endpoint }) => {
      await window.hopline.settings.update({ aiReadOnly: false, aiProvider: 'ollama', ollamaEndpoint: endpoint, ollamaModel: 'qwen3:8b', egressLog: true })
      await window.hopline.sessions.save({ folderId: null, name: 'Packet lab', host: '127.0.0.1', port, protocol: 'ssh', platform: 'iosxe', username: 'admin', credentialId: null, logToFile: false, notes: '', options: {} })
    }, { port: sim.port, endpoint: llm.ollama.url })
    await page.reload()
    await showSessions(page)
    await page.getByText('Packet lab', { exact: true }).first().dblclick()
    const pw = page.locator('[role=dialog] input[type=password]')
    await pw.fill('admin')
    await pw.press('Enter')
    await expect.poll(hop.termText).toMatch(/core-sw1#\s*$/)
    const saved = join(hop.dir, 'saved.pcap')
    await stubDialogs(app, { dir: hop.dir, open: saved, save: saved })
    await showPackets(hop)
    llm.ollama.script.push({ text: 'Capture on the client-facing interface and transfer the file over SSH.' })
    await page.getByLabel('Plan a capture with AI').fill('Where can I collect evidence of DNS timeouts?')
    await page.getByRole('button', { name: 'Ask assistant' }).click()
    await expect(page.getByLabel('Capture assistant answer')).toContainText('client-facing interface')
    await page.getByRole('radio', { name: 'SSH device' }).click()
    await page.getByLabel('Device interface', { exact: true }).fill('GigabitEthernet1/0/1')
    await page.getByLabel('Duration (s)').fill('15')
    await page.getByRole('button', { name: 'Preview capture…' }).click()
    await expect(page.getByRole('button', { name: 'Capture and transfer' })).toBeDisabled()
    await page.getByLabel('Type core-sw1 to approve').fill('core-sw1')
    await page.getByRole('button', { name: 'Capture and transfer' }).click()
    await page.getByRole('button', { name: 'Stop and analyze' }).click()
    const frames = page.getByRole('table', { name: 'Captured frames' })
    await expect(frames).toContainText('DNS', { timeout: 20_000 })
    expect(commands).toHaveLength(7)
    expect(commands[1]).toContain('match any')
    expect(commands.at(-2)).toMatch(/ stop$/)
    expect(commands.at(-1)).toMatch(/^no monitor capture/)
    expect(await page.evaluate(() => window.hopline.transfer.list())).toMatchObject([{ state: 'done', protocol: 'scp', direction: 'download', done: bytes.length }])
    await page.getByText('Busiest conversations by bytes').click()
    await expect(page.getByRole('table', { name: 'TCP and UDP conversations' })).toContainText('192.0.2.53:53')
    await page.getByRole('button', { name: 'udp.stream == 0' }).click()
    await expect(page.getByRole('textbox', { name: 'Wireshark display filter' })).toHaveValue('udp.stream == 0')
    await page.getByRole('button', { name: 'DNS error · 1' }).click()
    await expect(frames.getByRole('row')).toHaveCount(2)
    await page.getByRole('button', { name: 'Inspect frame 2' }).click()
    await page.getByText('Decoded header fields').click()
    await expect(page.getByRole('region', { name: 'Selected frame' })).toContainText('dns.flags.rcode')
    if (process.env.HOPLINE_SHOTS) {
      await page.screenshot({ path: join(process.env.HOPLINE_SHOTS, 'packets.png') })
      await sizeWindow(app, page, 820, 620)
      await page.screenshot({ path: join(process.env.HOPLINE_SHOTS, 'packets-narrow.png') })
    }
    await page.getByRole('button', { name: 'Show full protocol details' }).click()
    await expect(page.getByLabel('Local protocol details')).toContainText('printer.invalid')
    let sent = ''
    llm.ollama.route.fn = (body) => { sent = JSON.stringify(body); return { text: 'Frame 2 returned DNS response code 3 (NXDOMAIN).\n\n```wireshark\nframe.number == 2\n```' } }
    await page.getByRole('button', { name: 'Ask assistant' }).click()
    await expect(page.getByLabel('Capture assistant answer')).toContainText('Frame 2')
    expect(sent).toContain('selectedFrame')
    expect(sent).toContain('rcode')
    expect(sent).toContain('DNS error')
    expect(sent).not.toContain('printer.invalid')
    expect(sent).not.toContain(bytes.toString('base64'))
    await page.getByRole('button', { name: 'Apply suggested display filter' }).click()
    await expect(page.getByRole('textbox', { name: 'Wireshark display filter' })).toHaveValue('frame.number == 2')
    const log = await page.evaluate(() => window.hopline.egress.list({ limit: 5 }))
    expect(log.some((r) => r.source === 'packets')).toBe(true)
    await page.getByRole('button', { name: 'Save capture as…' }).click()
    await expect.poll(() => { try { return readFileSync(saved).equals(bytes) } catch { return false } }).toBe(true)
    await page.getByRole('button', { name: 'New capture…' }).click()
    await page.getByRole('button', { name: 'Open capture…' }).click()
    await expect(frames.getByRole('row')).toHaveCount(3)
    const transfer = (await page.evaluate(() => window.hopline.transfer.list()))[0]!
    writeFileSync(join(hop.dir, transfer.localName), Buffer.concat([bytes, Buffer.from([0])]))
    const changed = await page.evaluate(async (id) => {
      try { await window.hopline.packets.open({ kind: 'download', transferId: id }); return '' }
      catch (e) { return String(e) }
    }, transfer.id)
    expect(changed).toContain('downloaded file changed')
  } finally { await sim.close() }
})

test('a filter reaches late frames and a bad expression preserves the previous result', async ({ hop }) => {
  const bytes = dnsCapture()
  const firstSize = 16 + bytes.readUInt32LE(24 + 8)
  const first = bytes.subarray(24, 24 + firstSize)
  const path = join(hop.dir, 'many-queries.pcap')
  writeFileSync(path, Buffer.concat([bytes.subarray(0, 24), ...Array<Buffer>(50_000).fill(first), bytes.subarray(24 + firstSize)]))
  await stubDialogs(hop.app, { open: path })
  await showPackets(hop)
  const { page } = hop
  await page.getByRole('button', { name: 'Open capture…' }).click()
  const next = page.getByRole('button', { name: 'Next page' })
  await next.click({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Inspect frame 101', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'DNS error · 1' }).click()
  const last = page.getByRole('button', { name: 'Inspect frame 50001' })
  await expect(last).toBeVisible()
  await page.getByRole('textbox', { name: 'Wireshark display filter' }).fill('tcp &&&&')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(last).toBeVisible()
})

test('attach and drop appliance captures into chat without a terminal session', async ({ hop }) => {
  const { page, app, llm } = hop
  await page.evaluate(async (endpoint) => {
    await window.hopline.settings.update({ aiProvider: 'ollama', ollamaEndpoint: endpoint, ollamaModel: 'qwen3:8b' })
  }, llm.ollama.url)
  await page.reload()
  await page.keyboard.press(MOD + '+K')
  const palette = page.getByRole('combobox', { name: 'Command palette' })
  await palette.fill('Ask the assistant')
  await palette.press('Enter')
  const attach = page.getByRole('button', { name: 'Attach packet capture' })
  const file = join(hop.dir, 'bigip.pcap')
  writeFileSync(file, dnsCapture())
  await stubDialogs(app, { open: file })
  const requests: string[] = []
  llm.ollama.route.fn = (body) => {
    requests.push(JSON.stringify(body))
    return { text: 'Frame 2 is a DNS error from the resolver.' }
  }
  await attach.click()
  const chat = page.getByRole('region', { name: 'Capture conversation' })
  await expect(chat).toContainText('bigip.pcap')
  await expect(chat).toContainText('DNS error')
  expect(requests).toHaveLength(0)
  await chat.getByRole('button', { name: 'Analyze capture' }).click()
  await expect(chat).toContainText('Frame 2 is a DNS error')
  const question = chat.getByLabel('Question about attached capture')
  await question.fill('Which frame supports that?')
  await question.press('Enter')
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]).toContain('Frame 2 is a DNS error')
  expect(requests.join('')).not.toContain('printer.invalid')
  await expect(question).toBeEnabled()
  await chat.getByRole('button', { name: 'Continue in workspace' }).click()
  const followUp = page.getByRole('textbox', { name: 'Workspace question' })
  await expect(followUp).toHaveValue(/DNS error first seen in frame 2[\s\S]*Frame 2 is a DNS error/)
  expect(await followUp.inputValue()).not.toContain('bigip.pcap')
  expect(requests).toHaveLength(2)
  await page.getByRole('radio', { name: /capture/i }).click()
  await expect(chat).toContainText('Frame 2 is a DNS error')

  // Use a real disk-backed File so Electron resolves the same path as an OS drop.
  const dropped = join(hop.dir, 'fortigate.pcapng')
  const block = (type: number, body: Buffer) => {
    const size = 12 + Math.ceil(body.length / 4) * 4
    const out = Buffer.alloc(size)
    out.writeUInt32LE(type)
    out.writeUInt32LE(size, 4)
    body.copy(out, 8)
    out.writeUInt32LE(size, size - 4)
    return out
  }
  const first = dnsCapture()
  const frame = first.subarray(40, 40 + first.readUInt32LE(32))
  const header = Buffer.alloc(20)
  header.writeUInt32LE(frame.length, 12)
  header.writeUInt32LE(frame.length, 16)
  writeFileSync(dropped, Buffer.concat([
    block(0x0a0d0d0a, Buffer.from('4d3c2b1a01000000ffffffffffffffff', 'hex')),
    block(1, Buffer.from('01000000ffff0000', 'hex')), block(6, Buffer.concat([header, frame]))
  ]))
  const inputId = await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'test-desktop-drop'
    document.body.appendChild(input)
    return input.id
  })
  const input = page.locator('#' + inputId)
  await input.setInputFiles(dropped)
  await input.evaluate((el) => {
    const data = new DataTransfer()
    data.items.add((el as HTMLInputElement).files![0]!)
    document.querySelector('[aria-label="Capture conversation"]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    el.remove()
  })
  await expect(chat).toContainText('fortigate.pcapng')
  await expect(chat).not.toContainText('Frame 2 is a DNS error')
  expect(requests).toHaveLength(2)
  await chat.getByRole('button', { name: 'Inspect frames' }).click()
  const frames = page.getByRole('table', { name: 'Captured frames' })
  await expect(frames.getByRole('row')).toHaveCount(2)
  await expect(frames).toContainText('DNS')
  await page.keyboard.press('Escape')
  await chat.getByRole('button', { name: 'Remove attachment' }).click()
  await expect(chat).toHaveCount(0)
})
