<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

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
  totalAmount: number
  currency: string
  lotId?: string
  lotCode?: string
  source?: string
  reference?: string
  items?: OrderItem[]
  notes?: string
  dispatchedAt?: string
  createdAt: string
}

const sourceLabel: Record<string, string> = {
  staff: 'Staff',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
}

const sourceColor: Record<string, string> = {
  telegram: 'bg-sky-900/50 text-sky-300',
  whatsapp: 'bg-emerald-900/50 text-emerald-300',
  staff: 'bg-slate-700 text-slate-300',
}

const auth = useAuthStore()
const orders = ref<Order[]>([])
const loading = ref(true)

const statusColor: Record<string, string> = {
  pending: 'bg-amber-900/40 text-amber-300',
  confirmed: 'bg-blue-900/50 text-blue-300',
  dispatched: 'bg-purple-900/50 text-purple-300',
  delivered: 'bg-farm-green/20 text-farm-green',
  cancelled: 'bg-red-900/50 text-red-300',
}

const nextStatus: Record<string, { status: string; label: string }> = {
  pending: { status: 'confirmed', label: 'Confirm' },
  confirmed: { status: 'dispatched', label: 'Dispatch' },
  dispatched: { status: 'delivered', label: 'Mark delivered' },
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(amount)
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
  await api(`/api/sales/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  await load()
}

async function cancelOrder(id: string) {
  await api(`/api/sales/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled' }),
  })
  await load()
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Sales</h2>
      <p class="text-slate-400 text-sm mt-1">Order fulfillment and customer deliveries</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">Loading orders…</div>

    <div v-else-if="!orders.length" class="mt-8 text-slate-500 text-sm">No orders yet.</div>

    <div v-else class="mt-8 space-y-4">
      <div
        v-for="order in orders"
        :key="order.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-5"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-bold text-white">{{ order.customerName }}</h3>
              <span
                v-if="order.source && order.source !== 'staff'"
                class="text-[10px] font-bold px-2 py-0.5 rounded-full"
                :class="sourceColor[order.source] ?? 'bg-slate-700 text-slate-300'"
              >
                {{ sourceLabel[order.source] ?? order.source }}
              </span>
            </div>
            <p v-if="order.reference" class="text-xs font-mono text-slate-500 mt-0.5">
              {{ order.reference }}
            </p>
            <p v-if="order.customerPhone" class="text-slate-400 text-sm mt-1">
              {{ order.customerPhone }}
            </p>
            <p class="text-lg font-mono text-farm-gold mt-2">
              {{ formatAmount(order.totalAmount, order.currency) }}
            </p>

            <ul v-if="order.items && order.items.length" class="mt-2 space-y-0.5">
              <li
                v-for="(item, i) in order.items"
                :key="i"
                class="text-sm text-slate-300"
              >
                {{ item.quantity }} × {{ item.productName }}
                <span class="text-slate-600">({{ item.unit }})</span>
              </li>
            </ul>

            <p class="text-xs text-slate-500 mt-2">
              <span v-if="order.lotCode">Lot: {{ order.lotCode }} · </span>
              Created {{ new Date(order.createdAt).toLocaleDateString() }}
            </p>
            <p v-if="order.notes" class="text-sm text-slate-400 mt-2">{{ order.notes }}</p>
          </div>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full capitalize flex-shrink-0"
            :class="statusColor[order.status] ?? 'bg-slate-700'"
          >
            {{ order.status }}
          </span>
        </div>

        <div
          v-if="auth.canApprove && (nextStatus[order.status] || order.status === 'pending' || order.status === 'confirmed')"
          class="flex flex-wrap gap-2 mt-4"
        >
          <button
            v-if="nextStatus[order.status]"
            class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
            @click="updateStatus(order.id, nextStatus[order.status].status)"
          >
            {{ nextStatus[order.status].label }}
          </button>
          <button
            v-if="order.status === 'pending' || order.status === 'confirmed'"
            class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60"
            @click="cancelOrder(order.id)"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
