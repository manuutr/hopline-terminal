import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { PromptRetry } from '@shared/host-protocol'
import type { HostPrompt, PromptAnswer, PromptRequest } from '@shared/types'

const TIMEOUT_MS = 5 * 60_000

/**
 * Asks the user something on behalf of a connection (changed host key, MFA, passphrase) and waits.
 * Unanswered prompts cancel after five minutes; a closed window cancels its prompts.
 */
export class PromptBroker {
  private open = new Map<string, { wc: WebContents; tabId?: string; finish: (v: PromptAnswer) => void }>()

  ask(wc: WebContents, prompt: HostPrompt, meta: { tabId?: string; sessionName?: string; attempt?: number; error?: string } = {}): Promise<PromptAnswer> {
    if (wc.isDestroyed()) return Promise.resolve(null)
    const id = randomUUID()
    return new Promise<PromptAnswer>((resolve) => {
      const timer = setTimeout(() => finish(null), TIMEOUT_MS)
      const onGone = () => finish(null)
      const finish = (v: PromptAnswer) => {
        if (!this.open.delete(id)) return
        clearTimeout(timer)
        wc.off('destroyed', onGone)
        if (!wc.isDestroyed()) wc.send('prompt:done', id)
        resolve(v)
      }
      wc.once('destroyed', onGone)
      this.open.set(id, { wc, tabId: meta.tabId, finish })
      wc.send('prompt:ask', { id, ...meta, attempt: meta.attempt ?? 1, prompt } satisfies PromptRequest)
    })
  }

  /** Only the window that was asked can answer. */
  answer(sender: WebContents, id: string, value: PromptAnswer): void {
    const p = this.open.get(id)
    if (p && p.wc === sender) p.finish(value)
  }

  cancelFor(wc: WebContents): void {
    for (const p of [...this.open.values()]) if (p.wc === wc) p.finish(null)
  }

  /** A tab closed or its connection was replaced: its questions no longer apply. */
  cancelTab(tabId: string): void {
    for (const p of [...this.open.values()]) if (p.tabId === tabId) p.finish(null)
  }
}

type CredentialAsk = Extract<HostPrompt, { kind: 'keyboard-interactive' | 'secret' }>

/**
 * The prompt dialog's attempt number and error line for a question asked again after the device
 * rejected the previous answer. Says "password" only when the prompt is one.
 */
export function retryMeta(retry: PromptRetry | undefined, q: CredentialAsk): { attempt?: number; error?: string } {
  if (!retry) return {}
  const only = q.kind === 'keyboard-interactive' && q.prompts.length === 1 ? q.prompts[0] : undefined
  const isPassword = q.kind === 'secret' ? q.secret === 'password' : !!only && !only.echo && /password/i.test(only.prompt) && !/one.?time|otp/i.test(only.prompt)
  const left = `attempt ${retry.attempt} of ${retry.of}`
  if (retry.saved) return { attempt: retry.attempt, error: `The saved password was rejected. Enter the current one (${left}).` }
  return { attempt: retry.attempt, error: isPassword ? `Wrong password. Try again (${left}).` : `The device rejected that answer. Try again (${left}).` }
}
