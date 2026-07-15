<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import LanguageSwitcher from '@/components/LanguageSwitcher.vue'
import { api } from '@/lib/api'
import router from '@/router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const { t } = useI18n()

const name = ref('')
const email = ref('')
const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const registrationSecret = ref('')
const privacyAccepted = ref(false)
const consentError = ref<string | null>(null)
const formError = ref<string | null>(null)
const submitting = ref(false)

async function submitRegister() {
  formError.value = null
  consentError.value = null

  if (!privacyAccepted.value) {
    consentError.value = t('register.consentRequired')
    return
  }
  if (password.value !== confirmPassword.value) {
    formError.value = t('register.passwordMismatch')
    return
  }
  if (password.value.length < 8) {
    formError.value = t('register.passwordTooShort')
    return
  }
  const emailDomain = email.value.trim().toLowerCase().split('@').pop()
  if (emailDomain !== 'trovara.farm') {
    formError.value = t('register.emailDomain')
    return
  }

  submitting.value = true
  try {
    const data = await api<{
      user: {
        id: string
        email: string
        name: string
        role: 'owner' | 'supervisor' | 'field_worker'
        farmId: string
        totpEnabled?: boolean
        butlerTtsMode?: 'off' | 'voice_replies' | 'always'
      }
      mustChangePassword?: boolean
    }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: name.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
        password: password.value,
        registrationSecret: registrationSecret.value,
        consentAccepted: true,
      }),
    })

    auth.user = data.user
    auth.error = null
    await router.push('/dashboard')
  } catch (e) {
    formError.value = e instanceof Error ? e.message : t('register.failed')
  } finally {
    submitting.value = false
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
        <h1 class="text-3xl font-black text-white mt-2">{{ t('register.title') }}</h1>
        <p class="text-slate-400 text-sm mt-2">{{ t('register.subtitle') }}</p>
      </div>

      <form class="space-y-4" @submit.prevent="submitRegister">
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('register.name') }}</label>
          <input
            v-model="name"
            type="text"
            required
            autocomplete="name"
            maxlength="200"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('register.email') }}</label>
          <input
            v-model="email"
            type="email"
            required
            autocomplete="email"
            placeholder="you@trovara.farm"
            pattern="[^@\s]+@trovara\.farm"
            title="@trovara.farm only"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
          <p class="text-[11px] text-slate-500 mt-1">{{ t('register.emailHint') }}</p>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('register.phone') }}</label>
          <input
            v-model="phone"
            type="tel"
            required
            autocomplete="tel"
            placeholder="+234…"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
          <p class="text-[10px] text-slate-500 mt-1">{{ t('register.phoneHint') }}</p>
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('register.password') }}</label>
          <input
            v-model="password"
            type="password"
            required
            minlength="8"
            autocomplete="new-password"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('register.confirmPassword') }}</label>
          <input
            v-model="confirmPassword"
            type="password"
            required
            minlength="8"
            autocomplete="new-password"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">{{ t('register.secret') }}</label>
          <input
            v-model="registrationSecret"
            type="password"
            required
            autocomplete="off"
            class="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-farm-green/40 focus:border-farm-green"
          />
          <p class="text-[10px] text-slate-500 mt-1">{{ t('register.secretHint') }}</p>
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
            {{ t('register.consent') }}
            <a
              href="https://trovara.farm/privacy"
              target="_blank"
              rel="noopener noreferrer"
              class="text-farm-green hover:underline"
            >
              {{ t('register.viewPrivacy') }}
            </a>
          </span>
        </label>

        <p v-if="consentError" class="text-red-400 text-sm">{{ consentError }}</p>
        <p v-if="formError" class="text-red-400 text-sm">{{ formError }}</p>

        <button
          type="submit"
          :disabled="submitting || !privacyAccepted"
          class="w-full min-h-[3rem] py-3 rounded-xl bg-farm-green hover:bg-farm-green-dark text-white font-bold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {{ submitting ? t('register.submitting') : t('register.submit') }}
        </button>
      </form>

      <p class="mt-4 text-center text-xs text-slate-400">
        {{ t('register.haveAccount') }}
        <RouterLink to="/login" class="text-farm-green hover:underline">
          {{ t('register.signIn') }}
        </RouterLink>
      </p>
    </div>
  </div>
</template>
