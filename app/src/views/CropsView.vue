<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useAgronomySkipText, type AgronomySkipReason } from '@/composables/useAgronomySkipText'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t, te } = useI18n()
const { agronomySkipText } = useAgronomySkipText()
const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission?.('crops.manage') ?? auth.canApprove)

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
  standCount?: number
  costCentre?: string
  notes?: string
}

type PlotOption = {
  id: string
  name: string
  zoneName?: string | null
  plantCount?: number | null
  active?: boolean
}

type CostCentre = { code: string; name: string; covers: string }

type LifecycleStage = {
  id: string
  stage: string
  durationDays: number
  source: string
  startsOn: string
  endsOn: string
}

type LifecycleTask = {
  id: string
  stage: string
  offsetDays: number
  templateName: string
  description: string | null
  defaultDurationHours: number | null
  source: string
  dueDate: string | null
}

/**
 * This cycle's own stage lengths and the work inside them, dated from the day it
 * was planted. `expectedHarvestAt` is derived from these durations and is not
 * the date the farmer set on the cycle; the two can legitimately disagree.
 */
type Lifecycle = {
  generated: boolean
  agronomySkipReason: AgronomySkipReason | null
  expectedHarvestAt: string | null
  totalDays: number | null
  stages: LifecycleStage[]
  tasks: LifecycleTask[]
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
const costCentres = ref<CostCentre[]>([])
const loading = ref(true)
const updating = ref<string | null>(null)

const expanded = ref<Set<string>>(new Set())
const lifecycles = ref<Record<string, Lifecycle>>({})
const lifecycleLoading = ref<Record<string, boolean>>({})
const lifecycleErrors = ref<Record<string, string>>({})

const showAdd = ref(false)
const newCropType = ref('')
const newPlotId = ref('')
const newPlantedAt = ref(new Date().toISOString().slice(0, 10))
const newExpectedHarvestAt = ref('')
const newExpectedYieldKg = ref<number | ''>('')
const newStandCount = ref<number | ''>('')
const newCostCentre = ref('')
const newNotes = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const activePlots = computed(() => plots.value.filter((p) => p.active !== false))
function costCentreLabel(code: string) {
  const key = `finance.costCentreNames.${code}`
  const translated = t(key)
  const fallback = costCentres.value.find((costCentre) => costCentre.code === code)?.name ?? code
  return `${code} · ${translated === key ? fallback : translated}`
}

watch(newPlotId, (plotId) => {
  const plot = plots.value.find((item) => item.id === plotId)
  newStandCount.value = plot?.plantCount && plot.plantCount > 0 ? plot.plantCount : ''
})

async function load() {
  loading.value = true
  try {
    const [cropData, plotData, costCentreData] = await Promise.all([
      api<{ cropCycles: CropCycle[] }>('/api/crops'),
      api<{ plots: PlotOption[] }>('/api/zones/plots'),
      api<{ costCentres: CostCentre[] }>('/api/finance/cost-centres'),
    ])
    crops.value = cropData.cropCycles
    plots.value = plotData.plots
    costCentres.value = costCentreData.costCentres
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
  newStandCount.value = ''
  newCostCentre.value = ''
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
        standCount: newStandCount.value === '' ? undefined : Number(newStandCount.value),
        costCentre: newCostCentre.value.trim() || undefined,
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

async function toggleLifecycle(cycleId: string) {
  if (expanded.value.has(cycleId)) {
    expanded.value.delete(cycleId)
    return
  }
  expanded.value.add(cycleId)

  if (lifecycles.value[cycleId]) return

  lifecycleLoading.value[cycleId] = true
  lifecycleErrors.value[cycleId] = ''
  try {
    lifecycles.value[cycleId] = await api<Lifecycle>(`/api/crops/${cycleId}/lifecycle`)
  } catch {
    lifecycleErrors.value[cycleId] = t('crops.lifecycleFailed')
  } finally {
    lifecycleLoading.value[cycleId] = false
  }
}

function isExpanded(cycleId: string): boolean {
  return expanded.value.has(cycleId)
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
        <h2 class="text-2xl font-black text-os-fg">{{ t('crops.title') }}</h2>
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
      <p class="text-xs text-slate-400">
        {{ t('crops.savedBlocksHelp') }}
        <RouterLink to="/zones" class="font-semibold text-farm-green hover:underline">
          {{ t('crops.manageBlocks') }}
        </RouterLink>
      </p>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.cropType') }}</label>
          <input
            v-model="newCropType"
            type="text"
            required
            maxlength="100"
            :placeholder="t('crops.cropTypePlaceholder')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.blockField') }}</label>
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
        </div>
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
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.expectedYieldKg') }}</label>
          <input
            v-model.number="newExpectedYieldKg"
            type="number"
            min="1"
            step="1"
            :placeholder="t('crops.expectedYieldKg')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.numberOfStands') }}</label>
          <input
            v-model.number="newStandCount"
            type="number"
            min="1"
            step="1"
            :placeholder="t('crops.standsPlaceholder')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
          <p class="mt-1 text-[11px] text-slate-500">{{ t('crops.standsHelp') }}</p>
        </div>
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.costCentre') }}</label>
          <select
            v-model="newCostCentre"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          >
            <option value="">{{ t('crops.costCentrePlaceholder') }}</option>
            <option v-for="costCentre in costCentres" :key="costCentre.code" :value="costCentre.code">
              {{ costCentreLabel(costCentre.code) }}
            </option>
          </select>
          <p class="mt-1 text-[11px] text-slate-500">{{ t('crops.costCentreHelp') }}</p>
        </div>
        <div class="sm:col-span-2 lg:col-span-1">
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('crops.notesOptional') }}</label>
          <input
            v-model="newNotes"
            type="text"
            maxlength="2000"
            :placeholder="t('crops.notesOptional')"
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
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
            <p v-if="cycle.standCount || cycle.costCentre" class="text-xs text-slate-500 mt-1">
              <span v-if="cycle.standCount">
                {{ t('crops.stands', { count: cycle.standCount }) }}
              </span>
              <span v-if="cycle.standCount && cycle.costCentre"> · </span>
              <span v-if="cycle.costCentre">
                {{ t('crops.costCentre') }}: {{ costCentreLabel(cycle.costCentre) }}
              </span>
            </p>
          </div>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full capitalize flex-shrink-0"
            :class="stageColor[cycle.stage] ?? 'bg-slate-700 text-slate-300'"
          >
            {{ formatStage(cycle.stage) }}
          </span>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="toggleLifecycle(cycle.id)"
          >
            {{ isExpanded(cycle.id) ? t('crops.hideLifecycle') : t('crops.lifecycle') }}
          </button>
          <button
            v-if="canManage && nextStage(cycle.stage)"
            class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="updating === cycle.id"
            @click="advanceStage(cycle.id, cycle.stage)"
          >
            {{ updating === cycle.id ? t('crops.updating') : t('crops.advanceTo', { stage: formatStage(nextStage(cycle.stage)!) }) }}
          </button>
        </div>

        <div v-if="isExpanded(cycle.id)" class="mt-4 pt-4 border-t border-slate-800">
          <div v-if="lifecycleLoading[cycle.id]" class="text-sm text-slate-400">
            {{ t('crops.loadingLifecycle') }}
          </div>
          <p v-else-if="lifecycleErrors[cycle.id]" class="text-xs text-red-400">
            {{ lifecycleErrors[cycle.id] }}
          </p>
          <template v-else-if="lifecycles[cycle.id]">
            <p v-if="!lifecycles[cycle.id]!.generated" class="text-xs text-slate-500">
              {{ t('crops.noLifecycle') }}
              {{ agronomySkipText(lifecycles[cycle.id]!.agronomySkipReason) }}
            </p>
            <div v-else class="grid gap-4 lg:grid-cols-2">
              <div class="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                <h4 class="text-sm font-bold text-white mb-1">
                  {{ t('crops.lifecycleStages') }}
                  <span class="text-xs font-normal text-slate-500">
                    {{ t('templates.daysTotal', { days: lifecycles[cycle.id]!.totalDays }) }}
                  </span>
                </h4>
                <p v-if="lifecycles[cycle.id]!.expectedHarvestAt" class="text-xs text-slate-500">
                  {{ t('crops.harvestOpens') }}
                  {{ new Date(lifecycles[cycle.id]!.expectedHarvestAt!).toLocaleDateString() }}
                </p>
                <ul class="mt-3 space-y-2 max-h-48 overflow-auto">
                  <li
                    v-for="stage in lifecycles[cycle.id]!.stages"
                    :key="stage.id"
                    class="flex items-center justify-between gap-2 text-xs"
                  >
                    <span class="text-slate-300 capitalize">{{ formatStage(stage.stage) }}</span>
                    <span class="text-slate-500 shrink-0">
                      {{ new Date(stage.startsOn).toLocaleDateString() }} · {{ stage.durationDays }}d
                    </span>
                  </li>
                </ul>
              </div>
              <div class="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                <h4 class="text-sm font-bold text-white mb-1">{{ t('crops.lifecycleWork') }}</h4>
                <p v-if="lifecycles[cycle.id]!.tasks.length === 0" class="mt-3 text-xs text-slate-500">
                  {{ t('crops.noLifecycleWork') }}
                </p>
                <ul v-else class="mt-3 space-y-2 max-h-48 overflow-auto">
                  <li v-for="task in lifecycles[cycle.id]!.tasks" :key="task.id" class="text-xs">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-slate-300">{{ task.templateName }}</span>
                      <span v-if="task.dueDate" class="text-slate-500 shrink-0">
                        {{ new Date(task.dueDate).toLocaleDateString() }}
                      </span>
                    </div>
                    <p class="text-slate-500 capitalize">{{ formatStage(task.stage) }}</p>
                  </li>
                </ul>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
