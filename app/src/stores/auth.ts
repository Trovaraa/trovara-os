import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { api } from '@/lib/api'
import { clearSensitiveClientData } from '@/lib/client-cleanup'
import i18n, { persistLocale, type AppLocale } from '@/i18n'
import router from '@/router'

export type UserRole = 'owner' | 'supervisor' | 'field_worker' | 'sales'

export type User = {
  id: string
  email: string
  name: string
  role: UserRole
  farmId: string
  farmRoleId?: string | null
  permissions?: string[]
  isBreakGlass?: boolean
  totpEnabled?: boolean
  butlerTtsMode?: 'off' | 'voice_replies' | 'always'
  preferredLocale?: AppLocale
  mustChangePassword?: boolean
}

function isAppLocale(value: unknown): value is AppLocale {
  return value === 'en' || value === 'yo' || value === 'pcm' || value === 'fr'
}

/** Apply a locale to the running UI (vue-i18n + localStorage + <html lang>). */
export function applyLocale(locale: AppLocale) {
  i18n.global.locale.value = locale
  persistLocale(locale)
  document.documentElement.lang = locale === 'pcm' ? 'en' : locale
}

type LoginSuccessResponse = {
  user: User
  mustChangePassword?: boolean
}

type LoginTotpChallengeResponse = {
  requiresTotp: true
  totpChallenge: string
}

type LoginResponse = LoginSuccessResponse | LoginTotpChallengeResponse

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => !!user.value)
  const isOwner = computed(() => user.value?.role === 'owner')
  function hasPermission(key: string): boolean {
    if (user.value?.role === 'owner') return true
    return user.value?.permissions?.includes(key) ?? false
  }
  const canApprove = computed(
    () =>
      hasPermission('tasks.approve') ||
      user.value?.role === 'owner' ||
      user.value?.role === 'supervisor',
  )
  const canManageOrders = computed(
    () =>
      hasPermission('orders.manage') ||
      user.value?.role === 'owner' ||
      user.value?.role === 'supervisor' ||
      user.value?.role === 'sales',
  )
  const canManageProducts = computed(() => canManageOrders.value)
  const isSales = computed(() => user.value?.role === 'sales')
  const canAccessFinance = computed(
    () =>
      hasPermission('finance.read') ||
      user.value?.role === 'owner' ||
      user.value?.role === 'sales',
  )

  // The profile is the cross-device source of truth for language: it also drives
  // AI content and Telegram/WhatsApp messages, so the chrome follows it on login
  // and on session restore rather than whatever this device last cached.
  watch(
    () => user.value?.preferredLocale,
    (locale) => {
      if (isAppLocale(locale)) applyLocale(locale)
    },
  )

  /**
   * Mirror a UI language switch onto the profile. Best-effort: signed-out users
   * and failed writes are silently ignored so the switcher never blocks or throws.
   */
  async function savePreferredLocale(locale: AppLocale) {
    if (!user.value || user.value.preferredLocale === locale) return
    user.value = { ...user.value, preferredLocale: locale }
    try {
      await api('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferredLocale: locale }),
      })
    } catch {
      // Keep the optimistic UI change; the next explicit switch retries the write.
    }
  }

  async function fetchMe() {
    try {
      const data = await api<{ user: User }>('/auth/me')
      user.value = data.user
    } catch {
      user.value = null
    }
  }

  async function login(
    email: string,
    password: string,
    options?: { skipRedirect?: boolean },
  ): Promise<LoginResponse> {
    loading.value = true
    error.value = null
    try {
      const data = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      if ('requiresTotp' in data && data.requiresTotp) {
        user.value = null
        return data
      }
      if ('user' in data) {
        user.value = data.user
        await fetchMe()
        if (!options?.skipRedirect && user.value) {
          await router.push(user.value.role === 'field_worker' ? '/today' : user.value.role === 'sales' ? '/sales' : '/dashboard')
        }
      }
      return data
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Login failed'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' })
    } finally {
      await clearSensitiveClientData()
      user.value = null
      await router.push('/login')
    }
  }

  return {
    user,
    loading,
    error,
    isAuthenticated,
    isOwner,
    hasPermission,
    canApprove,
    canManageOrders,
    canManageProducts,
    isSales,
    canAccessFinance,
    fetchMe,
    login,
    logout,
    savePreferredLocale,
  }
})
