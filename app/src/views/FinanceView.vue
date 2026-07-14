<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type Expense = {
  id: string
  category: string
  description: string
  amount: number
  currency: string
  expenseDate: string
  vendor?: string | null
  receiptRef?: string | null
}

type Summary = {
  generatedAt: string
  currency: string
  revenue: number
  deliveredRevenue: number
  totalExpenses: number
  netProfit: number
  orderCount: number
  expenseCount: number
  expensesByCategory: Record<string, number>
}

const expenses = ref<Expense[]>([])
const summary = ref<Summary | null>(null)
const loading = ref(true)

function formatAmount(amount: number, currency = 'NGN') {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(amount)
}

onMounted(async () => {
  try {
    const [expenseData, summaryData] = await Promise.all([
      api<{ expenses: Expense[] }>('/api/finance'),
      api<{ summary: Summary }>('/api/finance/summary'),
    ])
    expenses.value = expenseData.expenses
    summary.value = summaryData.summary
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Finance</h2>
      <p class="text-slate-400 text-sm mt-1">Expenses and P&amp;L snapshot — owner only</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">Loading finance data…</div>

    <template v-else>
      <div v-if="summary" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">Revenue</p>
          <p class="text-2xl font-black text-farm-green mt-1">
            {{ formatAmount(summary.revenue, summary.currency) }}
          </p>
          <p class="text-xs text-slate-600 mt-2">{{ summary.orderCount }} active orders</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">Delivered revenue</p>
          <p class="text-2xl font-black text-blue-400 mt-1">
            {{ formatAmount(summary.deliveredRevenue, summary.currency) }}
          </p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">Total expenses</p>
          <p class="text-2xl font-black text-red-400 mt-1">
            {{ formatAmount(summary.totalExpenses, summary.currency) }}
          </p>
          <p class="text-xs text-slate-600 mt-2">{{ summary.expenseCount }} entries</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">Net profit</p>
          <p
            class="text-2xl font-black mt-1"
            :class="summary.netProfit >= 0 ? 'text-farm-gold' : 'text-red-400'"
          >
            {{ formatAmount(summary.netProfit, summary.currency) }}
          </p>
        </div>
      </div>

      <div v-if="summary && Object.keys(summary.expensesByCategory).length" class="mt-6">
        <div class="flex flex-wrap gap-3">
          <span
            v-for="(amount, category) in summary.expensesByCategory"
            :key="category"
            class="text-xs bg-slate-800 px-3 py-1.5 rounded-lg text-slate-300 capitalize"
          >
            {{ category }}: {{ formatAmount(amount, summary.currency) }}
          </span>
        </div>
      </div>

      <div class="mt-8 overflow-x-auto">
        <h3 class="font-bold text-white mb-4">Expenses</h3>
        <table v-if="expenses.length" class="w-full text-sm">
          <thead>
            <tr class="text-left text-slate-500 border-b border-slate-800">
              <th class="pb-3 font-semibold">Date</th>
              <th class="pb-3 font-semibold">Category</th>
              <th class="pb-3 font-semibold">Description</th>
              <th class="pb-3 font-semibold">Vendor</th>
              <th class="pb-3 font-semibold">Receipt ref</th>
              <th class="pb-3 font-semibold text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="expense in expenses"
              :key="expense.id"
              class="border-b border-slate-800/50"
            >
              <td class="py-4 text-slate-400">
                {{ new Date(expense.expenseDate).toLocaleDateString() }}
              </td>
              <td class="py-4 text-slate-300 capitalize">{{ expense.category }}</td>
              <td class="py-4 text-white">{{ expense.description }}</td>
              <td class="py-4 text-slate-400">{{ expense.vendor ?? '—' }}</td>
              <td class="py-4 text-slate-400 font-mono text-xs">{{ expense.receiptRef ?? '—' }}</td>
              <td class="py-4 font-mono text-red-300 text-right">
                {{ formatAmount(expense.amount, expense.currency) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="text-slate-500 text-sm">No expenses recorded.</p>
      </div>
    </template>
  </AppLayout>
</template>
