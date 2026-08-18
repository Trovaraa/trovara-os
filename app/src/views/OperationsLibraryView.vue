<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import ChatMarkdown from '@/components/ChatMarkdown.vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api, resolveApiUrl } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type Guideline = {
  id: string
  title: string
  category: string
  body: string
  audience: string
  status: 'draft' | 'indexing' | 'approved' | 'archived'
  version: number
  reviewDueAt: string | null
  ownerId: string | null
  ownerName: string | null
  authorName: string | null
  updatedAt: string
  activeVersionId: string | null
  sourceDocument: { id: string; filename: string | null } | null
}

type DocumentPreview = {
  id: string
  filename: string
  sizeBytes: number
  extractedText: string
  warnings: string[]
  status: string
  scanStatus: string
  ocrStatus: string
  ocrConfidence?: number | null
}

type EvaluationCase = { id: string; question: string; expectedGuidelineId: string; audience: string; language: string }
type EvaluationRun = { id: string; status: string; totalCases: number; passedCases: number; meanReciprocalRank: string | null; permissionLeaks: number; averageLatencyMs: number | null; createdAt: string }
type OwnerOption = { id: string; name: string }

const auth = useAuthStore()
const { t, locale } = useI18n()
const guidelines = ref<Guideline[]>([])
const owners = ref<OwnerOption[]>([])
const loading = ref(true)
const saving = ref(false)
const uploading = ref(false)
const reextracting = ref(false)
const briefingKey = ref<string | null>(null)
const briefs = ref<Record<string, string>>({})
const error = ref<string | null>(null)
const showForm = ref(false)
const editingId = ref<string | null>(null)
const documentPreview = ref<DocumentPreview | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const evaluationCases = ref<EvaluationCase[]>([])
const evaluationRuns = ref<EvaluationRun[]>([])
const evaluationForm = ref({ question: '', expectedGuidelineId: '', expectedText: '', audience: 'all', language: 'en' })
const form = ref({ title: '', category: '', ownerId: '', audience: 'all', body: '', reviewDueAt: '' })
const canWrite = computed(() => auth.hasPermission('knowledge.write'))
const canApprove = computed(() => auth.hasPermission('knowledge.approve'))

function appLocale(): 'en' | 'yo' | 'pcm' | 'fr' {
  const value = String(locale.value)
  return value === 'yo' || value === 'pcm' || value === 'fr' ? value : 'en'
}

function briefErrorMessage(err: unknown) {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : ''
  if (code === 'llm_unavailable') return t('operationsLibrary.briefUnavailable')
  if (code === 'budget_exhausted') return t('operationsLibrary.briefBudget')
  if (code === 'empty') return t('operationsLibrary.briefEmpty')
  return err instanceof Error ? err.message : t('operationsLibrary.briefFailed')
}

async function load() {
  loading.value = true
  error.value = null
  try {
    guidelines.value = (await api<{ guidelines: Guideline[] }>('/api/operation-guidelines')).guidelines
    if (canWrite.value) {
      owners.value = (await api<{ owners: OwnerOption[] }>('/api/operation-guidelines/owners')).owners
    }
    if (canApprove.value) {
      const [cases, runs] = await Promise.all([
        api<{ cases: EvaluationCase[] }>('/api/operation-guidelines/evaluations/cases'),
        api<{ runs: EvaluationRun[] }>('/api/operation-guidelines/evaluations/runs'),
      ])
      evaluationCases.value = cases.cases
      evaluationRuns.value = runs.runs
    }
  }
  catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.loadFailed') }
  finally { loading.value = false }
}

async function create() {
  saving.value = true
  error.value = null
  try {
    const path = editingId.value
      ? `/api/operation-guidelines/${editingId.value}`
      : documentPreview.value
        ? `/api/operation-guidelines/imports/${documentPreview.value.id}/create-draft`
        : '/api/operation-guidelines'
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body: JSON.stringify({ ...form.value, reviewDueAt: form.value.reviewDueAt ? new Date(`${form.value.reviewDueAt}T12:00:00.000Z`).toISOString() : null }) })
    form.value = { title: '', category: '', ownerId: auth.user?.id ?? '', audience: 'all', body: '', reviewDueAt: '' }
    editingId.value = null
    documentPreview.value = null
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
    ownerId: guideline.ownerId ?? '',
    audience: guideline.audience,
    body: guideline.body,
    reviewDueAt: guideline.reviewDueAt?.slice(0, 10) ?? '',
  }
  showForm.value = true
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function closeForm() {
  if (documentPreview.value) {
    try { await api(`/api/operation-guidelines/imports/${documentPreview.value.id}`, { method: 'DELETE' }) }
    catch { /* The preview may already have become a draft; closing the UI is still safe. */ }
  }
  showForm.value = false
  editingId.value = null
  documentPreview.value = null
  form.value = { title: '', category: '', ownerId: auth.user?.id ?? '', audience: 'all', body: '', reviewDueAt: '' }
}

function toggleForm() {
  if (showForm.value) void closeForm()
  else {
    if (!form.value.ownerId) form.value.ownerId = auth.user?.id ?? ''
    showForm.value = true
  }
}

async function uploadDocument(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploading.value = true
  error.value = null
  try {
    const data = new FormData()
    data.append('file', file)
    const result = await api<{ document: DocumentPreview }>('/api/operation-guidelines/imports/preview', { method: 'POST', body: data })
    let preview = result.document
    for (let attempt = 0; attempt < 200 && !['needs_review', 'failed', 'quarantined'].includes(preview.status); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_500))
      preview = (await api<{ document: DocumentPreview }>(`/api/operation-guidelines/imports/${preview.id}`)).document
    }
    if (preview.status === 'quarantined') throw new Error(t('operationsLibrary.malwareQuarantined'))
    if (preview.status !== 'needs_review') throw new Error(t('operationsLibrary.processingFailed'))
    documentPreview.value = preview
    form.value = {
      title: preview.filename.replace(/\.(pdf|docx)$/i, '').replace(/[-_]+/g, ' '),
      category: '',
      ownerId: auth.user?.id ?? '',
      audience: 'all',
      body: preview.extractedText,
      reviewDueAt: '',
    }
    editingId.value = null
    showForm.value = true
    const next = { ...briefs.value }
    delete next.form
    briefs.value = next
  } catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.uploadFailed') }
  finally { uploading.value = false }
}

async function reextractSource(documentId: string) {
  reextracting.value = true
  error.value = null
  try {
    const result = await api<{ document: { extractedText: string; warnings: string[]; filename: string } }>(
      `/api/operation-guidelines/documents/${documentId}/reextract`,
      { method: 'POST' },
    )
    form.value.body = result.document.extractedText
    const next = { ...briefs.value }
    delete next.form
    briefs.value = next
    if (documentPreview.value?.id === documentId) {
      documentPreview.value = {
        ...documentPreview.value,
        extractedText: result.document.extractedText,
        warnings: result.document.warnings,
      }
    }
    if (!showForm.value) {
      const guideline = guidelines.value.find((item) => item.sourceDocument?.id === documentId)
      if (guideline) editGuideline({ ...guideline, body: result.document.extractedText })
      else showForm.value = true
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('operationsLibrary.reextractFailed')
  } finally {
    reextracting.value = false
  }
}

async function briefSource(key: string, payload: { guidelineId?: string; documentId?: string; title?: string; body?: string }) {
  if (briefingKey.value) return
  briefingKey.value = key
  error.value = null
  try {
    const result = await api<{ brief: string }>('/api/operation-guidelines/brief', {
      method: 'POST',
      body: JSON.stringify({ ...payload, locale: appLocale() }),
    })
    briefs.value = { ...briefs.value, [key]: result.brief }
  } catch (e) {
    error.value = briefErrorMessage(e)
  } finally {
    briefingKey.value = null
  }
}

function briefForm() {
  return briefSource('form', {
    documentId: documentPreview.value?.id,
    title: form.value.title,
    body: form.value.body,
  })
}

async function addEvaluationCase() {
  saving.value = true
  error.value = null
  try {
    await api('/api/operation-guidelines/evaluations/cases', {
      method: 'POST',
      body: JSON.stringify({ ...evaluationForm.value, expectedText: evaluationForm.value.expectedText || null }),
    })
    evaluationForm.value = { question: '', expectedGuidelineId: '', expectedText: '', audience: 'all', language: 'en' }
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.evaluationSaveFailed') }
  finally { saving.value = false }
}

async function runEvaluation() {
  saving.value = true
  error.value = null
  try {
    await api('/api/operation-guidelines/evaluations/runs', { method: 'POST' })
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('operationsLibrary.evaluationRunFailed') }
  finally { saving.value = false }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div><p class="text-xs font-bold uppercase tracking-widest text-farm-gold">{{ t('operationsLibrary.eyebrow') }}</p><h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('operationsLibrary.title') }}</h2><p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('operationsLibrary.description') }}</p></div>
      <div v-if="canWrite" class="flex flex-wrap gap-2">
        <input ref="fileInput" class="sr-only" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" @change="uploadDocument" />
        <button type="button" :disabled="uploading" class="min-h-11 rounded-xl border border-farm-green px-4 py-2 text-sm font-bold text-emerald-300 disabled:opacity-50" @click="fileInput?.click()">{{ uploading ? t('operationsLibrary.extracting') : t('operationsLibrary.uploadDocument') }}</button>
        <button type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white" @click="toggleForm">{{ showForm ? t('operationsLibrary.closeForm') : t('operationsLibrary.newGuideline') }}</button>
      </div>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-400" role="alert">{{ error }}</p>
    <form v-if="showForm && canWrite" class="mt-6 grid gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:grid-cols-2" @submit.prevent="create">
      <div v-if="documentPreview" class="rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-4 text-sm text-slate-300 sm:col-span-2">
        <strong class="text-white">{{ t('operationsLibrary.reviewExtraction') }}</strong>
        <p class="mt-1">{{ documentPreview.filename }} · {{ Math.ceil(documentPreview.sizeBytes / 1024) }} KB</p>
        <p class="mt-2 text-slate-400">{{ t('operationsLibrary.reviewExtractionHelp') }}</p>
        <p class="mt-2 text-xs text-emerald-300">{{ t('operationsLibrary.safeProcessingComplete') }}<template v-if="documentPreview.ocrStatus === 'completed'"> · {{ t('operationsLibrary.ocrUsed', { confidence: documentPreview.ocrConfidence ?? 0 }) }}</template></p>
        <ul v-if="documentPreview.warnings.length" class="mt-2 list-disc space-y-1 pl-5 text-amber-300"><li v-for="warning in documentPreview.warnings" :key="warning">{{ warning }}</li></ul>
        <button type="button" :disabled="reextracting" class="mt-3 min-h-10 rounded-lg border border-emerald-700 px-3 text-xs font-bold text-emerald-300 disabled:opacity-50" @click="reextractSource(documentPreview.id)">{{ reextracting ? t('operationsLibrary.reextracting') : t('operationsLibrary.reextractSource') }}</button>
      </div>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.titleLabel') }}<input v-model="form.title" required minlength="3" maxlength="160" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" /></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.category') }}<input v-model="form.category" required maxlength="80" :placeholder="t('operationsLibrary.categoryPlaceholder')" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" /></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.ownerLabel') }}<select v-model="form.ownerId" required class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white"><option value="" disabled>{{ t('operationsLibrary.chooseOwner') }}</option><option v-for="owner in owners" :key="owner.id" :value="owner.id">{{ owner.name }}</option></select><span class="mt-1 block text-[11px] leading-4 text-slate-500">{{ t('operationsLibrary.ownerHelp') }}</span></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.audienceLabel') }}<select v-model="form.audience" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white"><option value="all">{{ t('operationsLibrary.everyone') }}</option><option value="management">{{ t('operationsLibrary.management') }}</option><option value="finance">{{ t('operationsLibrary.finance') }}</option><option value="operations">{{ t('operationsLibrary.operations') }}</option><option value="sales">{{ t('operationsLibrary.sales') }}</option></select></label>
      <label class="text-xs text-slate-400">{{ t('operationsLibrary.reviewDue') }}<input v-model="form.reviewDueAt" type="date" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" /></label>
      <label class="text-xs text-slate-400 sm:col-span-2">{{ t('operationsLibrary.guideline') }}<textarea v-model="form.body" required minlength="20" maxlength="250000" rows="14" :placeholder="t('operationsLibrary.guidelinePlaceholder')" class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm leading-6 text-white" /></label>
      <div v-if="form.body.trim()" class="rounded-xl border border-slate-800 bg-slate-950/70 p-4 sm:col-span-2">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs font-bold uppercase tracking-widest text-slate-500">{{ t('operationsLibrary.previewLabel') }}</p>
          <button data-testid="summarize-form-document" type="button" :disabled="Boolean(briefingKey) || form.body.trim().length < 20" class="min-h-11 w-full rounded-lg border border-emerald-700 px-4 py-2 text-sm font-bold text-emerald-300 disabled:opacity-50 sm:w-auto" @click="briefForm">{{ briefingKey === 'form' ? t('operationsLibrary.briefing') : briefs.form ? t('operationsLibrary.refreshSummary') : t('operationsLibrary.summarizeDocument') }}</button>
        </div>
        <div v-if="briefs.form" data-testid="form-document-summary" class="mb-4 rounded-xl border border-amber-700/40 bg-amber-950/20 p-4">
          <p class="mb-2 text-xs font-bold uppercase tracking-widest text-amber-300">{{ t('operationsLibrary.documentSummary') }}</p>
          <ChatMarkdown :text="briefs.form" />
          <p class="mt-3 text-xs text-slate-500">{{ t('operationsLibrary.briefHelp') }}</p>
        </div>
        <ChatMarkdown :text="form.body" />
      </div>
      <div class="sm:col-span-2"><button type="submit" :disabled="saving" class="min-h-11 rounded-xl bg-farm-green px-5 py-2 font-bold text-white disabled:opacity-50">{{ saving ? t('operationsLibrary.saving') : editingId ? t('operationsLibrary.updateDraft') : t('operationsLibrary.saveDraft') }}</button></div>
    </form>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('operationsLibrary.loading') }}</div>
    <p v-else-if="!guidelines.length" class="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-8 text-sm text-slate-400">{{ t('operationsLibrary.empty') }}</p>
    <div v-else class="mt-8 space-y-4">
      <CollapsibleSection v-for="guideline in guidelines" :key="guideline.id" :title="guideline.title" :description="`${guideline.category} · ${t('operationsLibrary.version', { version: guideline.version })} · ${guideline.status}`" :default-open="false">
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button :data-testid="`summarize-${guideline.id}`" type="button" :disabled="Boolean(briefingKey)" class="min-h-11 w-full rounded-lg border border-emerald-700 px-4 py-2 text-sm font-bold text-emerald-300 disabled:opacity-50 sm:w-auto" @click="briefSource(guideline.id, { guidelineId: guideline.id })">{{ briefingKey === guideline.id ? t('operationsLibrary.briefing') : briefs[guideline.id] ? t('operationsLibrary.refreshSummary') : t('operationsLibrary.summarizeDocument') }}</button>
        </div>
        <div v-if="briefs[guideline.id]" :data-testid="`summary-${guideline.id}`" class="mt-4 rounded-xl border border-amber-700/40 bg-amber-950/20 p-4">
          <p class="mb-2 text-xs font-bold uppercase tracking-widest text-amber-300">{{ t('operationsLibrary.documentSummary') }}</p>
          <ChatMarkdown :text="briefs[guideline.id]" />
          <p class="mt-3 text-xs text-slate-500">{{ t('operationsLibrary.briefHelp') }}</p>
        </div>
        <details :data-testid="`full-document-${guideline.id}`" class="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4" :open="!briefs[guideline.id]">
          <summary class="min-h-11 cursor-pointer content-center text-sm font-bold text-slate-300">{{ t('operationsLibrary.fullDocument') }}</summary>
          <div class="mt-4 border-t border-slate-800 pt-4 text-sm leading-6 text-slate-300">
            <ChatMarkdown :text="guideline.body" />
          </div>
        </details>
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <a v-if="guideline.sourceDocument" class="inline-flex min-h-10 items-center text-sm font-bold text-emerald-300 underline underline-offset-4" :href="resolveApiUrl(`/api/operation-guidelines/documents/${guideline.sourceDocument.id}/download`)">{{ t('operationsLibrary.downloadSource', { filename: guideline.sourceDocument.filename }) }}</a>
          <button v-if="guideline.sourceDocument && canWrite" type="button" :disabled="reextracting" class="min-h-10 rounded-lg border border-slate-700 px-3 text-xs font-bold text-slate-300 disabled:opacity-50" @click="reextractSource(guideline.sourceDocument.id)">{{ reextracting ? t('operationsLibrary.reextracting') : t('operationsLibrary.reextractSource') }}</button>
        </div>
        <p v-if="guideline.sourceDocument && canWrite" class="mt-2 text-xs text-slate-500">{{ t('operationsLibrary.reextractHelp') }}</p>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4 text-xs text-slate-500">
          <span>{{ t('operationsLibrary.owner', { owner: guideline.ownerName ?? t('operationsLibrary.unassignedOwner') }) }} · {{ t('operationsLibrary.documentedBy', { author: guideline.authorName ?? t('operationsLibrary.formerMember') }) }} · {{ t('operationsLibrary.audience', { audience: audienceLabel(guideline.audience) }) }}</span>
          <div class="flex gap-2"><button v-if="canWrite && guideline.status !== 'archived'" type="button" class="min-h-10 rounded-lg bg-slate-800 px-3 font-bold text-slate-300" @click="editGuideline(guideline)">{{ t('operationsLibrary.edit') }}</button><button v-if="canApprove && guideline.status === 'draft'" type="button" class="min-h-10 rounded-lg bg-emerald-500/15 px-3 font-bold text-emerald-300" @click="changeStatus(guideline, 'approve')">{{ t('operationsLibrary.approve') }}</button><button v-if="canApprove && guideline.status !== 'archived'" type="button" class="min-h-10 rounded-lg bg-slate-800 px-3 font-bold text-slate-300" @click="changeStatus(guideline, 'archive')">{{ t('operationsLibrary.archive') }}</button></div>
        </div>
      </CollapsibleSection>
    </div>

    <CollapsibleSection v-if="canApprove" class="mt-8" :title="t('operationsLibrary.evaluationTitle')" :description="t('operationsLibrary.evaluationDescription')" :default-open="false">
      <form class="mt-4 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4 sm:grid-cols-2" @submit.prevent="addEvaluationCase">
        <label class="text-xs text-slate-400 sm:col-span-2">{{ t('operationsLibrary.evaluationQuestion') }}<input v-model="evaluationForm.question" required minlength="3" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
        <label class="text-xs text-slate-400">{{ t('operationsLibrary.expectedGuideline') }}<select v-model="evaluationForm.expectedGuidelineId" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="">{{ t('operationsLibrary.chooseGuideline') }}</option><option v-for="guideline in guidelines.filter((item) => item.activeVersionId)" :key="guideline.id" :value="guideline.id">{{ guideline.title }}</option></select></label>
        <label class="text-xs text-slate-400">{{ t('operationsLibrary.language') }}<select v-model="evaluationForm.language" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="en">English</option><option value="yo">Yorùbá</option><option value="pcm">Pidgin</option><option value="fr">Français</option></select></label>
        <label class="text-xs text-slate-400">{{ t('operationsLibrary.audienceLabel') }}<select v-model="evaluationForm.audience" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="all">{{ t('operationsLibrary.everyone') }}</option><option value="management">{{ t('operationsLibrary.management') }}</option><option value="finance">{{ t('operationsLibrary.finance') }}</option><option value="operations">{{ t('operationsLibrary.operations') }}</option><option value="sales">{{ t('operationsLibrary.sales') }}</option></select></label>
        <label class="text-xs text-slate-400">{{ t('operationsLibrary.expectedText') }}<input v-model="evaluationForm.expectedText" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
        <div class="flex flex-wrap gap-2 sm:col-span-2"><button type="submit" :disabled="saving" class="min-h-11 rounded-lg bg-farm-green px-4 font-bold text-white">{{ t('operationsLibrary.addEvaluationCase') }}</button><button type="button" :disabled="saving || !evaluationCases.length" class="min-h-11 rounded-lg border border-farm-green px-4 font-bold text-emerald-300 disabled:opacity-50" @click="runEvaluation">{{ t('operationsLibrary.runEvaluation', { count: evaluationCases.length }) }}</button></div>
      </form>
      <div v-if="evaluationRuns.length" class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <article v-for="run in evaluationRuns.slice(0, 6)" :key="run.id" class="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300"><div class="flex justify-between gap-2"><strong class="text-white">{{ run.status }}</strong><span>{{ new Date(run.createdAt).toLocaleDateString() }}</span></div><p class="mt-2">{{ t('operationsLibrary.evaluationScore', { passed: run.passedCases, total: run.totalCases }) }}</p><p class="mt-1 text-xs text-slate-400">MRR {{ run.meanReciprocalRank ?? '—' }} · {{ t('operationsLibrary.permissionLeaks', { count: run.permissionLeaks }) }} · {{ run.averageLatencyMs ?? '—' }} ms</p></article>
      </div>
    </CollapsibleSection>
  </AppLayout>
</template>
