/** Stock: Feed bags delta=-2 reason=used  OR  Move: Feed bags -5 used */
export function parseStockMoveIntent(text: string): {
  itemQuery: string
  delta: number
  reason: string
} | null {
  const trimmed = text.trim()
  const keyed = trimmed.match(
    /^(?:stock|move\s+stock|move)\s*[:\-–]?\s*(.+?)\s+delta\s*=\s*([+-]?\d+)\s+reason\s*=\s*(.+)$/i,
  )
  if (keyed) {
    return {
      itemQuery: keyed[1].trim(),
      delta: Number(keyed[2]),
      reason: keyed[3].trim(),
    }
  }

  const shorthand = trimmed.match(
    /^(?:stock|move\s+stock|move)\s*[:\-–]?\s*(.+?)\s+([+-]?\d+)\s+(.+)$/i,
  )
  if (!shorthand) return null
  return {
    itemQuery: shorthand[1].trim(),
    delta: Number(shorthand[2]),
    reason: shorthand[3].trim(),
  }
}

/** Opening count: Feed bags=50  OR  Opening: Feed bags count=50 */
export function parseOpeningCountIntent(text: string): {
  itemQuery: string
  countedQuantity: number
} | null {
  const trimmed = text.trim()
  const withCountKey = trimmed.match(
    /^(?:opening(?:\s+count)?)\s*[:\-–]?\s*(.+?)\s+count\s*=\s*(\d+)$/i,
  )
  if (withCountKey) {
    return {
      itemQuery: withCountKey[1].trim(),
      countedQuantity: Number(withCountKey[2]),
    }
  }

  const withEquals = trimmed.match(
    /^(?:opening(?:\s+count)?)\s*[:\-–]?\s*(.+?)\s*=\s*(\d+)$/i,
  )
  if (!withEquals) return null
  return {
    itemQuery: withEquals[1].trim(),
    countedQuantity: Number(withEquals[2]),
  }
}

/** Ack low stock  OR  Acknowledge low stock: Feed bags  (item optional = all) */
export function parseLowStockAckIntent(text: string): {
  itemQuery: string | null
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:ack|acknowledge)\s+low\s+stock(?:\s*[:\-–]?\s*(.+))?$/i,
  )
  if (!match) return null
  const itemQuery = match[1]?.trim() || null
  return { itemQuery }
}
