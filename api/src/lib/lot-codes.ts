export type HarvestPeriod = '001' | '002' | '003'
export type LotUnit = 'kg' | 'crates'

const PERIOD_LABEL: Record<HarvestPeriod, string> = {
  '001': 'morning',
  '002': 'afternoon',
  '003': 'evening',
}

/** Map wall-clock hour in farm local time to harvest period code. */
export function harvestPeriodFromHour(hour: number): HarvestPeriod {
  if (hour >= 5 && hour < 12) return '001'
  if (hour >= 12 && hour < 17) return '002'
  return '003'
}

export function harvestPeriodLabel(period: HarvestPeriod): string {
  return PERIOD_LABEL[period]
}

/**
 * Hour (0–23) for `when` in `timeZone` using Intl. Falls back to UTC on bad TZ.
 */
export function localHour(when: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(when)
    const hour = parts.find((p) => p.type === 'hour')?.value
    return hour !== undefined ? Number(hour) : when.getUTCHours()
  } catch {
    return when.getUTCHours()
  }
}

export function harvestPeriodAt(when: Date, timeZone = 'Africa/Lagos'): HarvestPeriod {
  return harvestPeriodFromHour(localHour(when, timeZone))
}

export function yyyymmddLocal(when: Date, timeZone = 'Africa/Lagos'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(when)
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
    const m = parts.find((p) => p.type === 'month')?.value ?? '01'
    const d = parts.find((p) => p.type === 'day')?.value ?? '01'
    return `${y}${m}${d}`
  } catch {
    return when.toISOString().slice(0, 10).replace(/-/g, '')
  }
}

/** Normalize product/catalog units into lot units. */
export function normalizeLotUnit(raw: string | null | undefined): LotUnit {
  const u = (raw ?? 'kg').trim().toLowerCase()
  if (u === 'crate' || u === 'crates' || u === 'tray' || u === 'trays') return 'crates'
  return 'kg'
}

export function buildLotCodeBase(params: {
  orderReference?: string | null
  period: HarvestPeriod
  when?: Date
  timeZone?: string
}): string {
  if (params.orderReference) {
    return `${params.orderReference}-${params.period}`
  }
  const date = yyyymmddLocal(params.when ?? new Date(), params.timeZone ?? 'Africa/Lagos')
  return `LOT-${date}-${params.period}`
}

/**
 * Pick a unique lot code. If `base` exists in `existing`, append -2, -3, …
 */
export function allocateLotCode(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
