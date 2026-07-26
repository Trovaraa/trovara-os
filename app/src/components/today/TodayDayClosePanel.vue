<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { DayCloseData } from '@/composables/useTodayDayClose'

defineProps<{
  isSales: boolean
  dayClose: DayCloseData | null
  dayCloseOpen: boolean
  dayCloseLoading: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()

const { t } = useI18n()

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatCurrency(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString()}`
}
</script>

<template>
  <section class="mt-10">
    <button
      type="button"
      class="w-full flex items-center justify-between bg-slate-900 border border-slate-700 rounded-2xl px-5 py-4 transition-all hover:border-farm-green/50 active:scale-[0.99]"
      @click="emit('toggle')"
    >
      <div class="flex items-center gap-3">
        <span class="text-farm-green text-lg">🌙</span>
        <div class="text-left">
          <p class="font-bold text-white text-sm">
            {{ isSales ? t('today.salesDayClose') : t('today.dayClose') }}
          </p>
          <p class="text-xs text-slate-400 mt-0.5">
            {{ isSales ? t('today.salesDayCloseSubtitle') : t('today.dayCloseSubtitle') }}
          </p>
        </div>
      </div>
      <svg
        class="w-4 h-4 text-slate-400 shrink-0 transition-transform"
        :class="{ 'rotate-180': dayCloseOpen }"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <div v-if="dayCloseOpen" class="mt-3 space-y-4">
      <div v-if="dayCloseLoading" class="text-slate-400 text-sm px-1">{{ t('today.dayCloseLoading') }}</div>

      <template v-else-if="dayClose && dayClose.scope === 'sales' && dayClose.orders">
        <div
          class="rounded-2xl px-5 py-4 flex items-center gap-3"
          :class="dayClose.status === 'clear'
            ? 'bg-farm-green/10 border border-farm-green/30'
            : 'bg-amber-950/40 border border-amber-700/40'"
        >
          <span class="text-xl">{{ dayClose.status === 'clear' ? '✅' : '⚠️' }}</span>
          <div>
            <p class="font-bold text-sm" :class="dayClose.status === 'clear' ? 'text-farm-green' : 'text-amber-300'">
              {{ dayClose.status === 'clear' ? t('today.dayClear') : t('today.needsAttentionClose') }}
            </p>
            <p class="text-xs text-slate-400 mt-0.5">{{ dayClose.date }}</p>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h4 class="font-bold text-white text-sm mb-3">{{ t('today.ordersToday') }}</h4>
          <div class="grid grid-cols-3 gap-3">
            <div class="text-center">
              <p class="text-2xl font-black text-orange-400">{{ dayClose.orders.pending }}</p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.lblOrders') }}</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-black text-sky-400">{{ dayClose.orders.dispatched }}</p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.dispatched') }}</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-black text-farm-green">{{ dayClose.orders.delivered }}</p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.delivered') }}</p>
            </div>
          </div>
          <p class="mt-4 text-sm text-slate-300">
            {{ t('today.revenueToday') }}:
            <span class="font-bold text-white">
              {{ formatCurrency(dayClose.orders.revenueToday, dayClose.orders.currency) }}
            </span>
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <p class="text-xs text-slate-500 font-medium">{{ t('today.unpaidOrders') }}</p>
            <p class="text-2xl font-black mt-1" :class="dayClose.orders.unpaidCount > 0 ? 'text-amber-400' : 'text-slate-400'">
              {{ dayClose.orders.unpaidCount }}
            </p>
            <p class="text-xs text-slate-500 mt-0.5">
              {{ formatCurrency(dayClose.orders.unpaidTotal, dayClose.orders.currency) }}
            </p>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <p class="text-xs text-slate-500 font-medium">{{ t('today.lowStock') }}</p>
            <p class="text-2xl font-black mt-1" :class="(dayClose.inventory?.lowStockCount ?? 0) > 0 ? 'text-amber-400' : 'text-slate-400'">
              {{ dayClose.inventory?.lowStockCount ?? 0 }}
            </p>
            <RouterLink to="/finance" class="text-xs text-farm-green hover:underline mt-1 inline-block">
              {{ t('nav.finance') }}
            </RouterLink>
          </div>
        </div>

        <div v-if="dayClose.tomorrowActions.length" class="bg-slate-900 border border-farm-green/20 rounded-2xl p-5">
          <h4 class="font-bold text-farm-green text-sm mb-3">{{ t('today.forTomorrow') }}</h4>
          <ul class="space-y-2">
            <li
              v-for="(action, idx) in dayClose.tomorrowActions"
              :key="idx"
              class="flex items-start gap-2 text-sm text-slate-300"
            >
              <span class="text-farm-green shrink-0">→</span>
              <span>{{ action }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="text-xs text-slate-500 px-1">{{ t('today.noCarryForward') }}</p>
      </template>

      <template v-else-if="dayClose && dayClose.tasks">
        <div
          class="rounded-2xl px-5 py-4 flex items-center gap-3"
          :class="dayClose.status === 'clear'
            ? 'bg-farm-green/10 border border-farm-green/30'
            : 'bg-amber-950/40 border border-amber-700/40'"
        >
          <span class="text-xl">{{ dayClose.status === 'clear' ? '✅' : '⚠️' }}</span>
          <div>
            <p class="font-bold text-sm" :class="dayClose.status === 'clear' ? 'text-farm-green' : 'text-amber-300'">
              {{ dayClose.status === 'clear' ? t('today.dayClear') : t('today.needsAttentionClose') }}
            </p>
            <p class="text-xs text-slate-400 mt-0.5">{{ dayClose.date }}</p>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h4 class="font-bold text-white text-sm mb-3">{{ t('today.tasksToday') }}</h4>
          <div class="grid grid-cols-3 gap-3">
            <div class="text-center">
              <p class="text-2xl font-black text-farm-green">{{ dayClose.tasks.completed }}</p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.completed') }}</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-black" :class="dayClose.tasks.overdue > 0 ? 'text-red-400' : 'text-slate-400'">
                {{ dayClose.tasks.overdue }}
              </p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.lblOverdue') }}</p>
            </div>
            <div class="text-center">
              <p class="text-2xl font-black" :class="dayClose.tasks.pendingApproval > 0 ? 'text-purple-400' : 'text-slate-400'">
                {{ dayClose.tasks.pendingApproval }}
              </p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.forApproval') }}</p>
            </div>
          </div>
        </div>

        <div v-if="dayClose.pendingApprovals?.length" class="bg-slate-900 border border-purple-900/40 rounded-2xl p-5">
          <h4 class="font-bold text-purple-300 text-sm mb-3">
            {{ t('today.awaitingApprovalCount', { count: dayClose.pendingApprovals.length }) }}
          </h4>
          <ul class="space-y-2">
            <li
              v-for="item in dayClose.pendingApprovals"
              :key="item.id"
              class="flex items-start justify-between gap-2 text-sm"
            >
              <div class="min-w-0">
                <p class="font-medium text-white truncate">{{ item.title }}</p>
                <p class="text-xs text-slate-500">{{ item.worker ?? t('today.unassigned') }}{{ item.plot ? ` · ${item.plot}` : '' }}</p>
              </div>
              <RouterLink to="/tasks" class="text-xs text-farm-green shrink-0 hover:underline">{{ t('today.approve') }}</RouterLink>
            </li>
          </ul>
        </div>

        <div v-if="dayClose.overdueTasks?.length" class="bg-slate-900 border border-red-900/40 rounded-2xl p-5">
          <h4 class="font-bold text-red-400 text-sm mb-3">
            {{ t('today.overdueTasksCount', { count: dayClose.overdueTasks.length }) }}
          </h4>
          <ul class="space-y-2">
            <li
              v-for="item in dayClose.overdueTasks.slice(0, 5)"
              :key="item.id"
              class="text-sm"
            >
              <p class="font-medium text-white truncate">{{ item.title }}</p>
              <p class="text-xs text-slate-500">
                {{ item.worker ?? t('today.unassigned') }}{{ item.plot ? ` · ${item.plot}` : '' }}
                <span v-if="item.dueDate"> · {{ t('today.due') }} {{ formatTime(item.dueDate) }}</span>
              </p>
            </li>
          </ul>
          <p v-if="dayClose.overdueTasks.length > 5" class="text-xs text-slate-500 mt-2">
            {{ t('today.more', { count: dayClose.overdueTasks.length - 5 }) }}
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <p class="text-xs text-slate-500 font-medium">{{ t('today.lowStock') }}</p>
            <p class="text-2xl font-black mt-1" :class="(dayClose.inventory?.lowStockCount ?? 0) > 0 ? 'text-amber-400' : 'text-slate-400'">
              {{ dayClose.inventory?.lowStockCount ?? 0 }}
            </p>
            <p class="text-xs text-slate-500 mt-0.5">{{ t('today.movementsToday', { count: dayClose.inventory?.movementsToday ?? 0 }) }}</p>
          </div>
          <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <p class="text-xs text-slate-500 font-medium">{{ t('today.mortality') }}</p>
            <p class="text-2xl font-black mt-1" :class="(dayClose.livestock?.mortalityToday ?? 0) > 0 ? 'text-red-400' : 'text-slate-400'">
              {{ dayClose.livestock?.mortalityToday ?? 0 }}
            </p>
            <p class="text-xs text-slate-500 mt-0.5">{{ t('today.headToday') }}</p>
          </div>
        </div>

        <div v-if="dayClose.finance" class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h4 class="font-bold text-white text-sm mb-1">{{ t('today.expensesToday') }}</h4>
          <p class="text-xl font-black text-white">
            {{ formatCurrency(dayClose.finance.totalExpenses, dayClose.finance.currency) }}
          </p>
          <p class="text-xs text-slate-500 mt-0.5">{{ t('today.expensesLogged', { count: dayClose.finance.expensesToday }) }}</p>
        </div>

        <div v-if="dayClose.tomorrowActions.length" class="bg-slate-900 border border-farm-green/20 rounded-2xl p-5">
          <h4 class="font-bold text-farm-green text-sm mb-3">{{ t('today.forTomorrow') }}</h4>
          <ul class="space-y-2">
            <li
              v-for="(action, idx) in dayClose.tomorrowActions"
              :key="idx"
              class="flex items-start gap-2 text-sm text-slate-300"
            >
              <span class="text-farm-green shrink-0">→</span>
              <span>{{ action }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="text-xs text-slate-500 px-1">{{ t('today.noCarryForward') }}</p>
      </template>
    </div>
  </section>
</template>
