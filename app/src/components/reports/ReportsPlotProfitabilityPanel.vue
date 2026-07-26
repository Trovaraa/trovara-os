<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PlotProfitabilityReport } from '@/composables/useReportsData'

defineProps<{
  plotProfitability: PlotProfitabilityReport
  formatMoney: (amount: number, currency: string) => string
}>()

const { t } = useI18n()
</script>

<template>
  <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-white">{{ t('reports.plotProfitTitle') }}</h3>
      <span class="text-xs text-slate-500">
        {{ t('reports.labourProxy', { rate: formatMoney(plotProfitability.labourRatePerTask, plotProfitability.currency) }) }}
      </span>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.revenue') }}</p>
        <p class="text-lg font-black text-farm-green">
          {{ formatMoney(plotProfitability.totals.revenue, plotProfitability.currency) }}
        </p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.labour') }}</p>
        <p class="text-lg font-black text-amber-400">
          {{ formatMoney(plotProfitability.totals.labourCost, plotProfitability.currency) }}
        </p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.inputs') }}</p>
        <p class="text-lg font-black text-slate-300">
          {{ formatMoney(plotProfitability.totals.inputCost, plotProfitability.currency) }}
        </p>
      </div>
      <div class="bg-slate-800/50 rounded-xl p-3">
        <p class="text-xs text-slate-500">{{ t('reports.netProfit') }}</p>
        <p
          class="text-lg font-black"
          :class="plotProfitability.totals.netProfit >= 0 ? 'text-farm-green' : 'text-red-400'"
        >
          {{ formatMoney(plotProfitability.totals.netProfit, plotProfitability.currency) }}
        </p>
      </div>
    </div>
    <div v-if="plotProfitability.plots.length" class="overflow-x-auto -mx-1 px-1">
      <table class="w-full min-w-[20rem] text-sm">
        <thead>
          <tr class="text-left text-xs text-slate-500 border-b border-slate-800">
            <th class="pb-2 pr-4">{{ t('reports.plot') }}</th>
            <th class="pb-2 pr-4">{{ t('reports.tasks') }}</th>
            <th class="pb-2 pr-4">{{ t('reports.revenue') }}</th>
            <th class="pb-2 pr-4">{{ t('reports.costs') }}</th>
            <th class="pb-2">{{ t('reports.net') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="plot in plotProfitability.plots"
            :key="plot.plotId"
            class="border-b border-slate-800/50 last:border-0"
          >
            <td class="py-2 pr-4">
              <span class="text-white font-medium">{{ plot.plotName }}</span>
              <span class="text-slate-500 text-xs block capitalize">{{ plot.cropType }}</span>
            </td>
            <td class="py-2 pr-4 text-slate-400">{{ plot.tasksCompleted }}</td>
            <td class="py-2 pr-4 text-farm-green">
              {{ formatMoney(plot.revenue, plotProfitability.currency) }}
            </td>
            <td class="py-2 pr-4 text-slate-400">
              {{ formatMoney(plot.labourCost + plot.inputCost, plotProfitability.currency) }}
            </td>
            <td
              class="py-2 font-mono"
              :class="plot.netProfit >= 0 ? 'text-farm-green' : 'text-red-400'"
            >
              {{ formatMoney(plot.netProfit, plotProfitability.currency) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="text-slate-500 text-sm">{{ t('reports.noPlots') }}</p>
  </section>
</template>
