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
  monthlyWageNgn?: number | null
  monthlyWageEffectiveFrom?: string | null
  monthlyWageConfirmedAt?: string | null
  nextOfKinName?: string | null
  nextOfKinPhone?: string | null
  nextOfKinRelationship?: string | null
  employeeNumber?: string | null
  jobTitle?: string | null
  employmentType?: string | null
  employmentStartDate?: string | null
  employmentEndDate?: string | null
  employmentStatus?: string | null
}

const users = ref<FarmUser[]>([])
const loading = ref(true)

const newEmail = ref('')
const newName = ref('')
const newRole = ref<UserRole>('field_worker')
const newPassword = ref('')
const newPhone = ref('')
const newMonthlyWageNgn = ref<number | ''>('')
const newMonthlyWageEffectiveFrom = ref('')
const newConfirmMonthlyWage = ref(false)
const newNextOfKinName = ref('')
const newNextOfKinPhone = ref('')
const newNextOfKinRelationship = ref('')
const newEmployeeNumber = ref('')
const newJobTitle = ref('')
const newEmploymentType = ref('')
const newEmploymentStartDate = ref('')
const newEmploymentStatus = ref('employed')
const creating = ref(false)
const createError = ref<string | null>(null)

const toggling = ref<string | null>(null)
const editing = ref<FarmUser | null>(null)
const editName = ref('')
const editRole = ref<UserRole>('field_worker')
const editPhone = ref('')
const editMonthlyWageNgn = ref<number | ''>('')
const editMonthlyWageEffectiveFrom = ref('')
const editConfirmMonthlyWage = ref(false)
const editNextOfKinName = ref('')
const editNextOfKinPhone = ref('')
const editNextOfKinRelationship = ref('')
const editEmployeeNumber = ref('')
const editJobTitle = ref('')
const editEmploymentType = ref('')
const editEmploymentStartDate = ref('')
const editEmploymentEndDate = ref('')
const editEmploymentStatus = ref('employed')
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

function resetCreateForm() {
  newEmail.value = ''
  newName.value = ''
  newPassword.value = ''
  newPhone.value = ''
  newMonthlyWageNgn.value = ''
  newMonthlyWageEffectiveFrom.value = ''
  newConfirmMonthlyWage.value = false
  newNextOfKinName.value = ''
  newNextOfKinPhone.value = ''
  newNextOfKinRelationship.value = ''
  newEmployeeNumber.value = ''
  newJobTitle.value = ''
  newEmploymentType.value = ''
  newEmploymentStartDate.value = ''
  newEmploymentStatus.value = 'employed'
  newRole.value = 'field_worker'
}

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
        monthlyWageNgn:
          newMonthlyWageNgn.value === '' ? undefined : Number(newMonthlyWageNgn.value),
        monthlyWageEffectiveFrom: newMonthlyWageEffectiveFrom.value || undefined,
        confirmMonthlyWage: newConfirmMonthlyWage.value || undefined,
        nextOfKinName: newNextOfKinName.value.trim() || undefined,
        nextOfKinPhone: newNextOfKinPhone.value.trim() || undefined,
        nextOfKinRelationship: newNextOfKinRelationship.value.trim() || undefined,
        employeeNumber: newEmployeeNumber.value.trim() || undefined,
        jobTitle: newJobTitle.value.trim() || undefined,
        employmentType: newEmploymentType.value || undefined,
        employmentStartDate: newEmploymentStartDate.value || undefined,
        employmentStatus: newEmploymentStatus.value || undefined,
      }),
    })
    resetCreateForm()
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
  editMonthlyWageNgn.value = user.monthlyWageNgn ?? ''
  editMonthlyWageEffectiveFrom.value = user.monthlyWageEffectiveFrom ?? ''
  editConfirmMonthlyWage.value = !!user.monthlyWageConfirmedAt
  editNextOfKinName.value = user.nextOfKinName ?? ''
  editNextOfKinPhone.value = user.nextOfKinPhone ?? ''
  editNextOfKinRelationship.value = user.nextOfKinRelationship ?? ''
  editEmployeeNumber.value = user.employeeNumber ?? ''
  editJobTitle.value = user.jobTitle ?? ''
  editEmploymentType.value = user.employmentType ?? ''
  editEmploymentStartDate.value = user.employmentStartDate ?? ''
  editEmploymentEndDate.value = user.employmentEndDate ?? ''
  editEmploymentStatus.value = user.employmentStatus ?? 'employed'
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
    const wasConfirmed = !!editing.value.monthlyWageConfirmedAt
    await api(`/api/users/${editing.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editName.value.trim(),
        role: editRole.value,
        phone: editPhone.value.trim() || null,
        monthlyWageNgn:
          editMonthlyWageNgn.value === '' ? null : Number(editMonthlyWageNgn.value),
        monthlyWageEffectiveFrom: editMonthlyWageEffectiveFrom.value || null,
        confirmMonthlyWage: editConfirmMonthlyWage.value
          ? true
          : wasConfirmed && !editConfirmMonthlyWage.value
            ? false
            : undefined,
        nextOfKinName: editNextOfKinName.value.trim() || null,
        nextOfKinPhone: editNextOfKinPhone.value.trim() || null,
        nextOfKinRelationship: editNextOfKinRelationship.value.trim() || null,
        employeeNumber: editEmployeeNumber.value.trim() || null,
        jobTitle: editJobTitle.value.trim() || null,
        employmentType: editEmploymentType.value || null,
        employmentStartDate: editEmploymentStartDate.value || null,
        employmentEndDate: editEmploymentEndDate.value || null,
        employmentStatus: editEmploymentStatus.value || null,
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
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.employeeNumber') }}</label>
          <input
            v-model="newEmployeeNumber"
            type="text"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.jobTitle') }}</label>
          <input
            v-model="newJobTitle"
            type="text"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.employmentType') }}</label>
          <select
            v-model="newEmploymentType"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option value="">{{ t('users.optional') }}</option>
            <option value="permanent">{{ t('users.employmentPermanent') }}</option>
            <option value="temporary">{{ t('users.employmentTemporary') }}</option>
            <option value="casual">{{ t('users.employmentCasual') }}</option>
            <option value="contract">{{ t('users.employmentContract') }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.employmentStartDate') }}</label>
          <input
            v-model="newEmploymentStartDate"
            type="date"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.monthlyWage') }}</label>
          <input
            v-model.number="newMonthlyWageNgn"
            type="number"
            min="0"
            step="1"
            :placeholder="t('users.wagePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.wageEffectiveFrom') }}</label>
          <input
            v-model="newMonthlyWageEffectiveFrom"
            type="date"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.nextOfKinName') }}</label>
          <input
            v-model="newNextOfKinName"
            type="text"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.nextOfKinPhone') }}</label>
          <input
            v-model="newNextOfKinPhone"
            type="tel"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.nextOfKinRelationship') }}</label>
          <input
            v-model="newNextOfKinRelationship"
            type="text"
            :placeholder="t('users.nextOfKinRelationshipPlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <label class="flex items-center gap-2 text-sm text-slate-300">
        <input v-model="newConfirmMonthlyWage" type="checkbox" class="rounded border-slate-600" />
        {{ t('users.confirmMonthlyWage') }}
      </label>
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
            <th class="pb-3 font-semibold">{{ t('users.monthlyWageShort') }}</th>
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
            <td class="py-4 font-medium text-white">
              {{ user.name }}
              <span
                v-if="user.employeeNumber"
                class="ml-2 text-xs text-slate-500"
              >#{{ user.employeeNumber }}</span>
            </td>
            <td class="py-4 text-slate-400">{{ user.email }}</td>
            <td class="py-4 text-slate-300">{{ roleLabel(user.role) }}</td>
            <td class="py-4 text-slate-400">{{ user.phone ?? '-' }}</td>
            <td class="py-4 text-slate-400 font-mono">
              <span v-if="user.monthlyWageNgn != null">₦{{ user.monthlyWageNgn }}</span>
              <span v-else>-</span>
              <span
                v-if="user.monthlyWageConfirmedAt"
                class="ml-2 text-[10px] uppercase text-farm-green"
              >{{ t('users.wageConfirmed') }}</span>
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
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center overflow-y-auto"
      @click.self="closeEdit"
    >
      <div class="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-5 my-8">
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
          </select>
          <input
            v-model="editPhone"
            type="tel"
            placeholder="+234..."
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editEmployeeNumber"
            type="text"
            :placeholder="t('users.employeeNumber')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editJobTitle"
            type="text"
            :placeholder="t('users.jobTitle')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <select
            v-model="editEmploymentType"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">{{ t('users.employmentType') }}</option>
            <option value="permanent">{{ t('users.employmentPermanent') }}</option>
            <option value="temporary">{{ t('users.employmentTemporary') }}</option>
            <option value="casual">{{ t('users.employmentCasual') }}</option>
            <option value="contract">{{ t('users.employmentContract') }}</option>
          </select>
          <input
            v-model="editEmploymentStartDate"
            type="date"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editEmploymentEndDate"
            type="date"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <select
            v-model="editEmploymentStatus"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="employed">{{ t('users.employmentEmployed') }}</option>
            <option value="leave">{{ t('users.employmentLeave') }}</option>
            <option value="ended">{{ t('users.employmentEnded') }}</option>
          </select>
          <input
            v-model.number="editMonthlyWageNgn"
            type="number"
            min="0"
            step="1"
            :placeholder="t('users.monthlyWage')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editMonthlyWageEffectiveFrom"
            type="date"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editNextOfKinName"
            type="text"
            :placeholder="t('users.nextOfKinName')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editNextOfKinPhone"
            type="tel"
            :placeholder="t('users.nextOfKinPhone')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="editNextOfKinRelationship"
            type="text"
            :placeholder="t('users.nextOfKinRelationship')"
            class="sm:col-span-2 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <label class="sm:col-span-2 flex items-center gap-2 text-sm text-slate-300">
            <input v-model="editConfirmMonthlyWage" type="checkbox" class="rounded border-slate-600" />
            {{ t('users.confirmMonthlyWage') }}
          </label>
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
