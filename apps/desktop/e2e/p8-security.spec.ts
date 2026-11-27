import { hostname } from 'node:os'
import { cspViolations, test, expect } from './fixtures'

/**
 * Phase 8 security review M4 / C-L2 / C-L3 / C-L4 / I5: the renderer's origin, CSP, navigation,
 * permissions, IPC sender checks and the main-side confirmation before a link opens.
 */

test('the renderer is app://hopline under a strict CSP and cannot read local files or reach the network', async ({ hop }) => {
  const { page } = hop
  expect(page.url()).toMatch(/^app:\/\/hopline\/index\.html/)
  const r = await page.evaluate(async () => {
    const tryFetch = async (u: string) => {
      try {
        const res = await fetch(u)
        return `ok ${res.status}`
      } catch (e) {
        return `refused ${(e as Error).name}`
      }
    }
    const xhr = (u: string) => {
      try {
        const x = new XMLHttpRequest()
        x.open('GET', u, false)
        x.send()
        return `ok ${x.status}`
      } catch (e) {
        return `refused ${(e as Error).name}`
      }
    }
    return {
      file: await tryFetch('file:///etc/hostname'),
      sibling: await tryFetch('app://hopline/index.html'),
      http: await tryFetch('http://127.0.0.1:9/'),
      xhrFile: xhr('file:///etc/hostname'),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
    }
  })
  expect(r.file).toMatch(/^refused/)
  expect(r.sibling).toMatch(/^refused/)
  expect(r.http).toMatch(/^refused/)
  expect(r.xhrFile).toMatch(/^refused/)
  expect(r.csp).toContain("connect-src 'none'")
  expect(r.csp).toContain("default-src 'none'")
  // Frames are refused too: an iframe of a local file never loads it.
  const frame = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const f = document.createElement('iframe')
        f.src = 'file:///etc/hostname'
        f.onload = () => {
          let text = ''
          try {
            text = f.contentDocument?.body?.innerText ?? ''
          } catch {
            text = '(cross-origin)'
          }
          resolve(text)
        }
        document.body.append(f)
        setTimeout(() => resolve('(no load)'), 1500)
      })
  )
  expect(frame).not.toContain(hostname())
  // These refusals were logged on purpose: not the kind of violation the fixture fails on.
  await page.evaluate(() => document.querySelectorAll('iframe').forEach((f) => f.remove()))
  await page.waitForTimeout(500)
  cspViolations.get(page)?.splice(0)
})

test('window.open and navigation are refused; links open only after main asks', async ({ hop }) => {
  const { app, page } = hop
  const before = page.url()
  await page.evaluate(() => void window.open('https://example.com/?d=secret'))
  await page.evaluate(() => void (location.href = 'https://example.com/'))
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before)
  const opened = () => app.evaluate(() => (globalThis as { __hoplineOpened?: string[] }).__hoplineOpened ?? [])
  expect(await opened()).toEqual([])

  // links:open: the fixture's dialogs answer Cancel, so nothing opens; a "yes" opens the normalized URL.
  const asked: string[] = []
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { __asked?: string[] }
    g.__asked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as { message: string; detail: string; cancelId?: number }
      g.__asked!.push(`${o.message} ${o.detail}`)
      return { response: o.cancelId ?? 1, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox
  })
  await page.evaluate(() => (window as unknown as { hopline: { links: { open: (u: string) => Promise<unknown> } } }).hopline.links.open('https:\\\\example.com/x?d=1'))
  asked.push(...(await app.evaluate(() => (globalThis as { __asked?: string[] }).__asked ?? [])))
  expect(asked).toEqual(['Open this link in your browser? https://example.com/x?d=1'])
  expect(await opened()).toEqual([])
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox
  })
  await page.evaluate(() => (window as unknown as { hopline: { links: { open: (u: string) => Promise<unknown> } } }).hopline.links.open('https://example.com/y'))
  expect(await opened()).toEqual(['https://example.com/y'])
})

test('only the clipboard permission is granted, and IPC is refused from anything but the app page', async ({ hop }) => {
  const { app, page } = hop
  const perms = await page.evaluate(async () => {
    const out: Record<string, string> = {}
    for (const name of ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read']) {
      try {
        out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state
      } catch (e) {
        out[name] = `error ${(e as Error).name}`
      }
    }
    return out
  })
  expect(perms).toMatchObject({ camera: 'denied', microphone: 'denied', geolocation: 'denied', notifications: 'denied', 'clipboard-read': 'granted' })
  // The sender check itself, with events shaped like Electron's.
  const r = await app.evaluate(async ({ BrowserWindow }) => {
    const { trustedSender } = (globalThis as unknown as { __hoplineIpcSender?: { trustedSender: (e: unknown) => boolean } }).__hoplineIpcSender ?? {}
    if (!trustedSender) return 'missing'
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    const main = wc.mainFrame
    const real = trustedSender({ sender: wc, senderFrame: main })
    const sub = trustedSender({ sender: wc, senderFrame: { ...main, parent: main, url: main.url, processId: main.processId, routingId: main.routingId } })
    const gone = trustedSender({ sender: wc, senderFrame: null })
    const other = trustedSender({ sender: wc, senderFrame: { parent: null, url: 'https://evil.example/index.html', processId: main.processId, routingId: main.routingId } })
    return { real, sub, gone, other }
  })
  expect(r).toEqual({ real: true, sub: false, gone: false, other: false })
})

test('C-L1: a stored credential pointed at a new address is detached unless main gets a yes', async ({ hop }) => {
  const { app, page } = hop
  // The fixture answers this question yes for the other specs; here the user cancels.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { __asked?: string[] }
    g.__asked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as { message: string; cancelId?: number }
      g.__asked!.push(o.message)
      return { response: o.cancelId ?? 1, checkboxChecked: false }
    }) as unknown as typeof dialog.showMessageBox
  })
  type H = { hopline: { credentials: { list: () => Promise<{ id: string; name: string }[]> }; sessions: { list: () => Promise<{ sessions: { id: string; credentialId: string | null; host: string; port: number }[] }>; save: (s: unknown) => Promise<{ credentialId: string | null; options: { ssh?: { agentForward?: boolean } } }> } } }
  const out = await page.evaluate(async () => {
    const h = (window as unknown as H).hopline
    const cred = (await h.credentials.list()).find((c) => c.name === 'Simulator admin')!
    const seeded = (await h.sessions.list()).sessions.find((s) => s.credentialId === cred.id)!
    const base = { name: 'evil', folderId: null, protocol: 'ssh', platform: 'ios', username: 'admin', credentialId: cred.id, logToFile: false, notes: '', options: {} }
    const same = await h.sessions.save({ ...base, host: seeded.host, port: seeded.port })
    const moved = await h.sessions.save({ ...base, host: 'attacker.example', port: 22 })
    const fwd = await h.sessions.save({ ...base, credentialId: null, host: 'jump.example', port: 22, options: { ssh: { agentForward: true } } })
    return { same: same.credentialId === cred.id, moved: moved.credentialId, fwd: fwd.options.ssh?.agentForward }
  })
  expect(out).toEqual({ same: true, moved: null, fwd: false })
  expect(await app.evaluate(() => (globalThis as { __asked?: string[] }).__asked)).toEqual([expect.stringMatching(/^Use the saved credential "Simulator admin" with attacker\.example:22\?/), 'Forward your SSH agent to jump.example?'])
})
