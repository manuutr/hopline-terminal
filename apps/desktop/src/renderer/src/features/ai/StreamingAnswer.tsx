import { useEffect, useRef, useState } from 'react'

/** Append to existing DOM in short batches so earlier text stays still and selectable. */
export function StreamingAnswer({ text }: { text: string }) {
  const [shown, setShown] = useState(() => ({ text, parts: [{ offset: 0, value: text }] }))
  const lastPaint = useRef(0)
  useEffect(() => {
    const paint = () => {
      lastPaint.current = performance.now()
      setShown((prev) => {
        if (text === prev.text) return prev
        if (!text.startsWith(prev.text)) return { text, parts: [{ offset: 0, value: text }] }
        const offset = prev.text.length
        return { text, parts: [...prev.parts, { offset, value: text.slice(offset) }] }
      })
    }
    const remaining = 32 - (performance.now() - lastPaint.current)
    if (remaining <= 0) { paint(); return }
    const timer = setTimeout(paint, remaining)
    return () => clearTimeout(timer)
  }, [text])
  return <div className="selectable whitespace-pre-wrap text-sm leading-relaxed text-fg-muted">
    {shown.parts.map((part) => <span key={part.offset} className="animate-fade-in">{part.value}</span>)}
  </div>
}
