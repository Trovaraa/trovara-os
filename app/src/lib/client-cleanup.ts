import { clearQueue } from '@/lib/offline-queue'
import { clearTasksCache } from '@/lib/offline-cache'
import { clearPhotoQueue } from '@/lib/offline-photo-queue'

/** Clear offline queues, local caches, and service worker caches on logout. */
export async function clearSensitiveClientData(): Promise<void> {
  clearQueue()
  clearTasksCache()
  clearPhotoQueue()

  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => k.includes('trovara')).map((k) => caches.delete(k)),
      )
    } catch {
      // ignore cache API failures
    }
  }
}
