import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'
import { roleLabel } from '@/lib/roles'
import type { UserRole } from '@/stores/auth'

export type FarmUser = {
  id: string
  email: string
  name: string
  role: UserRole
  farmRoleId?: string | null
  farmRoleName?: string | null
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

export type AssignableFarmRole = {
  id: string
  name: string
  isSystem: boolean
  clonedFrom: string | null
}

/** Users list CRUD state for UsersView. */
export function useUsers() {
  const { t } = useI18n()

  const users = ref<FarmUser[]>([])
  const loading = ref(true)

  const newEmail = ref('')
  const newName = ref('')
  const newFarmRoleId = ref('')
  const newPassword = ref('')
  const assignableRoles = ref<AssignableFarmRole[]>([])
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
  const editFarmRoleId = ref('')
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

  function displayRole(user: FarmUser): string {
    const bundle = user.farmRoleName?.trim()
    if (bundle && bundle !== roleLabel(user.role)) {
      return user.jobTitle?.trim()
        ? `${user.jobTitle.trim()} · ${bundle}`
        : bundle
    }
    if (user.jobTitle?.trim()) {
      return `${user.jobTitle.trim()} (${roleLabel(user.role)})`
    }
    return roleLabel(user.role)
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
      const [data, roles] = await Promise.all([
        api<{ users: FarmUser[] }>('/api/users'),
        api<{ roles: AssignableFarmRole[] }>('/api/roles/assignable').catch(() => ({
          roles: [] as AssignableFarmRole[],
        })),
      ])
      users.value = data.users
      assignableRoles.value = roles.roles
      if (!newFarmRoleId.value && roles.roles.length) {
        const field = roles.roles.find((r) => r.clonedFrom === 'field_worker')
        newFarmRoleId.value = field?.id ?? roles.roles[0]!.id
      }
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
    const field = assignableRoles.value.find((r) => r.clonedFrom === 'field_worker')
    newFarmRoleId.value = field?.id ?? assignableRoles.value[0]?.id ?? ''
  }

  async function createUser() {
    if (!newEmail.value.trim() || !newName.value.trim() || !newPassword.value) return
    if (!newFarmRoleId.value) {
      createError.value = 'Select a role bundle'
      return
    }
    creating.value = true
    createError.value = null
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newEmail.value.trim(),
          name: newName.value.trim(),
          farmRoleId: newFarmRoleId.value,
          password: newPassword.value,
          phone: newPhone.value.trim() || undefined,
          monthlyWageNgn: optionalWageNgn(newMonthlyWageNgn.value) ?? undefined,
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

  async function breakGlassToggleAdmin(user: FarmUser) {
    if (user.role !== 'owner') return
    const action = user.active ? 'deactivate' : 'reactivate'
    const password = window.prompt(
      `Armed break-glass password required to ${action} Admin ${user.email}`,
    )
    if (!password) return
    const reason = window.prompt('Reason for this cleanup action (required)')?.trim()
    if (!reason || reason.length < 3) {
      deleteError.value = 'A reason of at least 3 characters is required'
      return
    }
    deleting.value = user.id
    deleteError.value = null
    try {
      await api(`/api/users/${user.id}/break-glass-${action}`, {
        method: 'POST',
        body: JSON.stringify({ password, reason }),
      })
      await load()
    } catch (e) {
      deleteError.value = e instanceof Error ? e.message : `Failed to ${action} admin`
    } finally {
      deleting.value = null
    }
  }

  function openEdit(user: FarmUser) {
    editing.value = user
    editName.value = user.name
    editFarmRoleId.value = user.farmRoleId ?? ''
    editJobTitle.value = user.jobTitle ?? ''
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
    if (editing.value.role !== 'owner' && !editFarmRoleId.value) {
      editError.value = 'Select a role bundle'
      return
    }
    editSaving.value = true
    editError.value = null
    try {
      const wasConfirmed = !!editing.value.monthlyWageConfirmedAt
      const isOwner = editing.value.role === 'owner'

      await api(`/api/users/${editing.value.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.value.trim(),
          ...(isOwner ? {} : { farmRoleId: editFarmRoleId.value }),
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

  return {
    users,
    loading,
    assignableRoles,
    newEmail,
    newName,
    newFarmRoleId,
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
    editFarmRoleId,
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
    displayRole,
    createUser,
    toggleActive,
    deleteUser,
    breakGlassToggleAdmin,
    openEdit,
    closeEdit,
    saveEdit,
    reload: load,
  }
}
