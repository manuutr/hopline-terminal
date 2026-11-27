/// <reference lib="webworker" />
/**
 * TextFSM off the UI thread. Device output is untrusted and a template regex could backtrack
 * catastrophically on crafted input: the client terminates this worker when it overruns its
 * budget, so the terminal never stalls.
 */
import { parseOutput } from '@hopline/parsers'

export interface ParseRequest {
  id: number
  platform: string
  command: string
  text: string
  budgetMs: number
}

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, platform, command, text, budgetMs } = e.data
  try {
    self.postMessage({ id, result: parseOutput(platform, command, text, { budgetMs }) })
  } catch (err) {
    self.postMessage({ id, result: null, error: err instanceof Error ? err.message : String(err) })
  }
}
