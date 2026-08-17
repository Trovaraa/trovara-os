<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import ChatMarkdown from '@/components/ChatMarkdown.vue'
import { api } from '@/lib/api'

const { t, locale } = useI18n()

type IntegrationStatus = { configured: boolean; hint?: string }
type ChatMessage = {
  id?: string
  role: 'user' | 'assistant'
  text: string
  image?: string
  metadata?: Record<string, unknown> | null
  feedbackRating?: 'up' | 'down' | null
  feedbackNote?: string | null
  feedbackEditing?: boolean
}
type TaskDraft = { title: string; description?: string; assigneeId?: string; dueAt?: string }
type ActionDraft = { draftId: string; actionType: string; preview: string }
type Conversation = {
  id: string
  title: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachmentUrl: string | null
  metadata: Record<string, unknown> | null
  feedbackRating: 'up' | 'down' | null
  feedbackNote: string | null
  feedbackAt: string | null
}

const loading = ref(true)
const aiStatus = ref<IntegrationStatus | null>(null)

const messages = ref<ChatMessage[]>([])
const conversations = ref<Conversation[]>([])
const activeConversationId = ref<string | null>(null)
const conversationBusy = ref(false)
const input = ref('')
const attachedImage = ref<string | null>(null)
const sending = ref(false)
const chatError = ref<string | null>(null)
const threadEl = ref<HTMLElement | null>(null)
const draft = ref<TaskDraft | null>(null)
const draftId = ref<string | null>(null)
const confirmingDraft = ref(false)
const draftMessage = ref<string | null>(null)
const actionDraft = ref<ActionDraft | null>(null)
const confirmingAction = ref(false)
const feedbackBusyId = ref<string | null>(null)
const feedbackDrafts = ref<Record<string, string>>({})
const feedbackErrorId = ref<string | null>(null)

const recording = ref(false)
const transcribing = ref(false)
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
const recordedChunks: BlobPart[] = []

const suggestions = computed(() => [
  t('ai.suggestions.revenue'),
  t('ai.suggestions.restocking'),
  t('ai.suggestions.birds'),
  t('ai.suggestions.chickens'),
  t('ai.suggestions.plots'),
])

function appLocale(): 'en' | 'yo' | 'pcm' | 'fr' {
  const l = String(locale.value)
  if (l === 'yo' || l === 'pcm' || l === 'fr') return l
  return 'en'
}

async function load() {
  loading.value = true
  try {
    const [status, history] = await Promise.all([
      api<IntegrationStatus>('/api/ai/status'),
      api<{ conversations: Conversation[] }>('/api/ai/conversations'),
    ])
    aiStatus.value = status
    conversations.value = history.conversations
    if (conversations.value[0]) await openConversation(conversations.value[0].id)
  } finally {
    loading.value = false
  }
}

function restorePendingAction(rows: ChatMessage[]) {
  actionDraft.value = null
  for (const row of [...rows].reverse()) {
    const draftId = row.metadata?.draftId
    const actionType = row.metadata?.actionType
    if (typeof draftId === 'string' && typeof actionType === 'string') {
      actionDraft.value = { draftId, actionType, preview: row.text }
      return
    }
    if (row.metadata?.confirmed || row.metadata?.cancelled) return
  }
}

async function refreshConversationList() {
  const data = await api<{ conversations: Conversation[] }>('/api/ai/conversations')
  conversations.value = data.conversations
}

async function openConversation(id: string) {
  if (conversationBusy.value) return
  conversationBusy.value = true
  chatError.value = null
  try {
    const data = await api<{ conversation: Conversation; messages: StoredMessage[] }>(`/api/ai/conversations/${id}`)
    activeConversationId.value = data.conversation.id
    messages.value = data.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content,
      image: message.attachmentUrl ?? undefined,
      metadata: message.metadata,
      feedbackRating: message.feedbackRating,
      feedbackNote: message.feedbackNote,
    }))
    restorePendingAction(messages.value)
    await scrollToBottom()
  } catch (e) {
    chatError.value = e instanceof Error ? e.message : t('insights.historyLoadFailed')
  } finally {
    conversationBusy.value = false
  }
}

function onConversationSelected(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  if (id) void openConversation(id)
}

async function newConversation() {
  if (conversationBusy.value) return
  conversationBusy.value = true
  try {
    const data = await api<{ conversation: Conversation; messages: StoredMessage[] }>('/api/ai/conversations', { method: 'POST' })
    conversations.value = [data.conversation, ...conversations.value]
    activeConversationId.value = data.conversation.id
    messages.value = []
    actionDraft.value = null
    draft.value = null
  } finally {
    conversationBusy.value = false
  }
}

async function clearConversation() {
  if (!activeConversationId.value || !window.confirm(t('insights.clearConfirm'))) return
  conversationBusy.value = true
  try {
    await api(`/api/ai/conversations/${activeConversationId.value}/messages`, { method: 'DELETE' })
    messages.value = []
    actionDraft.value = null
    await refreshConversationList()
  } finally {
    conversationBusy.value = false
  }
}

async function archiveConversation() {
  if (!activeConversationId.value || !window.confirm(t('insights.archiveConfirm'))) return
  conversationBusy.value = true
  try {
    await api(`/api/ai/conversations/${activeConversationId.value}/archive`, { method: 'POST' })
    await refreshConversationList()
    const next = conversations.value[0]
    if (next) {
      conversationBusy.value = false
      await openConversation(next.id)
    }
    else {
      activeConversationId.value = null
      messages.value = []
      actionDraft.value = null
    }
  } finally {
    conversationBusy.value = false
  }
}

onMounted(load)

onUnmounted(() => {
  stopTracks()
})

function stopTracks() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop()
    } catch {
      /* ignore */
    }
  }
  mediaRecorder = null
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  recording.value = false
}

async function scrollToBottom() {
  await nextTick()
  threadEl.value?.scrollTo({ top: threadEl.value.scrollHeight, behavior: 'smooth' })
}

function downscaleImage(file: File, maxSize: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error(t('ai.canvasNotSupported')))
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => reject(new Error(t('ai.invalidImage')))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error(t('ai.couldNotReadFile')))
    reader.readAsDataURL(file)
  })
}

async function onImageSelected(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  chatError.value = null
  try {
    attachedImage.value = await downscaleImage(file, 1024, 0.7)
  } catch {
    chatError.value = t('ai.couldNotReadImage')
  }
  target.value = ''
}

function removeImage() {
  attachedImage.value = null
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(t('ai.couldNotReadFile')))
    reader.readAsDataURL(blob)
  })
}

/** iOS Safari prefers AAC-in-MP4; Chrome prefers WebM. Strip codec params for a clean data URL. */
function pickRecorderMime(): string {
  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  const candidates = isAppleMobile
    ? ['audio/mp4', 'audio/aac', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm', 'audio/ogg']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

function normalizeAudioMime(raw: string): string {
  const base = (raw || '').split(';')[0].trim().toLowerCase()
  if (base === 'audio/mp4' || base === 'audio/aac' || base === 'audio/x-m4a' || base === 'audio/m4a') {
    return 'audio/mp4'
  }
  if (base === 'video/mp4') return 'audio/mp4'
  if (base === 'audio/webm') return 'audio/webm'
  if (base === 'audio/ogg' || base === 'audio/opus') return 'audio/ogg'
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'audio/mpeg'
  if (base === 'audio/wav' || base === 'audio/wave' || base === 'audio/x-wav') return 'audio/wav'
  // Empty type from Safari → assume MP4 on Apple, WebM elsewhere
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'audio/mp4'
  return 'audio/webm'
}

/** Ensure the data: header is a bare allowed audio mime (no codec params / spaces). */
function rewriteAudioDataUrl(dataUrl: string, mime: string): string {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return dataUrl
  return `data:${mime};base64,${dataUrl.slice(comma + 1).replace(/\s+/g, '')}`
}

async function toggleVoice() {
  if (transcribing.value || sending.value || !aiStatus.value?.configured) return
  if (recording.value) {
    mediaRecorder?.stop()
    return
  }

  chatError.value = null
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    chatError.value = t('ai.micUnsupported')
    return
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    chatError.value = t('ai.micDenied')
    return
  }

  recordedChunks.length = 0
  const mimeType = pickRecorderMime()
  mediaRecorder = mimeType
    ? new MediaRecorder(mediaStream, { mimeType })
    : new MediaRecorder(mediaStream)

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data)
  }

  mediaRecorder.onstop = () => {
    const first = recordedChunks[0]
    const chunkType = first instanceof Blob ? first.type : ''
    const raw = mediaRecorder?.mimeType || mimeType || chunkType || ''
    void finishRecording(normalizeAudioMime(String(raw)))
  }

  mediaRecorder.start()
  recording.value = true
}

async function finishRecording(mimeType: string) {
  recording.value = false
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  mediaRecorder = null

  if (!recordedChunks.length) return

  transcribing.value = true
  chatError.value = null
  try {
    const blob = new Blob(recordedChunks, { type: mimeType })
    recordedChunks.length = 0
    const audioDataUrl = rewriteAudioDataUrl(await blobToDataUrl(blob), mimeType)
    const data = await api<{ transcript: string }>('/api/ai/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audioDataUrl }),
    })
    const transcript = data.transcript.trim()
    if (!transcript) {
      chatError.value = t('ai.transcribeFailed')
      return
    }
    await send(transcript)
  } catch (e) {
    chatError.value = e instanceof Error ? e.message : t('ai.transcribeFailed')
  } finally {
    transcribing.value = false
  }
}

async function send(presetQuestion?: string) {
  const question = (presetQuestion ?? input.value).trim()
  const image = attachedImage.value
  if ((!question && !image) || sending.value || !aiStatus.value?.configured) return

  chatError.value = null
  messages.value.push({ role: 'user', text: question || t('ai.photoOnly'), image: image ?? undefined })
  input.value = ''
  attachedImage.value = null
  sending.value = true
  void scrollToBottom()

  try {
    const data = await api<{
      answer: string
      conversationId: string
      draft?: TaskDraft
      actionDraft?: ActionDraft | null
      message?: StoredMessage | null
    }>('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({
        question,
        imageUrl: image ?? undefined,
        conversationId: activeConversationId.value ?? undefined,
        locale: appLocale(),
      }),
    })
    messages.value.push({
      id: data.message?.id,
      role: 'assistant',
      text: data.answer,
      metadata: data.message?.metadata,
      feedbackRating: data.message?.feedbackRating ?? null,
      feedbackNote: data.message?.feedbackNote ?? null,
    })
    activeConversationId.value = data.conversationId
    actionDraft.value = data.actionDraft ?? null
    draft.value = data.draft ?? null
    draftMessage.value = null
    await refreshConversationList()
  } catch (e) {
    chatError.value = e instanceof Error ? e.message : t('ai.copilotError')
  } finally {
    sending.value = false
    void scrollToBottom()
  }
}

function editNegativeFeedback(message: ChatMessage) {
  if (!message.id || feedbackBusyId.value) return
  if (message.feedbackRating === 'down') {
    void saveFeedback(message, null)
    return
  }
  feedbackDrafts.value[message.id] = message.feedbackNote ?? ''
  message.feedbackEditing = true
  feedbackErrorId.value = null
}

async function saveFeedback(
  message: ChatMessage,
  rating: 'up' | 'down' | null,
  note?: string | null,
) {
  if (!message.id || feedbackBusyId.value) return
  feedbackBusyId.value = message.id
  feedbackErrorId.value = null
  try {
    const data = await api<{ message: StoredMessage }>(
      `/api/ai/messages/${message.id}/feedback`,
      {
        method: 'PATCH',
        body: JSON.stringify({ rating, note: rating === 'down' ? note ?? null : null }),
      },
    )
    message.feedbackRating = data.message.feedbackRating
    message.feedbackNote = data.message.feedbackNote
    message.feedbackEditing = false
  } catch {
    feedbackErrorId.value = message.id
  } finally {
    feedbackBusyId.value = null
  }
}

function rateHelpful(message: ChatMessage) {
  void saveFeedback(message, message.feedbackRating === 'up' ? null : 'up')
}

function submitNegativeFeedback(message: ChatMessage) {
  if (!message.id) return
  void saveFeedback(message, 'down', feedbackDrafts.value[message.id]?.trim() || null)
}

async function resolveAction(confirm: boolean) {
  if (!actionDraft.value || confirmingAction.value) return
  confirmingAction.value = true
  chatError.value = null
  const current = actionDraft.value
  try {
    if (confirm) {
      const data = await api<{ result: string; message?: StoredMessage | null }>(`/api/ai/actions/${current.draftId}/confirm`, { method: 'POST' })
      messages.value.push({
        id: data.message?.id,
        role: 'assistant',
        text: data.result,
        metadata: { confirmed: true },
      })
    } else {
      const data = await api<{ message?: StoredMessage | null }>(`/api/ai/actions/${current.draftId}/cancel`, { method: 'POST' })
      messages.value.push({
        id: data.message?.id,
        role: 'assistant',
        text: t('insights.actionCancelled'),
        metadata: { cancelled: true },
      })
    }
    actionDraft.value = null
    await refreshConversationList()
  } catch (e) {
    chatError.value = e instanceof Error ? e.message : t('insights.actionFailed')
  } finally {
    confirmingAction.value = false
    void scrollToBottom()
  }
}

async function confirmDraftTask() {
  if (!draft.value || !draftId.value) return
  confirmingDraft.value = true
  draftMessage.value = null
  try {
    const data = await api<{ task?: { id: string } }>('/api/ai/confirm-task', {
      method: 'POST',
      body: JSON.stringify({
        draftId: draftId.value,
        title: draft.value.title,
        description: draft.value.description,
      }),
    })
    draftMessage.value = data.task?.id
      ? t('ai.taskCreatedWithId', { id: data.task.id })
      : t('ai.taskCreated')
    draft.value = null
    draftId.value = null
  } catch (e) {
    draftMessage.value = e instanceof Error ? e.message : t('ai.confirmDraftFailed')
  } finally {
    confirmingDraft.value = false
  }
}

async function draftTaskFromPrompt() {
  const question = input.value.trim()
  if (!question || sending.value || !aiStatus.value?.configured) return
  sending.value = true
  draftMessage.value = null
  chatError.value = null
  try {
    const data = await api<{ draft?: TaskDraft; draftId?: string; message?: string }>('/api/ai/draft-task', {
      method: 'POST',
      body: JSON.stringify({ question }),
    })
    if (data.draft) {
      draft.value = data.draft
      draftId.value = data.draftId ?? null
      draftMessage.value = data.message ?? t('ai.draftReady')
    } else {
      draftMessage.value = data.message ?? t('ai.noDraftProduced')
    }
  } catch (e) {
    draftMessage.value = e instanceof Error ? e.message : t('ai.generateDraftFailed')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('ai.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">
          {{ t('ai.subtitle') }}
        </p>
      </div>
      <span
        v-if="aiStatus"
        class="text-xs font-bold px-2.5 py-1 rounded-full shrink-0"
        :class="aiStatus.configured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ aiStatus.configured ? t('ai.aiReady') : t('ai.aiNotConfigured') }}
      </span>
    </div>

    <p v-if="aiStatus?.hint && !aiStatus.configured" class="mt-4 text-xs text-slate-500">
      {{ aiStatus.hint }}
    </p>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('ai.loading') }}</div>

    <section v-else class="mt-6 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col overflow-hidden" style="height: calc(100vh - 16rem); min-height: 28rem">
      <div class="border-b border-slate-800 p-3 flex flex-wrap items-center gap-2">
        <select
          :value="activeConversationId ?? ''"
          :disabled="conversationBusy"
          :aria-label="t('insights.conversationHistory')"
          class="min-w-0 flex-1 sm:max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          @change="onConversationSelected"
        >
          <option value="" disabled>{{ t('insights.noConversation') }}</option>
          <option v-for="conversation in conversations" :key="conversation.id" :value="conversation.id">
            {{ conversation.title }}
          </option>
        </select>
        <button type="button" class="px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green text-xs font-bold" :disabled="conversationBusy" @click="newConversation">
          {{ t('insights.newChat') }}
        </button>
        <button type="button" class="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs" :disabled="conversationBusy || !activeConversationId" @click="clearConversation">
          {{ t('insights.clearChat') }}
        </button>
        <button type="button" class="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs" :disabled="conversationBusy || !activeConversationId" @click="archiveConversation">
          {{ t('insights.archiveChat') }}
        </button>
      </div>
      <!-- Thread -->
      <div ref="threadEl" class="flex-1 overflow-y-auto p-4 space-y-3">
        <!-- Empty state -->
        <div v-if="!messages.length" class="h-full flex flex-col items-center justify-center text-center px-6">
          <img src="/brand/trovara-monogram-tile-v1.svg" alt="" class="h-12 w-12 mb-3" width="48" height="48" />
          <p class="text-white font-semibold">{{ t('ai.emptyGreeting') }}</p>
          <p class="text-slate-500 text-sm mt-1 max-w-sm">
            {{ t('ai.emptyHint') }}
          </p>
          <div class="flex flex-wrap gap-2 justify-center mt-5 max-w-lg">
            <button
              v-for="s in suggestions"
              :key="s"
              type="button"
              :disabled="!aiStatus?.configured"
              class="text-xs px-3 py-1.5 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
              @click="send(s)"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div
          v-for="(msg, idx) in messages"
          :key="msg.id ?? idx"
          class="flex"
          :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"
            :class="msg.role === 'user'
              ? 'bg-farm-green/20 text-farm-green rounded-br-sm whitespace-pre-wrap'
              : 'bg-slate-800 text-slate-200 rounded-bl-sm'"
          >
            <img
              v-if="msg.image"
              :src="msg.image"
              :alt="t('ai.attachmentAlt')"
              class="mb-2 max-h-44 rounded-lg border border-black/20"
            />
            <ChatMarkdown v-if="msg.role === 'assistant'" :text="msg.text" />
            <template v-else>{{ msg.text }}</template>
            <div
              v-if="msg.role === 'assistant' && msg.id"
              class="mt-3 border-t border-slate-700/80 pt-2"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="mr-1 text-xs text-slate-400">{{ t('ai.helpfulQuestion') }}</span>
                <button
                  type="button"
                  class="min-h-10 min-w-10 rounded-lg border p-2 transition-colors disabled:opacity-50"
                  :class="msg.feedbackRating === 'up'
                    ? 'border-farm-green/60 bg-farm-green/20 text-farm-green'
                    : 'border-slate-700 text-slate-400 hover:text-white'"
                  :disabled="feedbackBusyId === msg.id"
                  :aria-label="t('ai.helpfulYes')"
                  :title="t('ai.helpfulYes')"
                  :aria-pressed="msg.feedbackRating === 'up'"
                  data-testid="ai-feedback-up"
                  @click="rateHelpful(msg)"
                >
                  <svg class="mx-auto h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M7 10v11H3V10h4Zm0 9h10.2a2 2 0 0 0 1.9-1.4l1.6-5A2 2 0 0 0 18.8 10H15l.6-3.1A3.2 3.2 0 0 0 12.5 3L7 10v9Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="min-h-10 min-w-10 rounded-lg border p-2 transition-colors disabled:opacity-50"
                  :class="msg.feedbackRating === 'down'
                    ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
                    : 'border-slate-700 text-slate-400 hover:text-white'"
                  :disabled="feedbackBusyId === msg.id"
                  :aria-label="t('ai.helpfulNo')"
                  :title="t('ai.helpfulNo')"
                  :aria-pressed="msg.feedbackRating === 'down'"
                  data-testid="ai-feedback-down"
                  @click="editNegativeFeedback(msg)"
                >
                  <svg class="mx-auto h-4 w-4 rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M7 10v11H3V10h4Zm0 9h10.2a2 2 0 0 0 1.9-1.4l1.6-5A2 2 0 0 0 18.8 10H15l.6-3.1A3.2 3.2 0 0 0 12.5 3L7 10v9Z" />
                  </svg>
                </button>
              </div>
              <form
                v-if="msg.feedbackEditing"
                class="mt-2 rounded-lg bg-slate-900/60 p-2"
                @submit.prevent="submitNegativeFeedback(msg)"
              >
                <label :for="`feedback-${msg.id}`" class="block text-xs font-semibold text-slate-300">
                  {{ t('ai.feedbackReasonLabel') }}
                </label>
                <textarea
                  :id="`feedback-${msg.id}`"
                  v-model="feedbackDrafts[msg.id]"
                  rows="2"
                  maxlength="500"
                  class="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-farm-green/60 focus:outline-none"
                  :placeholder="t('ai.feedbackReasonPlaceholder')"
                />
                <div class="mt-2 flex gap-2">
                  <button type="submit" class="min-h-10 rounded-lg bg-farm-green/20 px-3 text-xs font-bold text-farm-green" :disabled="feedbackBusyId === msg.id">
                    {{ t('ai.saveFeedback') }}
                  </button>
                  <button type="button" class="min-h-10 rounded-lg bg-slate-800 px-3 text-xs text-slate-300" @click="msg.feedbackEditing = false">
                    {{ t('common.cancel') }}
                  </button>
                </div>
              </form>
              <p v-else-if="msg.feedbackRating" class="mt-2 text-xs text-slate-500">
                {{ t('ai.feedbackSaved') }}
                <span v-if="msg.feedbackNote"> {{ t('ai.feedbackCorrectionSaved') }}</span>
              </p>
              <p v-if="feedbackErrorId === msg.id" class="mt-2 text-xs text-red-400">
                {{ t('ai.feedbackFailed') }}
              </p>
            </div>
          </div>
        </div>

        <div v-if="sending || transcribing" class="flex justify-start">
          <div class="bg-slate-800 text-slate-400 rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-sm">
            {{ transcribing ? t('ai.transcribing') : t('ai.thinking') }}
          </div>
        </div>
      </div>

      <!-- Composer -->
      <div class="border-t border-slate-800 p-3">
        <div v-if="actionDraft" class="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
          <p class="text-xs font-bold text-amber-300 uppercase tracking-wide">{{ t('insights.actionNeedsConfirmation') }}</p>
          <p class="mt-1 text-xs text-slate-300">{{ t('insights.actionSafetyNotice') }}</p>
          <div class="mt-3 flex items-center gap-2">
            <button type="button" :disabled="confirmingAction" class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50" @click="resolveAction(true)">
              {{ confirmingAction ? t('ai.confirming') : t('insights.confirmAction') }}
            </button>
            <button type="button" :disabled="confirmingAction" class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50" @click="resolveAction(false)">
              {{ t('insights.cancelAction') }}
            </button>
          </div>
        </div>
        <div v-if="draft" class="mb-3 rounded-lg border border-farm-green/30 bg-farm-green/10 p-3">
          <p class="text-xs font-bold text-farm-green uppercase tracking-wide">{{ t('ai.suggestedTaskDraft') }}</p>
          <p class="mt-1 text-sm text-white">{{ draft.title }}</p>
          <p v-if="draft.description" class="mt-1 text-xs text-slate-300">{{ draft.description }}</p>
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              :disabled="confirmingDraft"
              class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              @click="confirmDraftTask"
            >
              {{ confirmingDraft ? t('ai.confirming') : t('ai.confirmCreateTask') }}
            </button>
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="draft = null; draftId = null"
            >
              {{ t('ai.dismiss') }}
            </button>
          </div>
        </div>

        <div v-if="attachedImage" class="mb-2 flex items-center gap-2">
          <img :src="attachedImage" :alt="t('ai.previewAlt')" class="h-14 w-14 rounded-lg object-cover border border-slate-700" />
          <button type="button" class="text-xs text-slate-400 hover:text-white underline" @click="removeImage">
            {{ t('ai.removePhoto') }}
          </button>
        </div>

        <form class="flex items-end gap-2" @submit.prevent="send()">
          <label
            class="shrink-0 h-10 w-10 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 flex items-center justify-center cursor-pointer text-lg"
            :class="{ 'opacity-40 pointer-events-none': !aiStatus?.configured || recording || transcribing }"
            :title="t('ai.attachPhotoTitle')"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="m20.5 11.5-8.7 8.7a5.25 5.25 0 0 1-7.4-7.4l9.4-9.4a3.75 3.75 0 0 1 5.3 5.3l-9.4 9.4a2.25 2.25 0 0 1-3.2-3.2l8.7-8.7" />
            </svg>
            <input type="file" accept="image/*" capture="environment" class="hidden" @change="onImageSelected" />
          </label>
          <button
            type="button"
            class="shrink-0 h-10 w-10 rounded-lg flex items-center justify-center text-lg"
            :class="recording
              ? 'bg-red-900/50 text-red-300 animate-pulse'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'"
            :disabled="!aiStatus?.configured || sending || transcribing"
            :title="recording ? t('ai.stopRecording') : t('ai.voiceTitle')"
            :aria-label="recording ? t('ai.stopRecording') : t('ai.voiceTitle')"
            @click="toggleVoice"
          >
            <svg v-if="recording" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            <svg v-else class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <rect x="8" y="3" width="8" height="12" rx="4" />
              <path stroke-linecap="round" d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
            </svg>
          </button>
          <textarea
            v-model="input"
            :aria-label="t('ai.placeholder')"
            rows="1"
            :disabled="!aiStatus?.configured || recording || transcribing"
            :placeholder="recording ? t('ai.recording') : t('ai.placeholder')"
            class="flex-1 resize-none bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 disabled:opacity-50 max-h-32"
            @keydown.enter.exact.prevent="send()"
          />
          <button
            type="button"
            :disabled="sending || transcribing || recording || !input.trim() || !aiStatus?.configured"
            class="shrink-0 h-10 px-3 rounded-lg bg-slate-800 text-slate-300 font-semibold text-xs hover:bg-slate-700 disabled:opacity-50"
            @click="draftTaskFromPrompt"
          >
            {{ t('ai.draftTask') }}
          </button>
          <button
            type="submit"
            :disabled="sending || transcribing || recording || (!input.trim() && !attachedImage) || !aiStatus?.configured"
            class="shrink-0 h-10 px-4 rounded-lg bg-farm-green/20 text-farm-green font-bold text-sm hover:bg-farm-green/30 disabled:opacity-50"
          >
            {{ t('ai.send') }}
          </button>
        </form>
        <p v-if="!aiStatus?.configured" class="text-xs text-slate-500 mt-2">{{ t('ai.enableHint') }}</p>
        <p v-else-if="draftMessage" class="text-xs text-slate-300 mt-2">{{ draftMessage }}</p>
        <p v-else-if="chatError" class="text-xs text-red-400 mt-2">{{ chatError }}</p>
        <p v-else class="text-[10px] text-slate-600 mt-2">
          {{ t('ai.disclaimer') }}
        </p>
      </div>
    </section>
  </AppLayout>
</template>
