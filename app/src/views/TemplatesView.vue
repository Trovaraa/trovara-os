<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useAgronomySkipText, type AgronomySkipReason } from '@/composables/useAgronomySkipText'
import { api } from '@/lib/api'

const { t } = useI18n()
const { agronomySkipText } = useAgronomySkipText()

type TaskTemplate = {
  id: string
  name: string
  description?: string | null
  cropType?: string | null
  checklist?: string[] | null
  defaultDurationHours?: number | null
  actionType?: string | null
  createdAt: string
}

type Schedule = {
  id: string
  templateId: string
  templateName?: string | null
  recurrence: string
  assignedToName?: string | null
  plotName?: string | null
  active: boolean
  nextRunAt?: string | null
}

/**
 * One entry per crop cycle, not per crop: these are the stage lengths the farm
 * is actually working to, so two plantain blocks planted a month apart are two
 * rows that can legitimately disagree.
 */
type Lifecycle = {
  cropCycleId: string
  cropType: string
  plantedAt: string
  plotName: string | null
  totalDays: number
  stages: { stage: string; durationDays: number; source: string }[]
}

type CropCycle = {
  id: string
  cropType: string
  plotName?: string | null
  agronomySkipReason: AgronomySkipReason | null
}

const templates = ref<TaskTemplate[]>([])
const schedules = ref<Schedule[]>([])
const lifecycles = ref<Lifecycle[]>([])
/** Cycles missing from the list above, each carrying why it has no lifecycle. */
const skippedCycles = ref<CropCycle[]>([])
const loading = ref(true)

const newName = ref('')
const newDescription = ref('')
const newCropType = ref('')
const newDurationHours = ref<number | ''>('')
const newChecklistText = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const generating = ref(false)
const generateMessage = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const [tplData, schedData, lifeData, cropData] = await Promise.all([
      api<{ templates: TaskTemplate[] }>('/api/templates/templates'),
      api<{ schedules: Schedule[] }>('/api/templates/schedules'),
      api<{ lifecycles: Lifecycle[] }>('/api/templates/lifecycles'),
      api<{ cropCycles: CropCycle[] }>('/api/crops'),
    ])
    templates.value = tplData.templates
    schedules.value = schedData.schedules
    lifecycles.value = lifeData.lifecycles
    // A cycle listed above has a lifecycle and nothing to explain, whatever the
    // last generation attempt on it recorded.
    const listed = new Set(lifeData.lifecycles.map((lc) => lc.cropCycleId))
    skippedCycles.value = cropData.cropCycles.filter(
      (cycle) => cycle.agronomySkipReason && !listed.has(cycle.id),
    )
  } finally {
    loading.value = false
  }
}

onMounted(load)

function parseChecklist(text: string): string[] | undefined {
  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30)
  return items.length ? items : undefined
}

async function createTemplate() {
  if (!newName.value.trim()) return
  creating.value = true
  createError.value = null
  try {
    const hours =
      newDurationHours.value === '' ? undefined : Math.max(1, Math.trunc(Number(newDurationHours.value)))
    await api('/api/templates/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: newName.value.trim(),
        description: newDescription.value.trim() || undefined,
        cropType: newCropType.value.trim() || undefined,
        defaultDurationHours: hours,
        checklist: parseChecklist(newChecklistText.value),
      }),
    })
    newName.value = ''
    newDescription.value = ''
    newCropType.value = ''
    newDurationHours.value = ''
    newChecklistText.value = ''
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : t('templates.createFailed')
  } finally {
    creating.value = false
  }
}

async function generateTasks() {
  generating.value = true
  generateMessage.value = null
  try {
    const data = await api<{ count: number }>('/api/templates/generate-tasks', { method: 'POST' })
    generateMessage.value = t('templates.generatedN', { count: data.count })
    await load()
  } catch (e) {
    generateMessage.value = e instanceof Error ? e.message : t('templates.generateFailed')
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('templates.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('templates.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50 shrink-0"
        :disabled="generating"
        @click="generateTasks"
      >
        {{ generating ? t('templates.generating') : t('templates.generateDueTasks') }}
      </button>
    </div>

    <p v-if="generateMessage" class="mt-4 text-xs text-slate-400">{{ generateMessage }}</p>

    <form
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createTemplate"
    >
      <h3 class="font-bold text-white text-sm">{{ t('templates.newTemplateTitle') }}</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('templates.nameLabel') }}</label>
          <input
            v-model="newName"
            type="text"
            required
            maxlength="200"
            :placeholder="t('templates.namePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('templates.cropTypeLabel') }}</label>
          <input
            v-model="newCropType"
            type="text"
            maxlength="100"
            :placeholder="t('templates.cropTypePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('templates.durationLabel') }}</label>
          <input
            v-model.number="newDurationHours"
            type="number"
            min="1"
            step="1"
            :placeholder="t('templates.durationPlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('templates.descriptionLabel') }}</label>
          <input
            v-model="newDescription"
            type="text"
            maxlength="2000"
            :placeholder="t('templates.descriptionPlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('templates.checklistLabel') }}</label>
        <textarea
          v-model="newChecklistText"
          rows="3"
          maxlength="4000"
          :placeholder="t('templates.checklistPlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 resize-y"
        />
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating || !newName.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creating ? t('templates.creating') : t('templates.createTemplate') }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('templates.loading') }}</div>

    <template v-else>
      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">{{ t('templates.templatesSection') }}</h3>
        <div v-if="templates.length" class="space-y-3">
          <div
            v-for="tpl in templates"
            :key="tpl.id"
            class="bg-slate-900 border border-slate-800 rounded-xl p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <h4 class="font-bold text-white">{{ tpl.name }}</h4>
                <p v-if="tpl.description" class="text-slate-400 text-sm mt-1">{{ tpl.description }}</p>
                <p
                  v-if="tpl.cropType || tpl.defaultDurationHours"
                  class="text-xs text-slate-500 mt-2"
                >
                  <span v-if="tpl.cropType" class="capitalize">{{ tpl.cropType }}</span>
                  <span v-if="tpl.cropType && tpl.defaultDurationHours"> · </span>
                  <span v-if="tpl.defaultDurationHours">
                    {{ t('templates.defaultDuration', { hours: tpl.defaultDurationHours }) }}
                  </span>
                </p>
              </div>
            </div>
            <ul v-if="tpl.checklist?.length" class="mt-3 text-xs text-slate-400 list-disc list-inside space-y-1">
              <li v-for="(item, i) in tpl.checklist" :key="i">{{ item }}</li>
            </ul>
          </div>
        </div>
        <p v-else class="text-slate-500 text-sm">{{ t('templates.noTemplatesYet') }}</p>
      </div>

      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">{{ t('templates.recurringSchedules') }}</h3>
        <div v-if="schedules.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-slate-500 border-b border-slate-800">
                <th class="pb-3 font-semibold">{{ t('templates.thTemplate') }}</th>
                <th class="pb-3 font-semibold">{{ t('templates.thRecurrence') }}</th>
                <th class="pb-3 font-semibold">{{ t('templates.thPlot') }}</th>
                <th class="pb-3 font-semibold">{{ t('templates.thAssignee') }}</th>
                <th class="pb-3 font-semibold">{{ t('templates.thNextRun') }}</th>
                <th class="pb-3 font-semibold">{{ t('templates.thStatus') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="sched in schedules"
                :key="sched.id"
                class="border-b border-slate-800/50"
              >
                <td class="py-4 text-white">{{ sched.templateName ?? '-' }}</td>
                <td class="py-4 text-slate-400 capitalize">{{ sched.recurrence.replace('_', ' ') }}</td>
                <td class="py-4 text-slate-400">{{ sched.plotName ?? '-' }}</td>
                <td class="py-4 text-slate-400">{{ sched.assignedToName ?? '-' }}</td>
                <td class="py-4 text-slate-400">
                  {{ sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '-' }}
                </td>
                <td class="py-4">
                  <span
                    class="text-xs font-bold px-2 py-1 rounded-full"
                    :class="sched.active ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
                  >
                    {{ sched.active ? t('templates.active') : t('templates.inactive') }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-slate-500 text-sm">{{ t('templates.noSchedules') }}</p>
      </div>

      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">{{ t('templates.cropLifecycles') }}</h3>
        <div v-if="lifecycles.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="lc in lifecycles"
            :key="lc.cropCycleId"
            class="bg-slate-900 border border-slate-800 rounded-xl p-4"
          >
            <h4 class="font-bold text-white capitalize">{{ lc.cropType }}</h4>
            <p class="text-xs text-slate-400 mt-1">
              {{ lc.plotName ?? t('crops.unassignedPlot') }} ·
              {{ t('crops.planted') }} {{ new Date(lc.plantedAt).toLocaleDateString() }}
            </p>
            <p class="text-xs text-slate-500 mt-1">{{ t('templates.daysTotal', { days: lc.totalDays }) }}</p>
            <ul class="mt-3 space-y-1">
              <li
                v-for="stage in lc.stages"
                :key="stage.stage"
                class="text-xs text-slate-400 flex justify-between"
              >
                <span class="capitalize">{{ stage.stage.replace('_', ' ') }}</span>
                <span class="text-slate-500">{{ stage.durationDays }}d</span>
              </li>
            </ul>
          </div>
        </div>
        <p v-else-if="skippedCycles.length === 0" class="text-slate-500 text-sm">
          {{ t('templates.noLifecycles') }}
        </p>
        <ul v-if="skippedCycles.length" class="mt-3 space-y-1">
          <li v-for="cycle in skippedCycles" :key="cycle.id" class="text-slate-500 text-sm">
            <span class="capitalize text-slate-400">{{ cycle.cropType }}</span>
            <span v-if="cycle.plotName" class="text-slate-500"> · {{ cycle.plotName }}</span>
            - {{ agronomySkipText(cycle.agronomySkipReason) }}
          </li>
        </ul>
      </div>
    </template>
  </AppLayout>
</template>
