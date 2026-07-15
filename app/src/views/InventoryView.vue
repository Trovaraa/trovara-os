<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

type Item = {
  id: string
  name: string
  category: string
  unit: string
  quantity: number
  reorderLevel: number
  lowStock: boolean
  supplier?: string | null
  costPerUnit?: number | null
  expiryDate?: string | null
  storageLocation?: string | null
}

const auth = useAuthStore()
const items = ref<Item[]>([])
const loading = ref(true)

const hasSupplier = computed(() => items.value.some((i) => i.supplier))
const hasCostPerUnit = computed(() => items.value.some((i) => i.costPerUnit != null))
const hasExpiryDate = computed(() => items.value.some((i) => i.expiryDate))
const hasStorageLocation = computed(() => items.value.some((i) => i.storageLocation))

const selectedItemId = ref('')
const delta = ref<number | ''>('')
const reason = ref('')
const submitting = ref(false)
const moveError = ref<string | null>(null)
const openingStockOpen = ref(false)
const openingCounts = ref<Record<string, number | ''>>({})
const savingOpening = ref(false)
const openingMessage = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const data = await api<{ items: Item[] }>('/api/inventory')
    items.value = data.items
    if (!selectedItemId.value && data.items.length) {
      selectedItemId.value = data.items[0].id
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openOpeningStockModal() {
  openingCounts.value = Object.fromEntries(
    items.value.map((item) => [item.id, item.quantity]),
  )
  openingMessage.value = null
  openingStockOpen.value = true
}

async function saveOpeningStock() {
  savingOpening.value = true
  openingMessage.value = null
  try {
    await api('/api/inventory/opening-stock', {
      method: 'POST',
      body: JSON.stringify({
        counts: items.value.map((item) => ({
          itemId: item.id,
          countedQuantity: Number(openingCounts.value[item.id] ?? 0),
        })),
      }),
    })
    openingStockOpen.value = false
    openingMessage.value = 'Opening stock count saved successfully.'
    await load()
  } catch (e) {
    openingMessage.value = e instanceof Error ? e.message : 'Failed to save opening stock'
  } finally {
    savingOpening.value = false
  }
}

async function recordMovement() {
  if (!selectedItemId.value || delta.value === '' || !reason.value.trim()) return
  submitting.value = true
  moveError.value = null
  try {
    await api('/api/inventory/movements', {
      method: 'POST',
      body: JSON.stringify({
        itemId: selectedItemId.value,
        delta: Number(delta.value),
        reason: reason.value.trim(),
      }),
    })
    delta.value = ''
    reason.value = ''
    await load()
  } catch (e) {
    moveError.value = e instanceof Error ? e.message : 'Failed to record movement'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Inventory</h2>
      <p class="text-slate-400 text-sm mt-1">Stock levels and reorder alerts</p>
      <button
        v-if="auth.canApprove && !loading"
        type="button"
        class="mt-3 text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        @click="openOpeningStockModal"
      >
        Opening stock count
      </button>
      <p v-if="openingMessage" class="mt-2 text-xs text-slate-400">{{ openingMessage }}</p>
    </div>

    <form
      v-if="auth.canApprove && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="recordMovement"
    >
      <h3 class="font-bold text-white text-sm">Record stock movement</h3>
      <div class="grid sm:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Item</label>
          <select
            v-model="selectedItemId"
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option v-for="item in items" :key="item.id" :value="item.id">
              {{ item.name }} ({{ item.quantity }} {{ item.unit }})
            </option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Delta (+ in / − out)</label>
          <input
            v-model.number="delta"
            type="number"
            required
            placeholder="e.g. -5 or 20"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Reason</label>
          <input
            v-model="reason"
            type="text"
            required
            maxlength="500"
            placeholder="e.g. Applied to Block A"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="submitting || !selectedItemId || delta === '' || !reason.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ submitting ? 'Recording…' : 'Record movement' }}
        </button>
        <p v-if="moveError" class="text-xs text-red-400">{{ moveError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">Loading inventory…</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">Item</th>
            <th class="pb-3 font-semibold">Category</th>
            <th class="pb-3 font-semibold">Quantity</th>
            <th class="pb-3 font-semibold">Reorder at</th>
            <th v-if="hasSupplier" class="pb-3 font-semibold">Supplier</th>
            <th v-if="hasCostPerUnit" class="pb-3 font-semibold">Cost / unit</th>
            <th v-if="hasExpiryDate" class="pb-3 font-semibold">Expiry</th>
            <th v-if="hasStorageLocation" class="pb-3 font-semibold">Storage</th>
            <th class="pb-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.id"
            class="border-b border-slate-800/50"
          >
            <td class="py-4 font-medium text-white">{{ item.name }}</td>
            <td class="py-4 text-slate-400 capitalize">{{ item.category }}</td>
            <td class="py-4 font-mono text-slate-300">
              {{ item.quantity }} {{ item.unit }}
            </td>
            <td class="py-4 font-mono text-slate-500">{{ item.reorderLevel }}</td>
            <td v-if="hasSupplier" class="py-4 text-slate-400">{{ item.supplier ?? '-' }}</td>
            <td v-if="hasCostPerUnit" class="py-4 font-mono text-slate-400">
              {{ item.costPerUnit != null ? item.costPerUnit : '-' }}
            </td>
            <td v-if="hasExpiryDate" class="py-4 text-slate-400">
              {{ item.expiryDate ? new Date(item.expiryDate).toLocaleDateString() : '-' }}
            </td>
            <td v-if="hasStorageLocation" class="py-4 text-slate-400">
              {{ item.storageLocation ?? '-' }}
            </td>
            <td class="py-4">
              <span
                class="text-xs font-bold px-2 py-1 rounded-full"
                :class="item.lowStock ? 'bg-red-900/40 text-red-300' : 'bg-farm-green/20 text-farm-green'"
              >
                {{ item.lowStock ? 'Low stock' : 'OK' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="openingStockOpen"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="openingStockOpen = false"
    >
      <div class="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Opening stock count</h3>
        <p class="text-xs text-slate-500 mt-1">Set current counted quantity for each inventory item.</p>
        <div class="mt-4 max-h-[55vh] overflow-auto space-y-2">
          <div
            v-for="item in items"
            :key="item.id"
            class="grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 items-center"
          >
            <div>
              <p class="text-sm text-white">{{ item.name }}</p>
              <p class="text-xs text-slate-500">{{ item.unit }}</p>
            </div>
            <input
              v-model.number="openingCounts[item.id]"
              type="number"
              min="0"
              step="0.01"
              class="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white font-mono"
            />
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="text-xs px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="openingStockOpen = false"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="savingOpening"
            class="text-xs px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            @click="saveOpeningStock"
          >
            {{ savingOpening ? 'Saving…' : 'Save opening stock' }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
