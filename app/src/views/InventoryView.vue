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

type Supplier = {
  id: string
  name: string
  phone?: string | null
  email?: string | null
  active: boolean
}
type PurchaseOrderLine = {
  id: string
  itemId?: string | null
  itemName: string
  unit: string
  quantityOrdered: number
  quantityReceived: number
  unitCostMinor?: number | null
}
type PurchaseOrder = {
  id: string
  supplierId: string
  supplierName: string
  status: string
  expectedAt?: string | null
  createdAt: string
  lines?: PurchaseOrderLine[]
}
const suppliers = ref<Supplier[]>([])
const purchaseOrders = ref<PurchaseOrder[]>([])
const selectedPurchaseOrder = ref<PurchaseOrder | null>(null)
const newSupplierName = ref('')
const supplierSaving = ref(false)
const poSupplierId = ref('')
const poExpectedAt = ref('')
const poNotes = ref('')
const poLines = ref<Array<{ itemId: string; quantityOrdered: number; unitCostMinor: number | '' }>>([
  { itemId: '', quantityOrdered: 1, unitCostMinor: '' },
])
const poSaving = ref(false)
const poActionId = ref<string | null>(null)
const receiveQuantities = ref<Record<string, number | ''>>({})
const poMessage = ref<string | null>(null)

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

async function loadProcurement() {
  if (!auth.canApprove) return
  try {
    const [supplierData, orderData] = await Promise.all([
      api<{ suppliers: Supplier[] }>('/api/suppliers'),
      api<{ purchaseOrders: PurchaseOrder[] }>('/api/purchase-orders'),
    ])
    suppliers.value = supplierData.suppliers
    purchaseOrders.value = orderData.purchaseOrders
    if (!poSupplierId.value) poSupplierId.value = suppliers.value.find((s) => s.active)?.id ?? ''
  } catch (e) {
    poMessage.value = e instanceof Error ? e.message : t('inventory.poLoadFailed')
  }
}

onMounted(async () => {
  await Promise.all([load(), loadCountSessions(), loadProcurement()])
})

async function createSupplier() {
  if (!newSupplierName.value.trim()) return
  supplierSaving.value = true
  poMessage.value = null
  try {
    await api('/api/suppliers', {
      method: 'POST',
      body: JSON.stringify({ name: newSupplierName.value.trim() }),
    })
    newSupplierName.value = ''
    await loadProcurement()
  } catch (e) {
    poMessage.value = e instanceof Error ? e.message : t('inventory.supplierSaveFailed')
  } finally {
    supplierSaving.value = false
  }
}

function addPoLine() {
  poLines.value.push({ itemId: '', quantityOrdered: 1, unitCostMinor: '' })
}

async function createPurchaseOrder() {
  const lines = poLines.value.filter((line) => line.itemId).map((line) => {
    const item = items.value.find((candidate) => candidate.id === line.itemId)!
    return {
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      quantityOrdered: Math.max(1, Math.trunc(Number(line.quantityOrdered))),
      unitCostMinor: line.unitCostMinor === '' ? null : Math.max(0, Math.trunc(Number(line.unitCostMinor))),
    }
  })
  if (!poSupplierId.value || !lines.length) return
  poSaving.value = true
  poMessage.value = null
  try {
    await api('/api/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        supplierId: poSupplierId.value,
        expectedAt: poExpectedAt.value ? new Date(poExpectedAt.value).toISOString() : null,
        notes: poNotes.value.trim() || null,
        lines,
      }),
    })
    poLines.value = [{ itemId: '', quantityOrdered: 1, unitCostMinor: '' }]
    poExpectedAt.value = ''
    poNotes.value = ''
    poMessage.value = t('inventory.poDraftSaved')
    await loadProcurement()
  } catch (e) {
    poMessage.value = e instanceof Error ? e.message : t('inventory.poSaveFailed')
  } finally {
    poSaving.value = false
  }
}

async function openPurchaseOrder(id: string) {
  poActionId.value = id
  try {
    const data = await api<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${id}`)
    selectedPurchaseOrder.value = data.purchaseOrder
    receiveQuantities.value = Object.fromEntries(
      (data.purchaseOrder.lines ?? []).map((line) => [line.id, '']),
    )
  } finally {
    poActionId.value = null
  }
}

async function purchaseOrderAction(id: string, action: 'approve' | 'send' | 'cancel') {
  poActionId.value = id
  poMessage.value = null
  try {
    await api(`/api/purchase-orders/${id}/${action}`, { method: 'POST' })
    await loadProcurement()
    await openPurchaseOrder(id)
  } catch (e) {
    poMessage.value = e instanceof Error ? e.message : t('inventory.poActionFailed')
  } finally {
    poActionId.value = null
  }
}

async function receivePurchaseOrder() {
  if (!selectedPurchaseOrder.value?.lines) return
  const lines = selectedPurchaseOrder.value.lines
    .filter((line) => Number(receiveQuantities.value[line.id]) > 0)
    .map((line) => ({
      purchaseOrderLineId: line.id,
      quantityReceived: Math.trunc(Number(receiveQuantities.value[line.id])),
    }))
  if (!lines.length) return
  poActionId.value = selectedPurchaseOrder.value.id
  poMessage.value = null
  try {
    await api(`/api/purchase-orders/${selectedPurchaseOrder.value.id}/receipts`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), lines }),
    })
    poMessage.value = t('inventory.receiptPosted')
    await Promise.all([
      load(),
      loadProcurement(),
      openPurchaseOrder(selectedPurchaseOrder.value.id),
    ])
  } catch (e) {
    poMessage.value = e instanceof Error ? e.message : t('inventory.receiveFailed')
  } finally {
    poActionId.value = null
  }
}

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

    <section
      v-if="auth.canApprove && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5"
    >
      <div>
        <h3 class="font-bold text-white">{{ t('inventory.procurement') }}</h3>
        <p class="text-xs text-slate-500 mt-1">{{ t('inventory.procurementDesc') }}</p>
      </div>

      <form class="flex flex-col sm:flex-row gap-2" @submit.prevent="createSupplier">
        <input
          v-model="newSupplierName"
          required
          maxlength="200"
          :placeholder="t('inventory.supplierName')"
          class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <button
          type="submit"
          :disabled="supplierSaving || !newSupplierName.trim()"
          class="text-xs font-bold px-4 py-2 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          {{ supplierSaving ? t('inventory.saving') : t('inventory.addSupplier') }}
        </button>
      </form>

      <form
        v-if="suppliers.some((supplier) => supplier.active)"
        class="border-t border-slate-800 pt-5 space-y-3"
        @submit.prevent="createPurchaseOrder"
      >
        <h4 class="text-sm font-semibold text-white">{{ t('inventory.draftPo') }}</h4>
        <div class="grid sm:grid-cols-3 gap-3">
          <select
            v-model="poSupplierId"
            required
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="" disabled>{{ t('inventory.chooseSupplier') }}</option>
            <option
              v-for="supplier in suppliers.filter((candidate) => candidate.active)"
              :key="supplier.id"
              :value="supplier.id"
            >
              {{ supplier.name }}
            </option>
          </select>
          <input
            v-model="poExpectedAt"
            type="datetime-local"
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model="poNotes"
            maxlength="2000"
            :placeholder="t('inventory.poNotes')"
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>
        <div class="space-y-2">
          <div
            v-for="(line, index) in poLines"
            :key="index"
            class="grid sm:grid-cols-[1fr_110px_150px] gap-2"
          >
            <select
              v-model="line.itemId"
              required
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="" disabled>{{ t('inventory.chooseItem') }}</option>
              <option v-for="item in items" :key="item.id" :value="item.id">
                {{ item.name }} ({{ item.unit }})
              </option>
            </select>
            <input
              v-model.number="line.quantityOrdered"
              type="number"
              min="1"
              step="1"
              :aria-label="t('inventory.orderQty')"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              v-model.number="line.unitCostMinor"
              type="number"
              min="0"
              step="1"
              :placeholder="t('inventory.unitCostMinor')"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300"
            @click="addPoLine"
          >
            {{ t('inventory.addLine') }}
          </button>
          <button
            type="submit"
            :disabled="poSaving || !poSupplierId || !poLines.some((line) => line.itemId)"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green disabled:opacity-50"
          >
            {{ poSaving ? t('inventory.saving') : t('inventory.saveDraftPo') }}
          </button>
        </div>
      </form>

      <div class="border-t border-slate-800 pt-5">
        <h4 class="text-sm font-semibold text-white mb-3">{{ t('inventory.purchaseOrders') }}</h4>
        <p v-if="!purchaseOrders.length" class="text-xs text-slate-500">
          {{ t('inventory.noPurchaseOrders') }}
        </p>
        <div v-else class="grid lg:grid-cols-2 gap-3">
          <button
            v-for="order in purchaseOrders"
            :key="order.id"
            type="button"
            class="text-left rounded-lg border border-slate-800 bg-slate-950/60 p-3 hover:border-slate-700"
            @click="openPurchaseOrder(order.id)"
          >
            <div class="flex justify-between gap-3">
              <span class="text-sm font-semibold text-white">{{ order.supplierName }}</span>
              <span class="text-[11px] uppercase text-farm-green">{{ order.status.replace('_', ' ') }}</span>
            </div>
            <p class="text-xs text-slate-500 mt-1">{{ new Date(order.createdAt).toLocaleDateString() }}</p>
          </button>
        </div>
      </div>

      <div
        v-if="selectedPurchaseOrder"
        class="border-t border-slate-800 pt-5 space-y-3"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 class="text-sm font-semibold text-white">{{ selectedPurchaseOrder.supplierName }}</h4>
            <p class="text-xs text-slate-500 uppercase">{{ selectedPurchaseOrder.status.replace('_', ' ') }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="auth.isOwner && selectedPurchaseOrder.status === 'draft'"
              type="button"
              :disabled="poActionId === selectedPurchaseOrder.id"
              class="text-xs px-3 py-1.5 rounded bg-farm-green/20 text-farm-green"
              @click="purchaseOrderAction(selectedPurchaseOrder.id, 'approve')"
            >
              {{ t('inventory.approvePo') }}
            </button>
            <button
              v-if="selectedPurchaseOrder.status === 'approved'"
              type="button"
              :disabled="poActionId === selectedPurchaseOrder.id"
              class="text-xs px-3 py-1.5 rounded bg-slate-800 text-slate-300"
              @click="purchaseOrderAction(selectedPurchaseOrder.id, 'send')"
            >
              {{ t('inventory.markSent') }}
            </button>
            <button
              v-if="auth.isOwner && ['draft', 'approved', 'sent'].includes(selectedPurchaseOrder.status)"
              type="button"
              :disabled="poActionId === selectedPurchaseOrder.id"
              class="text-xs px-3 py-1.5 rounded bg-red-900/40 text-red-300"
              @click="purchaseOrderAction(selectedPurchaseOrder.id, 'cancel')"
            >
              {{ t('inventory.cancelPo') }}
            </button>
          </div>
        </div>
        <div
          v-for="line in selectedPurchaseOrder.lines"
          :key="line.id"
          class="grid grid-cols-[1fr_auto] gap-3 items-center rounded-lg bg-slate-950 border border-slate-800 p-3"
        >
          <div>
            <p class="text-sm text-white">{{ line.itemName }}</p>
            <p class="text-xs text-slate-500">
              {{ line.quantityReceived }} / {{ line.quantityOrdered }} {{ line.unit }}
            </p>
          </div>
          <input
            v-if="['approved', 'sent', 'partially_received'].includes(selectedPurchaseOrder.status) && line.quantityReceived < line.quantityOrdered"
            v-model.number="receiveQuantities[line.id]"
            type="number"
            min="1"
            :max="line.quantityOrdered - line.quantityReceived"
            step="1"
            :placeholder="t('inventory.receiveQty')"
            class="w-28 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>
        <button
          v-if="['approved', 'sent', 'partially_received'].includes(selectedPurchaseOrder.status)"
          type="button"
          :disabled="poActionId === selectedPurchaseOrder.id || !Object.values(receiveQuantities).some((value) => Number(value) > 0)"
          class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green disabled:opacity-50"
          @click="receivePurchaseOrder"
        >
          {{ t('inventory.postReceipt') }}
        </button>
      </div>
      <p v-if="poMessage" class="text-xs text-slate-400">{{ poMessage }}</p>
    </section>

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
