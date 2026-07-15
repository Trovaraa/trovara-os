<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import ChatMarkdown from '@/components/ChatMarkdown.vue'
import { api } from '@/lib/api'

type IntegrationStatus = { configured: boolean; hint?: string }
type ChatMessage = { role: 'user' | 'assistant'; text: string; image?: string }
type TaskDraft = { title: string; description?: string; assigneeId?: string; dueAt?: string }

const loading = ref(true)
const aiStatus = ref<IntegrationStatus | null>(null)

const messages = ref<ChatMessage[]>([])
const input = ref('')
const attachedImage = ref<string | null>(null)
const sending = ref(false)
const chatError = ref<string | null>(null)
const threadEl = ref<HTMLElement | null>(null)
const draft = ref<TaskDraft | null>(null)
const draftId = ref<string | null>(null)
const confirmingDraft = ref(false)
const draftMessage = ref<string | null>(null)

const suggestions = [
  "What's the revenue today?",
  'What needs restocking?',
  'How many birds are alive?',
  'My chickens are weak with greenish droppings - what could it be?',
  'Which plots are most profitable?',
]

async function load() {
  loading.value = true
  try {
    aiStatus.value = await api<IntegrationStatus>('/api/ai/status')
  } finally {
    loading.value = false
  }
}

onMounted(load)

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
        if (!ctx) return reject(new Error('Canvas not supported'))
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => reject(new Error('Invalid image'))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('Could not read file'))
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
    chatError.value = 'Could not read that image.'
  }
  target.value = ''
}

function removeImage() {
  attachedImage.value = null
}

async function send(presetQuestion?: string) {
  const question = (presetQuestion ?? input.value).trim()
  const image = attachedImage.value
  if ((!question && !image) || sending.value || !aiStatus.value?.configured) return

  chatError.value = null
  const history = messages.value
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.text }))

  messages.value.push({ role: 'user', text: question || '(photo)', image: image ?? undefined })
  input.value = ''
  attachedImage.value = null
  sending.value = true
  void scrollToBottom()

  try {
    const data = await api<{ answer: string; llmError?: string; draft?: TaskDraft }>('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question, imageUrl: image ?? undefined, history }),
    })
    messages.value.push({ role: 'assistant', text: data.answer })
    draft.value = data.draft ?? null
    draftMessage.value = null
  } catch (e) {
    chatError.value = e instanceof Error ? e.message : 'The Copilot could not respond.'
  } finally {
    sending.value = false
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
    draftMessage.value = data.task?.id ? `Task created (${data.task.id}).` : 'Task created.'
    draft.value = null
    draftId.value = null
  } catch (e) {
    draftMessage.value = e instanceof Error ? e.message : 'Could not confirm task draft.'
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
      draftMessage.value = data.message ?? 'Task draft ready for confirmation.'
    } else {
      draftMessage.value = data.message ?? 'No task draft was produced.'
    }
  } catch (e) {
    draftMessage.value = e instanceof Error ? e.message : 'Could not generate task draft.'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">Farm Copilot</h2>
        <p class="text-slate-400 text-sm mt-1">
          Ask about your farm, diagnose a sick animal, or send a photo of a crop - all in one chat.
        </p>
      </div>
      <span
        v-if="aiStatus"
        class="text-xs font-bold px-2.5 py-1 rounded-full shrink-0"
        :class="aiStatus.configured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ aiStatus.configured ? 'AI ready' : 'AI not configured' }}
      </span>
    </div>

    <p v-if="aiStatus?.hint && !aiStatus.configured" class="mt-4 text-xs text-slate-500">
      {{ aiStatus.hint }}
    </p>

    <div v-if="loading" class="mt-8 text-slate-400">Loading…</div>

    <section v-else class="mt-6 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col overflow-hidden" style="height: calc(100vh - 16rem); min-height: 28rem">
      <!-- Thread -->
      <div ref="threadEl" class="flex-1 overflow-y-auto p-4 space-y-3">
        <!-- Empty state -->
        <div v-if="!messages.length" class="h-full flex flex-col items-center justify-center text-center px-6">
          <div class="h-12 w-12 rounded-2xl bg-farm-green/15 text-farm-green flex items-center justify-center text-xl font-black mb-3">T</div>
          <p class="text-white font-semibold">Hi - I'm your farm copilot.</p>
          <p class="text-slate-500 text-sm mt-1 max-w-sm">
            Ask about money, stock, livestock or tasks. Describe a sick animal, or attach a photo of a struggling crop and I'll diagnose it.
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
          :key="idx"
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
              alt="attachment"
              class="mb-2 max-h-44 rounded-lg border border-black/20"
            />
            <ChatMarkdown v-if="msg.role === 'assistant'" :text="msg.text" />
            <template v-else>{{ msg.text }}</template>
          </div>
        </div>

        <div v-if="sending" class="flex justify-start">
          <div class="bg-slate-800 text-slate-400 rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-sm">
            Thinking…
          </div>
        </div>
      </div>

      <!-- Composer -->
      <div class="border-t border-slate-800 p-3">
        <div v-if="draft" class="mb-3 rounded-lg border border-farm-green/30 bg-farm-green/10 p-3">
          <p class="text-xs font-bold text-farm-green uppercase tracking-wide">Suggested task draft</p>
          <p class="mt-1 text-sm text-white">{{ draft.title }}</p>
          <p v-if="draft.description" class="mt-1 text-xs text-slate-300">{{ draft.description }}</p>
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              :disabled="confirmingDraft"
              class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              @click="confirmDraftTask"
            >
              {{ confirmingDraft ? 'Confirming…' : 'Confirm and create task' }}
            </button>
            <button
              type="button"
              class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="draft = null; draftId = null"
            >
              Dismiss
            </button>
          </div>
        </div>

        <div v-if="attachedImage" class="mb-2 flex items-center gap-2">
          <img :src="attachedImage" alt="preview" class="h-14 w-14 rounded-lg object-cover border border-slate-700" />
          <button type="button" class="text-xs text-slate-400 hover:text-white underline" @click="removeImage">
            Remove photo
          </button>
        </div>

        <form class="flex items-end gap-2" @submit.prevent="send()">
          <label
            class="shrink-0 h-10 w-10 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 flex items-center justify-center cursor-pointer text-lg"
            :class="{ 'opacity-40 pointer-events-none': !aiStatus?.configured }"
            title="Attach photo"
          >
            📎
            <input type="file" accept="image/*" capture="environment" class="hidden" @change="onImageSelected" />
          </label>
          <textarea
            v-model="input"
            rows="1"
            :disabled="!aiStatus?.configured"
            placeholder="Ask anything, or describe what's wrong…"
            class="flex-1 resize-none bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50 disabled:opacity-50 max-h-32"
            @keydown.enter.exact.prevent="send()"
          />
          <button
            type="button"
            :disabled="sending || !input.trim() || !aiStatus?.configured"
            class="shrink-0 h-10 px-3 rounded-lg bg-slate-800 text-slate-300 font-semibold text-xs hover:bg-slate-700 disabled:opacity-50"
            @click="draftTaskFromPrompt"
          >
            Draft task
          </button>
          <button
            type="submit"
            :disabled="sending || (!input.trim() && !attachedImage) || !aiStatus?.configured"
            class="shrink-0 h-10 px-4 rounded-lg bg-farm-green/20 text-farm-green font-bold text-sm hover:bg-farm-green/30 disabled:opacity-50"
          >
            Send
          </button>
        </form>
        <p v-if="!aiStatus?.configured" class="text-xs text-slate-500 mt-2">Add an API key in .env to enable the Copilot.</p>
        <p v-else-if="draftMessage" class="text-xs text-slate-300 mt-2">{{ draftMessage }}</p>
        <p v-else-if="chatError" class="text-xs text-red-400 mt-2">{{ chatError }}</p>
        <p v-else class="text-[10px] text-slate-600 mt-2">
          Copilot reads your live farm data. Guidance is assistive - confirm serious cases with a vet/agronomist.
        </p>
      </div>
    </section>
  </AppLayout>
</template>
