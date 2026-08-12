/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

import 'vue-router'
import type { UserRole } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean
    guest?: boolean
    fieldWorkerOnly?: boolean
    requiredPermission?: string
    anyPermission?: string[]
    allowedRoles?: UserRole[]
  }
}
interface ImportMetaEnv {
  readonly VITE_API_URL: string
  /** OS SPA origin for staff/app links (build-time). */
  readonly VITE_PUBLIC_APP_URL?: string
  /** Marketing origin for buyer-facing lot QR/share links when set. */
  readonly VITE_PUBLIC_MARKETING_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
