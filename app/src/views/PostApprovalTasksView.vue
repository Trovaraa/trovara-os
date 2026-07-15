<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type PostApprovalChange = {
  id: string
  taskId: string
  taskTitle: string
  changedByName?: string
  changedByRole?: string
  changedAt: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

const loading = ref(true)
const error = ref<string | null>(null)
const changes = ref<PostApprovalChange[]>([])

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ changes: PostApprovalChange[] }>('/api/tasks/post-approval-changes')
    changes.value = data.changes ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load post-approval changes'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-white">Post-approval task audit</h2>
        <p class="text-slate-400 text-sm mt-1">Track every change made after a task was approved</p>
      </div>
      <button
        type="button"
        class="text-sm px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        @click="load"
      >
        Refresh
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-400">{{ error }}</p>
    <div v-if="loading" class="mt-8 text-slate-400">Loading post-approval changes…</div>

    <div v-else class="mt-8 space-y-3">
      <div
        v-for="change in changes"
        :key="change.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-4"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-white font-semibold">{{ change.taskTitle }}</p>
            <p class="text-xs text-slate-500 mt-1">
              Task ID: <span class="font-mono">{{ change.taskId }}</span>
            </p>
          </div>
          <div class="text-right text-xs text-slate-500">
            <p>{{ new Date(change.changedAt).toLocaleString() }}</p>
            <p v-if="change.changedByName" class="capitalize">
              {{ change.changedByName }}
              <span v-if="change.changedByRole">({{ change.changedByRole.replace('_', ' ') }})</span>
            </p>
          </div>
        </div>

        <div class="grid gap-3 md:grid-cols-2 mt-4">
          <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
            <p class="text-xs text-slate-500 mb-2 uppercase tracking-wide">Before</p>
            <pre class="text-xs text-slate-300 whitespace-pre-wrap break-words">{{ JSON.stringify(change.before ?? {}, null, 2) }}</pre>
          </div>
          <div class="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
            <p class="text-xs text-slate-500 mb-2 uppercase tracking-wide">After</p>
            <pre class="text-xs text-slate-300 whitespace-pre-wrap break-words">{{ JSON.stringify(change.after ?? {}, null, 2) }}</pre>
          </div>
        </div>
      </div>

      <p v-if="!changes.length" class="text-sm text-slate-500">No post-approval task changes found.</p>
    </div>
  </AppLayout>
</template>
