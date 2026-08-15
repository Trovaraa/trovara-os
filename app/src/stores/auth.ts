import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/lib/api'
import { clearSensitiveClientData } from '@/lib/client-cleanup'
import i18n, { ensureLocaleLoaded, persistLocale, type AppLocale } from '@/i18n'
import router from '@/router'
import { defaultHome } from '@/lib/navigation'

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
export async function applyLocale(locale: AppLocale): Promise<void> {
  await ensureLocaleLoaded(locale)
  i18n.global.locale.value = locale
  persistLocale(locale)
  document.documentElement.lang = locale === 'pcm' ? 'en' : locale
}

async function applyProfileLocale(user: User): Promise<void> {
  if (!isAppLocale(user.preferredLocale)) return
  try {
    await applyLocale(user.preferredLocale)
  } catch {
    // A failed translation chunk must not invalidate a valid authenticated
    // session. Keep the language already loaded on this device and retry on the
    // next session restore or explicit language switch.
  }
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
  const canApprove = computed(() => hasPermission('tasks.approve'))
  const canManageOrders = computed(() => hasPermission('orders.manage'))
  const canManageProducts = computed(() => hasPermission('products.manage'))
  const isSales = computed(() => user.value?.role === 'sales')
  const canAccessFinance = computed(() => hasPermission('finance.read'))

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
      // Session restoration is not complete until the profile language is
      // available. Awaiting the lazy dictionary avoids an English flash and
      // makes callers observe one settled authentication state.
      await applyProfileLocale(data.user)
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
        await applyProfileLocale(data.user)
        await fetchMe()
        if (!options?.skipRedirect && user.value) {
          await router.push(defaultHome(user.value.role))
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
