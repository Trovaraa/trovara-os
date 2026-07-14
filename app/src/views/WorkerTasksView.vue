<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import { offlineApi, onlineStatus, pendingSyncCount } from '@/lib/offline-api'
import { queueOfflinePhoto, syncOfflinePhotos } from '@/lib/offline-photo-queue'

type Task = {
  id: string
  title: string
  description?: string
  status: string
  plotName?: string
  completionNote?: string
}

type InventoryItem = {
  id: string
  name: string
  unit: string
  quantity: number
}

type InventoryConsumption = {
  itemId: string
  quantity: number
}

const { t } = useI18n()
const tasks = ref<Task[]>([])
const loading = ref(true)
const actionId = ref<string | null>(null)
const notes = ref<Record<string, string>>({})
const photos = ref<Record<string, string>>({})
const voices = ref<Record<string, string>>({})
const expandedNote = ref<string | null>(null)
const recordingId = ref<string | null>(null)
const inventoryItems = ref<InventoryItem[]>([])
const inventoryConsumption = ref<Record<string, InventoryConsumption[]>>({})
const consumptionItemDraft = ref<Record<string, string>>({})
const consumptionQtyDraft = ref<Record<string, number>>({})
const queueError = ref<string | null>(null)

let mediaRecorder: MediaRecorder | null = null
let recordingStream: MediaStream | null = null
let recordingTimer: ReturnType<typeof setTimeout> | null = null
const recordingChunks: BlobPart[] = []

function onSyncComplete() {
  void syncQueuedPhotos()
  void load()
}

async function load() {
  loading.value = true
  try {
    const data = await offlineApi<{ tasks: Task[] }>('/api/tasks')
    tasks.value = data.tasks ?? []
  } catch {
    tasks.value = []
  } finally {
    loading.value = false
  }
}

async function loadInventory() {
  try {
    const data = await offlineApi<{ items: InventoryItem[] }>('/api/inventory')
    inventoryItems.value = data.items ?? []
  } catch {
    inventoryItems.value = []
  }
}

async function syncQueuedPhotos() {
  await syncOfflinePhotos((path, options) => offlineApi(path, options))
}

onMounted(() => {
  void syncQueuedPhotos()
  void load()
  void loadInventory()
  window.addEventListener('trovara-sync-complete', onSyncComplete)
  window.addEventListener('online', onSyncComplete)
})

onUnmounted(() => {
  window.removeEventListener('trovara-sync-complete', onSyncComplete)
  window.removeEventListener('online', onSyncComplete)
  stopRecording()
})

function captureLocation(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })
}

async function startTask(id: string) {
  actionId.value = id
  try {
    await offlineApi(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
    })
    await load()
  } finally {
    actionId.value = null
  }
}

async function submitTask(id: string) {
  actionId.value = id
  queueError.value = null
  try {
    const location = await captureLocation()
    const isOffline = !navigator.onLine
    if (isOffline && photos.value[id]) {
      const queued = queueOfflinePhoto(id, photos.value[id])
      if (!queued) {
        queueError.value = 'Could not save photo offline — queue full or storage full.'
        return
      }
    }
    const consumption = inventoryConsumption.value[id] ?? []
    await offlineApi(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'awaiting_approval',
        completionNote: notes.value[id]?.trim() || undefined,
        photoUrl: !isOffline ? photos.value[id] || undefined : undefined,
        voiceUrl: voices.value[id] || undefined,
        latitude: location?.latitude,
        longitude: location?.longitude,
        consumptions: consumption.length ? consumption : undefined,
      }),
    })
    delete notes.value[id]
    delete photos.value[id]
    delete voices.value[id]
    delete inventoryConsumption.value[id]
    delete consumptionItemDraft.value[id]
    delete consumptionQtyDraft.value[id]
    expandedNote.value = null
    await syncQueuedPhotos()
    await load()
  } catch (e) {
    if (e instanceof Error && e.message.includes('Offline queue')) {
      queueError.value = e.message
    }
  } finally {
    actionId.value = null
  }
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

function stopRecording() {
  if (recordingTimer) {
    clearTimeout(recordingTimer)
    recordingTimer = null
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  } else {
    recordingStream?.getTracks().forEach((track) => track.stop())
    recordingStream = null
    recordingId.value = null
  }
}

async function toggleVoiceRecording(taskId: string) {
  if (recordingId.value === taskId) {
    stopRecording()
    return
  }

  stopRecording()
  recordingChunks.length = 0

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(recordingStream)
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordingChunks.push(event.data)
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordingChunks, {
        type: mediaRecorder?.mimeType ?? 'audio/webm',
      })
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          voices.value[taskId] = reader.result
        }
      }
      reader.readAsDataURL(blob)
      recordingStream?.getTracks().forEach((track) => track.stop())
      recordingStream = null
      mediaRecorder = null
      recordingId.value = null
    }
    mediaRecorder.start()
    recordingId.value = taskId
    recordingTimer = setTimeout(() => stopRecording(), 60_000)
  } catch {
    recordingId.value = null
  }
}

function toggleNote(id: string) {
  expandedNote.value = expandedNote.value === id ? null : id
}

function addInventoryConsumption(taskId: string) {
  const itemId = consumptionItemDraft.value[taskId]
  const quantity = Number(consumptionQtyDraft.value[taskId] ?? 0)
  if (!itemId || !Number.isFinite(quantity) || quantity <= 0) return

  const existing = inventoryConsumption.value[taskId] ?? []
  const row = existing.find((entry) => entry.itemId === itemId)
  if (row) {
    row.quantity += quantity
  } else {
    existing.push({ itemId, quantity })
  }
  inventoryConsumption.value[taskId] = existing
  consumptionQtyDraft.value[taskId] = 1
}

function removeInventoryConsumption(taskId: string, itemId: string) {
  const existing = inventoryConsumption.value[taskId] ?? []
  inventoryConsumption.value[taskId] = existing.filter((entry) => entry.itemId !== itemId)
}

function inventoryItemLabel(itemId: string): string {
  const item = inventoryItems.value.find((row) => row.id === itemId)
  if (!item) return 'Unknown item'
  return `${item.name} (${item.unit})`
}
</script>

<template>
  <AppLayout worker-mode>
    <div class="w-full max-w-full min-w-0">
    <div
      v-if="!onlineStatus"
      class="mb-4 rounded-xl border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-200"
    >
      <p>{{ t('offline.banner') }}</p>
      <p v-if="pendingSyncCount > 0" class="mt-1 text-xs text-amber-300/90">
        {{ t('offline.pendingSync', { count: pendingSyncCount }) }}
      </p>
    </div>

    <p v-if="queueError" class="mt-4 rounded-xl border border-red-800/50 bg-red-950/40 px-4 py-3 text-sm text-red-300">
      {{ queueError }}
    </p>

    <div class="flex items-start justify-between gap-3 min-w-0">
      <div class="min-w-0 flex-1">
        <h2 class="text-xl sm:text-2xl font-black text-white leading-tight">{{ t('tasks.myTitle') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('tasks.mySubtitle') }}</p>
      </div>
      <span
        v-if="pendingSyncCount > 0"
        class="shrink-0 rounded-full bg-amber-600 px-2.5 py-1 text-xs font-bold text-white"
        :title="t('offline.pendingSync', { count: pendingSyncCount })"
      >
        {{ pendingSyncCount }}
      </span>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400 text-base">{{ t('tasks.loading') }}</div>

    <div v-else-if="tasks.length === 0" class="mt-12 text-center">
      <p class="text-slate-400 text-base">{{ t('tasks.empty') }}</p>
    </div>

    <div v-else class="mt-4 space-y-3 w-full max-w-full">
      <article
        v-for="task in tasks"
        :key="task.id"
        class="w-full max-w-full box-border overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4"
      >
        <TaskStatusBadge :status="task.status" class="mb-2" />
        <h3 class="font-bold text-white text-base leading-snug break-words">{{ task.title }}</h3>
        <p v-if="task.description" class="text-slate-400 text-sm mt-1.5 break-words">{{ task.description }}</p>
        <p v-if="task.plotName" class="text-xs text-slate-500 mt-1.5">
          {{ t('tasks.plot', { name: task.plotName }) }}
        </p>

        <div
          v-if="task.status === 'pending' || task.status === 'in_progress'"
          class="mt-4 flex flex-col gap-3"
        >
          <button
            v-if="task.status === 'pending'"
            type="button"
            class="w-full min-h-[3rem] rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-base transition-colors disabled:opacity-60"
            :disabled="actionId === task.id"
            @click="startTask(task.id)"
          >
            {{ t('tasks.start') }}
          </button>

          <template v-if="task.status === 'in_progress'">
            <button
              type="button"
              class="w-full min-h-[3rem] rounded-xl bg-slate-800 border border-slate-700 text-white font-semibold text-base"
              @click="toggleNote(task.id)"
            >
              {{ t('tasks.addNote') }}
            </button>

            <div v-if="expandedNote === task.id" class="space-y-3">
              <textarea
                v-model="notes[task.id]"
                rows="3"
                maxlength="2000"
                :placeholder="t('tasks.notePlaceholder')"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-base text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-farm-green/40 resize-none"
              />
              <label class="flex items-center justify-center gap-2 min-h-[3rem] rounded-xl bg-slate-800 border border-slate-700 text-white font-semibold text-base cursor-pointer">
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
                class="w-full max-h-40 rounded-xl object-cover border border-slate-700"
              />
              <button
                type="button"
                class="w-full min-h-[3rem] rounded-xl border text-white font-semibold text-base transition-colors"
                :class="recordingId === task.id
                  ? 'bg-red-900/50 border-red-700 animate-pulse'
                  : voices[task.id]
                    ? 'bg-farm-green/20 border-farm-green/40'
                    : 'bg-slate-800 border-slate-700'"
                @click="toggleVoiceRecording(task.id)"
              >
                {{
                  recordingId === task.id
                    ? t('tasks.recordVoice') + '…'
                    : voices[task.id]
                      ? t('tasks.voiceAttached')
                      : t('tasks.recordVoice')
                }}
              </button>
              <p class="text-xs text-slate-500 text-center">{{ t('tasks.captureLocation') }}</p>

              <div class="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-2">
                <p class="text-xs font-semibold text-slate-300">Inventory used (optional)</p>
                <div class="grid gap-2 sm:grid-cols-[1fr_110px_auto]">
                  <select
                    v-model="consumptionItemDraft[task.id]"
                    class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    <option value="">Select item</option>
                    <option v-for="item in inventoryItems" :key="item.id" :value="item.id">
                      {{ item.name }} ({{ item.quantity }} {{ item.unit }})
                    </option>
                  </select>
                  <input
                    v-model.number="consumptionQtyDraft[task.id]"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Qty"
                    class="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="button"
                    class="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs font-semibold text-white"
                    @click="addInventoryConsumption(task.id)"
                  >
                    Add
                  </button>
                </div>

                <ul
                  v-if="(inventoryConsumption[task.id] ?? []).length"
                  class="space-y-1 text-xs text-slate-300"
                >
                  <li
                    v-for="entry in inventoryConsumption[task.id]"
                    :key="entry.itemId"
                    class="flex items-center justify-between rounded-lg bg-slate-950 px-2.5 py-1.5"
                  >
                    <span>{{ inventoryItemLabel(entry.itemId) }} · {{ entry.quantity }}</span>
                    <button
                      type="button"
                      class="text-red-300 hover:text-red-200"
                      @click="removeInventoryConsumption(task.id, entry.itemId)"
                    >
                      Remove
                    </button>
                  </li>
                </ul>
              </div>
            </div>

            <button
              type="button"
              class="w-full min-h-[3.25rem] rounded-xl bg-farm-green hover:bg-farm-green-dark text-white font-bold text-base transition-colors disabled:opacity-60"
              :disabled="actionId === task.id"
              @click="submitTask(task.id)"
            >
              {{ t('tasks.submit') }}
            </button>
          </template>
        </div>
      </article>
    </div>
    </div>
  </AppLayout>
</template>
