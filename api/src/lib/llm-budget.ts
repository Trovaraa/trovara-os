type FarmDayBucket = { count: number; dayKey: string }

const buckets = new Map<string, FarmDayBucket>()

function dayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function llmDailyBudgetPerFarm(): number {
  const raw = process.env.LLM_DAILY_BUDGET_PER_FARM?.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : 500
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500
}

/** Returns true when the farm may call the LLM (inquiry, ask, diagnosis, etc.). */
export function checkLlmBudget(farmId: string): { allowed: boolean; used: number; limit: number } {
  const limit = llmDailyBudgetPerFarm()
  const key = farmId
  const today = dayKey()
  const bucket = buckets.get(key)

  if (!bucket || bucket.dayKey !== today) {
    buckets.set(key, { count: 0, dayKey: today })
    return { allowed: true, used: 0, limit }
  }

  return { allowed: bucket.count < limit, used: bucket.count, limit }
}

/** Record one LLM call against the farm's daily budget. */
export function consumeLlmBudget(farmId: string): void {
  const today = dayKey()
  const bucket = buckets.get(farmId)
  if (!bucket || bucket.dayKey !== today) {
    buckets.set(farmId, { count: 1, dayKey: today })
    return
  }
  bucket.count += 1
}

export function resetLlmBudget(farmId?: string): void {
  if (farmId) buckets.delete(farmId)
  else buckets.clear()
}
