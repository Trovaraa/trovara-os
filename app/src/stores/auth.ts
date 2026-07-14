import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/lib/api'
import { clearSensitiveClientData } from '@/lib/client-cleanup'
import router from '@/router'

export type UserRole = 'owner' | 'supervisor' | 'field_worker'

export type User = {
  id: string
  email: string
  name: string
  role: UserRole
  farmId: string
  totpEnabled?: boolean
  butlerTtsMode?: 'off' | 'voice_replies' | 'always'
  mustChangePassword?: boolean
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
  const canApprove = computed(
    () => user.value?.role === 'owner' || user.value?.role === 'supervisor',
  )

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
        if (!options?.skipRedirect && user.value) {
          await router.push(user.value.role === 'field_worker' ? '/today' : '/dashboard')
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

  return { user, loading, error, isAuthenticated, isOwner, canApprove, fetchMe, login, logout }
})
