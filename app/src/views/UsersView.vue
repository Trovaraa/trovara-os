<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import UsersCreateForm from '@/components/users/UsersCreateForm.vue'
import UsersEditModal from '@/components/users/UsersEditModal.vue'
import UsersTable from '@/components/users/UsersTable.vue'
import { useUsers } from '@/composables/useUsers'

const { t } = useI18n()

const {
  users,
  loading,
  newEmail,
  newName,
  newRoleChoice,
  newCustomRoleName,
  newPassword,
  newPhone,
  newMonthlyWageNgn,
  newMonthlyWageEffectiveFrom,
  newConfirmMonthlyWage,
  newNextOfKinName,
  newNextOfKinPhone,
  newNextOfKinRelationship,
  newEmployeeNumber,
  newJobTitle,
  newEmploymentType,
  newEmploymentStartDate,
  creating,
  createError,
  toggling,
  deleting,
  deleteError,
  editing,
  editName,
  editRoleChoice,
  editCustomRoleName,
  editPhone,
  editMonthlyWageNgn,
  editMonthlyWageEffectiveFrom,
  editConfirmMonthlyWage,
  editNextOfKinName,
  editNextOfKinPhone,
  editNextOfKinRelationship,
  editEmployeeNumber,
  editJobTitle,
  editEmploymentType,
  editEmploymentStartDate,
  editEmploymentEndDate,
  editEmploymentStatus,
  editSaving,
  editError,
  newIsOther,
  editIsOther,
  displayRole,
  createUser,
  toggleActive,
  deleteUser,
  openEdit,
  closeEdit,
  saveEdit,
} = useUsers()
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('users.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('users.subtitle') }}</p>
    </div>

    <UsersCreateForm
      v-model:new-email="newEmail"
      v-model:new-name="newName"
      v-model:new-role-choice="newRoleChoice"
      v-model:new-custom-role-name="newCustomRoleName"
      v-model:new-password="newPassword"
      v-model:new-phone="newPhone"
      v-model:new-employee-number="newEmployeeNumber"
      v-model:new-job-title="newJobTitle"
      v-model:new-employment-type="newEmploymentType"
      v-model:new-employment-start-date="newEmploymentStartDate"
      v-model:new-monthly-wage-ngn="newMonthlyWageNgn"
      v-model:new-monthly-wage-effective-from="newMonthlyWageEffectiveFrom"
      v-model:new-next-of-kin-name="newNextOfKinName"
      v-model:new-next-of-kin-phone="newNextOfKinPhone"
      v-model:new-next-of-kin-relationship="newNextOfKinRelationship"
      v-model:new-confirm-monthly-wage="newConfirmMonthlyWage"
      :new-is-other="newIsOther"
      :creating="creating"
      :create-error="createError"
      @submit="createUser"
    />

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('users.loading') }}</div>

    <UsersTable
      v-else
      :users="users"
      :toggling="toggling"
      :deleting="deleting"
      :delete-error="deleteError"
      :display-role="displayRole"
      @edit="openEdit"
      @toggle="toggleActive"
      @delete="deleteUser"
    />

    <UsersEditModal
      v-if="editing"
      v-model:edit-name="editName"
      v-model:edit-role-choice="editRoleChoice"
      v-model:edit-custom-role-name="editCustomRoleName"
      v-model:edit-phone="editPhone"
      v-model:edit-employee-number="editEmployeeNumber"
      v-model:edit-job-title="editJobTitle"
      v-model:edit-employment-type="editEmploymentType"
      v-model:edit-employment-start-date="editEmploymentStartDate"
      v-model:edit-employment-end-date="editEmploymentEndDate"
      v-model:edit-employment-status="editEmploymentStatus"
      v-model:edit-monthly-wage-ngn="editMonthlyWageNgn"
      v-model:edit-monthly-wage-effective-from="editMonthlyWageEffectiveFrom"
      v-model:edit-next-of-kin-name="editNextOfKinName"
      v-model:edit-next-of-kin-phone="editNextOfKinPhone"
      v-model:edit-next-of-kin-relationship="editNextOfKinRelationship"
      v-model:edit-confirm-monthly-wage="editConfirmMonthlyWage"
      :editing="editing"
      :edit-is-other="editIsOther"
      :edit-saving="editSaving"
      :edit-error="editError"
      @close="closeEdit"
      @save="saveEdit"
    />
  </AppLayout>
</template>
