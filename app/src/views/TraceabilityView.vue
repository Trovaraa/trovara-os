<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()

type HarvestLot = {
  id: string
  farmSlug: string
  lotCode: string
  publicToken?: string
  plotId?: string | null
  plotName?: string | null
  zoneName?: string | null
  productName: string
  quantityKg: number
  unit?: string
  harvestedAt: string
  createdAt: string
  publicNotes?: string | null
  internalNotes?: string | null
  photoUrl?: string | null
  verificationStatus: string
  reportedByName?: string | null
  verifiedByName?: string | null
  verifiedAt?: string | null
  orderId?: string | null
  orderReference?: string | null
  orderSource?: string | null
}

type PlotOption = {
  id: string
  name: string
  zoneName?: string | null
}

const auth = useAuthStore()
const isOwner = computed(() => auth.isOwner)
const canManage = computed(() => auth.canApprove)
const canPrintQr = computed(() => auth.canManageOrders)
const verifyingId = ref<string | null>(null)

const lots = ref<HarvestLot[]>([])
const plots = ref<PlotOption[]>([])
const loading = ref(true)
const exporting = ref(false)
const exportMessage = ref<string | null>(null)
const qrByLotId = ref<Record<string, { imgUrl: string; url: string }>>({})
const loadingQrFor = ref<string | null>(null)
const creating = ref(false)
const createError = ref<string | null>(null)
const showStandalone = ref(false)
const newProductName = ref('')
const newQuantityKg = ref<number | ''>('')
const newUnit = ref<'kg' | 'crates'>('kg')
const newPlotId = ref('')
const newPublicNotes = ref('')
const newInternalNotes = ref('')
const newPhoto = ref<string | null>(null)
const editing = ref<HarvestLot | null>(null)
const editProductName = ref('')
const editQuantityKg = ref<number | ''>('')
const editUnit = ref<'kg' | 'crates'>('kg')
const editPlotId = ref('')
const editPublicNotes = ref('')
const editInternalNotes = ref('')
const editPhoto = ref<string | null>(null)
const savingEdit = ref(false)
const editError = ref<string | null>(null)
const timelineFor = ref<HarvestLot | null>(null)
const timelineLoading = ref(false)
const timelineEvents = ref<Array<{ id: string; type: string; at: string; note?: string }>>([])
const timelineError = ref<string | null>(null)

function publicLotUrl(lot: Pick<HarvestLot, 'farmSlug' | 'lotCode' | 'publicToken'>) {
  const base = import.meta.env.VITE_PUBLIC_APP_URL ?? window.location.origin
  const token = lot.publicToken ?? lot.lotCode
  return `${String(base).replace(/\/+$/, '')}/lot/${lot.farmSlug}/${token}`
}

function qtyLabel(lot: Pick<HarvestLot, 'quantityKg' | 'unit'>) {
  return `${lot.quantityKg} ${lot.unit === 'crates' ? 'crates' : 'kg'}`
}

function needsPack(lot: HarvestLot) {
  // Once verified, pack is considered complete — don't keep nagging.
  if (lot.verificationStatus === 'verified') return false
  return !lot.plotId || !lot.photoUrl || lot.verificationStatus === 'reported'
}

async function load() {
  loading.value = true
  try {
    const [lotData, plotData] = await Promise.all([
      api<{ lots: HarvestLot[] }>('/api/traceability'),
      api<{ plots: PlotOption[] }>('/api/zones/plots'),
    ])
    lots.value = lotData.lots
    plots.value = plotData.plots
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openEdit(lot: HarvestLot) {
  editing.value = lot
  editProductName.value = lot.productName
  editQuantityKg.value = lot.quantityKg
  editUnit.value = lot.unit === 'crates' ? 'crates' : 'kg'
  editPlotId.value = lot.plotId ?? ''
  editPublicNotes.value = lot.publicNotes ?? ''
  editInternalNotes.value = lot.internalNotes ?? ''
  editPhoto.value = null
  editError.value = null
}

function closeEdit() {
  if (savingEdit.value) return
  editing.value = null
}

async function saveEdit() {
  if (!editing.value || editQuantityKg.value === '') return
  savingEdit.value = true
  editError.value = null
  try {
    const body: Record<string, unknown> = {
      productName: editProductName.value.trim(),
      quantityKg: Number(editQuantityKg.value),
      unit: editUnit.value,
      plotId: editPlotId.value || null,
      publicNotes: editPublicNotes.value.trim() || null,
    }
    if (canManage.value) {
      body.internalNotes = editInternalNotes.value.trim() || null
    }
    if (editPhoto.value) body.photoUrl = editPhoto.value

    await api(`/api/traceability/${editing.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    editing.value = null
    await load()
  } catch (e) {
    editError.value = e instanceof Error ? e.message : t('trace.updateFailed')
  } finally {
    savingEdit.value = false
  }
}

function onNewPhotoChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) {
    newPhoto.value = null
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    newPhoto.value = typeof reader.result === 'string' ? reader.result : null
  }
  reader.readAsDataURL(file)
}

function onEditPhotoChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) {
    editPhoto.value = null
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    editPhoto.value = typeof reader.result === 'string' ? reader.result : null
  }
  reader.readAsDataURL(file)
}

async function createLot() {
  if (!newProductName.value.trim() || newQuantityKg.value === '') return
  creating.value = true
  createError.value = null
  try {
    await api('/api/traceability', {
      method: 'POST',
      body: JSON.stringify({
        productName: newProductName.value.trim(),
        quantityKg: Number(newQuantityKg.value),
        unit: newUnit.value,
        plotId: newPlotId.value || undefined,
        publicNotes: newPublicNotes.value.trim() || null,
        internalNotes: canManage.value ? newInternalNotes.value.trim() || null : null,
        photoUrl: newPhoto.value,
      }),
    })
    newProductName.value = ''
    newQuantityKg.value = ''
    newUnit.value = 'kg'
    newPlotId.value = ''
    newPublicNotes.value = ''
    newInternalNotes.value = ''
    newPhoto.value = null
    showStandalone.value = false
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('trace.createFailed')
  } finally {
    creating.value = false
  }
}

async function verifyLot(lot: HarvestLot, status: 'verified' | 'rejected') {
  verifyingId.value = lot.id
  try {
    await api(`/api/traceability/${lot.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('trace.verifyFailed')
  } finally {
    verifyingId.value = null
  }
}

function statusMeta(status: string): { label: string; cls: string } {
  switch (status) {
    case 'verified':
      return { label: t('trace.statusVerified'), cls: 'bg-farm-green/20 text-farm-green' }
    case 'rejected':
      return { label: t('trace.statusRejected'), cls: 'bg-red-900/40 text-red-300' }
    default:
      return { label: t('trace.statusAwaiting'), cls: 'bg-amber-500/15 text-amber-300' }
  }
}

function revokeQrBlobUrls() {
  for (const entry of Object.values(qrByLotId.value)) {
    if (entry.imgUrl.startsWith('blob:')) {
      URL.revokeObjectURL(entry.imgUrl)
    }
  }
}

async function fetchQr(lotId: string) {
  loadingQrFor.value = lotId
  try {
    const prev = qrByLotId.value[lotId]
    if (prev?.imgUrl.startsWith('blob:')) {
      URL.revokeObjectURL(prev.imgUrl)
    }

    const res = await fetch(`/api/traceability/${lotId}/qr`, { credentials: 'include' })
    if (!res.ok) throw new Error(`QR request failed (${res.status})`)
    const svg = await res.text()
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const imgUrl = URL.createObjectURL(blob)
    const lot = lots.value.find((row) => row.id === lotId)
    qrByLotId.value[lotId] = {
      imgUrl,
      url: lot ? publicLotUrl(lot) : '',
    }
  } finally {
    loadingQrFor.value = null
  }
}

onUnmounted(revokeQrBlobUrls)

async function openTimeline(lot: HarvestLot) {
  timelineFor.value = lot
  timelineLoading.value = true
  timelineError.value = null
  try {
    const data = await api<{ events: Array<{ id: string; type: string; at: string; note?: string }> }>(
      `/api/traceability/${lot.id}/timeline`,
    )
    timelineEvents.value = data.events
  } catch (e) {
    timelineEvents.value = []
    timelineError.value = e instanceof Error ? e.message : t('trace.timelineFailed')
  } finally {
    timelineLoading.value = false
  }
}

async function exportAudit() {
  exporting.value = true
  exportMessage.value = null
  try {
    const data = await api<{
      exportedAt: string
      harvestLots: HarvestLot[]
      auditChain: unknown[]
    }>('/api/traceability/export')

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `traceability-audit-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)

    exportMessage.value = t('trace.exportedN', { count: data.auditChain.length })
  } catch (e) {
    exportMessage.value = e instanceof Error ? e.message : t('trace.exportFailed')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">{{ t('trace.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">
          {{ t('trace.subtitle') }}
        </p>
        <p class="text-xs text-slate-500 mt-1">
          Customer orders auto-create lots (TRV-ORD-…-001). Pack and enrich them here or via Telegram /lots.
        </p>
      </div>
      <button
        v-if="isOwner"
        class="text-sm px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        :disabled="exporting"
        @click="exportAudit"
      >
        {{ exporting ? t('trace.exporting') : t('trace.exportAudit') }}
      </button>
    </div>

    <div class="mt-6">
      <button
        type="button"
        class="text-xs text-slate-400 hover:text-white underline"
        @click="showStandalone = !showStandalone"
      >
        {{ showStandalone ? 'Hide standalone harvest' : 'Add standalone harvest (no order)' }}
      </button>
    </div>

    <form
      v-if="showStandalone"
      class="mt-3 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createLot"
    >
      <h3 class="font-bold text-white text-sm">Standalone harvest</h3>
      <p class="text-xs text-slate-400">Lot code is generated automatically (LOT-YYYYMMDD-001).</p>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <input
          v-model="newProductName"
          type="text"
          required
          :placeholder="t('trace.productName')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model.number="newQuantityKg"
          type="number"
          min="1"
          step="1"
          required
          placeholder="Quantity"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <select
          v-model="newUnit"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="kg">kg</option>
          <option value="crates">crates</option>
        </select>
        <select
          v-model="newPlotId"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">Plot (optional)</option>
          <option v-for="p in plots" :key="p.id" :value="p.id">
            {{ p.zoneName ? `${p.zoneName} / ` : '' }}{{ p.name }}
          </option>
        </select>
        <textarea
          v-model="newPublicNotes"
          rows="2"
          maxlength="1000"
          :placeholder="t('trace.publicNotesPlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
        />
        <textarea
          v-if="canManage"
          v-model="newInternalNotes"
          rows="2"
          maxlength="1000"
          :placeholder="t('trace.internalNotesPlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
        />
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('trace.photoEvidence') }}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="mt-1 w-full text-xs text-slate-400"
            @change="onNewPhotoChange"
          />
        </label>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating"
          class="text-sm px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creating ? t('trace.creating') : t('trace.createLotBtn') }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <p v-if="exportMessage" class="mt-4 text-xs text-slate-400">{{ exportMessage }}</p>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('trace.loading') }}</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">{{ t('trace.lotCode') }}</th>
            <th class="pb-3 font-semibold">Order</th>
            <th class="pb-3 font-semibold">{{ t('trace.thProduct') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thPlot') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thQuantity') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thHarvested') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thStatus') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thPublicLink') }}</th>
            <th v-if="canPrintQr" class="pb-3 font-semibold">{{ t('trace.thQr') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thNotes') }}</th>
            <th class="pb-3 font-semibold">{{ t('trace.thActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="lot in lots"
            :key="lot.id"
            class="border-b border-slate-800/50"
            :class="needsPack(lot) ? 'bg-amber-500/5' : ''"
          >
            <td class="py-4 font-mono font-bold text-farm-gold">{{ lot.lotCode }}</td>
            <td class="py-4 text-xs text-slate-400">
              <span v-if="lot.orderReference" class="font-mono text-slate-300">{{ lot.orderReference }}</span>
              <span v-else>-</span>
              <span v-if="lot.orderSource" class="block text-[10px] text-slate-500">{{ lot.orderSource }}</span>
            </td>
            <td class="py-4 text-white">{{ lot.productName }}</td>
            <td class="py-4 text-slate-400">
              <span v-if="lot.zoneName">{{ lot.zoneName }} / </span>{{ lot.plotName ?? '-' }}
            </td>
            <td class="py-4 font-mono text-slate-300">{{ qtyLabel(lot) }}</td>
            <td class="py-4 text-slate-400">
              {{ new Date(lot.harvestedAt).toLocaleDateString() }}
            </td>
            <td class="py-4">
              <span
                class="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
                :class="statusMeta(lot.verificationStatus).cls"
              >
                {{ statusMeta(lot.verificationStatus).label }}
              </span>
              <p v-if="needsPack(lot)" class="text-[10px] text-amber-300 mt-1">Needs pack details</p>
              <p v-if="lot.reportedByName" class="text-[10px] text-slate-500 mt-1">
                {{ t('trace.by') }} {{ lot.reportedByName }}
              </p>
            </td>
            <td class="py-4">
              <a
                v-if="lot.verificationStatus === 'verified'"
                :href="publicLotUrl(lot)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs font-mono text-farm-green hover:underline break-all"
              >
                {{ publicLotUrl(lot) }}
              </a>
              <span v-else class="text-xs text-slate-600">{{ t('trace.notPublicYet') }}</span>
            </td>
            <td v-if="canPrintQr" class="py-4">
              <div class="flex flex-col gap-2 items-start">
                <a
                  :href="`/api/traceability/${lot.id}/label.html?autoprint=1`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
                >
                  {{ t('trace.printQr') }}
                </a>
                <button
                  type="button"
                  class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                  :disabled="loadingQrFor === lot.id"
                  @click="fetchQr(lot.id)"
                >
                  {{ loadingQrFor === lot.id ? t('trace.loadingShort') : qrByLotId[lot.id] ? t('trace.refreshQr') : t('trace.showQr') }}
                </button>
              </div>
              <div v-if="qrByLotId[lot.id]" class="mt-2 space-y-1">
                <img
                  :src="qrByLotId[lot.id].imgUrl"
                  :alt="t('trace.lotQrAlt')"
                  class="rounded border border-slate-800 bg-white p-2 h-32 w-32"
                />
                <a
                  :href="qrByLotId[lot.id].url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="block text-[10px] text-farm-green hover:underline break-all"
                >
                  {{ qrByLotId[lot.id].url }}
                </a>
              </div>
            </td>
            <td class="py-4 text-xs text-slate-400">
              <p><span class="text-slate-500">{{ t('trace.publicLabel') }}</span> {{ lot.publicNotes || '-' }}</p>
              <p class="mt-1"><span class="text-slate-500">{{ t('trace.internalLabel') }}</span> {{ lot.internalNotes || '-' }}</p>
            </td>
            <td class="py-4">
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
                  @click="openEdit(lot)"
                >
                  {{ needsPack(lot) ? 'Complete pack' : 'Update lot' }}
                </button>
                <template v-if="canManage && lot.verificationStatus === 'reported'">
                  <button
                    type="button"
                    :disabled="verifyingId === lot.id"
                    class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30 disabled:opacity-50"
                    @click="verifyLot(lot, 'verified')"
                  >
                    {{ t('trace.verify') }}
                  </button>
                  <button
                    type="button"
                    :disabled="verifyingId === lot.id"
                    class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
                    @click="verifyLot(lot, 'rejected')"
                  >
                    {{ t('trace.reject') }}
                  </button>
                </template>
                <button
                  v-if="canManage"
                  type="button"
                  class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                  @click="openTimeline(lot)"
                >
                  {{ t('trace.timeline') }}
                </button>
                <a
                  v-if="canPrintQr"
                  :href="`/api/traceability/${lot.id}/label.html?autoprint=1`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
                >
                  {{ t('trace.printQr') }}
                </a>
                <a
                  v-if="isOwner"
                  :href="`/api/traceability/${lot.id}/certificate.html`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
                >
                  {{ t('trace.downloadCert') }}
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!lots.length" class="text-slate-500 text-sm mt-4">{{ t('trace.noLots') }}</p>
    </div>

    <div
      v-if="editing"
      class="fixed inset-0 z-40 bg-black/60 flex items-end sm:items-center justify-center p-4"
      @click.self="closeEdit"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-3">
        <h3 class="text-white font-bold">Update lot · {{ editing.lotCode }}</h3>
        <p v-if="editing.orderReference" class="text-xs text-slate-400 font-mono">
          Order {{ editing.orderReference }}
          <span v-if="editing.orderSource">({{ editing.orderSource }})</span>
        </p>
        <input
          v-model="editProductName"
          type="text"
          required
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          placeholder="Product"
        />
        <div class="grid grid-cols-2 gap-3">
          <input
            v-model.number="editQuantityKg"
            type="number"
            min="1"
            step="1"
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            placeholder="Quantity"
          />
          <select
            v-model="editUnit"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="kg">kg</option>
            <option value="crates">crates</option>
          </select>
        </div>
        <select
          v-model="editPlotId"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">Plot / block (optional)</option>
          <option v-for="p in plots" :key="p.id" :value="p.id">
            {{ p.zoneName ? `${p.zoneName} / ` : '' }}{{ p.name }}
          </option>
        </select>
        <textarea
          v-model="editPublicNotes"
          rows="2"
          maxlength="1000"
          :placeholder="t('trace.publicNotesPlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
        />
        <textarea
          v-if="canManage"
          v-model="editInternalNotes"
          rows="2"
          maxlength="1000"
          :placeholder="t('trace.internalNotesPlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
        />
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('trace.photoEvidence') }}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="mt-1 w-full text-xs text-slate-400"
            @change="onEditPhotoChange"
          />
          <p v-if="editing.photoUrl && !editPhoto" class="text-[10px] text-slate-500 mt-1">Photo already attached</p>
        </label>
        <p v-if="editError" class="text-xs text-red-400">{{ editError }}</p>
        <div class="flex gap-2 justify-end">
          <button
            type="button"
            class="text-sm px-4 py-2 rounded-lg bg-slate-800 text-slate-300"
            :disabled="savingEdit"
            @click="closeEdit"
          >
            Cancel
          </button>
          <button
            type="button"
            class="text-sm px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green font-semibold disabled:opacity-50"
            :disabled="savingEdit"
            @click="saveEdit"
          >
            {{ savingEdit ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="timelineFor"
      class="fixed inset-0 z-40 bg-black/60 flex items-end sm:items-center justify-center p-4"
      @click.self="timelineFor = null"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-3 max-h-[80vh] overflow-y-auto">
        <h3 class="text-white font-bold text-lg">{{ t('trace.lotTimeline') }} · {{ timelineFor.lotCode }}</h3>
        <p v-if="timelineLoading" class="text-slate-400 text-sm">{{ t('trace.loading') }}</p>
        <p v-else-if="timelineError" class="text-red-400 text-sm">{{ timelineError }}</p>
        <ul v-else class="space-y-2 text-sm">
          <li v-for="ev in timelineEvents" :key="ev.id" class="border-b border-slate-800 pb-2">
            <span class="text-slate-500 text-xs">{{ ev.at }}</span>
            <p class="text-white">{{ ev.type }}</p>
            <p v-if="ev.note" class="text-slate-400 text-xs">{{ ev.note }}</p>
          </li>
          <li v-if="!timelineEvents.length" class="text-slate-500">No events</li>
        </ul>
        <button
          type="button"
          class="text-sm px-4 py-2 rounded-lg bg-slate-800 text-slate-300"
          @click="timelineFor = null"
        >
          Close
        </button>
      </div>
    </div>
  </AppLayout>
</template>
