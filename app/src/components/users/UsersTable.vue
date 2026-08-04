<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { FarmUser } from '@/composables/useUsers'

defineProps<{
  users: FarmUser[]
  toggling: string | null
  deleting: string | null
  deleteError: string | null
  displayRole: (user: FarmUser) => string
  canBreakGlassCleanup?: boolean
}>()

const emit = defineEmits<{
  edit: [user: FarmUser]
  toggle: [user: FarmUser]
  delete: [user: FarmUser]
  'break-glass-admin': [user: FarmUser]
}>()

const { t } = useI18n()
</script>

<template>
  <div class="mt-8 overflow-x-auto">
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
          <td class="py-4 text-slate-300">{{ displayRole(user) }}</td>
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
          <td class="py-4 text-right whitespace-nowrap">
            <button
              type="button"
              class="mr-2 text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="emit('edit', user)"
            >
              {{ t('users.edit') }}
            </button>
            <button
              v-if="user.role !== 'owner'"
              type="button"
              class="mr-2 text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
              :disabled="toggling === user.id || deleting === user.id"
              @click="emit('toggle', user)"
            >
              {{ toggling === user.id ? '…' : user.active ? t('users.deactivate') : t('users.activate') }}
            </button>
            <button
              v-if="user.role !== 'owner'"
              type="button"
              class="text-xs px-3 py-1.5 rounded-lg bg-red-950/60 text-red-300 hover:bg-red-900/70 disabled:opacity-50"
              :disabled="deleting === user.id || toggling === user.id"
              @click="emit('delete', user)"
            >
              {{ deleting === user.id ? '…' : t('users.delete') }}
            </button>
            <button
              v-if="canBreakGlassCleanup && user.role === 'owner'"
              type="button"
              class="ml-2 text-xs px-3 py-1.5 rounded-lg bg-amber-950/50 text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
              :disabled="deleting === user.id"
              @click="emit('break-glass-admin', user)"
            >
              {{
                deleting === user.id
                  ? '…'
                  : user.active
                    ? 'Break-glass deactivate'
                    : 'Break-glass reactivate'
              }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="deleteError" class="text-red-400 text-sm mt-3">{{ deleteError }}</p>
    <p v-if="!users.length" class="text-slate-500 text-sm mt-4">{{ t('users.noUsers') }}</p>
  </div>
</template>
