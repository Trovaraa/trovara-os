<script setup lang="ts">
import { useI18n } from 'vue-i18n'

type RetentionStatus = {
  config: {
    retentionDays: number
    sessionRetentionDays: number
    customerContactRetentionDays: number
  }
  pendingTaskEvidence: number
  pendingExpiredSessions: number
  pendingChatMessages: number
  pendingContactPhones: number
}

type AnonymizeTargets = {
  workers: Array<{ id: string; name: string; email: string }>
  contacts: Array<{ id: string; name: string | null; phone: string | null; channel: string }>
}

defineProps<{
  retentionStatus: RetentionStatus | null
  retentionLoading: boolean
  retentionRunning: boolean
  retentionMessage: string | null
  anonymizeTargets: AnonymizeTargets | null
  anonymizingWorker: boolean
  anonymizingContact: boolean
  anonymizeMessage: string | null
  exportingFarmData: boolean
  farmExportMessage: string | null
}>()

const exportReason = defineModel<string>('exportReason', { required: true })
const selectedWorkerId = defineModel<string>('selectedWorkerId', { required: true })
const selectedContactId = defineModel<string>('selectedContactId', { required: true })

const emit = defineEmits<{
  export: []
  'run-retention': []
  'anonymize-worker': []
  'anonymize-contact': []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
    <h3 class="font-bold text-white text-sm">{{ t('settings.privacy') }}</h3>
    <p class="text-xs text-slate-500 mt-1">{{ t('settings.privacyDesc') }}</p>
    <div class="mt-4 space-y-4">
      <label class="block text-xs text-slate-400">
        {{ t('settings.exportReasonLabel') }}
        <input
          v-model="exportReason"
          type="text"
          maxlength="500"
          class="mt-1 w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white"
          :placeholder="t('settings.exportReasonPlaceholder')"
        />
      </label>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          :disabled="exportingFarmData"
          @click="emit('export')"
        >
          {{ exportingFarmData ? t('settings.exporting') : t('settings.exportFarmData') }}
        </button>
        <a
          href="/ndpa-compliance.md"
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          {{ t('settings.ndpaDoc') }}
        </a>
      </div>
      <div
        v-if="retentionStatus"
        class="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400 space-y-1"
      >
        <p class="font-semibold text-slate-300">{{ t('settings.retentionStatus') }}</p>
        <p>{{ t('settings.retentionConfig', retentionStatus.config) }}</p>
        <p>{{ t('settings.retentionPending', retentionStatus) }}</p>
        <button
          type="button"
          class="mt-2 text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          :disabled="retentionRunning || retentionLoading"
          @click="emit('run-retention')"
        >
          {{ retentionRunning ? t('settings.runningRetention') : t('settings.runRetention') }}
        </button>
      </div>
      <div
        v-if="anonymizeTargets"
        class="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-3"
      >
        <p class="text-xs font-semibold text-slate-300">{{ t('settings.anonymizeTitle') }}</p>
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-xs text-slate-400">
            {{ t('settings.anonymizeWorker') }}
            <select
              v-model="selectedWorkerId"
              class="mt-1 block rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-sm text-white"
            >
              <option value="">{{ t('settings.selectWorker') }}</option>
              <option v-for="worker in anonymizeTargets.workers" :key="worker.id" :value="worker.id">
                {{ worker.name }} ({{ worker.email }})
              </option>
            </select>
          </label>
          <button
            type="button"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-900/40 text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
            :disabled="!selectedWorkerId || anonymizingWorker"
            @click="emit('anonymize-worker')"
          >
            {{ anonymizingWorker ? t('settings.anonymizing') : t('settings.anonymizeWorkerBtn') }}
          </button>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-xs text-slate-400">
            {{ t('settings.anonymizeContact') }}
            <select
              v-model="selectedContactId"
              class="mt-1 block rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-sm text-white"
            >
              <option value="">{{ t('settings.selectContact') }}</option>
              <option
                v-for="contact in anonymizeTargets.contacts"
                :key="contact.id"
                :value="contact.id"
              >
                {{ contact.name || contact.phone || contact.id }} ({{ contact.channel }})
              </option>
            </select>
          </label>
          <button
            type="button"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-amber-900/40 text-amber-200 hover:bg-amber-900/60 disabled:opacity-50"
            :disabled="!selectedContactId || anonymizingContact"
            @click="emit('anonymize-contact')"
          >
            {{ anonymizingContact ? t('settings.anonymizing') : t('settings.anonymizeContactBtn') }}
          </button>
        </div>
        <p class="text-[11px] text-slate-500">{{ t('settings.anonymizeNote') }}</p>
      </div>
    </div>
    <p v-if="farmExportMessage" class="mt-2 text-xs text-slate-400">{{ farmExportMessage }}</p>
    <p v-if="retentionMessage" class="mt-2 text-xs text-slate-400">{{ retentionMessage }}</p>
    <p v-if="anonymizeMessage" class="mt-2 text-xs text-slate-400">{{ anonymizeMessage }}</p>
  </div>
</template>
