import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'
import { roleLabel } from '@/lib/roles'
import type { UserRole } from '@/stores/auth'

export type StaffRole = Exclude<UserRole, 'owner'>
export type RoleChoice = StaffRole | 'other'

export type FarmUser = {
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

/** Users list CRUD state for UsersView. */
export function useUsers() {
  const { t } = useI18n()

  const users = ref<FarmUser[]>([])
  const loading = ref(true)

  const newEmail = ref('')
  const newName = ref('')
  const newRoleChoice = ref<RoleChoice>('field_worker')
  const newCustomRoleName = ref('')
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
  const deleting = ref<string | null>(null)
  const deleteError = ref<string | null>(null)
  const editing = ref<FarmUser | null>(null)
  const editName = ref('')
  const editRoleChoice = ref<RoleChoice>('field_worker')
  const editCustomRoleName = ref('')
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

  const newIsOther = computed(() => newRoleChoice.value === 'other')
  const editIsOther = computed(() => editRoleChoice.value === 'other')

  function displayRole(user: FarmUser): string {
    if (user.jobTitle?.trim()) {
      return `${user.jobTitle.trim()} (${roleLabel(user.role)})`
    }
    return roleLabel(user.role)
  }

  /** Other always starts as field_worker; admin upgrades via Role (supervisor/sales). */
  function rolePayload(choice: RoleChoice, customName: string, jobTitle: string) {
    if (choice === 'other') {
      return {
        role: 'field_worker' as const,
        jobTitle: customName.trim(),
      }
    }
    // Keep custom name if admin upgrades Other → supervisor/sales without retyping job title
    const title = jobTitle.trim() || customName.trim()
    return {
      role: choice,
      jobTitle: title || undefined,
    }
  }

  function optionalWageNgn(value: number | '' | null | undefined): number | null {
    if (value === '' || value == null) return null
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.trunc(n)
  }

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
    newCustomRoleName.value = ''
    newEmploymentType.value = ''
    newEmploymentStartDate.value = ''
    newEmploymentStatus.value = 'employed'
    newRoleChoice.value = 'field_worker'
  }

  async function createUser() {
    if (!newEmail.value.trim() || !newName.value.trim() || !newPassword.value) return
    if (newIsOther.value && !newCustomRoleName.value.trim()) {
      createError.value = t('users.customRoleRequired')
      return
    }
    creating.value = true
    createError.value = null
    try {
      const { role, jobTitle } = rolePayload(
        newRoleChoice.value,
        newCustomRoleName.value,
        newJobTitle.value,
      )
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newEmail.value.trim(),
          name: newName.value.trim(),
          role,
          password: newPassword.value,
          phone: newPhone.value.trim() || undefined,
          monthlyWageNgn: optionalWageNgn(newMonthlyWageNgn.value) ?? undefined,
          monthlyWageEffectiveFrom: newMonthlyWageEffectiveFrom.value || undefined,
          confirmMonthlyWage: newConfirmMonthlyWage.value || undefined,
          nextOfKinName: newNextOfKinName.value.trim() || undefined,
          nextOfKinPhone: newNextOfKinPhone.value.trim() || undefined,
          nextOfKinRelationship: newNextOfKinRelationship.value.trim() || undefined,
          employeeNumber: newEmployeeNumber.value.trim() || undefined,
          jobTitle: jobTitle || undefined,
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

  async function deleteUser(user: FarmUser) {
    if (user.role === 'owner') return
    const ok = window.confirm(
      t('users.deleteConfirm', { name: user.name, email: user.email }),
    )
    if (!ok) return
    deleting.value = user.id
    deleteError.value = null
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' })
      if (editing.value?.id === user.id) editing.value = null
      await load()
    } catch (e) {
      deleteError.value = e instanceof Error ? e.message : t('users.deleteFailed')
    } finally {
      deleting.value = null
    }
  }

  function openEdit(user: FarmUser) {
    editing.value = user
    editName.value = user.name
    // Other = custom name + field_worker. Upgraded roles keep job title under their system role.
    if (user.role === 'field_worker' && user.jobTitle?.trim()) {
      editRoleChoice.value = 'other'
      editCustomRoleName.value = user.jobTitle
      editJobTitle.value = ''
    } else {
      editRoleChoice.value = user.role === 'owner' ? 'field_worker' : (user.role as StaffRole)
      editCustomRoleName.value = ''
      editJobTitle.value = user.jobTitle ?? ''
    }
    editPhone.value = user.phone ?? ''
    editMonthlyWageNgn.value = user.monthlyWageNgn ?? ''
    editMonthlyWageEffectiveFrom.value = user.monthlyWageEffectiveFrom ?? ''
    editConfirmMonthlyWage.value = !!user.monthlyWageConfirmedAt
    editNextOfKinName.value = user.nextOfKinName ?? ''
    editNextOfKinPhone.value = user.nextOfKinPhone ?? ''
    editNextOfKinRelationship.value = user.nextOfKinRelationship ?? ''
    editEmployeeNumber.value = user.employeeNumber ?? ''
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
    if (editing.value.role === 'owner') {
      // Owners keep their role; only profile fields change
    } else if (editIsOther.value && !editCustomRoleName.value.trim()) {
      editError.value = t('users.customRoleRequired')
      return
    }
    editSaving.value = true
    editError.value = null
    try {
      const wasConfirmed = !!editing.value.monthlyWageConfirmedAt
      const isOwner = editing.value.role === 'owner'
      const { role, jobTitle } = isOwner
        ? { role: undefined as StaffRole | undefined, jobTitle: editJobTitle.value.trim() || null }
        : rolePayload(
            editRoleChoice.value,
            editCustomRoleName.value,
            editJobTitle.value,
          )

      await api(`/api/users/${editing.value.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.value.trim(),
          ...(isOwner ? {} : { role }),
          phone: editPhone.value.trim() || null,
          monthlyWageNgn: optionalWageNgn(editMonthlyWageNgn.value),
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
          jobTitle: jobTitle === undefined ? null : jobTitle || null,
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

  return {
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
    newEmploymentStatus,
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
    reload: load,
  }
}
