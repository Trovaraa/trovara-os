<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'
type Invoice = { id: string; description: string; amount: number; amountPaid?: number; currency: string; approvalStatus?: string }
const props = defineProps<{ invoices: Invoice[]; disabled?: boolean; reviewImmediately?: boolean }>()
const emit = defineEmits<{ saved: []; busy: [value: boolean]; dirty: [value: boolean] }>()
const { t, locale } = useI18n()
const review = ref<(Invoice & { amountPaid: number; requestId: string })[]>([])
const confirmed = ref(false), busy = ref(false), error = ref('')
const eligible = computed(() => props.invoices.length > 0 && props.invoices.length <= 100 && props.invoices.every(r => r.approvalStatus === 'approved' && r.amount > (r.amountPaid ?? 0)))
const totals = computed(() => review.value.reduce<Record<string, number>>((out, r) => { out[r.currency] = (out[r.currency] ?? 0) + r.amount - r.amountPaid; return out }, {}))
const money = (amount: number, currency: string) => new Intl.NumberFormat(locale.value, { style: 'currency', currency }).format(amount)
function open() {
  if (props.disabled || busy.value || !eligible.value) return
  review.value = props.invoices.map(r => ({ ...r, amountPaid: r.amountPaid ?? 0, requestId: crypto.randomUUID() }))
  confirmed.value = false; error.value = ''; emit('dirty', true)
}
function cancel() { if (!busy.value) { review.value = []; confirmed.value = false; error.value = ''; emit('dirty', false) } }
onMounted(() => { if (props.reviewImmediately) open() })
async function settle() {
  if (props.disabled || busy.value || !confirmed.value || !review.value.length) return
  busy.value = true; emit('busy', true); error.value = ''
  try {
    await api('/api/finance/historical-settlements', { method: 'POST', body: JSON.stringify({ confirmed: true,
      invoices: review.value.map(({ id, amount, amountPaid, currency, requestId }) => ({ id, amount, amountPaid, currency, requestId })),
    }) })
    review.value = []; confirmed.value = false; emit('dirty', false); emit('saved')
  } catch (e) { error.value = e instanceof Error ? e.message : t('financeTracking.failed') }
  finally { busy.value = false; emit('busy', false) }
}
</script>
<template>
  <section class="my-4 rounded-xl border border-slate-600 bg-slate-900 p-4" data-testid="historical-settlement">
    <button v-if="!review.length" type="button" :disabled="disabled || !eligible" class="min-h-11 rounded bg-farm-green px-4 py-2 font-bold text-white disabled:opacity-50" @click="open">{{ t('historicalSettlement.action') }}</button>
    <div v-else>
      <h4 class="font-bold text-white">{{ t('historicalSettlement.review', { count: review.length }) }}</h4>
      <p class="mt-2 text-sm text-slate-300">{{ t('historicalSettlement.explanation') }}</p>
      <ul class="my-3 max-h-56 space-y-2 overflow-auto text-slate-200"><li v-for="invoice in review" :key="invoice.id">{{ invoice.description }} · {{ money(invoice.amount - invoice.amountPaid, invoice.currency) }}</li></ul>
      <p v-for="(total, currency) in totals" :key="currency" class="font-bold text-white">{{ t('historicalSettlement.total') }}: {{ money(total, currency) }}</p>
      <label class="my-4 flex items-start gap-3 text-slate-200"><input v-model="confirmed" type="checkbox" :disabled="busy" class="mt-1" />{{ t('historicalSettlement.confirmation') }}</label>
      <p v-if="error" role="alert" class="my-3 text-red-300">{{ error }}</p>
      <div class="flex flex-wrap gap-3">
        <button type="button" :disabled="busy || disabled || !confirmed" class="min-h-11 rounded bg-farm-green px-4 py-2 font-bold text-white disabled:opacity-50" @click="settle">{{ t('historicalSettlement.confirm') }}</button>
        <button type="button" :disabled="busy" class="min-h-11 rounded border border-slate-600 px-4 py-2 text-slate-200" @click="cancel">{{ t('finance.cancel') }}</button>
      </div>
    </div>
  </section>
</template>
