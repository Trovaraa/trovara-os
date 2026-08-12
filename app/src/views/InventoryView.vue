<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import InventoryProcurementSection from '@/components/inventory/InventoryProcurementSection.vue'
import { useInventoryProcurement } from '@/composables/useInventoryProcurement'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'
import AccessibleDialog from '@/components/AccessibleDialog.vue'

const { t } = useI18n()

type Item = {
  id: string
  sku: string
  name: string
  category: string
  unit: string
  quantity: number
  reorderLevel: number
  varianceTolerance: number
  lowStock: boolean
  productId?: string | null
  productName?: string | null
  productSku?: string | null
  supplier?: string | null
  costPerUnit?: number | null
  expiryDate?: string | null
  storageLocation?: string | null
}

type CatalogueProduct = {
  id: string
  sku: string
  name: string
  active: boolean
}

type ShrinkAlert = {
  id: string
  itemName: string
  unit: string
  sku: string
  alertType: string
  periodDays: number
  qtyIn: number
  qtyOutSale: number
  qtyOutOther: number
  soldQty: number
  unexplainedOut: number
  tolerance: number
  status: string
  createdAt: string
}

const auth = useAuthStore()
const isFieldWorker = computed(() => auth.user?.role === 'field_worker')
const canSubmitCount = computed(() => auth.hasPermission('inventory.count'))
const canWrite = computed(() => auth.hasPermission('inventory.write'))
const items = ref<Item[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

const hasSupplier = computed(() => items.value.some((i) => i.supplier))
const hasCostPerUnit = computed(() => items.value.some((i) => i.costPerUnit != null))
const hasExpiryDate = computed(() => items.value.some((i) => i.expiryDate))
const hasStorageLocation = computed(() => items.value.some((i) => i.storageLocation))

const selectedItemId = ref('')
const delta = ref<number | ''>('')
const reasonKind = ref<'custom' | 'spoilage'>('custom')
const reason = ref('')
const submitting = ref(false)
const moveError = ref<string | null>(null)
const catalogueProducts = ref<CatalogueProduct[]>([])
const newItemProductId = ref('')
const shrinkAlerts = ref<ShrinkAlert[]>([])
const refreshingShrink = ref(false)
const openingStockOpen = ref(false)
const openingCounts = ref<Record<string, number | ''>>({})
const savingOpening = ref(false)
const openingMessage = ref<string | null>(null)

const newItemName = ref('')
const newItemSku = ref('')
const newItemCategory = ref('supplies')
const newItemUnit = ref<'kg' | 'bags' | 'liters' | 'units' | 'crates'>('units')
const newVarianceTolerance = ref(0)
const creatingItem = ref(false)
const createItemError = ref<string | null>(null)

type CountSession = {
  id: string
  status: string
  locationText?: string | null
  recordedById: string
  createdAt: string
  rejectionReason?: string | null
  hasVariance: boolean
}
type ReconciliationAlert = {
  id: string
  itemName: string
  unit: string
  sku: string
  expectedQuantity: number
  countedQuantity: number
  variance: number
  tolerance: number
  status: string
  createdAt: string
}
const countSessions = ref<CountSession[]>([])
const reconciliationAlerts = ref<ReconciliationAlert[]>([])
const countLocation = ref('')
const countLines = ref<Array<{ itemId: string; countedQuantity: number | '' }>>([])
const submittingCount = ref(false)
const countMessage = ref<string | null>(null)
const verifyingSessionId = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
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
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : t('inventory.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadCountSessions() {
  if (!canSubmitCount.value) return
  try {
    const data = await api<{ sessions: CountSession[] }>('/api/inventory/count-sessions')
    countSessions.value = data.sessions ?? []
  } catch {
    countSessions.value = []
  }
}

async function loadReconciliationAlerts() {
  if (!canWrite.value) return
  try {
    const data = await api<{ alerts: ReconciliationAlert[] }>('/api/inventory/reconciliation-alerts')
    reconciliationAlerts.value = data.alerts ?? []
  } catch {
    reconciliationAlerts.value = []
  }
}

async function loadCatalogueProducts() {
  if (!canWrite.value) return
  try {
    const data = await api<{ products: CatalogueProduct[] }>('/api/products')
    catalogueProducts.value = (data.products ?? []).filter((p) => p.active)
  } catch {
    catalogueProducts.value = []
  }
}

async function loadShrinkAlerts() {
  if (!canWrite.value) return
  try {
    const data = await api<{ alerts: ShrinkAlert[] }>('/api/inventory/shrink-alerts')
    shrinkAlerts.value = data.alerts ?? []
  } catch {
    shrinkAlerts.value = []
  }
}

async function refreshShrinkAlerts() {
  if (!canWrite.value) return
  refreshingShrink.value = true
  try {
    await api('/api/inventory/shrink-alerts/refresh?days=30', { method: 'POST' })
    await loadShrinkAlerts()
  } finally {
    refreshingShrink.value = false
  }
}

async function updateShrinkAlert(alertId: string, status: 'acknowledged' | 'resolved') {
  await api(`/api/inventory/shrink-alerts/${alertId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  await loadShrinkAlerts()
}

const {
  suppliers,
  purchaseOrders,
  selectedPurchaseOrder,
  newSupplierName,
  supplierSaving,
  poSupplierId,
  poExpectedAt,
  poNotes,
  poLines,
  poSaving,
  poActionId,
  receiveQuantities,
  poMessage,
  loadProcurement,
  createSupplier,
  addPoLine,
  createPurchaseOrder,
  openPurchaseOrder,
  purchaseOrderAction,
  receivePurchaseOrder,
} = useInventoryProcurement({
  canApprove: () => auth.hasPermission('purchase_orders.approve'),
  getItems: () => items.value,
  reloadItems: load,
})

onMounted(async () => {
  await Promise.all([
    load(),
    loadCountSessions(),
    loadReconciliationAlerts(),
    loadShrinkAlerts(),
    loadCatalogueProducts(),
    loadProcurement(),
  ])
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
        sku: newItemSku.value.trim().toUpperCase(),
        name: newItemName.value.trim(),
        category: newItemCategory.value.trim() || 'supplies',
        unit: newItemUnit.value,
        varianceTolerance: Math.max(0, Math.trunc(newVarianceTolerance.value)),
        productId: newItemProductId.value || null,
      }),
    })
    newItemSku.value = ''
    newItemName.value = ''
    newItemCategory.value = 'supplies'
    newItemUnit.value = 'units'
    newItemProductId.value = ''
    await load()
  } catch (e) {
    createItemError.value = e instanceof Error ? e.message : t('inventory.addItemFailed')
  } finally {
    creatingItem.value = false
  }
}

async function recordMovement() {
  if (!selectedItemId.value || delta.value === '') return
  const movementReason =
    reasonKind.value === 'spoilage' ? 'spoilage' : reason.value.trim()
  if (!movementReason) return
  submitting.value = true
  moveError.value = null
  try {
    await api('/api/inventory/movements', {
      method: 'POST',
      body: JSON.stringify({
        itemId: selectedItemId.value,
        delta: Number(delta.value),
        reason: movementReason,
      }),
    })
    delta.value = ''
    reason.value = ''
    reasonKind.value = 'custom'
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
    await Promise.all([load(), loadCountSessions(), loadReconciliationAlerts()])
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
    await Promise.all([load(), loadCountSessions(), loadReconciliationAlerts()])
  } catch (e) {
    countMessage.value = e instanceof Error ? e.message : 'Verify failed'
  } finally {
    verifyingSessionId.value = null
  }
}

async function updateAlert(alertId: string, status: 'acknowledged' | 'resolved') {
  await api(`/api/inventory/reconciliation-alerts/${alertId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  await loadReconciliationAlerts()
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('inventory.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('inventory.subtitle') }}</p>
      <button
        v-if="canWrite && !loading"
        type="button"
        class="mt-3 text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        @click="openOpeningStockModal"
      >
        {{ t('inventory.openingStockBtn') }}
      </button>
      <p v-if="openingMessage" class="mt-2 text-xs text-slate-400">{{ openingMessage }}</p>
    </div>

    <div v-if="loadError && !loading" class="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300" role="alert">
      <p>{{ loadError }}</p>
      <button type="button" class="mt-3 underline" @click="load">{{ t('inventory.tryAgain') }}</button>
    </div>

    <InventoryProcurementSection
      v-if="canWrite && !loading"
      v-model:new-supplier-name="newSupplierName"
      v-model:po-supplier-id="poSupplierId"
      v-model:po-expected-at="poExpectedAt"
      v-model:po-notes="poNotes"
      v-model:po-lines="poLines"
      v-model:receive-quantities="receiveQuantities"
      :is-owner="auth.isOwner"
      :items="items"
      :suppliers="suppliers"
      :purchase-orders="purchaseOrders"
      :selected-purchase-order="selectedPurchaseOrder"
      :supplier-saving="supplierSaving"
      :po-saving="poSaving"
      :po-action-id="poActionId"
      :po-message="poMessage"
      @create-supplier="createSupplier"
      @add-po-line="addPoLine"
      @create-purchase-order="createPurchaseOrder"
      @open-purchase-order="openPurchaseOrder"
      @purchase-order-action="purchaseOrderAction"
      @receive-purchase-order="receivePurchaseOrder"
    />

    <form
      v-if="canWrite && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createItem"
    >
      <h3 class="font-bold text-white text-sm">{{ t('inventory.addItem') }}</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <input
          v-model="newItemSku"
          aria-label="SKU"
          required
          maxlength="40"
          placeholder="SKU"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white uppercase"
        />
        <input
          v-model="newItemName"
          :aria-label="t('inventory.itemName')"
          required
          :placeholder="t('inventory.itemName')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="newItemCategory"
          :aria-label="t('inventory.category')"
          :placeholder="t('inventory.category')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <select
          v-model="newItemUnit"
          :aria-label="t('inventory.unit')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="units">units</option>
          <option value="kg">kg</option>
          <option value="bags">bags</option>
          <option value="liters">liters</option>
          <option value="crates">crates</option>
        </select>
        <select
          v-model="newItemProductId"
          :aria-label="t('inventory.linkedProduct')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white sm:col-span-2 lg:col-span-1"
        >
          <option value="">{{ t('inventory.noProductLink') }}</option>
          <option v-for="p in catalogueProducts" :key="p.id" :value="p.id">
            {{ p.sku }} · {{ p.name }}
          </option>
        </select>
        <input
          v-model.number="newVarianceTolerance"
          aria-label="Count tolerance"
          type="number"
          min="0"
          step="1"
          placeholder="Count tolerance"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creatingItem || !newItemName.trim() || !newItemSku.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creatingItem ? t('inventory.addingItem') : t('inventory.addItemBtn') }}
        </button>
        <p v-if="createItemError" class="text-xs text-red-400">{{ createItemError }}</p>
      </div>
    </form>

    <section
      v-if="canWrite"
      class="mt-8 rounded-xl border border-amber-900/50 bg-amber-950/15 p-5"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="font-bold text-amber-100">{{ t('inventory.shrinkAlertsTitle') }}</h3>
          <p class="mt-1 text-xs text-slate-400">{{ t('inventory.shrinkAlertsDesc') }}</p>
        </div>
        <button
          type="button"
          class="rounded bg-amber-900/40 px-3 py-1.5 text-xs text-amber-100 disabled:opacity-50"
          :disabled="refreshingShrink"
          @click="refreshShrinkAlerts"
        >
          {{ refreshingShrink ? t('inventory.shrinkRefreshing') : t('inventory.shrinkRefresh') }}
        </button>
      </div>
      <div v-if="shrinkAlerts.length" class="mt-4 space-y-3">
        <article
          v-for="alert in shrinkAlerts.slice(0, 12)"
          :key="alert.id"
          class="rounded-lg border border-slate-800 bg-slate-950 p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="font-semibold text-white">{{ alert.sku }} · {{ alert.itemName }}</p>
              <p class="mt-1 text-sm text-slate-300">
                <span v-if="alert.alertType === 'unexplained_out'">
                  {{ t('inventory.unexplainedOut') }}: {{ alert.unexplainedOut }} {{ alert.unit }}
                  (tolerance ±{{ alert.tolerance }})
                </span>
                <span v-else>
                  {{ t('inventory.salesMismatch') }}: sold {{ alert.soldQty }}, stock out
                  {{ alert.qtyOutSale }} {{ alert.unit }}
                </span>
              </p>
              <p class="mt-1 text-xs text-slate-500">
                In {{ alert.qtyIn }} · sale out {{ alert.qtyOutSale }} · other out {{ alert.qtyOutOther }}
                · {{ alert.periodDays }}d window · {{ new Date(alert.createdAt).toLocaleString() }}
              </p>
            </div>
            <div v-if="alert.status !== 'resolved'" class="flex gap-2">
              <button
                v-if="alert.status === 'open'"
                type="button"
                class="rounded bg-amber-900/40 px-3 py-1.5 text-xs text-amber-200"
                @click="updateShrinkAlert(alert.id, 'acknowledged')"
              >
                Acknowledge
              </button>
              <button
                type="button"
                class="rounded bg-farm-green/20 px-3 py-1.5 text-xs text-farm-green"
                @click="updateShrinkAlert(alert.id, 'resolved')"
              >
                Resolve
              </button>
            </div>
            <span v-else class="text-xs font-semibold text-farm-green">Resolved</span>
          </div>
        </article>
      </div>
      <p v-else class="mt-3 text-xs text-slate-500">No open leakage alerts. Run a rescan after sales and stock moves.</p>
    </section>

    <section
      v-if="canWrite && reconciliationAlerts.length"
      class="mt-8 rounded-xl border border-red-900/60 bg-red-950/20 p-5"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="font-bold text-red-200">Inventory reconciliation alerts</h3>
          <p class="mt-1 text-xs text-slate-400">Physical counts outside the allowed SKU tolerance.</p>
        </div>
        <span class="rounded-full bg-red-900/50 px-3 py-1 text-xs font-bold text-red-200">
          {{ reconciliationAlerts.filter((alert) => alert.status !== 'resolved').length }} open
        </span>
      </div>
      <div class="mt-4 space-y-3">
        <article
          v-for="alert in reconciliationAlerts.slice(0, 12)"
          :key="alert.id"
          class="rounded-lg border border-slate-800 bg-slate-950 p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="font-semibold text-white">{{ alert.sku }} · {{ alert.itemName }}</p>
              <p class="mt-1 text-sm text-slate-300">
                Expected {{ alert.expectedQuantity }} {{ alert.unit }}, counted {{ alert.countedQuantity }}.
                <span :class="alert.variance < 0 ? 'text-red-300' : 'text-amber-300'">
                  Variance {{ alert.variance > 0 ? '+' : '' }}{{ alert.variance }}.
                </span>
              </p>
              <p class="mt-1 text-xs text-slate-500">Tolerance ±{{ alert.tolerance }} · {{ new Date(alert.createdAt).toLocaleString() }}</p>
            </div>
            <div v-if="alert.status !== 'resolved'" class="flex gap-2">
              <button
                v-if="alert.status === 'open'"
                type="button"
                class="rounded bg-amber-900/40 px-3 py-1.5 text-xs text-amber-200"
                @click="updateAlert(alert.id, 'acknowledged')"
              >
                Acknowledge
              </button>
              <button
                type="button"
                class="rounded bg-farm-green/20 px-3 py-1.5 text-xs text-farm-green"
                @click="updateAlert(alert.id, 'resolved')"
              >
                Resolve
              </button>
            </div>
            <span v-else class="text-xs font-semibold text-farm-green">Resolved</span>
          </div>
        </article>
      </div>
    </section>

    <div
      v-if="canSubmitCount && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
    >
      <h3 class="font-bold text-white text-sm">
        {{ isFieldWorker ? 'Submit inventory count' : 'Verified inventory count' }}
      </h3>
      <p class="text-xs text-slate-500">
        Submit a count session. Stock only updates after a different Admin/Supervisor verifies it.
      </p>
      <input
        v-model="countLocation"
        aria-label="Count location"
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
            :aria-label="`Count line ${idx + 1} item`"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option v-for="item in items" :key="item.id" :value="item.id">
              {{ item.sku }} · {{ item.name }} ({{ item.quantity }} {{ item.unit }})
            </option>
          </select>
          <input
            v-model.number="line.countedQuantity"
            :aria-label="`Count line ${idx + 1} quantity`"
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
            <span v-if="session.hasVariance" class="ml-2 rounded bg-red-900/40 px-2 py-0.5 text-red-300">Variance</span>
            <span class="text-slate-500">
              · {{ new Date(session.createdAt).toLocaleString() }}
              <template v-if="session.locationText"> · {{ session.locationText }}</template>
            </span>
          </div>
          <div v-if="canWrite && session.status === 'submitted'" class="flex gap-2">
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
      v-if="canWrite && !loading"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="recordMovement"
    >
      <h3 class="font-bold text-white text-sm">{{ t('inventory.recordMovement') }}</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.item') }}</label>
          <select
            v-model="selectedItemId"
            :aria-label="t('inventory.item')"
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option v-for="item in items" :key="item.id" :value="item.id">
              {{ item.sku }} · {{ item.name }} ({{ item.quantity }} {{ item.unit }})
            </option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.delta') }}</label>
          <input
            v-model.number="delta"
            :aria-label="t('inventory.delta')"
            type="number"
            required
            :placeholder="t('inventory.deltaPlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.reasonKind') }}</label>
          <select
            v-model="reasonKind"
            :aria-label="t('inventory.reasonKind')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option value="custom">{{ t('inventory.reasonCustom') }}</option>
            <option value="spoilage">{{ t('inventory.reasonSpoilage') }}</option>
          </select>
        </div>
        <div v-if="reasonKind === 'custom'">
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('inventory.reason') }}</label>
          <input
            v-model="reason"
            :aria-label="t('inventory.reason')"
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
          :disabled="
            submitting ||
            !selectedItemId ||
            delta === '' ||
            (reasonKind === 'custom' && !reason.trim())
          "
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ submitting ? t('inventory.recording') : t('inventory.recordMovementBtn') }}
        </button>
        <p v-if="moveError" class="text-xs text-red-400">{{ moveError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400" role="status" aria-live="polite">{{ t('inventory.loading') }}</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">SKU / {{ t('inventory.item') }}</th>
            <th class="pb-3 font-semibold">{{ t('inventory.linkedProduct') }}</th>
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
            <td class="py-4 font-medium text-white">
              <span class="block font-mono text-[11px] text-farm-green">{{ item.sku }}</span>
              {{ item.name }}
            </td>
            <td class="py-4 text-slate-400 text-xs">
              <span v-if="item.productId">
                <span class="font-mono text-farm-green">{{ item.productSku }}</span>
                · {{ item.productName }}
              </span>
              <span v-else class="text-slate-600">{{ t('inventory.noProductLink') }}</span>
            </td>
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

    <AccessibleDialog :open="openingStockOpen" title-id="opening-stock-title" :close-label="t('dialog.close')" @close="openingStockOpen = false">
      <div class="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 id="opening-stock-title" class="text-white font-bold text-lg">{{ t('inventory.openingStockTitle') }}</h3>
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
    </AccessibleDialog>
  </AppLayout>
</template>
