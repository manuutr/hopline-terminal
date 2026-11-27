import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Settings } from '@shared/types'
import { insecureAcked, isInsecureEndpoint, isLoopbackEndpoint, ollamaHostLabel, parseEndpoint } from '@shared/ollama'
import { listOllamaModels, OllamaProvider, testOllama } from '../src/main/llm/ollama'
import { AiService, INSECURE_REFUSAL } from '../src/main/llm/service'
import type { SettingsService } from '../src/main/settings'

/** No network: the /api/show lookup is replaced (these endpoints do not exist). */
const NO_NET = { modelInfo: async () => ({ tools: true, contextLength: null }) }

/**
 * L3: a remote plain-http Ollama server is named as such and needs an acknowledgement bound to the
 * exact endpoint, enforced in main. L4: model discovery returns fixed error categories only, never
 * text from the server, and only http(s) endpoints are used.
 */

const CANARY = 'SERVER-BODY-CANARY-7f3a'

describe('endpoint rules (shared by main and the window)', () => {
  it('loopback is localhost, 127.0.0.0/8 and ::1 only', () => {
    for (const e of ['http://127.0.0.1:11434', 'http://127.5.6.7', 'http://localhost:11434', 'http://LOCALHOST', 'http://[::1]:11434']) expect(isLoopbackEndpoint(e), e).toBe(true)
    for (const e of ['http://10.1.1.5:11434', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://[::2]', 'http://0.0.0.0', 'file:///etc/passwd', 'not a url'])
      expect(isLoopbackEndpoint(e), e).toBe(false)
  })
  it('insecure = remote and plain http; https or loopback is not', () => {
    expect(isInsecureEndpoint('http://gpu-box:11434')).toBe(true)
    expect(isInsecureEndpoint('https://gpu-box:11434')).toBe(false)
    expect(isInsecureEndpoint('http://127.0.0.1:11434')).toBe(false)
  })
  it('only http(s) without credentials parses', () => {
    for (const e of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/', 'http://u:p@x:1', 'data:text/plain,hi']) expect(parseEndpoint(e), e).toBeNull()
    expect(parseEndpoint('https://x:1')).not.toBeNull()
  })
  it('the acknowledgement counts for exactly its endpoint', () => {
    expect(insecureAcked('http://gpu-box:11434', 'http://gpu-box:11434')).toBe(true)
    expect(insecureAcked('http://gpu-box:11435', 'http://gpu-box:11434')).toBe(false)
    expect(insecureAcked('http://gpu-box:11434', '')).toBe(false)
  })
  it('labels name the server: "Ollama · <host>"', () => {
    expect(ollamaHostLabel('http://gpu-box.lab:11434')).toBe('Ollama · gpu-box.lab:11434')
    expect(ollamaHostLabel('http://127.0.0.1:11434')).toBe('Ollama · 127.0.0.1:11434')
  })
})

describe('L4: discovery never returns server text', () => {
  let srv: Server
  let url = ''
  let mode: '500' | 'html' | 'badjson' | 'weird' = '500'
  beforeAll(async () => {
    srv = createServer((_req, res) => {
      if (mode === '500') return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `boom ${CANARY}` }))
      if (mode === 'html') return res.writeHead(200, { 'content-type': 'text/html' }).end(`<html>${CANARY}</html>`)
      if (mode === 'badjson') return res.writeHead(200).end(`{"models": ${CANARY}`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: CANARY }))
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => srv.close(() => r())))

  it.each([
    ['500', 'http_error'],
    ['html', 'not_ollama'],
    ['badjson', 'not_ollama'],
    ['weird', 'not_ollama']
  ] as const)('%s → %s with a fixed message', async (m, error) => {
    mode = m
    const r = await listOllamaModels(url)
    expect(r).toMatchObject({ ok: false, error })
    expect(JSON.stringify(r)).not.toContain(CANARY)
    expect(JSON.stringify(await testOllama(url, 'qwen3:8b'))).not.toContain(CANARY)
  })

  it('unreachable and bad schemes are categories too', async () => {
    expect(await listOllamaModels('http://127.0.0.1:9')).toMatchObject({ ok: false, error: 'unreachable', code: 'network' })
    for (const e of ['file:///etc/passwd', 'ftp://127.0.0.1/', 'javascript:alert(1)']) {
      expect(await listOllamaModels(e)).toMatchObject({ ok: false, error: 'invalid_url', code: 'bad_endpoint' })
      expect(await testOllama(e, 'qwen3:8b')).toMatchObject({ ok: false, code: 'bad_endpoint' })
      expect(() => new OllamaProvider(e, 'qwen3:8b')).toThrow(/http/)
    }
  })
})

describe('L3: main refuses an unacknowledged remote plain-http server', () => {
  const REMOTE = 'http://ollama.example.invalid:11434'
  const fake = (init: Partial<Settings>) => {
    let s = { aiProvider: 'ollama', aiModel: 'claude-opus-5-5', ollamaEndpoint: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:8b', ollamaInsecureAck: '', ...init } as Settings
    const svc = { get: () => s, update: (p: Partial<Settings>) => ((s = { ...s, ...p }), s), apiKey: async () => undefined }
    return svc as unknown as SettingsService
  }

  it('provider(): refused without the ack, refused with an ack for another endpoint, built with the right one', async () => {
    await expect(new AiService(fake({ ollamaEndpoint: REMOTE }), NO_NET).provider()).rejects.toThrow(INSECURE_REFUSAL)
    await expect(new AiService(fake({ ollamaEndpoint: REMOTE, ollamaInsecureAck: 'http://other.invalid:11434' }), NO_NET).provider()).rejects.toThrow(INSECURE_REFUSAL)
    expect(await new AiService(fake({ ollamaEndpoint: REMOTE, ollamaInsecureAck: REMOTE }), NO_NET).provider()).toMatchObject({ id: 'ollama' })
    // https and loopback need nothing.
    expect(await new AiService(fake({ ollamaEndpoint: 'https://ollama.example.invalid' }), NO_NET).provider()).toMatchObject({ id: 'ollama' })
    expect(await new AiService(fake({}), NO_NET).provider()).toMatchObject({ id: 'ollama' })
    await expect(new AiService(fake({ ollamaEndpoint: 'file:///etc/passwd' }), NO_NET).provider()).rejects.toThrow(/http/)
  })

  it('test and connect: refused without the ack (nothing is sent), and connect stores the ack bound to the endpoint', async () => {
    let calls = 0
    const counting = async () => (calls++, { ok: true, code: 'ok' as const, message: 'Connected' })
    const svc = fake({ aiProvider: 'anthropic' })
    const ai = new AiService(svc, { testOllama: counting, ...NO_NET })
    expect(await ai.test({ provider: 'ollama', model: 'qwen3:8b', endpoint: REMOTE })).toMatchObject({ ok: false, code: 'insecure_endpoint' })
    expect(await ai.connect({ provider: 'ollama', model: 'qwen3:8b', endpoint: REMOTE })).toMatchObject({ ok: false, code: 'insecure_endpoint' })
    expect(calls).toBe(0)
    expect(svc.get().aiProvider).toBe('anthropic')
    const r = await ai.connect({ provider: 'ollama', model: 'qwen3:8b', endpoint: REMOTE, insecureAck: true })
    expect(r).toMatchObject({ ok: true, settings: { aiProvider: 'ollama', ollamaEndpoint: REMOTE, ollamaInsecureAck: REMOTE } })
    expect(await ai.provider()).toMatchObject({ id: 'ollama' })
    // Moving to another endpoint voids it; a loopback connect clears it.
    svc.update({ ollamaEndpoint: 'http://ollama2.example.invalid:11434' })
    await expect(ai.provider()).rejects.toThrow(INSECURE_REFUSAL)
    expect((await ai.connect({ provider: 'ollama', model: 'qwen3:8b', endpoint: 'http://127.0.0.1:11434' })).settings?.ollamaInsecureAck).toBe('')
  })
})
