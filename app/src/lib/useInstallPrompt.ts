/** Shared Add-to-Home-Screen helpers for Trovara OS. */
import { ref, onMounted, onBeforeUnmount } from 'vue'

const DISMISS_KEY = 'trovara-os-a2hs-dismissed-until'
const DISMISS_DAYS = 21

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone =
    'standalone' in navigator && (navigator as Navigator & { standalone?: boolean }).standalone
  return Boolean(iosStandalone) || window.matchMedia('(display-mode: standalone)').matches
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    return Date.now() < Number(raw)
  } catch {
    return false
  }
}

export function useInstallPrompt() {
  const visible = ref(false)
  const canPrompt = ref(false)
  const iosHint = ref(false)
  let deferred: BeforeInstallPromptEvent | null = null

  function showIfEligible() {
    if (isStandalone() || isDismissed()) {
      visible.value = false
      return
    }
    if (deferred) {
      canPrompt.value = true
      iosHint.value = false
      visible.value = true
      return
    }
    if (isIos()) {
      canPrompt.value = false
      iosHint.value = true
      visible.value = true
    }
  }

  function onBeforeInstall(e: Event) {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    showIfEligible()
  }

  async function install() {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    deferred = null
    canPrompt.value = false
    visible.value = false
  }

  function dismiss() {
    visible.value = false
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000))
    } catch {
      /* ignore */
    }
  }

  onMounted(() => {
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.setTimeout(showIfEligible, 2000)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  })

  return { visible, canPrompt, iosHint, install, dismiss }
}
