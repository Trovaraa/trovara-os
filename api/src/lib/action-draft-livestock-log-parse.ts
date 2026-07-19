/** Feed: Broiler A [notes=...] OR Feeding: Broiler A */
/** Vaccinate: Broiler A [notes=...] OR Vaccination: ... */
/** Mortality: Broiler A heads=3 [notes=...] */
export function parseLivestockLogIntent(text: string): {
  logType: 'feeding' | 'vaccination' | 'mortality'
  batchQuery: string
  headCount?: number
  notes?: string
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(feed(?:ing)?|vaccinat(?:e|ion)|mortality)\s*[:\-–]?\s*(.+?)(?:\s+heads?\s*=\s*(\d+))?(?:\s+notes?\s*=\s*(.+))?\s*$/i,
  )
  if (!match) return null

  const kind = match[1].toLowerCase()
  let logType: 'feeding' | 'vaccination' | 'mortality'
  if (kind === 'feed' || kind === 'feeding') logType = 'feeding'
  else if (kind === 'vaccinate' || kind === 'vaccination') logType = 'vaccination'
  else logType = 'mortality'

  const batchQuery = match[2].trim()
  if (!batchQuery) return null

  const headCount = match[3] != null ? Number(match[3]) : undefined
  if (logType === 'mortality' && (headCount == null || !Number.isFinite(headCount) || headCount < 1)) {
    return null
  }

  const notes = match[4]?.trim()
  return {
    logType,
    batchQuery: batchQuery.slice(0, 200),
    headCount,
    notes: notes ? notes.slice(0, 2000) : undefined,
  }
}
