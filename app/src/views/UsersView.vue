<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { roleLabel } from '@/lib/roles'
import type { UserRole } from '@/stores/auth'

const { t } = useI18n()

type FarmUser = {
  id: string
  email: string
  name: string
  role: UserRole
  active: boolean
  createdAt: string
  phone?: string | null
  dailyWageNgn?: number | null
}

const users = ref<FarmUser[]>([])
const loading = ref(true)

const newEmail = ref('')
const newName = ref('')
const newRole = ref<UserRole>('field_worker')
const newPassword = ref('')
const newPhone = ref('')
const newDailyWageNgn = ref<number | ''>('')
const creating = ref(false)
const createError = ref<string | null>(null)

const toggling = ref<string | null>(null)
const editing = ref<FarmUser | null>(null)
const editName = ref('')
const editRole = ref<UserRole>('field_worker')
const editPhone = ref('')
const editDailyWageNgn = ref<number | ''>('')
const editSaving = ref(false)
const editError = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const data = await api<{ users: FarmUser[] }>('/api/users')
    users.value = data.users
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function createUser() {
  if (!newEmail.value.trim() || !newName.value.trim() || !newPassword.value) return
  creating.value = true
  createError.value = null
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        email: newEmail.value.trim(),
        name: newName.value.trim(),
        role: newRole.value,
        password: newPassword.value,
        phone: newPhone.value.trim() || undefined,
        dailyWageNgn:
          newDailyWageNgn.value === '' ? undefined : Number(newDailyWageNgn.value),
      }),
    })
    newEmail.value = ''
    newName.value = ''
    newPassword.value = ''
    newPhone.value = ''
    newDailyWageNgn.value = ''
    newRole.value = 'field_worker'
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('users.createFailed')
  } finally {
    creating.value = false
  }
}

async function toggleActive(user: FarmUser) {
  if (user.role === 'owner') return
  toggling.value = user.id
  try {
    await api(`/api/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !user.active }),
    })
    await load()
  } finally {
    toggling.value = null
  }
}

function openEdit(user: FarmUser) {
  editing.value = user
  editName.value = user.name
  editRole.value = user.role
  editPhone.value = user.phone ?? ''
  editDailyWageNgn.value = user.dailyWageNgn ?? ''
  editError.value = null
}

function closeEdit() {
  if (editSaving.value) return
  editing.value = null
}

async function saveEdit() {
  if (!editing.value) return
  editSaving.value = true
  editError.value = null
  try {
    await api(`/api/users/${editing.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editName.value.trim(),
        role: editRole.value,
        phone: editPhone.value.trim() || null,
        dailyWageNgn:
          editDailyWageNgn.value === '' ? null : Number(editDailyWageNgn.value),
      }),
    })
    editing.value = null
    await load()
  } catch (e) {
    editError.value = e instanceof Error ? e.message : t('users.updateFailed')
  } finally {
    editSaving.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">{{ t('users.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('users.subtitle') }}</p>
    </div>

    <form
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createUser"
    >
      <h3 class="font-bold text-white text-sm">{{ t('users.addUser') }}</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.email') }}</label>
          <input
            v-model="newEmail"
            type="email"
            required
            placeholder="worker@trovara.farm"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.name') }}</label>
          <input
            v-model="newName"
            type="text"
            required
            maxlength="200"
            :placeholder="t('users.fullName')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.role') }}</label>
          <select
            v-model="newRole"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option value="supervisor">{{ t('users.supervisor') }}</option>
            <option value="field_worker">{{ t('users.fieldWorker') }}</option>
            <option value="owner">{{ t('users.founder') }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.password') }}</label>
          <input
            v-model="newPassword"
            type="password"
            required
            minlength="8"
            :placeholder="t('users.min8')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.phone') }}</label>
          <input
            v-model="newPhone"
            type="tel"
            placeholder="+234..."
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.dailyWage') }}</label>
          <input
            v-model.number="newDailyWageNgn"
            type="number"
            min="0"
            step="1"
            :placeholder="t('users.wagePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creating ? t('users.creating') : t('users.createUser') }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('users.loading') }}</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">{{ t('users.name') }}</th>
            <th class="pb-3 font-semibold">{{ t('users.email') }}</th>
            <th class="pb-3 font-semibold">{{ t('users.role') }}</th>
            <th class="pb-3 font-semibold">{{ t('users.phone') }}</th>
            <th class="pb-3 font-semibold">{{ t('users.dailyWageShort') }}</th>
            <th class="pb-3 font-semibold">{{ t('users.status') }}</th>
            <th class="pb-3 font-semibold">{{ t('users.joined') }}</th>
            <th class="pb-3 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="user in users"
            :key="user.id"
            class="border-b border-slate-800/50"
          >
            <td class="py-4 font-medium text-white">{{ user.name }}</td>
            <td class="py-4 text-slate-400">{{ user.email }}</td>
            <td class="py-4 text-slate-300">{{ roleLabel(user.role) }}</td>
            <td class="py-4 text-slate-400">{{ user.phone ?? '-' }}</td>
            <td class="py-4 text-slate-400 font-mono">
              {{ user.dailyWageNgn != null ? `₦${user.dailyWageNgn}` : '-' }}
            </td>
            <td class="py-4">
              <span
                class="text-xs font-bold px-2 py-1 rounded-full"
                :class="user.active ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
              >
                {{ user.active ? t('users.active') : t('users.inactive') }}
              </span>
            </td>
            <td class="py-4 text-slate-400">
              {{ new Date(user.createdAt).toLocaleDateString() }}
            </td>
            <td class="py-4 text-right">
              <button
                type="button"
                class="mr-2 text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                @click="openEdit(user)"
              >
                {{ t('users.edit') }}
              </button>
              <button
                v-if="user.role !== 'owner'"
                type="button"
                class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                :disabled="toggling === user.id"
                @click="toggleActive(user)"
              >
                {{ toggling === user.id ? '…' : user.active ? t('users.deactivate') : t('users.activate') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!users.length" class="text-slate-500 text-sm mt-4">{{ t('users.noUsers') }}</p>
    </div>

    <div
      v-if="editing"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="closeEdit"
    >
      <div class="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">{{ t('users.editUser') }}</h3>
        <form class="mt-4 grid sm:grid-cols-2 gap-3" @submit.prevent="saveEdit">
          <input
            v-model="editName"
            type="text"
            required
            :placeholder="t('users.fullName')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <select
            v-model="editRole"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="supervisor">{{ t('users.supervisor') }}</option>
            <option value="field_worker">{{ t('users.fieldWorker') }}</option>
            <option value="owner">{{ t('users.founder') }}</option>
          </select>
          <input
            v-model="editPhone"
            type="tel"
            placeholder="+234..."
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model.number="editDailyWageNgn"
            type="number"
            min="0"
            step="1"
            :placeholder="t('users.dailyWage')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <p v-if="editError" class="sm:col-span-2 text-xs text-red-400">{{ editError }}</p>
          <div class="sm:col-span-2 flex justify-end gap-2">
            <button
              type="button"
              class="text-xs px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="closeEdit"
            >
              {{ t('users.cancel') }}
            </button>
            <button
              type="submit"
              :disabled="editSaving"
              class="text-xs px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            >
              {{ editSaving ? t('users.saving') : t('users.saveChanges') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </AppLayout>
</template>
