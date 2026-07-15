import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg', 'icons/icon-maskable.svg'],
      manifest: false, // we have our own manifest.webmanifest in /public
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            // API calls - network first, fall back to cached response (stale data ok for GET)
            urlPattern: ({ url }) => {
              const path = url.pathname
              return path === '/api/tasks' || path.startsWith('/api/today')
            },
            handler: 'NetworkFirst',
            options: {
              cacheName: 'trovara-api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
              networkTimeoutSeconds: 5,
            },
          },
        ],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/auth/, /^\/public/],
        skipWaiting: false,
        clientsClaim: false,
      },
      devOptions: {
        enabled: false, // keep dev clean; SW only active in production build
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/auth': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/public': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
})
