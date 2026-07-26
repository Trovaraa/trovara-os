<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { RoleChoice } from '@/composables/useUsers'

const newEmail = defineModel<string>('newEmail', { required: true })
const newName = defineModel<string>('newName', { required: true })
const newRoleChoice = defineModel<RoleChoice>('newRoleChoice', { required: true })
const newCustomRoleName = defineModel<string>('newCustomRoleName', { required: true })
const newPassword = defineModel<string>('newPassword', { required: true })
const newPhone = defineModel<string>('newPhone', { required: true })
const newEmployeeNumber = defineModel<string>('newEmployeeNumber', { required: true })
const newJobTitle = defineModel<string>('newJobTitle', { required: true })
const newEmploymentType = defineModel<string>('newEmploymentType', { required: true })
const newEmploymentStartDate = defineModel<string>('newEmploymentStartDate', { required: true })
const newMonthlyWageNgn = defineModel<number | ''>('newMonthlyWageNgn', { required: true })
const newMonthlyWageEffectiveFrom = defineModel<string>('newMonthlyWageEffectiveFrom', { required: true })
const newNextOfKinName = defineModel<string>('newNextOfKinName', { required: true })
const newNextOfKinPhone = defineModel<string>('newNextOfKinPhone', { required: true })
const newNextOfKinRelationship = defineModel<string>('newNextOfKinRelationship', { required: true })
const newConfirmMonthlyWage = defineModel<boolean>('newConfirmMonthlyWage', { required: true })

defineProps<{
  newIsOther: boolean
  creating: boolean
  createError: string | null
}>()

const emit = defineEmits<{ submit: [] }>()
const { t } = useI18n()
</script>

<template>
  <form
    class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
    @submit.prevent="emit('submit')"
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
          v-model="newRoleChoice"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        >
          <option value="supervisor">{{ t('users.supervisor') }}</option>
          <option value="sales">{{ t('users.sales') }}</option>
          <option value="field_worker">{{ t('users.fieldWorker') }}</option>
          <option value="other">{{ t('users.roleOther') }}</option>
        </select>
      </div>
      <div v-if="newIsOther">
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.customRoleName') }}</label>
        <input
          v-model="newCustomRoleName"
          type="text"
          required
          maxlength="200"
          :placeholder="t('users.customRolePlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
        <p class="text-[11px] text-slate-500 mt-1">{{ t('users.otherRoleHint') }}</p>
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
      <div v-if="!newIsOther">
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
</template>
