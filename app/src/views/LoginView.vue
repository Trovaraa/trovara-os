<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'
import router from '@/router'
import { api } from '@/lib/api'
import type { ConsentStatus } from '@/lib/consent'

const auth = useAuthStore()
const { t } = useI18n()
const email = ref('')
const password = ref('')
const flash = ref<string | null>(null)
const privacyAccepted = ref(false)
const consentStatus = ref<ConsentStatus | null>(null)
const consentError = ref<string | null>(null)
const forgotOpen = ref(false)
const forgotEmail = ref('')
const forgotMessage = ref<string | null>(null)
const forgotSubmitting = ref(false)
const forceChangeOpen = ref(false)
const changingPassword = ref(false)
const forceNewPassword = ref('')
const forceConfirmPassword = ref('')
const forceError = ref<string | null>(null)
const requiresTotp = ref(false)
const totpCode = ref('')
const totpChallengeToken = ref('')
const totpSubmitting = ref(false)

onMounted(() => {
  const message = sessionStorage.getItem('trovara_flash')
  if (message) {
    flash.value = message
    sessionStorage.removeItem('trovara_flash')
  }
  forgotEmail.value = email.value
  void loadConsentStatus()
})

async function loadConsentStatus() {
  try {
    consentStatus.value = await api<ConsentStatus>('/api/consent/status')
    privacyAccepted.value = !!consentStatus.value.acceptedLatest
  } catch {
    // Requires auth - only succeeds when a session cookie is already present.
  }
}

// Records consent after a successful sign-in. Version and required types come
// from the API so the client cannot drift from the server contract. Failures
// here must never block login: the session is already established.
async function recordConsentIfNeeded() {
  if (!privacyAccepted.value) return
  try {
    const status = consentStatus.value?.currentVersion
      ? consentStatus.value
      : await api<ConsentStatus>('/api/consent/status')
    consentStatus.value = status
    if (status.acceptedLatest) return

    for (const consentType of status.requiredTypes) {
      await api('/api/consent', {
        method: 'POST',
        body: JSON.stringify({ consentType, version: status.currentVersion }),
      })
    }
  } catch {
    // Consent is best-effort at login; do not interrupt navigation.
  }
}

async function submitLogin() {
  forceError.value = null
  consentError.value = null
  if (!privacyAccepted.value) {
    consentError.value = t('login.consentRequired')
    return
  }
  try {
    const data = await auth.login(email.value, password.value, { skipRedirect: true })
    if ('requiresTotp' in data && data.requiresTotp) {
      requiresTotp.value = true
      totpChallengeToken.value = data.totpChallenge
      return
    }
    if (!('user' in data)) return
    await recordConsentIfNeeded()
    if ('mustChangePassword' in data && data.mustChangePassword) {
      await router.push('/change-password')
      return
    }
    await router.push(auth.user?.role === 'field_worker' ? '/today' : '/dashboard')
  } catch {
    // Store handles user-facing error state.
  }
}

async function submitTotp() {
  if (!totpChallengeToken.value || !/^\d{6}$/.test(totpCode.value.trim())) return
  totpSubmitting.value = true
  auth.error = null
  try {
    const data = await api<{
      user: {
        id: string
        email: string
        name: string
        role: 'owner' | 'supervisor' | 'field_worker'
        farmId: string
      }
      mustChangePassword?: boolean
    }>('/auth/totp/complete-login', {
      method: 'POST',
      body: JSON.stringify({
        totpChallenge: totpChallengeToken.value,
        token: totpCode.value.trim(),
      }),
    })

    auth.user = data.user

    await recordConsentIfNeeded()

    if ('mustChangePassword' in data && data.mustChangePassword) {
      await router.push('/change-password')
      return
    }

    await router.push(auth.user?.role === 'field_worker' ? '/today' : '/dashboard')
  } catch (e) {
    auth.error = e instanceof Error ? e.message : 'Invalid authentication code'
  } finally {
    totpSubmitting.value = false
  }
}

async function sendForgotPassword() {
  if (!forgotEmail.value.trim()) return
  forgotSubmitting.value = true
  forgotMessage.value = null
  try {
    const data = await api<{ message?: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: forgotEmail.value.trim() }),
    })
    forgotMessage.value =
      data.message ??
      'If this email exists, we sent password reset instructions.'
  } catch (e) {
    forgotMessage.value = e instanceof Error ? e.message : 'Could not send reset email.'
  } finally {
    forgotSubmitting.value = false
  }
}

async function applyForcedPasswordChange() {
  forceError.value = null
  if (forceNewPassword.value.length < 8) {
    forceError.value = 'New password must be at least 8 characters.'
    return
  }
  if (forceNewPassword.value !== forceConfirmPassword.value) {
    forceError.value = 'Passwords do not match.'
    return
  }
  changingPassword.value = true
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: password.value,
        newPassword: forceNewPassword.value,
      }),
    })
    forceChangeOpen.value = false
    forceNewPassword.value = ''
    forceConfirmPassword.value = ''
    await router.push(auth.user?.role === 'field_worker' ? '/today' : '/dashboard')
  } catch (e) {
    forceError.value = e instanceof Error ? e.message : 'Could not change password.'
  } finally {
    changingPassword.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-farm-green-dark/30 p-6">
    <div class="relative w-full max-w-md bg-slate-900/80 backdrop-blur border border-slate-800 rounded-2xl p-8 shadow-2xl">
      <div class="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>

      <div class="text-center mb-8">
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('brand.name') }}</p>
        <h1 class="text-3xl font-black text-white mt-2">{{ t('brand.farm') }}</h1>
        <p class="text-slate-400 text-sm mt-2">{{ t('brand.tagline') }}</p>
      </div>

      <p v-if="flash" class="mb-4 rounded-xl border border-farm-green/40 bg-farm-green/10 px-4 py-3 text-sm text-farm-green">
        {{ flash }}
      </p>

      <form v-if="!requiresTotp" class="space-y-4" @submit.prevent="submitLogin">
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('login.email') }}</label>
          <input
            v-model="email"
            type="email"
            required
            autocomplete="username"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('login.password') }}</label>
          <input
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
        </div>

        <label
          class="flex items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors"
          :class="consentError ? 'border-red-500/50 bg-red-950/20' : 'border-slate-800 bg-slate-950'"
        >
          <input
            v-model="privacyAccepted"
            type="checkbox"
            required
            class="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-farm-green focus:ring-farm-green/50"
            @change="consentError = null"
          />
          <span class="text-xs text-slate-400 leading-5">
            I agree to Trovara's data processing and privacy terms.
            <a
              href="https://trovara.farm/privacy"
              target="_blank"
              rel="noopener noreferrer"
              class="text-farm-green hover:underline"
            >
              View privacy policy
            </a>
          </span>
        </label>

        <p v-if="consentError" class="text-red-400 text-sm">{{ consentError }}</p>
        <p v-if="auth.error" class="text-red-400 text-sm">{{ auth.error }}</p>

        <button
          type="submit"
          :disabled="auth.loading || !privacyAccepted"
          class="w-full min-h-[3rem] py-3 rounded-xl bg-farm-green hover:bg-farm-green-dark text-white font-bold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {{ auth.loading ? t('login.signingIn') : t('login.signIn') }}
        </button>
      </form>

      <form v-else class="space-y-4" @submit.prevent="submitTotp">
        <p class="text-sm text-slate-300">
          Enter your 6-digit authenticator code to finish signing in.
        </p>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">Authentication code</label>
          <input
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            pattern="[0-9]{6}"
            maxlength="6"
            required
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm tracking-[0.35em] text-center focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
        </div>

        <p v-if="auth.error" class="text-red-400 text-sm">{{ auth.error }}</p>

        <button
          type="submit"
          :disabled="totpSubmitting"
          class="w-full min-h-[3rem] py-3 rounded-xl bg-farm-green hover:bg-farm-green-dark text-white font-bold text-sm transition-colors disabled:opacity-60"
        >
          {{ totpSubmitting ? 'Verifying…' : 'Verify code' }}
        </button>

        <button
          type="button"
          class="w-full text-xs text-slate-400 hover:text-farm-green underline"
          @click="requiresTotp = false"
        >
          Back to email/password
        </button>
      </form>

      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          class="text-xs text-slate-400 hover:text-farm-green underline"
          @click="forgotOpen = true"
        >
          Forgot password?
        </button>
        <RouterLink to="/register" class="text-xs text-slate-400 hover:text-farm-green underline">
          {{ t('login.registerAsFounder') }}
        </RouterLink>
      </div>
    </div>

    <div
      v-if="forgotOpen"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="forgotOpen = false"
    >
      <div class="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Forgot password</h3>
        <p class="text-xs text-slate-500 mt-1">Enter your account email to receive reset instructions.</p>
        <form class="mt-4 space-y-3" @submit.prevent="sendForgotPassword">
          <input
            v-model="forgotEmail"
            type="email"
            required
            placeholder="owner@trovara.farm"
            class="w-full px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-farm-green/50"
          />
          <button
            type="submit"
            :disabled="forgotSubmitting"
            class="w-full px-3 py-2.5 rounded-lg bg-farm-green/20 text-farm-green font-bold text-sm hover:bg-farm-green/30 disabled:opacity-50"
          >
            {{ forgotSubmitting ? 'Sending…' : 'Send reset email' }}
          </button>
        </form>
        <p v-if="forgotMessage" class="text-xs text-slate-300 mt-3">{{ forgotMessage }}</p>
      </div>
    </div>

    <div
      v-if="forceChangeOpen"
      class="fixed inset-0 z-50 bg-black/75 p-4 flex items-center justify-center"
    >
      <div class="w-full max-w-md rounded-2xl border border-amber-700/40 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Change your password</h3>
        <p class="text-xs text-amber-200/80 mt-1">Your account requires a password update before continuing.</p>
        <form class="mt-4 space-y-3" @submit.prevent="applyForcedPasswordChange">
          <input
            v-model="forceNewPassword"
            type="password"
            minlength="8"
            required
            placeholder="New password"
            class="w-full px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-farm-green/50"
          />
          <input
            v-model="forceConfirmPassword"
            type="password"
            minlength="8"
            required
            placeholder="Confirm new password"
            class="w-full px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:border-farm-green/50"
          />
          <p v-if="forceError" class="text-xs text-red-400">{{ forceError }}</p>
          <button
            type="submit"
            :disabled="changingPassword"
            class="w-full px-3 py-2.5 rounded-lg bg-farm-green/20 text-farm-green font-bold text-sm hover:bg-farm-green/30 disabled:opacity-50"
          >
            {{ changingPassword ? 'Updating…' : 'Update password and continue' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
