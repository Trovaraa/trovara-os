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

type UnlockMode = 'reveal' | 'edit'

const auth = useAuthStore()
const loading = ref(true)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const entries = ref<VaultEntry[]>([])
const canManage = ref(false)
const candidates = ref<ShareCandidate[]>([])
const shareDraft = ref<Record<string, string[]>>({})
const savingShareId = ref<string | null>(null)
const showAddForm = ref(false)
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
const unlockingId = ref<string | null>(null)
const unlockMode = ref<UnlockMode | null>(null)
const unlocking = ref(false)
const showBreakGlass = ref(false)
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

function clearUnlockCodes() {
  totpToken.value = ''
  breakGlassPassword.value = ''
  showBreakGlass.value = false
}

function closeUnlock() {
  unlockingId.value = null
  unlockMode.value = null
  unlocking.value = false
  clearUnlockCodes()
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
    showAddForm.value = false
    message.value = 'Entry saved'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  }
}

function beginUnlock(entry: VaultEntry, mode: UnlockMode) {
  unlockingId.value = entry.id
  unlockMode.value = mode
  editingId.value = null
  revealId.value = null
  revealed.value = null
  clearUnlockCodes()
  error.value = null
  message.value = null
  if (mode === 'edit') {
    editForm.value = {
      label: entry.label,
      loginUrl: entry.loginUrl,
      loginEmail: entry.loginEmail,
      password: '',
      notes: entry.notes ?? '',
    }
  }
}

function cancelUnlock() {
  closeUnlock()
}

function cancelEdit() {
  editingId.value = null
  closeUnlock()
}

async function confirmUnlock() {
  if (!unlockingId.value || !unlockMode.value) return
  if (unlockMode.value === 'reveal') {
    await reveal(unlockingId.value)
    return
  }
  editingId.value = unlockingId.value
  unlockingId.value = null
  unlockMode.value = null
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
    clearUnlockCodes()
    message.value = 'Entry updated'
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Update failed'
  } finally {
    savingEditId.value = null
  }
}

async function reveal(id: string) {
  unlocking.value = true
  revealed.value = null
  message.value = null
  error.value = null
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
    unlockingId.value = null
    unlockMode.value = null
    clearUnlockCodes()
    message.value = 'Password revealed once — copy it now. It is not stored in the browser.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Reveal failed'
  } finally {
    unlocking.value = false
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
      <span class="flex items-center gap-2">
        <span v-if="entries.length" class="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
          {{ entries.length }}
        </span>
        <button
          v-if="canManage"
          type="button"
          class="hidden min-h-8 rounded-lg bg-farm-green/20 px-2.5 py-1 text-[11px] font-bold text-farm-green hover:bg-farm-green/30 sm:inline-flex"
          data-testid="vault-add-key-header"
          @click.stop="showAddForm = !showAddForm"
        >
          {{ showAddForm ? 'Close' : '+ Add vault key' }}
        </button>
      </span>
    </template>

    <p v-if="loading" class="mt-4 text-xs text-slate-400">Loading…</p>
    <p v-else-if="error" class="mt-4 text-xs text-red-400" role="alert">{{ error }}</p>
    <p v-if="message" class="mt-2 text-xs text-slate-400">{{ message }}</p>

    <button
      v-if="canManage"
      type="button"
      class="mt-4 flex min-h-11 w-full items-center justify-center rounded-lg border border-farm-green/40 bg-farm-green/15 px-3 text-xs font-bold text-farm-green hover:bg-farm-green/25 sm:hidden"
      data-testid="vault-add-key-mobile"
      @click="showAddForm = !showAddForm"
    >
      {{ showAddForm ? 'Close add form' : '+ Add vault key' }}
    </button>

    <div v-if="canManage && showAddForm" class="mt-4 space-y-2 rounded-lg border border-slate-800 bg-slate-950/45 p-3" data-testid="vault-add-form">
      <p class="text-xs font-semibold text-slate-300">New vault key</p>
      <input
        v-model="form.label"
        aria-label="Vault entry label"
        placeholder="Label (e.g. Instagram, Paystack dashboard)"
        class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="form.loginUrl"
        aria-label="Login URL"
        placeholder="https://…"
        class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="form.loginEmail"
        aria-label="Login email or username"
        placeholder="Email or username"
        class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
      />
      <textarea
        v-model="form.notes"
        aria-label="Vault notes"
        placeholder="Notes (optional)"
        rows="2"
        class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
      />
      <input
        v-model="form.password"
        aria-label="Password"
        type="password"
        placeholder="Password"
        class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
      />
      <button
        type="button"
        class="rounded-lg bg-farm-green/20 px-3 py-1.5 text-xs font-bold text-farm-green hover:bg-farm-green/30"
        @click="createEntry"
      >
        Save to vault
      </button>
    </div>

    <ul v-if="entries.length" class="mt-4 space-y-2">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="rounded-lg border border-slate-800 px-3 py-2 text-xs"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold text-slate-200">{{ entry.label }}</p>
            <p v-if="entry.sharedWithMe && !entry.canManage" class="mt-0.5 text-farm-gold">
              Shared with you
            </p>
            <p class="mt-0.5 truncate text-slate-500">{{ entry.loginEmail }}</p>
            <a
              :href="entry.loginUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="break-all text-farm-green hover:underline"
            >
              {{ entry.loginUrl }}
            </a>
            <p v-if="revealId === entry.id && revealed" class="mt-2 break-all font-mono text-farm-gold">
              {{ revealed }}
            </p>
          </div>
          <div class="flex shrink-0 flex-col gap-1">
            <button
              v-if="entry.canReveal"
              type="button"
              class="rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
              @click="beginUnlock(entry, 'reveal')"
            >
              Reveal
            </button>
            <button
              v-if="entry.canManage"
              type="button"
              class="rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
              @click="beginUnlock(entry, 'edit')"
            >
              Edit
            </button>
            <button
              v-if="entry.canManage"
              type="button"
              class="rounded bg-red-900/40 px-2 py-1 text-red-300 hover:bg-red-900/60"
              @click="remove(entry.id)"
            >
              Delete
            </button>
          </div>
        </div>

        <div
          v-if="unlockingId === entry.id && unlockMode"
          class="mt-3 space-y-2 border-t border-slate-800 pt-3"
          data-testid="vault-unlock-strip"
        >
          <p class="font-semibold text-slate-300">Unlock {{ entry.label }}</p>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              v-model="totpToken"
              aria-label="TOTP for reveal or edit"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="TOTP code"
              class="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white sm:flex-1"
            />
            <div class="flex gap-2 sm:shrink-0">
              <button
                type="button"
                class="min-h-10 rounded-lg bg-farm-green/20 px-3 py-1.5 text-xs font-bold text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
                :disabled="unlocking"
                @click="confirmUnlock"
              >
                {{ unlocking ? 'Checking…' : 'Confirm' }}
              </button>
              <button
                type="button"
                class="min-h-10 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
                @click="cancelUnlock"
              >
                Cancel
              </button>
            </div>
          </div>
          <button
            type="button"
            class="text-[11px] font-semibold text-slate-500 underline underline-offset-2 hover:text-slate-300"
            @click="showBreakGlass = !showBreakGlass"
          >
            {{ showBreakGlass ? 'Hide break-glass' : 'Use break-glass instead' }}
          </button>
          <input
            v-if="showBreakGlass"
            v-model="breakGlassPassword"
            aria-label="Break-glass password"
            type="password"
            placeholder="Break-glass password (if armed)"
            class="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
          />
        </div>

        <div v-if="entry.canManage && editingId === entry.id" class="mt-3 space-y-2 border-t border-slate-800 pt-2">
          <p class="font-semibold text-slate-400">Edit entry</p>
          <input
            v-model="editForm.label"
            aria-label="Edit vault entry label"
            placeholder="Label"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
          />
          <input
            v-model="editForm.loginUrl"
            aria-label="Edit login URL"
            placeholder="https://…"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
          />
          <input
            v-model="editForm.loginEmail"
            aria-label="Edit login email or username"
            placeholder="Email or username"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
          />
          <input
            v-model="editForm.password"
            aria-label="New password"
            type="password"
            placeholder="New password (leave blank to keep current)"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
          />
          <textarea
            v-model="editForm.notes"
            aria-label="Edit notes"
            placeholder="Notes (optional)"
            rows="2"
            class="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
          />
          <div class="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-2">
            <p class="text-[11px] text-slate-500">Confirm with TOTP to save changes</p>
            <input
              v-model="totpToken"
              aria-label="TOTP to save vault edits"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="TOTP code"
              class="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
            />
            <button
              type="button"
              class="text-[11px] font-semibold text-slate-500 underline underline-offset-2 hover:text-slate-300"
              @click="showBreakGlass = !showBreakGlass"
            >
              {{ showBreakGlass ? 'Hide break-glass' : 'Use break-glass instead' }}
            </button>
            <input
              v-if="showBreakGlass"
              v-model="breakGlassPassword"
              aria-label="Break-glass password for save"
              type="password"
              placeholder="Break-glass password (if armed)"
              class="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"
            />
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-lg bg-farm-green/20 px-3 py-1.5 text-xs font-bold text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              :disabled="savingEditId === entry.id"
              @click="saveEdit(entry)"
            >
              {{ savingEditId === entry.id ? 'Saving…' : 'Save changes' }}
            </button>
            <button
              type="button"
              class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
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
              class="mt-3 rounded-lg bg-farm-green/20 px-3 py-1.5 text-xs font-bold text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              :disabled="savingShareId === entry.id"
              @click="saveShares(entry)"
            >
              {{ savingShareId === entry.id ? 'Saving…' : 'Save sharing' }}
            </button>
          </div>
        </details>
      </li>
    </ul>
  </CollapsibleSection>
</template>
