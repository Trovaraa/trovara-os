<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type HarvestLot = {
  id: string
  lotCode: string
  plotName?: string
  productName: string
  quantityKg: number
  harvestedAt: string
  createdAt: string
  publicNotes?: string | null
  internalNotes?: string | null
}

const lots = ref<HarvestLot[]>([])
const loading = ref(true)
const exporting = ref(false)
const exportMessage = ref<string | null>(null)
const qrByLotId = ref<Record<string, { imgUrl: string; url: string }>>({})
const loadingQrFor = ref<string | null>(null)
const creating = ref(false)
const createError = ref<string | null>(null)
const newLotCode = ref('')
const newProductName = ref('')
const newQuantityKg = ref<number | ''>('')
const newPublicNotes = ref('')
const newInternalNotes = ref('')
const editing = ref<HarvestLot | null>(null)
const editPublicNotes = ref('')
const editInternalNotes = ref('')
const savingEdit = ref(false)
const editError = ref<string | null>(null)
const timelineFor = ref<HarvestLot | null>(null)
const timelineLoading = ref(false)
const timelineEvents = ref<Array<{ id: string; type: string; at: string; note?: string }>>([])
const timelineError = ref<string | null>(null)

function publicLotUrl(lotCode: string) {
  return `http://127.0.0.1:5173/lot/${lotCode}`
}

async function load() {
  loading.value = true
  try {
    const data = await api<{ lots: HarvestLot[] }>('/api/traceability')
    lots.value = data.lots
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openEdit(lot: HarvestLot) {
  editing.value = lot
  editPublicNotes.value = lot.publicNotes ?? ''
  editInternalNotes.value = lot.internalNotes ?? ''
  editError.value = null
}

function closeEdit() {
  if (savingEdit.value) return
  editing.value = null
}

async function saveEdit() {
  if (!editing.value) return
  savingEdit.value = true
  editError.value = null
  try {
    await api(`/api/traceability/${editing.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        publicNotes: editPublicNotes.value.trim() || null,
        internalNotes: editInternalNotes.value.trim() || null,
      }),
    })
    editing.value = null
    await load()
  } catch (e) {
    editError.value = e instanceof Error ? e.message : 'Failed to update lot'
  } finally {
    savingEdit.value = false
  }
}

async function createLot() {
  if (!newLotCode.value.trim() || !newProductName.value.trim() || newQuantityKg.value === '') return
  creating.value = true
  createError.value = null
  try {
    await api('/api/traceability', {
      method: 'POST',
      body: JSON.stringify({
        lotCode: newLotCode.value.trim(),
        productName: newProductName.value.trim(),
        quantityKg: Number(newQuantityKg.value),
        publicNotes: newPublicNotes.value.trim() || null,
        internalNotes: newInternalNotes.value.trim() || null,
      }),
    })
    newLotCode.value = ''
    newProductName.value = ''
    newQuantityKg.value = ''
    newPublicNotes.value = ''
    newInternalNotes.value = ''
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : 'Failed to create lot'
  } finally {
    creating.value = false
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
      url: lot ? publicLotUrl(lot.lotCode) : '',
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
    timelineError.value = e instanceof Error ? e.message : 'Failed to load timeline'
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

    exportMessage.value = `Exported ${data.auditChain.length} audit events`
  } catch (e) {
    exportMessage.value = e instanceof Error ? e.message : 'Export failed'
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">Traceability</h2>
        <p class="text-slate-400 text-sm mt-1">Harvest lots and audit chain — owner only</p>
      </div>
      <button
        class="text-sm px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        :disabled="exporting"
        @click="exportAudit"
      >
        {{ exporting ? 'Exporting…' : 'Export audit chain' }}
      </button>
    </div>

    <form class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4" @submit.prevent="createLot">
      <h3 class="font-bold text-white text-sm">Create harvest lot</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <input
          v-model="newLotCode"
          type="text"
          required
          placeholder="Lot code"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="newProductName"
          type="text"
          required
          placeholder="Product name"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model.number="newQuantityKg"
          type="number"
          min="0"
          step="0.01"
          required
          placeholder="Quantity kg"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <textarea
          v-model="newPublicNotes"
          rows="2"
          maxlength="1000"
          placeholder="Public notes (visible on public lot page)"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
        />
        <textarea
          v-model="newInternalNotes"
          rows="2"
          maxlength="1000"
          placeholder="Internal notes (owner/team only)"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
        />
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating"
          class="text-sm px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creating ? 'Creating…' : 'Create lot' }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <p v-if="exportMessage" class="mt-4 text-xs text-slate-400">{{ exportMessage }}</p>

    <div v-if="loading" class="mt-8 text-slate-400">Loading harvest lots…</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">Lot code</th>
            <th class="pb-3 font-semibold">Product</th>
            <th class="pb-3 font-semibold">Plot</th>
            <th class="pb-3 font-semibold">Quantity</th>
            <th class="pb-3 font-semibold">Harvested</th>
            <th class="pb-3 font-semibold">Public link</th>
            <th class="pb-3 font-semibold">QR</th>
            <th class="pb-3 font-semibold">Notes</th>
            <th class="pb-3 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="lot in lots"
            :key="lot.id"
            class="border-b border-slate-800/50"
          >
            <td class="py-4 font-mono font-bold text-farm-gold">{{ lot.lotCode }}</td>
            <td class="py-4 text-white">{{ lot.productName }}</td>
            <td class="py-4 text-slate-400">{{ lot.plotName ?? '—' }}</td>
            <td class="py-4 font-mono text-slate-300">{{ lot.quantityKg }} kg</td>
            <td class="py-4 text-slate-400">
              {{ new Date(lot.harvestedAt).toLocaleDateString() }}
            </td>
            <td class="py-4">
              <a
                :href="publicLotUrl(lot.lotCode)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs font-mono text-farm-green hover:underline break-all"
              >
                {{ publicLotUrl(lot.lotCode) }}
              </a>
            </td>
            <td class="py-4">
              <button
                type="button"
                class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                :disabled="loadingQrFor === lot.id"
                @click="fetchQr(lot.id)"
              >
                {{ loadingQrFor === lot.id ? 'Loading…' : qrByLotId[lot.id] ? 'Refresh QR' : 'Show QR' }}
              </button>
              <div v-if="qrByLotId[lot.id]" class="mt-2 space-y-1">
                <img
                  :src="qrByLotId[lot.id].imgUrl"
                  alt="Lot QR code"
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
              <p><span class="text-slate-500">Public:</span> {{ lot.publicNotes || '—' }}</p>
              <p class="mt-1"><span class="text-slate-500">Internal:</span> {{ lot.internalNotes || '—' }}</p>
            </td>
            <td class="py-4">
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                  @click="openEdit(lot)"
                >
                  Edit notes
                </button>
                <button
                  type="button"
                  class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                  @click="openTimeline(lot)"
                >
                  Timeline
                </button>
                <a
                  :href="`/api/traceability/${lot.id}/certificate.html`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
                >
                  Download certificate
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!lots.length" class="text-slate-500 text-sm mt-4">No harvest lots recorded.</p>
    </div>

    <div
      v-if="editing"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="closeEdit"
    >
      <div class="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Edit lot notes</h3>
        <form class="mt-4 space-y-3" @submit.prevent="saveEdit">
          <textarea
            v-model="editPublicNotes"
            rows="3"
            maxlength="1000"
            placeholder="Public notes"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
          />
          <textarea
            v-model="editInternalNotes"
            rows="3"
            maxlength="1000"
            placeholder="Internal notes"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
          />
          <p v-if="editError" class="text-xs text-red-400">{{ editError }}</p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="text-xs px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="closeEdit"
            >
              Cancel
            </button>
            <button
              type="submit"
              :disabled="savingEdit"
              class="text-xs px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            >
              {{ savingEdit ? 'Saving…' : 'Save notes' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <div
      v-if="timelineFor"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="timelineFor = null"
    >
      <div class="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Lot timeline · {{ timelineFor.lotCode }}</h3>
        <p v-if="timelineLoading" class="mt-4 text-sm text-slate-400">Loading timeline…</p>
        <p v-else-if="timelineError" class="mt-4 text-sm text-red-400">{{ timelineError }}</p>
        <ul v-else class="mt-4 space-y-2 max-h-72 overflow-auto">
          <li
            v-for="event in timelineEvents"
            :key="event.id"
            class="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs"
          >
            <p class="text-slate-200 font-semibold capitalize">{{ event.type.replace('_', ' ') }}</p>
            <p class="text-slate-500 mt-1">{{ new Date(event.at).toLocaleString() }}</p>
            <p v-if="event.note" class="text-slate-400 mt-1">{{ event.note }}</p>
          </li>
          <li v-if="!timelineEvents.length" class="text-xs text-slate-500">No events found for this lot.</li>
        </ul>
      </div>
    </div>
  </AppLayout>
</template>
