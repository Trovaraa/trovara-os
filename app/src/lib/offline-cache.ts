const CACHE_KEY = 'trovara-task-cache'

export type TaskCacheEntry = {
  data: unknown
  timestamp: string
}

export function getTasksCache(): TaskCacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TaskCacheEntry
    if (!parsed || typeof parsed.timestamp !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function setTasksCache(data: unknown): void {
  const entry: TaskCacheEntry = {
    data,
    timestamp: new Date().toISOString(),
  }
  localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
}

export function clearTasksCache(): void {
  localStorage.removeItem(CACHE_KEY)
}
