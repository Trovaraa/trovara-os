<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t, te } = useI18n()
const auth = useAuthStore()
const canManage = computed(() => auth.canApprove)

type CropCycle = {
  id: string
  plotId: string
  plotName?: string
  cropType: string
  stage: string
  plantedAt: string
  expectedHarvestAt?: string
  actualHarvestAt?: string
  expectedYieldKg?: number
  actualYieldKg?: number
  notes?: string
}

type PlotOption = {
  id: string
  name: string
  zoneName?: string | null
  active?: boolean
}

const STAGE_ORDER = [
  'planted',
  'germination',
  'vegetative',
  'flowering',
  'fruiting',
  'harvest_ready',
  'harvested',
] as const

const crops = ref<CropCycle[]>([])
const plots = ref<PlotOption[]>([])
const loading = ref(true)
const updating = ref<string | null>(null)

const showAdd = ref(false)
const newCropType = ref('')
const newPlotId = ref('')
const newPlantedAt = ref(new Date().toISOString().slice(0, 10))
const newExpectedHarvestAt = ref('')
const newExpectedYieldKg = ref<number | ''>('')
const newNotes = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const activePlots = computed(() => plots.value.filter((p) => p.active !== false))

async function load() {
  loading.value = true
  try {
    const [cropData, plotData] = await Promise.all([
      api<{ cropCycles: CropCycle[] }>('/api/crops'),
      api<{ plots: PlotOption[] }>('/api/zones/plots'),
    ])
    crops.value = cropData.cropCycles
    plots.value = plotData.plots
    if (!newPlotId.value && activePlots.value[0]) {
      newPlotId.value = activePlots.value[0].id
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

function nextStage(stage: string): string | null {
  const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number])
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null
  return STAGE_ORDER[idx + 1]
}

function formatStage(stage: string): string {
  const key = `crops.stage.${stage}`
  return te(key) ? t(key) : stage.replace(/_/g, ' ')
}

function plotLabel(plot: PlotOption): string {
  return plot.zoneName ? `${plot.name} (${plot.zoneName})` : plot.name
}

function resetCreateForm() {
  newCropType.value = ''
  newPlantedAt.value = new Date().toISOString().slice(0, 10)
  newExpectedHarvestAt.value = ''
  newExpectedYieldKg.value = ''
  newNotes.value = ''
  if (activePlots.value[0]) newPlotId.value = activePlots.value[0].id
}

async function createCycle() {
  if (!canManage.value || !newCropType.value.trim() || !newPlotId.value || !newPlantedAt.value) return
  creating.value = true
  createError.value = null
  try {
    await api('/api/crops', {
      method: 'POST',
      body: JSON.stringify({
        cropType: newCropType.value.trim(),
        plotId: newPlotId.value,
        plantedAt: new Date(newPlantedAt.value).toISOString(),
        expectedHarvestAt: newExpectedHarvestAt.value
          ? new Date(newExpectedHarvestAt.value).toISOString()
          : undefined,
        expectedYieldKg:
          newExpectedYieldKg.value === '' ? undefined : Number(newExpectedYieldKg.value),
        notes: newNotes.value.trim() || undefined,
      }),
    })
    resetCreateForm()
    showAdd.value = false
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('crops.createFailed')
  } finally {
    creating.value = false
  }
}

async function advanceStage(id: string, currentStage: string) {
  const next = nextStage(currentStage)
  if (!next) return

  updating.value = id
  try {
    await api(`/api/crops/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: next }),
    })
    await load()
  } finally {
    updating.value = null
  }
}

const stageColor: Record<string, string> = {
  planted: 'bg-amber-900/40 text-amber-300',
  germination: 'bg-lime-900/40 text-lime-300',
  vegetative: 'bg-green-900/40 text-green-300',
  flowering: 'bg-pink-900/40 text-pink-300',
  fruiting: 'bg-orange-900/40 text-orange-300',
  harvest_ready: 'bg-farm-gold/20 text-farm-gold',
  harvested: 'bg-farm-green/20 text-farm-green',
}
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-black text-white">{{ t('crops.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('crops.subtitle') }}</p>
      </div>
      <button
        v-if="canManage"
        type="button"
        class="text-sm px-4 py-2 rounded-lg bg-farm-green text-slate-950 font-bold hover:bg-farm-green/90"
        @click="showAdd = !showAdd"
      >
        {{ showAdd ? t('crops.close') : t('crops.addCycle') }}
      </button>
    </div>

    <form
      v-if="showAdd && canManage"
      class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createCycle"
    >
      <h3 class="font-bold text-white text-sm">{{ t('crops.addCycleTitle') }}</h3>
      <p v-if="activePlots.length === 0" class="text-xs text-amber-300">
        {{ t('crops.needPlots') }}
      </p>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <input
          v-model="newCropType"
          type="text"
          required
          maxlength="100"
          :placeholder="t('crops.cropTypePlaceholder')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
        <select
          v-model="newPlotId"
          required
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        >
          <option disabled value="">{{ t('crops.selectPlot') }}</option>
          <option v-for="plot in activePlots" :key="plot.id" :value="plot.id">
            {{ plotLabel(plot) }}
          </option>
        </select>
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.plantedDate') }}</label>
          <input
            v-model="newPlantedAt"
            type="date"
            required
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.expectedHarvestDate') }}</label>
          <input
            v-model="newExpectedHarvestAt"
            type="date"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <input
          v-model.number="newExpectedYieldKg"
          type="number"
          min="1"
          step="1"
          :placeholder="t('crops.expectedYieldKg')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
        <input
          v-model="newNotes"
          type="text"
          maxlength="2000"
          :placeholder="t('crops.notesOptional')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 sm:col-span-2 lg:col-span-1"
        />
      </div>
      <p v-if="createError" class="text-sm text-red-400">{{ createError }}</p>
      <button
        type="submit"
        class="text-sm px-4 py-2 rounded-lg bg-farm-green text-slate-950 font-bold hover:bg-farm-green/90 disabled:opacity-50"
        :disabled="creating || activePlots.length === 0"
      >
        {{ creating ? t('crops.creating') : t('crops.createCycle') }}
      </button>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('crops.loading') }}</div>

    <div v-else-if="crops.length === 0" class="mt-8 text-slate-500">
      {{ t('crops.empty') }}
      <span v-if="canManage && !showAdd" class="block text-slate-600 text-sm mt-1">
        {{ t('crops.emptyHint') }}
      </span>
    </div>

    <div v-else class="mt-8 space-y-4">
      <div
        v-for="cycle in crops"
        :key="cycle.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-5"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="font-bold text-white capitalize">{{ cycle.cropType }}</h3>
            <p class="text-slate-400 text-sm mt-1">
              <span v-if="cycle.plotName">{{ cycle.plotName }}</span>
              <span v-else class="text-slate-600">{{ t('crops.unassignedPlot') }}</span>
            </p>
            <p class="text-xs text-slate-500 mt-2">
              {{ t('crops.planted') }} {{ new Date(cycle.plantedAt).toLocaleDateString() }}
              <span v-if="cycle.expectedHarvestAt">
                · {{ t('crops.expectedHarvest') }} {{ new Date(cycle.expectedHarvestAt).toLocaleDateString() }}
              </span>
            </p>
            <p v-if="cycle.expectedYieldKg" class="text-xs text-slate-500 mt-1">
              {{ t('crops.expectedYield') }}: {{ cycle.expectedYieldKg }} kg
              <span v-if="cycle.actualYieldKg"> · {{ t('crops.actual') }}: {{ cycle.actualYieldKg }} kg</span>
            </p>
          </div>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full capitalize flex-shrink-0"
            :class="stageColor[cycle.stage] ?? 'bg-slate-700 text-slate-300'"
          >
            {{ formatStage(cycle.stage) }}
          </span>
        </div>

        <div v-if="canManage && nextStage(cycle.stage)" class="mt-4">
          <button
            class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="updating === cycle.id"
            @click="advanceStage(cycle.id, cycle.stage)"
          >
            {{ updating === cycle.id ? t('crops.updating') : t('crops.advanceTo', { stage: formatStage(nextStage(cycle.stage)!) }) }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
