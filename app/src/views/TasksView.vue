<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

type Task = {
  id: string
  title: string
  description?: string
  status: string
  plotName?: string
  assignedToName?: string
  completionNote?: string
  photoUrl?: string
  voiceUrl?: string
  latitude?: string | number | null
  longitude?: string | number | null
  actionType?: string | null
}

type PlotOption = { id: string; name: string }
type UserOption = { id: string; name: string; role: string }
type TemplateOption = { id: string; name: string; actionType?: string | null }

const auth = useAuthStore()
const { t } = useI18n()
const tasks = ref<Task[]>([])
const plots = ref<PlotOption[]>([])
const staff = ref<UserOption[]>([])
const templates = ref<TemplateOption[]>([])
const loading = ref(true)

const newTitle = ref('')
const newDescription = ref('')
const newPlotId = ref('')
const newAssignedToId = ref('')
const newTemplateId = ref('')
const newDueDate = ref('')
const creating = ref(false)
const createError = ref<string | null>(null)
const notes = ref<Record<string, string>>({})
const photos = ref<Record<string, string>>({})
const rejectModalTask = ref<Task | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

type HandoverProgress = {
  zones: number
  activeBlocks: number
  handoverTasksOpen: number
  handoverTasksCompleted: number
  openTasks: Array<{ id: string; title: string; status: string }>
}
const handoverProgress = ref<HandoverProgress | null>(null)
const generatingHandover = ref(false)
const handoverMessage = ref<string | null>(null)

function openRejectModal(task: Task) {
  rejectModalTask.value = task
  rejectReason.value = ''
}

function closeRejectModal() {
  if (rejecting.value) return
  rejectModalTask.value = null
  rejectReason.value = ''
}

function gpsLabel(task: Task): string {
  const lat = task.latitude
  const lng = task.longitude
  if (lat == null || lat === '' || lng == null || lng === '') return 'Not captured'
  return `${lat}, ${lng}`
}

async function load() {
  loading.value = true
  try {
    const data = await api<{ tasks: Task[] }>('/api/tasks')
    tasks.value = data.tasks
  } finally {
    loading.value = false
  }
}

async function loadCreateOptions() {
  if (!auth.canApprove) return
  try {
    const [plotData, userData, tplData] = await Promise.all([
      api<{ plots: PlotOption[] }>('/api/zones/plots'),
      api<{ users: UserOption[] }>('/api/users'),
      api<{ templates: TemplateOption[] }>('/api/templates/templates'),
    ])
    plots.value = plotData.plots
    staff.value = userData.users
    templates.value = tplData.templates
  } catch {
    plots.value = []
    staff.value = []
    templates.value = []
  }
}

async function loadHandoverProgress() {
  if (!auth.canApprove) return
  try {
    const data = await api<{ progress: HandoverProgress }>('/api/handover/progress')
    handoverProgress.value = data.progress
  } catch {
    handoverProgress.value = null
  }
}

async function generateHandoverTasks() {
  if (!auth.canApprove) return
  generatingHandover.value = true
  handoverMessage.value = null
  try {
    await api('/api/handover/seed-templates', { method: 'POST', body: '{}' })
    const data = await api<{ count: number }>('/api/handover/generate-tasks', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    handoverMessage.value = `Generated ${data.count} handover task(s).`
    await Promise.all([load(), loadHandoverProgress(), loadCreateOptions()])
  } catch (e) {
    handoverMessage.value = e instanceof Error ? e.message : 'Failed to generate handover tasks'
  } finally {
    generatingHandover.value = false
  }
}

onMounted(async () => {
  await Promise.all([load(), loadCreateOptions(), loadHandoverProgress()])
})

async function createTask() {
  if (!newTitle.value.trim()) return
  creating.value = true
  createError.value = null
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: newTitle.value.trim(),
        description: newDescription.value.trim() || undefined,
        plotId: newPlotId.value || undefined,
        assignedToId: newAssignedToId.value || undefined,
        templateId: newTemplateId.value || undefined,
        dueDate: newDueDate.value ? new Date(newDueDate.value).toISOString() : undefined,
      }),
    })
    newTitle.value = ''
    newDescription.value = ''
    newPlotId.value = ''
    newAssignedToId.value = ''
    newTemplateId.value = ''
    newDueDate.value = ''
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : 'Failed to create task'
  } finally {
    creating.value = false
  }
}

async function updateStatus(
  id: string,
  status: string,
  extra?: { rejectionReason?: string },
) {
  await api(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...extra }),
  })
  await load()
}

function onPhotoSelected(taskId: string, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      photos.value[taskId] = reader.result
    }
  }
  reader.readAsDataURL(file)
  input.value = ''
}

async function submitForApproval(id: string) {
  await api(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'awaiting_approval',
      completionNote: notes.value[id]?.trim() || undefined,
      photoUrl: photos.value[id] || undefined,
    }),
  })
  delete notes.value[id]
  delete photos.value[id]
  await load()
}

async function rejectTaskWithReason() {
  if (!rejectModalTask.value) return
  const reason = rejectReason.value.trim()
  if (reason.length < 5) return
  rejecting.value = true
  try {
    await updateStatus(rejectModalTask.value.id, 'rejected', { rejectionReason: reason })
    closeRejectModal()
  } finally {
    rejecting.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('tasks.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('tasks.subtitle') }}</p>
      <RouterLink
        v-if="auth.isOwner"
        to="/tasks/post-approval"
        class="mt-2 inline-flex text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
      >
        View post-approval changes
      </RouterLink>
    </div>

    <div
      v-if="auth.canApprove"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="font-bold text-white text-sm">Handover batch</h3>
          <p class="text-xs text-slate-500 mt-0.5">
            Seed templates and generate open handover tasks for active blocks.
          </p>
        </div>
        <button
          type="button"
          :disabled="generatingHandover"
          class="text-xs px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          @click="generateHandoverTasks"
        >
          {{ generatingHandover ? 'Generating…' : 'Generate handover tasks' }}
        </button>
      </div>
      <div
        v-if="handoverProgress"
        class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs"
      >
        <div class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
          <p class="text-slate-500">Zones</p>
          <p class="text-white font-semibold">{{ handoverProgress.zones }}</p>
        </div>
        <div class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
          <p class="text-slate-500">Active blocks</p>
          <p class="text-white font-semibold">{{ handoverProgress.activeBlocks }}</p>
        </div>
        <div class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
          <p class="text-slate-500">Open</p>
          <p class="text-white font-semibold">{{ handoverProgress.handoverTasksOpen }}</p>
        </div>
        <div class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
          <p class="text-slate-500">Completed</p>
          <p class="text-white font-semibold">{{ handoverProgress.handoverTasksCompleted }}</p>
        </div>
      </div>
      <p v-if="handoverMessage" class="text-xs text-slate-400">{{ handoverMessage }}</p>
    </div>

    <form
      v-if="auth.canApprove"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="createTask"
    >
      <h3 class="font-bold text-white text-sm">{{ t('tasks.assignNew') }}</h3>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('tasks.titleLabel') }}</label>
        <input
          v-model="newTitle"
          type="text"
          required
          maxlength="200"
          :placeholder="t('tasks.titlePlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
        />
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1.5">{{ t('tasks.descriptionLabel') }}</label>
        <textarea
          v-model="newDescription"
          rows="2"
          maxlength="2000"
          :placeholder="t('tasks.descriptionPlaceholder')"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 resize-none"
        />
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('tasks.blockLabel') }}</label>
          <select
            v-model="newPlotId"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">{{ t('tasks.optionalNone') }}</option>
            <option v-for="plot in plots" :key="plot.id" :value="plot.id">{{ plot.name }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('tasks.assigneeLabel') }}</label>
          <select
            v-model="newAssignedToId"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">{{ t('tasks.optionalNone') }}</option>
            <option v-for="u in staff" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('tasks.templateLabel') }}</label>
          <select
            v-model="newTemplateId"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">{{ t('tasks.optionalNone') }}</option>
            <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">{{ t('tasks.dueDateLabel') }}</label>
          <input
            v-model="newDueDate"
            type="datetime-local"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="creating || !newTitle.trim()"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ creating ? t('tasks.assigning') : t('tasks.assign') }}
        </button>
        <p v-if="createError" class="text-xs text-red-400">{{ createError }}</p>
      </div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('tasks.loading') }}</div>

    <div v-else class="mt-6 space-y-3 w-full max-w-full">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="w-full max-w-full box-border overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4"
      >
        <TaskStatusBadge :status="task.status" class="mb-2" />
        <h3 class="font-bold text-white text-base break-words leading-snug">{{ task.title }}</h3>
        <p v-if="task.description" class="text-slate-400 text-sm mt-1.5 break-words">{{ task.description }}</p>
        <p class="text-xs text-slate-500 mt-1.5">
          <span v-if="task.plotName">{{ task.plotName }} · </span>
          <span v-if="task.assignedToName">{{ t('tasks.assignedTo', { name: task.assignedToName }) }}</span>
        </p>
        <div
          v-if="task.status === 'awaiting_approval'"
          class="mt-3 grid gap-2 text-xs text-slate-400"
        >
          <p v-if="task.completionNote" class="rounded-lg border border-slate-800 bg-slate-800/50 px-3 py-2">
            <span class="text-slate-500">Completion note:</span> {{ task.completionNote }}
          </p>
          <div v-if="task.photoUrl" class="rounded-lg border border-slate-800 bg-slate-800/50 px-3 py-2">
            <p class="text-slate-500 mb-1">Photo evidence</p>
            <img
              :src="task.photoUrl"
              alt="task completion evidence"
              class="h-24 w-24 rounded-lg border border-slate-700 object-cover"
            />
          </div>
          <p v-if="task.voiceUrl" class="rounded-lg border border-slate-800 bg-slate-800/50 px-3 py-2">
            <span class="text-slate-500">Voice note:</span>
            <a
              :href="task.voiceUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="text-farm-green hover:underline break-all"
            >
              Open recording
            </a>
          </p>
          <p class="rounded-lg border border-slate-800 bg-slate-800/50 px-3 py-2">
            <span class="text-slate-500">GPS:</span> {{ gpsLabel(task) }}
          </p>
        </div>

        <div
          v-if="task.status === 'in_progress' && auth.user?.role === 'field_worker'"
          class="mt-4 space-y-3"
        >
          <textarea
            v-model="notes[task.id]"
            rows="2"
            maxlength="2000"
            :placeholder="t('tasks.notePlaceholder')"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 resize-none"
          />
          <div class="flex flex-wrap items-center gap-3">
            <label class="inline-flex items-center gap-2 min-h-[2.75rem] px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-300 cursor-pointer hover:border-farm-green/50">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                class="sr-only"
                @change="onPhotoSelected(task.id, $event)"
              />
              {{ photos[task.id] ? t('tasks.photoAttached') : t('tasks.attachPhoto') }}
            </label>
            <img
              v-if="photos[task.id]"
              :src="photos[task.id]"
              alt=""
              class="h-12 w-12 rounded-lg object-cover border border-slate-700"
            />
          </div>
        </div>

        <div class="flex flex-wrap gap-2 mt-4">
          <button
            v-if="task.status === 'pending' || task.status === 'in_progress'"
            class="text-xs px-3 py-1.5 rounded-lg bg-blue-900/40 text-blue-300 hover:bg-blue-900/60 min-h-[2.75rem]"
            @click="updateStatus(task.id, 'in_progress')"
          >
            {{ t('tasks.start') }}
          </button>
          <button
            v-if="task.status === 'in_progress' && auth.user?.role === 'field_worker'"
            class="text-xs px-3 py-1.5 rounded-lg bg-purple-900/40 text-purple-300 hover:bg-purple-900/60 min-h-[2.75rem]"
            @click="submitForApproval(task.id)"
          >
            {{ t('tasks.submit') }}
          </button>
          <template v-if="task.status === 'awaiting_approval' && auth.canApprove">
            <button
              class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 min-h-[2.75rem]"
              @click="updateStatus(task.id, 'completed')"
            >
              {{ t('tasks.approve') }}
            </button>
            <button
              class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 min-h-[2.75rem]"
              @click="openRejectModal(task)"
            >
              {{ t('tasks.reject') }}
            </button>
          </template>
        </div>
      </div>
    </div>

    <div
      v-if="rejectModalTask"
      class="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      @click.self="closeRejectModal"
    >
      <div class="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 class="text-white font-bold text-lg">Reject task</h3>
        <p class="text-xs text-slate-500 mt-1">A rejection reason is required (minimum 5 characters).</p>
        <textarea
          v-model="rejectReason"
          rows="4"
          minlength="5"
          maxlength="1000"
          placeholder="Explain what needs to be corrected"
          class="mt-3 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 resize-none"
        />
        <div class="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            class="text-xs px-3 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="closeRejectModal"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="rejectReason.trim().length < 5 || rejecting"
            class="text-xs px-3 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
            @click="rejectTaskWithReason"
          >
            {{ rejecting ? 'Rejecting…' : 'Reject task' }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
