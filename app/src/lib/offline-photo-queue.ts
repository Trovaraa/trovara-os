const STORAGE_KEY = 'trovara-offline-photo-queue'
const MAX_QUEUE_SIZE = 20

type PhotoQueue = Record<string, string>

function readQueue(): PhotoQueue {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PhotoQueue
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

function writeQueue(queue: PhotoQueue): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue))
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      return false
    }
    throw err
  }
}

export function clearPhotoQueue(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function queueOfflinePhoto(taskId: string, photoUrl: string): boolean {
  const queue = readQueue()
  const keys = Object.keys(queue)
  if (!keys.includes(taskId) && keys.length >= MAX_QUEUE_SIZE) return false
  queue[taskId] = photoUrl
  return writeQueue(queue)
}

export function clearQueuedPhoto(taskId: string): void {
  const queue = readQueue()
  if (!queue[taskId]) return
  delete queue[taskId]
  writeQueue(queue)
}

export function getQueuedPhoto(taskId: string): string | null {
  const queue = readQueue()
  return queue[taskId] ?? null
}

export async function syncOfflinePhotos(
  apiFn: (path: string, options: RequestInit) => Promise<unknown>,
): Promise<{ synced: number; failed: number }> {
  if (!navigator.onLine) return { synced: 0, failed: 0 }
  const queue = readQueue()
  const entries = Object.entries(queue)
  let synced = 0
  let failed = 0

  for (const [taskId, photoUrl] of entries) {
    try {
      await apiFn(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ photoUrl }),
      })
      delete queue[taskId]
      synced += 1
    } catch {
      failed += 1
    }
  }

  writeQueue(queue)
  return { synced, failed }
}
