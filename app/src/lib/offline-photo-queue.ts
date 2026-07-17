const LEGACY_STORAGE_KEY = 'trovara-offline-photo-queue'
const DB_NAME = 'trovara-offline-photos'
const STORE_NAME = 'photos'
const DB_VERSION = 1
const MAX_QUEUE_SIZE = 20
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

type PhotoEntry = {
  taskId: string
  photoUrl: string
  queuedAt: number
}

function isExpired(entry: PhotoEntry, now = Date.now()): boolean {
  return now - entry.queuedAt > EXPIRY_MS
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'taskId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open offline photo queue'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      const result = fn(store)
      if (result instanceof Promise) {
        result.then(resolve).catch(reject)
        return
      }
      result.onsuccess = () => resolve(result.result as T)
      result.onerror = () => reject(result.error ?? new Error('Offline photo queue operation failed'))
    })
  } finally {
    db.close()
  }
}

async function readAllEntries(): Promise<PhotoEntry[]> {
  return withStore('readonly', (store) => store.getAll())
}

async function writeEntry(entry: PhotoEntry): Promise<void> {
  await withStore('readwrite', (store) => store.put(entry))
}

async function deleteEntry(taskId: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(taskId))
}

async function clearAllEntries(): Promise<void> {
  await withStore('readwrite', (store) => store.clear())
}

async function pruneExpiredEntries(entries: PhotoEntry[]): Promise<PhotoEntry[]> {
  const now = Date.now()
  const fresh = entries.filter((entry) => !isExpired(entry, now))
  const expired = entries.filter((entry) => isExpired(entry, now))
  await Promise.all(expired.map((entry) => deleteEntry(entry.taskId)))
  return fresh
}

function readLegacyQueue(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

async function migrateLegacyQueue(): Promise<void> {
  const legacy = readLegacyQueue()
  const taskIds = Object.keys(legacy)
  if (taskIds.length === 0) return

  const now = Date.now()
  for (const taskId of taskIds) {
    const photoUrl = legacy[taskId]
    if (typeof photoUrl === 'string' && photoUrl) {
      await writeEntry({ taskId, photoUrl, queuedAt: now })
    }
  }
  localStorage.removeItem(LEGACY_STORAGE_KEY)
}

let migrationPromise: Promise<void> | null = null

async function ensureReady(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateLegacyQueue()
  }
  await migrationPromise
}

export async function clearPhotoQueue(): Promise<void> {
  localStorage.removeItem(LEGACY_STORAGE_KEY)
  if (typeof indexedDB === 'undefined') return
  try {
    await clearAllEntries()
  } catch {
    // ignore IndexedDB failures during logout cleanup
  }
}

export async function queueOfflinePhoto(taskId: string, photoUrl: string): Promise<boolean> {
  await ensureReady()
  const entries = await pruneExpiredEntries(await readAllEntries())
  if (!entries.some((entry) => entry.taskId === taskId) && entries.length >= MAX_QUEUE_SIZE) {
    return false
  }

  try {
    await writeEntry({ taskId, photoUrl, queuedAt: Date.now() })
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      return false
    }
    throw err
  }
}

export async function clearQueuedPhoto(taskId: string): Promise<void> {
  await ensureReady()
  await deleteEntry(taskId)
}

export async function getQueuedPhoto(taskId: string): Promise<string | null> {
  await ensureReady()
  const entries = await pruneExpiredEntries(await readAllEntries())
  return entries.find((entry) => entry.taskId === taskId)?.photoUrl ?? null
}

export async function syncOfflinePhotos(
  apiFn: (path: string, options: RequestInit) => Promise<unknown>,
): Promise<{ synced: number; failed: number }> {
  if (!navigator.onLine) return { synced: 0, failed: 0 }

  await ensureReady()
  const entries = await pruneExpiredEntries(await readAllEntries())
  let synced = 0
  let failed = 0

  for (const entry of entries) {
    try {
      await apiFn(`/api/tasks/${entry.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ photoUrl: entry.photoUrl }),
      })
      await deleteEntry(entry.taskId)
      synced += 1
    } catch {
      failed += 1
    }
  }

  return { synced, failed }
}
