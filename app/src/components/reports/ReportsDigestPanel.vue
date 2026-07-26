<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { DigestReport } from '@/composables/useReportsData'

defineProps<{
  digest: DigestReport
}>()

const { t } = useI18n()
</script>

<template>
  <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-white">{{ t('reports.digestTitle') }}</h3>
      <span class="text-xs text-slate-500">{{ t('reports.exceptionsCount', { count: digest.summary.total }) }}</span>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.overdue') }}</p>
        <p class="text-xl font-black text-red-400">{{ digest.summary.overdueTasks }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.lowStock') }}</p>
        <p class="text-xl font-black text-amber-400">{{ digest.summary.lowStock }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.approvals') }}</p>
        <p class="text-xl font-black text-purple-400">{{ digest.summary.pendingApprovals }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.mortalityToday') }}</p>
        <p class="text-xl font-black text-red-300">{{ digest.summary.mortalityToday }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.ordersPending') }}</p>
        <p class="text-xl font-black text-blue-400">{{ digest.summary.ordersPending }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.rejected') }}</p>
        <p class="text-xl font-black text-slate-300">{{ digest.summary.rejectedTasks }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.notLoggedToday') }}</p>
        <p class="text-xl font-black text-amber-400">{{ digest.summary.assetLogsMissing }}</p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.assetsToVerify') }}</p>
        <p class="text-xl font-black text-cyan-400">{{ digest.summary.assetVerificationPending }}</p>
      </div>
    </div>
  </section>
</template>
