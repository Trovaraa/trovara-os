<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { SystemStatus } from '@/types/system-status'

defineProps<{
  systemStatus: SystemStatus
}>()

const { t } = useI18n()

function formatBackupTime(iso: string | null): string {
  if (!iso) return t('settings.backupNever')
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
    <h3 class="font-bold text-white text-sm mb-4">{{ t('settings.systemStatus') }}</h3>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.api') }}</p>
        <p class="font-medium" :class="systemStatus.api === 'ok' ? 'text-farm-green' : 'text-red-400'">
          {{ systemStatus.api === 'ok' ? t('settings.statusOk') : t('settings.statusError') }}
        </p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.database') }}</p>
        <p class="font-medium" :class="systemStatus.db === 'ok' ? 'text-farm-green' : 'text-red-400'">
          {{
            systemStatus.db === 'ok'
              ? t('settings.statusOkLatency', { ms: systemStatus.dbLatencyMs })
              : t('settings.statusError')
          }}
        </p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.lastBackup') }}</p>
        <p class="font-medium text-slate-300 text-xs">{{ formatBackupTime(systemStatus.lastBackup) }}</p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.backupsOnDisk') }}</p>
        <p class="font-medium text-slate-300">{{ systemStatus.backupCount }}</p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.whatsapp') }}</p>
        <p
          class="font-medium text-xs"
          :class="systemStatus.whatsappConfigured ? 'text-farm-green' : 'text-slate-500'"
        >
          {{ systemStatus.whatsappConfigured ? t('settings.configured') : t('settings.notConfigured') }}
        </p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.aiMode') }}</p>
        <p class="font-medium text-slate-300 text-xs capitalize">{{ systemStatus.aiMode }}</p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.environment') }}</p>
        <p class="font-medium text-slate-300 text-xs">{{ systemStatus.env }}</p>
      </div>
      <div>
        <p class="text-xs text-slate-500">{{ t('settings.version') }}</p>
        <p class="font-medium text-slate-300 text-xs font-mono">{{ systemStatus.commit }}</p>
      </div>
    </div>
  </div>
</template>
