import { ref } from 'vue'

export const swUpdateAvailable = ref(false)
let applyUpdate: (() => Promise<void>) | null = null

export function announceSwUpdate(update: () => Promise<void>) {
  applyUpdate = update
  swUpdateAvailable.value = true
}

export async function installSwUpdate() {
  if (!applyUpdate) return
  swUpdateAvailable.value = false
  await applyUpdate()
}
