/** Create zone: North Field [description=...] */
export function parseCreateZoneIntent(text: string): { name: string; description?: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:create\s+)?zone\s*[:\-–]?\s*(.+?)(?:\s+description\s*=\s*(.+))?\s*$/i,
  )
  if (!match?.[1]) return null
  const name = match[1].trim()
  if (!name) return null
  const description = match[2]?.trim()
  return {
    name: name.slice(0, 200),
    description: description ? description.slice(0, 2000) : undefined,
  }
}

/** Create plot: Block 2 zone=North Field [crop=plantain] */
export function parseCreatePlotIntent(text: string): {
  name: string
  zoneName: string
  cropType?: string
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:create\s+)?(?:plot|block)\s*[:\-–]?\s*(.+?)\s+zone\s*=\s*(.+?)(?:\s+crop\s*=\s*(.+?))?\s*$/i,
  )
  if (!match) return null
  const name = match[1].trim()
  const zoneName = match[2].trim()
  if (!name || !zoneName) return null
  return {
    name: name.slice(0, 200),
    zoneName: zoneName.slice(0, 200),
    cropType: match[3]?.trim(),
  }
}
