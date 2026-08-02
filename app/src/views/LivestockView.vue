<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useAgronomySkipText, type AgronomySkipReason } from '@/composables/useAgronomySkipText'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const { agronomySkipText } = useAgronomySkipText()
const auth = useAuthStore()
const canManage = computed(() => auth.canApprove)

type Batch = {
  id: string
  name: string
  species: string
  headCount: number
  plotName?: string
  acquiredAt: string
  active: boolean
}

type PlotOption = {
  id: string
  name: string
  zoneName?: string | null
  active?: boolean
}

type Economics = {
  feedUsedKg: number
  startCount: number
  currentHeadCount: number
  daysSinceStart: number
  estimatedWeightPerBirdKg: number | null
  weightGainKg: number | null
  fcr: number | null
  targetCloseoutAt?: string | null
}

type VaccinationEntry = {
  day: number
  name: string
  vaccine: string | null
  dueDate: string
  status: 'completed' | 'due' | 'upcoming' | 'overdue'
}

type VaccinationSchedule = {
  schedule: VaccinationEntry[]
  completedCount: number
  agronomySkipReason: AgronomySkipReason | null
}

type LogType = 'feeding' | 'vaccination' | 'mortality'

const batches = ref<Batch[]>([])
const plots = ref<PlotOption[]>([])
const loading = ref(true)
const logging = ref<string | null>(null)
const logNotes = ref<Record<string, string>>({})
const mortalityCount = ref<Record<string, number>>({})

const expanded = ref<Set<string>>(new Set())
const economics = ref<Record<string, Economics | null>>({})
const vaccination = ref<Record<string, VaccinationSchedule | null>>({})
const detailLoading = ref<Record<string, boolean>>({})
const detailErrors = ref<Record<string, string>>({})

const showAdd = ref(false)
const newName = ref('')
const newSpecies = ref('')
const newHeadCount = ref<number | ''>('')
const newPlotId = ref('')
const newAcquiredAt = ref(new Date().toISOString().slice(0, 10))
const newNotes = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const activePlots = computed(() => plots.value.filter((p) => p.active !== false))

async function load() {
  loading.value = true
  try {
    const [batchData, plotData] = await Promise.all([
      api<{ batches: Batch[] }>('/api/livestock/batches'),
      api<{ plots: PlotOption[] }>('/api/zones/plots'),
    ])
    batches.value = batchData.batches.filter((b) => b.active)
    plots.value = plotData.plots
  } finally {
    loading.value = false
  }
}

onMounted(load)

function plotLabel(plot: PlotOption): string {
  return plot.zoneName ? `${plot.name} (${plot.zoneName})` : plot.name
}

function resetCreateForm() {
  newName.value = ''
  newSpecies.value = ''
  newHeadCount.value = ''
  newPlotId.value = ''
  newAcquiredAt.value = new Date().toISOString().slice(0, 10)
  newNotes.value = ''
}

async function createBatch() {
  if (!canManage.value || !newName.value.trim() || !newSpecies.value.trim()) return
  if (newHeadCount.value === '' || Number(newHeadCount.value) < 1) return
  if (!newAcquiredAt.value) return

  creating.value = true
  createError.value = null
  try {
    await api('/api/livestock/batches', {
      method: 'POST',
      body: JSON.stringify({
        name: newName.value.trim(),
        species: newSpecies.value.trim(),
        headCount: Number(newHeadCount.value),
        plotId: newPlotId.value || undefined,
        acquiredAt: new Date(newAcquiredAt.value).toISOString(),
        notes: newNotes.value.trim() || undefined,
      }),
    })
    resetCreateForm()
    showAdd.value = false
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('livestock.createFailed')
  } finally {
    creating.value = false
  }
}

async function toggleDetails(batchId: string) {
  if (expanded.value.has(batchId)) {
    expanded.value.delete(batchId)
    return
  }
  expanded.value.add(batchId)

  if (economics.value[batchId] !== undefined) return

  detailLoading.value[batchId] = true
  detailErrors.value[batchId] = ''
  try {
    const [econData, vaccResult] = await Promise.allSettled([
      api<Economics>(`/api/livestock/batches/${batchId}/economics`),
      api<VaccinationSchedule>(`/api/livestock/batches/${batchId}/vaccination-schedule`),
    ])
    economics.value[batchId] = econData.status === 'fulfilled' ? econData.value : null
    vaccination.value[batchId] = vaccResult.status === 'fulfilled' ? vaccResult.value : null
    if (econData.status === 'rejected' && vaccResult.status === 'rejected') {
      detailErrors.value[batchId] = t('livestock.detailsFailed')
    }
  } finally {
    detailLoading.value[batchId] = false
  }
}

async function submitLog(batchId: string, logType: LogType) {
  logging.value = `${batchId}-${logType}`
  try {
    const body: { logType: LogType; notes?: string; headCount?: number } = {
      logType,
      notes: logNotes.value[batchId] || undefined,
    }
    if (logType === 'mortality') {
      const count = mortalityCount.value[batchId]
      if (!count || count < 1) return
      body.headCount = count
    }

    await api(`/api/livestock/batches/${batchId}/logs`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    logNotes.value[batchId] = ''
    mortalityCount.value[batchId] = 0
    delete economics.value[batchId]
    delete vaccination.value[batchId]
    await load()
  } finally {
    logging.value = null
  }
}

function isLogging(batchId: string, logType: LogType): boolean {
  return logging.value === `${batchId}-${logType}`
}

function isExpanded(batchId: string): boolean {
  return expanded.value.has(batchId)
}

const logButtonClass: Record<LogType, string> = {
  feeding: 'bg-blue-900/40 text-blue-300 hover:bg-blue-900/60',
  vaccination: 'bg-purple-900/40 text-purple-300 hover:bg-purple-900/60',
  mortality: 'bg-red-900/40 text-red-300 hover:bg-red-900/60',
}

/**
 * A batch whose growth curve nobody has established has no weight to show. The
 * API sends null rather than a default so the farmer is not given a projection
 * that was never made for their birds, and '-' is how that reads.
 */
function weightLabel(value: number | null): string {
  return value == null ? '-' : `${value} kg`
}

const vaccStatusColor: Record<string, string> = {
  completed: 'bg-farm-green/20 text-farm-green',
  due: 'bg-amber-900/40 text-amber-300',
  upcoming: 'bg-slate-700 text-slate-400',
  overdue: 'bg-red-900/40 text-red-300',
}
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('livestock.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('livestock.subtitle') }}</p>
      </div>
      <button
        v-if="canManage"
        type="button"
        class="text-sm px-4 py-2 rounded-lg bg-farm-green text-slate-950 font-bold hover:bg-farm-green/90"
        @click="showAdd = !showAdd"
      >
        {{ showAdd ? t('livestock.close') : t('livestock.addBatch') }}
      </button>
    </div>

    <form
      v-if="showAdd && canManage"
      class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createBatch"
    >
      <h3 class="font-bold text-white text-sm">{{ t('livestock.addBatchTitle') }}</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <input
          v-model="newName"
          type="text"
          required
          maxlength="200"
          :placeholder="t('livestock.namePlaceholder')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
        <input
          v-model="newSpecies"
          type="text"
          required
          maxlength="100"
          :placeholder="t('livestock.speciesPlaceholder')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
        <input
          v-model.number="newHeadCount"
          type="number"
          required
          min="1"
          step="1"
          :placeholder="t('livestock.headCountPlaceholder')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
        <select
          v-model="newPlotId"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
        >
          <option value="">{{ t('livestock.plotOptional') }}</option>
          <option v-for="plot in activePlots" :key="plot.id" :value="plot.id">
            {{ plotLabel(plot) }}
          </option>
        </select>
        <div>
          <label class="block text-[11px] text-slate-500 mb-1">{{ t('livestock.acquiredDate') }}</label>
          <input
            v-model="newAcquiredAt"
            type="date"
            required
            class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <input
          v-model="newNotes"
          type="text"
          maxlength="2000"
          :placeholder="t('livestock.notesOptional')"
          class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <p v-if="createError" class="text-sm text-red-400">{{ createError }}</p>
      <button
        type="submit"
        class="text-sm px-4 py-2 rounded-lg bg-farm-green text-slate-950 font-bold hover:bg-farm-green/90 disabled:opacity-50"
        :disabled="creating"
      >
        {{ creating ? t('livestock.creating') : t('livestock.createBatch') }}
      </button>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('livestock.loading') }}</div>

    <div v-else-if="batches.length === 0" class="mt-8 text-slate-500">
      {{ t('livestock.empty') }}
      <span v-if="canManage && !showAdd" class="block text-slate-600 text-sm mt-1">
        {{ t('livestock.emptyHint') }}
      </span>
    </div>

    <div v-else class="mt-8 space-y-4">
      <div
        v-for="batch in batches"
        :key="batch.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-5"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="font-bold text-white">{{ batch.name }}</h3>
            <p class="text-slate-400 text-sm mt-1 capitalize">
              {{ batch.species }}
              <span v-if="batch.plotName"> · {{ batch.plotName }}</span>
            </p>
            <p class="text-xs text-slate-500 mt-2">
              {{ batch.headCount }} {{ t('livestock.head') }} · {{ t('livestock.acquired') }} {{ new Date(batch.acquiredAt).toLocaleDateString() }}
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="toggleDetails(batch.id)"
            >
              {{ isExpanded(batch.id) ? t('livestock.hideDetails') : t('livestock.econVaccines') }}
            </button>
            <span class="text-xs font-bold px-2.5 py-1 rounded-full bg-farm-green/20 text-farm-green">
              {{ t('livestock.active') }}
            </span>
          </div>
        </div>

        <div
          v-if="isExpanded(batch.id)"
          class="mt-4 pt-4 border-t border-slate-800"
        >
          <div v-if="detailLoading[batch.id]" class="text-sm text-slate-400">{{ t('livestock.loadingDetails') }}</div>
          <p v-else-if="detailErrors[batch.id]" class="text-xs text-red-400">{{ detailErrors[batch.id] }}</p>
          <div v-else class="grid gap-4 lg:grid-cols-2">
            <div v-if="economics[batch.id]" class="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
              <h4 class="text-sm font-bold text-white mb-3">{{ t('livestock.economics') }}</h4>
              <dl class="grid grid-cols-2 gap-2 text-xs">
                <dt class="text-slate-500">{{ t('livestock.feedUsed') }}</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.feedUsedKg }} kg</dd>
                <dt class="text-slate-500">{{ t('livestock.headCount') }}</dt>
                <dd class="text-slate-300 font-mono text-right">
                  {{ economics[batch.id]!.currentHeadCount }} / {{ economics[batch.id]!.startCount }}
                </dd>
                <dt class="text-slate-500">{{ t('livestock.daysSinceStart') }}</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.daysSinceStart }}</dd>
                <dt class="text-slate-500">{{ t('livestock.estWeight') }}</dt>
                <dd class="text-slate-300 font-mono text-right">{{ weightLabel(economics[batch.id]!.estimatedWeightPerBirdKg) }}</dd>
                <dt class="text-slate-500">{{ t('livestock.weightGain') }}</dt>
                <dd class="text-slate-300 font-mono text-right">{{ weightLabel(economics[batch.id]!.weightGainKg) }}</dd>
                <dt class="text-slate-500">{{ t('livestock.fcr') }}</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.fcr ?? '-' }}</dd>
              </dl>
            </div>
            <div v-if="vaccination[batch.id]" class="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
              <h4 class="text-sm font-bold text-white mb-1">
                {{ t('livestock.vaccSchedule') }}
                <span class="text-xs font-normal text-slate-500">
                  {{ t('livestock.vaccDone', { done: vaccination[batch.id]!.completedCount, total: vaccination[batch.id]!.schedule.length }) }}
                </span>
              </h4>
              <p
                v-if="vaccination[batch.id]!.schedule.length === 0"
                class="mt-3 text-xs text-slate-500"
              >
                {{ t('livestock.vaccNone') }}
                {{ agronomySkipText(vaccination[batch.id]!.agronomySkipReason) }}
              </p>
              <ul v-else class="mt-3 space-y-2 max-h-48 overflow-auto">
                <li
                  v-for="entry in vaccination[batch.id]!.schedule"
                  :key="entry.day"
                  class="flex items-center justify-between gap-2 text-xs"
                >
                  <span class="text-slate-300">{{ t('livestock.day') }} {{ entry.day }} - {{ entry.name }}</span>
                  <span
                    class="font-bold px-2 py-0.5 rounded-full capitalize shrink-0"
                    :class="vaccStatusColor[entry.status] ?? 'bg-slate-700 text-slate-400'"
                  >
                    {{ t(`livestock.vaccStatus.${entry.status}`) }}
                  </span>
                </li>
              </ul>
            </div>
            <p
              v-if="!economics[batch.id] && !vaccination[batch.id]"
              class="text-xs text-slate-500 col-span-2"
            >
              {{ t('livestock.noData') }}
            </p>
          </div>
        </div>

        <div class="mt-4 space-y-3">
          <input
            v-model="logNotes[batch.id]"
            type="text"
            :placeholder="t('livestock.notesPlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-farm-green/50"
          />

          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="logType in (['feeding', 'vaccination', 'mortality'] as LogType[])"
              :key="logType"
              class="text-xs px-3 py-1.5 rounded-lg capitalize disabled:opacity-50"
              :class="logButtonClass[logType]"
              :disabled="isLogging(batch.id, logType)"
              @click="submitLog(batch.id, logType)"
            >
              {{ isLogging(batch.id, logType) ? t('livestock.logging') : `${t('livestock.logPrefix')} ${t(`livestock.logType.${logType}`)}` }}
            </button>

            <input
              v-model.number="mortalityCount[batch.id]"
              type="number"
              min="1"
              :max="batch.headCount"
              :placeholder="t('livestock.mortalityPlaceholder')"
              class="w-28 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50"
            />
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
