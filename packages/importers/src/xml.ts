/**
 * A minimal, non-validating XML reader for SecureCRT's settings export: elements,
 * attributes, text, CDATA and the predefined/numeric entities. DOCTYPEs are
 * skipped without expanding anything (no external or custom entities), and
 * nesting depth is capped.
 */
export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

const MAX_DEPTH = 128

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()]! : m
  })
}

export class XmlError extends Error {}

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlElement[] = [root]
  let i = 0
  const n = src.length
  const top = () => stack[stack.length - 1]!
  const skipTo = (marker: string, from: number) => {
    const j = src.indexOf(marker, from)
    if (j < 0) throw new XmlError(`Unterminated ${marker === '-->' ? 'comment' : 'markup'} at offset ${from}`)
    return j + marker.length
  }
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) i = skipTo('-->', lt + 4)
    else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end < 0) throw new XmlError('Unterminated CDATA')
      top().text += src.slice(lt + 9, end)
      i = end + 3
    } else if (src.startsWith('<?', lt)) i = skipTo('?>', lt + 2)
    else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...]: skip it whole.
      let j = lt + 2
      let depth = 0
      for (; j < n; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      i = j + 1
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt)
      if (end < 0) throw new XmlError('Unterminated end tag')
      const name = src.slice(lt + 2, end).trim()
      if (stack.length === 1 || top().name !== name) throw new XmlError(`Mismatched </${name}> at offset ${lt}`)
      stack.pop()
      i = end + 1
    } else {
      // Start tag: find the closing '>' outside quoted attribute values.
      let j = lt + 1
      let q: string | null = null
      for (; j < n; j++) {
        const c = src[j]
        if (q) {
          if (c === q) q = null
        } else if (c === '"' || c === "'") q = c
        else if (c === '>') break
      }
      if (j >= n) throw new XmlError('Unterminated start tag')
      let body = src.slice(lt + 1, j)
      const selfClose = body.endsWith('/')
      if (selfClose) body = body.slice(0, -1)
      const m = /^([^\s/>]+)/.exec(body)
      if (!m) throw new XmlError(`Bad tag at offset ${lt}`)
      // Null prototype: attribute names come from the file ("__proto__", "constructor").
      const el: XmlElement = { name: m[1]!, attrs: Object.create(null) as Record<string, string>, children: [], text: '' }
      for (const a of body.slice(m[1]!.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        el.attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '')
      }
      top().children.push(el)
      if (!selfClose) {
        if (stack.length > MAX_DEPTH) throw new XmlError('XML nesting is too deep')
        stack.push(el)
      }
      i = j + 1
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed <${top().name}>`)
  const docEl = root.children[0]
  if (!docEl) throw new XmlError('No root element')
  return docEl
}
