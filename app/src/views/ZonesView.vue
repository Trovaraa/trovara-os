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
  zoneName?: string | null
  cropType?: string | null
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

const selectedPlotId = ref<string | null>(null)
const timeline = ref<TimelineEntry[]>([])
const timelineLoading = ref(false)

const selectedPlotName = computed(() =>
  plotRows.value.find((p) => p.id === selectedPlotId.value)?.name ?? '',
)

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

async function selectPlot(plotId: string) {
  if (selectedPlotId.value === plotId) {
    selectedPlotId.value = null
    timeline.value = []
    return
  }
  selectedPlotId.value = plotId
  timelineLoading.value = true
  try {
    const data = await api<{ timeline: TimelineEntry[] }>(`/api/zones/plots/${plotId}/timeline`)
    timeline.value = data.timeline
  } catch {
    timeline.value = []
  } finally {
    timelineLoading.value = false
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

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('zones.loading') }}</div>

    <template v-else>
      <div class="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 class="font-bold text-white mb-4">{{ t('zones.zones') }}</h3>
          <div v-if="zones.length" class="space-y-3">
            <div
              v-for="zone in zones"
              :key="zone.id"
              class="bg-slate-900 border border-slate-800 rounded-xl p-4"
            >
              <h4 class="font-bold text-white">{{ zone.name }}</h4>
              <p v-if="zone.description" class="text-slate-400 text-sm mt-1">{{ zone.description }}</p>
            </div>
          </div>
          <p v-else class="text-slate-500 text-sm">{{ t('zones.noZones') }}</p>
        </div>

        <div>
          <h3 class="font-bold text-white mb-4">{{ t('zones.plots') }}</h3>
          <p class="text-xs text-slate-500 mb-3">{{ t('zones.selectPlot') }}</p>
          <div v-if="plotRows.length" class="space-y-2">
            <button
              v-for="plot in plotRows"
              :key="plot.id"
              type="button"
              class="w-full text-left bg-slate-900 border rounded-xl p-4 transition-colors"
              :class="selectedPlotId === plot.id
                ? 'border-farm-green/50 bg-farm-green/5'
                : 'border-slate-800 hover:border-slate-700'"
              @click="selectPlot(plot.id)"
            >
              <p class="font-bold text-white">{{ plot.name }}</p>
              <p class="text-xs text-slate-500 mt-1">
                {{ plot.zoneName ?? t('zones.noZone') }}
                <span v-if="plot.cropType"> · {{ plot.cropType }}</span>
              </p>
            </button>
          </div>
          <p v-else class="text-slate-500 text-sm">{{ t('zones.noPlots') }}</p>
        </div>
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
                <th class="pb-3 font-semibold">{{ t('zones.plot') }}</th>
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
