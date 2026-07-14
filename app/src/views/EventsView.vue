<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type FarmEvent = {
  id: string
  eventType: string
  entityType: string
  entityId: string
  source: string
  approvalStatus?: string | null
  actorName?: string | null
  createdAt: string
}

const events = ref<FarmEvent[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    const data = await api<{ events: FarmEvent[] }>('/api/events?limit=100')
    events.value = data.events
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Farm Events</h2>
      <p class="text-slate-400 text-sm mt-1">Activity log across plots, crops, and tasks</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">Loading events…</div>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">Time</th>
            <th class="pb-3 font-semibold">Event</th>
            <th class="pb-3 font-semibold">Entity</th>
            <th class="pb-3 font-semibold">Source</th>
            <th class="pb-3 font-semibold">Actor</th>
            <th class="pb-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="evt in events"
            :key="evt.id"
            class="border-b border-slate-800/50"
          >
            <td class="py-4 text-slate-400 whitespace-nowrap">
              {{ new Date(evt.createdAt).toLocaleString() }}
            </td>
            <td class="py-4 text-white capitalize">{{ evt.eventType.replace(/_/g, ' ') }}</td>
            <td class="py-4 text-slate-400">
              <span class="capitalize">{{ evt.entityType.replace(/_/g, ' ') }}</span>
            </td>
            <td class="py-4 text-slate-400 capitalize">{{ evt.source }}</td>
            <td class="py-4 text-slate-400">{{ evt.actorName ?? '—' }}</td>
            <td class="py-4 text-slate-400 capitalize">
              {{ evt.approvalStatus?.replace(/_/g, ' ') ?? '—' }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!events.length" class="text-slate-500 text-sm mt-4">No events recorded.</p>
    </div>
  </AppLayout>
</template>
