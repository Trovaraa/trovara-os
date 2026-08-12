<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AssignableFarmRole } from '@/composables/useUsers'

const newEmail = defineModel<string>('newEmail', { required: true })
const newName = defineModel<string>('newName', { required: true })
const newFarmRoleId = defineModel<string>('newFarmRoleId', { required: true })
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
  creating: boolean
  createError: string | null
  assignableRoles: AssignableFarmRole[]
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
          :aria-label="t('users.email')"
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
          :aria-label="t('users.name')"
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
          v-model="newFarmRoleId"
          :aria-label="t('users.role')"
          required
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        >
          <option disabled value="">Select role bundle</option>
          <option v-for="role in assignableRoles" :key="role.id" :value="role.id">
            {{ role.name }}{{ role.isSystem ? '' : ' (custom)' }}
          </option>
        </select>
        <p class="text-[11px] text-slate-500 mt-1">
          Bundles come from Settings → Roles & permissions.
        </p>
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.jobTitle') }}</label>
        <input
          v-model="newJobTitle"
          :aria-label="t('users.jobTitle')"
          type="text"
          maxlength="200"
          :placeholder="t('users.jobTitle')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.password') }}</label>
        <input
          v-model="newPassword"
          :aria-label="t('users.password')"
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
          :aria-label="t('users.phone')"
          type="tel"
          placeholder="+234..."
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.employeeNumber') }}</label>
        <input
          v-model="newEmployeeNumber"
          :aria-label="t('users.employeeNumber')"
          type="text"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.employmentType') }}</label>
        <select
          v-model="newEmploymentType"
          :aria-label="t('users.employmentType')"
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
          :aria-label="t('users.employmentStartDate')"
          type="date"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.monthlyWage') }}</label>
        <input
          v-model.number="newMonthlyWageNgn"
          :aria-label="t('users.monthlyWage')"
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
          :aria-label="t('users.wageEffectiveFrom')"
          type="date"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.nextOfKinName') }}</label>
        <input
          v-model="newNextOfKinName"
          :aria-label="t('users.nextOfKinName')"
          type="text"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.nextOfKinPhone') }}</label>
        <input
          v-model="newNextOfKinPhone"
          :aria-label="t('users.nextOfKinPhone')"
          type="tel"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('users.nextOfKinRelationship') }}</label>
        <input
          v-model="newNextOfKinRelationship"
          :aria-label="t('users.nextOfKinRelationship')"
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
