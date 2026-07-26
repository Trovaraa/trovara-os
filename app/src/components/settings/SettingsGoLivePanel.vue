<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Checklist } from '@/composables/useSettingsOnboarding'

defineProps<{
  goLiveReady: boolean
  goLiveDoneCount: number
  goLiveItems: Array<{ label: string; done: boolean; hint?: string }>
  liveMode: boolean
  goingLive: boolean
  goLiveMessage: string | null
  ready: boolean
  checklist: Checklist | null
}>()

const emit = defineEmits<{ 'go-live': [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="contents">
    <div
      class="mt-8 bg-slate-900 border rounded-xl p-5"
      :class="goLiveReady ? 'border-farm-green/40' : 'border-amber-700/30'"
    >
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h3 class="font-bold text-white">{{ t('settings.goLiveTitle') }}</h3>
          <p class="text-xs text-slate-400 mt-0.5">{{ t('settings.goLiveSubtitle') }}</p>
        </div>
        <span
          class="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap"
          :class="goLiveReady ? 'bg-farm-green/20 text-farm-green' : 'bg-amber-900/30 text-amber-300'"
        >
          {{ goLiveDoneCount }}/{{ goLiveItems.length }}
          {{ goLiveReady ? `- ${t('settings.ready')}` : `- ${t('settings.notReady')}` }}
        </span>
      </div>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <span
          class="text-xs font-bold px-2.5 py-1 rounded-full"
          :class="liveMode ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-300'"
        >
          {{ liveMode ? t('settings.liveModeEnabled') : t('settings.demoMode') }}
        </span>
        <button
          v-if="!liveMode"
          type="button"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          :disabled="goingLive"
          @click="emit('go-live')"
        >
          {{ goingLive ? t('settings.switching') : t('settings.goLiveNow') }}
        </button>
      </div>
      <p v-if="goLiveMessage" class="text-xs text-slate-400 mb-3">{{ goLiveMessage }}</p>
      <ul class="space-y-2.5">
        <li v-for="(item, idx) in goLiveItems" :key="idx" class="flex items-start gap-3 text-sm">
          <span
            class="mt-0.5 shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
            :class="item.done ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-500'"
          >
            {{ item.done ? '✓' : '○' }}
          </span>
          <div class="min-w-0">
            <p :class="item.done ? 'text-slate-300' : 'text-white'">{{ item.label }}</p>
            <p v-if="!item.done && item.hint" class="text-xs text-slate-500 mt-0.5">{{ item.hint }}</p>
          </div>
        </li>
      </ul>
    </div>

    <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div class="flex items-center justify-between gap-4">
        <h3 class="font-bold text-white">{{ t('settings.onboardingTitle') }}</h3>
        <span
          class="text-xs font-bold px-2.5 py-1 rounded-full"
          :class="ready ? 'bg-farm-green/20 text-farm-green' : 'bg-amber-900/40 text-amber-300'"
        >
          {{ ready ? t('settings.ready') : t('settings.incomplete') }}
        </span>
      </div>
      <ul v-if="checklist" class="mt-4 space-y-3">
        <li class="flex items-center gap-3 text-sm">
          <span :class="checklist.hasZones ? 'text-farm-green' : 'text-slate-500'">
            {{ checklist.hasZones ? '✓' : '○' }}
          </span>
          <span class="text-slate-300">{{ t('settings.zonesConfigured', { count: checklist.zonesCount }) }}</span>
        </li>
        <li class="flex items-center gap-3 text-sm">
          <span :class="checklist.hasTemplates ? 'text-farm-green' : 'text-slate-500'">
            {{ checklist.hasTemplates ? '✓' : '○' }}
          </span>
          <span class="text-slate-300">{{
            t('settings.templatesCreated', { count: checklist.templatesCount })
          }}</span>
        </li>
        <li class="flex items-center gap-3 text-sm">
          <span :class="checklist.hasUsers ? 'text-farm-green' : 'text-slate-500'">
            {{ checklist.hasUsers ? '✓' : '○' }}
          </span>
          <span class="text-slate-300">{{ t('settings.teamAdded', { count: checklist.usersCount }) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
