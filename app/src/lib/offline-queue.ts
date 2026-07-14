/**
 * Offline queue stub — localStorage-backed write queue for field workers.
 *
 * Pattern:
 * 1. When `navigator.onLine` is false, enqueue mutations (PATCH task, add note, etc.)
 *    instead of calling the API directly.
 * 2. On `window` `online` event, drain the queue FIFO and replay each item via `api()`.
 * 3. Failed sync items stay at the head of the queue for retry; optionally cap queue size.
 *
 * Full sync (not implemented yet): compare server updatedAt vs local cache, merge conflicts.
 */

const QUEUE_KEY = 'trovara-offline-queue'
const MAX_QUEUE_SIZE = 20

export type QueuedRequest = {
  id: string
  path: string
  method: string
  body?: string
  createdAt: string
}

function readQueue(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as QueuedRequest[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(queue: QueuedRequest[]): boolean {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      return false
    }
    throw err
  }
}

/** Append a request to the offline queue (newest at end). Returns false if full or quota exceeded. */
export function enqueue(item: Omit<QueuedRequest, 'id' | 'createdAt'>): QueuedRequest | false {
  const queue = readQueue()
  if (queue.length >= MAX_QUEUE_SIZE) return false

  const entry: QueuedRequest = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
  queue.push(entry)
  if (!writeQueue(queue)) return false
  return entry
}

/** Remove and return the oldest queued request, or null if empty. */
export function dequeue(): QueuedRequest | null {
  const queue = readQueue()
  if (queue.length === 0) return null
  const [head, ...rest] = queue
  writeQueue(rest)
  return head
}

/** Peek at queue length without mutating. */
export function queueLength(): number {
  return readQueue().length
}

/** Clear entire queue (e.g. after successful full sync). */
export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY)
}

/**
 * Drain queue on reconnect — stub: logs items; wire to `api()` when sync is implemented.
 *
 * ```ts
 * window.addEventListener('online', () => { void syncOfflineQueue(api) })
 * ```
 */
export async function syncOfflineQueue(
  send: (path: string, init: RequestInit) => Promise<unknown>,
): Promise<{ synced: number; failed: number }> {
  let synced = 0
  let failed = 0

  while (queueLength() > 0) {
    const item = dequeue()
    if (!item) break
    try {
      await send(item.path, {
        method: item.method,
        body: item.body,
      })
      synced++
    } catch {
      const requeued = enqueue({ path: item.path, method: item.method, body: item.body })
      if (!requeued) break
      failed++
      break
    }
  }

  return { synced, failed }
}
