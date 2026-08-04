<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/lib/api'

type VaultEntry = {
  id: string
  label: string
  category: string
  loginUrl: string
  loginEmail: string
  notes: string | null
  hasPassword: boolean
}

const loading = ref(true)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const entries = ref<VaultEntry[]>([])
const form = ref({
  label: '',
  category: 'provider_portal',
  loginUrl: '',
  loginEmail: '',
  password: '',
  notes: '',
})
const revealId = ref<string | null>(null)
const totpToken = ref('')
const breakGlassPassword = ref('')
const revealed = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ entries: VaultEntry[] }>('/api/vault')
    entries.value = data.entries
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load vault'
  } finally {
    loading.value = false
  }
}

async function createEntry() {
  message.value = null
  try {
    await api('/api/vault', {
      method: 'POST',
      body: JSON.stringify({
        label: form.value.label,
        category: form.value.category,
        loginUrl: form.value.loginUrl,
        loginEmail: form.value.loginEmail,
        password: form.value.password,
        notes: form.value.notes || null,
      }),
    })
    form.value = {
      label: '',
      category: 'provider_portal',
      loginUrl: '',
      loginEmail: '',
      password: '',
      notes: '',
    }
    message.value = 'Entry saved'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  }
}

async function reveal(id: string) {
  revealed.value = null
  message.value = null
  try {
    const data = await api<{ password: string }>(`/api/vault/${id}/reveal`, {
      method: 'POST',
      body: JSON.stringify({
        totpToken: totpToken.value || undefined,
        breakGlassPassword: breakGlassPassword.value || undefined,
      }),
    })
    revealed.value = data.password
    revealId.value = id
    message.value = 'Password revealed once — copy it now. It is not stored in the browser.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Reveal failed'
  }
}

async function remove(id: string) {
  if (!window.confirm('Delete this vault entry?')) return
  await api(`/api/vault/${id}`, { method: 'DELETE' })
  await load()
}

onMounted(load)
</script>

<template>
  <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
    <h3 class="font-bold text-white text-sm">Portal credential vault</h3>
    <p class="text-xs text-slate-500 mt-1">
      Human login email/password/URL for provider dashboards. Runtime API keys stay in server
      environment. Reveal requires TOTP (or armed break-glass password).
    </p>

    <p v-if="loading" class="text-xs text-slate-400 mt-4">Loading…</p>
    <p v-else-if="error" class="text-xs text-red-400 mt-4">{{ error }}</p>
    <p v-if="message" class="text-xs text-slate-400 mt-2">{{ message }}</p>

    <ul v-if="entries.length" class="mt-4 space-y-2">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="border border-slate-800 rounded-lg px-3 py-2 text-xs"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-slate-200 font-semibold">{{ entry.label }}</p>
            <p class="text-slate-500 mt-0.5 truncate">{{ entry.loginEmail }}</p>
            <a
              :href="entry.loginUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="text-farm-green hover:underline break-all"
            >
              {{ entry.loginUrl }}
            </a>
            <p v-if="revealId === entry.id && revealed" class="mt-2 font-mono text-farm-gold break-all">
              {{ revealed }}
            </p>
          </div>
          <div class="flex flex-col gap-1 shrink-0">
            <button
              type="button"
              class="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="reveal(entry.id)"
            >
              Reveal
            </button>
            <button
              type="button"
              class="px-2 py-1 rounded bg-red-900/40 text-red-300 hover:bg-red-900/60"
              @click="remove(entry.id)"
            >
              Delete
            </button>
          </div>
        </div>
      </li>
    </ul>

    <div class="mt-4 grid gap-2 sm:grid-cols-2">
      <input
        v-model="totpToken"
        type="text"
        inputmode="numeric"
        maxlength="6"
        placeholder="TOTP for reveal"
        class="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="breakGlassPassword"
        type="password"
        placeholder="Break-glass password (if armed)"
        class="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
    </div>

    <div class="mt-6 border-t border-slate-800 pt-4 space-y-2">
      <p class="text-xs font-semibold text-slate-400">Add entry</p>
      <input
        v-model="form.label"
        placeholder="Label (e.g. Paystack dashboard)"
        class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="form.loginUrl"
        placeholder="https://…"
        class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="form.loginEmail"
        placeholder="Login email"
        class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="form.password"
        type="password"
        placeholder="Password"
        class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
      <button
        type="button"
        class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
        @click="createEntry"
      >
        Save to vault
      </button>
    </div>
  </div>
</template>
