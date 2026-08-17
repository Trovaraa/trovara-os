import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

type ChildNode = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode

type RenderContext = {
  tableCell?: boolean
}

const OMITTED_ELEMENTS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed'])

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node
}

function childrenOf(node: ParentNode | Element): ChildNode[] {
  return 'childNodes' in node ? node.childNodes : []
}

function escapeMarkdownText(value: string, tableCell = false): string {
  let escaped = value.replace(/\\/g, '\\\\')
  if (tableCell) escaped = escaped.replace(/\|/g, '\\|')
  return escaped.replace(/([`*_[\]<>])/g, '\\$1')
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function safeHttpUrl(value: string): string | null {
  if (!value || value.length > 2_048 || containsControlCharacter(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

function renderChildren(node: ParentNode | Element, context: RenderContext = {}): string {
  return childrenOf(node)
    .map((child) => renderNode(child, context))
    .join('')
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((item) => item.name.toLowerCase() === name)?.value ?? null
}

function descendantRows(element: Element): Element[] {
  const rows: Element[] = []
  const visit = (node: ChildNode) => {
    if (!isElement(node)) return
    if (node.tagName === 'table' && node !== element) return
    if (node.tagName === 'tr') {
      rows.push(node)
      return
    }
    node.childNodes.forEach(visit)
  }
  element.childNodes.forEach(visit)
  return rows
}

function renderTable(table: Element): string {
  const rows = descendantRows(table)
    .map((row) =>
      row.childNodes
        .filter((node): node is Element => isElement(node) && ['td', 'th'].includes(node.tagName))
        .map((cell) => renderChildren(cell, { tableCell: true }).replace(/\s+/g, ' ').trim() || ' '),
    )
    .filter((row) => row.length > 0)

  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const padded = rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => ' ')])
  const [header, ...body] = padded
  if (!header) return ''

  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function renderNode(node: ChildNode, context: RenderContext = {}): string {
  if ('value' in node) return escapeMarkdownText(node.value, context.tableCell)
  if (!isElement(node) || OMITTED_ELEMENTS.has(node.tagName)) return ''

  const tag = node.tagName.toLowerCase()
  if (tag === 'table') return `\n\n${renderTable(node)}\n\n`
  if (/^h[1-6]$/.test(tag)) {
    const text = renderChildren(node, context).replace(/\s+/g, ' ').trim()
    const level = Math.min(Number(tag.slice(1)), 3)
    return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '\n\n'
  }
  if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
    const text = renderChildren(node, context).trim()
    return text ? `${text}\n\n` : '\n'
  }
  if (tag === 'br') return context.tableCell ? ' ' : '\n'
  if (tag === 'li') {
    const text = renderChildren(node, context).replace(/\s+/g, ' ').trim()
    return text ? `- ${text}\n` : ''
  }
  if (tag === 'ul' || tag === 'ol') return `\n${renderChildren(node, context)}\n`
  if (tag === 'strong' || tag === 'b') {
    const text = renderChildren(node, context).trim()
    return text ? `**${text}**` : ''
  }
  if (tag === 'em' || tag === 'i') {
    const text = renderChildren(node, context).trim()
    return text ? `*${text}*` : ''
  }
  if (tag === 'a') {
    const text = renderChildren(node, context).replace(/\s+/g, ' ').trim()
    if (!text) return ''
    const href = safeHttpUrl(attribute(node, 'href') ?? '')
    return href ? `[${text}](<${href}>)` : text
  }

  return renderChildren(node, context)
}

/** Turn Mammoth HTML into reviewable markdown, keeping Word tables as GFM tables. */
export function htmlToGuidelineMarkdown(html: string): string {
  const fragment = parseFragment(html)
  return renderChildren(fragment)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export function isMarkdownTableBlock(value: string): boolean {
  const lines = value.trim().split('\n')
  return lines.length >= 2 && lines.every((line) => line.includes('|'))
}
