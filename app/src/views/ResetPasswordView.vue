<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { api } from '@/lib/api'

const route = useRoute()
const router = useRouter()
const token = ref('')
const password = ref('')
const confirmation = ref('')
const error = ref<string | null>(null)
const complete = ref(false)
const submitting = ref(false)

onMounted(async () => {
  const value = route.query.token
  token.value = typeof value === 'string' ? value : ''
  if (!token.value) return

  const query = { ...route.query }
  delete query.token
  await router.replace({ path: route.path, query })
})

async function submit() {
  error.value = null
  if (!token.value) {
    error.value = 'This reset link is invalid.'
    return
  }
  if (password.value.length < 8) {
    error.value = 'Password must be at least 8 characters.'
    return
  }
  if (password.value !== confirmation.value) {
    error.value = 'Passwords do not match.'
    return
  }

  submitting.value = true
  try {
    await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: token.value, newPassword: password.value }),
    })
    password.value = ''
    confirmation.value = ''
    complete.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not reset password.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-farm-green-dark/30 p-6">
    <main class="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl">
      <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">Trovara OS</p>
      <h1 class="mt-2 text-2xl font-black text-white">Reset your password</h1>

      <div v-if="complete" class="mt-6 space-y-4">
        <p class="text-sm text-farm-green">Your password was reset successfully.</p>
        <RouterLink to="/login" class="inline-block text-sm font-bold text-farm-green hover:underline">
          Continue to sign in
        </RouterLink>
      </div>

      <form v-else class="mt-6 space-y-4" @submit.prevent="submit">
        <p v-if="!token" class="text-sm text-red-400">
          This reset link is missing its token. Request a new link from the sign-in page.
        </p>
        <input
          v-model="password"
          type="password"
          minlength="8"
          required
          autocomplete="new-password"
          placeholder="New password"
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white focus:border-farm-green focus:outline-none"
        />
        <input
          v-model="confirmation"
          type="password"
          minlength="8"
          required
          autocomplete="new-password"
          placeholder="Confirm new password"
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white focus:border-farm-green focus:outline-none"
        />
        <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
        <button
          type="submit"
          :disabled="submitting || !token"
          class="w-full rounded-xl bg-farm-green px-4 py-3 text-sm font-bold text-white hover:bg-farm-green-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ submitting ? 'Resetting…' : 'Reset password' }}
        </button>
        <RouterLink to="/login" class="block text-center text-xs text-slate-400 hover:text-farm-green hover:underline">
          Back to sign in
        </RouterLink>
      </form>
    </main>
  </div>
</template>
