<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type Option = { id: string; name: string }
type WorkOrder = {
  id: string
  title: string
  description: string | null
  serviceType: string
  priority: string
  status: string
  dueAt: string | null
  checklist: string[]
  completedChecklist: string[]
  estimatedCostMinor: number | null
  actualCostMinor: number | null
  completionNotes: string | null
  asset: { id: string; name: string; assetTag: string | null } | null
  assignedToName: string | null
  contractor: { id: string; name: string; company: string | null } | null
}

const auth = useAuthStore()
const { t } = useI18n()
const canManage = computed(() => auth.hasPermission('maintenance.write'))
const data = ref<{ workOrders: WorkOrder[]; assets: Option[]; staff: Option[]; contractors: Option[] }>({ workOrders: [], assets: [], staff: [], contractors: [] })
const loading = ref(true)
const error = ref('')
const showCreate = ref(false)
const saving = ref(false)
const filter = ref('active')
const form = ref({ assetId: '', title: '', description: '', serviceType: 'preventive', priority: 'normal', dueAt: '', assignedToId: '', contractorId: '', checklist: '', estimatedCost: '' })
const completion = ref<Record<string, { notes: string; parts: string; cost: string; downtime: string; checked: string[]; evidence: string | null }>>({})

const visible = computed(() => data.value.workOrders.filter((row) => filter.value === 'all' || (filter.value === 'active' ? !['completed', 'cancelled'].includes(row.status) : row.status === filter.value)))

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api('/api/maintenance')
    for (const row of data.value.workOrders) {
      completion.value[row.id] ??= { notes: '', parts: '', cost: '', downtime: '', checked: [...(row.completedChecklist ?? [])], evidence: null }
    }
  } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.maintenance.loadFailed') } finally { loading.value = false }
}

async function createWorkOrder() {
  if (!form.value.assetId || !form.value.title.trim()) return
  saving.value = true
  try {
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify({
      assetId: form.value.assetId,
      title: form.value.title.trim(),
      description: form.value.description.trim() || null,
      serviceType: form.value.serviceType,
      priority: form.value.priority,
      dueAt: form.value.dueAt ? new Date(form.value.dueAt).toISOString() : null,
      assignedToId: form.value.assignedToId || null,
      contractorId: form.value.contractorId || null,
      checklist: form.value.checklist.split('\n').map((line) => line.trim()).filter(Boolean),
      estimatedCostMinor: form.value.estimatedCost ? Math.round(Number(form.value.estimatedCost) * 100) : null,
    }) })
    form.value = { assetId: '', title: '', description: '', serviceType: 'preventive', priority: 'normal', dueAt: '', assignedToId: '', contractorId: '', checklist: '', estimatedCost: '' }
    showCreate.value = false
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.maintenance.saveFailed') } finally { saving.value = false }
}

async function setStatus(order: WorkOrder, status: 'in_progress' | 'completed' | 'cancelled') {
  const details = completion.value[order.id] ?? { notes: '', parts: '', cost: '', downtime: '', checked: [], evidence: null }
  if (status === 'completed' && !details.notes.trim()) { error.value = t('roadmapFeatures.maintenance.noteRequired'); return }
  if (status === 'completed' && order.checklist.some((item) => !details.checked.includes(item))) { error.value = t('roadmapFeatures.maintenance.checklistRequired'); return }
  try {
    await api(`/api/maintenance/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({
      status,
      completionNotes: details.notes.trim() || null,
      partsUsed: details.parts.trim() || null,
      actualCostMinor: details.cost ? Math.round(Number(details.cost) * 100) : null,
      downtimeMinutes: details.downtime ? Number(details.downtime) : null,
      completedChecklist: details.checked,
      evidenceUrl: details.evidence,
    }) })
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.maintenance.updateFailed') }
}

function addEvidence(orderId: string, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) { error.value = t('roadmapFeatures.maintenance.imageOnly'); return }
  const reader = new FileReader()
  reader.onload = () => { completion.value[orderId].evidence = String(reader.result) }
  reader.onerror = () => { error.value = t('roadmapFeatures.maintenance.imageFailed') }
  reader.readAsDataURL(file)
}

function money(value: number | null) { return value == null ? '—' : new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(value / 100) }
function date(value: string | null) { return value ? new Date(value).toLocaleDateString() : t('roadmapFeatures.common.noDueDate') }
onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div><p class="text-xs font-bold uppercase tracking-[.2em] text-farm-green">{{ t('roadmapFeatures.maintenance.eyebrow') }}</p><h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('roadmapFeatures.maintenance.title') }}</h2><p class="mt-1 text-sm text-slate-400">{{ t('roadmapFeatures.maintenance.subtitle') }}</p></div>
      <button v-if="canManage" class="rounded-xl bg-farm-green px-4 py-2 font-bold text-slate-950" @click="showCreate = !showCreate">{{ showCreate ? t('roadmapFeatures.common.close') : t('roadmapFeatures.maintenance.schedule') }}</button>
    </div>
    <p v-if="error" class="mt-4 rounded-xl border border-red-700/50 bg-red-950/30 p-3 text-sm text-red-300">{{ error }}</p>

    <CollapsibleSection v-if="showCreate && canManage" class="mt-6" :title="t('roadmapFeatures.maintenance.newTitle')" :description="t('roadmapFeatures.maintenance.newDescription')">
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <select v-model="form.assetId" class="os-input"><option value="">{{ t('roadmapFeatures.maintenance.chooseEquipment') }}</option><option v-for="item in data.assets" :key="item.id" :value="item.id">{{ item.name }}</option></select>
        <input v-model="form.title" class="os-input" :placeholder="t('roadmapFeatures.maintenance.workTitle')" />
        <select v-model="form.serviceType" class="os-input"><option value="preventive">{{ t('roadmapFeatures.maintenance.preventive') }}</option><option value="inspection">{{ t('roadmapFeatures.maintenance.inspection') }}</option><option value="repair">{{ t('roadmapFeatures.maintenance.repair') }}</option><option value="replacement">{{ t('roadmapFeatures.maintenance.replacement') }}</option></select>
        <select v-model="form.priority" class="os-input"><option value="low">{{ t('roadmapFeatures.maintenance.low') }}</option><option value="normal">{{ t('roadmapFeatures.maintenance.normal') }}</option><option value="high">{{ t('roadmapFeatures.maintenance.high') }}</option><option value="urgent">{{ t('roadmapFeatures.maintenance.urgent') }}</option></select>
        <input v-model="form.dueAt" type="datetime-local" class="os-input" />
        <input v-model="form.estimatedCost" type="number" min="0" class="os-input" :placeholder="t('roadmapFeatures.maintenance.estimatedCost')" />
        <select v-model="form.assignedToId" class="os-input"><option value="">{{ t('roadmapFeatures.maintenance.noStaff') }}</option><option v-for="person in data.staff" :key="person.id" :value="person.id">{{ person.name }}</option></select>
        <select v-model="form.contractorId" class="os-input"><option value="">{{ t('roadmapFeatures.maintenance.noContractor') }}</option><option v-for="person in data.contractors" :key="person.id" :value="person.id">{{ person.name }}</option></select>
        <textarea v-model="form.description" rows="3" class="os-input md:col-span-2" :placeholder="t('roadmapFeatures.maintenance.workDescription')" />
        <textarea v-model="form.checklist" rows="3" class="os-input" :placeholder="t('roadmapFeatures.maintenance.checklist')" />
      </div>
      <button :disabled="saving || !form.assetId || !form.title.trim()" class="mt-4 rounded-xl bg-farm-green px-4 py-2 font-bold text-slate-950 disabled:opacity-40" @click="createWorkOrder">{{ saving ? t('roadmapFeatures.maintenance.saving') : t('roadmapFeatures.maintenance.create') }}</button>
    </CollapsibleSection>

    <div class="mt-6 flex gap-2 overflow-x-auto pb-1"><button v-for="item in ['active','open','in_progress','completed','all']" :key="item" class="whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold" :class="filter === item ? 'border-farm-green bg-farm-green/15 text-farm-green' : 'border-slate-700 text-slate-400'" @click="filter = item">{{ t(`roadmapFeatures.maintenance.filters.${item}`) }}</button></div>
    <p v-if="loading" class="mt-8 text-slate-400">{{ t('roadmapFeatures.maintenance.loading') }}</p>
    <p v-else-if="!visible.length" class="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">{{ t('roadmapFeatures.maintenance.empty') }}</p>
    <div v-else class="mt-4 grid gap-4 xl:grid-cols-2">
      <details v-for="order in visible" :key="order.id" class="group rounded-2xl border border-slate-800 bg-slate-900 p-5" :open="order.priority === 'urgent'">
        <summary class="cursor-pointer list-none">
          <div class="flex items-start justify-between gap-3"><div><div class="flex flex-wrap gap-2"><span class="rounded-full bg-farm-green/15 px-2 py-1 text-[10px] font-black uppercase text-farm-green">{{ t(`roadmapFeatures.maintenance.filters.${order.status}`) }}</span><span class="rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-black uppercase text-amber-300">{{ t(`roadmapFeatures.maintenance.${order.priority}`) }}</span></div><h3 class="mt-3 font-bold text-white">{{ order.title }}</h3><p class="mt-1 text-sm text-slate-400">{{ order.asset?.name || t('roadmapFeatures.maintenance.unknownEquipment') }} · {{ date(order.dueAt) }}</p></div><span class="text-slate-500 group-open:rotate-180">⌄</span></div>
        </summary>
        <div class="mt-4 border-t border-slate-800 pt-4 text-sm">
          <p v-if="order.description" class="text-slate-300">{{ order.description }}</p>
          <dl class="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt class="text-slate-500">{{ t('roadmapFeatures.maintenance.assignedTo') }}</dt><dd class="mt-1 text-slate-200">{{ order.assignedToName || order.contractor?.name || t('roadmapFeatures.maintenance.unassigned') }}</dd></div><div><dt class="text-slate-500">{{ t('roadmapFeatures.maintenance.estimated') }}</dt><dd class="mt-1 text-slate-200">{{ money(order.estimatedCostMinor) }}</dd></div></dl>
          <div v-if="order.checklist.length" class="mt-4 space-y-2 text-slate-300">
            <label v-for="step in order.checklist" :key="step" class="flex items-start gap-2 rounded-lg bg-slate-950/60 px-3 py-2">
              <input v-if="!['completed','cancelled'].includes(order.status)" v-model="completion[order.id].checked" type="checkbox" :value="step" class="mt-0.5 h-4 w-4 accent-green-500" />
              <span v-else class="font-bold text-farm-green">{{ order.completedChecklist.includes(step) ? '✓' : '–' }}</span>
              <span>{{ step }}</span>
            </label>
          </div>
          <div v-if="!['completed','cancelled'].includes(order.status)" class="mt-5 grid gap-2 sm:grid-cols-2">
            <textarea v-model="completion[order.id].notes" rows="2" class="os-input sm:col-span-2" :placeholder="t('roadmapFeatures.maintenance.completionNote')" />
            <input v-model="completion[order.id].parts" class="os-input" :placeholder="t('roadmapFeatures.maintenance.partsUsed')" />
            <input v-model="completion[order.id].cost" type="number" min="0" class="os-input" :placeholder="t('roadmapFeatures.maintenance.actualCost')" />
            <input v-model="completion[order.id].downtime" type="number" min="0" class="os-input" :placeholder="t('roadmapFeatures.maintenance.downtime')" />
            <label class="rounded-xl border border-dashed border-slate-700 p-3 text-xs text-slate-400 sm:col-span-2"><span class="mb-2 block font-bold text-slate-300">{{ t('roadmapFeatures.maintenance.evidence') }}</span><input type="file" accept="image/*" capture="environment" class="block w-full" @change="addEvidence(order.id, $event)" /><span v-if="completion[order.id].evidence" class="mt-2 block text-farm-green">{{ t('roadmapFeatures.maintenance.evidenceReady') }}</span></label>
          </div>
          <div v-if="!['completed','cancelled'].includes(order.status)" class="mt-4 flex flex-wrap gap-2"><button v-if="order.status === 'open'" class="rounded-lg bg-blue-500/15 px-3 py-2 text-xs font-bold text-blue-300" @click="setStatus(order, 'in_progress')">{{ t('roadmapFeatures.maintenance.start') }}</button><button class="rounded-lg bg-farm-green px-3 py-2 text-xs font-bold text-slate-950" @click="setStatus(order, 'completed')">{{ t('roadmapFeatures.maintenance.complete') }}</button><button v-if="canManage" class="rounded-lg bg-red-950/40 px-3 py-2 text-xs font-bold text-red-300" @click="setStatus(order, 'cancelled')">{{ t('roadmapFeatures.maintenance.cancel') }}</button></div>
          <p v-if="order.completionNotes" class="mt-4 rounded-xl bg-slate-950 p-3 text-slate-300"><span class="font-bold text-white">{{ t('roadmapFeatures.maintenance.completion') }}</span> {{ order.completionNotes }}</p>
        </div>
      </details>
    </div>
  </AppLayout>
</template>

<style scoped>.os-input{width:100%;border-radius:.75rem;border:1px solid rgb(51 65 85);background:rgb(2 6 23);padding:.7rem .8rem;font-size:.875rem;color:white}.os-input::placeholder{color:rgb(100 116 139)}</style>
