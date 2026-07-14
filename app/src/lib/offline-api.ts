import { ref } from 'vue'
import { api } from '@/lib/api'
import { enqueue, queueLength, syncOfflineQueue } from '@/lib/offline-queue'
import { getTasksCache, setTasksCache } from '@/lib/offline-cache'

const TASKS_PATH = '/api/tasks'
const TASK_PATCH_RE = /^\/api\/tasks\/([^/]+)$/
const LAST_SYNCED_KEY = 'trovara_last_synced'

export const onlineStatus = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
export const pendingSyncCount = ref(0)
export const lastSyncedAt = ref<Date | null>(null)
export const syncStatus = ref<'idle' | 'syncing' | 'error'>('idle')

function loadLastSynced() {
  try {
    const raw = localStorage.getItem(LAST_SYNCED_KEY)
    if (raw) lastSyncedAt.value = new Date(raw)
  } catch {
    // ignore
  }
}

function saveLastSynced() {
  try {
    const now = new Date()
    lastSyncedAt.value = now
    localStorage.setItem(LAST_SYNCED_KEY, now.toISOString())
  } catch {
    // ignore
  }
}

function refreshPendingCount() {
  pendingSyncCount.value = queueLength()
}

export function isOnline(): boolean {
  return navigator.onLine
}

function isTasksGet(path: string, method: string): boolean {
  return path === TASKS_PATH && method === 'GET'
}

function applyOptimisticTaskPatch(path: string, body?: string) {
  if (!body) return
  const match = path.match(TASK_PATCH_RE)
  if (!match) return

  const cached = getTasksCache()
  if (!cached?.data) return

  try {
    const patch = JSON.parse(body) as Record<string, unknown>
    const payload = cached.data as { tasks?: Array<Record<string, unknown>> }
    const tasks = payload.tasks
    if (!Array.isArray(tasks)) return

    const task = tasks.find((row) => row.id === match[1])
    if (!task) return

    Object.assign(task, patch)
    setTasksCache(payload)
  } catch {
    // Ignore malformed optimistic updates
  }
}

export async function offlineApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const body =
    typeof options.body === 'string'
      ? options.body
      : options.body != null
        ? JSON.stringify(options.body)
        : undefined

  if (isOnline()) {
    const result = await api<T>(path, { ...options, body })
    if (isTasksGet(path, method)) {
      setTasksCache(result)
      saveLastSynced()
    }
    return result
  }

  if (method === 'GET') {
    if (path === TASKS_PATH) {
      const cached = getTasksCache()
      if (cached) return cached.data as T
      throw new Error('No cached tasks available offline')
    }
    throw new Error('Cannot fetch while offline')
  }

  if (method === 'PATCH' || method === 'POST') {
    const enqueued = enqueue({ path, method, body })
    if (!enqueued) {
      throw new Error('Offline queue full or storage quota exceeded')
    }
    applyOptimisticTaskPatch(path, body)
    refreshPendingCount()
    window.dispatchEvent(new CustomEvent('trovara-offline-queue-change'))
    return {} as T
  }

  throw new Error(`Offline: ${method} not supported`)
}

async function drainQueue() {
  if (!isOnline()) return
  syncStatus.value = 'syncing'

  try {
    await syncOfflineQueue((path, init) => api(path, init))
    refreshPendingCount()
    window.dispatchEvent(new CustomEvent('trovara-sync-complete'))

    try {
      const fresh = await api<unknown>(TASKS_PATH)
      setTasksCache(fresh)
      saveLastSynced()
    } catch {
      // Keep existing cache if refresh fails
    }
    syncStatus.value = 'idle'
  } catch {
    syncStatus.value = 'error'
    window.dispatchEvent(new CustomEvent('trovara-sync-failed'))
  }
}

export async function retrySync(): Promise<void> {
  await drainQueue()
}

export function startOfflineSyncListener(): void {
  loadLastSynced()
  refreshPendingCount()

  window.addEventListener('online', () => {
    onlineStatus.value = true
    void drainQueue()
  })

  window.addEventListener('offline', () => {
    onlineStatus.value = false
  })

  window.addEventListener('trovara-offline-queue-change', () => {
    refreshPendingCount()
  })

  if (isOnline() && queueLength() > 0) {
    void drainQueue()
  }
}
