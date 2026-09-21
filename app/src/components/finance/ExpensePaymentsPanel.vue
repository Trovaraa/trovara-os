<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'
const props = defineProps<{ expense: { id: string; description: string; amount: number; currency: string; amountPaid?: number; paymentStatus?: string; approvalStatus?: string; paymentDueDate?: string | null }; canWrite: boolean }>()
const emit = defineEmits<{ saved: []; busy: [value: boolean]; dirty: [value: boolean] }>()
const { t, locale } = useI18n()
type Payment = { id: string; amount: number; currency: string; paidOn: string; reference: string }
const payments = ref<Payment[]>([])
const dueDate = ref(props.expense.paymentDueDate ?? '')
const amount = ref('')
const paidOn = ref(new Date().toISOString().slice(0, 10))
const reference = ref('')
const requestId = ref(crypto.randomUUID())
const busy = ref(false)
const error = ref('')
const historyLoading = ref(true)
const historyFailed = ref(false)
watch(busy, value => emit('busy', value))
watch(() => props.expense.paymentDueDate, value => { dueDate.value = value ?? '' })
watch(() => [dueDate.value, props.expense.paymentDueDate, amount.value, reference.value], () => {
  emit('dirty', dueDate.value !== (props.expense.paymentDueDate ?? '') || !!amount.value || !!reference.value)
})
const balance = computed(() => props.expense.amount - (props.expense.amountPaid ?? 0))
const money = (value: number, currency = props.expense.currency) => new Intl.NumberFormat(locale.value, { style: 'currency', currency }).format(value)
async function load() {
  historyLoading.value = true; historyFailed.value = false; error.value = ''
  try { payments.value = (await api<{ payments: Payment[] }>(`/api/finance/${props.expense.id}/payments`)).payments }
  catch (e) { historyFailed.value = true; error.value = e instanceof Error ? e.message : t('financeTracking.failed') }
  finally { historyLoading.value = false }
}
async function saveDueDate() {
  if (!props.canWrite || busy.value || !dueDate.value) return
  busy.value = true; error.value = ''
  try {
    await api(`/api/finance/${props.expense.id}`, { method: 'PATCH', body: JSON.stringify({ paymentDueDate: dueDate.value }) })
    emit('saved')
  } catch (e) { error.value = e instanceof Error ? e.message : t('financeTracking.failed') }
  finally { busy.value = false }
}
async function record() {
  if (busy.value || !props.canWrite || props.expense.approvalStatus !== 'approved' || !props.expense.paymentDueDate || dueDate.value !== props.expense.paymentDueDate || balance.value <= 0) return
  busy.value = true; error.value = ''
  try {
    await api(`/api/finance/${props.expense.id}/payments`, { method: 'POST', body: JSON.stringify({
      amount: Number(amount.value), currency: props.expense.currency, paidOn: paidOn.value, reference: reference.value, requestId: requestId.value,
    }) })
    requestId.value = crypto.randomUUID(); amount.value = ''; reference.value = ''
    await load(); emit('saved')
  } catch (e) { error.value = e instanceof Error ? e.message : t('financeTracking.failed') }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <section class="my-5 rounded-2xl border border-slate-700 bg-slate-900 p-5" data-testid="expense-payments-panel">
    <h3 class="font-bold text-white">{{ t('financeTracking.payments') }}</h3>
    <p class="mt-2 text-slate-300">{{ t('financeTracking.paymentStatus') }}: {{ t(`financeTracking.${expense.paymentStatus ?? 'unpaid'}`) }} · {{ t('financeTracking.balance') }}: {{ money(balance) }}</p>
    <p class="mt-2 text-sm text-slate-400">{{ t('financeTracking.recordOnly') }}</p>
    <p v-if="!expense.paymentDueDate" class="mt-2 text-amber-300">{{ t('financeTracking.reviewDue') }}</p>
    <p v-else class="mt-2 text-slate-300">{{ t('financeTracking.dueDate') }}: {{ expense.paymentDueDate }}</p>
    <p v-if="error" role="alert" class="mt-3 text-red-300">{{ error }}</p>
    <form v-if="canWrite" class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="saveDueDate">
      <label class="text-slate-300">{{ t('financeTracking.dueDate') }}<input v-model="dueDate" required type="date" class="ml-2 rounded bg-slate-800 p-2 text-white" /></label>
      <button :disabled="busy" class="rounded bg-slate-700 p-2 text-white">{{ t('financeTracking.saveDue') }}</button>
    </form>
    <p v-if="expense.approvalStatus !== 'approved'" class="mt-4 text-amber-300">{{ t('financeTracking.approvalRequired') }}</p>
    <form v-if="canWrite && expense.approvalStatus === 'approved' && balance > 0" class="mt-5 grid gap-3 sm:grid-cols-3" @submit.prevent="record">
      <label class="text-slate-300">{{ t('finance.amount') }} ({{ expense.currency }})<input v-model="amount" required type="number" min="1" :max="balance" step="1" class="mt-1 w-full rounded bg-slate-800 p-2 text-white" /></label>
      <label class="text-slate-300">{{ t('financeTracking.paidOn') }}<input v-model="paidOn" required type="date" :max="new Date().toISOString().slice(0, 10)" class="mt-1 w-full rounded bg-slate-800 p-2 text-white" /></label>
      <label class="text-slate-300">{{ t('financeTracking.reference') }}<input v-model="reference" required maxlength="200" class="mt-1 w-full rounded bg-slate-800 p-2 text-white" /></label>
      <button :disabled="busy || !expense.paymentDueDate || dueDate !== expense.paymentDueDate" class="rounded bg-farm-green p-3 font-bold text-white disabled:opacity-50">{{ t('financeTracking.recordPayment') }}</button>
    </form>
    <h4 class="mt-5 font-bold text-white">{{ t('financeTracking.history') }}</h4>
    <p v-if="historyLoading" role="status" class="mt-3 text-slate-400">{{ t('finance.loading') }}</p>
    <button v-else-if="historyFailed" type="button" class="mt-3 rounded border border-slate-600 p-2 text-slate-200" @click="load">{{ t('financeTracking.retryHistory') }}</button>
    <ul v-else class="mt-3 space-y-2"><li v-for="payment in payments" :key="payment.id" class="break-words rounded bg-slate-800 p-3 text-slate-200">{{ payment.paidOn }} · {{ money(payment.amount, payment.currency) }} · {{ payment.reference }}</li></ul>
    <p v-if="!historyLoading && !historyFailed && !payments.length" class="mt-4 text-sm text-slate-400">{{ t('financeTracking.noPayments') }}</p>
  </section>
</template>
