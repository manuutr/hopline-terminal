import { useEffect, useState } from 'react'
import { logicalLine, type Block } from '../../lib/blocks'
import type { BlockController } from './controller'

const failed = new WeakMap<Block, boolean>()
const deviceError = /^\s*%\s*(Invalid|Incomplete|Ambiguous|Error|Unknown)/i

/** Inspect completed output in short idle slices. Hovering a large transcript must never copy it. */
export function useBlockError(ctl: BlockController, block?: Block): boolean {
  const [found, setFound] = useState<Block>()
  useEffect(() => {
    if (!block || failed.has(block)) return
    const buffer = ctl.term.buffer.active
    let offset = 1
    let pending = 0
    const scan = () => {
      if (block.start.isDisposed || block.end.isDisposed) return
      const until = performance.now() + 3
      let line = block.start.line + offset
      while (line < block.end.line) {
        const row = logicalLine(buffer, line)
        if (deviceError.test(row.text)) {
          failed.set(block, true)
          setFound(block)
          return
        }
        line = row.last + 1
        if (performance.now() >= until) {
          offset = line - block.start.line
          pending = requestIdleCallback(scan, { timeout: 100 })
          return
        }
      }
      failed.set(block, false)
    }
    pending = requestIdleCallback(scan, { timeout: 100 })
    return () => cancelIdleCallback(pending)
  }, [ctl, block])
  return !!block && (found === block || failed.get(block) === true)
}
