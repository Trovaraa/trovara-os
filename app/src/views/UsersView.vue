<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { roleLabel } from '@/lib/roles'
import type { UserRole } from '@/stores/auth'

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
    createError.value = e instanceof Error ? e.message : 'Failed to create user'
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
    editError.value = e instanceof Error ? e.message : 'Failed to update user'
  } finally {
    editSaving.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Users</h2>
      <p class="text-slate-400 text-sm mt-1">Manage farm team members - Founder only</p>
    </div>

    <form
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createUser"
    >
      <h3 class="font-bold text-white text-sm">Add user</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Email</label>
          <input
            v-model="newEmail"
            type="email"
            required
            placeholder="worker@trovara.farm"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Name</label>
          <input
            v-model="newName"
            type="text"
            required
            maxlength="200"
            placeholder="Full name"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Role</label>
          <select
            v-model="newRole"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option value="supervisor">Supervisor</option>
            <option value="field_worker">Field worker</option>
            <option value="owner">Founder</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Password</label>
          <input
            v-model="newPassword"
            type="password"
            required
            minlength="8"
            placeholder="Min 8 characters"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Phone</label>
          <input
            v-model="newPhone"
            type="tel"
            placeholder="+234..."
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Daily wage (NGN)</label>
          <input
            v-model.number="newDailyWageNgn"
            type="number"
            min="0"
            step="1"
            placeholder="e.g. 7000"
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
          {{ creating ? 'Creating…' : 'Create user' }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">Loading users…</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">Name</th>
            <th class="pb-3 font-semibold">Email</th>
            <th class="pb-3 font-semibold">Role</th>
            <th class="pb-3 font-semibold">Phone</th>
            <th class="pb-3 font-semibold">Daily wage</th>
            <th class="pb-3 font-semibold">Status</th>
            <th class="pb-3 font-semibold">Joined</th>
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
                {{ user.active ? 'Active' : 'Inactive' }}
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
                Edit
              </button>
              <button
                v-if="user.role !== 'owner'"
                type="button"
                class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                :disabled="toggling === user.id"
                @click="toggleActive(user)"
              >
                {{ toggling === user.id ? '…' : user.active ? 'Deactivate' : 'Activate' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!users.length" class="text-slate-500 text-sm mt-4">No users found.</p>
    </div>

    <div
      v-if="editing"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="closeEdit"
    >
      <div class="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Edit user</h3>
        <form class="mt-4 grid sm:grid-cols-2 gap-3" @submit.prevent="saveEdit">
          <input
            v-model="editName"
            type="text"
            required
            placeholder="Full name"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <select
            v-model="editRole"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="supervisor">Supervisor</option>
            <option value="field_worker">Field worker</option>
            <option value="owner">Founder</option>
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
            placeholder="Daily wage (NGN)"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <p v-if="editError" class="sm:col-span-2 text-xs text-red-400">{{ editError }}</p>
          <div class="sm:col-span-2 flex justify-end gap-2">
            <button
              type="button"
              class="text-xs px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="closeEdit"
            >
              Cancel
            </button>
            <button
              type="submit"
              :disabled="editSaving"
              class="text-xs px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            >
              {{ editSaving ? 'Saving…' : 'Save changes' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </AppLayout>
</template>
