<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type FieldReport = {
  id: string
  category: string
  severity: string
  description: string
  photoUrl: string | null
  status: string
  createdByName: string
  createdAt: string
}

const auth = useAuthStore()
const canManage = computed(() => auth.canApprove)
const reports = ref<FieldReport[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const category = ref('observation')
const severity = ref('normal')
const description = ref('')
const photoUrl = ref<string | null>(null)
const categories = ['observation', 'crop', 'livestock', 'equipment', 'safety', 'theft', 'other']

async function load() {
  loading.value = true
  error.value = null
  try {
    reports.value = (await api<{ reports: FieldReport[] }>('/api/field-reports')).reports
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load field reports.'
  } finally {
    loading.value = false
  }
}

function selectPhoto(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return void (photoUrl.value = null)
  const reader = new FileReader()
  reader.onload = () => { photoUrl.value = typeof reader.result === 'string' ? reader.result : null }
  reader.readAsDataURL(file)
}

async function submit() {
  if (description.value.trim().length < 3) return
  saving.value = true
  error.value = null
  try {
    await api('/api/field-reports', {
      method: 'POST',
      body: JSON.stringify({ category: category.value, severity: severity.value, description: description.value.trim(), photoUrl: photoUrl.value }),
    })
    description.value = ''
    photoUrl.value = null
    category.value = 'observation'
    severity.value = 'normal'
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not submit this report.'
  } finally {
    saving.value = false
  }
}

async function setStatus(report: FieldReport, status: string) {
  error.value = null
  try {
    await api(`/api/field-reports/${report.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not update this report.'
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="mx-auto w-full max-w-5xl space-y-6 px-4 py-5 sm:px-6 sm:py-8">
      <header>
        <p class="text-xs font-bold uppercase tracking-[0.18em] text-farm-green">Field operations</p>
        <h1 class="mt-1 text-2xl font-bold text-white sm:text-3xl">Observation & incident log</h1>
        <p class="mt-2 max-w-2xl text-sm text-slate-400">Record what you see in the field. Urgent and theft reports alert supervisors immediately.</p>
      </header>

      <p v-if="error" class="rounded-xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">{{ error }}</p>

      <form class="rounded-2xl border border-white/10 bg-[#10221a] p-4 sm:p-6" @submit.prevent="submit">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="text-sm font-semibold text-slate-200">Report type
            <select v-model="category" class="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#07140f] px-3 text-white">
              <option v-for="option in categories" :key="option" :value="option">{{ option.replace('_', ' ') }}</option>
            </select>
          </label>
          <label class="text-sm font-semibold text-slate-200">Priority
            <select v-model="severity" class="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#07140f] px-3 text-white">
              <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option>
            </select>
          </label>
        </div>
        <label class="mt-4 block text-sm font-semibold text-slate-200">What did you observe?
          <textarea v-model="description" rows="4" maxlength="4000" required class="mt-2 w-full rounded-xl border border-white/10 bg-[#07140f] px-3 py-3 text-white placeholder:text-slate-600" placeholder="Be specific: what happened, where, and what needs attention." />
        </label>
        <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label class="cursor-pointer text-sm font-semibold text-slate-300">
            <span class="inline-flex min-h-11 items-center rounded-xl border border-white/10 px-4">{{ photoUrl ? 'Photo attached' : 'Attach photo (optional)' }}</span>
            <input class="sr-only" type="file" accept="image/*" capture="environment" @change="selectPhoto" />
          </label>
          <button type="submit" :disabled="saving || description.trim().length < 3" class="min-h-12 rounded-xl bg-farm-green px-6 font-bold text-[#07140f] disabled:opacity-50">{{ saving ? 'Submitting…' : 'Submit report' }}</button>
        </div>
      </form>

      <section>
        <div class="mb-3 flex items-center justify-between"><h2 class="text-lg font-bold text-white">Recent reports</h2><span class="text-xs text-slate-500">{{ reports.length }} shown</span></div>
        <p v-if="loading" class="text-sm text-slate-400">Loading reports…</p>
        <p v-else-if="!reports.length" class="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">No reports yet.</p>
        <div v-else class="space-y-3">
          <article v-for="report in reports" :key="report.id" class="rounded-2xl border border-white/10 bg-[#10221a] p-4">
            <div class="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wide">
              <span class="rounded-full bg-white/5 px-2.5 py-1 text-slate-300">{{ report.category }}</span>
              <span class="rounded-full px-2.5 py-1" :class="report.severity === 'normal' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-red-900/40 text-red-200'">{{ report.severity }}</span>
              <span class="rounded-full bg-blue-900/30 px-2.5 py-1 text-blue-200">{{ report.status.replace('_', ' ') }}</span>
            </div>
            <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-100">{{ report.description }}</p>
            <img v-if="report.photoUrl" :src="report.photoUrl" alt="Field report evidence" class="mt-3 max-h-64 w-full rounded-xl object-cover sm:w-80" />
            <div class="mt-3 flex flex-col gap-3 border-t border-white/5 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p class="text-xs text-slate-500">{{ report.createdByName }} · {{ formatDate(report.createdAt) }}</p>
              <div v-if="canManage" class="flex flex-wrap gap-2">
                <button v-if="report.status === 'open'" type="button" class="min-h-10 rounded-lg border border-blue-700/50 px-3 text-xs font-bold text-blue-200" @click="setStatus(report, 'in_progress')">Start review</button>
                <button v-if="report.status !== 'resolved'" type="button" class="min-h-10 rounded-lg border border-emerald-700/50 px-3 text-xs font-bold text-emerald-200" @click="setStatus(report, 'resolved')">Resolve</button>
                <button v-if="report.status !== 'dismissed'" type="button" class="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-slate-300" @click="setStatus(report, 'dismissed')">Dismiss</button>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </AppLayout>
</template>
