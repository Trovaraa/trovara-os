<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  status: string
}>()

const { t, te } = useI18n()

const statusColor: Record<string, string> = {
  pending: 'bg-slate-700 text-slate-300',
  in_progress: 'bg-blue-900/50 text-blue-300',
  awaiting_approval: 'bg-purple-900/50 text-purple-300',
  completed: 'bg-farm-green/20 text-farm-green',
  rejected: 'bg-red-900/50 text-red-300',
}

function label(status: string) {
  const shortKey = `statusShort.${status}`
  return te(shortKey) ? t(shortKey) : t(`status.${status}`)
}
</script>

<template>
  <span
    class="inline-flex max-w-full text-[11px] font-bold leading-tight px-2 py-1 rounded-full"
    :class="statusColor[status] ?? 'bg-slate-700 text-slate-300'"
  >
    {{ label(status) }}
  </span>
</template>
