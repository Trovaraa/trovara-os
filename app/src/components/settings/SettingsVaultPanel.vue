<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type VaultEntry = {
  id: string
  label: string
  category: string
  loginUrl: string
  loginEmail: string
  notes: string | null
  hasPassword: boolean
  canManage: boolean
  canReveal: boolean
  sharedWithMe: boolean
  sharedUserIds: string[]
}

type ShareCandidate = {
  id: string
  name: string
  role: string
  jobTitle: string | null
}

const auth = useAuthStore()
const loading = ref(true)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const entries = ref<VaultEntry[]>([])
const canManage = ref(false)
const candidates = ref<ShareCandidate[]>([])
const shareDraft = ref<Record<string, string[]>>({})
const savingShareId = ref<string | null>(null)
const form = ref({
  label: '',
  category: 'provider_portal',
  loginUrl: '',
  loginEmail: '',
  password: '',
  notes: '',
})
const revealId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const savingEditId = ref<string | null>(null)
const totpToken = ref('')
const breakGlassPassword = ref('')
const revealed = ref<string | null>(null)
const editForm = ref({
  label: '',
  loginUrl: '',
  loginEmail: '',
  password: '',
  notes: '',
})

const visible = computed(
  () => loading.value || canManage.value || entries.value.length > 0 || auth.isOwner,
)

function candidateLabel(user: ShareCandidate): string {
  const extra = user.jobTitle?.trim() || user.role
  return extra ? `${user.name} (${extra})` : user.name
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ canManage?: boolean; entries: VaultEntry[] }>('/api/vault')
    canManage.value = Boolean(data.canManage)
    entries.value = data.entries
    shareDraft.value = Object.fromEntries(
      data.entries.map((entry) => [entry.id, [...entry.sharedUserIds]]),
    )
    if (canManage.value && !candidates.value.length) {
      const staff = await api<{ users: ShareCandidate[] }>('/api/vault/share-candidates')
      candidates.value = staff.users
    }
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

function startEdit(entry: VaultEntry) {
  editingId.value = entry.id
  revealed.value = null
  revealId.value = null
  editForm.value = {
    label: entry.label,
    loginUrl: entry.loginUrl,
    loginEmail: entry.loginEmail,
    password: '',
    notes: entry.notes ?? '',
  }
}

function cancelEdit() {
  editingId.value = null
}

async function saveEdit(entry: VaultEntry) {
  savingEditId.value = entry.id
  message.value = null
  error.value = null
  try {
    await api(`/api/vault/${entry.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        label: editForm.value.label,
        loginUrl: editForm.value.loginUrl,
        loginEmail: editForm.value.loginEmail,
        notes: editForm.value.notes || null,
        ...(editForm.value.password ? { password: editForm.value.password } : {}),
        totpToken: totpToken.value || undefined,
        breakGlassPassword: breakGlassPassword.value || undefined,
      }),
    })
    editingId.value = null
    message.value = 'Entry updated'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Update failed'
  } finally {
    savingEditId.value = null
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

function toggleShare(entryId: string, userId: string) {
  const current = new Set(shareDraft.value[entryId] ?? [])
  if (current.has(userId)) current.delete(userId)
  else current.add(userId)
  shareDraft.value = { ...shareDraft.value, [entryId]: [...current] }
}

async function saveShares(entry: VaultEntry) {
  savingShareId.value = entry.id
  message.value = null
  error.value = null
  try {
    const data = await api<{ sharedUserIds: string[] }>(`/api/vault/${entry.id}/shares`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: shareDraft.value[entry.id] ?? [] }),
    })
    shareDraft.value = { ...shareDraft.value, [entry.id]: data.sharedUserIds }
    entry.sharedUserIds = data.sharedUserIds
    message.value = 'Sharing updated'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not update sharing'
  } finally {
    savingShareId.value = null
  }
}

onMounted(load)
</script>

<template>
  <CollapsibleSection
    v-if="visible"
    class="mt-6"
    title="Portal credential vault"
    description="Manage human portal logins and share individual entries with named staff. Reveal and admin edits require TOTP or an armed break-glass password."
    :default-open="false"
    test-id="settings-vault-section"
  >
    <template #meta>
      <span v-if="entries.length" class="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
        {{ entries.length }}
      </span>
    </template>
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
            <p v-if="entry.sharedWithMe && !entry.canManage" class="text-farm-gold mt-0.5">
              Shared with you
            </p>
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
              v-if="entry.canReveal"
              type="button"
              class="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="reveal(entry.id)"
            >
              Reveal
            </button>
            <button
              v-if="entry.canManage"
              type="button"
              class="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="startEdit(entry)"
            >
              Edit
            </button>
            <button
              v-if="entry.canManage"
              type="button"
              class="px-2 py-1 rounded bg-red-900/40 text-red-300 hover:bg-red-900/60"
              @click="remove(entry.id)"
            >
              Delete
            </button>
          </div>
        </div>
        <div v-if="entry.canManage && editingId === entry.id" class="mt-3 border-t border-slate-800 pt-2 space-y-2">
          <p class="text-slate-400 font-semibold">Edit entry</p>
          <input
            v-model="editForm.label"
            aria-label="Edit vault entry label"
            placeholder="Label"
            class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
          />
          <input
            v-model="editForm.loginUrl"
            aria-label="Edit login URL"
            placeholder="https://…"
            class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
          />
          <input
            v-model="editForm.loginEmail"
            aria-label="Edit login email or username"
            placeholder="Email or username"
            class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
          />
          <input
            v-model="editForm.password"
            aria-label="New password"
            type="password"
            placeholder="New password (leave blank to keep current)"
            class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
          />
          <textarea
            v-model="editForm.notes"
            aria-label="Edit notes"
            placeholder="Notes (optional)"
            rows="2"
            class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
          />
          <div class="flex gap-2">
            <button
              type="button"
              class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              :disabled="savingEditId === entry.id"
              @click="saveEdit(entry)"
            >
              {{ savingEditId === entry.id ? 'Saving…' : 'Save changes' }}
            </button>
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="cancelEdit"
            >
              Cancel
            </button>
          </div>
        </div>
        <details
          v-if="entry.canManage && candidates.length"
          class="group mt-3 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/45"
        >
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-semibold text-slate-300 marker:content-none">
            <span>Sharing</span>
            <span class="flex items-center gap-2 text-[11px] font-medium text-slate-500">
              {{ (shareDraft[entry.id] ?? []).length }} selected
              <svg class="h-4 w-4 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
            </span>
          </summary>
          <div class="border-t border-slate-800 px-3 py-3">
            <div class="grid gap-2 sm:grid-cols-2">
              <label
                v-for="person in candidates"
                :key="`${entry.id}-${person.id}`"
                class="flex items-center gap-2 text-slate-300"
              >
                <input
                  type="checkbox"
                  :checked="(shareDraft[entry.id] ?? []).includes(person.id)"
                  @change="toggleShare(entry.id, person.id)"
                />
                <span>{{ candidateLabel(person) }}</span>
              </label>
            </div>
            <button
              type="button"
              class="mt-3 text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              :disabled="savingShareId === entry.id"
              @click="saveShares(entry)"
            >
              {{ savingShareId === entry.id ? 'Saving…' : 'Save sharing' }}
            </button>
          </div>
        </details>
      </li>
    </ul>

    <div
      v-if="canManage || entries.some((entry) => entry.canReveal)"
      class="mt-4 grid gap-2 sm:grid-cols-2"
    >
      <input
        v-model="totpToken"
        aria-label="TOTP for reveal or edit"
        type="text"
        inputmode="numeric"
        maxlength="6"
        placeholder="TOTP for reveal or edit"
        class="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="breakGlassPassword"
        aria-label="Break-glass password"
        type="password"
        placeholder="Break-glass password (if armed)"
        class="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
      />
    </div>

    <details v-if="canManage" class="group mt-6 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/45">
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-xs font-semibold text-slate-300 marker:content-none">
        <span>Add entry</span>
        <svg class="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div class="space-y-2 border-t border-slate-800 p-3">
        <input
          v-model="form.label"
          aria-label="Vault entry label"
          placeholder="Label (e.g. Instagram, Paystack dashboard)"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
        />
        <input
          v-model="form.loginUrl"
          aria-label="Login URL"
          placeholder="https://…"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
        />
        <input
          v-model="form.loginEmail"
          aria-label="Login email or username"
          placeholder="Email or username"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
        />
        <textarea
          v-model="form.notes"
          aria-label="Vault notes"
          placeholder="Notes (optional)"
          rows="2"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
        />
        <input
          v-model="form.password"
          aria-label="Password"
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
    </details>
  </CollapsibleSection>
</template>
