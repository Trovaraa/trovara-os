<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

type Zone = {
  id: string
  name: string
  description?: string | null
  createdAt: string
}

type PlantingUnit = {
  id: string
  plotId: string
  plotName?: string | null
  label: string
  unitType: string
  status: string
  plantedAt?: string | null
}

type PlotRow = {
  id: string
  name: string
  code?: string | null
  notes?: string | null
  zoneId?: string | null
  zoneName?: string | null
  cropType?: string | null
  areaAcres?: string | null
  active?: boolean
  latitude?: string | null
  longitude?: string | null
}

type TimelineEntry = {
  id: string
  type: 'task' | 'farm_event'
  title: string
  status?: string | null
  eventType?: string | null
  createdAt: string
}

const zones = ref<Zone[]>([])
const plantingUnits = ref<PlantingUnit[]>([])
const plotRows = ref<PlotRow[]>([])
const loading = ref(true)

const newZoneName = ref('')
const newZoneDescription = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const newBlockZoneId = ref('')
const newBlockName = ref('')
const newBlockCode = ref('')
const newBlockNotes = ref('')
const newBlockArea = ref('')
const creatingBlock = ref(false)
const createBlockError = ref<string | null>(null)

const selectedPlotId = ref<string | null>(null)
const timeline = ref<TimelineEntry[]>([])
const timelineLoading = ref(false)
const archivingId = ref<string | null>(null)

type CensusSurvey = {
  id: string
  cropType: string
  plantCount: number
  minHeight?: number | null
  maxHeight?: number | null
  heightUnit: string
  verificationStatus: string
  surveyedAt: string
}

const censusSurveys = ref<CensusSurvey[]>([])
const censusCurrent = ref<CensusSurvey[]>([])
const censusLoading = ref(false)
const censusCropType = ref('plantain')
const censusPlantCount = ref<number | ''>('')
const censusMinHeight = ref<number | ''>('')
const censusMaxHeight = ref<number | ''>('')
const censusHeightUnit = ref<'cm' | 'm'>('cm')
const censusSaving = ref(false)
const censusError = ref<string | null>(null)
const verifyingCensusId = ref<string | null>(null)

const selectedPlotName = computed(() =>
  plotRows.value.find((p) => p.id === selectedPlotId.value)?.name ?? '',
)

const blocksByZone = computed(() => {
  return zones.value.map((zone) => ({
    zone,
    blocks: plotRows.value.filter((p) => p.zoneId === zone.id),
  }))
})

async function load() {
  loading.value = true
  try {
    const [zoneData, plotData, unitData] = await Promise.all([
      api<{ zones: Zone[] }>('/api/zones'),
      api<{ plots: PlotRow[] }>('/api/zones/plots'),
      api<{ plantingUnits: PlantingUnit[] }>('/api/zones/planting-units'),
    ])
    zones.value = zoneData.zones
    plantingUnits.value = unitData.plantingUnits
    plotRows.value = plotData.plots
    if (!newBlockZoneId.value && zones.value[0]) {
      newBlockZoneId.value = zones.value[0].id
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function createZone() {
  if (!newZoneName.value.trim()) return
  creating.value = true
  createError.value = null
  try {
    await api('/api/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: newZoneName.value.trim(),
        description: newZoneDescription.value.trim() || undefined,
      }),
    })
    newZoneName.value = ''
    newZoneDescription.value = ''
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('zones.createFailed')
  } finally {
    creating.value = false
  }
}

async function createBlock() {
  if (!newBlockZoneId.value || !newBlockName.value.trim()) return
  creatingBlock.value = true
  createBlockError.value = null
  try {
    await api('/api/zones/plots', {
      method: 'POST',
      body: JSON.stringify({
        zoneId: newBlockZoneId.value,
        name: newBlockName.value.trim(),
        code: newBlockCode.value.trim() || undefined,
        notes: newBlockNotes.value.trim() || undefined,
        areaAcres: newBlockArea.value.trim() || undefined,
      }),
    })
    newBlockName.value = ''
    newBlockCode.value = ''
    newBlockNotes.value = ''
    newBlockArea.value = ''
    await load()
  } catch (e) {
    createBlockError.value = e instanceof Error ? e.message : t('zones.createBlockFailed')
  } finally {
    creatingBlock.value = false
  }
}

async function archiveBlock(plotId: string) {
  archivingId.value = plotId
  try {
    await api(`/api/zones/plots/${plotId}/archive`, { method: 'POST', body: '{}' })
    if (selectedPlotId.value === plotId) {
      selectedPlotId.value = null
      timeline.value = []
    }
    await load()
  } finally {
    archivingId.value = null
  }
}

async function loadPlotDetails(plotId: string) {
  timelineLoading.value = true
  censusLoading.value = true
  try {
    const [timelineData, censusData, currentData] = await Promise.all([
      api<{ timeline: TimelineEntry[] }>(`/api/zones/plots/${plotId}/timeline`),
      api<{ surveys: CensusSurvey[] }>(`/api/census/plots/${plotId}`),
      api<{ surveys: CensusSurvey[] }>(`/api/census/plots/${plotId}/current`),
    ])
    timeline.value = timelineData.timeline
    censusSurveys.value = censusData.surveys
    censusCurrent.value = currentData.surveys
  } catch {
    timeline.value = []
    censusSurveys.value = []
    censusCurrent.value = []
  } finally {
    timelineLoading.value = false
    censusLoading.value = false
  }
}

async function selectPlot(plotId: string) {
  if (selectedPlotId.value === plotId) {
    selectedPlotId.value = null
    timeline.value = []
    censusSurveys.value = []
    censusCurrent.value = []
    return
  }
  selectedPlotId.value = plotId
  await loadPlotDetails(plotId)
}

async function submitCensus() {
  if (!selectedPlotId.value || censusPlantCount.value === '') return
  censusSaving.value = true
  censusError.value = null
  try {
    await api('/api/census', {
      method: 'POST',
      body: JSON.stringify({
        plotId: selectedPlotId.value,
        cropType: censusCropType.value.trim(),
        plantCount: Number(censusPlantCount.value),
        minHeight: censusMinHeight.value === '' ? null : Number(censusMinHeight.value),
        maxHeight: censusMaxHeight.value === '' ? null : Number(censusMaxHeight.value),
        heightUnit: censusHeightUnit.value,
      }),
    })
    censusPlantCount.value = ''
    censusMinHeight.value = ''
    censusMaxHeight.value = ''
    await loadPlotDetails(selectedPlotId.value)
  } catch (e) {
    censusError.value = e instanceof Error ? e.message : t('zones.censusFailed')
  } finally {
    censusSaving.value = false
  }
}

async function verifyCensus(surveyId: string, status: 'verified' | 'rejected') {
  verifyingCensusId.value = surveyId
  try {
    await api(`/api/census/${surveyId}/verify`, {
      method: 'POST',
      body: JSON.stringify({
        status,
        rejectionReason: status === 'rejected' ? 'Needs recount' : undefined,
      }),
    })
    if (selectedPlotId.value) await loadPlotDetails(selectedPlotId.value)
  } finally {
    verifyingCensusId.value = null
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">{{ t('zones.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('zones.subtitle') }}</p>
    </div>

    <form
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createZone"
    >
      <h3 class="font-bold text-white text-sm">{{ t('zones.newZone') }}</h3>
      <div class="grid sm:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.name') }}</label>
          <input
            v-model="newZoneName"
            type="text"
            required
            maxlength="200"
            :placeholder="t('zones.namePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.description') }}</label>
          <input
            v-model="newZoneDescription"
            type="text"
            maxlength="2000"
            :placeholder="t('zones.optional')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating || !newZoneName.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creating ? t('zones.creating') : t('zones.createZone') }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <form
      class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createBlock"
    >
      <h3 class="font-bold text-white text-sm">{{ t('zones.newBlock') }}</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.zone') }}</label>
          <select
            v-model="newBlockZoneId"
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option v-for="zone in zones" :key="zone.id" :value="zone.id">{{ zone.name }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.blockName') }}</label>
          <input
            v-model="newBlockName"
            type="text"
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.blockCode') }}</label>
          <input
            v-model="newBlockCode"
            type="text"
            :placeholder="t('zones.blockCodePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.area') }}</label>
          <input
            v-model="newBlockArea"
            type="text"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div class="sm:col-span-2">
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('zones.notes') }}</label>
          <input
            v-model="newBlockNotes"
            type="text"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creatingBlock || !zones.length"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creatingBlock ? t('zones.creatingBlock') : t('zones.createBlock') }}
        </button>
        <p v-if="createBlockError" class="text-xs text-red-400">{{ createBlockError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('zones.loading') }}</div>

    <template v-else>
      <div class="mt-8 space-y-6">
        <div v-for="group in blocksByZone" :key="group.zone.id" class="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h3 class="font-bold text-white">{{ group.zone.name }}</h3>
          <p v-if="group.zone.description" class="text-slate-400 text-sm mt-1">{{ group.zone.description }}</p>
          <div v-if="group.blocks.length" class="mt-4 space-y-2">
            <div
              v-for="plot in group.blocks"
              :key="plot.id"
              class="flex flex-col sm:flex-row sm:items-center gap-3 border border-slate-800 rounded-xl p-4"
              :class="selectedPlotId === plot.id ? 'border-farm-green/50 bg-farm-green/5' : ''"
            >
              <button type="button" class="text-left flex-1" @click="selectPlot(plot.id)">
                <p class="font-bold text-white">
                  {{ plot.name }}
                  <span v-if="plot.code" class="ml-2 text-xs text-slate-500">{{ plot.code }}</span>
                </p>
                <p class="text-xs text-slate-500 mt-1">
                  <span v-if="plot.areaAcres">{{ plot.areaAcres }} acres</span>
                  <span v-if="plot.cropType"> · {{ plot.cropType }}</span>
                </p>
              </button>
              <button
                type="button"
                class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                :disabled="archivingId === plot.id"
                @click="archiveBlock(plot.id)"
              >
                {{ archivingId === plot.id ? '…' : t('zones.archiveBlock') }}
              </button>
            </div>
          </div>
          <p v-else class="mt-3 text-slate-500 text-sm">{{ t('zones.noBlocksInZone') }}</p>
        </div>
        <p v-if="!zones.length" class="text-slate-500 text-sm">{{ t('zones.noZones') }}</p>
      </div>

      <div v-if="selectedPlotId" class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white">{{ t('zones.censusTitle') }} — {{ selectedPlotName }}</h3>
        <div v-if="censusLoading" class="mt-3 text-slate-400 text-sm">{{ t('zones.loading') }}</div>
        <template v-else>
          <div v-if="censusCurrent.length" class="mt-3 space-y-1 text-sm text-slate-300">
            <p class="text-xs text-slate-500 uppercase tracking-wide">{{ t('zones.censusCurrent') }}</p>
            <p v-for="s in censusCurrent" :key="s.id">
              {{ s.cropType }}: {{ s.plantCount }}
              <span v-if="s.minHeight != null || s.maxHeight != null">
                · {{ s.minHeight ?? '?' }}–{{ s.maxHeight ?? '?' }} {{ s.heightUnit }}
              </span>
            </p>
          </div>
          <form class="mt-4 grid sm:grid-cols-2 lg:grid-cols-5 gap-3" @submit.prevent="submitCensus">
            <input
              v-model="censusCropType"
              type="text"
              required
              :placeholder="t('zones.censusCropType')"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              v-model="censusPlantCount"
              type="number"
              min="0"
              required
              :placeholder="t('zones.censusPlantCount')"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              v-model="censusMinHeight"
              type="number"
              min="0"
              step="any"
              :placeholder="t('zones.censusMinHeight')"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              v-model="censusMaxHeight"
              type="number"
              min="0"
              step="any"
              :placeholder="t('zones.censusMaxHeight')"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <select
              v-model="censusHeightUnit"
              class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="cm">cm</option>
              <option value="m">m</option>
            </select>
            <button
              type="submit"
              :disabled="censusSaving"
              class="sm:col-span-2 lg:col-span-5 text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            >
              {{ censusSaving ? t('zones.censusSaving') : t('zones.censusSubmit') }}
            </button>
          </form>
          <p v-if="censusError" class="mt-2 text-xs text-red-400">{{ censusError }}</p>
          <div v-if="censusSurveys.length" class="mt-4 space-y-2">
            <p class="text-xs text-slate-500 uppercase tracking-wide">{{ t('zones.censusHistory') }}</p>
            <div
              v-for="s in censusSurveys.slice(0, 8)"
              :key="s.id"
              class="flex flex-wrap items-center justify-between gap-2 border border-slate-800 rounded-lg px-3 py-2 text-sm"
            >
              <span class="text-slate-300">
                {{ s.cropType }} · {{ s.plantCount }} · {{ s.verificationStatus }}
              </span>
              <div v-if="s.verificationStatus === 'reported'" class="flex gap-2">
                <button
                  type="button"
                  class="text-xs px-2 py-1 rounded bg-farm-green/20 text-farm-green"
                  :disabled="verifyingCensusId === s.id"
                  @click="verifyCensus(s.id, 'verified')"
                >
                  {{ t('zones.censusVerify') }}
                </button>
                <button
                  type="button"
                  class="text-xs px-2 py-1 rounded bg-red-900/40 text-red-300"
                  :disabled="verifyingCensusId === s.id"
                  @click="verifyCensus(s.id, 'rejected')"
                >
                  {{ t('zones.censusReject') }}
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div v-if="selectedPlotId" class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white">
          {{ t('zones.timeline') }} - {{ selectedPlotName }}
        </h3>
        <div v-if="timelineLoading" class="mt-4 text-slate-400 text-sm">{{ t('zones.loadingTimeline') }}</div>
        <div v-else-if="timeline.length" class="mt-4 space-y-3">
          <div
            v-for="entry in timeline"
            :key="`${entry.type}-${entry.id}`"
            class="flex items-start gap-3 border-b border-slate-800/50 pb-3 last:border-0"
          >
            <span
              class="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded shrink-0"
              :class="entry.type === 'task' ? 'bg-blue-900/40 text-blue-300' : 'bg-purple-900/40 text-purple-300'"
            >
              {{ entry.type === 'task' ? t('zones.task') : entry.eventType ?? t('zones.event') }}
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-sm text-white">{{ entry.title }}</p>
              <p class="text-xs text-slate-500 mt-1">
                {{ new Date(entry.createdAt).toLocaleString() }}
                <span v-if="entry.status"> · {{ entry.status.replace('_', ' ') }}</span>
              </p>
            </div>
          </div>
        </div>
        <p v-else class="mt-4 text-slate-500 text-sm">{{ t('zones.noTimeline') }}</p>
      </div>

      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">{{ t('zones.plantingUnits') }}</h3>
        <div v-if="plantingUnits.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-slate-500 border-b border-slate-800">
                <th class="pb-3 font-semibold">{{ t('zones.label') }}</th>
                <th class="pb-3 font-semibold">{{ t('zones.block') }}</th>
                <th class="pb-3 font-semibold">{{ t('zones.type') }}</th>
                <th class="pb-3 font-semibold">{{ t('zones.status') }}</th>
                <th class="pb-3 font-semibold">{{ t('zones.planted') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="unit in plantingUnits"
                :key="unit.id"
                class="border-b border-slate-800/50"
              >
                <td class="py-4 font-medium text-white">{{ unit.label }}</td>
                <td class="py-4 text-slate-400">{{ unit.plotName ?? '-' }}</td>
                <td class="py-4 text-slate-400">{{ unit.unitType.replace(/_/g, ' ') }}</td>
                <td class="py-4 text-slate-400 capitalize">{{ unit.status }}</td>
                <td class="py-4 text-slate-400">
                  {{ unit.plantedAt ? new Date(unit.plantedAt).toLocaleDateString() : '-' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-slate-500 text-sm">{{ t('zones.noPlantingUnits') }}</p>
      </div>
    </template>
  </AppLayout>
</template>
