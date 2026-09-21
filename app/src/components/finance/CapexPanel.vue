<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'
const { t, locale } = useI18n()
type Asset = { id: string; name: string; assetTag: string | null; quantityOwned: number; acquisitionCostMinor: number | null; currency: string | null; operationalStatus: string; active: boolean }
type Expense = { id: string; description: string; amount: number; currency: string; entityCode: string; approvalStatus: string; paymentStatus: string }
const data = ref<{ assets: Asset[]; expenses: Expense[] }>({ assets: [], expenses: [] })
const error = ref(''); const loading = ref(true); const query = ref('')
const matches = (value: string) => value.toLowerCase().includes(query.value.toLowerCase())
const assets = computed(() => data.value.assets.filter(row => matches(`${row.name} ${row.assetTag ?? ''}`)))
const expenses = computed(() => data.value.expenses.filter(row => matches(row.description)))
function money(value: number, currency: string | null) { return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency || 'NGN' }).format(value) }
onMounted(async () => {
  try { data.value = await api('/api/finance/capex') }
  catch (e) { error.value = e instanceof Error ? e.message : t('financeTracking.failed') }
  finally { loading.value = false }
})
</script>
<template>
  <section id="finance-capex-panel" role="tabpanel" aria-labelledby="finance-capex-tab" class="mt-6 space-y-5">
    <h2 class="text-xl font-bold text-white">{{ t('financeTracking.capex') }}</h2>
    <p class="text-sm text-slate-400">{{ t('financeTracking.capexHint') }}</p>
    <p v-if="error" role="alert" class="text-red-300">{{ error }}</p>
    <p v-else-if="loading" role="status">{{ t('finance.loading') }}</p>
    <template v-else>
      <label class="block text-slate-300">{{ t('financeTracking.search') }}<input v-model="query" type="search" class="ml-3 rounded bg-slate-800 p-2 text-white" /></label>
      <h3 class="font-bold text-white">{{ t('financeTracking.assets') }} ({{ assets.length }})</h3>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><article v-for="asset in assets" :key="asset.id" class="rounded-xl border border-slate-800 p-4 text-slate-300">
        <h4 class="font-bold text-white">{{ asset.name }}</h4><p>{{ asset.assetTag ?? '—' }} · {{ asset.operationalStatus }}</p>
        <p>{{ t('financeTracking.quantity') }}: {{ asset.quantityOwned }}</p>
        <p>{{ t('financeTracking.acquisitionCost') }}: {{ asset.acquisitionCostMinor == null ? '—' : money(asset.acquisitionCostMinor / 100, asset.currency) }}</p>
        <p v-if="!asset.active" class="text-amber-300">{{ t('financeTracking.inactive') }}</p>
      </article></div>
      <p v-if="!assets.length" class="text-slate-400">{{ t('financeTracking.noAssets') }}</p>
      <h3 class="font-bold text-white">{{ t('financeTracking.capexExpenses') }} ({{ expenses.length }})</h3>
      <article v-for="expense in expenses" :key="expense.id" class="rounded-xl border border-slate-800 p-4 text-slate-300">
        <h4 class="font-bold text-white">{{ expense.description }}</h4>
        <p>{{ expense.entityCode }} · {{ money(expense.amount, expense.currency) }} · {{ t(`finance.status.${expense.approvalStatus}`) }} · {{ t(`financeTracking.${expense.paymentStatus}`) }}</p>
      </article>
      <p v-if="!expenses.length" class="text-slate-400">{{ t('financeTracking.noCapex') }}</p>
    </template>
  </section>
</template>
