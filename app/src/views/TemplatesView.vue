<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type TaskTemplate = {
  id: string
  name: string
  description?: string | null
  cropType?: string | null
  checklist?: string[] | null
  defaultDurationHours?: number | null
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

type Lifecycle = {
  cropType: string
  totalDays: number
  stages: { stage: string; durationDays: number }[]
}

const templates = ref<TaskTemplate[]>([])
const schedules = ref<Schedule[]>([])
const lifecycles = ref<Lifecycle[]>([])
const loading = ref(true)

const newName = ref('')
const newDescription = ref('')
const newCropType = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)

const generating = ref(false)
const generateMessage = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    const [tplData, schedData, lifeData] = await Promise.all([
      api<{ templates: TaskTemplate[] }>('/api/templates/templates'),
      api<{ schedules: Schedule[] }>('/api/templates/schedules'),
      api<{ lifecycles: Lifecycle[] }>('/api/templates/lifecycles'),
    ])
    templates.value = tplData.templates
    schedules.value = schedData.schedules
    lifecycles.value = lifeData.lifecycles
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function createTemplate() {
  if (!newName.value.trim()) return
  creating.value = true
  createError.value = null
  try {
    await api('/api/templates/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: newName.value.trim(),
        description: newDescription.value.trim() || undefined,
        cropType: newCropType.value.trim() || undefined,
      }),
    })
    newName.value = ''
    newDescription.value = ''
    newCropType.value = ''
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : 'Failed to create template'
  } finally {
    creating.value = false
  }
}

async function generateTasks() {
  generating.value = true
  generateMessage.value = null
  try {
    const data = await api<{ count: number }>('/api/templates/generate-tasks', { method: 'POST' })
    generateMessage.value = `Generated ${data.count} task(s) from due schedules`
    await load()
  } catch (e) {
    generateMessage.value = e instanceof Error ? e.message : 'Generate failed'
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">Task Templates</h2>
        <p class="text-slate-400 text-sm mt-1">Reusable task definitions and recurring schedules</p>
      </div>
      <button
        type="button"
        class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50 shrink-0"
        :disabled="generating"
        @click="generateTasks"
      >
        {{ generating ? 'Generating…' : 'Generate due tasks' }}
      </button>
    </div>

    <p v-if="generateMessage" class="mt-4 text-xs text-slate-400">{{ generateMessage }}</p>

    <form
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createTemplate"
    >
      <h3 class="font-bold text-white text-sm">New task template</h3>
      <div class="grid sm:grid-cols-3 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Name</label>
          <input
            v-model="newName"
            type="text"
            required
            maxlength="200"
            placeholder="e.g. Plantain weeding"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Crop type</label>
          <input
            v-model="newCropType"
            type="text"
            maxlength="100"
            placeholder="e.g. plantain"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Description</label>
          <input
            v-model="newDescription"
            type="text"
            maxlength="2000"
            placeholder="Optional details"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating || !newName.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ creating ? 'Creating…' : 'Create template' }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">Loading templates…</div>

    <template v-else>
      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">Templates</h3>
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
                <p class="text-xs text-slate-500 mt-2">
                  <span v-if="tpl.cropType" class="capitalize">{{ tpl.cropType }}</span>
                  <span v-if="tpl.defaultDurationHours"> · {{ tpl.defaultDurationHours }}h default</span>
                </p>
              </div>
            </div>
            <ul v-if="tpl.checklist?.length" class="mt-3 text-xs text-slate-400 list-disc list-inside space-y-1">
              <li v-for="(item, i) in tpl.checklist" :key="i">{{ item }}</li>
            </ul>
          </div>
        </div>
        <p v-else class="text-slate-500 text-sm">No templates yet.</p>
      </div>

      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">Recurring schedules</h3>
        <div v-if="schedules.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-slate-500 border-b border-slate-800">
                <th class="pb-3 font-semibold">Template</th>
                <th class="pb-3 font-semibold">Recurrence</th>
                <th class="pb-3 font-semibold">Plot</th>
                <th class="pb-3 font-semibold">Assignee</th>
                <th class="pb-3 font-semibold">Next run</th>
                <th class="pb-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="sched in schedules"
                :key="sched.id"
                class="border-b border-slate-800/50"
              >
                <td class="py-4 text-white">{{ sched.templateName ?? '—' }}</td>
                <td class="py-4 text-slate-400 capitalize">{{ sched.recurrence.replace('_', ' ') }}</td>
                <td class="py-4 text-slate-400">{{ sched.plotName ?? '—' }}</td>
                <td class="py-4 text-slate-400">{{ sched.assignedToName ?? '—' }}</td>
                <td class="py-4 text-slate-400">
                  {{ sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—' }}
                </td>
                <td class="py-4">
                  <span
                    class="text-xs font-bold px-2 py-1 rounded-full"
                    :class="sched.active ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
                  >
                    {{ sched.active ? 'Active' : 'Inactive' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-slate-500 text-sm">No recurring schedules.</p>
      </div>

      <div class="mt-8">
        <h3 class="font-bold text-white mb-4">Crop lifecycles</h3>
        <div v-if="lifecycles.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="lc in lifecycles"
            :key="lc.cropType"
            class="bg-slate-900 border border-slate-800 rounded-xl p-4"
          >
            <h4 class="font-bold text-white capitalize">{{ lc.cropType }}</h4>
            <p class="text-xs text-slate-500 mt-1">{{ lc.totalDays }} days total</p>
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
        <p v-else class="text-slate-500 text-sm">No lifecycle definitions.</p>
      </div>
    </template>
  </AppLayout>
</template>
