<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type Batch = {
  id: string
  name: string
  species: string
  headCount: number
  plotName?: string
  acquiredAt: string
  active: boolean
}

type Economics = {
  feedUsedKg: number
  startCount: number
  currentHeadCount: number
  daysSinceStart: number
  estimatedWeightPerBirdKg: number
  weightGainKg: number
  fcr: number | null
  targetCloseoutAt?: string | null
}

type VaccinationEntry = {
  day: number
  name: string
  vaccine: string
  dueDate: string
  status: 'completed' | 'due' | 'upcoming' | 'overdue'
}

type VaccinationSchedule = {
  schedule: VaccinationEntry[]
  completedCount: number
}

type LogType = 'feeding' | 'vaccination' | 'mortality'

const batches = ref<Batch[]>([])
const loading = ref(true)
const logging = ref<string | null>(null)
const logNotes = ref<Record<string, string>>({})
const mortalityCount = ref<Record<string, number>>({})

const expanded = ref<Set<string>>(new Set())
const economics = ref<Record<string, Economics | null>>({})
const vaccination = ref<Record<string, VaccinationSchedule | null>>({})
const detailLoading = ref<Record<string, boolean>>({})
const detailErrors = ref<Record<string, string>>({})

async function load() {
  loading.value = true
  try {
    const data = await api<{ batches: Batch[] }>('/api/livestock/batches')
    batches.value = data.batches.filter((b) => b.active)
  } finally {
    loading.value = false
  }
}

onMounted(load)

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
      detailErrors.value[batchId] = 'Failed to load batch details'
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

const vaccStatusColor: Record<string, string> = {
  completed: 'bg-farm-green/20 text-farm-green',
  due: 'bg-amber-900/40 text-amber-300',
  upcoming: 'bg-slate-700 text-slate-400',
  overdue: 'bg-red-900/40 text-red-300',
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Livestock</h2>
      <p class="text-slate-400 text-sm mt-1">Batches, feeding, vaccination, and mortality logs</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">Loading batches…</div>

    <div v-else-if="batches.length === 0" class="mt-8 text-slate-500">
      No active livestock batches.
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
              {{ batch.headCount }} head · Acquired {{ new Date(batch.acquiredAt).toLocaleDateString() }}
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="toggleDetails(batch.id)"
            >
              {{ isExpanded(batch.id) ? 'Hide details' : 'Economics & vaccines' }}
            </button>
            <span class="text-xs font-bold px-2.5 py-1 rounded-full bg-farm-green/20 text-farm-green">
              Active
            </span>
          </div>
        </div>

        <div
          v-if="isExpanded(batch.id)"
          class="mt-4 pt-4 border-t border-slate-800"
        >
          <div v-if="detailLoading[batch.id]" class="text-sm text-slate-400">Loading details…</div>
          <p v-else-if="detailErrors[batch.id]" class="text-xs text-red-400">{{ detailErrors[batch.id] }}</p>
          <div v-else class="grid gap-4 lg:grid-cols-2">
            <div v-if="economics[batch.id]" class="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
              <h4 class="text-sm font-bold text-white mb-3">Economics</h4>
              <dl class="grid grid-cols-2 gap-2 text-xs">
                <dt class="text-slate-500">Feed used</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.feedUsedKg }} kg</dd>
                <dt class="text-slate-500">Head count</dt>
                <dd class="text-slate-300 font-mono text-right">
                  {{ economics[batch.id]!.currentHeadCount }} / {{ economics[batch.id]!.startCount }}
                </dd>
                <dt class="text-slate-500">Days since start</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.daysSinceStart }}</dd>
                <dt class="text-slate-500">Est. weight / bird</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.estimatedWeightPerBirdKg }} kg</dd>
                <dt class="text-slate-500">Weight gain</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.weightGainKg }} kg</dd>
                <dt class="text-slate-500">FCR</dt>
                <dd class="text-slate-300 font-mono text-right">{{ economics[batch.id]!.fcr ?? '-' }}</dd>
              </dl>
            </div>
            <div v-if="vaccination[batch.id]" class="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
              <h4 class="text-sm font-bold text-white mb-1">
                Vaccination schedule
                <span class="text-xs font-normal text-slate-500">
                  ({{ vaccination[batch.id]!.completedCount }}/{{ vaccination[batch.id]!.schedule.length }} done)
                </span>
              </h4>
              <ul class="mt-3 space-y-2 max-h-48 overflow-auto">
                <li
                  v-for="entry in vaccination[batch.id]!.schedule"
                  :key="entry.day"
                  class="flex items-center justify-between gap-2 text-xs"
                >
                  <span class="text-slate-300">Day {{ entry.day }} - {{ entry.name }}</span>
                  <span
                    class="font-bold px-2 py-0.5 rounded-full capitalize shrink-0"
                    :class="vaccStatusColor[entry.status] ?? 'bg-slate-700 text-slate-400'"
                  >
                    {{ entry.status }}
                  </span>
                </li>
              </ul>
            </div>
            <p
              v-if="!economics[batch.id] && !vaccination[batch.id]"
              class="text-xs text-slate-500 col-span-2"
            >
              No economics or vaccination data available for this batch.
            </p>
          </div>
        </div>

        <div class="mt-4 space-y-3">
          <input
            v-model="logNotes[batch.id]"
            type="text"
            placeholder="Optional notes…"
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
              {{ isLogging(batch.id, logType) ? 'Logging…' : `Log ${logType}` }}
            </button>

            <input
              v-model.number="mortalityCount[batch.id]"
              type="number"
              min="1"
              :max="batch.headCount"
              placeholder="Mortality #"
              class="w-28 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50"
            />
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
