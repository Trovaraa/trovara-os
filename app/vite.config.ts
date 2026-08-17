import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { VitePWA } from 'vite-plugin-pwa'

// The production host serves the app shell from a web server config we do not
// ship, and a check on 26 July 2026 found it sending no CSP at all, so the
// policy travels with the document instead of depending on the proxy. Build
// only: in dev this would refuse Vite's HMR socket. `frame-ancestors` is
// ignored in a meta tag and stays in the nginx config.
function contentSecurityPolicy(apiUrl: string): Plugin {
  let apiOrigin = ''
  try {
    apiOrigin = apiUrl ? new URL(apiUrl).origin : ''
  } catch {
    throw new Error('VITE_API_URL must be an absolute URL when configured')
  }
  const external = apiOrigin && apiOrigin !== 'null' ? ` ${apiOrigin}` : ''
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // Evidence photos and voice notes are read back as object URLs.
    `img-src 'self' data: blob:${external}`,
    `media-src 'self' blob:${external}`,
    "font-src 'self' data:",
    `connect-src 'self'${external}`,
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ')

  return {
    name: 'trovara-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => ({
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      }),
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
  plugins: [
    vue(),
    contentSecurityPolicy(env.VITE_API_URL?.trim() ?? ''),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/trovara-os-icon.svg', 'icons/icon-maskable.svg'],
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
  build: {
    rollupOptions: {
      output: {
        // Pages are already route-lazy. Keep stable framework code out of the
        // entry chunk so it caches independently across OS deployments.
        manualChunks(id) {
          if (id.includes('/node_modules/vue-i18n/')) return 'i18n-runtime'
          if (
            id.includes('/node_modules/vue/') ||
            id.includes('/node_modules/vue-router/') ||
            id.includes('/node_modules/pinia/')
          ) return 'vue-core'
          if (id.includes('/node_modules/@vueuse/')) return 'vueuse'
        },
      },
    },
  },
  }
})
