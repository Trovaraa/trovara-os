<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

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
    createError.value = e instanceof Error ? e.message : 'Failed to create zone'
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
      <h2 class="text-2xl font-black text-white">Zones &amp; Plots</h2>
      <p class="text-slate-400 text-sm mt-1">Farm layout, planting units, and plot timelines</p>
    </div>

    <form
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createZone"
    >
      <h3 class="font-bold text-white text-sm">New zone</h3>
      <div class="grid sm:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Name</label>
          <input
            v-model="newZoneName"
            type="text"
            required
            maxlength="200"
            placeholder="e.g. North Orchard"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Description</label>
          <input
            v-model="newZoneDescription"
            type="text"
            maxlength="2000"
            placeholder="Optional"
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
          {{ creating ? 'Creating…' : 'Create zone' }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">Loading zones…</div>

    <template v-else>
      <div class="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 class="font-bold text-white mb-4">Zones</h3>
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
          <p v-else class="text-slate-500 text-sm">No zones yet.</p>
        </div>

        <div>
          <h3 class="font-bold text-white mb-4">Plots</h3>
          <p class="text-xs text-slate-500 mb-3">Select a plot to view its activity timeline</p>
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
                {{ plot.zoneName ?? 'No zone' }}
                <span v-if="plot.cropType"> · {{ plot.cropType }}</span>
              </p>
            </button>
          </div>
          <p v-else class="text-slate-500 text-sm">No plots found.</p>
        </div>
      </div>

      <div v-if="selectedPlotId" class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white">
          Timeline - {{ selectedPlotName }}
        </h3>
        <div v-if="timelineLoading" class="mt-4 text-slate-400 text-sm">Loading timeline…</div>
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
              {{ entry.type === 'task' ? 'Task' : entry.eventType ?? 'Event' }}
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
        <p v-else class="mt-4 text-slate-500 text-sm">No timeline events for this plot.</p>
      </div>

      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">Planting units</h3>
        <div v-if="plantingUnits.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-slate-500 border-b border-slate-800">
                <th class="pb-3 font-semibold">Label</th>
                <th class="pb-3 font-semibold">Plot</th>
                <th class="pb-3 font-semibold">Type</th>
                <th class="pb-3 font-semibold">Status</th>
                <th class="pb-3 font-semibold">Planted</th>
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
        <p v-else class="text-slate-500 text-sm">No planting units.</p>
      </div>
    </template>
  </AppLayout>
</template>
