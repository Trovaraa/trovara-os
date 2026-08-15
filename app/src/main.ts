import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { MotionPlugin } from '@vueuse/motion'
import App from './App.vue'
import router from './router'
import i18n, { prepareInitialLocale } from './i18n'
import { startOfflineSyncListener } from '@/lib/offline-api'
import { applyTheme, readStoredTheme } from '@/lib/theme'
import './style.css'
import { announceSwUpdate } from '@/lib/sw-update'

// Re-apply after module load (index.html already set class to avoid FOUC).
applyTheme(readStoredTheme())

async function bootstrap() {
  startOfflineSyncListener()

  // Only English ships in the entry chunk. Load the remembered language before
  // mounting so returning staff never see an English flash.
  await prepareInitialLocale()

  // Service worker registration with update prompt (production only)
  if (import.meta.env.PROD) {
    import('virtual:pwa-register').then(({ registerSW }) => {
      const updateSW = registerSW({
        onNeedRefresh() {
          announceSwUpdate(() => updateSW(true))
        },
        onOfflineReady() {
          console.log('[Trovara OS] App shell cached - ready for offline use')
        },
      })
    })
  } else if ('serviceWorker' in navigator) {
    // Dev: unregister any service worker left over from a previous production build on
    // this origin. A stale SW intercepts API calls and serves the cached app shell,
    // breaking JSON responses (e.g. "Unexpected token '<'" when enabling 2FA).
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => void reg.unregister())
    })
    if ('caches' in window) {
      void caches.keys().then((keys) => keys.forEach((key) => void caches.delete(key)))
    }
  }

  createApp(App).use(createPinia()).use(router).use(i18n).use(MotionPlugin).mount('#app')
}

void bootstrap()
