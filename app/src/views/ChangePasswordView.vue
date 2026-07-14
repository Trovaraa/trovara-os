<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const error = ref<string | null>(null)
const saving = ref(false)

async function submit() {
  error.value = null
  if (newPassword.value.length < 8) {
    error.value = 'New password must be at least 8 characters.'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match.'
    return
  }
  saving.value = true
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      }),
    })
    if (auth.user) {
      auth.user = { ...auth.user, mustChangePassword: false }
    }
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    await router.push(auth.user?.role === 'field_worker' ? '/today' : '/dashboard')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not change password.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="max-w-md">
      <h2 class="text-2xl font-black text-white">Change password</h2>
      <p class="text-slate-400 text-sm mt-1">
        You must set a new password before continuing.
      </p>

      <form class="mt-8 space-y-4" @submit.prevent="submit">
        <input
          v-model="currentPassword"
          type="password"
          required
          autocomplete="current-password"
          placeholder="Current password"
          class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="newPassword"
          type="password"
          required
          autocomplete="new-password"
          placeholder="New password"
          class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="confirmPassword"
          type="password"
          required
          autocomplete="new-password"
          placeholder="Confirm new password"
          class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <p v-if="error" class="text-xs text-red-400">{{ error }}</p>
        <button
          type="submit"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          :disabled="saving"
        >
          {{ saving ? 'Saving…' : 'Update password' }}
        </button>
      </form>
    </div>
  </AppLayout>
</template>
