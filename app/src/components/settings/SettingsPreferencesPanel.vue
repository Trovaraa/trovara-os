<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'

defineProps<{
  isOwner: boolean
  savingOrderAlerts: boolean
  savingWorkerAlerts: boolean
  savingHealthSla: boolean
  orderAlertsMessage: string | null
  workerAlertsMessage: string | null
  healthSlaMessage: string | null
  savingTtsMode: boolean
  ttsMessage: string | null
}>()

const ttsMode = defineModel<'off' | 'voice_replies' | 'always'>('ttsMode', { required: true })
const orderAlertsSubscribed = defineModel<boolean>('orderAlertsSubscribed', { required: true })
const workerAlertsSubscribed = defineModel<boolean>('workerAlertsSubscribed', { required: true })
const healthSlaAlertsEnabled = defineModel<boolean>('healthSlaAlertsEnabled', { required: true })

const emit = defineEmits<{
  'save-tts': []
  'save-order-alerts': []
  'save-worker-alerts': []
  'save-health-sla': []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="contents">
    <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h3 class="font-bold text-white text-sm">{{ t('settings.appearanceTitle') }}</h3>
          <p class="text-xs text-slate-500 mt-1">{{ t('settings.appearanceDesc') }}</p>
        </div>
        <ThemeSwitcher />
      </div>
    </div>

    <div
      v-if="isOwner"
      class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5"
    >
      <div>
        <h3 class="font-bold text-white text-sm">{{ t('settings.alertSubscriptionsTitle') }}</h3>
        <p class="text-xs text-slate-500 mt-1">{{ t('settings.alertSubscriptionsDesc') }}</p>
      </div>

      <div class="flex items-start justify-between gap-4 pt-1 border-t border-slate-800">
        <div class="min-w-0">
          <p class="text-sm text-slate-200">{{ t('settings.orderAlertsSubscribe') }}</p>
          <p class="text-xs text-slate-500 mt-1">{{ t('settings.orderAlertsHint') }}</p>
          <p v-if="savingOrderAlerts" class="text-xs text-slate-500 mt-2">{{ t('settings.saving') }}</p>
          <p
            v-else-if="orderAlertsMessage"
            class="text-xs mt-2"
            :class="orderAlertsMessage.toLowerCase().includes('fail') ? 'text-red-300' : 'text-farm-green'"
          >
            {{ orderAlertsMessage }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="orderAlertsSubscribed"
          :aria-label="t('settings.orderAlertsSubscribe')"
          :disabled="savingOrderAlerts"
          class="relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-farm-green/60 disabled:opacity-50"
          :class="orderAlertsSubscribed ? 'bg-farm-green' : 'bg-slate-700'"
          @click="
            orderAlertsSubscribed = !orderAlertsSubscribed;
            emit('save-order-alerts')
          "
        >
          <span
            class="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
            :class="orderAlertsSubscribed ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>

      <div class="flex items-start justify-between gap-4 pt-4 border-t border-slate-800">
        <div class="min-w-0">
          <p class="text-sm text-slate-200">{{ t('settings.workerAlertsSubscribe') }}</p>
          <p class="text-xs text-slate-500 mt-1">{{ t('settings.workerAlertsHint') }}</p>
          <p v-if="savingWorkerAlerts" class="text-xs text-slate-500 mt-2">{{ t('settings.saving') }}</p>
          <p
            v-else-if="workerAlertsMessage"
            class="text-xs mt-2"
            :class="workerAlertsMessage.toLowerCase().includes('fail') ? 'text-red-300' : 'text-farm-green'"
          >
            {{ workerAlertsMessage }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="workerAlertsSubscribed"
          :aria-label="t('settings.workerAlertsSubscribe')"
          :disabled="savingWorkerAlerts"
          class="relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-farm-green/60 disabled:opacity-50"
          :class="workerAlertsSubscribed ? 'bg-farm-green' : 'bg-slate-700'"
          @click="
            workerAlertsSubscribed = !workerAlertsSubscribed;
            emit('save-worker-alerts')
          "
        >
          <span
            class="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
            :class="workerAlertsSubscribed ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>

      <div class="flex items-start justify-between gap-4 pt-4 border-t border-slate-800">
        <div class="min-w-0">
          <p class="text-sm text-slate-200">{{ t('settings.healthSlaSubscribe') }}</p>
          <p class="text-xs text-slate-500 mt-1">{{ t('settings.healthSlaHint') }}</p>
          <p v-if="savingHealthSla" class="text-xs text-slate-500 mt-2">{{ t('settings.saving') }}</p>
          <p
            v-else-if="healthSlaMessage"
            class="text-xs mt-2"
            :class="healthSlaMessage.toLowerCase().includes('fail') ? 'text-red-300' : 'text-farm-green'"
          >
            {{ healthSlaMessage }}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="healthSlaAlertsEnabled"
          :aria-label="t('settings.healthSlaSubscribe')"
          :disabled="savingHealthSla"
          class="relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-farm-green/60 disabled:opacity-50"
          :class="healthSlaAlertsEnabled ? 'bg-farm-green' : 'bg-slate-700'"
          @click="
            healthSlaAlertsEnabled = !healthSlaAlertsEnabled;
            emit('save-health-sla')
          "
        >
          <span
            class="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
            :class="healthSlaAlertsEnabled ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>
    </div>

    <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
      <h3 class="font-bold text-white text-sm">{{ t('settings.butlerVoiceMode') }}</h3>
      <p class="text-xs text-slate-500">{{ t('settings.butlerVoiceDesc') }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <select
          v-model="ttsMode"
          :aria-label="t('settings.butlerVoiceMode')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="off">{{ t('settings.ttsOff') }}</option>
          <option value="voice_replies">{{ t('settings.ttsVoiceReplies') }}</option>
          <option value="always">{{ t('settings.ttsAlways') }}</option>
        </select>
        <button
          type="button"
          class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          :disabled="savingTtsMode"
          @click="emit('save-tts')"
        >
          {{ savingTtsMode ? t('settings.saving') : t('settings.saveMode') }}
        </button>
      </div>
      <p v-if="ttsMessage" class="text-xs text-slate-400">{{ ttsMessage }}</p>
    </div>
  </div>
</template>
