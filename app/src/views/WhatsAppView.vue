<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type StaticTemplate = {
  id: string
  name: string
  en: string
  yo: string
  pcm: string
}

type ApiTemplate = {
  id: string
  name: string
  placeholders?: string[]
}

type WhatsAppStatus = {
  configured: boolean
  hint?: string
}

const staticTemplates: StaticTemplate[] = [
  {
    id: 'task_complete',
    name: 'Task Complete',
    en: '✅ Task completed on Trovara Farm\n\nTask: Weeding - Plot B\nPlot: Plot B\nCompleted by: Ade\nTime: 21 Jun 2026, 14:30\n\nPlease review in Trovara OS.',
    yo: '✅ Iṣẹ parí lóko Trovara\n\nIṣẹ: Weeding - Plot B\nApá oko: Plot B\nOlùparí: Ade\nÀkókò: 21 Jun 2026, 14:30\n\nJọ̀wọ́ wo rẹ̀ nínú Trovara OS.',
    pcm: '✅ Task don finish for Trovara Farm\n\nTask: Weeding - Plot B\nPlot: Plot B\nPerson wey finish am: Ade\nTime: 21 Jun 2026, 14:30\n\nAbeg check am for Trovara OS.',
  },
  {
    id: 'incident_report',
    name: 'Incident Report',
    en: '⚠️ INCIDENT REPORT - Trovara Farm\n\nType: Equipment failure\nLocation: North paddock\nDetails: Irrigation pump stopped during morning shift\nReported by: Chidi\nTime: 21 Jun 2026, 09:15\n\nAction required. Check Trovara OS for full details.',
    yo: '⚠️ ÌRÒYÌN ÌṢÒRÒ - Oko Trovara\n\nIrú: Equipment failure\nIbù: North paddock\nÀlàyé: Irrigation pump stopped during morning shift\nOlùròyìn: Chidi\nÀkókò: 21 Jun 2026, 09:15\n\nÈtò nílò. Wo Trovara OS fún àlàyé kíkún.',
    pcm: '⚠️ INCIDENT REPORT - Trovara Farm\n\nType: Equipment failure\nLocation: North paddock\nWetin happen: Irrigation pump stopped during morning shift\nPerson wey report: Chidi\nTime: 21 Jun 2026, 09:15\n\nWe need action. Check Trovara OS for full gist.',
  },
  {
    id: 'low_stock_alert',
    name: 'Low Stock Alert',
    en: '📦 LOW STOCK ALERT - Trovara Farm\n\nItem: NPK Fertilizer\nCurrent stock: 3 bags\nReorder level: 10 bags\n\nPlease restock soon. View inventory in Trovara OS.',
    yo: '📦 ÌKÌLÒ ÌNÀWÓ KÉKÉÈRÍ - Oko Trovara\n\nNkan: NPK Fertilizer\nIye lọ́wọ́lọ́wọ́: 3 bags\nIpele títún: 10 bags\n\nJọ̀wọ́ ṣe àtúnṣe kíákíá. Wo àkójọpọ̀ nínú Trovara OS.',
    pcm: '📦 LOW STOCK ALERT - Trovara Farm\n\nItem: NPK Fertilizer\nWetin remain: 3 bags\nReorder level: 10 bags\n\nAbeg restock quick quick. Check inventory for Trovara OS.',
  },
]

const copied = ref<string | null>(null)
const waStatus = ref<WhatsAppStatus | null>(null)
const sendTemplates = ref<ApiTemplate[]>([])

const phone = ref('')
const templateId = ref('')
const lang = ref<'en' | 'yo' | 'pcm'>('en')
const variablesJson = ref('{}')
const sending = ref(false)
const sendMessage = ref<string | null>(null)
const sendError = ref<string | null>(null)

onMounted(async () => {
  try {
    const [statusData, tplData] = await Promise.all([
      api<WhatsAppStatus>('/api/whatsapp/status'),
      api<{ templates: ApiTemplate[] }>('/api/whatsapp/templates'),
    ])
    waStatus.value = statusData
    sendTemplates.value = tplData.templates
    if (tplData.templates.length) {
      templateId.value = tplData.templates[0].id
    }
  } catch {
    waStatus.value = { configured: false }
  }
})

async function copyText(key: string, text: string) {
  await navigator.clipboard.writeText(text)
  copied.value = key
  setTimeout(() => {
    if (copied.value === key) copied.value = null
  }, 2000)
}

async function sendMessageForm() {
  sending.value = true
  sendMessage.value = null
  sendError.value = null
  try {
    let variables: Record<string, string> = {}
    if (variablesJson.value.trim()) {
      variables = JSON.parse(variablesJson.value) as Record<string, string>
    }
    const data = await api<{ ok: boolean; messageId?: string; preview?: string }>(
      '/api/whatsapp/send',
      {
        method: 'POST',
        body: JSON.stringify({
          to: phone.value.trim(),
          templateId: templateId.value,
          lang: lang.value,
          variables,
        }),
      },
    )
    sendMessage.value = data.preview
      ? `Sent (ID: ${data.messageId ?? 'ok'})`
      : 'Message sent'
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : 'Send failed'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">WhatsApp Templates</h2>
        <p class="text-slate-400 text-sm mt-1">
          Bilingual message templates - copy manually or send via Meta API
        </p>
      </div>
      <span
        v-if="waStatus"
        class="text-xs font-bold px-2.5 py-1 rounded-full shrink-0"
        :class="waStatus.configured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ waStatus.configured ? 'API configured' : 'Copy-only mode' }}
      </span>
    </div>

    <form
      v-if="waStatus?.configured"
      class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
      @submit.prevent="sendMessageForm"
    >
      <h3 class="font-bold text-white text-sm">Send WhatsApp message</h3>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Phone (E.164)</label>
          <input
            v-model="phone"
            type="tel"
            required
            placeholder="2348012345678"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Template</label>
          <select
            v-model="templateId"
            required
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option v-for="tpl in sendTemplates" :key="tpl.id" :value="tpl.id">
              {{ tpl.name }}
            </option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Language</label>
          <select
            v-model="lang"
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-farm-green/50"
          >
            <option value="en">English</option>
            <option value="yo">Yoruba</option>
            <option value="pcm">Pidgin</option>
          </select>
        </div>
        <div class="sm:col-span-2 lg:col-span-1">
          <label class="block text-xs text-slate-500 mb-1.5">Variables (JSON)</label>
          <input
            v-model="variablesJson"
            type="text"
            placeholder='{"taskTitle":"Weeding"}'
            class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-farm-green/50"
          />
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          :disabled="sending || !phone.trim() || !templateId"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        >
          {{ sending ? 'Sending…' : 'Send message' }}
        </button>
        <p v-if="sendError" class="text-xs text-red-400">{{ sendError }}</p>
      </div>
      <pre v-if="sendMessage" class="text-xs text-slate-400 whitespace-pre-wrap">{{ sendMessage }}</pre>
    </form>

    <p v-else-if="waStatus?.hint" class="mt-6 text-xs text-slate-500">{{ waStatus.hint }}</p>

    <div class="mt-8 space-y-6">
      <div
        v-for="tpl in staticTemplates"
        :key="tpl.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-5"
      >
        <h3 class="font-bold text-white">{{ tpl.name }}</h3>

        <div class="mt-4 grid gap-4 lg:grid-cols-3">
          <div
            v-for="langOpt in ([
              { code: 'en', label: 'English' },
              { code: 'yo', label: 'Yoruba' },
              { code: 'pcm', label: 'Pidgin' },
            ] as const)"
            :key="`${tpl.id}-${langOpt.code}`"
            class="bg-slate-800/50 border border-slate-700 rounded-lg p-4 flex flex-col"
          >
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-bold text-slate-400 uppercase tracking-wide">
                {{ langOpt.label }}
              </span>
              <button
                class="text-xs px-2.5 py-1 rounded-md transition-colors"
                :class="copied === `${tpl.id}-${langOpt.code}`
                  ? 'bg-farm-green/20 text-farm-green'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'"
                @click="copyText(`${tpl.id}-${langOpt.code}`, tpl[langOpt.code])"
              >
                {{ copied === `${tpl.id}-${langOpt.code}` ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <pre class="text-xs text-slate-300 whitespace-pre-wrap font-sans flex-1">{{ tpl[langOpt.code] }}</pre>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
