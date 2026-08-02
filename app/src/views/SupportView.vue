<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type Ticket = {
  id: string
  reference: string
  category: string
  priority: string
  status: string
  description: string
  channel: string
  customerName: string | null
  customerPhone: string | null
  createdAt: string
}

const tickets = ref<Ticket[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const description = ref('')
const category = ref('complaint')
const priority = ref('normal')
const openTickets = computed(() => tickets.value.filter((ticket) => !['resolved', 'closed'].includes(ticket.status)))

async function load() {
  loading.value = true
  error.value = null
  try {
    tickets.value = (await api<{ tickets: Ticket[] }>('/api/support')).tickets
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load support tickets.'
  } finally {
    loading.value = false
  }
}

async function createTicket() {
  if (description.value.trim().length < 3) return
  saving.value = true
  error.value = null
  try {
    await api('/api/support', { method: 'POST', body: JSON.stringify({ description: description.value.trim(), category: category.value, priority: priority.value }) })
    description.value = ''
    category.value = 'complaint'
    priority.value = 'normal'
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not create this ticket.'
  } finally {
    saving.value = false
  }
}

async function setStatus(ticket: Ticket, status: string) {
  error.value = null
  try {
    await api(`/api/support/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not update this ticket.'
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-8">
      <header class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div><p class="text-xs font-bold uppercase tracking-[0.18em] text-farm-green">Customer care</p><h1 class="mt-1 text-2xl font-bold text-white sm:text-3xl">Complaints & support</h1><p class="mt-2 text-sm text-slate-400">Keep every issue visible until someone closes it.</p></div>
        <div class="rounded-xl border border-white/10 bg-[#10221a] px-4 py-3 text-sm text-slate-300"><strong class="text-white">{{ openTickets.length }}</strong> open</div>
      </header>

      <p v-if="error" class="rounded-xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">{{ error }}</p>

      <form class="rounded-2xl border border-white/10 bg-[#10221a] p-4 sm:p-6" @submit.prevent="createTicket">
        <h2 class="font-bold text-white">Log a customer issue</h2>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <label class="text-sm font-semibold text-slate-200">Category
            <select v-model="category" class="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#07140f] px-3 text-white"><option value="complaint">Complaint</option><option value="delivery">Delivery</option><option value="quality">Product quality</option><option value="payment">Payment</option><option value="other">Other</option></select>
          </label>
          <label class="text-sm font-semibold text-slate-200">Priority
            <select v-model="priority" class="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#07140f] px-3 text-white"><option value="low">Low</option><option value="normal">Normal</option><option value="urgent">Urgent</option></select>
          </label>
        </div>
        <label class="mt-4 block text-sm font-semibold text-slate-200">Issue
          <textarea v-model="description" rows="3" maxlength="4000" required class="mt-2 w-full rounded-xl border border-white/10 bg-[#07140f] px-3 py-3 text-white placeholder:text-slate-600" placeholder="Customer name or order reference, what happened, and the expected resolution." />
        </label>
        <div class="mt-4 flex justify-end"><button type="submit" :disabled="saving || description.trim().length < 3" class="min-h-12 rounded-xl bg-farm-green px-6 font-bold text-[#07140f] disabled:opacity-50">{{ saving ? 'Saving…' : 'Create ticket' }}</button></div>
      </form>

      <section>
        <h2 class="mb-3 text-lg font-bold text-white">Ticket queue</h2>
        <p v-if="loading" class="text-sm text-slate-400">Loading tickets…</p>
        <p v-else-if="!tickets.length" class="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">No support tickets yet.</p>
        <div v-else class="grid gap-3 lg:grid-cols-2">
          <article v-for="ticket in tickets" :key="ticket.id" class="rounded-2xl border border-white/10 bg-[#10221a] p-4">
            <div class="flex flex-wrap items-center gap-2"><strong class="mr-auto font-mono text-sm text-white">{{ ticket.reference }}</strong><span class="rounded-full bg-white/5 px-2.5 py-1 text-xs font-bold uppercase text-slate-300">{{ ticket.category }}</span><span class="rounded-full px-2.5 py-1 text-xs font-bold uppercase" :class="ticket.priority === 'urgent' ? 'bg-red-900/40 text-red-200' : 'bg-amber-900/30 text-amber-200'">{{ ticket.priority }}</span></div>
            <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-100">{{ ticket.description }}</p>
            <p v-if="ticket.customerName || ticket.customerPhone" class="mt-2 text-xs text-slate-400">{{ ticket.customerName || 'Customer' }}<span v-if="ticket.customerPhone"> · {{ ticket.customerPhone }}</span></p>
            <div class="mt-4 flex flex-col gap-3 border-t border-white/5 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p class="text-xs text-slate-500">{{ ticket.channel }} · {{ formatDate(ticket.createdAt) }}</p>
              <div class="flex flex-wrap gap-2"><button v-if="ticket.status === 'open'" type="button" class="min-h-10 rounded-lg border border-blue-700/50 px-3 text-xs font-bold text-blue-200" @click="setStatus(ticket, 'in_progress')">Start</button><button v-if="!['resolved', 'closed'].includes(ticket.status)" type="button" class="min-h-10 rounded-lg border border-emerald-700/50 px-3 text-xs font-bold text-emerald-200" @click="setStatus(ticket, 'resolved')">Resolve</button><span v-else class="self-center text-xs font-bold uppercase text-emerald-300">{{ ticket.status }}</span></div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </AppLayout>
</template>
