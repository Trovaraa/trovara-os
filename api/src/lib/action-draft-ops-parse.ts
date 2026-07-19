/** Create task: Count coconut in Block 2 */
export function parseCreateTaskIntent(text: string): { title: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:create(?:\s+a)?\s+)?(?:task|handover\s+task)\s*[:\-–]?\s*(.+)$/i,
  )
  if (match?.[1]) return { title: match[1].trim().slice(0, 200) }
  if (/^create\s+.+/i.test(trimmed) && /task/i.test(trimmed)) {
    return { title: trimmed.replace(/^create\s+/i, '').slice(0, 200) }
  }
  return null
}

/** Census: <block> crop=<type> count=<n> [min=<n>] [max=<n>] */
export function parseCensusIntent(text: string): {
  blockName: string
  cropType: string
  plantCount: number
  minHeight?: number
  maxHeight?: number
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^census\s*[:\-–]?\s*(.+?)\s+crop\s*=\s*(\S+)\s+count\s*=\s*(\d+)(?:\s+min\s*=\s*([\d.]+))?(?:\s+max\s*=\s*([\d.]+))?$/i,
  )
  if (!match) return null
  return {
    blockName: match[1].trim(),
    cropType: match[2].trim(),
    plantCount: Number(match[3]),
    minHeight: match[4] != null ? Number(match[4]) : undefined,
    maxHeight: match[5] != null ? Number(match[5]) : undefined,
  }
}

/** Asset count: <asset name or tag> available=<n> [damaged=<n>] */
export function parseAssetCountIntent(text: string): {
  assetQuery: string
  countAvailable: number
  countDamaged: number
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^asset(?:\s+count)?\s*[:\-–]?\s*(.+?)\s+available\s*=\s*(\d+)(?:\s+damaged\s*=\s*(\d+))?$/i,
  )
  if (!match) return null
  return {
    assetQuery: match[1].trim(),
    countAvailable: Number(match[2]),
    countDamaged: match[3] != null ? Number(match[3]) : 0,
  }
}
