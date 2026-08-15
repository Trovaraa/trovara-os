<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type Guideline = {
  id: string
  title: string
  category: string
  body: string
  audience: string
  status: 'draft' | 'approved' | 'archived'
  version: number
  reviewDueAt: string | null
  authorName: string | null
  updatedAt: string
}

const auth = useAuthStore()
const { t } = useI18n()
const guidelines = ref<Guideline[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const showForm = ref(false)
const editingId = ref<string | null>(null)
const form = ref({ title: '', category: '', audience: 'all', body: '', reviewDueAt: '' })
const canWrite = computed(() => auth.hasPermission('knowledge.write'))
const canApprove = computed(() => auth.hasPermission('knowledge.approve'))

async function load() {
  loading.value = true
  error.value = null
  try { guidelines.value = (await api<{ guidelines: Guideline[] }>('/api/operation-guidelines')).guidelines }
  catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.loadFailed') }
  finally { loading.value = false }
}

async function create() {
  saving.value = true
  error.value = null
  try {
    await api(editingId.value ? `/api/operation-guidelines/${editingId.value}` : '/api/operation-guidelines', { method: editingId.value ? 'PATCH' : 'POST', body: JSON.stringify({ ...form.value, reviewDueAt: form.value.reviewDueAt ? new Date(`${form.value.reviewDueAt}T12:00:00.000Z`).toISOString() : null }) })
    form.value = { title: '', category: '', audience: 'all', body: '', reviewDueAt: '' }
    editingId.value = null
    showForm.value = false
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.saveFailed') }
  finally { saving.value = false }
}

async function changeStatus(guideline: Guideline, action: 'approve' | 'archive') {
  saving.value = true
  try { await api(`/api/operation-guidelines/${guideline.id}/${action}`, { method: 'POST' }); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.updateFailed') }
  finally { saving.value = false }
}

function audienceLabel(audience: string) {
  return t(`operationsLibrary.${audience === 'all' ? 'everyone' : audience}`)
}

function editGuideline(guideline: Guideline) {
  editingId.value = guideline.id
  form.value = {
    title: guideline.title,
    category: guideline.category,
    audience: guideline.audience,
    body: guideline.body,
    reviewDueAt: guideline.reviewDueAt?.slice(0, 10) ?? '',
  }
  showForm.value = true
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function closeForm() {
  showForm.value = false
  editingId.value = null
  form.value = { title: '', category: '', audience: 'all', body: '', reviewDueAt: '' }
}

function toggleForm() {
  if (showForm.value) closeForm()
  else showForm.value = true
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div><p class="text-xs font-bold uppercase tracking-widest text-farm-gold">{{ t('operationsLibrary.eyebrow') }}</p><h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('operationsLibrary.title') }}</h2><p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('operationsLibrary.description') }}</p></div>
      <button v-if="canWrite" type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white" @click="toggleForm">{{ showForm ? t('operationsLibrary.closeForm') : t('operationsLibrary.newGuideline') }}</button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-400" role="alert">{{ error }}</p>
    <form v-if="showForm && canWrite" class="mt-6 grid gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-2" @submit.prevent="create">
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.titleLabel') }}<input v-model="form.title" required minlength="3" maxlength="160" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" /></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.category') }}<input v-model="form.category" required maxlength="80" :placeholder="t('operationsLibrary.categoryPlaceholder')" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" /></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.audienceLabel') }}<select v-model="form.audience" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white"><option value="all">{{ t('operationsLibrary.everyone') }}</option><option value="management">{{ t('operationsLibrary.management') }}</option><option value="finance">{{ t('operationsLibrary.finance') }}</option><option value="operations">{{ t('operationsLibrary.operations') }}</option><option value="sales">{{ t('operationsLibrary.sales') }}</option></select></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.reviewDue') }}<input v-model="form.reviewDueAt" type="date" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" /></label>
      <label class="text-xs text-slate-400 sm:col-span-2">{{ t('operationsLibrary.guideline') }}<textarea v-model="form.body" required minlength="20" maxlength="30000" rows="10" :placeholder="t('operationsLibrary.guidelinePlaceholder')" class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm leading-6 text-white" /></label>
      <div class="sm:col-span-2"><button type="submit" :disabled="saving" class="min-h-11 rounded-xl bg-farm-green px-5 py-2 font-bold text-white disabled:opacity-50">{{ saving ? t('operationsLibrary.saving') : editingId ? t('operationsLibrary.updateDraft') : t('operationsLibrary.saveDraft') }}</button></div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('operationsLibrary.loading') }}</div>
    <p v-else-if="!guidelines.length" class="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-8 text-sm text-slate-400">{{ t('operationsLibrary.empty') }}</p>
    <div v-else class="mt-8 space-y-4">
      <CollapsibleSection v-for="guideline in guidelines" :key="guideline.id" :title="guideline.title" :description="`${guideline.category} · ${t('operationsLibrary.version', { version: guideline.version })} · ${guideline.status}`" :default-open="false">
        <div class="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-300">{{ guideline.body }}</div>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4 text-xs text-slate-500">
          <span>{{ guideline.authorName ?? t('operationsLibrary.formerMember') }} · {{ t('operationsLibrary.audience', { audience: audienceLabel(guideline.audience) }) }}</span>
          <div class="flex gap-2"><button v-if="canWrite && guideline.status !== 'archived'" type="button" class="min-h-10 rounded-lg bg-slate-800 px-3 font-bold text-slate-300" @click="editGuideline(guideline)">{{ t('operationsLibrary.edit') }}</button><button v-if="canApprove && guideline.status === 'draft'" type="button" class="min-h-10 rounded-lg bg-emerald-500/15 px-3 font-bold text-emerald-300" @click="changeStatus(guideline, 'approve')">{{ t('operationsLibrary.approve') }}</button><button v-if="canApprove && guideline.status !== 'archived'" type="button" class="min-h-10 rounded-lg bg-slate-800 px-3 font-bold text-slate-300" @click="changeStatus(guideline, 'archive')">{{ t('operationsLibrary.archive') }}</button></div>
        </div>
      </CollapsibleSection>
    </div>
  </AppLayout>
</template>
