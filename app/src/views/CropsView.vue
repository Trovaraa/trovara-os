<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t, te } = useI18n()

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
const loading = ref(true)
const updating = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const data = await api<{ cropCycles: CropCycle[] }>('/api/crops')
    crops.value = data.cropCycles
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
    <div>
      <h2 class="text-2xl font-black text-white">{{ t('crops.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('crops.subtitle') }}</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('crops.loading') }}</div>

    <div v-else-if="crops.length === 0" class="mt-8 text-slate-500">
      {{ t('crops.empty') }}
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

        <div v-if="nextStage(cycle.stage)" class="mt-4">
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
