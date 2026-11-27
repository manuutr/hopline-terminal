import { Fragment, type ReactNode } from 'react'
import { CodeExcerpt } from './CodeExcerpt'
import { parseMarkdown, type Align, type Block, type Inline } from './markdown-parse'

/**
 * Assistant answers as Markdown. Builds React elements only (no innerHTML), so model output can
 * never inject markup. Parsing lives in markdown-parse.ts (unit-tested).
 */
function spans(c: Inline[], key: string): ReactNode[] {
  return c.map((n, i) => {
    const k = `${key}-${i}`
    switch (n.t) {
      case 'text':
        return n.v
      case 'code':
        return (
          <code key={k} className="rounded-sm bg-active px-1 py-px font-mono text-[12px] text-fg">
            {n.v}
          </code>
        )
      case 'strong':
        return (
          <strong key={k} className="font-semibold text-fg">
            {spans(n.c, k)}
          </strong>
        )
      case 'em':
        return (
          <em key={k} className="italic">
            {spans(n.c, k)}
          </em>
        )
      case 'del':
        return (
          <del key={k} className="text-fg-subtle">
            {spans(n.c, k)}
          </del>
        )
    }
  })
}

const alignClass = (a: Align) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left')

function block(b: Block, k: string, tabId?: string): ReactNode {
  switch (b.t) {
    case 'code':
      return <CodeExcerpt key={k} text={b.v} language={b.lang} tabId={tabId} />
    case 'h':
      return (
        <div key={k} className={`mb-1 mt-3 font-semibold text-fg first:mt-0 ${b.level <= 2 ? 'text-[14px]' : 'text-[13.5px]'}`}>
          {spans(b.c, k)}
        </div>
      )
    case 'ul':
      return (
        <ul key={k} className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-fg-subtle">
          {b.items.map((it, j) => (
            <li key={j}>{spans(it, `${k}-${j}`)}</li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={k} start={b.start} className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-fg-subtle">
          {b.items.map((it, j) => (
            <li key={j}>{spans(it, `${k}-${j}`)}</li>
          ))}
        </ol>
      )
    case 'table':
      return (
        <div key={k} className="my-2 overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-[12.5px] leading-[1.45]">
            <thead className="bg-active/60">
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} scope="col" className={`whitespace-nowrap border-b border-line px-2.5 py-1.5 font-semibold text-fg ${alignClass(b.align[j] ?? null)}`}>
                    {spans(c, `${k}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-line/60 last:border-b-0">
                  {r.map((c, j) => (
                    <td key={j} className={`px-2.5 py-1.5 align-top ${j === 0 ? 'whitespace-nowrap text-fg' : ''} ${alignClass(b.align[j] ?? null)}`}>
                      {spans(c, `${k}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return (
        <blockquote key={k} className="my-2 border-l-2 border-line-strong pl-3 text-fg-subtle">
          {b.c.map((x, j) => block(x, `${k}-${j}`, tabId))}
        </blockquote>
      )
    case 'hr':
      return <hr key={k} className="my-3 border-line" />
    case 'p':
      return (
        <p key={k} className="my-1.5 first:mt-0">
          {b.lines.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {spans(l, `${k}-${j}`)}
            </Fragment>
          ))}
        </p>
      )
  }
}

export function Markdown({ text, tabId }: { text: string; tabId?: string }): React.JSX.Element {
  return <div className="selectable text-[13.5px] leading-[1.6] text-fg-muted">{parseMarkdown(text).map((b, i) => block(b, String(i), tabId))}</div>
}
