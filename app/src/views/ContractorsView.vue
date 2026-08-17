<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type Engagement = { id: string; title: string; deliverables: string | null; startDate: string; endDate: string | null; rateType: string; agreedAmountMinor: number; paidAmountMinor: number; currency: string; costCentreCode: string | null; status: string }
type Contractor = { id: string; name: string; company: string | null; specialty: string; phone: string | null; email: string | null; status: string; insuranceExpiresAt: string | null; notes: string | null; engagements: Engagement[] }
const auth = useAuthStore()
const { t } = useI18n()
const canManage = computed(() => auth.hasPermission('contractors.write'))
const contractors = ref<Contractor[]>([])
const loading = ref(true)
const error = ref('')
const showNew = ref(false)
const selected = ref('')
const paymentInputs = ref<Record<string, string>>({})
const person = ref({ name: '', company: '', specialty: '', phone: '', email: '', notes: '' })
const work = ref({ title: '', deliverables: '', startDate: '', endDate: '', rateType: 'fixed', agreedAmount: '', paidAmount: '', costCentreCode: 'CC10', status: 'planned' })

async function load() { loading.value = true; try { const result = await api<{ contractors: Contractor[] }>('/api/contractors'); contractors.value = result.contractors; for (const item of result.contractors) for (const job of item.engagements) paymentInputs.value[job.id] ??= String(job.paidAmountMinor / 100) } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.contractors.loadFailed') } finally { loading.value = false } }
async function addPerson() { try { await api('/api/contractors', { method: 'POST', body: JSON.stringify({ ...person.value, company: person.value.company || null, phone: person.value.phone || null, email: person.value.email || null, notes: person.value.notes || null }) }); person.value = { name: '', company: '', specialty: '', phone: '', email: '', notes: '' }; showNew.value = false; await load() } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.contractors.personFailed') } }
async function addEngagement() { if (!selected.value || !work.value.title || !work.value.startDate) return; try { await api('/api/contractors/engagements', { method: 'POST', body: JSON.stringify({ contractorId: selected.value, title: work.value.title, deliverables: work.value.deliverables || null, startDate: work.value.startDate, endDate: work.value.endDate || null, rateType: work.value.rateType, agreedAmountMinor: Math.round(Number(work.value.agreedAmount || 0) * 100), paidAmountMinor: Math.round(Number(work.value.paidAmount || 0) * 100), currency: 'NGN', costCentreCode: work.value.costCentreCode || null, status: work.value.status }) }); work.value = { title: '', deliverables: '', startDate: '', endDate: '', rateType: 'fixed', agreedAmount: '', paidAmount: '', costCentreCode: 'CC10', status: 'planned' }; await load() } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.contractors.engagementFailed') } }
async function updateEngagement(row: Engagement, status: string, paidNgn = row.paidAmountMinor / 100) { try { await api(`/api/contractors/engagements/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status, paidAmountMinor: Math.round(paidNgn * 100) }) }); await load() } catch (e) { error.value = e instanceof Error ? e.message : t('roadmapFeatures.contractors.updateFailed') } }
async function savePayment(row: Engagement) {
  const paid = Number(paymentInputs.value[row.id])
  if (!Number.isFinite(paid) || paid < 0 || paid * 100 > row.agreedAmountMinor) { error.value = t('roadmapFeatures.contractors.invalidPayment'); return }
  await updateEngagement(row, row.status, paid)
}
function money(value: number) { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(value / 100) }
onMounted(load)
</script>
<template>
  <AppLayout>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div><p class="text-xs font-bold uppercase tracking-[.2em] text-farm-green">{{ t('roadmapFeatures.contractors.eyebrow') }}</p><h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('roadmapFeatures.contractors.title') }}</h2><p class="mt-1 text-sm text-slate-400">{{ t('roadmapFeatures.contractors.subtitle') }}</p></div>
      <button v-if="canManage" class="rounded-xl bg-farm-green px-4 py-2 font-bold text-slate-950" @click="showNew = !showNew">{{ showNew ? t('roadmapFeatures.common.close') : t('roadmapFeatures.contractors.add') }}</button>
    </div>
    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>
    <CollapsibleSection v-if="showNew && canManage" class="mt-6" :title="t('roadmapFeatures.contractors.newTitle')" :description="t('roadmapFeatures.contractors.newDescription')">
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><input v-model="person.name" class="os-input" :placeholder="t('roadmapFeatures.contractors.contactName')"/><input v-model="person.company" class="os-input" :placeholder="t('roadmapFeatures.contractors.company')"/><input v-model="person.specialty" class="os-input" :placeholder="t('roadmapFeatures.contractors.specialty')"/><input v-model="person.phone" class="os-input" :placeholder="t('roadmapFeatures.contractors.phone')"/><input v-model="person.email" class="os-input" :placeholder="t('roadmapFeatures.contractors.email')"/><input v-model="person.notes" class="os-input" :placeholder="t('roadmapFeatures.contractors.notes')"/></div>
      <button :disabled="!person.name || !person.specialty" class="mt-4 rounded-xl bg-farm-green px-4 py-2 font-bold text-slate-950 disabled:opacity-40" @click="addPerson">{{ t('roadmapFeatures.contractors.save') }}</button>
    </CollapsibleSection>
    <CollapsibleSection v-if="canManage && contractors.length" class="mt-6" :title="t('roadmapFeatures.contractors.assignTitle')" :description="t('roadmapFeatures.contractors.assignDescription')">
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><select v-model="selected" class="os-input"><option value="">{{ t('roadmapFeatures.contractors.choose') }}</option><option v-for="item in contractors" :key="item.id" :value="item.id">{{ item.name }}{{ item.company ? ` — ${item.company}` : '' }}</option></select><input v-model="work.title" class="os-input" :placeholder="t('roadmapFeatures.contractors.workTitle')"/><input v-model="work.startDate" type="date" class="os-input"/><input v-model="work.endDate" type="date" class="os-input"/><select v-model="work.rateType" class="os-input"><option value="fixed">{{ t('roadmapFeatures.contractors.fixed') }}</option><option value="daily">{{ t('roadmapFeatures.contractors.daily') }}</option><option value="hourly">{{ t('roadmapFeatures.contractors.hourly') }}</option></select><input v-model="work.agreedAmount" type="number" min="0" class="os-input" :placeholder="t('roadmapFeatures.contractors.agreed')"/><input v-model="work.paidAmount" type="number" min="0" class="os-input" :placeholder="t('roadmapFeatures.contractors.paid')"/><select v-model="work.costCentreCode" class="os-input"><option value="CC10">{{ t('roadmapFeatures.contractors.costCentres.headOffice') }}</option><option value="CC20">{{ t('roadmapFeatures.contractors.costCentres.plantain') }}</option><option value="CC30">{{ t('roadmapFeatures.contractors.costCentres.coconut') }}</option><option value="CC40">{{ t('roadmapFeatures.contractors.costCentres.poultry') }}</option><option value="CC50">{{ t('roadmapFeatures.contractors.costCentres.processing') }}</option><option value="CC60">{{ t('roadmapFeatures.contractors.costCentres.sales') }}</option></select><textarea v-model="work.deliverables" rows="2" class="os-input md:col-span-2" :placeholder="t('roadmapFeatures.contractors.deliverables')"/></div>
      <button :disabled="!selected || !work.title || !work.startDate" class="mt-4 rounded-xl bg-farm-green px-4 py-2 font-bold text-slate-950 disabled:opacity-40" @click="addEngagement">{{ t('roadmapFeatures.contractors.saveEngagement') }}</button>
    </CollapsibleSection>
    <p v-if="loading" class="mt-8 text-slate-400">{{ t('roadmapFeatures.contractors.loading') }}</p>
    <p v-else-if="!contractors.length" class="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">{{ t('roadmapFeatures.contractors.empty') }}</p>
    <div v-else class="mt-6 space-y-3">
      <details v-for="item in contractors" :key="item.id" class="group rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <summary class="cursor-pointer list-none"><div class="flex justify-between gap-3"><div><h3 class="font-bold text-white">{{ item.name }}</h3><p class="mt-1 text-sm text-slate-400">{{ item.company || t('roadmapFeatures.contractors.independent') }} · {{ item.specialty }}</p><p class="mt-1 text-xs text-slate-500">{{ t('roadmapFeatures.contractors.engagements', { count: item.engagements.length }) }}</p></div><span class="text-slate-500 group-open:rotate-180">⌄</span></div></summary>
        <div class="mt-4 border-t border-slate-800 pt-4"><div class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400"><span v-if="item.phone">{{ item.phone }}</span><span v-if="item.email">{{ item.email }}</span></div>
          <div v-if="item.engagements.length" class="mt-4 space-y-3">
            <div v-for="job in item.engagements" :key="job.id" class="rounded-xl bg-slate-950 p-4"><div class="flex flex-wrap justify-between gap-3"><div><p class="font-semibold text-white">{{ job.title }}</p><p class="mt-1 text-xs text-slate-500">{{ job.startDate }} → {{ job.endDate || t('roadmapFeatures.contractors.openEnd') }} · {{ job.costCentreCode || t('roadmapFeatures.common.noCostCentre') }}</p></div><span class="text-xs font-bold uppercase text-farm-green">{{ t(`roadmapFeatures.contractors.statuses.${job.status}`) }}</span></div><p v-if="job.deliverables" class="mt-2 text-sm text-slate-300">{{ job.deliverables }}</p>
              <div class="mt-3 grid grid-cols-2 gap-3 text-xs"><div><span class="text-slate-500">{{ t('roadmapFeatures.contractors.agreedLabel') }}</span><p class="mt-1 text-white">{{ money(job.agreedAmountMinor) }}</p></div><div><span class="text-slate-500">{{ t('roadmapFeatures.contractors.paidLabel') }}</span><p class="mt-1 text-white">{{ money(job.paidAmountMinor) }}</p></div></div>
              <div v-if="canManage" class="mt-3 flex flex-wrap items-end gap-2"><label class="min-w-44 flex-1 text-xs text-slate-400"><span class="mb-1 block">{{ t('roadmapFeatures.contractors.paid') }}</span><input v-model="paymentInputs[job.id]" type="number" min="0" :max="job.agreedAmountMinor / 100" class="os-input"/></label><button class="action" @click="savePayment(job)">{{ t('roadmapFeatures.contractors.savePaid') }}</button></div>
              <div v-if="canManage && !['completed','cancelled'].includes(job.status)" class="mt-3 flex flex-wrap gap-2"><button v-if="job.status === 'planned'" class="action" @click="updateEngagement(job, 'active')">{{ t('roadmapFeatures.contractors.start') }}</button><button class="action" @click="updateEngagement(job, 'completed')">{{ t('roadmapFeatures.contractors.complete') }}</button><button class="action text-red-300" @click="updateEngagement(job, 'cancelled')">{{ t('roadmapFeatures.contractors.cancel') }}</button></div>
            </div>
          </div><p v-else class="mt-4 text-sm text-slate-500">{{ t('roadmapFeatures.contractors.noEngagements') }}</p>
        </div>
      </details>
    </div>
  </AppLayout>
</template>
<style scoped>.os-input{width:100%;border-radius:.75rem;border:1px solid rgb(51 65 85);background:rgb(2 6 23);padding:.7rem .8rem;font-size:.875rem;color:white}.os-input::placeholder{color:rgb(100 116 139)}.action{border-radius:.5rem;background:rgb(30 41 59);padding:.45rem .7rem;font-size:.75rem;font-weight:700;color:rgb(203 213 225)}</style>
