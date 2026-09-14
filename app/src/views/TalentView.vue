<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { api, resolveApiUrl } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type Candidate = { id: string; name: string; email: string | null; phone: string | null; location: string | null }
type Application = { id: string; candidateId: string; roleLabel: string; stage: string; source: string; needsReview: boolean;
  careerPostId: string | null; assignedToId: string | null; nextAction: string | null; dueAt: string | null;
  receivedAt: string; retentionUntil: string; acknowledgedAt: string | null }
type Row = { application: Application; candidate: Candidate }
type TalentDocument = { id: string; filename: string; kind: string; extractionStatus: string; extractedText: string | null;
  extractedFields: Record<string, string | null> | null; warnings: string[] }
type Detail = Row & { documents: TalentDocument[]; events: { id: string; kind: string; body: string; occurredAt: string }[];
  otherApplications: { id: string; roleLabel: string; stage: string }[] }
type Metadata = { jobs: { id: string; title: string; published: boolean }[]; reviewers: { id: string; name: string }[]; stages: string[];
  zoho: { configured: boolean; automaticIntake: boolean; sendingEnabled: boolean; folderCount: number };
  sync: { lastSyncedAt: string | null; lastError: string | null }[] }

const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('talent.manage'))
const canAdmin = computed(() => auth.hasPermission('talent.admin'))
const rows = ref<Row[]>([])
const detail = ref<Detail | null>(null)
const metadata = ref<Metadata | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const hasMore = ref(false)
const offset = ref(0)
const importOpen = ref(false)
const importRole = ref('')
const importResults = ref<{ name: string; status: string; id?: string }[]>([])
const selectedFiles = ref<File[]>([])
const supportingFile = ref<File | null>(null)
const batchInput = ref<HTMLInputElement | null>(null)
const supportingInput = ref<HTMLInputElement | null>(null)
const note = ref('')
const emailSubject = ref('')
const emailBody = ref('')
const sendRequestId = ref(crypto.randomUUID())
const retentionDate = ref('')
const retentionReason = ref('')
const filters = reactive({ q: '', stage: '', job: '', assigned: '', review: false, from: '', to: '' })
const form = reactive({ name: '', email: '', phone: '', location: '', stage: 'new', careerPostId: '', assignedToId: '',
  nextAction: '', dueAt: '', needsReview: true, linkExistingCandidate: false })

function label(value: string) { return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()) }
function date(value: string | null) { return value ? new Date(value).toLocaleDateString() : '—' }
function overdue(application: Application) { return Boolean(application.dueAt && new Date(application.dueAt).getTime() < Date.now() && !['hired', 'rejected', 'withdrawn'].includes(application.stage)) }
function localDateTime(value: string | null) {
  if (!value) return ''
  const instant = new Date(value)
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
async function action(work: () => Promise<void>) {
  busy.value = true; error.value = ''; notice.value = ''
  try { await work() } catch (e) { error.value = e instanceof Error ? e.message : 'Something went wrong' }
  finally { busy.value = false }
}
async function load() {
  loading.value = true
  try {
    const query = new URLSearchParams({ offset: String(offset.value) })
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value))
    const result = await api<{ applications: Row[]; hasMore: boolean }>(`/api/talent?${query}`)
    rows.value = result.applications; hasMore.value = result.hasMore
    metadata.value = await api<Metadata>('/api/talent/metadata')
  } finally { loading.value = false }
}
async function select(id: string) {
  const result = await api<Detail>(`/api/talent/${id}`)
  detail.value = result
  supportingFile.value = null
  if (supportingInput.value) supportingInput.value.value = ''
  Object.assign(form, { name: result.candidate.name, email: result.candidate.email ?? '', phone: result.candidate.phone ?? '',
    location: result.candidate.location ?? '', stage: result.application.stage, careerPostId: result.application.careerPostId ?? '',
    assignedToId: result.application.assignedToId ?? '', nextAction: result.application.nextAction ?? '',
    dueAt: localDateTime(result.application.dueAt), needsReview: result.application.needsReview, linkExistingCandidate: false })
  note.value = ''; emailBody.value = ''; emailSubject.value = `Your Trovara application — ${result.application.roleLabel}`
  sendRequestId.value = crypto.randomUUID(); retentionDate.value = result.application.retentionUntil.slice(0, 10)
}
async function save() {
  if (!detail.value) return
  const id = detail.value.application.id
  await api(`/api/talent/${id}`, { method: 'PATCH', body: JSON.stringify({ stage: form.stage,
    careerPostId: form.careerPostId || null, assignedToId: form.assignedToId || null, nextAction: form.nextAction || null,
    dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null, needsReview: form.needsReview,
    candidate: { name: form.name, email: form.email || null, phone: form.phone || null, location: form.location || null },
    linkExistingCandidate: form.linkExistingCandidate }) })
  await select(id); await load(); notice.value = 'Application saved.'
}
function useSuggestions(document: TalentDocument) {
  const fields = document.extractedFields
  if (!fields) return
  for (const key of ['name', 'email', 'phone', 'location'] as const) if (fields[key]) form[key] = fields[key]!
  form.needsReview = true
  notice.value = 'Suggestions copied into the form. Check them against the CV before saving.'
}
async function importFiles() {
  importResults.value = []
  for (const file of selectedFiles.value) {
    const result: { name: string; status: string; id?: string } = { name: file.name, status: 'Uploading…' }
    importResults.value.push(result)
    const index = importResults.value.length - 1
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Larger than 10 MB')
      const body = new FormData(); body.append('file', file)
      if (importRole.value) body.append('careerPostId', importRole.value)
      const response = await api<{ id: string; duplicate: boolean }>('/api/talent/import', { method: 'POST', body })
      importResults.value[index] = { name: file.name, id: response.id, status: response.duplicate ? 'Already imported — no duplicate created' : 'Imported — extraction queued' }
    } catch (e) { importResults.value[index] = { name: file.name, status: e instanceof Error ? e.message : 'Import failed' } }
  }
  selectedFiles.value = []
  if (batchInput.value) batchInput.value.value = ''
  await load()
}
async function addNote() {
  if (!detail.value) return
  const id = detail.value.application.id
  await api(`/api/talent/${id}/notes`, { method: 'POST', body: JSON.stringify({ body: note.value }) })
  await select(id)
}
async function sendEmail() {
  if (!detail.value || !confirm(`Send this message from hello@trovara.farm to ${detail.value.candidate.email}?`)) return
  const id = detail.value.application.id
  await api(`/api/talent/${id}/messages`, { method: 'POST', body: JSON.stringify({ subject: emailSubject.value, body: emailBody.value, requestId: sendRequestId.value }) })
  await select(id); notice.value = 'Message submitted to Zoho.'
}
async function sync() {
  const result = await api<{ imported: number; duplicates: number; failed: number; busy: boolean }>('/api/talent/sync', { method: 'POST' })
  await load()
  notice.value = result.busy ? 'Another sync is running.' : `This page: ${result.imported} imported, ${result.duplicates} already present, ${result.failed} failed. Further pages are processed by the worker or the next sync.`
}
async function remove() {
  if (!detail.value || !confirm('Permanently delete this application, documents and notes? The candidate profile is retained only if they have another application. This cannot be undone.')) return
  await api(`/api/talent/${detail.value.application.id}`, { method: 'DELETE' })
  detail.value = null; await load(); notice.value = 'Application and its private documents deleted.'
}
async function retain() {
  if (!detail.value) return
  await api(`/api/talent/${detail.value.application.id}/retention`, { method: 'POST', body: JSON.stringify({ until: new Date(`${retentionDate.value}T23:59:59`).toISOString(), reason: retentionReason.value }) })
  await select(detail.value.application.id); notice.value = 'Retention decision recorded.'
}
async function retryExtraction() {
  if (!detail.value) return
  await api(`/api/talent/${detail.value.application.id}/extract`, { method: 'POST' })
  await select(detail.value.application.id); notice.value = 'Extraction queued for the worker.'
}
async function attachDocument() {
  if (!detail.value || !supportingFile.value) return
  const id = detail.value.application.id
  const body = new FormData(); body.append('file', supportingFile.value)
  await api(`/api/talent/${id}/documents`, { method: 'POST', body })
  supportingFile.value = null; await select(id); notice.value = 'Document attached; extraction queued.'
}
onMounted(() => action(load))
</script>

<template>
  <AppLayout>
    <main class="talent space-y-6">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div><p class="eyebrow">People &amp; opportunity</p><h1 class="text-3xl font-black text-os-fg">Talent</h1><p class="text-slate-400 mt-2">One place for applications, CVs and hiring follow-ups.</p></div>
        <div class="flex flex-wrap gap-2">
          <RouterLink v-if="auth.hasPermission('careers.manage')" to="/careers" class="button">Manage roles</RouterLink>
          <button v-if="canManage" class="button primary" :disabled="busy" @click="importOpen = !importOpen">Import applications</button>
          <button class="button" :disabled="busy" @click="action(async () => { await load(); if (detail) await select(detail.application.id) })">Refresh</button>
        </div>
      </header>
      <p v-if="error" role="alert" class="alert error">{{ error }}</p>
      <p v-if="notice" role="status" class="alert">{{ notice }}</p>
      <section class="panel intake flex flex-wrap items-center justify-between gap-3" aria-label="Email intake">
        <div><strong>Zoho · hello@trovara.farm</strong><p class="text-sm text-slate-400 mt-1">{{ metadata?.zoho.configured ? `${metadata.zoho.folderCount} recruitment folder(s) configured. ${metadata.zoho.automaticIntake ? 'Automatic intake enabled; worker required.' : 'Manual intake only.'}` : 'CV and EML uploads are available. Connect Zoho on the server to import designated recruitment folders.' }}</p>
          <p v-for="(entry, index) in metadata?.sync.filter(item => item.lastError)" :key="index" class="text-amber-300 text-sm">{{ entry.lastError }}</p>
        </div>
        <button v-if="canAdmin" class="button" :disabled="busy || !metadata?.zoho.configured" @click="action(sync)">Sync Zoho page</button>
      </section>
      <section v-if="importOpen && canManage" class="panel space-y-4" aria-labelledby="import-heading">
        <h2 id="import-heading" class="text-lg font-bold">Bring existing applications into Talent</h2>
        <p class="text-slate-400 text-sm">Upload CVs alone (PDF/DOCX) or original emails (EML). No applicant details need to be typed first. Each file is scanned, stored privately and queued for extraction. Maximum 10 MB per file; up to 20 files per batch.</p>
        <label>Role for this batch<select v-model="importRole"><option value="">Unassigned — decide during review</option><option v-for="job in metadata?.jobs" :key="job.id" :value="job.id">{{ job.title }}</option></select></label>
        <label>Application files<input ref="batchInput" type="file" multiple accept=".pdf,.docx,.eml" :disabled="busy" @change="selectedFiles = Array.from(($event.target as HTMLInputElement).files ?? []).slice(0, 20)" /></label>
        <button class="button primary" :disabled="busy || !selectedFiles.length" @click="action(importFiles)">{{ busy ? 'Processing…' : `Import ${selectedFiles.length || ''} files` }}</button>
        <ul class="text-sm space-y-2" aria-live="polite"><li v-for="(result, index) in importResults" :key="index"><strong>{{ result.name }}</strong> — {{ result.status }} <button v-if="result.id" class="text-emerald-300 underline" @click="action(() => select(result.id!))">Review</button></li></ul>
      </section>
      <form class="panel filters" @submit.prevent="offset = 0; action(load)">
        <label class="search">Search<input v-model="filters.q" type="search" placeholder="Name, email or role" maxlength="150" /></label>
        <label>Stage<select v-model="filters.stage"><option value="">All stages</option><option v-for="stage in metadata?.stages" :key="stage" :value="stage">{{ label(stage) }}</option></select></label>
        <label>Role<select v-model="filters.job"><option value="">All roles</option><option v-for="job in metadata?.jobs" :key="job.id" :value="job.id">{{ job.title }}</option></select></label>
        <label>Reviewer<select v-model="filters.assigned"><option value="">Everyone</option><option v-for="reviewer in metadata?.reviewers" :key="reviewer.id" :value="reviewer.id">{{ reviewer.name }}</option></select></label>
        <label>Received from<input v-model="filters.from" type="date" /></label><label>Received to<input v-model="filters.to" type="date" /></label>
        <label class="check"><input v-model="filters.review" type="checkbox" />Needs review</label><button class="button" :disabled="busy">Filter</button>
      </form>
      <div class="workspace" :class="{ selected: detail }">
        <section class="panel applications" aria-label="Applications">
          <div class="flex justify-between gap-2 mb-4"><h2 class="font-bold">Applications</h2><span class="text-sm text-slate-400">{{ offset + (rows.length ? 1 : 0) }}–{{ offset + rows.length }}{{ hasMore ? '+' : '' }}</span></div>
          <p v-if="loading" role="status">Loading applications…</p>
          <div v-else-if="!rows.length" class="empty"><h3 class="font-semibold">No applications here yet</h3><p class="text-slate-400 mt-2">Import your existing CVs or adjust the filters. Applicants will appear here when online applications or Zoho intake are enabled.</p></div>
          <ul v-else class="space-y-2"><li v-for="row in rows" :key="row.application.id">
            <button class="application" :class="{ active: detail?.application.id === row.application.id }" :aria-pressed="detail?.application.id === row.application.id" :disabled="busy" @click="action(() => select(row.application.id))">
              <div class="flex justify-between gap-2"><strong>{{ row.candidate.name }}</strong><span class="badge">{{ label(row.application.stage) }}</span></div>
              <p class="text-sm mt-1">{{ row.application.roleLabel }}</p>
              <p class="text-xs text-slate-400 mt-2">{{ date(row.application.receivedAt) }} · {{ label(row.application.source) }}</p>
              <div class="flex flex-wrap gap-2 mt-2"><span v-if="row.application.needsReview" class="badge review">Needs review</span><span v-if="overdue(row.application)" class="badge overdue">Follow-up overdue</span></div>
            </button>
          </li></ul>
          <div class="flex justify-between gap-3 mt-5"><button class="button" :disabled="busy || offset === 0" @click="offset -= 50; action(load)">Previous</button><button class="button" :disabled="busy || !hasMore" @click="offset += 50; action(load)">Next</button></div>
        </section>
        <section v-if="detail" class="panel detail space-y-6" aria-label="Application details">
          <header class="flex justify-between gap-2"><div><p class="eyebrow">Application record</p><h2 class="text-xl font-bold">{{ detail.candidate.name }}</h2><p class="reference">{{ detail.application.id }}</p></div><button aria-label="Close application" class="button" @click="detail = null">Close</button></header>
          <form class="space-y-4" @submit.prevent="action(save)">
            <fieldset :disabled="!canManage || busy" class="fields">
              <label>Full name<input v-model="form.name" required maxlength="200" /></label><label>Email<input v-model="form.email" type="email" maxlength="320" /></label>
              <label>Phone<input v-model="form.phone" type="tel" maxlength="80" /></label><label>Location<input v-model="form.location" maxlength="300" /></label>
              <label>Role<select v-model="form.careerPostId"><option value="">Unassigned / general interest</option><option v-for="job in metadata?.jobs" :key="job.id" :value="job.id">{{ job.title }}</option></select></label>
              <label>Stage<select v-model="form.stage"><option v-for="stage in metadata?.stages" :key="stage" :value="stage">{{ label(stage) }}</option></select></label>
              <label>Assigned reviewer<select v-model="form.assignedToId"><option value="">Unassigned</option><option v-for="reviewer in metadata?.reviewers" :key="reviewer.id" :value="reviewer.id">{{ reviewer.name }}</option></select></label>
              <label>Follow-up due<input v-model="form.dueAt" type="datetime-local" /></label><label class="wide">Next action<input v-model="form.nextAction" maxlength="1000" placeholder="e.g. Arrange a supervisor interview" /></label>
              <label class="check wide"><input v-model="form.needsReview" type="checkbox" />Needs human review — uncheck only after checking the source documents</label>
              <label class="check wide"><input v-model="form.linkExistingCandidate" type="checkbox" />If this email already exists, link to that candidate without replacing their profile</label>
            </fieldset>
            <p class="text-xs text-slate-400">Contact changes affect this candidate’s other applications. Extracted information is unverified until you review it.</p>
            <button v-if="canManage" class="button primary" :disabled="busy">Save application</button>
          </form>
          <section v-if="detail.otherApplications.length > 1" class="space-y-2"><h3 class="font-semibold">This candidate’s applications</h3><button v-for="application in detail.otherApplications" :key="application.id" class="block text-sm text-emerald-300 underline" :disabled="busy" @click="action(() => select(application.id))">{{ application.roleLabel }} · {{ label(application.stage) }}</button></section>
          <section class="space-y-3"><h3 class="font-semibold">CVs &amp; supporting documents</h3><p v-if="!detail.documents.length" class="text-slate-400">No documents attached.</p>
            <form v-if="canManage" class="space-y-3" @submit.prevent="action(attachDocument)"><label>Add a CV or supporting document<input ref="supportingInput" type="file" accept=".pdf,.docx" :disabled="busy" @change="supportingFile = ($event.target as HTMLInputElement).files?.[0] ?? null" /></label><button class="button" :disabled="busy || !supportingFile">Attach document</button></form>
            <article v-for="document in detail.documents" :key="document.id" class="document space-y-3">
              <div class="flex flex-wrap justify-between gap-2"><strong class="break-all">{{ document.filename }}</strong><a class="text-emerald-300 underline text-sm" :href="resolveApiUrl(`/api/talent/${detail.application.id}/documents/${document.id}`)">Download original</a></div>
              <p class="text-xs text-slate-400">{{ label(document.kind) }} · {{ label(document.extractionStatus) }}</p>
              <p v-if="['pending', 'processing'].includes(document.extractionStatus)" class="text-sm text-slate-400">Background extraction queued. Refresh after the Talent worker runs.</p>
              <p v-for="warning in document.warnings" :key="warning" class="text-sm text-amber-200">{{ warning }}</p>
              <button v-if="canManage && document.extractedFields" class="button" :disabled="busy" @click="useSuggestions(document)">Use suggested contact details</button>
              <details v-if="document.extractedFields"><summary>Extracted profile sections</summary><dl class="mt-3 space-y-3"><template v-for="(value, key) in document.extractedFields" :key="key"><dt class="text-sm font-semibold">{{ label(String(key)) }}</dt><dd class="whitespace-pre-wrap text-sm text-slate-300">{{ value || 'Not found — review the CV' }}</dd></template></dl></details>
              <details v-if="document.extractedText"><summary>Full extracted CV text</summary><pre class="cv-text">{{ document.extractedText }}</pre></details>
            </article>
            <button v-if="canManage && detail.documents.some(doc => doc.extractionStatus === 'needs_review')" class="button" :disabled="busy" @click="action(retryExtraction)">Retry failed extraction</button>
          </section>
          <form v-if="canManage" class="space-y-3" @submit.prevent="action(addNote)"><h3 class="font-semibold">Private hiring note</h3><label>Note<textarea v-model="note" rows="3" maxlength="10000" required placeholder="Record job-related observations and next steps." /></label><button class="button" :disabled="busy || !note.trim()">Add note</button></form>
          <details v-if="canManage"><summary>Send an email through Zoho</summary><p class="text-sm text-slate-400 my-3">From hello@trovara.farm. Review imported contact details first. Messages are sent only when you confirm.</p>
            <form class="space-y-3" @submit.prevent="action(sendEmail)"><label>Subject<input v-model="emailSubject" maxlength="200" required /></label><label>Message<textarea v-model="emailBody" rows="5" maxlength="10000" required /></label><button class="button" :disabled="busy || !metadata?.zoho.sendingEnabled">Review &amp; send</button><p v-if="!metadata?.zoho.sendingEnabled" class="text-sm text-amber-200">Zoho sending is not configured yet.</p></form>
          </details>
          <section><h3 class="font-semibold mb-3">Activity &amp; correspondence</h3><ol class="timeline"><li v-for="event in detail.events" :key="event.id"><p class="text-xs text-slate-400">{{ label(event.kind) }} · {{ new Date(event.occurredAt).toLocaleString() }}</p><p class="whitespace-pre-wrap break-words mt-2 text-sm">{{ event.body }}</p></li></ol></section>
          <details><summary>Privacy &amp; retention</summary><p class="text-sm text-slate-400 my-3">Scheduled deletion: {{ date(detail.application.retentionUntil) }}. Applicant requests go to hello@trovara.farm. No automated hiring decisions are made.</p>
            <form v-if="canAdmin" class="space-y-3" @submit.prevent="action(retain)"><label>Retain until<input v-model="retentionDate" type="date" required /></label><label>Reason for changing retention<textarea v-model="retentionReason" minlength="10" maxlength="1000" required /></label><button class="button" :disabled="busy">Record retention decision</button></form>
            <button v-if="canAdmin" class="button danger mt-4" :disabled="busy" @click="action(remove)">Permanently delete application</button>
          </details>
        </section>
      </div>
    </main>
  </AppLayout>
</template>

<style scoped>
.talent { color: var(--os-fg); max-width: 1600px; margin: 0 auto; }
.eyebrow { color: #6ee7b7; font-size: .7rem; text-transform: uppercase; letter-spacing: .16em; margin-bottom: .4rem; font-weight: 700; }
.panel { background: rgb(15 23 42 / .65); border: 1px solid #334155; border-radius: 1rem; padding: 1.25rem; min-width: 0; }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; border: 1px solid #475569; border-radius: .6rem; padding: .5rem .85rem; font-size: .85rem; font-weight: 600; color: #e2e8f0; background: #1e293b; }
.button.primary { background: #065f46; border-color: #10b981; color: #ecfdf5; }.button.danger { border-color: #f87171; color: #fca5a5; }
button:disabled, fieldset:disabled { opacity: .55; }button:disabled { cursor: not-allowed; }
.alert { padding: 1rem; border-radius: .6rem; background: #064e3b; border: 1px solid #059669; }.alert.error { background: #450a0a; border-color: #ef4444; }
label { display: flex; flex-direction: column; gap: .4rem; font-size: .8rem; font-weight: 600; min-width: 0; }
input:not([type=checkbox]), select, textarea { width: 100%; min-width: 0; background: #0f172a; color: #f1f5f9; border: 1px solid #475569; border-radius: .5rem; padding: .65rem; font-size: .9rem; font-weight: 400; }
input[type=checkbox] { accent-color: #10b981; width: 1rem; height: 1rem; flex-shrink: 0; }
.check { flex-direction: row; align-items: center; font-weight: 400; }.filters { display: flex; gap: 1rem; flex-wrap: wrap; align-items: end; }.filters label { flex: 1 1 130px; }.filters .search { flex-basis: 220px; }
.workspace { display: grid; gap: 1.5rem; }.workspace.selected { grid-template-columns: minmax(280px, .8fr) minmax(0, 1.3fr); align-items: start; }
.application { display: block; width: 100%; text-align: left; padding: 1rem; border-radius: .75rem; border: 1px solid #334155; background: #0f172a; overflow-wrap: anywhere; }
.application:hover, .application.active { border-color: #34d399; background: #102c28; }.badge { display: inline-block; flex-shrink: 0; font-size: .65rem; border-radius: 99px; padding: .2rem .6rem; background: #334155; color: #e2e8f0; }.badge.review { color: #fde68a; background: #422006; }.badge.overdue { color: #fecaca; background: #450a0a; }
.empty { padding: 3rem 1rem; text-align: center; }.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }.wide { grid-column: 1 / -1; }.reference { font-size: .7rem; color: #94a3b8; overflow-wrap: anywhere; margin-top: .4rem; }
.document { border: 1px solid #334155; border-radius: .75rem; padding: 1rem; }.cv-text { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: .85rem; max-height: 400px; overflow: auto; padding-top: 1rem; }
.detail > header { align-items: flex-start; }
html.light .talent .panel { background: var(--os-shell); border-color: var(--os-border); }
html.light .talent :is(input:not([type=checkbox]), select, textarea, .application, .button) { background: var(--os-canvas); color: var(--os-fg); border-color: #94a3b8; }
html.light .talent .button.primary { background: #065f46; color: white; }
html.light .talent .button.danger { color: #991b1b; border-color: #dc2626; }
html.light .talent :is(.application.active, .application:hover) { background: #ecfdf5; border-color: #059669; }
html.light .talent .eyebrow { color: #047857; }
html.light .talent .alert { background: #d1fae5; color: #064e3b; }
html.light .talent .alert.error { background: #fee2e2; color: #991b1b; }
summary { cursor: pointer; font-weight: 600; font-size: .9rem; }.timeline { border-left: 1px solid #475569; margin-left: .25rem; }.timeline li { padding: 0 0 1.5rem 1rem; }.timeline li:last-child { padding-bottom: 0; }
:is(button, a, input, textarea, select, summary):focus-visible { outline: 2px solid #6ee7b7; outline-offset: 3px; }
@media (max-width: 1050px) { .workspace.selected { grid-template-columns: 1fr; }.detail { grid-row: 1; } }
@media (max-width: 600px) { .fields { grid-template-columns: 1fr; }.panel { padding: 1rem; }.application .badge { white-space: normal; }.filters label { flex-basis: 100%; } }
</style>
