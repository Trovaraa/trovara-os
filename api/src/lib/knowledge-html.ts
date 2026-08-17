const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

function inlineMarkdown(html: string): string {
  let value = html
  value = value.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner: string) => {
    const text = stripTags(inner)
    return text ? `**${text}**` : ''
  })
  value = value.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = stripTags(inner)
    if (!text) return ''
    return /^https?:\/\//i.test(href) ? `[${text}](${href})` : text
  })
  return stripTags(value)
}

function replaceUntilStable(value: string, pattern: RegExp, replacement = ''): string {
  let previous = ''
  let current = value
  while (current !== previous) {
    previous = current
    current = current.replace(new RegExp(pattern.source, pattern.flags), replacement)
  }
  return current
}

function stripTags(html: string): string {
  return decodeHtmlEntities(
    replaceUntilStable(
      html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(?:p|div|h[1-6])>/gi, ' '),
      /<[^>]+>/g,
      ' ',
    ),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeTableCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function convertTable(tableHtml: string): string {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) =>
      [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => {
        const text = escapeTableCell(inlineMarkdown(cell[1]!))
        return text || ' '
      }),
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

/** Turn Mammoth HTML into reviewable markdown, keeping Word tables as GFM tables. */
export function htmlToGuidelineMarkdown(html: string): string {
  let value = replaceUntilStable(html, /<!--[\s\S]*?-->/g)
  value = replaceUntilStable(value, /<style\b[^>]*>[\s\S]*?<\/style>/gi)
  value = replaceUntilStable(value, /<script\b[^>]*>[\s\S]*?<\/script>/gi)
  value = value.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => `\n\n${convertTable(table)}\n\n`)
  value = value.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    const text = inlineMarkdown(inner)
    return text ? `\n\n${'#'.repeat(Math.min(Number(level), 3))} ${text}\n\n` : '\n\n'
  })
  value = value.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `- ${inlineMarkdown(inner)}\n`)
  value = value.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
  value = value.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner: string) => {
    const text = inlineMarkdown(inner)
    return text ? `${text}\n\n` : '\n'
  })
  value = value.replace(/<br\s*\/?>/gi, '\n')
  value = value.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner: string) => {
    const text = inlineMarkdown(inner)
    return text ? `**${text}**` : ''
  })
  value = replaceUntilStable(value, /<[^>]+>/g)
  return decodeHtmlEntities(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export function isMarkdownTableBlock(value: string): boolean {
  const lines = value.trim().split('\n')
  return lines.length >= 2 && lines.every((line) => line.includes('|'))
}
