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
        // Workbox's production terser worker exits early under Node 22 in some
        // constrained build environments. The development mode only disables
        // service-worker minification; caching behavior remains production-safe.
        mode: 'development',
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            // Authenticated task/today APIs must never be cached offline.
            urlPattern: ({ url }) => {
              const path = url.pathname
              return path === '/api/tasks' || path.startsWith('/api/today')
            },
            handler: 'NetworkOnly',
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
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/auth': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/public': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
})
