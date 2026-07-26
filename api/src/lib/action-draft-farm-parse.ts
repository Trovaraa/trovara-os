/**
 * Butler line grammar for crop and livestock drafts.
 *
 * A `key=value` value may run to several words — `species=poulet a double fin`,
 * `type=noix de coco` — because the species and crop lexicons are full of
 * multi-word aliases in four languages and a field worker types the alias, not
 * the English key. Those values are captured as `\S+(?:\s+(?!\w+\s*=)\S+)*`:
 * words are taken until the next `key=` token or the end of the line, so a
 * following `heads=200`, `plot=Block 2` or `planted=...` still parses into its
 * own group and no trailing whitespace lands in the value.
 */

/** Crop: Block 2 type=plantain planted=2026-07-19 [harvest=YYYY-MM-DD] [yield=500] */
export function parseCropCycleIntent(text: string): {
  plotName: string
  cropType: string
  plantedAt: string
  expectedHarvestAt?: string
  expectedYieldKg?: number
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:create\s+)?crop(?:\s+cycle)?\s*[:\-–]?\s*(.+?)\s+type\s*=\s*(\S+(?:\s+(?!\w+\s*=)\S+)*)\s+planted\s*=\s*(\d{4}-\d{2}-\d{2})(?:\s+harvest\s*=\s*(\d{4}-\d{2}-\d{2}))?(?:\s+yield\s*=\s*(\d+))?$/i,
  )
  if (!match) return null
  return {
    plotName: match[1].trim(),
    cropType: match[2].trim(),
    plantedAt: match[3],
    expectedHarvestAt: match[4],
    expectedYieldKg: match[5] != null ? Number(match[5]) : undefined,
  }
}

/** Livestock: Noiler A species=noiler heads=200 [plot=Block 2] [acquired=YYYY-MM-DD] */
export function parseLivestockBatchIntent(text: string): {
  name: string
  species: string
  headCount: number
  plotName?: string
  acquiredAt: string
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:create\s+)?(?:livestock|batch)\s*[:\-–]?\s*(.+?)\s+species\s*=\s*(\S+(?:\s+(?!\w+\s*=)\S+)*)\s+heads?\s*=\s*(\d+)(?:\s+plot\s*=\s*(.+?))?(?:\s+acquired\s*=\s*(\d{4}-\d{2}-\d{2}))?\s*$/i,
  )
  if (!match) return null
  return {
    name: match[1].trim(),
    species: match[2].trim(),
    headCount: Number(match[3]),
    plotName: match[4]?.trim(),
    acquiredAt: match[5] ?? new Date().toISOString().slice(0, 10),
  }
}
