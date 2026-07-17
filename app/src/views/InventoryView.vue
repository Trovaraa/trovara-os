<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

const { t } = useI18n()

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

const newItemName = ref('')
const newItemCategory = ref('supplies')
const newItemUnit = ref<'kg' | 'bags' | 'liters' | 'units' | 'crates'>('units')
const creatingItem = ref(false)
const createItemError = ref<string | null>(null)

type CountSession = {
  id: string
  status: string
  locationText?: string | null
  recordedById: string
  createdAt: string
  rejectionReason?: string | null
}
const countSessions = ref<CountSession[]>([])
const countLocation = ref('')
const countLines = ref<Array<{ itemId: string; countedQuantity: number | '' }>>([])
const submittingCount = ref(false)
const countMessage = ref<string | null>(null)
const verifyingSessionId = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const data = await api<{ items: Item[] }>('/api/inventory')
    items.value = data.items
    if (!selectedItemId.value && data.items.length) {
      selectedItemId.value = data.items[0].id
    }
    if (!countLines.value.length && data.items.length) {
      countLines.value = data.items.slice(0, 8).map((item) => ({
        itemId: item.id,
        countedQuantity: item.quantity,
      }))
    }
  } finally {
    loading.value = false
  }
}

async function loadCountSessions() {
  if (!auth.canApprove) return
  try {
    const data = await api<{ sessions: CountSession[] }>('/api/inventory/count-sessions')
    countSessions.value = data.sessions ?? []
  } catch {
    countSessions.value = []
  }
}

onMounted(async () => {
  await Promise.all([load(), loadCountSessions()])
})

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
    await api('/api/inventory/opening-count', {
      method: 'POST',
      body: JSON.stringify({
        items: items.value.map((item) => ({
          itemId: item.id,
          countedQuantity: Math.max(0, Math.trunc(Number(openingCounts.value[item.id] ?? 0))),
        })),
      }),
    })
    openingStockOpen.value = false
    openingMessage.value = t('inventory.savedOk')
    await load()
  } catch (e) {
    openingMessage.value = e instanceof Error ? e.message : t('inventory.saveFailed')
  } finally {
    savingOpening.value = false
  }
}

async function createItem() {
  if (!newItemName.value.trim()) return
  creatingItem.value = true
  createItemError.value = null
  try {
    await api('/api/inventory/items', {
      method: 'POST',
      body: JSON.stringify({
        name: newItemName.value.trim(),
        category: newItemCategory.value.trim() || 'supplies',
        unit: newItemUnit.value,
      }),
    })
    newItemName.value = ''
    newItemCategory.value = 'supplies'
    newItemUnit.value = 'units'
    await load()
  } catch (e) {
    createItemError.value = e instanceof Error ? e.message : t('inventory.addItemFailed')
  } finally {
    creatingItem.value = false
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
    moveError.value = e instanceof Error ? e.message : t('inventory.recordFailed')
  } finally {
    submitting.value = false
  }
}

function addCountLine() {
  const unused = items.value.find((item) => !countLines.value.some((l) => l.itemId === item.id))
  if (!unused) return
  countLines.value.push({ itemId: unused.id, countedQuantity: unused.quantity })
}

async function submitCountSession() {
  const lines = countLines.value
    .filter((l) => l.itemId && l.countedQuantity !== '')
    .map((l) => {
      const item = items.value.find((i) => i.id === l.itemId)!
      return {
        itemId: item.id,
        itemName: item.name,
        category: item.category,
        unit: item.unit as 'kg' | 'bags' | 'liters' | 'units' | 'crates',
        countedQuantity: Math.max(0, Math.trunc(Number(l.countedQuantity))),
      }
    })
  if (!lines.length) return
  submittingCount.value = true
  countMessage.value = null
  try {
    await api('/api/inventory/count-sessions', {
      method: 'POST',
      body: JSON.stringify({
        locationText: countLocation.value.trim() || undefined,
        lines,
      }),
    })
    countMessage.value = 'Count session submitted — awaiting verification before stock posts.'
    await Promise.all([load(), loadCountSessions()])
  } catch (e) {
    countMessage.value = e instanceof Error ? e.message : 'Failed to submit count'
  } finally {
    submittingCount.value = false
  }
}

async function verifyCountSession(sessionId: string, status: 'verified' | 'rejected') {
  verifyingSessionId.value = sessionId
  countMessage.value = null
  try {
    await api(`/api/inventory/count-sessions/${sessionId}/verify`, {
      method: 'POST',
      body: JSON.stringify({
        status,
        rejectionReason: status === 'rejected' ? 'Count rejected — please recount' : undefined,
      }),
    })
    countMessage.value =
      status === 'verified' ? 'Count verified — stock updated.' : 'Count session rejected.'
    await Promise.all([load(), loadCountSessions()])
  } catch (e) {
    countMessage.value = e instanceof Error ? e.message : 'Verify failed'
  } finally {
    verifyingSessionId.value = null
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">{{ t('inventory.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('inventory.subtitle') }}</p>
      <button
        v-if="auth.canApprove && !loading"
        type="button"
        class="mt-3 text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        @click="openOpeningStockModal"
      >
        {{ t('inventory.openingStockBtn') }}
      </button>
      <p v-if="openingMessage" class="mt-2 text-xs text-slate-400">{{ openingMessage }}</p>
    </div>

    <form
      v-if="auth.canApprove && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createItem"
    >
      <h3 class="font-bold text-white text-sm">{{ t('inventory.addItem') }}</h3>
      <div class="grid sm:grid-cols-3 gap-4">
        <input
          v-model="newItemName"
          required
          :placeholder="t('inventory.itemName')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="newItemCategory"
          :placeholder="t('inventory.category')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <select
          v-model="newItemUnit"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="units">units</option>
          <option value="kg">kg</option>
          <option value="bags">bags</option>
          <option value="liters">liters</option>
          <option value="crates">crates</option>
        </select>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creatingItem || !newItemName.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creatingItem ? t('inventory.addingItem') : t('inventory.addItemBtn') }}
        </button>
        <p v-if="createItemError" class="text-xs text-red-400">{{ createItemError }}</p>
      </div>
    </form>

    <div
      v-if="auth.canApprove && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
    >
      <h3 class="font-bold text-white text-sm">Verified inventory count</h3>
      <p class="text-xs text-slate-500">
        Submit a count session. Stock only updates after a different Admin/Supervisor verifies it.
      </p>
      <input
        v-model="countLocation"
        type="text"
        placeholder="Location (optional)"
        class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
      />
      <div class="space-y-2">
        <div
          v-for="(line, idx) in countLines"
          :key="idx"
          class="grid grid-cols-[1fr_110px] gap-2"
        >
          <select
            v-model="line.itemId"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option v-for="item in items" :key="item.id" :value="item.id">
              {{ item.name }} ({{ item.quantity }} {{ item.unit }})
            </option>
          </select>
          <input
            v-model.number="line.countedQuantity"
            type="number"
            min="0"
            step="1"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
          />
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          @click="addCountLine"
        >
          Add line
        </button>
        <button
          type="button"
          :disabled="submittingCount || !countLines.length"
          class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          @click="submitCountSession"
        >
          {{ submittingCount ? 'Submitting…' : 'Submit count session' }}
        </button>
      </div>
      <div v-if="countSessions.length" class="space-y-2 pt-2 border-t border-slate-800">
        <p class="text-xs font-semibold text-slate-400">Recent sessions</p>
        <div
          v-for="session in countSessions.slice(0, 8)"
          :key="session.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950 border border-slate-800 px-3 py-2"
        >
          <div class="text-xs text-slate-300">
            <span class="capitalize">{{ session.status }}</span>
            <span class="text-slate-500">
              · {{ new Date(session.createdAt).toLocaleString() }}
              <template v-if="session.locationText"> · {{ session.locationText }}</template>
            </span>
          </div>
          <div v-if="session.status === 'submitted'" class="flex gap-2">
            <button
              type="button"
              :disabled="verifyingSessionId === session.id"
              class="text-[11px] px-2 py-1 rounded bg-farm-green/20 text-farm-green"
              @click="verifyCountSession(session.id, 'verified')"
            >
              Verify
            </button>
            <button
              type="button"
              :disabled="verifyingSessionId === session.id"
              class="text-[11px] px-2 py-1 rounded bg-red-900/40 text-red-300"
              @click="verifyCountSession(session.id, 'rejected')"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
      <p v-if="countMessage" class="text-xs text-slate-400">{{ countMessage }}</p>
    </div>

    <form
      v-if="auth.canApprove && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="recordMovement"
    >
      <h3 class="font-bold text-white text-sm">{{ t('inventory.recordMovement') }}</h3>
      <div class="grid sm:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.item') }}</label>
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
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.delta') }}</label>
          <input
            v-model.number="delta"
            type="number"
            required
            :placeholder="t('inventory.deltaPlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.reason') }}</label>
          <input
            v-model="reason"
            type="text"
            required
            maxlength="500"
            :placeholder="t('inventory.reasonPlaceholder')"
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
          {{ submitting ? t('inventory.recording') : t('inventory.recordMovementBtn') }}
        </button>
        <p v-if="moveError" class="text-xs text-red-400">{{ moveError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('inventory.loading') }}</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">{{ t('inventory.item') }}</th>
            <th class="pb-3 font-semibold">{{ t('inventory.category') }}</th>
            <th class="pb-3 font-semibold">{{ t('inventory.quantity') }}</th>
            <th class="pb-3 font-semibold">{{ t('inventory.reorderAt') }}</th>
            <th v-if="hasSupplier" class="pb-3 font-semibold">{{ t('inventory.supplier') }}</th>
            <th v-if="hasCostPerUnit" class="pb-3 font-semibold">{{ t('inventory.costPerUnit') }}</th>
            <th v-if="hasExpiryDate" class="pb-3 font-semibold">{{ t('inventory.expiry') }}</th>
            <th v-if="hasStorageLocation" class="pb-3 font-semibold">{{ t('inventory.storage') }}</th>
            <th class="pb-3 font-semibold">{{ t('inventory.status') }}</th>
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
                {{ item.lowStock ? t('inventory.lowStock') : t('inventory.ok') }}
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
        <h3 class="text-white font-bold text-lg">{{ t('inventory.openingStockTitle') }}</h3>
        <p class="text-xs text-slate-500 mt-1">{{ t('inventory.openingStockDesc') }}</p>
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
              step="1"
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
            {{ t('inventory.cancel') }}
          </button>
          <button
            type="button"
            :disabled="savingOpening"
            class="text-xs px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            @click="saveOpeningStock"
          >
            {{ savingOpening ? t('inventory.saving') : t('inventory.saveOpeningStock') }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
