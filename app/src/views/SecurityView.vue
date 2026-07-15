<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type SecurityEvent = {
  ts: string
  type: string
  metadata: Record<string, unknown>
}

const loading = ref(true)
const events = ref<SecurityEvent[]>([])
const loadError = ref<string | null>(null)
const activeSessions = ref<number | null>(null)
const revoking = ref(false)
const revokeMessage = ref<string | null>(null)

function formatDetails(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata)
  if (keys.length === 0) return '-'
  return keys
    .slice(0, 4)
    .map((k) => `${k}: ${String(metadata[k])}`)
    .join(' · ')
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [eventsData, meData] = await Promise.all([
      api<{ events: SecurityEvent[] }>('/api/system/security-events'),
      api<{ user: unknown; activeSessions?: number }>('/auth/me'),
    ])
    events.value = eventsData.events
    activeSessions.value =
      typeof meData.activeSessions === 'number' ? meData.activeSessions : null
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Failed to load security data'
  } finally {
    loading.value = false
  }
}

async function revokeAllSessions() {
  if (!window.confirm('Log out all devices? You will stay signed in on this browser.')) return
  revoking.value = true
  revokeMessage.value = null
  try {
    const data = await api<{ revokedSessions?: number; message?: string }>(
      '/auth/revoke-all-sessions',
      { method: 'POST' },
    )
    revokeMessage.value =
      data.message ??
      `Revoked ${data.revokedSessions ?? 0} other session(s).`
    await load()
  } catch (e) {
    revokeMessage.value = e instanceof Error ? e.message : 'Could not revoke sessions'
  } finally {
    revoking.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <RouterLink to="/settings" class="text-xs text-slate-500 hover:text-farm-green">
          ← Settings
        </RouterLink>
        <h2 class="text-2xl font-black text-white mt-2">Security dashboard</h2>
        <p class="text-slate-400 text-sm mt-1">Recent security events and active sessions</p>
      </div>
      <button
        type="button"
        class="text-sm px-4 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
        :disabled="revoking"
        @click="revokeAllSessions"
      >
        {{ revoking ? 'Revoking…' : 'Log out all devices' }}
      </button>
    </div>

    <p v-if="revokeMessage" class="mt-4 text-xs text-slate-400">{{ revokeMessage }}</p>

    <div v-if="activeSessions !== null" class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <p class="text-xs text-slate-500">Active sessions (your account)</p>
      <p class="text-2xl font-black text-white mt-1">{{ activeSessions }}</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">Loading security events…</div>
    <p v-else-if="loadError" class="mt-8 text-sm text-red-400">{{ loadError }}</p>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">Timestamp</th>
            <th class="pb-3 font-semibold">Event type</th>
            <th class="pb-3 font-semibold">Details</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(event, idx) in events"
            :key="`${event.ts}-${idx}`"
            class="border-b border-slate-800/50"
          >
            <td class="py-3 text-slate-400 whitespace-nowrap">
              {{ new Date(event.ts).toLocaleString() }}
            </td>
            <td class="py-3 font-mono text-farm-gold">{{ event.type }}</td>
            <td class="py-3 text-slate-400 text-xs break-all">
              {{ formatDetails(event.metadata) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!events.length" class="text-slate-500 text-sm mt-4">No security events recorded yet.</p>
    </div>
  </AppLayout>
</template>
