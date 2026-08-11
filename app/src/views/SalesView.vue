<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useAuthStore } from '@/stores/auth'
import { api, resolveApiUrl } from '@/lib/api'

const { t, te } = useI18n()

function statusLabel(status: string): string {
  const key = `sales.status.${status}`
  return te(key) ? t(key) : status
}

function paymentStatusLabel(status: string): string {
  const key = `sales.paymentStatus.${status}`
  return te(key) ? t(key) : status.replaceAll('_', ' ')
}

type OrderItem = {
  productName: string
  unit: string
  quantity: number
  unitPriceKobo: number
  lineTotalKobo: number
}

type Order = {
  id: string
  customerName: string
  customerPhone?: string
  status: string
  paymentStatus?: string
  totalAmount: number
  currency: string
  lotId?: string
  lotCode?: string
  source?: string
  customerContactId?: string | null
  reference?: string
  items?: OrderItem[]
  notes?: string
  dispatchedAt?: string
  deliveryPhotoUrl?: string | null
  customerFeedback?: string | null
  customerFeedbackAt?: string | null
  cancelledBy?: string | null
  refundRequestedAt?: string | null
  hasInvoice?: boolean
  createdAt: string
}

type CustomerProfile = {
  contact: {
    id: string
    channel: string
    externalId: string
    name?: string | null
    phone?: string | null
    firstSeen: string
    lastSeen: string
  }
  stats: {
    orderCount: number
    inquiryCount: number
    lifetimeValue: number
    currency: string
  }
  orders: Order[]
}

const sourceLabel: Record<string, string> = {
  staff: 'sales.sourceStaff',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
}

function sourceText(source: string): string {
  const label = sourceLabel[source]
  if (!label) return source
  return te(label) ? t(label) : label
}

const sourceColor: Record<string, string> = {
  telegram: 'bg-sky-900/50 text-sky-300',
  whatsapp: 'bg-emerald-900/50 text-emerald-300',
  staff: 'bg-slate-700 text-slate-300',
}

const auth = useAuthStore()
const orders = ref<Order[]>([])
const loading = ref(true)
const actionBusy = ref<string | null>(null)
const actionMessage = ref<string | null>(null)

function displayCustomerName(order: Order): string {
  if (order.customerName === '[redacted]') return 'Customer'
  return order.customerName
}

const statusColor: Record<string, string> = {
  pending: 'bg-amber-900/40 text-amber-300',
  confirmed: 'bg-blue-900/50 text-blue-300',
  dispatched: 'bg-purple-900/50 text-purple-300',
  delivered: 'bg-farm-green/20 text-farm-green',
  cancelled: 'bg-red-900/50 text-red-300',
}

const paymentStatusColor: Record<string, string> = {
  unpaid: 'bg-amber-900/50 text-amber-200',
  paid: 'bg-farm-green/20 text-farm-green',
  not_required: 'bg-slate-700/80 text-slate-400',
  refunded: 'bg-slate-700 text-slate-300',
  partially_refunded: 'bg-orange-900/40 text-orange-300',
  refund_pending: 'bg-orange-900/50 text-orange-200',
}

const nextStatus: Record<string, { status: string; labelKey: string }> = {
  pending: { status: 'confirmed', labelKey: 'sales.confirm' },
  confirmed: { status: 'dispatched', labelKey: 'sales.dispatch' },
  dispatched: { status: 'delivered', labelKey: 'sales.markDelivered' },
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(amount)
}

function isUnpaid(order: Order): boolean {
  return order.paymentStatus === 'unpaid'
}

function blocksFulfillment(order: Order, next: string): boolean {
  return isUnpaid(order) && (next === 'dispatched' || next === 'delivered')
}

function canRefund(order: Order): boolean {
  const ps = order.paymentStatus
  return ps === 'paid' || ps === 'refund_pending' || ps === 'partially_refunded'
}

function canResendPayLink(order: Order): boolean {
  return order.paymentStatus === 'unpaid'
}

async function load() {
  loading.value = true
  try {
    const data = await api<{ orders: Order[] }>('/api/sales')
    orders.value = data.orders
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function updateStatus(id: string, status: string) {
  actionMessage.value = null
  try {
    await api(`/api/sales/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
    await load()
  } catch (err) {
    actionMessage.value = err instanceof Error ? err.message : 'Update failed'
  }
}

async function cancelOrder(id: string) {
  await api(`/api/sales/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled' }),
  })
  await load()
}

async function resendPayLink(order: Order) {
  actionBusy.value = `pay-${order.id}`
  actionMessage.value = null
  try {
    const data = await api<{ authorizationUrl: string; reused?: boolean }>(
      `/api/sales/${order.id}/resend-pay-link`,
      { method: 'POST', body: '{}' },
    )
    try {
      await navigator.clipboard.writeText(data.authorizationUrl)
      actionMessage.value = `${t('sales.payLinkCopied')}: ${data.authorizationUrl}`
    } catch {
      actionMessage.value = `${t('sales.payLink')}: ${data.authorizationUrl}`
    }
  } catch (err) {
    actionMessage.value = err instanceof Error ? err.message : t('sales.payLinkFailed')
  } finally {
    actionBusy.value = null
  }
}

async function verifyPayment(order: Order) {
  actionBusy.value = `verify-${order.id}`
  actionMessage.value = null
  try {
    await api(`/api/sales/${order.id}/verify-payment`, { method: 'POST', body: '{}' })
    actionMessage.value = t('sales.paymentVerified')
    await load()
  } catch (err) {
    actionMessage.value = err instanceof Error ? err.message : t('sales.verifyFailed')
  } finally {
    actionBusy.value = null
  }
}

async function refundOrder(order: Order) {
  const ok = window.confirm(t('sales.refundConfirm'))
  if (!ok) return

  const reason = window.prompt(t('sales.refundReasonPrompt'), t('sales.refundReasonDefault'))
  if (reason == null) return
  const trimmed = reason.trim()
  if (!trimmed) {
    actionMessage.value = t('sales.refundReasonRequired')
    return
  }

  actionBusy.value = `refund-${order.id}`
  actionMessage.value = null
  try {
    await api(`/api/sales/${order.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: trimmed }),
    })
    actionMessage.value = t('sales.refundStarted')
    await load()
  } catch (err) {
    actionMessage.value = err instanceof Error ? err.message : t('sales.refundFailed')
  } finally {
    actionBusy.value = null
  }
}

const profile = ref<CustomerProfile | null>(null)
const profileLoading = ref(false)
const profileOpen = ref(false)

async function openCustomer(contactId: string) {
  profileOpen.value = true
  profileLoading.value = true
  profile.value = null
  try {
    profile.value = await api<CustomerProfile>(`/api/sales/contacts/${contactId}`)
  } finally {
    profileLoading.value = false
  }
}

function closeCustomer() {
  profileOpen.value = false
  profile.value = null
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('sales.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('sales.subtitle') }}</p>
    </div>

    <p
      v-if="actionMessage"
      class="mt-4 text-sm text-amber-200/90 bg-amber-950/40 border border-amber-900/50 rounded-lg px-3 py-2"
    >
      {{ actionMessage }}
    </p>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('sales.loading') }}</div>

    <div v-else-if="!orders.length" class="mt-8 text-slate-500 text-sm">{{ t('sales.noOrders') }}</div>

    <div v-else class="mt-8 space-y-4">
      <div
        v-for="order in orders"
        :key="order.id"
        class="bg-slate-900 border rounded-xl p-5"
        :class="
          order.refundRequestedAt
            ? 'border-orange-700/70 ring-1 ring-orange-800/40'
            : 'border-slate-800'
        "
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-bold text-white">{{ displayCustomerName(order) }}</h3>
              <span
                v-if="order.source && order.source !== 'staff'"
                class="text-[10px] font-bold px-2 py-0.5 rounded-full"
                :class="sourceColor[order.source] ?? 'bg-slate-700 text-slate-300'"
              >
                {{ sourceText(order.source) }}
              </span>
              <span
                v-if="order.paymentStatus && order.paymentStatus !== 'not_required'"
                class="text-[10px] font-bold px-2 py-0.5 rounded-full capitalize"
                :class="paymentStatusColor[order.paymentStatus] ?? 'bg-slate-700 text-slate-300'"
              >
                {{ paymentStatusLabel(order.paymentStatus) }}
              </span>
              <span
                v-else-if="order.paymentStatus === 'not_required'"
                class="text-[10px] font-bold px-2 py-0.5 rounded-full"
                :class="paymentStatusColor.not_required"
              >
                {{ paymentStatusLabel('not_required') }}
              </span>
            </div>
            <p v-if="order.reference" class="text-xs font-mono text-slate-500 mt-0.5">
              {{ order.reference }}
            </p>
            <p v-if="order.customerPhone" class="text-slate-400 text-sm mt-1">
              {{ order.customerPhone }}
            </p>
            <p
              v-if="order.refundRequestedAt"
              class="text-xs text-orange-300 mt-1 font-semibold"
            >
              {{ t('sales.refundRequested') }}
              {{ new Date(order.refundRequestedAt).toLocaleString() }}
              <span v-if="order.cancelledBy"> · {{ order.cancelledBy }}</span>
            </p>
            <p class="text-lg font-mono text-farm-gold mt-2">
              <template v-if="order.totalAmount > 0">
                {{ formatAmount(order.totalAmount, order.currency) }}
              </template>
              <template v-else>
                {{ t('sales.priceOnRequest') }}
              </template>
            </p>

            <ul v-if="order.items && order.items.length" class="mt-2 space-y-0.5">
              <li
                v-for="(item, i) in order.items"
                :key="i"
                class="text-sm text-slate-300"
              >
                {{ item.quantity }} × {{ item.productName }}
                <span class="text-slate-600">({{ item.unit }})</span>
                <span v-if="item.unitPriceKobo > 0" class="text-slate-500 font-mono">
                  · {{ formatAmount(item.unitPriceKobo / 100, order.currency) }}
                  = {{ formatAmount(item.lineTotalKobo / 100, order.currency) }}
                </span>
                <span v-else class="text-slate-600"> · {{ t('sales.priceOnRequest') }}</span>
              </li>
            </ul>

            <p class="text-xs text-slate-500 mt-2">
              <span v-if="order.lotCode">{{ t('sales.lot') }}: {{ order.lotCode }} · </span>
              {{ t('sales.created') }} {{ new Date(order.createdAt).toLocaleDateString() }}
            </p>
            <a
              v-if="order.lotId && auth.canManageOrders"
              :href="resolveApiUrl(`/api/traceability/${order.lotId}/label.html?autoprint=1`)"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-block mt-2 text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
            >
              {{ t('sales.printQr') }}
            </a>
            <p v-if="order.notes" class="text-sm text-slate-400 mt-2">{{ order.notes }}</p>
          </div>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full capitalize flex-shrink-0"
            :class="statusColor[order.status] ?? 'bg-slate-700'"
          >
            {{ statusLabel(order.status) }}
          </span>
        </div>

        <div
          v-if="auth.canManageOrders"
          class="flex flex-wrap gap-2 mt-4"
        >
          <button
            v-if="nextStatus[order.status]"
            class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="blocksFulfillment(order, nextStatus[order.status].status)"
            :title="
              blocksFulfillment(order, nextStatus[order.status].status)
                ? t('sales.unpaidBlocksFulfillment')
                : undefined
            "
            @click="updateStatus(order.id, nextStatus[order.status].status)"
          >
            {{ t(nextStatus[order.status].labelKey) }}
          </button>
          <button
            v-if="order.status === 'pending' || order.status === 'confirmed'"
            class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60"
            @click="cancelOrder(order.id)"
          >
            {{ t('sales.cancel') }}
          </button>
          <button
            v-if="canResendPayLink(order)"
            class="text-xs px-3 py-1.5 rounded-lg bg-sky-900/40 text-sky-300 hover:bg-sky-900/60 disabled:opacity-50"
            :disabled="actionBusy === `pay-${order.id}`"
            @click="resendPayLink(order)"
          >
            {{ t('sales.resendPayLink') }}
          </button>
          <button
            v-if="order.paymentStatus === 'unpaid'"
            class="text-xs px-3 py-1.5 rounded-lg bg-blue-900/40 text-blue-300 hover:bg-blue-900/60 disabled:opacity-50"
            :disabled="actionBusy === `verify-${order.id}`"
            @click="verifyPayment(order)"
          >
            {{ t('sales.verifyPayment') }}
          </button>
          <button
            v-if="canRefund(order)"
            class="text-xs px-3 py-1.5 rounded-lg bg-orange-900/40 text-orange-300 hover:bg-orange-900/60 disabled:opacity-50"
            :disabled="actionBusy === `refund-${order.id}`"
            @click="refundOrder(order)"
          >
            {{ t('sales.refund') }}
          </button>
          <a
            v-if="order.hasInvoice"
            :href="resolveApiUrl(`/api/sales/${order.id}/invoice`)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"
          >
            {{ t('sales.openInvoice') }}
          </a>
          <a
            v-if="order.hasInvoice"
            :href="resolveApiUrl(`/api/sales/${order.id}/invoice/pdf`)"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"
          >
            {{ t('sales.downloadPdf') }}
          </a>
          <button
            v-if="order.customerContactId"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="openCustomer(order.customerContactId!)"
          >
            {{ t('sales.viewCustomer') }}
          </button>
        </div>
        <p v-if="order.customerFeedback" class="text-xs text-amber-200/90 mt-3">
          Feedback: {{ order.customerFeedback }}
        </p>
        <p v-if="order.deliveryPhotoUrl" class="text-xs text-slate-500 mt-1">
          Delivery photo on file
        </p>
      </div>
    </div>

    <!-- Customer profile drawer -->
    <div
      v-if="profileOpen"
      class="fixed inset-0 z-50 flex justify-end bg-black/50"
      @click.self="closeCustomer"
    >
      <div class="w-full max-w-md h-full overflow-y-auto bg-slate-950 border-l border-slate-800 p-6">
        <div class="flex items-start justify-between">
          <h3 class="text-xl font-black text-os-fg">{{ t('sales.customer') }}</h3>
          <button
            class="text-slate-500 hover:text-white text-sm"
            @click="closeCustomer"
          >
            {{ t('sales.close') }}
          </button>
        </div>

        <div v-if="profileLoading" class="mt-8 text-slate-400 text-sm">{{ t('sales.loadingCustomer') }}</div>

        <div v-else-if="profile" class="mt-6 space-y-6">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="text-lg font-bold text-white">
                {{ profile.contact.name || t('sales.unnamedCustomer') }}
              </h4>
              <span
                class="text-[10px] font-bold px-2 py-0.5 rounded-full"
                :class="sourceColor[profile.contact.channel] ?? 'bg-slate-700 text-slate-300'"
              >
                {{ sourceText(profile.contact.channel) }}
              </span>
            </div>
            <p class="text-xs font-mono text-slate-500 mt-1">
              {{ profile.contact.channel }}:{{ profile.contact.externalId }}
            </p>
            <p v-if="profile.contact.phone" class="text-slate-400 text-sm mt-1">
              {{ profile.contact.phone }}
            </p>
            <p class="text-xs text-slate-500 mt-2">
              {{ t('sales.firstSeen') }} {{ new Date(profile.contact.firstSeen).toLocaleDateString() }} ·
              {{ t('sales.lastActive') }} {{ new Date(profile.contact.lastSeen).toLocaleDateString() }}
            </p>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
              <p class="text-2xl font-black text-os-fg">{{ profile.stats.orderCount }}</p>
              <p class="text-[11px] text-slate-500 mt-0.5">{{ t('sales.orders') }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
              <p class="text-2xl font-black text-os-fg">{{ profile.stats.inquiryCount }}</p>
              <p class="text-[11px] text-slate-500 mt-0.5">{{ t('sales.questions') }}</p>
            </div>
            <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 text-center">
              <p class="text-lg font-black text-farm-gold leading-tight">
                {{ formatAmount(profile.stats.lifetimeValue, profile.stats.currency) }}
              </p>
              <p class="text-[11px] text-slate-500 mt-0.5">{{ t('sales.delivered') }}</p>
            </div>
          </div>

          <div>
            <h5 class="text-sm font-bold text-slate-300 mb-2">{{ t('sales.orderHistory') }}</h5>
            <div v-if="!profile.orders.length" class="text-sm text-slate-500">{{ t('sales.noOrders') }}</div>
            <div v-else class="space-y-3">
              <div
                v-for="o in profile.orders"
                :key="o.id"
                class="bg-slate-900 border border-slate-800 rounded-xl p-4"
              >
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p v-if="o.reference" class="text-xs font-mono text-slate-500">
                      {{ o.reference }}
                    </p>
                    <p class="text-farm-gold font-mono mt-0.5">
                      {{ formatAmount(o.totalAmount, o.currency) }}
                    </p>
                    <span
                      v-if="o.paymentStatus"
                      class="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full capitalize"
                      :class="paymentStatusColor[o.paymentStatus] ?? 'bg-slate-700 text-slate-300'"
                    >
                      {{ paymentStatusLabel(o.paymentStatus) }}
                    </span>
                  </div>
                  <span
                    class="text-xs font-bold px-2.5 py-1 rounded-full capitalize flex-shrink-0"
                    :class="statusColor[o.status] ?? 'bg-slate-700'"
                  >
                    {{ statusLabel(o.status) }}
                  </span>
                </div>
                <ul v-if="o.items && o.items.length" class="mt-2 space-y-0.5">
                  <li v-for="(item, i) in o.items" :key="i" class="text-sm text-slate-300">
                    {{ item.quantity }} × {{ item.productName }}
                    <span class="text-slate-600">({{ item.unit }})</span>
                  </li>
                </ul>
                <p class="text-xs text-slate-500 mt-2">
                  {{ new Date(o.createdAt).toLocaleDateString() }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
