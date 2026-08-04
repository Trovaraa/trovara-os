<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { roleLabel } from '@/lib/roles'
import type { AssignableFarmRole, FarmUser } from '@/composables/useUsers'

const editName = defineModel<string>('editName', { required: true })
const editFarmRoleId = defineModel<string>('editFarmRoleId', { required: true })
const editPhone = defineModel<string>('editPhone', { required: true })
const editEmployeeNumber = defineModel<string>('editEmployeeNumber', { required: true })
const editJobTitle = defineModel<string>('editJobTitle', { required: true })
const editEmploymentType = defineModel<string>('editEmploymentType', { required: true })
const editEmploymentStartDate = defineModel<string>('editEmploymentStartDate', { required: true })
const editEmploymentEndDate = defineModel<string>('editEmploymentEndDate', { required: true })
const editEmploymentStatus = defineModel<string>('editEmploymentStatus', { required: true })
const editMonthlyWageNgn = defineModel<number | ''>('editMonthlyWageNgn', { required: true })
const editMonthlyWageEffectiveFrom = defineModel<string>('editMonthlyWageEffectiveFrom', { required: true })
const editNextOfKinName = defineModel<string>('editNextOfKinName', { required: true })
const editNextOfKinPhone = defineModel<string>('editNextOfKinPhone', { required: true })
const editNextOfKinRelationship = defineModel<string>('editNextOfKinRelationship', { required: true })
const editConfirmMonthlyWage = defineModel<boolean>('editConfirmMonthlyWage', { required: true })

defineProps<{
  editing: FarmUser
  editSaving: boolean
  editError: string | null
  assignableRoles: AssignableFarmRole[]
}>()

const emit = defineEmits<{
  close: []
  save: []
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center overflow-y-auto"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-5 my-8">
      <h3 class="text-white font-bold text-lg">{{ t('users.editUser') }}</h3>
      <form class="mt-4 grid sm:grid-cols-2 gap-3" @submit.prevent="emit('save')">
        <input
          v-model="editName"
          type="text"
          required
          :placeholder="t('users.fullName')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <select
          v-if="editing.role !== 'owner'"
          v-model="editFarmRoleId"
          required
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option v-for="role in assignableRoles" :key="role.id" :value="role.id">
            {{ role.name }}{{ role.isSystem ? '' : ' (custom)' }}
          </option>
        </select>
        <p
          v-else
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          {{ editing.farmRoleName || roleLabel('owner') }}
        </p>
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
            @click="emit('close')"
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
</template>
