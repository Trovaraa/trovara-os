import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { MotionPlugin } from '@vueuse/motion'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { startOfflineSyncListener } from '@/lib/offline-api'
import './style.css'

startOfflineSyncListener()

// Service worker registration with update prompt (production only)
if (import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      onNeedRefresh() {
        const banner = document.createElement('div')
        banner.id = 'sw-update-banner'
        banner.style.cssText = [
          'position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%)',
          'background:#1f6b42;color:#fff;padding:0.75rem 1.25rem',
          'border-radius:0.75rem;font-size:0.85rem;font-weight:600',
          'box-shadow:0 4px 24px rgba(0,0,0,0.5);z-index:9999',
          'display:flex;align-items:center;gap:0.75rem;white-space:nowrap',
        ].join(';')
        banner.innerHTML =
          'New version available - <button id="sw-update-btn" style="background:#fff;color:#1f6b42;border:none;border-radius:0.5rem;padding:0.25rem 0.75rem;font-weight:700;cursor:pointer">Update now</button>'
        document.body.appendChild(banner)
        document.getElementById('sw-update-btn')?.addEventListener('click', () => {
          void updateSW(true)
          banner.remove()
        })
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
