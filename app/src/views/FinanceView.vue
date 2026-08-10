<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

type ExpenseLabel = { id: string; name: string; slug: string }

type Expense = {
  id: string
  category: string
  description: string
  amount: number
  currency: string
  expenseDate: string
  vendor?: string | null
  receiptRef?: string | null
  approvalStatus?: string
  source?: string
  labels?: ExpenseLabel[]
  hasAttachment?: boolean
  extractionMethod?: string | null
  extractionStatus?: string | null
}

type Summary = {
  generatedAt: string
  currency: string
  revenue: number
  deliveredRevenue: number
  paidRevenue?: number
  outstandingInvoices?: number
  refunds?: number
  refundsPending?: number
  invoiceCount?: number
  totalExpenses: number
  netProfit: number
  orderCount: number
  expenseCount: number
  expensesByCategory: Record<string, number>
  expensesByLabel?: Record<string, { name: string; slug: string; total: number }>
}

const CATEGORIES = [
  'inputs',
  'labour',
  'equipment',
  'transport',
  'utilities',
  'feed',
  'medicine',
  'other',
] as const

const expenses = ref<Expense[]>([])
const labels = ref<ExpenseLabel[]>([])
const summary = ref<Summary | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const labelFilter = ref('')
const editingId = ref<string | null>(null)
const showForm = ref(false)
const retryingExtractionIds = ref<Set<string>>(new Set())

const form = ref({
  category: 'other' as (typeof CATEGORIES)[number],
  description: '',
  amount: '',
  vendor: '',
  receiptRef: '',
  expenseDate: new Date().toISOString().slice(0, 10),
  labelIds: [] as string[],
  approvalStatus: 'approved' as 'pending' | 'approved' | 'rejected',
})

const canWrite = computed(() => auth.user?.role === 'owner' || auth.user?.role === 'sales')
const canRetryExtraction = computed(
  () => auth.user?.role === 'owner' || auth.user?.role === 'supervisor',
)
const hasExpenseActions = computed(() => canWrite.value || canRetryExtraction.value)

function formatAmount(amount: number, currency = 'NGN') {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(amount)
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString()
}

function statusClasses(status?: string) {
  if (status === 'pending') return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
  if (status === 'rejected') return 'border-red-500/30 bg-red-500/10 text-red-300'
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
}

function statusLabel(status?: string) {
  const normalized = status === 'pending' || status === 'rejected' ? status : 'approved'
  return t(`finance.status.${normalized}`)
}

function isInboundAttachment(expense: Expense) {
  return expense.source === 'inbound_email' && expense.hasAttachment
}

function extractionStatusLabel(status?: string | null) {
  const normalized = status === 'success' || status === 'failed' ? status : 'unknown'
  return t(`finance.extractionStatus.${normalized}`)
}

function extractionMethodLabel(method?: string | null) {
  const normalized = ['heuristic', 'pdf_text', 'llm_text', 'llm_vision', 'none'].includes(method ?? '')
    ? method
    : 'none'
  return t(`finance.extractionMethod.${normalized}`)
}

async function retryExtraction(expense: Expense) {
  if (!canRetryExtraction.value || !isInboundAttachment(expense)) return
  retryingExtractionIds.value = new Set(retryingExtractionIds.value).add(expense.id)
  error.value = null
  try {
    await api(`/api/finance/${expense.id}/retry-extraction`, { method: 'POST' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('finance.retryExtractionFailed')
  } finally {
    const next = new Set(retryingExtractionIds.value)
    next.delete(expense.id)
    retryingExtractionIds.value = next
  }
}

function resetForm() {
  editingId.value = null
  form.value = {
    category: 'other',
    description: '',
    amount: '',
    vendor: '',
    receiptRef: '',
    expenseDate: new Date().toISOString().slice(0, 10),
    labelIds: [],
    approvalStatus: 'approved',
  }
}

function startCreate() {
  resetForm()
  showForm.value = true
}

function startEdit(expense: Expense) {
  editingId.value = expense.id
  showForm.value = true
  form.value = {
    category: (CATEGORIES.includes(expense.category as (typeof CATEGORIES)[number])
      ? expense.category
      : 'other') as (typeof CATEGORIES)[number],
    description: expense.description,
    amount: String(expense.amount),
    vendor: expense.vendor ?? '',
    receiptRef: expense.receiptRef ?? '',
    expenseDate: new Date(expense.expenseDate).toISOString().slice(0, 10),
    labelIds: (expense.labels ?? []).map((label) => label.id),
    approvalStatus: (expense.approvalStatus as 'pending' | 'approved' | 'rejected') ?? 'approved',
  }
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const query = labelFilter.value ? `?labelId=${encodeURIComponent(labelFilter.value)}` : ''
    const [expenseData, summaryData, labelData] = await Promise.all([
      api<{ expenses: Expense[] }>(`/api/finance${query}`),
      api<{ summary: Summary }>(`/api/finance/summary${query}`),
      api<{ labels: ExpenseLabel[] }>('/api/finance/labels'),
    ])
    expenses.value = expenseData.expenses
    summary.value = summaryData.summary
    labels.value = labelData.labels
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('finance.loadFailed')
  } finally {
    loading.value = false
  }
}

async function saveExpense() {
  if (!canWrite.value) return
  saving.value = true
  error.value = null
  try {
    const amount = Math.round(Number(form.value.amount))
    if (!Number.isFinite(amount) || amount < 0) throw new Error(t('finance.invalidAmount'))
    const payload = {
      category: form.value.category,
      description: form.value.description.trim(),
      amount,
      vendor: form.value.vendor.trim() || null,
      receiptRef: form.value.receiptRef.trim() || null,
      expenseDate: new Date(`${form.value.expenseDate}T12:00:00.000Z`).toISOString(),
      labelIds: form.value.labelIds,
      approvalStatus: form.value.approvalStatus,
    }
    if (editingId.value) {
      await api(`/api/finance/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      await api('/api/finance', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    }
    showForm.value = false
    resetForm()
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('finance.saveFailed')
  } finally {
    saving.value = false
  }
}

function toggleLabel(id: string) {
  const set = new Set(form.value.labelIds)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  form.value.labelIds = [...set]
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('finance.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('finance.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="labelFilter"
          class="rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200"
          @change="load"
        >
          <option value="">{{ t('finance.allLabels') }}</option>
          <option v-for="label in labels" :key="label.id" :value="label.id">{{ label.name }}</option>
        </select>
        <button
          v-if="canWrite"
          type="button"
          class="rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white"
          @click="startCreate"
        >
          {{ t('finance.addExpense') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-400">{{ error }}</p>
    <div v-if="loading" class="mt-8 text-slate-400">{{ t('finance.loading') }}</div>

    <template v-else>
      <div
        v-if="showForm && canWrite"
        class="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4"
      >
        <h3 class="font-bold text-white">
          {{ editingId ? t('finance.editExpense') : t('finance.addExpense') }}
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('finance.category') }}</span>
            <select v-model="form.category" class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100">
              <option v-for="category in CATEGORIES" :key="category" :value="category">{{ category }}</option>
            </select>
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('finance.amount') }}</span>
            <input
              v-model="form.amount"
              type="number"
              min="0"
              step="1"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
          <label class="text-sm text-slate-400 space-y-1 md:col-span-2">
            <span>{{ t('finance.description') }}</span>
            <input
              v-model="form.description"
              type="text"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('finance.vendor') }}</span>
            <input
              v-model="form.vendor"
              type="text"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('finance.date') }}</span>
            <input
              v-model="form.expenseDate"
              type="date"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('finance.receiptRef') }}</span>
            <input
              v-model="form.receiptRef"
              type="text"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </label>
          <label class="text-sm text-slate-400 space-y-1">
            <span>{{ t('finance.approvalStatus') }}</span>
            <select
              v-model="form.approvalStatus"
              class="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100"
            >
              <option value="pending">pending</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
        </div>
        <div>
          <p class="text-sm text-slate-400 mb-2">{{ t('finance.labels') }}</p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="label in labels"
              :key="label.id"
              type="button"
              class="rounded-lg px-3 py-1.5 text-xs font-semibold border"
              :class="
                form.labelIds.includes(label.id)
                  ? 'bg-farm-green/20 border-farm-green text-farm-green'
                  : 'bg-slate-950 border-slate-700 text-slate-300'
              "
              @click="toggleLabel(label.id)"
            >
              {{ label.name }}
            </button>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            :disabled="saving || !form.description.trim()"
            @click="saveExpense"
          >
            {{ t('finance.save') }}
          </button>
          <button
            type="button"
            class="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300"
            @click="showForm = false; resetForm()"
          >
            {{ t('finance.cancel') }}
          </button>
        </div>
      </div>

      <div v-if="summary" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.revenue') }}</p>
          <p class="text-2xl font-black text-farm-green mt-1">
            {{ formatAmount(summary.revenue, summary.currency) }}
          </p>
          <p class="text-xs text-slate-600 mt-2">{{ t('finance.activeOrders', { count: summary.orderCount }) }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.deliveredRevenue') }}</p>
          <p class="text-2xl font-black text-blue-400 mt-1">
            {{ formatAmount(summary.deliveredRevenue, summary.currency) }}
          </p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.totalExpenses') }}</p>
          <p class="text-2xl font-black text-red-400 mt-1">
            {{ formatAmount(summary.totalExpenses, summary.currency) }}
          </p>
          <p class="text-xs text-slate-600 mt-2">{{ t('finance.entries', { count: summary.expenseCount }) }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.netProfit') }}</p>
          <p
            class="text-2xl font-black mt-1"
            :class="summary.netProfit >= 0 ? 'text-farm-gold' : 'text-red-400'"
          >
            {{ formatAmount(summary.netProfit, summary.currency) }}
          </p>
        </div>
      </div>

      <div
        v-if="summary"
        class="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4"
      >
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.paidRevenue') }}</p>
          <p class="text-xl font-black text-emerald-400 mt-1">
            {{ formatAmount(summary.paidRevenue ?? 0, summary.currency) }}
          </p>
          <p class="text-xs text-slate-600 mt-2">
            {{ t('finance.invoiceCount', { count: summary.invoiceCount ?? 0 }) }}
          </p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.outstandingInvoices') }}</p>
          <p class="text-xl font-black text-amber-300 mt-1">
            {{ formatAmount(summary.outstandingInvoices ?? 0, summary.currency) }}
          </p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.refunds') }}</p>
          <p class="text-xl font-black text-orange-300 mt-1">
            {{ formatAmount(summary.refunds ?? 0, summary.currency) }}
          </p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('finance.refundsPending') }}</p>
          <p class="text-xl font-black text-orange-200 mt-1">
            {{ formatAmount(summary.refundsPending ?? 0, summary.currency) }}
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

      <div
        v-if="summary?.expensesByLabel && Object.keys(summary.expensesByLabel).length"
        class="mt-3 flex flex-wrap gap-3"
      >
        <span
          v-for="(row, labelId) in summary.expensesByLabel"
          :key="labelId"
          class="text-xs bg-slate-800/80 px-3 py-1.5 rounded-lg text-farm-gold"
        >
          {{ row.name }}: {{ formatAmount(row.total, summary.currency) }}
        </span>
      </div>

      <section class="mt-8" aria-labelledby="expenses-heading">
        <h3 id="expenses-heading" class="font-bold text-white mb-4">{{ t('finance.expenses') }}</h3>

        <div v-if="expenses.length" class="space-y-3 md:hidden" data-testid="expense-cards">
          <article
            v-for="expense in expenses"
            :key="expense.id"
            class="rounded-2xl border border-slate-800 bg-slate-900/80 p-4"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {{ formatDate(expense.expenseDate) }} · {{ expense.category }}
                </p>
                <h4 class="mt-1 break-words font-bold text-white">{{ expense.description }}</h4>
              </div>
              <p class="shrink-0 font-mono text-sm font-bold text-red-300">
                {{ formatAmount(expense.amount, expense.currency) }}
              </p>
            </div>

            <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt class="text-xs text-slate-500">{{ t('finance.vendor') }}</dt>
                <dd class="mt-1 break-words text-slate-300">{{ expense.vendor ?? '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-slate-500">{{ t('finance.approvalStatus') }}</dt>
                <dd class="mt-1">
                  <span
                    class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold"
                    :class="statusClasses(expense.approvalStatus)"
                  >
                    {{ statusLabel(expense.approvalStatus) }}
                  </span>
                </dd>
              </div>
              <div v-if="isInboundAttachment(expense)" class="col-span-2">
                <dt class="text-xs text-slate-500">{{ t('finance.extraction') }}</dt>
                <dd class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span class="font-semibold text-slate-300">
                    {{ extractionStatusLabel(expense.extractionStatus) }}
                  </span>
                  <span class="text-slate-500">
                    {{ extractionMethodLabel(expense.extractionMethod) }}
                  </span>
                </dd>
              </div>
              <div class="col-span-2">
                <dt class="text-xs text-slate-500">{{ t('finance.labels') }}</dt>
                <dd class="mt-1 flex flex-wrap gap-1.5">
                  <span v-if="!(expense.labels ?? []).length" class="text-slate-500">—</span>
                  <span
                    v-for="label in expense.labels ?? []"
                    :key="label.id"
                    class="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
                  >
                    {{ label.name }}
                  </span>
                </dd>
              </div>
            </dl>

            <div
              v-if="expense.hasAttachment || hasExpenseActions"
              class="mt-4 flex items-center justify-end gap-3 border-t border-slate-800 pt-3"
            >
              <a
                v-if="expense.hasAttachment"
                :href="`/api/finance/${expense.id}/attachment`"
                target="_blank"
                rel="noopener"
                class="min-h-9 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-farm-green"
              >
                {{ t('finance.attachment') }}
              </a>
              <button
                v-if="canRetryExtraction && isInboundAttachment(expense) && expense.approvalStatus === 'pending'"
                type="button"
                class="min-h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-300 disabled:opacity-50"
                :disabled="retryingExtractionIds.has(expense.id)"
                @click="retryExtraction(expense)"
              >
                {{ retryingExtractionIds.has(expense.id) ? t('finance.retryingExtraction') : t('finance.retryExtraction') }}
              </button>
              <button
                v-if="canWrite"
                type="button"
                class="min-h-9 rounded-lg bg-farm-green/15 px-3 py-2 text-xs font-bold text-farm-green"
                @click="startEdit(expense)"
              >
                {{ t('finance.edit') }}
              </button>
            </div>
          </article>
        </div>

        <div v-if="expenses.length" class="hidden overflow-x-auto rounded-2xl border border-slate-800 md:block">
        <table class="w-full min-w-[78rem] table-auto text-sm" data-testid="expense-table">
          <thead>
            <tr class="border-b border-slate-800 bg-slate-900/70 text-left text-slate-500">
              <th class="whitespace-nowrap px-4 py-3 font-semibold">{{ t('finance.date') }}</th>
              <th class="whitespace-nowrap px-4 py-3 font-semibold">{{ t('finance.category') }}</th>
              <th class="min-w-64 px-4 py-3 font-semibold">{{ t('finance.description') }}</th>
              <th class="min-w-40 px-4 py-3 font-semibold">{{ t('finance.labels') }}</th>
              <th class="min-w-36 px-4 py-3 font-semibold">{{ t('finance.vendor') }}</th>
              <th class="whitespace-nowrap px-4 py-3 font-semibold">{{ t('finance.approvalStatus') }}</th>
              <th class="min-w-40 px-4 py-3 font-semibold">{{ t('finance.extraction') }}</th>
              <th class="whitespace-nowrap px-4 py-3 text-right font-semibold">{{ t('finance.amount') }}</th>
              <th v-if="hasExpenseActions" class="whitespace-nowrap px-4 py-3 text-right font-semibold">{{ t('finance.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="expense in expenses"
              :key="expense.id"
              class="border-b border-slate-800/50"
            >
              <td class="whitespace-nowrap px-4 py-4 text-slate-400">
                {{ formatDate(expense.expenseDate) }}
              </td>
              <td class="whitespace-nowrap px-4 py-4 text-slate-300 capitalize">{{ expense.category }}</td>
              <td class="px-4 py-4 text-white">
                {{ expense.description }}
                <a
                  v-if="expense.hasAttachment"
                  :href="`/api/finance/${expense.id}/attachment`"
                  target="_blank"
                  rel="noopener"
                  class="ml-2 text-xs text-farm-green hover:underline"
                >
                  {{ t('finance.attachment') }}
                </a>
              </td>
              <td class="px-4 py-4 text-slate-400">
                <span v-if="!(expense.labels ?? []).length">-</span>
                <span
                  v-for="label in expense.labels ?? []"
                  :key="label.id"
                  class="inline-block mr-1 mb-1 text-[11px] bg-slate-800 px-2 py-0.5 rounded"
                >
                  {{ label.name }}
                </span>
              </td>
              <td class="px-4 py-4 text-slate-400">{{ expense.vendor ?? '—' }}</td>
              <td class="px-4 py-4">
                <span
                  class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold"
                  :class="statusClasses(expense.approvalStatus)"
                >
                  {{ statusLabel(expense.approvalStatus) }}
                </span>
              </td>
              <td class="px-4 py-4 text-xs">
                <div v-if="isInboundAttachment(expense)">
                  <p class="font-semibold text-slate-300">{{ extractionStatusLabel(expense.extractionStatus) }}</p>
                  <p class="mt-0.5 text-slate-500">{{ extractionMethodLabel(expense.extractionMethod) }}</p>
                </div>
                <span v-else class="text-slate-600">—</span>
              </td>
              <td class="whitespace-nowrap px-4 py-4 font-mono text-red-300 text-right">
                {{ formatAmount(expense.amount, expense.currency) }}
              </td>
              <td v-if="hasExpenseActions" class="whitespace-nowrap px-4 py-4 text-right">
                <button
                  v-if="canRetryExtraction && isInboundAttachment(expense) && expense.approvalStatus === 'pending'"
                  type="button"
                  class="mr-3 text-xs text-amber-300 hover:underline disabled:opacity-50"
                  :disabled="retryingExtractionIds.has(expense.id)"
                  @click="retryExtraction(expense)"
                >
                  {{ retryingExtractionIds.has(expense.id) ? t('finance.retryingExtraction') : t('finance.retryExtraction') }}
                </button>
                <button v-if="canWrite" type="button" class="text-xs text-farm-green hover:underline" @click="startEdit(expense)">
                  {{ t('finance.edit') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p v-else class="text-slate-500 text-sm">{{ t('finance.noExpenses') }}</p>
      </section>
    </template>
  </AppLayout>
</template>
