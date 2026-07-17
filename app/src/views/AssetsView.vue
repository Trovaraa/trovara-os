<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()

function categoryLabel(category: string): string {
  return t(`assets.cat.${category}`)
}

function conditionLabel(cond: string): string {
  return t(`assets.cond.${cond}`)
}

type AssetLog = {
  id: string
  logDate: string
  countAvailable: number
  countDamaged: number
  condition: string
  note: string | null
  photoUrl?: string | null
  recordedById: string
  recordedByName: string | null
  verificationStatus: string
  verifiedById?: string | null
  verifiedAt: string | null
  createdAt: string
}

type Asset = {
  id: string
  name: string
  category: string
  unit: string
  quantityOwned: number
  assignedToId: string | null
  assignedToName: string | null
  notes: string | null
  active: boolean
  createdAt: string
  latestLog: AssetLog | null
  loggedToday: boolean
  verifiedToday: boolean
}

const CATEGORY_OPTIONS = ['ppe', 'tool', 'vehicle', 'irrigation', 'other']
const CONDITION_OPTIONS = ['good', 'fair', 'damaged']

const auth = useAuthStore()
const canManage = computed(() => auth.canApprove)

const assets = ref<Asset[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// Add asset (managers)
const showAdd = ref(false)
const newName = ref('')
const newCategory = ref('tool')
const newUnit = ref('unit')
const newQty = ref<number | ''>('')
const creating = ref(false)

// Log-today modal
const logging = ref<Asset | null>(null)
const logAvailable = ref<number | ''>('')
const logDamaged = ref<number | ''>(0)
const logCondition = ref('good')
const logNote = ref('')
const logPhoto = ref<string | null>(null)
const savingLog = ref(false)

// History / verify modal
const detail = ref<Asset | null>(null)
const detailLogs = ref<AssetLog[]>([])
const detailLoading = ref(false)

function categoryClass(category: string): string {
  switch (category) {
    case 'ppe':
      return 'bg-amber-500/15 text-amber-300'
    case 'tool':
      return 'bg-farm-green/15 text-farm-green'
    case 'vehicle':
      return 'bg-blue-500/15 text-blue-300'
    case 'irrigation':
      return 'bg-cyan-500/15 text-cyan-300'
    default:
      return 'bg-slate-700/40 text-slate-300'
  }
}

function statusBadge(asset: Asset): { label: string; cls: string } {
  if (!asset.loggedToday) return { label: t('assets.notLoggedToday'), cls: 'bg-slate-700/40 text-slate-400' }
  if (asset.latestLog?.verificationStatus === 'rejected')
    return { label: t('assets.rejected'), cls: 'bg-red-900/40 text-red-300' }
  if (asset.verifiedToday) return { label: t('assets.verifiedToday'), cls: 'bg-farm-green/20 text-farm-green' }
  return { label: t('assets.awaitingVerification'), cls: 'bg-amber-500/15 text-amber-300' }
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ assets: Asset[] }>('/api/assets')
    assets.value = data.assets
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('assets.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function createAsset() {
  if (!newName.value.trim()) return
  creating.value = true
  error.value = null
  try {
    await api('/api/assets', {
      method: 'POST',
      body: JSON.stringify({
        name: newName.value.trim(),
        category: newCategory.value,
        unit: newUnit.value.trim() || 'unit',
        quantityOwned: newQty.value === '' ? 0 : Number(newQty.value),
      }),
    })
    newName.value = ''
    newQty.value = ''
    newCategory.value = 'tool'
    newUnit.value = 'unit'
    showAdd.value = false
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('assets.addFailed')
  } finally {
    creating.value = false
  }
}

function openLog(asset: Asset) {
  logging.value = asset
  logAvailable.value = asset.quantityOwned
  logDamaged.value = 0
  logCondition.value = 'good'
  logNote.value = ''
  logPhoto.value = null
}

function onPhotoChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) {
    logPhoto.value = null
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    logPhoto.value = typeof reader.result === 'string' ? reader.result : null
  }
  reader.readAsDataURL(file)
}

async function submitLog() {
  if (!logging.value || logAvailable.value === '') return
  savingLog.value = true
  error.value = null
  try {
    await api(`/api/assets/${logging.value.id}/logs`, {
      method: 'POST',
      body: JSON.stringify({
        countAvailable: Number(logAvailable.value),
        countDamaged: logDamaged.value === '' ? 0 : Number(logDamaged.value),
        condition: logCondition.value,
        note: logNote.value.trim() || null,
        photoUrl: logPhoto.value,
      }),
    })
    logging.value = null
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('assets.saveLogFailed')
  } finally {
    savingLog.value = false
  }
}

async function openDetail(asset: Asset) {
  detail.value = asset
  detailLogs.value = []
  detailLoading.value = true
  try {
    const data = await api<{ logs: AssetLog[] }>(`/api/assets/${asset.id}/logs`)
    detailLogs.value = data.logs
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('assets.loadHistoryFailed')
  } finally {
    detailLoading.value = false
  }
}

async function verifyLog(log: AssetLog, status: 'verified' | 'rejected') {
  error.value = null
  try {
    await api(`/api/assets/logs/${log.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
    if (detail.value) await openDetail(detail.value)
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('assets.verifyFailed')
  }
}

function logSummary(log: AssetLog | null): string {
  if (!log) return t('assets.noLogsYet')
  const parts = [t('assets.nAvailable', { count: log.countAvailable })]
  if (log.countDamaged > 0) parts.push(t('assets.nDamaged', { count: log.countDamaged }))
  parts.push(conditionLabel(log.condition))
  return parts.join(' · ')
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">{{ t('assets.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">
          {{ t('assets.subtitle') }}
        </p>
      </div>
      <button
        v-if="canManage"
        class="shrink-0 px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30"
        @click="showAdd = !showAdd"
      >
        {{ showAdd ? t('assets.close') : t('assets.addAsset') }}
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>

    <!-- Add asset -->
    <div v-if="showAdd && canManage" class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 class="font-bold text-white text-sm">{{ t('assets.addAnAsset') }}</h3>
      <div class="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <input
          v-model="newName"
          :placeholder="t('assets.namePlaceholder')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <select
          v-model="newCategory"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option v-for="cat in CATEGORY_OPTIONS" :key="cat" :value="cat">{{ categoryLabel(cat) }}</option>
        </select>
        <input
          v-model="newUnit"
          :placeholder="t('assets.unit')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model.number="newQty"
          type="number"
          min="0"
          :placeholder="t('assets.qtyOwned')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <button
          :disabled="creating || !newName.trim()"
          class="px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
          @click="createAsset"
        >
          {{ creating ? t('assets.adding') : t('assets.add') }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('assets.loading') }}</div>

    <div v-else-if="!assets.length" class="mt-8 text-slate-500 text-sm">
      {{ t('assets.empty') }}
    </div>

    <div v-else class="mt-6 space-y-3">
      <div
        v-for="a in assets"
        :key="a.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-4"
        :class="{ 'opacity-50': !a.active }"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <p class="font-semibold text-white truncate">{{ a.name }}</p>
              <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full" :class="categoryClass(a.category)">
                {{ categoryLabel(a.category) }}
              </span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full" :class="statusBadge(a).cls">
                {{ statusBadge(a).label }}
              </span>
            </div>
            <p class="text-xs text-slate-400 mt-1">
              {{ t('assets.owns') }} {{ a.quantityOwned }} {{ a.unit }}<span v-if="a.assignedToName"> · {{ t('assets.assignedTo') }} {{ a.assignedToName }}</span>
            </p>
            <p class="text-xs text-slate-500 mt-0.5">
              {{ t('assets.latest') }} {{ logSummary(a.latestLog) }}
              <span v-if="a.latestLog?.recordedByName"> - {{ a.latestLog.recordedByName }}</span>
            </p>
          </div>
          <div class="flex flex-col gap-2 flex-shrink-0">
            <button
              class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
              @click="openLog(a)"
            >
              {{ t('assets.logToday') }}
            </button>
            <button
              class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"
              @click="openDetail(a)"
            >
              {{ t('assets.history') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Log-today modal -->
    <div
      v-if="logging"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="logging = null"
    >
      <div class="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6">
        <h3 class="font-bold text-white">{{ t('assets.logToday') }} - {{ logging.name }}</h3>
        <div class="mt-4 space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="text-xs text-slate-400">{{ t('assets.available') }}</span>
              <input
                v-model.number="logAvailable"
                type="number"
                min="0"
                class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </label>
            <label class="block">
              <span class="text-xs text-slate-400">{{ t('assets.damaged') }}</span>
              <input
                v-model.number="logDamaged"
                type="number"
                min="0"
                class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </label>
          </div>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('assets.condition') }}</span>
            <select
              v-model="logCondition"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option v-for="cond in CONDITION_OPTIONS" :key="cond" :value="cond">{{ conditionLabel(cond) }}</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('assets.noteOptional') }}</span>
            <textarea
              v-model="logNote"
              rows="2"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('assets.photoOptional') }}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              class="mt-1 w-full text-xs text-slate-400"
              @change="onPhotoChange"
            />
          </label>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <button
            class="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700"
            @click="logging = null"
          >
            {{ t('assets.cancel') }}
          </button>
          <button
            :disabled="savingLog || logAvailable === ''"
            class="px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
            @click="submitLog"
          >
            {{ savingLog ? t('assets.saving') : t('assets.saveLog') }}
          </button>
        </div>
      </div>
    </div>

    <!-- History / verify modal -->
    <div
      v-if="detail"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="detail = null"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-6 max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-white">{{ detail.name }} - {{ t('assets.logHistory') }}</h3>
          <button class="text-slate-400 hover:text-white" @click="detail = null">✕</button>
        </div>
        <div v-if="detailLoading" class="mt-4 text-slate-400 text-sm">{{ t('assets.loadingShort') }}</div>
        <div v-else-if="!detailLogs.length" class="mt-4 text-slate-500 text-sm">{{ t('assets.noLogs') }}</div>
        <div v-else class="mt-4 space-y-2">
          <div
            v-for="log in detailLogs"
            :key="log.id"
            class="bg-slate-950 border border-slate-800 rounded-lg p-3"
          >
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm text-white">{{ logSummary(log) }}</p>
              <span
                class="text-[10px] font-bold px-2 py-0.5 rounded-full"
                :class="{
                  'bg-farm-green/20 text-farm-green': log.verificationStatus === 'verified',
                  'bg-amber-500/15 text-amber-300': log.verificationStatus === 'reported',
                  'bg-red-900/40 text-red-300': log.verificationStatus === 'rejected',
                }"
              >
                {{ log.verificationStatus }}
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-1">
              {{ formatDate(log.logDate) }}<span v-if="log.recordedByName"> · {{ log.recordedByName }}</span>
            </p>
            <p v-if="log.note" class="text-xs text-slate-400 mt-1">{{ log.note }}</p>
            <img
              v-if="log.photoUrl"
              :src="log.photoUrl"
              :alt="t('assets.evidence')"
              class="mt-2 max-h-40 rounded-lg border border-slate-800"
            />
            <div v-if="canManage && log.verificationStatus === 'reported'" class="mt-2 flex gap-2">
              <button
                class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
                @click="verifyLog(log, 'verified')"
              >
                {{ t('assets.verify') }}
              </button>
              <button
                class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60"
                @click="verifyLog(log, 'rejected')"
              >
                {{ t('assets.reject') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
