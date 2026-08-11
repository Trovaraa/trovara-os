<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { BillingStatus } from '@/composables/useSettingsOnboarding'
import { resolveApiUrl } from '@/lib/api'

defineProps<{
  billingStatus: BillingStatus | null
}>()

const { t } = useI18n()
</script>

<template>
  <div class="contents">
    <div v-if="billingStatus" class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 class="font-bold text-white text-sm">{{ t('settings.saasBilling') }}</h3>
      <p class="text-xs text-slate-400 mt-2">{{ t('settings.saasBillingInfo') }}</p>
      <p class="text-xs mt-2">
        <span class="font-bold px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">
          {{ billingStatus.enabled ? t('settings.billingEnabled') : t('settings.billingPlaceholder') }}
        </span>
      </p>
      <p class="text-xs text-slate-500 mt-3">{{ t('settings.seeDocs', { docs: billingStatus.docs }) }}</p>
    </div>

    <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 class="font-bold text-white text-sm">{{ t('settings.csvExports') }}</h3>
      <p class="text-xs text-slate-500 mt-1">{{ t('settings.csvDesc') }}</p>
      <div class="mt-4 flex flex-wrap gap-2">
        <a
          :href="resolveApiUrl('/api/exports/tasks.csv')"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          {{ t('settings.exportTasksCsv') }}
        </a>
        <a
          :href="resolveApiUrl('/api/exports/inventory.csv')"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          {{ t('settings.exportInventoryCsv') }}
        </a>
        <a
          :href="resolveApiUrl('/api/exports/expenses.csv')"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          {{ t('settings.exportExpensesCsv') }}
        </a>
        <a
          :href="resolveApiUrl('/api/exports/audit.csv')"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          {{ t('settings.exportAuditCsv') }}
        </a>
      </div>
    </div>
  </div>
</template>
